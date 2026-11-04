/**
 * T-511 S4 (TESTER, 2026-11-04) - the xlsx worker under Next and in the deploy artifact. docs/tasks/511-settlement-upload-s4-spec.md "Worker path under Next" (a)-(d).
 * (e), the live proof on 9008 after a real `next build`, is a manual exit step that needs BOSS's OK; nothing here starts a server.
 *
 * RED today, for these reasons: `resolveWorkerPath` is not exported from `xlsx-worker-host.ts`, and `serverExternalPackages` in `apps/erp/next.config.js`
 * lacks `read-excel-file` and `yauzl`. The deploy-artifact guards are already true and are here so they stay true (they must not go red).
 *
 * CONTRACT:
 *  W1  `resolveWorkerPath(cwd: string = process.cwd(), fileExists: (path: string) => boolean = existsSync): URL` exported from `xlsx-worker-host.ts`, evaluated at
 *      CALL time (never cached at module load, because Next may start the server with any cwd). It walks up from `cwd` to the folder that holds
 *      `package-lock.json` (as `packages/storage-firebase/src/index.ts:94-103` does) and returns the file URL of
 *      `<root>/packages/domain/src/settlement-intake/xlsx-worker.mjs`; when no root is found, or the file is not there, it falls back to
 *      `new URL('./xlsx-worker.mjs', import.meta.url)`. When NEITHER candidate exists (per `fileExists`) it throws a `SettlementIntakeRefusal` with code
 *      XLSX_WORKER_UNAVAILABLE at once: never a hang, never a bare Error.
 *  W2  `readSheetsInWorker` uses `resolveWorkerPath()` when no `workerUrl` option is given (proved by reading a real invoice with `process.cwd` stubbed).
 */
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import * as host from '../../src/settlement-intake/xlsx-worker-host';
import { fixture } from './t511-s3-helpers';

const REPO = resolve(__dirname, '..', '..', '..', '..');
const WORKER = join(REPO, 'packages', 'domain', 'src', 'settlement-intake', 'xlsx-worker.mjs');
// lower-cased: Windows drive letters differ in case between `import.meta.url` and `__dirname`
const toPath = (u: URL | string): string => resolve(u instanceof URL ? fileURLToPath(u) : String(u)).toLowerCase();
const WORKER_L = WORKER.toLowerCase();
const resolveWorkerPath = (host as unknown as { resolveWorkerPath: (cwd?: string, fileExists?: (p: string) => boolean) => URL }).resolveWorkerPath;

afterEach(() => vi.restoreAllMocks());

describe('T-511 S4 worker path (a, c)', () => {
  it('the worker file exists where the spec says (the thing being resolved)', () => {
    expect(existsSync(WORKER)).toBe(true);
  });

  it('is exported', () => {
    expect(typeof resolveWorkerPath).toBe('function');
  });

  for (const [label, cwd] of [
    ['the repo root', REPO],
    ['apps/erp (where `next start` runs)', join(REPO, 'apps', 'erp')],
    ['a folder deep inside apps/erp', join(REPO, 'apps', 'erp', 'src', 'app', 'channel-settlements')],
    ['packages/domain', join(REPO, 'packages', 'domain')],
  ] as const) {
    it(`resolves the same worker file with cwd = ${label} [kills: cwd-relative path; resolution cached at load]`, () => {
      expect(toPath(resolveWorkerPath(cwd))).toBe(WORKER_L);
    });
  }

  it('with a cwd that has no repo above it, falls back to the module\'s own location and still finds the file [kills: no fallback]', () => {
    expect(toPath(resolveWorkerPath(tmpdir()))).toBe(WORKER_L);
  });

  it('defaults to process.cwd() at CALL time: a stubbed cwd changes the answer\'s starting point but not the file [kills: cached at import]', () => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(join(REPO, 'apps', 'erp'));
    expect(toPath(resolveWorkerPath())).toBe(WORKER_L);
    expect(spy).toHaveBeenCalled();
  });

  it('when neither the repo path nor the module-relative path exists it refuses at once with XLSX_WORKER_UNAVAILABLE [kills: handing a missing file to Worker (a hang or a bare ERR_MODULE_NOT_FOUND)]', () => {
    let thrown: unknown;
    const started = Date.now();
    try {
      resolveWorkerPath(REPO, () => false);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SettlementIntakeRefusal);
    expect((thrown as SettlementIntakeRefusal).code).toBe('XLSX_WORKER_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('prefers the repo path, and when only the module-relative one exists uses that [kills: always module-relative]', () => {
    const moduleRelative = toPath(new URL('../../src/settlement-intake/xlsx-worker.mjs', import.meta.url));
    const onlyModule = (p: string): boolean => toPath(p) === moduleRelative;
    expect(toPath(resolveWorkerPath(tmpdir(), onlyModule))).toBe(moduleRelative);
  });

  it('reading a real invoice works with the cwd stubbed to apps/erp and to a folder outside the repo (the real worker is found, not just a path computed) [kills: path correct but never used by readSheetsInWorker]', async () => {
    const workbook = (await openSettlementZip(fixture('foodpanda-malvar-oct12-34col.zip'))).workbook;
    for (const cwd of [join(REPO, 'apps', 'erp'), tmpdir()]) {
      vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      const inv = await readFoodpandaInvoice(workbook);
      expect(inv.orders.length, cwd).toBe(57);
      vi.restoreAllMocks();
    }
  }, 20_000);

  it('a worker file that cannot be started is still XLSX_WORKER_UNAVAILABLE and quick (already true in slice 3; guards the new default path) [kills: a hang]', async () => {
    const started = Date.now();
    let thrown: unknown;
    try {
      await host.readSheetsInWorker(Buffer.from('PK'), { workerUrl: new URL('file:///definitely/not/here/xlsx-worker.mjs') });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as SettlementIntakeRefusal).code).toBe('XLSX_WORKER_UNAVAILABLE');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('T-511 S4 next.config.js (b)', () => {
  const src = readFileSync(join(REPO, 'apps', 'erp', 'next.config.js'), 'utf8');
  const listed = (): string[] => {
    const m = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(src);
    return m ? [...(m[1] as string).matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1] as string) : [];
  };

  it('serverExternalPackages lists read-excel-file and yauzl (a bundler must not inline them, the worker imports them by name) and keeps the three it had [kills: library bundled into the server build]', () => {
    const l = listed();
    expect(l).toEqual(expect.arrayContaining(['postgres', 'firebase-admin', 'pino', 'read-excel-file', 'yauzl']));
  });
});

describe('T-511 S4 deploy artifact (d)', () => {
  const yml = readFileSync(join(REPO, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const pathsLine = /PATHS="([^"]*)"/.exec(yml)?.[1] ?? '';
  const excludes = [...yml.matchAll(/--exclude='([^']+)'/g)].map((m) => m[1] as string);

  it('the tar path list includes `packages` (so the worker .mjs ships) and `node_modules` (so read-excel-file and yauzl do) [kills: artifact without the worker]', () => {
    const tokens = pathsLine.split(/\s+/);
    expect(tokens).toContain('packages');
    expect(tokens).toContain('node_modules');
  });

  it('no --exclude pattern matches the worker file or a folder on its way (tests and *.test.ts are excluded; an .mjs under src is not) [kills: an exclude that eats the worker]', () => {
    expect(excludes.length).toBeGreaterThan(0);
    const rel = 'packages/domain/src/settlement-intake/xlsx-worker.mjs'.split('/');
    for (const pattern of excludes) {
      const body = pattern.replace(/^\*\*\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
      const re = new RegExp(`(^|/)${body}$`);
      for (let i = 1; i <= rel.length; i++) {
        expect(re.test(rel.slice(0, i).join('/')), `${pattern} vs ${rel.slice(0, i).join('/')}`).toBe(false);
      }
    }
  });

  it('read-excel-file and yauzl are runtime dependencies of @shareat/domain, not devDependencies (the artifact is `npm ci --omit=dev`) [kills: library pruned from the artifact]', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'packages', 'domain', 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(expect.arrayContaining(['read-excel-file', 'yauzl']));
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('read-excel-file');
    expect(yml).toMatch(/npm ci --omit=dev/);
  });

  it('the repo path separator assumption holds on this machine (the test itself must not pass by accident of platform)', () => {
    expect(WORKER.split(sep).slice(-4)).toEqual(['domain', 'src', 'settlement-intake', 'xlsx-worker.mjs']);
  });
});

describe('T-511 S4 plain `next build` (Turbopack) [kills: the build-time panic "there must be a path to a root"]', () => {
  // Found 2026-11-04: with `import { Worker } from 'node:worker_threads'` and `new Worker(<run-time path>)`, Turbopack (Next 16.3) panics while printing
  // the issue for that call and `next build` dies; `--webpack` passed. Bisected by stubbing: only the Worker construction triggers it.
  const hostSrc = readFileSync(join(REPO, 'packages', 'domain', 'src', 'settlement-intake', 'xlsx-worker-host.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('the host takes the Worker constructor from process.getBuiltinModule, never a value import of node:worker_threads', () => {
    expect(hostSrc).not.toMatch(/import\s*\{[^}]*\bWorker\b[^}]*\}\s*from\s*'node:worker_threads'/);
    expect(hostSrc).toMatch(/process\.getBuiltinModule\('node:worker_threads'\)/);
  });
});
