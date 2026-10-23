import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, MARKER_FILE } from '../src/index.js';

const exec = promisify(execFile);
const CLI_PATH = join(import.meta.dirname, '../dist/cli.js');

describe('CLI with format-assert.config.json', () => {
  let rootDir: string;
  let versionDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'fag-cli-'));
    versionDir = join(rootDir, 'schema', '0.0.0');
    await mkdir(versionDir, { recursive: true });
    await writeFile(
      join(versionDir, 'user.schema.json'),
      JSON.stringify({
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      }),
    );
  });

  it('respects config options when no CLI flags are given', async () => {
    await writeFile(
      join(rootDir, CONFIG_FILE),
      JSON.stringify({
        options: {
          mode: 'fast',
        },
      }),
    );

    const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, versionDir]);
    expect(stdout).toMatch(/wrote .*format-assert-fast: 1 file\(s\)/);
    expect(stderr).toBe('');

    const generated = await readdir(join(versionDir, 'format-assert-fast'));
    expect(generated).toContain(MARKER_FILE);
    expect(generated).toContain('user.schema.json');

    // full was not generated because mode was fast in config
    const entries = await readdir(versionDir);
    expect(entries).not.toContain('format-assert-full');
  });

  it('CLI flag overrides config option and prints warning', async () => {
    await writeFile(
      join(rootDir, CONFIG_FILE),
      JSON.stringify({
        options: {
          mode: 'fast',
        },
      }),
    );

    const { stdout, stderr } = await exec(process.execPath, [CLI_PATH, versionDir, '--mode', 'full']);
    expect(stdout).toMatch(/wrote .*format-assert-full: 1 file\(s\)/);
    expect(stderr).toMatch(/warning: CLI flag --mode full overrides config option mode "fast"/);

    const entries = await readdir(versionDir);
    expect(entries).toContain('format-assert-full');
    expect(entries).not.toContain('format-assert-fast');
  });

  it('fails with clear error if config file is invalid', async () => {
    await writeFile(
      join(rootDir, CONFIG_FILE),
      JSON.stringify({
        options: {
          mode: 'invalid-mode',
        },
      }),
    );

    await expect(exec(process.execPath, [CLI_PATH, versionDir])).rejects.toThrow(
      /must be equal to one of the allowed values/,
    );
  });

  it('creates format-assert.config.json when --write-config is passed', async () => {
    const { stdout, stderr } = await exec(process.execPath, [
      CLI_PATH,
      versionDir,
      '--mode',
      'fast',
      '--strict',
      '--write-config',
    ]);

    expect(stdout).toMatch(/wrote .*format-assert\.config\.json/);
    expect(stdout).toMatch(/wrote .*format-assert-fast: 1 file\(s\)/);
    expect(stderr).toBe('');

    const configContent = JSON.parse(await (await import('node:fs/promises')).readFile(join(rootDir, CONFIG_FILE), 'utf8'));
    expect(configContent.options).toEqual({
      mode: 'fast',
      strict: true,
    });
  });
});
