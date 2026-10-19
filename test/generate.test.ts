import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { generate, MARKER_FILE } from '../src/index.js';

const BASE = 'https://example.test/lib/main/schema/0.0.0';
let dir: string; // the version directory

async function put(rel: string, content: unknown, raw = false) {
  const p = join(dir, rel);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, raw ? (content as string) : JSON.stringify(content, null, '\t') + '\n');
}
const read = async (rel: string) => JSON.parse(await readFile(join(dir, rel), 'utf8'));
const tree = async (d: string, prefix = ''): Promise<string[]> =>
  (await Promise.all((await readdir(d, { withFileTypes: true })).map(async (e) => (e.isDirectory() ? tree(join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])))).flat().sort();

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'fag-')), 'schema', '0.0.0');
  await mkdir(dir, { recursive: true });
  await put('main.schema.json', {
    $id: `${BASE}/main.schema.json`,
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      sub: { $ref: 'ide/sub.schema.json' },
      abs: { $ref: `${BASE}/ide/sub.schema.json` },
    },
  });
  await put('ide/sub.schema.json', { $id: `${BASE}/ide/sub.schema.json`, type: 'string', format: 'email', description: 'format: not touched' });
  await put('notes.json', { format: 'uuid' }); // not *.schema.json -> ignored
});

describe('generate', () => {
  it('mirrors *.schema.json recursively into format-assert-fast / -full', async () => {
    const res = await generate({ versionDir: dir });
    expect(res.warnings).toEqual([]);
    for (const m of ['fast', 'full']) {
      expect(await tree(join(dir, `format-assert-${m}`))).toEqual([MARKER_FILE, 'ide/sub.schema.json', 'main.schema.json']);
    }
    const main = await read('format-assert-fast/main.schema.json');
    expect(main.properties.id).toEqual({ type: 'string', pattern: expect.stringContaining('[0-9a-fA-F]') });
    expect(main.$id).toBe(`${BASE}/format-assert-fast/main.schema.json`);
    expect(main.properties.sub.$ref).toBe('ide/sub.schema.json');
    expect(main.properties.abs.$ref).toBe(`${BASE}/format-assert-fast/ide/sub.schema.json`);
    const sub = await read('format-assert-full/ide/sub.schema.json');
    expect(sub.$id).toBe(`${BASE}/format-assert-full/ide/sub.schema.json`);
    expect(sub.format).toBeUndefined();
    expect(sub.pattern).toBeDefined();
    expect(sub.description).toBe('format: not touched');
  });

  it('fast and full really use different dictionaries', async () => {
    await put('d.schema.json', { type: 'string', format: 'date' });
    await generate({ versionDir: dir });
    expect((await read('format-assert-fast/d.schema.json')).pattern).not.toBe((await read('format-assert-full/d.schema.json')).pattern);
  });

  it('leaves the original files untouched', async () => {
    const before = await readFile(join(dir, 'main.schema.json'), 'utf8');
    await generate({ versionDir: dir });
    expect(await readFile(join(dir, 'main.schema.json'), 'utf8')).toBe(before);
  });

  it('is idempotent and never treats its own output (or nested format-assert-*) as input', async () => {
    await generate({ versionDir: dir });
    const first = await tree(dir);
    const snapshot = await readFile(join(dir, 'format-assert-fast/main.schema.json'), 'utf8');
    const res = await generate({ versionDir: dir });
    expect(await tree(dir)).toEqual(first);
    expect(await readFile(join(dir, 'format-assert-fast/main.schema.json'), 'utf8')).toBe(snapshot);
    expect(res.modes[0]!.files).toEqual(['ide/sub.schema.json', 'main.schema.json']);
    await put('ide/format-assert-fast/x.schema.json', { format: 'uuid' }); // nested one is skipped too
    expect((await generate({ versionDir: dir })).modes[0]!.files).toEqual(['ide/sub.schema.json', 'main.schema.json']);
  });

  it('keeps tab / space indentation of the source', async () => {
    await put('sp.schema.json', '{\n    "type": "string",\n    "format": "uuid"\n}', true);
    await generate({ versionDir: dir, modes: ['fast'] });
    const text = await readFile(join(dir, 'format-assert-fast/sp.schema.json'), 'utf8');
    expect(text.startsWith('{\n    "type"')).toBe(true);
    expect(text.endsWith('}')).toBe(true); // source had no trailing newline
    expect((await readFile(join(dir, 'format-assert-fast/main.schema.json'), 'utf8')).startsWith('{\n\t"')).toBe(true);
  });

  it('removes outputs of deleted sources', async () => {
    await put('gone.schema.json', { format: 'uuid' });
    await generate({ versionDir: dir });
    expect(await tree(join(dir, 'format-assert-fast'))).toContain('gone.schema.json');
    await (await import('node:fs/promises')).rm(join(dir, 'gone.schema.json'));
    await generate({ versionDir: dir });
    expect(await tree(join(dir, 'format-assert-fast'))).not.toContain('gone.schema.json');
  });

  it('refuses to overwrite a format-assert-* directory without the marker', async () => {
    await put('format-assert-fast/handmade.txt', 'x', true);
    await expect(generate({ versionDir: dir })).rejects.toThrow(/refusing to overwrite/);
    expect(await tree(join(dir, 'format-assert-fast'))).toEqual(['handmade.txt']);
  });

  it('--check reports missing / differing / unexpected files and writes nothing', async () => {
    expect((await generate({ versionDir: dir, check: true })).stale.length).toBeGreaterThan(0);
    expect(await tree(dir)).not.toContain('format-assert-fast/main.schema.json');
    await generate({ versionDir: dir });
    expect((await generate({ versionDir: dir, check: true })).stale).toEqual([]);
    await put('main.schema.json', { $id: `${BASE}/main.schema.json`, format: 'uuid' });
    expect((await generate({ versionDir: dir, check: true })).stale.join('\n')).toMatch(/main\.schema\.json \(differs\)/);
    await put('format-assert-full/stray.schema.json', {});
    expect((await generate({ versionDir: dir, check: true })).stale.join('\n')).toMatch(/stray\.schema\.json \(unexpected\)/);
  });

  it('reports unconverted formats and passes compile options through', async () => {
    await put('r.schema.json', { type: 'string', format: 'regex' });
    const kept = await generate({ versionDir: dir, modes: ['fast'] });
    expect(kept.modes[0]!.changes.filter((c) => c.action === 'kept').map((c) => c.format)).toEqual(['regex']);
    expect((await read('format-assert-fast/r.schema.json')).format).toBe('regex');
    await generate({ versionDir: dir, modes: ['fast'], compile: { onUnresolved: 'drop' } });
    expect((await read('format-assert-fast/r.schema.json')).format).toBeUndefined();
  });

  it('names the file when the JSON is broken; missing dir is an error', async () => {
    await put('bad.schema.json', '{', true);
    await expect(generate({ versionDir: dir })).rejects.toThrow(/bad\.schema\.json: invalid JSON/);
    await expect(generate({ versionDir: join(dir, 'nope') })).rejects.toThrow(/not found/);
  });

  it('dot-directories are skipped unless included explicitly', async () => {
    await put('.hidden/h.schema.json', { type: 'string', format: 'uuid' });
    await put('.other/o.schema.json', { type: 'string', format: 'uuid' });
    await put('.git/g.schema.json', { type: 'string', format: 'uuid' });
    const files = async (opts = {}) => (await generate({ versionDir: dir, modes: ['fast'], ...opts })).modes[0]!.files;
    expect(await files()).toEqual(['ide/sub.schema.json', 'main.schema.json']);
    expect(await files({ includeDotDirs: ['.hidden'] })).toEqual(['.hidden/h.schema.json', 'ide/sub.schema.json', 'main.schema.json']);
    expect(await files({ includeDotDirs: true })).toEqual(['.hidden/h.schema.json', '.other/o.schema.json', 'ide/sub.schema.json', 'main.schema.json']); // .git never
    expect(await tree(join(dir, 'format-assert-fast'))).toContain('.other/o.schema.json');
  });
});

describe('generate: marker and lint', () => {
  it('records generator and compiler versions in the marker', async () => {
    await generate({ versionDir: dir, modes: ['fast'] });
    const marker = await read(`format-assert-fast/${MARKER_FILE}`);
    expect(marker.generatedBy).toMatchObject({ name: 'format-assert-generator', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(marker.compiler).toMatchObject({ name: 'format-assert-compiler', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(marker.mode).toBe('fast');
  });

  it('lints generated patterns for the target engine', async () => {
    await put('h.schema.json', { type: 'string', format: 'hostname' });
    const none = await generate({ versionDir: dir, modes: ['fast'] });
    expect(none.lintWarnings).toEqual([]);
    const re2 = await generate({ versionDir: dir, modes: ['fast'], lint: { engine: 're2' } });
    expect(re2.lintWarnings.join('\n')).toMatch(/h\.schema\.json#: format "hostname" pattern uses lookahead/);
    const long = await generate({ versionDir: dir, modes: ['fast'], lint: { maxLength: 20 } });
    expect(long.lintWarnings.length).toBeGreaterThan(0);
  });
});
