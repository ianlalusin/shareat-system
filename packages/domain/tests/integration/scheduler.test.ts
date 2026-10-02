import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-140 — the month-end scheduler, and the live half of **DEF-044**.
 *
 * ⭐ The tests that matter here are not "does it post" — the runners already had that. They are
 * **"does it tell the truth about what it did"**, because v1's failure was never a bad posting. It
 * was two months of nothing, invisible, found by an audit.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, schedulerRepo, systemTransaction, withOrgPrincipal } from '@shareat/db';
import { lastCompletedPeriod, runFindingObservation, runMonthEnd } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** An org with a store, a January-2026 period, and one depreciable asset. */
async function orgWithAsset(hint: string, opts: { withPeriod: boolean }) {
  const code = uid(`sch-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  // T-346 S2: opening_date on/before every asset's acquired_on below, so the S2 in-service fill
  // trigger (once it lands) derives 'store_opening' in-service dates equal to acquired_on rather
  // than leaving these assets HELD (opening_date NULL) — this file's whole point is asserting real
  // depreciation postings happen.
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, opening_date) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id
  `;
  const [person] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${org!.id}, 'Owner') returning id
  `;
  if (opts.withPeriod) {
    await sql`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${org!.id}, '2026-01-01', '2026-01-31', 'open')
    `;
  }
  // A ₱120,000 asset over 12 months = ₱10,000 a month, starting January.
  const [asset] = await sql<{ id: string }[]>`
    insert into fixed_assets
      (org_id, store_id, name, category, acquired_on, cost, salvage_value,
       useful_life_months, interval, status, created_by)
    values (${org!.id}, ${store!.id}, ${`Fryer ${hint}`}, 'kitchen_equipment', '2026-01-01',
            '120000.00', '0.00', 12, 'monthly', 'active', ${person!.id})
    returning id
  `;
  return { orgId: org!.id, storeId: store!.id, assetId: asset!.id };
}

async function runsFor(orgId: string) {
  // ⛔ `withOrgPrincipal`, not a bare `transaction()` — DEF-218. `scheduler_runs` rows are WRITTEN
  // through `systemTransaction()` (so they land), then read back here; with no principal the read
  // returns zero rows and no error, and every count assertion below silently becomes 0.
  return withOrgPrincipal(orgId, (tx) => schedulerRepo.recentRuns(tx, orgId, 50));
}

/**
 * T-233 — DEF-219: test-local DDL, never a migration. Refuses every INSERT or UPDATE on the named
 * table for one org id, so a real write is refused exactly like a schema or outage fault would
 * refuse it. `t233_`-prefixed by the orchestrator's approval condition.
 *
 * ⚠️ The function is shared across every trigger this file creates (they can nest — T3 refuses a
 * write on TWO tables at once) so only the TRIGGER is dropped in this helper's own `finally`; the
 * function itself is dropped once, in this file's `afterAll`, after every trigger referencing it
 * is long gone. Dropping it per-call would fail with "other objects depend on it" the moment two
 * of these are nested. Belt-and-braces: the `afterAll` drops every trigger name too, in case a
 * killed run skipped this `finally` and left the lane DB armed for the next test.
 */
async function withRefusalTrigger(
  table: string,
  event: 'insert' | 'update',
  brokenOrgId: string,
  fn: () => Promise<void>,
): Promise<void> {
  const trigger = `t233_refuse_${table}_${event}`;
  await sql.unsafe(`
    create or replace function t233_refuse_run() returns trigger as $$
    begin raise exception 'T233: refused'; end $$ language plpgsql;
  `);
  // ⭐ Idempotent, unlike `create or replace function` above: a killed run (Ctrl-C, a timeout)
  // skips both this helper's `finally` and the file's `afterAll`, so the NEXT run's bare `create
  // trigger` would die on "already exists" BEFORE its own `try` — one confusing red run whose own
  // `finally` then never fires either.
  await sql.unsafe(`drop trigger if exists ${trigger} on ${table}`);
  await sql.unsafe(`
    create trigger ${trigger} before ${event} on ${table}
      for each row when (new.org_id = '${brokenOrgId}'::uuid) execute function t233_refuse_run();
  `);
  try {
    await fn();
  } finally {
    await sql.unsafe(`drop trigger if exists ${trigger} on ${table}`);
  }
}

beforeAll(async () => {
  await sql`
    truncate table
      scheduler_runs, prepaid_items, money_transfers, money_accounts, sales_day_tenders,
      sales_day_channels, sales_days, sales_channels, expense_payments, expenses,
      expense_categories, person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts, fixed_assets,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  // Belt and braces (approval condition 1): a killed test's own `finally` might never have run.
  await sql.unsafe(`drop trigger if exists t233_refuse_scheduler_runs_insert on scheduler_runs`);
  await sql.unsafe(`drop trigger if exists t233_refuse_scheduler_runs_update on scheduler_runs`);
  await sql.unsafe(`drop trigger if exists t233_refuse_finding_occurrences_insert on finding_occurrences`);
  await sql.unsafe(`drop function if exists t233_refuse_run()`);
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('⭐ the run records itself — including when it does nothing', () => {
  it('posts on the first run and reports ZERO posted on the second', async () => {
    const o = await orgWithAsset('idem', { withPeriod: true });

    const first = await runMonthEnd({ period: '2026-01', orgId: o.orgId, trigger: 'manual' });
    const dep1 = first.outcomes.find((x) => x.job === 'depreciation')!;
    expect(dep1.posted).toBe(1);
    expect(dep1.failed).toBe(0);

    // ⛔ THE BUG THIS PINS. `runDepreciation.posted` lists postings CONSIDERED, not written, so
    // reporting its length made a repeat run claim "posted 1" while writing nothing. A scheduler
    // that reports work it did not do looks healthy forever — DEF-044 wearing the other mask.
    const second = await runMonthEnd({ period: '2026-01', orgId: o.orgId });
    const dep2 = second.outcomes.find((x) => x.job === 'depreciation')!;
    expect(dep2.posted).toBe(0);
    expect(dep2.skipped).toBe(1);

    // And the ledger agrees: one entry, not two.
    const entries = await sql<{ n: number }[]>`
      select count(*)::int as n from journal_entries
      where org_id = ${o.orgId} and source_type = 'depreciation'
    `;
    expect(entries[0]!.n).toBe(1);
  });

  it('⭐ a run that posts NOTHING still writes a row — the whole point of the table', async () => {
    const o = await orgWithAsset('noop', { withPeriod: true });
    await runMonthEnd({ period: '2026-01', orgId: o.orgId });
    await runMonthEnd({ period: '2026-01', orgId: o.orgId });

    const runs = await runsFor(o.orgId);
    // Two runs x two jobs. ⚠️ "It ran and there was nothing to do" and "it never ran" must be
    // tellable apart, and postings alone cannot tell them apart — a stopped scheduler makes none,
    // and none looks exactly like nothing-to-do. That is DEF-044 in one sentence.
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.finishedAt !== null)).toBe(true);
  });

  it('records the TRIGGER, so a dead cron is distinguishable from a quiet one', async () => {
    const o = await orgWithAsset('trigger', { withPeriod: true });
    await runMonthEnd({ period: '2026-01', orgId: o.orgId, trigger: 'cron' });
    await runMonthEnd({ period: '2026-01', orgId: o.orgId, trigger: 'manual' });

    const runs = await runsFor(o.orgId);
    // "Nobody has run it since March" and "the cron died in March and someone has been clicking
    // the button" are different problems with different fixes.
    expect(runs.filter((r) => r.trigger === 'cron')).toHaveLength(2);
    expect(runs.filter((r) => r.trigger === 'manual')).toHaveLength(2);
  });
});

describe('⛔ a failure is recorded, with its reason, and does not stop the run', () => {
  it('the missing-fiscal-period failure reaches the row verbatim', async () => {
    // No fiscal period at all — the most likely real failure, and the one T-124 §12.1 names.
    const o = await orgWithAsset('nofiscal', { withPeriod: false });

    const result = await runMonthEnd({ period: '2026-01', orgId: o.orgId });
    expect(result.hadFailures).toBe(true);

    const dep = result.outcomes.find((x) => x.job === 'depreciation')!;
    expect(dep.failed).toBe(1);
    expect(dep.failures[0]!.reason).toMatch(/no fiscal period covers/);

    const runs = await runsFor(o.orgId);
    const row = runs.find((r) => r.job === 'depreciation')!;
    expect(row.outcome).toBe('failed');
    // ⚠️ Verbatim. A scheduler that swallows this rebuilds the silence the whole task removes.
    expect(row.failures?.[0]?.reason).toMatch(/no fiscal period covers/);
    expect(row.failures?.[0]?.subjectName).toContain('Fryer');
  });

  it('⭐ one org failing does not stop the next', async () => {
    const broken = await orgWithAsset('broken', { withPeriod: false });
    const healthy = await orgWithAsset('healthy', { withPeriod: true });

    // Every org in one sweep — which is how the cron actually runs.
    const result = await runMonthEnd({ period: '2026-01' });

    const brokenDep = result.outcomes.find(
      (x) => x.orgId === broken.orgId && x.job === 'depreciation',
    )!;
    const healthyDep = result.outcomes.find(
      (x) => x.orgId === healthy.orgId && x.job === 'depreciation',
    )!;
    expect(brokenDep.failed).toBe(1);
    // ⭐ The healthy org still posted. A sweep that aborts on the first bad org would leave every
    // org after it silently unprocessed — which is the same invisibility, just wider.
    expect(healthyDep.posted).toBe(1);
  });

  it('the outcome and the failure count can never disagree', async () => {
    const o = await orgWithAsset('outcome', { withPeriod: true });
    await runMonthEnd({ period: '2026-01', orgId: o.orgId });
    const runs = await runsFor(o.orgId);
    // Guaranteed by a CHECK constraint AND derived in the repo rather than passed in, so the
    // screen cannot report "ok" beside a list of failures.
    for (const r of runs) {
      if (r.outcome === 'ok') expect(r.failedCount).toBe(0);
      if (r.failedCount > 0) expect(r.outcome).not.toBe('ok');
    }
  });
});

describe('⛔ T-368 — the scheduled depreciation run names a month it skipped because its period is closed', () => {
  /** Everything the run row holds, as text per column: whichever column carries the note is found here, and a column added later is covered. */
  async function rowText(orgId: string): Promise<{ outcome: string; texts: Record<string, string> }> {
    const [r] = await sql<{ j: Record<string, unknown> }[]>`
      select to_jsonb(r) as j from scheduler_runs r where org_id = ${orgId} and job = 'depreciation' order by started_at desc limit 1`;
    const j = r!.j;
    const texts: Record<string, string> = {};
    for (const [k, v] of Object.entries(j)) {
      if (['id', 'org_id', 'started_at', 'finished_at'].includes(k) || v === null) continue;
      texts[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return { outcome: String(j.outcome), texts };
  }

  it("January owed and its period CLOSED: the cron run is not 'failed', and its row says 'closed month' with the count 1 (a skip is not silent)", async () => {
    const o = await orgWithAsset('closedskip', { withPeriod: false });
    const [person] = await sql<{ id: string }[]>`select id from persons where org_id = ${o.orgId} limit 1`;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
              values (${o.orgId}, '2026-01-01', '2026-01-31', 'closed', now(), ${person!.id})`;

    const result = await runMonthEnd({ period: '2026-01', orgId: o.orgId, trigger: 'cron' });
    const dep = result.outcomes.find((x) => x.job === 'depreciation')!;
    expect(dep.failed, 'a closed month was recorded as a failure').toBe(0);

    const row = await rowText(o.orgId);
    expect(row.outcome, 'a skip is not a failure').not.toBe('failed');
    expect(row.texts.failed_count, 'a notice is not a failure: failed_count stays 0 when only a notice is present').toBe('0');
    const holder = Object.entries(row.texts).find(([, t]) => /closed month/i.test(t));
    expect(holder, `no column of the run row mentions a closed month: ${JSON.stringify(row.texts)}`).toBeDefined();
    expect(holder![1]).toMatch(/\b1\b/);
  });

  it('control: a run with nothing skipped has no such text', async () => {
    const o = await orgWithAsset('nothingskipped', { withPeriod: true });
    await runMonthEnd({ period: '2026-01', orgId: o.orgId, trigger: 'cron' });
    const row = await rowText(o.orgId);
    expect(row.outcome).toBe('ok');
    expect(Object.values(row.texts).some((t) => /closed month/i.test(t)), JSON.stringify(row.texts)).toBe(false);
  });
});

describe('⭐ T-233 — DEF-219: startRun inside the per-org boundary', () => {
  it('T1 — one org\'s first write is refused; the next org still runs', async () => {
    const broken = await orgWithAsset('t233-t1-broken', { withPeriod: true });
    const healthy = await orgWithAsset('t233-t1-healthy', { withPeriod: true });
    const [brokenOrg] = await sql<{ name: string }[]>`select name from organizations where id = ${broken.orgId}`;

    await withRefusalTrigger('scheduler_runs', 'insert', broken.orgId, async () => {
      const result = await runMonthEnd({ period: '2026-01' });

      // ⭐ Before the fix this REJECTS — that is the failure to watch.
      const brokenOutcomes = result.outcomes.filter((o) => o.orgId === broken.orgId);
      expect(brokenOutcomes).toHaveLength(2); // depreciation + amortisation
      for (const o of brokenOutcomes) {
        expect(o.error).toMatch(/could not open/);
        expect(o.error).toMatch(/T233: refused/);
        expect(o.posted).toBe(0);
        expect(o.orgName).toBe(brokenOrg!.name);
      }

      // The healthy org still did its real work.
      const healthyDep = result.outcomes.find(
        (o) => o.orgId === healthy.orgId && o.job === 'depreciation',
      )!;
      expect(healthyDep.posted).toBe(1);

      expect(result.hadFailures).toBe(true);
    });

    const brokenRuns = await runsFor(broken.orgId);
    expect(brokenRuns).toHaveLength(0);
    const healthyRuns = await runsFor(healthy.orgId);
    expect(healthyRuns).toHaveLength(2);
    expect(healthyRuns.every((r) => r.finishedAt !== null)).toBe(true);
  });

  it('T2 — every org\'s first write refused, nothing is skipped', async () => {
    // A malformed period trips `scheduler_runs_period_shape_check` for every org — no trigger
    // needed. This is the shape of the real DEF-219 finding: `scheduler_runs_job_check` refusing
    // `recurring_expenses` before 0136 widened it.
    // `listOrgsToRun` enumerates EVERY org, so no principal can express it — production reaches it
    // through `systemTransaction()` (`scheduler/index.ts:218`) and this wraps at the same layer.
    const orgsBefore = await systemTransaction((tx) => schedulerRepo.listOrgsToRun(tx));
    const [runsBefore] = await sql<{ n: number }[]>`select count(*)::int as n from scheduler_runs`;

    const result = await runMonthEnd({ period: '2026-1' });

    expect(result.outcomes).toHaveLength(orgsBefore.length * 2);
    for (const o of result.outcomes) {
      expect(o.error).toMatch(/could not open/);
      expect(o.posted).toBe(0);
    }
    expect(result.hadFailures).toBe(true);

    const [runsAfter] = await sql<{ n: number }[]>`select count(*)::int as n from scheduler_runs`;
    expect(runsAfter!.n).toBe(runsBefore!.n);
  });

  it('T3 — the failure is recorded per org, and failRun\'s own failure does not escape', async () => {
    // ⚠️ Every business job's real WORK is internally hardened per-item (T-233's own finding 3's
    // premise: `reference_postgres_batch_needs_savepoint`), so a business-rule fault like "no
    // fiscal period" is CAUGHT into `failures` rather than thrown — proven by the existing
    // "missing-fiscal-period" test above landing on `dep.failures[0]`, never `dep.error`. Guard B
    // needs a `work()` that genuinely rejects, and `runFindingObservation`'s closure has no
    // per-item catch of its own around `recordFindingObservations` — so a refused write INSIDE it
    // propagates uncaught, which is exactly Guard B's contract.
    const broken = await orgWithAsset('t233-t3', { withPeriod: true });
    // `lastCompletedPeriod` of this clock is '2026-01' — the org's one active asset has nothing
    // booked for it yet, so `periodicPostingsMissed` fires `depreciationNotBooked:2026-01` and
    // `observeFinding` actually attempts its INSERT into `finding_occurrences`.
    const nowMs = Date.parse('2026-02-15T00:00:00Z');

    // Two refusals nested: the org's INSERT into `finding_occurrences` (so `work()` itself
    // throws) AND the org's `failRun` UPDATE on `scheduler_runs` (so recording the failure ALSO
    // fails) — together proving failRun's own refusal is appended, not left to escape.
    await withRefusalTrigger('scheduler_runs', 'update', broken.orgId, async () => {
      await withRefusalTrigger('finding_occurrences', 'insert', broken.orgId, async () => {
        const result = await runFindingObservation({ orgId: broken.orgId, nowMs });
        const outcome = result.outcomes[0]!;
        expect(outcome.error).toMatch(/T233: refused/);
        // ⭐ failRun's own refusal is appended, not left to escape and reject the run.
        expect(outcome.error).toMatch(/could not be closed/);
        expect(outcome.posted).toBe(0);
      });
    });

    const rows = await sql<{ finished_at: Date | null }[]>`
      select finished_at from scheduler_runs where org_id = ${broken.orgId} and job = 'finding_observation'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.finished_at).toBeNull();

    const unfinished = await withOrgPrincipal(broken.orgId, (tx) =>
      schedulerRepo.unfinishedRuns(tx, broken.orgId),
    );
    expect(unfinished.some((r) => r.job === 'finding_observation')).toBe(true);
  });

  it('T3b — guard C: finishRun refused after the work succeeded keeps the REAL posted count', async () => {
    const healthy = await orgWithAsset('t233-t3b', { withPeriod: true });

    await withRefusalTrigger('scheduler_runs', 'update', healthy.orgId, async () => {
      const result = await runMonthEnd({ period: '2026-01', orgId: healthy.orgId });
      const dep = result.outcomes.find((o) => o.job === 'depreciation')!;
      // ⭐ The answer to the steer: reporting 0 here would be the exact lie
      // `runDepreciationJob`'s own comment rails against, wearing its other face.
      expect(dep.posted).toBe(1);
      expect(dep.error).toMatch(/T233: refused/);
    });

    const rows = await sql<{ finished_at: Date | null }[]>`
      select finished_at from scheduler_runs where org_id = ${healthy.orgId} and job = 'depreciation'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.finished_at).toBeNull();

    // The work really did commit — the ledger has the entry regardless of the bookkeeping failure.
    const [entries] = await sql<{ n: number }[]>`
      select count(*)::int as n from journal_entries
      where org_id = ${healthy.orgId} and source_type = 'depreciation'`;
    expect(entries!.n).toBe(1);
  });
});

describe('the default period', () => {
  it('is the LAST COMPLETED month, never the current one — derived in Asia/Manila, not raw UTC', () => {
    // ⚠️ Running on the 1st is the normal case. Depreciating a month that has not finished would
    // post a charge for days that have not happened.
    // 2026-08-01T02:00:00Z is 2026-08-01 10:00 in Manila — still August, so the last completed
    // period is July.
    expect(lastCompletedPeriod(new Date('2026-08-01T02:00:00Z'))).toBe('2026-07');
    // ⛔ DEF-283: 2026-08-31T23:59:00Z is 2026-09-01 07:59 in Manila — the business month has
    // already rolled to September, so the last completed period is August. The raw-UTC idiom saw
    // this instant as still-August and returned July — a job firing here closed the wrong month.
    expect(lastCompletedPeriod(new Date('2026-08-31T23:59:00Z'))).toBe('2026-08');
    // And it crosses the year boundary the obvious way.
    // 2027-01-01T02:00:00Z is 2027-01-01 10:00 in Manila — still January, so the last completed
    // period is December 2026.
    expect(lastCompletedPeriod(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12');
  });

  it('⛔ DEF-283: crosses BOTH the day and the year in Manila — raw UTC was two months off true', () => {
    // 2026-12-31T17:00:00Z is 2027-01-01 01:00 in Manila: the business year has already rolled to
    // 2027 and the month to January, so the TRUE current month is 2027-01 and the last completed
    // period is 2026-12. The old raw-UTC function never saw the year turn — it read "current
    // month" as 2026-12 (a month behind truth) and then subtracted one more, returning 2026-11:
    // two months before the true current month, though only one month off the correct *answer*.
    expect(lastCompletedPeriod(new Date('2026-12-31T17:00:00Z'))).toBe('2026-12');
  });
});
