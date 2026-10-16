/**
 * T-417 case 8 / slice B3 - `scripts/ci-affected-apps.mjs` decides which app CI jobs run.
 * Spawned as `node <script>` (root `allowJs` is false, so no TS import of the .mjs).
 * Input: changed paths on stdin (one per line) or the literal `UNKNOWN`. Output: `pos=...` and
 * `customer=...`. It FAILS OPEN: anything unknown means both true.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '..', '..', 'scripts', 'ci-affected-apps.mjs');

function run(stdin: string): { pos: string | undefined; customer: string | undefined; status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', timeout: 20_000 });
  const out = new Map<string, string>();
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = /^(pos|customer)=(true|false)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return { pos: out.get('pos'), customer: out.get('customer'), status: r.status, stderr: r.stderr ?? '' };
}

const both = (paths: string[]) => run(paths.join('\n') + '\n');

describe('T-417 ci-affected-apps', () => {
  it('UNKNOWN -> both true. Mutant: fail-closed default', () => {
    const r = run('UNKNOWN\n');
    expect(r.status).toBe(0);
    expect([r.pos, r.customer]).toEqual(['true', 'true']);
  });

  it('docs-only change -> both false', () => {
    expect(both(['docs/x.md'])).toMatchObject({ pos: 'false', customer: 'false' });
  });

  it('ERP-only change -> both false', () => {
    expect(both(['apps/erp/src/a.ts'])).toMatchObject({ pos: 'false', customer: 'false' });
  });

  it('apps/pos change -> pos only', () => {
    expect(both(['apps/pos/src/a.tsx'])).toMatchObject({ pos: 'true', customer: 'false' });
  });

  it('apps/customer change -> customer only', () => {
    expect(both(['apps/customer/src/a.tsx'])).toMatchObject({ pos: 'false', customer: 'true' });
  });

  it('a sibling-name prefix is not a match (apps/pos2/x, apps/posters/x)', () => {
    expect(both(['apps/pos2/x.ts', 'apps/customers-old/x.ts'])).toMatchObject({ pos: 'false', customer: 'false' });
  });

  it.each([
    'packages/core/src/a.ts',
    'package-lock.json',
    'package.json',
    'tsconfig.json',
    '.github/workflows/ci.yml',
    '.github/workflows/app-build.yml',
    'scripts/ci-affected-apps.mjs',
    'scripts/apk-signing-gate.mjs',
  ])('%s -> both true', (p) => {
    expect(both([p])).toMatchObject({ pos: 'true', customer: 'true' });
  });

  it('other workflows and scripts do not trigger apps (deploy.yml, scripts/month-end.ts)', () => {
    expect(both(['.github/workflows/deploy.yml', 'scripts/month-end.ts'])).toMatchObject({ pos: 'false', customer: 'false' });
  });

  it('a mixed change is the union', () => {
    expect(both(['docs/a.md', 'apps/pos/src/a.tsx', 'apps/erp/src/b.ts'])).toMatchObject({ pos: 'true', customer: 'false' });
    expect(both(['apps/pos/src/a.tsx', 'apps/customer/src/b.tsx'])).toMatchObject({ pos: 'true', customer: 'true' });
  });

  it('tolerates CRLF input and blank lines', () => {
    const r = run('docs/a.md\r\n\r\napps/customer/src/a.tsx\r\n');
    expect([r.pos, r.customer]).toEqual(['false', 'true']);
  });

  it('always prints both keys and exits 0 for a normal change', () => {
    const r = both(['apps/erp/src/a.ts']);
    expect(r.status).toBe(0);
    expect(r.pos).toBeDefined();
    expect(r.customer).toBeDefined();
  });
});
