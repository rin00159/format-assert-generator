import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import type { FormatMode } from 'format-assert-compiler';
import { CONFIG_FILE, type IncludeDotDirs } from 'jsonschema-lib-layout';

export { CONFIG_FILE };

export interface FormatAssertConfigOptions {
  mode?: FormatMode | 'both';
  source?: string;
  keepFormat?: boolean;
  onUnresolved?: 'keep' | 'drop' | 'error';
  includeDotDirs?: IncludeDotDirs;
  lintRegex?: 'ecma' | 're2';
  maxPatternLength?: number;
  strict?: boolean;
}

export interface FormatAssertConfigFile {
  $schema?: string;
  options?: FormatAssertConfigOptions;
}

export const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    options: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: ['fast', 'full', 'both'] },
        source: { type: 'string' },
        keepFormat: { type: 'boolean' },
        onUnresolved: { enum: ['keep', 'drop', 'error'] },
        includeDotDirs: {
          oneOf: [
            { type: 'boolean' },
            { type: 'array', items: { type: 'string' } },
          ],
        },
        lintRegex: { enum: ['ecma', 're2'] },
        maxPatternLength: { type: 'integer', minimum: 1 },
        strict: { type: 'boolean' },
      },
    },
  },
} as const;

const validateConfig = new Ajv({ allErrors: true, strict: false }).compile(CONFIG_SCHEMA);

export function assertValidConfig(config: unknown): asserts config is FormatAssertConfigFile {
  if (validateConfig(config)) return;
  const msgs = (validateConfig.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty)})` : ''}`,
  );
  throw new Error(msgs.join('; '));
}

/**
 * Finds the project root directory (parent of schema/, sibling to examples/)
 * where format-assert.config.json may reside.
 */
export async function findProjectRoot(versionDir: string): Promise<string | undefined> {
  const abs = resolve(versionDir);
  const candidate = dirname(dirname(abs));
  try {
    const s = await stat(join(candidate, CONFIG_FILE));
    if (s.isFile()) return candidate;
  } catch {}
  return undefined;
}

/**
 * Loads and validates format-assert.config.json if present in the project root.
 * Returns empty config if not found.
 */
export async function loadConfigFile(versionDir: string): Promise<{
  config: FormatAssertConfigFile;
  configPath?: string;
}> {
  const root = await findProjectRoot(versionDir);
  if (!root) return { config: {} };
  const configPath = join(root, CONFIG_FILE);
  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { config: {} };
    throw new Error(`${CONFIG_FILE}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: invalid JSON (${(e as Error).message})`);
  }
  assertValidConfig(parsed);
  return { config: parsed, configPath };
}

export interface CliFlags {
  mode?: string;
  source?: string;
  keepFormat?: boolean;
  onUnresolved?: string;
  includeDotDirs?: IncludeDotDirs;
  lintRegex?: string;
  maxPatternLength?: number;
  strict?: boolean;
}

export interface ResolvedCliOptions {
  mode: 'fast' | 'full' | 'both';
  source?: string;
  keepFormat?: boolean;
  onUnresolved?: 'keep' | 'drop' | 'error';
  includeDotDirs?: IncludeDotDirs;
  lintRegex?: 'ecma' | 're2';
  maxPatternLength?: number;
  strict: boolean;
  warnings: string[];
}

function areIncludeDotDirsEqual(a?: IncludeDotDirs, b?: IncludeDotDirs): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  return false;
}

/**
 * Resolves CLI flags and config options with precedence: CLI flag > config > default.
 * Emits warnings when an explicit CLI flag overrides a differing config value.
 */
export function resolveCliOptions(
  cli: CliFlags,
  configOptions: FormatAssertConfigOptions = {},
): ResolvedCliOptions {
  const warnings: string[] = [];

  // mode
  if (cli.mode !== undefined && configOptions.mode !== undefined && cli.mode !== configOptions.mode) {
    warnings.push(`CLI flag --mode ${cli.mode} overrides config option mode "${configOptions.mode}"`);
  }
  const mode = (cli.mode ?? configOptions.mode ?? 'both') as 'fast' | 'full' | 'both';

  // source
  if (cli.source !== undefined && configOptions.source !== undefined && cli.source !== configOptions.source) {
    warnings.push(`CLI flag --source ${cli.source} overrides config option source "${configOptions.source}"`);
  }
  const source = cli.source ?? configOptions.source;

  // keepFormat
  if (cli.keepFormat !== undefined && configOptions.keepFormat !== undefined && cli.keepFormat !== configOptions.keepFormat) {
    warnings.push(`CLI flag --keep-format overrides config option keepFormat ${configOptions.keepFormat}`);
  }
  const keepFormat = cli.keepFormat ?? configOptions.keepFormat;

  // onUnresolved
  if (cli.onUnresolved !== undefined && configOptions.onUnresolved !== undefined && cli.onUnresolved !== configOptions.onUnresolved) {
    warnings.push(`CLI flag --on-unresolved ${cli.onUnresolved} overrides config option onUnresolved "${configOptions.onUnresolved}"`);
  }
  const onUnresolved = (cli.onUnresolved ?? configOptions.onUnresolved) as 'keep' | 'drop' | 'error' | undefined;

  // includeDotDirs
  if (
    cli.includeDotDirs !== undefined &&
    configOptions.includeDotDirs !== undefined &&
    !areIncludeDotDirsEqual(cli.includeDotDirs, configOptions.includeDotDirs)
  ) {
    const cliStr = Array.isArray(cli.includeDotDirs) ? JSON.stringify(cli.includeDotDirs) : String(cli.includeDotDirs);
    const cfgStr = Array.isArray(configOptions.includeDotDirs) ? JSON.stringify(configOptions.includeDotDirs) : String(configOptions.includeDotDirs);
    warnings.push(`CLI flag --include-dot-dir(s) ${cliStr} overrides config option includeDotDirs ${cfgStr}`);
  }
  const includeDotDirs = cli.includeDotDirs ?? configOptions.includeDotDirs;

  // lintRegex
  if (cli.lintRegex !== undefined && configOptions.lintRegex !== undefined && cli.lintRegex !== configOptions.lintRegex) {
    warnings.push(`CLI flag --lint-regex ${cli.lintRegex} overrides config option lintRegex "${configOptions.lintRegex}"`);
  }
  const lintRegex = (cli.lintRegex ?? configOptions.lintRegex) as 'ecma' | 're2' | undefined;

  // maxPatternLength
  if (cli.maxPatternLength !== undefined && configOptions.maxPatternLength !== undefined && cli.maxPatternLength !== configOptions.maxPatternLength) {
    warnings.push(`CLI flag --max-pattern-length ${cli.maxPatternLength} overrides config option maxPatternLength ${configOptions.maxPatternLength}`);
  }
  const maxPatternLength = cli.maxPatternLength ?? configOptions.maxPatternLength;

  // strict
  if (cli.strict !== undefined && configOptions.strict !== undefined && cli.strict !== configOptions.strict) {
    warnings.push(`CLI flag --strict overrides config option strict ${configOptions.strict}`);
  }
  const strict = cli.strict ?? configOptions.strict ?? false;

  return {
    mode,
    source,
    keepFormat,
    onUnresolved,
    includeDotDirs,
    lintRegex,
    maxPatternLength,
    strict,
    warnings,
  };
}
