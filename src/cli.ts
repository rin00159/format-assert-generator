#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { generate } from './generate.js';
import { CONFIG_FILE, loadConfigFile, resolveCliOptions } from './config.js';
import type { FormatMode } from 'format-assert-compiler';

const HELP = `Usage: format-assert-generator <schema/version directory> [options]

For every *.schema.json below the directory (recursively, except format-assert-* directories)
writes format-assert-fast/ and format-assert-full/ mirrors in which "format" is replaced by "pattern".

      --mode <fast|full|both>   default: both
      --source <url|file>       dictionary to use instead of the bundled one; "{mode}" is replaced by fast/full
      --keep-format             keep "format" next to the injected "pattern"
      --on-unresolved <keep|drop|error>   formats without a pattern, e.g. regex, int32 (default: keep)
      --include-dot-dirs        also read every dot-directory (.git, node_modules and format-assert-* are never read)
      --include-dot-dir <name>  also read this dot-directory, e.g. .internal (repeatable)
      --lint-regex <ecma|re2>   warn about generated patterns the target engine cannot handle (re2: no lookahead / backreference)
      --max-pattern-length <n>  warn about generated patterns longer than n characters
      --strict                  exit 1 when a format could not be converted or a lint warning was raised
      --check                   write nothing; exit 1 when the generated directories are out of date
  -h, --help

Optional <root>/${CONFIG_FILE} holds the same options (camelCase inside "options").
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      source: { type: 'string' },
      'keep-format': { type: 'boolean' },
      'on-unresolved': { type: 'string' },
      'include-dot-dirs': { type: 'boolean' },
      'include-dot-dir': { type: 'string', multiple: true },
      'lint-regex': { type: 'string' },
      'max-pattern-length': { type: 'string' },
      strict: { type: 'boolean' },
      check: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const [versionDir, ...rest] = positionals;
  if (!versionDir || rest.length) {
    process.stderr.write(HELP);
    return 2;
  }

  const { config } = await loadConfigFile(versionDir);

  const maxLengthInput = values['max-pattern-length'] === undefined ? undefined : Number(values['max-pattern-length']);
  if (maxLengthInput !== undefined && !(maxLengthInput > 0)) throw new Error('--max-pattern-length must be a positive number');

  const resolved = resolveCliOptions(
    {
      mode: values.mode,
      source: values.source,
      keepFormat: values['keep-format'],
      onUnresolved: values['on-unresolved'],
      includeDotDirs: values['include-dot-dirs'] ? true : values['include-dot-dir'],
      lintRegex: values['lint-regex'],
      maxPatternLength: maxLengthInput,
      strict: values.strict,
    },
    config.options,
  );

  for (const w of resolved.warnings) console.error(`warning: ${w}`);

  if (!['fast', 'full', 'both'].includes(resolved.mode)) throw new Error('--mode must be fast, full or both');
  if (resolved.onUnresolved && !['keep', 'drop', 'error'].includes(resolved.onUnresolved)) {
    throw new Error('--on-unresolved must be keep, drop or error');
  }
  if (resolved.lintRegex && !['ecma', 're2'].includes(resolved.lintRegex)) {
    throw new Error('--lint-regex must be ecma or re2');
  }

  const modes: FormatMode[] = resolved.mode === 'both' ? ['fast', 'full'] : [resolved.mode as FormatMode];
  const res = await generate({
    versionDir,
    modes,
    source: resolved.source,
    check: values.check,
    lint: resolved.lintRegex || resolved.maxPatternLength ? { engine: resolved.lintRegex, maxLength: resolved.maxPatternLength } : undefined,
    includeDotDirs: resolved.includeDotDirs,
    compile: { keepFormat: resolved.keepFormat, onUnresolved: resolved.onUnresolved },
  });

  for (const w of res.warnings) console.error(`warning: ${w}`);
  for (const w of res.lintWarnings) console.error(`lint: ${w}`);
  let unresolved = 0;
  for (const m of res.modes) {
    const kept = m.changes.filter((c) => c.action === 'kept' && c.reason !== 'noop');
    unresolved += kept.length;
    const converted = m.changes.filter((c) => c.action === 'injected' || c.action === 'merged-into-allOf').length;
    console.log(`${values.check ? 'checked' : 'wrote'} ${m.outputDir}: ${m.files.length} file(s), ${converted} format(s) converted, ${kept.length} left as-is`);
    for (const c of kept) console.error(`  left as-is: ${c.format} (${c.reason}) in ${c.file}#${c.path}`);
  }
  if (res.stale.length) {
    for (const s of res.stale) console.error(`out of date: ${s}`);
    return 1;
  }
  return resolved.strict && (unresolved > 0 || res.lintWarnings.length > 0) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
