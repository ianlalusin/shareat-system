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
import { closeDb, schedulerRepo, transaction } from '@shareat/db';
import { lastCompletedPeriod, runMonthEnd } from '@shareat/domain';

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
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
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
  return transaction((tx) => schedulerRepo.recentRuns(tx, orgId, 50));
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

describe('the default period', () => {
  it('is the LAST COMPLETED month, never the current one', () => {
    // ⚠️ Running on the 1st is the normal case. Depreciating a month that has not finished would
    // post a charge for days that have not happened.
    expect(lastCompletedPeriod(new Date('2026-08-01T02:00:00Z'))).toBe('2026-07');
    expect(lastCompletedPeriod(new Date('2026-08-31T23:59:00Z'))).toBe('2026-07');
    // And it crosses the year boundary the obvious way.
    expect(lastCompletedPeriod(new Date('2027-01-01T02:00:00Z'))).toBe('2026-12');
  });
});
