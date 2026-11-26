/**
 * T-417 case 8 / slice B3 - `scripts/ci-affected-apps.mjs` decides which app CI jobs run.
 * Spawned as `node <script>` (root `allowJs` is false, so no TS import of the .mjs).
 * Input: changed paths on stdin (one per line) or the literal `UNKNOWN`. Output: `customer=...` only
 * (T-588 retired apps/pos). It FAILS OPEN: anything unknown means true.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve(__dirname, '..', '..', 'scripts', 'ci-affected-apps.mjs');

function run(stdin: string): { keys: string[]; customer: string | undefined; status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', timeout: 20_000 });
  const out = new Map<string, string>();
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const m = /^(\w+)=(true|false)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return { keys: [...out.keys()], customer: out.get('customer'), status: r.status, stderr: r.stderr ?? '' };
}

const both = (paths: string[]) => run(paths.join('\n') + '\n');

describe('T-417 ci-affected-apps', () => {
  it('UNKNOWN -> true. Mutant: fail-closed default', () => {
    const r = run('UNKNOWN\n');
    expect(r.status).toBe(0);
    expect(r.customer).toBe('true');
  });

  it('docs-only change -> false', () => {
    expect(both(['docs/x.md'])).toMatchObject({ customer: 'false' });
  });

  it('ERP-only change -> false', () => {
    expect(both(['apps/erp/src/a.ts'])).toMatchObject({ customer: 'false' });
  });

  it('apps/customer change -> true', () => {
    expect(both(['apps/customer/src/a.tsx'])).toMatchObject({ customer: 'true' });
  });

  it('a retired apps/pos path no longer selects anything, and no pos key is printed. Mutant: pos back in APPS', () => {
    const r = both(['apps/pos/src/a.tsx']);
    expect(r.customer).toBe('false');
    expect(r.keys).toEqual(['customer']);
  });

  it('a sibling-name prefix is not a match (apps/customers-old/x)', () => {
    expect(both(['apps/customers-old/x.ts'])).toMatchObject({ customer: 'false' });
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
  ])('%s -> true', (p) => {
    expect(both([p])).toMatchObject({ customer: 'true' });
  });

  it('other workflows and scripts do not trigger apps (deploy.yml, scripts/month-end.ts)', () => {
    expect(both(['.github/workflows/deploy.yml', 'scripts/month-end.ts'])).toMatchObject({ customer: 'false' });
  });

  it('a mixed change is the union', () => {
    expect(both(['docs/a.md', 'apps/erp/src/b.ts'])).toMatchObject({ customer: 'false' });
    expect(both(['docs/a.md', 'apps/customer/src/b.tsx', 'apps/erp/src/b.ts'])).toMatchObject({ customer: 'true' });
  });

  it('tolerates CRLF input and blank lines', () => {
    const r = run('docs/a.md\r\n\r\napps/customer/src/a.tsx\r\n');
    expect(r.customer).toBe('true');
  });

  it('always prints the customer key and exits 0 for a normal change', () => {
    const r = both(['apps/erp/src/a.ts']);
    expect(r.status).toBe(0);
    expect(r.customer).toBeDefined();
  });
});
