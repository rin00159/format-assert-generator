import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { lintPattern, loadDictionary, relocateSchema, transpile, VERSION as COMPILER_VERSION } from 'format-assert-compiler';
import type { Change, FormatMode, JsonSchema, LintOptions, TranspileOptions } from 'format-assert-compiler';
import { findSchemaFiles, MARKER_FILE, outputDirName, toPosix as posix } from 'jsonschema-lib-layout';
import type { IncludeDotDirs } from 'jsonschema-lib-layout';

export { findSchemaFiles, isIgnoredDir, MARKER_FILE, OUTPUT_DIR_PREFIX, outputDirName } from 'jsonschema-lib-layout';

const GENERATOR_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export interface GenerateOptions {
  /** A `schema/<version>` directory of a JSON Schema library. */
  versionDir: string;
  /** Default: both. */
  modes?: readonly FormatMode[];
  /**
   * Dictionary location (URL / file) instead of the one bundled with format-assert-compiler.
   * `{mode}` is replaced by `fast` / `full`.
   */
  source?: string;
  /** Options passed to the compiler (`onUnresolved`, `keepFormat`, ...). */
  compile?: TranspileOptions;
  /** Write nothing; report what is out of date in `stale`. */
  check?: boolean;
  /**
   * Dot-directories (`.hidden/`) are skipped by default. `true` includes all of them, a list includes only those names
   * (e.g. `['.internal']`). `.git`, `node_modules` and `format-assert-*` are never entered.
   */
  includeDotDirs?: IncludeDotDirs;
  /** Warn (in `warnings`) about generated patterns the target platform cannot handle, e.g. `{ engine: 're2', maxLength: 1024 }`. */
  lint?: LintOptions;
}

export interface ModeResult {
  mode: FormatMode;
  outputDir: string;
  /** Written (or, with `check`, expected) files relative to `outputDir`, marker excluded. */
  files: string[];
  changes: Array<Change & { file: string }>;
}

export interface GenerateResult {
  modes: ModeResult[];
  warnings: string[];
  /** Patterns the `lint` option objects to (also never fatal by themselves). */
  lintWarnings: string[];
  /** Only with `check`: files that are missing, different or unexpected. */
  stale: string[];
}

/** Keep the source file's look: indentation unit and trailing newline. */
function serialize(value: unknown, originalText: string): string {
  const indent = /^\{?\s*\n([ \t]+)\S/.exec(originalText)?.[1] ?? '\t';
  const text = JSON.stringify(value, null, indent);
  return originalText.endsWith('\n') ? text + '\n' : text;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(posix(relative(dir, p)));
    }
  };
  await walk(dir);
  return out.sort();
}

const exists = (p: string) => stat(p).then(() => true, () => false);

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const { versionDir, modes = ['fast', 'full'], check = false } = options;
  if (!(await exists(versionDir))) throw new Error(`version directory not found: ${versionDir}`);
  const sources = await findSchemaFiles(versionDir, options.includeDotDirs);
  const texts = new Map<string, string>();
  for (const rel of sources) texts.set(rel, await readFile(join(versionDir, rel), 'utf8'));

  const result: GenerateResult = { modes: [], warnings: [], lintWarnings: [], stale: [] };
  if (sources.length === 0) result.warnings.push(`no *.schema.json found in ${versionDir}`);

  for (const mode of modes) {
    const outDirName = outputDirName(mode);
    const outDir = join(versionDir, outDirName);
    const dictionary = await loadDictionary({ mode, source: options.source?.replaceAll('{mode}', mode) });

    const planned = new Map<string, string>();
    const changes: ModeResult['changes'] = [];
    for (const rel of sources) {
      const text = texts.get(rel)!;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`${rel}: invalid JSON (${(e as Error).message})`);
      }
      const relocated = relocateSchema(parsed as JsonSchema, { relativePath: rel, outputDir: outDirName });
      for (const w of relocated.warnings) result.warnings.push(`${rel}: ${w}`);
      const compiled = transpile(relocated.schema, dictionary, options.compile);
      for (const c of compiled.report.changes) {
        changes.push({ ...c, file: rel });
        const pattern = c.action === 'injected' || c.action === 'merged-into-allOf' ? dictionary.formats[c.format]?.pattern : undefined;
        if (pattern && options.lint) {
          for (const issue of lintPattern(pattern, options.lint)) result.lintWarnings.push(`${outDirName}/${rel}#${c.path}: format "${c.format}" pattern ${issue.message}`);
        }
      }
      planned.set(rel, serialize(compiled.schema, text));
    }
    const marker =
      JSON.stringify(
        {
          generatedBy: { name: 'format-assert-generator', version: GENERATOR_VERSION },
          compiler: { name: 'format-assert-compiler', version: COMPILER_VERSION },
          mode,
          dictionary: { origin: dictionary.origin, ...(dictionary.id && { id: dictionary.id }) },
          sources: sources.map((rel) => ({ file: rel, sha256: createHash('sha256').update(texts.get(rel)!).digest('hex') })),
        },
        null,
        '\t',
      ) + '\n';
    planned.set(MARKER_FILE, marker);

    result.modes.push({ mode, outputDir: outDir, files: sources, changes });

    const present = await exists(outDir);
    if (present && !(await exists(join(outDir, MARKER_FILE)))) {
      throw new Error(`${outDir} exists but has no ${MARKER_FILE}; refusing to overwrite a directory this tool did not create`);
    }

    if (check) {
      const onDisk = present ? await listFiles(outDir) : [];
      for (const [rel, text] of planned) {
        if (sources.length === 0) break;
        if (!onDisk.includes(rel)) result.stale.push(`${outDirName}/${rel} (missing)`);
        else if ((await readFile(join(outDir, rel), 'utf8')) !== text) result.stale.push(`${outDirName}/${rel} (differs)`);
      }
      for (const rel of onDisk) if (!planned.has(rel) || sources.length === 0) result.stale.push(`${outDirName}/${rel} (unexpected)`);
      continue;
    }

    if (present) await rm(outDir, { recursive: true, force: true });
    if (sources.length === 0) continue;
    for (const [rel, text] of planned) {
      const target = join(outDir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    }
  }
  return result;
}
