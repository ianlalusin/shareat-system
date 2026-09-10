import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-264 / DEF-284 slice 1 — "something must CREATE fiscal periods."
 *
 * ⭐ `createOrganization`'s own case in `first-run-setup.test.ts` already proves the happy path
 * (12 fresh months, genuinely adjacent, no gap or overlap at the Dec/Jan seam). This file proves
 * the two things that path cannot: idempotency on a SECOND run, and the failure mode the
 * orchestrator found by executing rather than reasoning — a bare `ON CONFLICT DO NOTHING` against
 * this table's EXCLUDE constraint swallows a PARTIAL overlap exactly like an exact duplicate, so a
 * backfill against an org that already holds one wide legacy period must not be allowed to report
 * "0 inserted" as if that meant "already fine" without also saying where coverage actually ends.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, fiscalPeriodsRepo, APP_ROLE, type Tx } from '@shareat/db';
import { listFindings, closeReadiness, fiscalPeriodSeedWindow } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** An otherwise-ordinary org (chart of accounts, a store, an admin) with NO fiscal periods — the
 *  exact shape a freshly bootstrapped org had before T-264/DEF-284, on every path except a test or
 *  `dev-seed-inventory.ts`'s own hand-rolled row. */
async function bareOrg(hint: string): Promise<string> {
  const code = uid(`fp-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
  return orgId;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

describe('seedCalendarMonths — idempotency', () => {
  it('a second run against the same window inserts nothing and reports it as skipped, not silent', async () => {
    const orgId = await bareOrg('idem');
    const window = fiscalPeriodSeedWindow();

    const first = await transaction((tx) => fiscalPeriodsRepo.seedCalendarMonths(tx, orgId, window));
    expect(first.periodsInserted).toBe(12);
    expect(first.periodsSkipped).toBe(0);

    const second = await transaction((tx) => fiscalPeriodsRepo.seedCalendarMonths(tx, orgId, window));
    expect(second.periodsInserted).toBe(0);
    expect(second.periodsSkipped).toBe(12);

    const [row] = await sql<{ n: string }[]>`
      select count(*)::text n from fiscal_periods where org_id = ${orgId}`;
    expect(row!.n).toBe('12'); // not 24 — the second run truly added nothing.
  });
});

describe('seedCalendarMonths — the partial-overlap trap the orchestrator proved by executing it', () => {
  it('⛔ an org already covered by one wide legacy period reports 0 inserted / 12 skipped — NOT a silent success', async () => {
    const orgId = await bareOrg('wide');
    // The exact shape several dev/test fixtures already carry (task report).
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, '2020-01-01', '2035-12-31', 'open')`;

    const window = fiscalPeriodSeedWindow();
    const result = await transaction((tx) => fiscalPeriodsRepo.seedCalendarMonths(tx, orgId, window));

    // ⚠️ THE POINT: every one of the 12 candidate months conflicts with the wide period, so
    // `periodsInserted` is 0 — indistinguishable, by that number alone, from "already fully
    // seeded". `periodsSkipped` says which one actually happened.
    expect(result.periodsInserted).toBe(0);
    expect(result.periodsSkipped).toBe(12);

    // And the number that actually answers "is this org fine now?" — yes, because the legacy
    // period already reaches 2035, far past any runway threshold.
    const coverage = await transaction((tx) => fiscalPeriodsRepo.latestPeriodEnd(tx, orgId));
    expect(coverage).toBe('2035-12-31');
  });
});

describe('latestPeriodEnd', () => {
  it('is null for an org with no periods at all', async () => {
    const orgId = await bareOrg('bare');
    const coverage = await transaction((tx) => fiscalPeriodsRepo.latestPeriodEnd(tx, orgId));
    expect(coverage).toBeNull();
  });
});

describe('fiscalPeriodRunwayLow — the runway warning, soft, never blocking a close', () => {
  const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const PERIOD = new Date().toISOString().slice(0, 7);

  it('⛔ fires SOFT when an org has zero fiscal periods at all', async () => {
    const orgId = await bareOrg('zero');
    const feed = await asOrg(orgId, (tx) => listFindings(tx, orgId, { period: PERIOD }));
    const finding = feed.findings.find((x) => x.kind === 'fiscalPeriodRunwayLow');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(/no fiscal periods at all/);

    // ⭐ Change 1's whole point: this must NEVER block a close. `closeReadiness` filters on `hard`
    // only, and a soft finding is not itself sufficient to block — proved here, not assumed.
    const readiness = await asOrg(orgId, (tx) => closeReadiness(tx, orgId, PERIOD));
    expect(readiness.blocking.some((f) => f.kind === 'fiscalPeriodRunwayLow')).toBe(false);
  });

  it('⛔ says the DIFFERENT true thing when periods exist but none are open — never "no periods", never "reopen"', async () => {
    const orgId = await bareOrg('all-closed');
    // Two closed periods, on purpose (plural) — proves the count is real, not a hardcoded "1".
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${daysFromNow(-400)}, ${daysFromNow(-31)}, 'closed'),
             (${orgId}, ${daysFromNow(-30)}, ${daysFromNow(-1)}, 'closed')`;

    const feed = await asOrg(orgId, (tx) => listFindings(tx, orgId, { period: PERIOD }));
    const finding = feed.findings.find((x) => x.kind === 'fiscalPeriodRunwayLow');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('soft');
    // Both halves of the orchestrator's objection to the old wording, disproved directly.
    expect(finding!.detail).not.toMatch(/no fiscal periods at all/);
    expect(finding!.detail).not.toMatch(/reopen/i);
    expect(finding!.detail).toMatch(/has 2 fiscal period\(s\), but none of them are open/);
  });

  it('⛔ fires SOFT when coverage runs out within the 60-day window', async () => {
    const orgId = await bareOrg('low');
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${daysFromNow(-400)}, ${daysFromNow(30)}, 'open')`;

    const feed = await asOrg(orgId, (tx) => listFindings(tx, orgId, { period: PERIOD }));
    const finding = feed.findings.find((x) => x.kind === 'fiscalPeriodRunwayLow');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('soft');
    expect(finding!.detail).toMatch(daysFromNow(30));
  });

  it('stays quiet when coverage comfortably exceeds the 60-day window', async () => {
    const orgId = await bareOrg('healthy');
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${orgId}, ${daysFromNow(-400)}, ${daysFromNow(400)}, 'open')`;

    const feed = await asOrg(orgId, (tx) => listFindings(tx, orgId, { period: PERIOD }));
    expect(feed.findings.some((x) => x.kind === 'fiscalPeriodRunwayLow')).toBe(false);
  });
});
