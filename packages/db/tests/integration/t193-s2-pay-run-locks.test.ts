import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-193 S2 (TESTER) - the pay-run locks. docs/tasks/193-statutory-remittance/REFRESH.md s2 C14, s4.1 step 6, s5 S2 + case 10:
 *  - `payrollRepo.lockPayRun(tx, orgId, id)` : `SELECT ... FOR UPDATE` of ONE run, right after `getPayRun`; returns the run as it is AFTER the
 *    lock was won (so a run voided while we waited reads `voided`), or null (unknown id, or another org's).
 *  - `statutoryPaymentsRepo.lockMonthRuns(tx, orgId, month, storeIds)` : locks the month's POSTED runs of those stores in id order and returns
 *    the locked ids (ascending). The status filter is IN the locking statement, so a run voided while we waited drops out.
 * The domain guard in `voidPayRun` (refuse while a payment stands) is S4, not tested here.
 *
 * RED TODAY: `lockPayRun`, `lockMonthRuns` and the `statutoryPaymentsRepo` export do not exist.
 *
 * MUTANTS: lockPayRun without FOR UPDATE (the second caller does not wait); lockPayRun that returns the row it read BEFORE waiting (stale
 *   status); lockMonthRuns without FOR UPDATE; lockMonthRuns that selects ids first and locks them in a second statement (the voided run is
 *   still returned); month taken from period_start; voided / draft run locked; ids not ascending (deadlock order); org filter missing.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { transaction, systemTransaction, APP_ROLE, payrollRepo, statutoryPaymentsRepo as repo, type Tx } from '@shareat/db';
import { mkOrg, mkPerson, mkRun, mkWorld } from './_fixtures/t193-s2-world';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
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
const asOwner = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => systemTransaction(fn);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
/** Resolves to 'waiting' if `p` is still pending after `ms`, else 'done'. */
async function stillPending(p: Promise<unknown>, ms = 700): Promise<boolean> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await sleep(ms);
  return !done;
}

/** A org with one Lipa person and two posted October runs (X and Y) to race over. */
async function twoRuns(hint: string) {
  const f = await mkOrg(sql, hint);
  const who = await mkPerson(sql, f, 'Racer', f.lipa);
  const x = await mkRun(sql, f, { storeId: f.lipa, start: '2026-10-01', end: '2026-10-15', status: 'posted', slips: [{ who, sss: ['525.00', '1035.00', '25.00'] }] });
  const y = await mkRun(sql, f, { storeId: f.lipa, start: '2026-10-16', end: '2026-10-31', status: 'posted', slips: [{ who, sss: ['525.00', '1045.00', '25.00'] }] });
  return { f, x, y };
}

describe('T-193 S2 - payrollRepo.lockPayRun', () => {
  it('returns the run (id, status, store, period) and null for an unknown id or another org\'s run', async () => {
    const w = await mkWorld(sql, 'lock-one');
    const other = await mkOrg(sql, 'lock-one-b');
    const run = await asOrg(w.orgId, (tx) => payrollRepo.lockPayRun(tx, w.orgId, w.runs.L2));
    expect(run).toMatchObject({ id: w.runs.L2, status: 'posted', storeId: w.lipa, periodStart: '2026-10-16', periodEnd: '2026-10-31' });
    expect(await asOrg(w.orgId, (tx) => payrollRepo.lockPayRun(tx, w.orgId, crypto.randomUUID()))).toBeNull();
    // run without the role switch, so only the repo's own org filter stands between this call and the other org's run
    expect(await asOwner((tx) => payrollRepo.lockPayRun(tx, other.orgId, w.runs.L2))).toBeNull();
  });

  it('a second caller WAITS until the first commits (kills: no FOR UPDATE)', async () => {
    const { f, x } = await twoRuns('lock-wait');
    const held = deferred();
    const release = deferred();
    const first = asOrg(f.orgId, async (tx) => {
      await payrollRepo.lockPayRun(tx, f.orgId, x);
      held.resolve();
      await release.promise;
    });
    await Promise.race([held.promise, first]);
    let second: Promise<unknown> | undefined;
    try {
      second = asOrg(f.orgId, (tx) => payrollRepo.lockPayRun(tx, f.orgId, x));
      expect(await stillPending(second)).toBe(true);
    } finally {
      release.resolve();
    }
    await first;
    expect(await second).toMatchObject({ id: x, status: 'posted' });
  });

  it('after waiting it reads the run AS COMMITTED: a run voided by the lock holder comes back `voided` (kills: row read before the lock was won)', async () => {
    const { f, x } = await twoRuns('lock-reread');
    const held = deferred();
    const release = deferred();
    const voider = asOrg(f.orgId, async (tx) => {
      await payrollRepo.lockPayRun(tx, f.orgId, x);
      held.resolve();
      await release.promise;
      const ok = await payrollRepo.markPayRunVoided(tx, f.orgId, x, { voidedBy: f.adminId, reason: 'race test' });
      expect(ok).toBe(true);
    });
    await Promise.race([held.promise, voider]);
    let waiter: Promise<{ status: string } | null> | undefined;
    try {
      waiter = asOrg(f.orgId, (tx) => payrollRepo.lockPayRun(tx, f.orgId, x)) as Promise<{ status: string } | null>;
      expect(await stillPending(waiter, 500)).toBe(true);
    } finally {
      release.resolve();
    }
    await voider;
    expect((await waiter)?.status).toBe('voided');
  });
});

describe('T-193 S2 - statutoryPaymentsRepo.lockMonthRuns', () => {
  it('returns exactly the POSTED runs whose period_end is in the month, for the named stores, ids ascending (kills: month by period_start; voided / draft locked; wrong order; org filter)', async () => {
    const w = await mkWorld(sql, 'lock-month');
    const other = await mkWorld(sql, 'lock-month-b');
    const locked = (month: string, stores: string[]) => asOrg(w.orgId, (tx) => repo.lockMonthRuns(tx, w.orgId, month, stores)) as Promise<string[]>;
    const asc = (ids: string[]) => [...ids].sort();

    expect(await locked('2026-10-01', [w.lipa])).toEqual(asc([w.runs.L1, w.runs.L2])); // not the voided L5v, not another store
    expect(await locked('2026-10-01', [w.malvar])).toEqual(asc([w.runs.M1, w.runs.M2])); // M1 is 26 Sep - 10 Oct: October by period_end
    expect(await locked('2026-10-01', [w.lipa, w.malvar])).toEqual(asc([w.runs.L1, w.runs.L2, w.runs.M1, w.runs.M2]));
    expect(await locked('2026-11-01', [w.lipa])).toEqual(asc([w.runs.L3, w.runs.L7]));
    expect(await locked('2026-12-01', [w.lipa])).toEqual([]); // the only December run is a draft
    expect(await locked('2026-09-01', [w.malvar])).toEqual([]); // M1 started in September but ended in October
    // another org's runs, even handed our store ids by mistake, are never returned or locked
    const mine = await asOwner((tx) => repo.lockMonthRuns(tx, w.orgId, '2026-10-01', [w.lipa, other.lipa]));
    expect(mine).toEqual(asc([w.runs.L1, w.runs.L2]));
  });

  it('holds the lock: a payment racing a run void WAITS, and a run voided while it waited DROPS OUT of the result (kills: no FOR UPDATE; ids selected first and locked afterwards)', async () => {
    const { f, x, y } = await twoRuns('lock-month-race');
    const held = deferred();
    const release = deferred();
    const voider = asOrg(f.orgId, async (tx) => {
      await payrollRepo.lockPayRun(tx, f.orgId, x);
      held.resolve();
      await release.promise;
      expect(await payrollRepo.markPayRunVoided(tx, f.orgId, x, { voidedBy: f.adminId, reason: 'race test' })).toBe(true);
    });
    await Promise.race([held.promise, voider]);
    let payer: Promise<string[]> | undefined;
    try {
      payer = asOrg(f.orgId, (tx) => repo.lockMonthRuns(tx, f.orgId, '2026-10-01', [f.lipa])) as Promise<string[]>;
      expect(await stillPending(payer)).toBe(true);
    } finally {
      release.resolve();
    }
    await voider;
    expect(await payer).toEqual([y]);
  });
});
