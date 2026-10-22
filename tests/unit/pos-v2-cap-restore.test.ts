import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const fixtures: string[] = [];
const script = path.resolve(__dirname, '../../apps/pos/scripts/build-cap.mjs');
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'shareat-cap-restore-'));
  fixtures.push(root);
  const put = (file: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  put('scripts/placeholder', '');
  copyFileSync(script, path.join(root, 'scripts/build-cap.mjs'));
  put('src/server/original.ts', 'original server');
  put('src/app/api/route.ts', 'original route');
  put('src/middleware.ts', 'original middleware');
  const windows = process.platform === 'win32';
  put(`fake-bin/npx${windows ? '.cmd' : ''}`, windows
    ? '@echo off\r\necho ran>build-marker\r\nif "%CAP_TEST_RECREATE%"=="yes" (\r\nmkdir src\\server\r\necho generated>src\\server\\generated.ts\r\n)\r\nexit /b %CAP_TEST_EXIT%\r\n'
    : '#!/bin/sh\nprintf ran > build-marker\nif [ "$CAP_TEST_RECREATE" = yes ]; then mkdir -p src/server; printf generated > src/server/generated.ts; fi\nexit "$CAP_TEST_EXIT"\n');
  if (!windows) {
    // chmod only the fixture executable, never a repository file.
    const result = spawnSync('chmod', ['755', path.join(root, 'fake-bin/npx')]);
    expect(result.status).toBe(0);
  }
  const run = (recreate = false, exit = 0) => spawnSync(process.execPath, [path.join(root, 'scripts/build-cap.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: path.join(root, 'fake-bin') + path.delimiter + process.env.PATH,
      CAP_TEST_RECREATE: recreate ? 'yes' : 'no', CAP_TEST_EXIT: String(exit) },
  });
  const read = (file: string) => existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8').trim() : null;
  return { root, put, run, read };
}
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    if (path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith('shareat-cap-restore-')) {
      throw new Error('Refusing cleanup outside this test fixture');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('DEF-677 actual build-cap restoration with a fake build in an isolated fixture', () => {
  it('merges original source back when the build recreates its directory', () => {
    const f = fixture();
    expect(f.run(true).status).toBe(0);
    expect(f.read('src/server/original.ts')).toBe('original server');
    expect(f.read('src/server/generated.ts')).toBe('generated');
    expect(f.read('.cap-stash/server/original.ts')).toBeNull();
  });
  it('preserves both conflicting files and restores non-conflicting siblings before refusing a new build', () => {
    const f = fixture();
    f.put('.cap-stash/server/original.ts', 'older server');
    f.put('.cap-stash/server/unique.ts', 'recover me');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('saved source remains in .cap-stash');
    expect(f.read('src/server/original.ts')).toBe('original server');
    expect(f.read('.cap-stash/server/original.ts')).toBe('older server');
    expect(f.read('src/server/unique.ts')).toBe('recover me');
    expect(f.read('build-marker')).toBeNull();
  });
  it('restores all source after a failed build and preserves its failure status', () => {
    const f = fixture();
    expect(f.run(false, 5).status).toBe(5);
    expect(f.read('src/server/original.ts')).toBe('original server');
    expect(f.read('src/app/api/route.ts')).toBe('original route');
    expect(f.read('src/middleware.ts')).toBe('original middleware');
  });
  it('preserves unknown stash contents and stops before building', () => {
    const f = fixture();
    f.put('.cap-stash/unknown.txt', 'recover manually');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('saved source remains in .cap-stash');
    expect(f.read('.cap-stash/unknown.txt')).toBe('recover manually');
    expect(f.read('build-marker')).toBeNull();
  });
  it('recovers a crashed stash before a successful build and warns', () => {
    const f = fixture();
    mkdirSync(path.join(f.root, '.cap-stash'));
    renameSync(path.join(f.root, 'src/server'), path.join(f.root, '.cap-stash/server'));
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('crashed earlier run');
    expect(f.read('src/server/original.ts')).toBe('original server');
    expect(existsSync(path.join(f.root, '.cap-stash'))).toBe(false);
  });
});
