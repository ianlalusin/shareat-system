import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-368 S4 (DEF-434) — a FAILED run must not clear the not-booked finding. `docs/tasks/368-periods-depreciation.md` §S4, legs F1-F4.
 * Today `periodicPostingsMissed` suppresses `depreciationNotBooked:P` / `amortisationNotBooked:P` whenever ANY `scheduler_runs`
 * row exists for the job and period, whatever its outcome. The target: "booked" means an effective entry exists, whatever the run
 * log says; the domain's `periodicPostingsStillMissing` stays the only judge.
 *
 * ⛔ TESTER. Spec corrections: the outcome enum is ok | partial | failed (not "error"), and the DB refuses `ok` with
 * failed_count > 0 (`scheduler_runs_outcome_matches_failures_check`), so F2's "ok run with failed_count=1" is a `partial` run
 * (posted_count 1, failed_count 1) — the honest shape of one-of-two-assets-posted.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  closePeriod,
  createPrepaidItem,
  depreciateAsset,
  listFindings,
  runAmortisationAsSystem,
  runDepreciationAsSystem,
  seedAttendanceConfig,
} from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD = '2026-01';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** One org, one store (opens 2020, so assets are in service), an admin, and January 2026 OPEN. */
async function fixture(hint: string) {
  const code = uid(`t368s4-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId: store!.id, effectiveFrom: '2026-01-01' }));
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${store!.id}, 'manual')`;
  return { orgId, storeId: store!.id, admin: actor(orgId, p!.id), personId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function asset(f: Fixture, name: string): Promise<string> {
  const [a] = await sql<{ id: string }[]>`
    insert into fixed_assets (org_id, store_id, name, category, acquired_on, cost, useful_life_months, salvage_value, status, created_by)
    values (${f.orgId}, ${f.storeId}, ${name}, 'equipment', '2026-01-01', 24000, 24, 0, 'active', ${f.personId}) returning id`;
  return a!.id;
}
const runRow = (f: Fixture, job: 'depreciation' | 'amortisation', outcome: 'ok' | 'partial' | 'failed', counts: { posted?: number; failed?: number } = {}) =>
  sql`insert into scheduler_runs (org_id, job, period, trigger, outcome, posted_count, failed_count, error)
      values (${f.orgId}, ${job}, ${PERIOD}, 'cron', ${outcome}, ${counts.posted ?? 0}, ${counts.failed ?? 0}, ${outcome === 'failed' ? 'job failed' : null})`;

const feed = (f: Fixture) => asOrg(f.orgId, (tx) => listFindings(tx, f.orgId, { period: PERIOD }));
const findingOf = async (f: Fixture, kind: string) => (await feed(f)).findings.find((x) => x.kind === kind);
const close = (f: Fixture) => asOrg(f.orgId, (tx) => closePeriod(tx, f.admin, { period: PERIOD }));

describe('F1 — a FAILED depreciation run, nothing booked', () => {
  it('depreciationNotBooked:2026-01 is a hard finding and the close is refused — red today: the failed run row silences it and the close goes through', async () => {
    const f = await fixture('f1');
    await asset(f, 'Chiller');
    await runRow(f, 'depreciation', 'failed');

    const finding = await findingOf(f, 'depreciationNotBooked');
    expect(finding, 'a failed run cleared the not-booked finding').toBeDefined();
    expect(finding!.severity).toBe('hard');
    expect(finding!.detail).toMatch(/1 asset\(s\)/);
    await expect(close(f)).rejects.toThrow(/not ready to close — blocked by: .*depreciationNotBooked/);
    const [p] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${f.orgId}`;
    expect(p!.status, 'the refused close closed the period anyway').toBe('open');
  });
});

describe('F2 — a PARTIAL run: one of two assets posted', () => {
  it('the finding survives and counts exactly the one asset still owing', async () => {
    const f = await fixture('f2');
    const posted = await asset(f, 'Chiller');
    await asset(f, 'Fryer');
    await asOrg(f.orgId, (tx) => depreciateAsset(tx, f.admin, { assetId: posted, through: PERIOD }));
    await runRow(f, 'depreciation', 'partial', { posted: 1, failed: 1 });

    const finding = await findingOf(f, 'depreciationNotBooked');
    expect(finding, 'a partial run cleared the not-booked finding').toBeDefined();
    expect(finding!.detail).toBe(`1 asset(s) are still depreciating and have no posted entry for ${PERIOD}. DEF-044: this stopped for two months in v1 and only a capture found it.`);
  });
});

describe('F3 (control) — the run posted every asset', () => {
  it('no finding, and the close goes through', async () => {
    const f = await fixture('f3');
    await asset(f, 'Chiller');
    await asset(f, 'Fryer');
    await runDepreciationAsSystem(f.orgId, { through: PERIOD });
    expect(await findingOf(f, 'depreciationNotBooked'), 'an entry-complete month still raises the finding').toBeUndefined();
    await close(f);
    const [p] = await sql<{ status: string }[]>`select status from fiscal_periods where org_id = ${f.orgId}`;
    expect(p!.status).toBe('closed');
  });

  it('with NO run row at all but every entry present: still quiet (the finding is judged by the ledger, not the run log)', async () => {
    const f = await fixture('f3b');
    const a = await asset(f, 'Chiller');
    await asOrg(f.orgId, (tx) => depreciateAsset(tx, f.admin, { assetId: a, through: PERIOD }));
    await sql`delete from scheduler_runs where org_id = ${f.orgId}`;
    expect(await findingOf(f, 'depreciationNotBooked')).toBeUndefined();
  });

  it('nothing to depreciate: no finding even after a failed run row', async () => {
    const f = await fixture('f3c');
    await runRow(f, 'depreciation', 'failed');
    expect(await findingOf(f, 'depreciationNotBooked')).toBeUndefined();
  });
});

describe('F4 — the same fix for prepaid amortisation', () => {
  const item = (f: Fixture) =>
    asOrg(f.orgId, (tx) =>
      createPrepaidItem(tx, f.admin, { storeId: f.storeId, name: 'Fire insurance', category: 'insurance', coverageStartDate: '2026-01-01', coverageMonths: 12, totalCost: '12000.00' } as never),
    );

  it('a FAILED amortisation run, nothing booked: amortisationNotBooked fires (hard)', async () => {
    const f = await fixture('f4');
    await item(f);
    await runRow(f, 'amortisation', 'failed');
    const finding = await findingOf(f, 'amortisationNotBooked');
    expect(finding, 'a failed amortisation run cleared the finding').toBeDefined();
    expect(finding!.severity).toBe('hard');
  });

  it('control: once the run really booked the month, the finding is gone', async () => {
    const f = await fixture('f4b');
    await item(f);
    await runAmortisationAsSystem(f.orgId, PERIOD);
    expect(await findingOf(f, 'amortisationNotBooked')).toBeUndefined();
  });
});
