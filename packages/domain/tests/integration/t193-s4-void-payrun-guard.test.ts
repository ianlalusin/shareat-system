import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-193 S4 (TESTER) - the `voidPayRun` guard: a pay run cannot be voided while a POSTED statutory payment stands for that run's
 * store and month and an agency the run accrued. REFRESH.md s4.2 (`lockPayRun` right after `getPayRun`, re-read status, then the guard,
 * refused with `refuse(raw, sentence)` naming the payment's reference no.), s5 S4 cases 9 and 10 (second half), s6 ("add `lockPayRun` + the
 * guard only"), old spec Question 4 (void the payment first, void the run, re-run, pay again).
 *
 * NAMES FIXED BY THIS FILE (the builder implements them):
 *   - the refusal is a RefusalError (`name`), the sentence on `userMessage` NAMES the blocking payment's reference no. and says
 *     "void that payment first" (case-insensitive); a VOIDED payment never blocks.
 *   - `payrollRepo.lockPayRun(tx, orgId, runId)` (FOR UPDATE on the run row), called right after `getPayRun`, status re-read after the lock.
 *   - the missing repo read (S2 tester's gap): `statutoryPaymentsRepo.postedForRun(tx, orgId, runId)`-style - "posted payments for this run's
 *     store and month, restricted to the agencies the run's payslips carry a non-zero amount for" -> rows with at least `referenceNo`.
 *     The tests below do not call it directly (they go through voidPayRun); they define what it must answer.
 *
 * RED TODAY: voidPayRun has no guard, so the refusal legs fail with "NOT REFUSED"; the gated races fail on the missing wait.
 * MUTANTS: guard missing (2210 Lipa -1,595); guard on the wrong store; guard ignoring the month; guard ignoring the agency the run accrued;
 * a voided payment still blocking; guard reads payments BEFORE locking the run (the gated legs); no run lock (the gated legs).
 *
 * Fixture note: the S3 world's pay runs are written raw and their payslips carry no journal link, so a void of one reverses 0 entries
 * here; what these legs judge is the run's status and the refusal, not the payslip reversals (payroll.test.ts covers those).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, type Tx } from '@shareat/db';
import { recordStatutoryPayment, voidPayRun, voidStatutoryPayment } from '@shareat/domain';
import { mkPerson, mkRun } from '../../../db/tests/integration/_fixtures/t193-s2-world';
import {
  asOrg, balance, count, mkWorld, refusal, uid,
  type PayInput, type PayResult, type World,
} from './_fixtures/t193-s3-world';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const sql = postgres(url, { max: 10 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

function input(w: World, over: Partial<PayInput> = {}): PayInput {
  return {
    paymentId: crypto.randomUUID(),
    agency: 'sss',
    month: '2026-10-01',
    paidOn: '2026-11-10',
    moneyAccountId: w.lipaOffice,
    referenceNo: uid('PRN'),
    lines: [{ storeId: w.lipa, amount: '3180.00' }],
    ...over,
  };
}
const pay = (w: World, inp: PayInput, who = w.admin): Promise<PayResult> =>
  asOrg(w.orgId, (tx) => (recordStatutoryPayment as (tx: unknown, a: unknown, i: unknown) => Promise<PayResult>)(tx, who, inp));
const voidPayment = (w: World, paymentId: string): Promise<unknown> =>
  asOrg(w.orgId, (tx) =>
    (voidStatutoryPayment as unknown as (tx: Tx, a: unknown, i: unknown) => Promise<unknown>)(tx, w.admin, { paymentId, reason: 'Wrong receipt' }));
const voidRunOp = (w: World, runId: string, reason = 'Wrong period') => (tx: Tx) => voidPayRun(tx, w.admin, { runId, reason });
const voidRun = (w: World, runId: string) => asOrg(w.orgId, voidRunOp(w, runId));

/** The run of a store whose period ends on `end`. Lipa has 15 Oct + 31 Oct, Malvar 10 Oct + 25 Oct, Rosario 31 Oct (all posted). */
async function runOf(w: World, storeId: string, end: string): Promise<string> {
  const [r] = await sql<{ id: string }[]>`select id from pay_runs where org_id = ${w.orgId} and store_id = ${storeId} and period_end = ${end}`;
  return r!.id;
}
async function runStatus(runId: string): Promise<string> {
  const [r] = await sql<{ status: string }[]>`select status from pay_runs where id = ${runId}`;
  return r!.status;
}
async function entriesInOrg(w: World): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${w.orgId}`;
  return Number(r!.n);
}
const GUARD = /void that payment first/i;

// -----------------------------------------------------------------------------------------------------------------
describe('case 9 - void a pay run while its month is paid', () => {
  it('Lipa SSS October is paid (PRN-0001): voiding the 31 Oct run is refused in words naming PRN-0001; the run stays posted, nothing is written; once the payment is voided the run void succeeds (kills: guard missing - 2210 Lipa -1,595)', async () => {
    const w = await mkWorld(sql, 'g9');
    const r2 = await runOf(w, w.lipa, '2026-10-31');
    const inp = input(w, { referenceNo: 'PRN-0001' });
    await pay(w, inp);
    const entriesBefore = await entriesInOrg(w);
    const payrollBefore = await balance(sql, w, '2210', w.lipa);

    const e = await refusal(voidRun(w, r2), 'a pay run void while its month stands paid');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toContain('PRN-0001');
    expect(e.userMessage).toMatch(GUARD);
    expect(e.userMessage).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(await runStatus(r2), 'the run is untouched').toBe('posted');
    expect(await entriesInOrg(w), 'no reversal was written').toBe(entriesBefore);
    expect(await balance(sql, w, '2210', w.lipa)).toBe(payrollBefore);

    await voidPayment(w, inp.paymentId);
    await expect(voidRun(w, r2), 'with the payment voided the run may go').resolves.toMatchObject({});
    expect(await runStatus(r2)).toBe('voided');
  });

  it("EVERY run of that store's month that accrued the agency is blocked, not only the latest (kills: guard looks at the newest run only)", async () => {
    const w = await mkWorld(sql, 'g9both');
    await pay(w, input(w, { referenceNo: 'PRN-0002' }));
    for (const end of ['2026-10-15', '2026-10-31']) {
      const id = await runOf(w, w.lipa, end);
      const e = await refusal(voidRun(w, id), `the ${end} run`);
      expect(e.name).toBe('RefusalError');
      expect(e.userMessage).toContain('PRN-0002');
      expect(await runStatus(id)).toBe('posted');
    }
  });

  it('a PARTIAL payment blocks as well as a full one (kills: guard only when the month is fully paid)', async () => {
    const w = await mkWorld(sql, 'g9part');
    await pay(w, input(w, { referenceNo: 'PRN-0003', lines: [{ storeId: w.lipa, amount: '100.00' }] }));
    const e = await refusal(voidRun(w, await runOf(w, w.lipa, '2026-10-31')), 'a run void under a partial payment');
    expect(e.userMessage).toContain('PRN-0003');
  });

  it('with several payments standing, the sentence names a blocking payment by its reference no. (any one of them)', async () => {
    const w = await mkWorld(sql, 'g9many');
    await pay(w, input(w, { referenceNo: 'PRN-A1', lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    await pay(w, input(w, { referenceNo: 'PRN-B2', lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    const e = await refusal(voidRun(w, await runOf(w, w.lipa, '2026-10-31')), 'a run void under two payments');
    expect(e.userMessage).toMatch(/PRN-A1|PRN-B2/);
  });

  it('no payment at all: the run void works exactly as before (positive control; kills: a guard that refuses always)', async () => {
    const w = await mkWorld(sql, 'g9none');
    const id = await runOf(w, w.rosario, '2026-10-31');
    await expect(voidRun(w, id)).resolves.toMatchObject({});
    expect(await runStatus(id)).toBe('voided');
  });
});

describe('the guard is scoped to the run\'s store, month and the agencies the run accrued', () => {
  it("a payment for MALVAR does not block voiding a LIPA run, and does block Malvar's own (kills: guard ignoring the store)", async () => {
    const w = await mkWorld(sql, 'gstore');
    await pay(w, input(w, { moneyAccountId: w.malvarOffice, referenceNo: 'PRN-MV', lines: [{ storeId: w.malvar, amount: '3180.00' }] }));
    const lipaRun = await runOf(w, w.lipa, '2026-10-31');
    await expect(voidRun(w, lipaRun), "Lipa owes nothing to this payment").resolves.toMatchObject({});
    const malvarRun = await runOf(w, w.malvar, '2026-10-25');
    const e = await refusal(voidRun(w, malvarRun), "Malvar's run under Malvar's payment");
    expect(e.userMessage).toContain('PRN-MV');
    expect(await runStatus(malvarRun)).toBe('posted');
  });

  it('a payment of ANOTHER month does not block: a November Lipa run voids while October SSS stands paid (kills: guard ignoring the month)', async () => {
    const w = await mkWorld(sql, 'gmonth');
    const ana = await mkPerson(sql, { orgId: w.orgId, lipa: w.lipa, malvar: w.malvar, adminId: w.adminId, bankId: w.lipaOffice }, 'Ana Nov', w.lipa);
    const nov = await mkRun(sql, { orgId: w.orgId, lipa: w.lipa, malvar: w.malvar, adminId: w.adminId, bankId: w.lipaOffice }, {
      storeId: w.lipa, start: '2026-11-01', end: '2026-11-15', status: 'posted',
      slips: [{ who: ana, sss: ['100.00', '200.00', '10.00'] }],
    });
    await pay(w, input(w, { referenceNo: 'PRN-OCT' }));
    await expect(voidRun(w, nov), 'October is paid, November is not').resolves.toMatchObject({});
    expect(await runStatus(nov)).toBe('voided');
    const e = await refusal(voidRun(w, await runOf(w, w.lipa, '2026-10-31')), 'the October run');
    expect(e.userMessage).toContain('PRN-OCT');
  });

  it("the agency must be one the run accrued: a BIR payment blocks the 31 Oct run (withholding 125.50) but NOT the 15 Oct run (no withholding) (kills: guard ignoring the agency)", async () => {
    const w = await mkWorld(sql, 'gagency');
    await pay(w, input(w, { agency: 'bir', referenceNo: 'BIR-0001', lines: [{ storeId: w.lipa, amount: '125.50' }] }));
    const first = await runOf(w, w.lipa, '2026-10-15');
    const second = await runOf(w, w.lipa, '2026-10-31');
    await expect(voidRun(w, first), 'the 15 Oct run carried no withholding').resolves.toMatchObject({});
    expect(await runStatus(first)).toBe('voided');
    const e = await refusal(voidRun(w, second), 'the 31 Oct run, which withheld tax');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toContain('BIR-0001');
    expect(await runStatus(second)).toBe('posted');
  });

  it("a payment to one agency does not block a run that accrued only OTHER agencies: Rosario's run is SSS-only, a Lipa PhilHealth payment is unrelated (kills: any payment of the month blocks)", async () => {
    const w = await mkWorld(sql, 'gother');
    await pay(w, input(w, { agency: 'philhealth', referenceNo: 'PH-0001', lines: [{ storeId: w.lipa, amount: '1040.00' }] }));
    const rosario = await runOf(w, w.rosario, '2026-10-31');
    await expect(voidRun(w, rosario)).resolves.toMatchObject({});
  });

  it('a VOIDED payment never blocks (kills: a voided payment still counted)', async () => {
    const w = await mkWorld(sql, 'gvoided');
    const inp = input(w, { referenceNo: 'PRN-VOIDED' });
    await pay(w, inp);
    await voidPayment(w, inp.paymentId);
    await expect(voidRun(w, await runOf(w, w.lipa, '2026-10-15'))).resolves.toMatchObject({});
    await expect(voidRun(w, await runOf(w, w.lipa, '2026-10-31'))).resolves.toMatchObject({});
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Case 10, second half: a payment racing a run void. Gated: A holds its transaction open, B must PARK on the run lock, then judge.
// -----------------------------------------------------------------------------------------------------------------
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };
async function gated<TA, TB>(
  orgId: string,
  opA: (tx: Tx) => Promise<TA>,
  opB: (tx: Tx) => Promise<TB>,
): Promise<{ a: Settled<TA>; b: Settled<TB>; bWaited: boolean }> {
  const aReady = deferred<void>();
  const gate = deferred<void>();
  const aP: Promise<Settled<TA>> = asOrg(orgId, async (tx) => {
    try {
      const value = await opA(tx);
      aReady.resolve();
      await gate.promise;
      return value;
    } catch (err) {
      aReady.resolve();
      throw err;
    }
  }).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  await aReady.promise;
  const bPid = deferred<number>();
  const bP: Promise<Settled<TB>> = asOrg(orgId, async (tx) => {
    const rows = await tx.execute(dsql`select pg_backend_pid() as pid`);
    bPid.resolve(Number((rows as unknown as { pid: number }[])[0]?.pid));
    return opB(tx);
  }).then((value) => ({ status: 'fulfilled', value }) as const, (reason) => ({ status: 'rejected', reason }) as const);
  const settled = bP.then(() => true);
  let waited = false;
  const pid = await Promise.race([bPid.promise, settled.then(() => 0)]);
  if (pid) {
    const deadline = Date.now() + 8000;
    while (!waited && Date.now() < deadline) {
      const rows = await sql<{ pid: number }[]>`
        select pid from pg_stat_activity where datname = current_database() and pid = ${pid} and wait_event_type = 'Lock'`;
      if (rows[0]) waited = true;
      else if (await Promise.race([settled, new Promise<boolean>((r) => setTimeout(() => r(false), 20))])) break;
    }
  }
  gate.resolve();
  const [a, b] = await Promise.all([aP, bP]);
  return { a, b, bWaited: waited };
}

describe('case 10 (second half) - a payment racing a run void: one waits, then refuses', () => {
  it('the payment is in flight (uncommitted) when the run void starts: the void PARKS on the run lock, then sees the committed payment and is refused; the run stays posted (kills: voidPayRun reads payments before locking the run; no run lock)', async () => {
    const w = await mkWorld(sql, 'g10a');
    const r2 = await runOf(w, w.lipa, '2026-10-31');
    const inp = input(w, { referenceNo: 'PRN-RACE' });
    const { a, b, bWaited } = await gated(
      w.orgId,
      (tx) => (recordStatutoryPayment as (tx: unknown, a: unknown, i: unknown) => Promise<PayResult>)(tx, w.admin, inp),
      voidRunOp(w, r2),
    );
    expect(a.status, 'the payment posts').toBe('fulfilled');
    expect(bWaited, 'the run void waited for the payment\'s hold on the run').toBe(true);
    expect(b.status, 'the run void is refused').toBe('rejected');
    expect((b as { reason: { name?: string; userMessage?: string } }).reason.name).toBe('RefusalError');
    expect((b as { reason: { userMessage?: string } }).reason.userMessage).toContain('PRN-RACE');
    expect(await runStatus(r2)).toBe('posted');
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
  });

  it('the run void is in flight when the payment starts: the payment PARKS on the run lock, then finds October short and is refused as overpaying; the run is voided and NO payment exists (kills: no run lock - a payment on a voided run)', async () => {
    const w = await mkWorld(sql, 'g10b');
    const r2 = await runOf(w, w.lipa, '2026-10-31');
    const { a, b, bWaited } = await gated(
      w.orgId,
      voidRunOp(w, r2),
      (tx) => (recordStatutoryPayment as (tx: unknown, a: unknown, i: unknown) => Promise<PayResult>)(tx, w.admin, input(w)),
    );
    expect(a.status, 'the run void goes through').toBe('fulfilled');
    expect(bWaited, 'the payment waited for the run void').toBe(true);
    expect(b.status, 'the 3,180.00 payment is now an overpayment (only 1,585.00 is owed)').toBe('rejected');
    expect((b as { reason: { name?: string } }).reason.name).toBe('RefusalError');
    expect(await runStatus(r2)).toBe('voided');
    expect(await count(sql, w, 'statutory_payments')).toBe(0);
  });

  it('unsynchronised, 4 times over: a run void and a full payment fired together - exactly one of them wins, and a voided run NEVER sits under a standing payment', async () => {
    for (let i = 0; i < 4; i++) {
      const w = await mkWorld(sql, `g10c${i}`);
      const r2 = await runOf(w, w.lipa, '2026-10-31');
      const results = await Promise.allSettled([voidRun(w, r2), pay(w, input(w))]);
      expect(results.filter((r) => r.status === 'fulfilled'), 'exactly one wins').toHaveLength(1);
      const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
      expect((bad.reason as { name?: string }).name, 'the loser is a refusal in words, not a deadlock').toBe('RefusalError');
      const posted = await count(sql, w, 'statutory_payments');
      const status = await runStatus(r2);
      expect(status === 'voided' && posted > 0, 'the broken state: a voided run under a payment').toBe(false);
      expect(status === 'posted' || posted === 0).toBe(true);
    }
  });
});
