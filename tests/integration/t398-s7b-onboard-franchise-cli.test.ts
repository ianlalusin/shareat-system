/**
 * T-398 S7b (TESTER) - scripts/onboard-franchise.ts: dry run by default, --confirm writes, second run says "already onboarded: <code>" (O2, O3), the
 * mock-vs-production guard acts before any connection (O12 at the CLI). docs/tasks/398-s7/S7-REFRESH.md s5, s11.
 * The script is spawned with DATABASE_URL = SYSTEM_DATABASE_URL = TEST_DATABASE_URL. The data file is a temp copy of the MOCK file (mock:true, so it may
 * live outside the repo) with unique codes and `franchisorOrgCode` set to a franchisor org this test creates.
 *
 * RED TODAY for one reason: scripts/onboard-franchise.ts does not exist (tsx: "Cannot find module"), so every leg sees a non-zero exit with no plan.
 *
 * ASSUMED CLI (the refresh): `--file <path> --by <person id> [--confirm]`, space-separated values. Dry-run output contains the text
 * "(dry run: nothing written)"; a repeat run prints "already onboarded: <org code>" and exits 0.
 *
 * MUTANTS: dry run that writes; --confirm ignored; second run creates a twin; --by optional; mock guard after the connection (production unreachable
 * from here, so a late guard shows as a connection error, not the mock refusal).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDb, systemTransaction } from '@shareat/db';
import { createFirstAdmin, createOrganization } from '../../packages/domain/src/organizations';

const url = process.env.TEST_DATABASE_URL!;
const sql = postgres(url, { max: 4 });
const dirs: string[] = [];
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const script = join(repoRoot, 'scripts', 'onboard-franchise.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const MOCK = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'fixtures', 'onboarding', 'MOCK-padre-garcia.onboarding.json'), 'utf8'));
let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`.toUpperCase();

async function setup() {
  const t = tag();
  const code = `S7BC${t}`;
  const l = await systemTransaction(async (tx) => {
    const org = await createOrganization(tx, { code, name: `Mock Franchisor Co ${t}` });
    const admin = await createFirstAdmin(tx, { orgId: org.orgId, displayName: `Mock Ian ${t}` });
    return { orgId: org.orgId, adminId: admin.personId };
  });
  const dir = mkdtempSync(join(tmpdir(), 's7b-'));
  dirs.push(dir);
  const orgCode = `MOCKPG${t}`;
  const path = join(dir, 'mock.onboarding.json');
  writeFileSync(
    path,
    JSON.stringify({
      ...MOCK,
      franchisorOrgCode: code,
      org: { code: orgCode, name: `Mock Padre Garcia Foods ${t}` },
      store: { ...MOCK.store, code: `MPG${t}`, posStoreId: `MOCK-POS-${t}` },
      franchisorPerson: { ...MOCK.franchisorPerson, email: `f.${t.toLowerCase()}@example.test` },
      owner: { ...MOCK.owner, email: `o.${t.toLowerCase()}@example.test` },
    }),
    'utf8',
  );
  return { ...l, orgCode, path };
}

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, DATABASE_URL: url, SYSTEM_DATABASE_URL: url, NODE_ENV: 'development', ...env },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const orgCount = async (code: string) => (await sql<{ n: number }[]>`select count(*)::int n from organizations where code = ${code}`)[0]!.n;
const totals = async () => (await sql<{ o: number; p: number; a: number }[]>`select (select count(*) from organizations)::int o, (select count(*) from persons)::int p, (select count(*) from audit_log)::int a`)[0]!;

describe('onboard-franchise CLI', () => {
  it('no --confirm: prints the plan with "(dry run: nothing written)", exit 0, nothing written - Mutant: dry run that writes / default is confirm', async () => {
    const s = await setup();
    const before = await totals();
    const r = run(['--file', s.path, '--by', s.adminId]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('(dry run: nothing written)');
    expect(r.out).toContain(s.orgCode);
    expect(await orgCount(s.orgCode)).toBe(0);
    expect(await totals()).toEqual(before);
  }, 120_000);

  it('--confirm writes the company; a repeat run prints "already onboarded: <code>", exit 0, writes nothing - Mutant: --confirm ignored / second run creates a twin', async () => {
    const s = await setup();
    const first = run(['--file', s.path, '--by', s.adminId, '--confirm']);
    expect(first.status, first.out).toBe(0);
    expect(first.out).not.toContain('(dry run: nothing written)');
    expect(await orgCount(s.orgCode)).toBe(1);
    const before = await totals();
    const second = run(['--file', s.path, '--by', s.adminId, '--confirm']);
    expect(second.status, second.out).toBe(0);
    expect(second.out).toContain(`already onboarded: ${s.orgCode}`);
    expect(await orgCount(s.orgCode)).toBe(1);
    expect(await totals()).toEqual(before);
  }, 180_000);

  it('--by is required: refused, nothing written - Mutant: --by optional (audit actor guessed)', async () => {
    const s = await setup();
    const before = await totals();
    const r = run(['--file', s.path, '--confirm']);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/--by/);
    expect(await totals()).toEqual(before);
  }, 120_000);

  it('O12 at the CLI: a mock file against the production host is refused before any connection - Mutant: guard runs after the connection', async () => {
    const s = await setup();
    const prod = 'postgres://u:pw-never-echo@shareat-system-db-do-user-39783702-0.m.db.ondigitalocean.com:25060/shareat';
    const r = run(['--file', s.path, '--by', s.adminId, '--confirm'], { NODE_ENV: undefined, SYSTEM_DATABASE_URL: prod, DATABASE_URL: prod });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/mock/i);
    expect(r.out).not.toMatch(/ECONN|ENOTFOUND|timeout|getaddrinfo/i);
    expect(r.out).not.toContain('pw-never-echo');
    expect(await orgCount(s.orgCode)).toBe(0);
  }, 120_000);
});
