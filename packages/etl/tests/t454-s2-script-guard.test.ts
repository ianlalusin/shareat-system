/**
 * T-454 S2 (TESTER, audit round A) - the SCRIPT's own code path refuses a map with Banay-Banay as own.
 * scripts/master-data.ts `run()` (including the plan-only dry run with no --actor, which WRITES sheets) and `readinessCmd()` read
 * the database / plan Banay-Banay before any guard today (run(): assertRunTarget after a withOrgPrincipal read, then the planners;
 * readinessCmd(): assertRunTarget inside withOrgPrincipal). Nothing of `run` is exported, so the script is spawned.
 *
 * The database is an unreachable address: a call that reaches the DB dies with ECONNREFUSED, a call that is refused first dies with
 * the Banay-Banay sentence. The sheets directory must stay empty (the dry run must write no sheet for a closed store).
 * Mutant killed: guard only in scripts/lib/master-data-apply.ts, not in the script's own run()/readinessCmd().
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const B = 'iGOW7q2pZbeHWV832UNh';
const ORG = '00000000-0000-4000-8000-000000000001';
const ACTOR = '00000000-0000-4000-8000-000000000002';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 't454-script-'));
  const snapshot = join(dir, 'v1-snapshot.json');
  const text = JSON.stringify({ version: 1, stores: [], items: [], suppliers: [], arCustomers: [], staff: [], staffIdentities: [] });
  writeFileSync(snapshot, text);
  writeFileSync(join(dir, 'v1-snapshot.sha256'), `${createHash('sha256').update(text).digest('hex')}  v1-snapshot.json\n`);
  const map = join(dir, 'stores.csv');
  writeFileSync(map, ['v1_store_id,name,role,org_code,store_code', 'b9DzsnPbr1BUnY88lyT4,SharEat Lipa,own,SE,LIPA', `${B},SharEat Banay-Banay,own,SE,BNBN`].join('\r\n'));
  const sheets = join(dir, 'sheets');
  mkdirSync(sheets);
  return { snapshot, map, sheets };
}

function runScript(args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'master-data.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x', TEST_DATABASE_URL: 'postgresql://x:x@127.0.0.1:1/x', NODE_ENV: 'development' },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('T7b. the master-data script refuses Banay-Banay as own before any database read or sheet write', () => {
  it.each([
    ['run (plan-only dry run, no --actor)', (f: ReturnType<typeof fixture>) => ['run', '--snapshot', f.snapshot, '--map', f.map, '--org', ORG, '--org-code', 'SE', '--sheets', f.sheets]],
    ['run --apply', (f: ReturnType<typeof fixture>) => ['run', '--snapshot', f.snapshot, '--map', f.map, '--org', ORG, '--org-code', 'SE', '--sheets', f.sheets, '--apply', '--actor', ACTOR]],
    ['readiness', (f: ReturnType<typeof fixture>) => ['readiness', '--org', ORG, '--map', f.map, '--actor', ACTOR, '--org-code', 'SE']],
  ])('%s', (_n, args) => {
    const f = fixture();
    const r = runScript(args(f));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Banay-Banay[\s\S]*377/);
    expect(r.out).not.toMatch(/ECONNREFUSED|connect/i);
    expect(readdirSync(f.sheets)).toEqual([]);
  }, 150_000);
});
