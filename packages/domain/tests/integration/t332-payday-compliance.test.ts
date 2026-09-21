/**
 * T-332 slice B — `docs/tasks/332-store-payday-settings-and-the-sixteen-day-check.md` §4.3/§4.4,
 * amended by Amendment 1 (A1.1, A1.2, A1.5, A1.6).
 *
 * Two detectors, mutually exclusive by construction (A1.5): a store with no live config has no
 * cadence to judge, so it cannot be a branch inside the cadence detector.
 *   B1 — `payoutIntervalTooLong` — the configured cadence cannot satisfy the statutory ceiling.
 *   B2 — `attendanceConfigMissing` — DEF-249's state made visible in the feed.
 * Names ruled by the orchestrator, 2026-09-21: the kind string is PERSISTED
 * (`recordFindingObservations`, acknowledgements keyed off it), so it names the CONDITION only —
 * the statute citation belongs in the constant and the operator message, never the kind, because a
 * citation is exactly the kind of thing that gets renumbered (A1.6: this task was one draft away
 * from citing RA 11360, the SERVICE CHARGE statute, at a WAGE alert — Labor Code Art. 103).
 *
 * ⭐ **Every assertion below goes through `listFindings`, never an exported detector function
 * directly** (A1.2). The registry in `packages/db/src/repo/findings.ts` / `.../findings/index.ts`
 * is a hand-maintained array; a detector written and never spread into it runs nowhere, and a test
 * that imports and calls it directly would pass both the firing and silent case with zero
 * registration — DEF-406's exact shape. Going through the feed makes the firing case a real
 * positive control: the same absence that would hide a registration bug also silences it.
 *
 * ⭐ **Every fixture raw-inserts its store, never through `createStore`.** B2 needs a store with
 * zero config rows, and once slice A's fix lands `createStore` can never produce that state again
 * — raw-inserting keeps this file's cases true independent of whether slice A has landed.
 *
 * ⭐ **Case 5 is the one capable of proving the team wrong about something already shipped**
 * (DEF-409, filed `reported`/INFERRED, never executed). It touches no DB and no detector — it runs
 * the real, already-shipped `derivePeriods`/`payoutDateFor` across all of calendar 2026 and asserts
 * the resulting distinct payout dates as a literal array, pre-registered before this file ran for
 * the first time. If it disagrees with the array below, that is news about the product, not about
 * this test.
 */
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { listFindings } from '@shareat/domain';
import { derivePeriods, payoutDateFor, type PayoutConfig, type PeriodConfig } from '../../src/payroll/periods';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}
const sql = postgres(url, { max: 3 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const PERIOD = '2026-01';

beforeEach(async () => {
  await sql`
    truncate table store_attendance_config, person_store_scope, person_grants, person_roles,
      person_credentials, stock_locations, location_types, sales_channels, stores, persons,
      fiscal_periods, expense_categories, accounts, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** Minimal fixture — org + one raw-inserted store, no chart of accounts, no fiscal periods.
 *  Every other detector `listFindings` runs returns empty rows against an org with no data rather
 *  than throwing (measured, not assumed — see slice A's own fixtures for the same convention). */
async function makeOrgAndStore(hint: string): Promise<{ orgId: string; storeId: string }> {
  const code = uid(hint);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  return { orgId: org!.id, storeId: store!.id };
}

/** Two stores in ONE org, for case 6 — a single `listFindings` call has to attach the right
 *  finding to the right store, not merely produce the right finding somewhere in the org. */
async function makeOrgWithTwoStores(
  hint: string,
): Promise<{ orgId: string; storeAId: string; storeBId: string }> {
  const code = uid(hint);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const [storeA] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(`${hint}-a`)}, ${`Store ${hint} A`}) returning id`;
  const [storeB] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(`${hint}-b`)}, ${`Store ${hint} B`}) returning id`;
  return { orgId: org!.id, storeAId: storeA!.id, storeBId: storeB!.id };
}

/** A single store in an EXISTING org with an explicit `is_active` — case 8's filtering. */
async function insertStoreInOrg(orgId: string, hint: string, isActive: boolean): Promise<string> {
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, is_active)
    values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, ${isActive}) returning id`;
  return store!.id;
}

/**
 * Three explicit raw inserts into `store_attendance_config`, one per case shape — deliberately not
 * one dynamic column-list builder, so every statement is a plain tagged template this codebase
 * already uses elsewhere, nothing invented. Each names only the columns the case cares about;
 * everything else is left to Postgres's OWN column default, never a hand-copied literal, so the
 * "on schema defaults" case tests the real default rather than a copy of it that could drift.
 */
async function insertConfigOnDefaults(orgId: string, storeId: string): Promise<void> {
  await sql`insert into store_attendance_config (org_id, store_id, effective_from)
    values (${orgId}, ${storeId}, '2026-01-01')`;
}

async function insertConfigMonthly(orgId: string, storeId: string): Promise<void> {
  await sql`insert into store_attendance_config (org_id, store_id, effective_from, payroll_period_type)
    values (${orgId}, ${storeId}, '2026-01-01', 'monthly')`;
}

/** The DEF-409 shape: reads as semi_monthly, actually collapses via `fixed_days` + a single day. */
async function insertConfigFixedDaysCollapse(orgId: string, storeId: string): Promise<void> {
  await sql`insert into store_attendance_config
    (org_id, store_id, effective_from, payroll_period_type, semi_monthly_cutoff_day, payout_mode, payout_days)
    values (${orgId}, ${storeId}, '2026-01-01', 'semi_monthly', 15, 'fixed_days', ${sql.array([10])}::integer[])`;
}

const feed = (orgId: string) =>
  withOrgPrincipal(orgId, (tx) => listFindings(tx, orgId, { period: PERIOD }));

const findingsFor = async (orgId: string, storeId: string) =>
  (await feed(orgId)).findings.filter((f) => f.storeId === storeId);

describe('T-332 slice B — payoutIntervalTooLong / attendanceConfigMissing, through listFindings', () => {
  it('B1 fires — payrollPeriodType = "monthly" cannot satisfy the ceiling every month', async () => {
    const { orgId, storeId } = await makeOrgAndStore('b1-monthly');
    await insertConfigMonthly(orgId, storeId);

    const finding = (await findingsFor(orgId, storeId)).find((f) => f.kind === 'payoutIntervalTooLong');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`payoutIntervalTooLong:${storeId}`);
    expect(finding!.severity).toBe('soft');
    expect(finding!.storeId).toBe(storeId);
  });

  it('B1 stays silent — semi_monthly ON THE SCHEMA DEFAULTS (amended §6, not the original claim)', async () => {
    const { orgId, storeId } = await makeOrgAndStore('b1-default');
    // Every payday/period column left to its own Postgres default: semi_monthly, cutoff 15,
    // lag, lag-days 0 — the config §2 originally measured as "max 16 days, seven months a year".
    await insertConfigOnDefaults(orgId, storeId);

    const kinds = (await findingsFor(orgId, storeId)).map((f) => f.kind);
    expect(kinds).not.toContain('payoutIntervalTooLong');
  });

  it('B1 fires — DEF-409: semi_monthly + fixed_days + payoutDays=[10] LOOKS compliant and is not', async () => {
    const { orgId, storeId } = await makeOrgAndStore('b1-def409');
    await insertConfigFixedDaysCollapse(orgId, storeId);

    const finding = (await findingsFor(orgId, storeId)).find((f) => f.kind === 'payoutIntervalTooLong');
    expect(finding).toBeDefined();
    expect(finding!.key).toBe(`payoutIntervalTooLong:${storeId}`);
    expect(finding!.severity).toBe('soft');
  });

  it('B2 fires and B1 stays silent — a store with NO live config row (A1.5\'s mutual exclusivity)', async () => {
    // ⭐ No `insertConfig` call at all — this is the point of the case.
    const { orgId, storeId } = await makeOrgAndStore('b2-missing');

    const kinds = (await findingsFor(orgId, storeId)).map((f) => f.kind);
    const missing = (await findingsFor(orgId, storeId)).find((f) => f.kind === 'attendanceConfigMissing');

    expect(missing).toBeDefined();
    expect(missing!.key).toBe(`attendanceConfigMissing:${storeId}`);
    expect(missing!.severity).toBe('soft');
    expect(missing!.storeId).toBe(storeId);
    // The complement, asserted together on purpose — A1.5's invariant IS this pair, not two facts.
    expect(kinds).not.toContain('payoutIntervalTooLong');
  });

  it('B1 attaches the finding to the RIGHT store — two cadences, one org, one listFindings call', async () => {
    const { orgId, storeAId, storeBId } = await makeOrgWithTwoStores('c6-multi');
    await insertConfigMonthly(orgId, storeAId);
    await insertConfigOnDefaults(orgId, storeBId);

    const findings = (await feed(orgId)).findings.filter((f) => f.kind === 'payoutIntervalTooLong');

    // 1. the monthly store has the finding.
    const forA = findings.find((f) => f.storeId === storeAId);
    expect(forA).toBeDefined();
    // 3. ⭐ the KEY matches the monthly store, not the defaults store — acknowledgements are
    //    stored against the key, so a mismatched key is a silently broken acknowledgement even
    //    when the displayed storeId looks right.
    expect(forA!.key).toBe(`payoutIntervalTooLong:${storeAId}`);

    // 2. the defaults store does not have the finding.
    const forB = findings.find((f) => f.storeId === storeBId);
    expect(forB).toBeUndefined();

    // The whole point: exactly one finding of this kind in the feed, and it is A's, never B's —
    // a per-store loop that computes the right answer and attaches it to the wrong store would
    // pass every single-store case in this file while failing only this one.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.storeId).toBe(storeAId);
    expect(findings.some((f) => f.storeId === storeBId)).toBe(false);
  });

  it("B1's detail carries the measured maximum — 31, the same number case 5 measures independently", async () => {
    const { orgId, storeId } = await makeOrgAndStore('c7-number');
    await insertConfigFixedDaysCollapse(orgId, storeId);

    const finding = (await findingsFor(orgId, storeId)).find((f) => f.kind === 'payoutIntervalTooLong');
    expect(finding).toBeDefined();
    // ⭐ Tied to case 5: case 5 independently measures this exact config's twelve-month set of
    // distinct payout dates via the real derivePeriods/payoutDateFor and finds its maximum
    // interval is 31 (Feb's 28 is the minimum, not the number a twelve-month window reports).
    // This asserts the detector's OWN computed number agrees — two independent routes, one figure.
    // ⛔ Match the CLAUSE the number is built into, never a bare digit or an unanchored regex —
    // an unanchored `/31/` would be satisfied by a date, an id, or any other stray "31" on the
    // page; it proves a character appeared, not that a value was computed.
    expect(finding!.detail).toContain('can run 31 days between paydays');
  });

  it('is_active filters both detectors — WITH an active control for EACH detector, in the same feed', async () => {
    // ⭐ Every silence below is paired with ITS OWN detector firing elsewhere in this same feed —
    // not just any positive control. A single shared control (e.g. only payoutIntervalTooLong
    // firing) would leave attendanceConfigMissing's silence paired with a DIFFERENT detector's
    // firing: if attendanceConfigMissing's own is_active predicate excluded everything outright,
    // this case would still pass in full. Same vacuity shape cases 2/4 guard against, same remedy
    // applied per-detector: a positive case that fires, for THAT detector, in the SAME listFindings
    // call.
    const code = uid('c8-active');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;

    const inactiveMonthly = await insertStoreInOrg(orgId, 'c8-inactive-monthly', false);
    await insertConfigMonthly(orgId, inactiveMonthly);

    const inactiveNoConfig = await insertStoreInOrg(orgId, 'c8-inactive-noconfig', false);
    // No config row inserted for this one at all — the point of this half.

    const activeMonthly = await insertStoreInOrg(orgId, 'c8-active-monthly', true);
    await insertConfigMonthly(orgId, activeMonthly);

    // The attendanceConfigMissing control — active, no config, expected to fire in this same feed.
    const activeNoConfig = await insertStoreInOrg(orgId, 'c8-active-noconfig', true);

    const findings = (await feed(orgId)).findings;

    expect(findings.some((f) => f.kind === 'payoutIntervalTooLong' && f.storeId === inactiveMonthly)).toBe(false);
    expect(findings.some((f) => f.kind === 'attendanceConfigMissing' && f.storeId === inactiveNoConfig)).toBe(false);

    // Control 1: the SAME condition, on an active store, in the same feed, DOES fire — pairs with
    // the inactiveMonthly silence above.
    const activeFinding = findings.find(
      (f) => f.kind === 'payoutIntervalTooLong' && f.storeId === activeMonthly,
    );
    expect(activeFinding).toBeDefined();
    expect(activeFinding!.key).toBe(`payoutIntervalTooLong:${activeMonthly}`);

    // Control 2: the SAME condition (no config), on an active store, in the same feed, DOES fire
    // — pairs with the inactiveNoConfig silence above, for attendanceConfigMissing specifically.
    const activeMissingFinding = findings.find(
      (f) => f.kind === 'attendanceConfigMissing' && f.storeId === activeNoConfig,
    );
    expect(activeMissingFinding).toBeDefined();
    expect(activeMissingFinding!.key).toBe(`attendanceConfigMissing:${activeNoConfig}`);

    // ⭐ What this protects, stated rather than left implicit: the filter DEFERS surfacing, it
    // does not hide the underlying gap. A store reactivated without ever getting a config will
    // fire attendanceConfigMissing the moment it goes active again — the backfill script is
    // deliberately NOT filtered on is_active for exactly that reason. This case is not proof of
    // that reactivation path (out of scope here); it is proof the two detectors' own is_active
    // filter exists at all, which had no committed assertion before this.
  });
});

describe('T-332 slice B, case 5 — DEF-409 settled by measurement, not the detector', () => {
  it('⭐ FALSIFIABLE, pre-registered before this file ran: 24 periods of 2026 collapse to 12 distinct payout dates', () => {
    const periodConfig: PeriodConfig = { payrollPeriodType: 'semi_monthly', semiMonthlyCutoffDay: 15 };
    const payoutConfig: PayoutConfig = { payoutMode: 'fixed_days', payoutLagDays: 0, payoutDays: [10] };

    const allPeriods: { start: string; end: string }[] = [];
    const payoutDates: string[] = [];
    for (let month = 1; month <= 12; month++) {
      const periods = derivePeriods(periodConfig, 2026, month);
      // ⚠️ `periodIndex` reset to 0/1 PER CALENDAR MONTH — matching how a per-store, per-month
      // detector would call `payoutDateFor`, not a continuous index across the year. With a
      // single-entry `payoutDays`, `Math.min(periodIndex, payoutDays.length - 1)` clamps to 0
      // either way, so this choice does not change the dates below — but it WOULD for a
      // multi-entry `payoutDays`, and that is a builder decision, not settled here.
      periods.forEach((p, periodIndex) => {
        allPeriods.push(p);
        payoutDates.push(payoutDateFor(p, payoutConfig, periodIndex));
      });
    }

    expect(allPeriods).toHaveLength(24);

    const distinctDates = [...new Set(payoutDates)];

    // ⛔ Falsification condition, named before this ever ran:
    //   24 distinct dates  → the Math.min(periodIndex, payoutDays.length-1) trace is WRONG;
    //                        DEF-409's mechanism is wrong with it. RETRACT, do not narrow.
    //   12 distinct, but a different array → the collapse is real, only the month-roll
    //                        arithmetic differs. The row NARROWS.
    //   12 distinct, exactly this array → the row UPGRADES from reported to verified.
    expect(distinctDates).toEqual([
      '2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10',
      '2026-08-10', '2026-09-10', '2026-10-10', '2026-11-10', '2026-12-10', '2027-01-10',
    ]);
    expect(distinctDates).toHaveLength(12);

    const intervals: number[] = [];
    for (let i = 1; i < distinctDates.length; i++) {
      const a = Date.parse(`${distinctDates[i - 1]}T00:00:00Z`);
      const b = Date.parse(`${distinctDates[i]}T00:00:00Z`);
      intervals.push(Math.round((b - a) / 86_400_000));
    }
    expect(intervals).toEqual([28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    // Not one interval at or under the 16-day statutory ceiling, on a config that reads as
    // "semi_monthly" — the entire point DEF-409 exists to make visible.
    expect(Math.min(...intervals)).toBeGreaterThan(16);
  });
});
