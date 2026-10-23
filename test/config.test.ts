import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertValidConfig,
  CONFIG_FILE,
  findProjectRoot,
  loadConfigFile,
  resolveCliOptions,
  writeConfigFile,
} from '../src/index.js';

describe('format-assert.config schema and validation', () => {
  it('validates a correct configuration', () => {
    expect(() =>
      assertValidConfig({
        $schema: 'https://example.com/schema.json',
        options: {
          mode: 'fast',
          source: 'https://example.com/dict-{mode}.json',
          keepFormat: true,
          onUnresolved: 'drop',
          includeDotDirs: ['.internal'],
          lintRegex: 're2',
          maxPatternLength: 100,
          strict: true,
        },
      }),
    ).not.toThrow();
  });

  it('rejects unexpected properties at top-level', () => {
    expect(() =>
      assertValidConfig({
        unknownProp: 123,
      }),
    ).toThrow(/must NOT have additional properties \(unknownProp\)/);
  });

  it('rejects unexpected properties in options', () => {
    expect(() =>
      assertValidConfig({
        options: {
          check: true, // check is not allowed in config
        },
      }),
    ).toThrow(/must NOT have additional properties \(check\)/);
  });

  it('rejects invalid enum values', () => {
    expect(() =>
      assertValidConfig({
        options: {
          mode: 'superfast',
        },
      }),
    ).toThrow(/must be equal to one of the allowed values/);
  });
});

describe('config loading and resolution', () => {
  let rootDir: string;
  let versionDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'fag-config-'));
    versionDir = join(rootDir, 'schema', '0.0.0');
    await mkdir(versionDir, { recursive: true });
  });

  it('findProjectRoot identifies the parent directory of schema/', async () => {
    expect(await findProjectRoot(versionDir)).toBeUndefined();
    await writeFile(join(rootDir, CONFIG_FILE), JSON.stringify({ options: { mode: 'fast' } }));
    expect(await findProjectRoot(versionDir)).toBe(rootDir);
  });

  it('loadConfigFile returns empty config when not present', async () => {
    const res = await loadConfigFile(versionDir);
    expect(res.config).toEqual({});
    expect(res.configPath).toBeUndefined();
  });

  it('loadConfigFile loads and parses config when present', async () => {
    await writeFile(
      join(rootDir, CONFIG_FILE),
      JSON.stringify({ options: { mode: 'full', onUnresolved: 'error' } }),
    );
    const res = await loadConfigFile(versionDir);
    expect(res.config).toEqual({ options: { mode: 'full', onUnresolved: 'error' } });
    expect(res.configPath).toBe(join(rootDir, CONFIG_FILE));
  });

  it('loadConfigFile throws on invalid JSON or invalid schema', async () => {
    await writeFile(join(rootDir, CONFIG_FILE), '{ broken json');
    await expect(loadConfigFile(versionDir)).rejects.toThrow(/invalid JSON/);

    await writeFile(join(rootDir, CONFIG_FILE), JSON.stringify({ options: { mode: 'bad' } }));
    await expect(loadConfigFile(versionDir)).rejects.toThrow(/must be equal to one of the allowed values/);
  });

  it('resolveCliOptions merges config with CLI flags and warns on overrides', () => {
    const configOptions = {
      mode: 'fast' as const,
      onUnresolved: 'drop' as const,
      includeDotDirs: ['.cfg'],
      strict: true,
    };

    // When CLI does not specify, config values take effect without warning
    const noCli = resolveCliOptions({}, configOptions);
    expect(noCli.mode).toBe('fast');
    expect(noCli.onUnresolved).toBe('drop');
    expect(noCli.includeDotDirs).toEqual(['.cfg']);
    expect(noCli.strict).toBe(true);
    expect(noCli.warnings).toEqual([]);

    // When CLI specifies same value, no warning
    const sameCli = resolveCliOptions({ mode: 'fast' }, configOptions);
    expect(sameCli.mode).toBe('fast');
    expect(sameCli.warnings).toEqual([]);

    // When CLI specifies different value, warning is emitted and CLI value wins
    const overrideCli = resolveCliOptions(
      {
        mode: 'full',
        onUnresolved: 'error',
        includeDotDirs: ['.cli'],
        strict: false,
      },
      configOptions,
    );
    expect(overrideCli.mode).toBe('full');
    expect(overrideCli.onUnresolved).toBe('error');
    expect(overrideCli.includeDotDirs).toEqual(['.cli']);
    expect(overrideCli.strict).toBe(false);
    expect(overrideCli.warnings).toEqual([
      'CLI flag --mode full overrides config option mode "fast"',
      'CLI flag --on-unresolved error overrides config option onUnresolved "drop"',
      'CLI flag --include-dot-dir(s) [".cli"] overrides config option includeDotDirs [".cfg"]',
      'CLI flag --strict overrides config option strict true',
    ]);
  });

  it('writeConfigFile creates format-assert.config.json when not present', async () => {
    const { configPath, written } = await writeConfigFile(versionDir, {
      mode: 'fast',
      strict: true,
      onUnresolved: 'drop',
    });
    expect(configPath).toBe(join(rootDir, CONFIG_FILE));
    expect(written.options).toEqual({
      mode: 'fast',
      strict: true,
      onUnresolved: 'drop',
    });

    const loaded = await loadConfigFile(versionDir);
    expect(loaded.config.options).toEqual({
      mode: 'fast',
      strict: true,
      onUnresolved: 'drop',
    });
  });

  it('writeConfigFile updates existing format-assert.config.json', async () => {
    await writeConfigFile(versionDir, {
      mode: 'fast',
      strict: true,
    });

    await writeConfigFile(versionDir, {
      mode: 'full',
      onUnresolved: 'error',
    });

    const loaded = await loadConfigFile(versionDir);
    expect(loaded.config.options).toEqual({
      mode: 'full',
      strict: true,
      onUnresolved: 'error',
    });
  });
});
