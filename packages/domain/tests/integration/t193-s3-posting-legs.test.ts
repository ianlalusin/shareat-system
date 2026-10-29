import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-193 S3 (TESTER) - `recordStatutoryPayment`: the legs it posts, to the centavo, and the refusals that write nothing.
 * docs/tasks/193-statutory-remittance/REFRESH.md s4 (legs), s5 S3 (cases 2, 3, 4, 5, 7, 13, 15, 19; K2; P1; P2) + the original
 * spec's "Cases". The three shapes are also worked examples: docs/POSTING-PATTERNS.md `statutory_payment.*`.
 *
 * RED TODAY: `recordStatutoryPayment` is not exported from @shareat/domain (packages/domain/src/payroll/statutory-payments.ts does
 * not exist), so every leg fails with "is not a function" - the right reason.
 *
 * NAMES THE TESTER FIXED (the builder implements these exact spellings; the figures are the spec's):
 *  - `import { recordStatutoryPayment } from '@shareat/domain'`, signature `(tx, actor, input) => Promise<{ id, entryId, created }>`
 *    (`id` = the payment id = `input.paymentId`; `created` false on a replay).
 *  - input: { paymentId, agency: 'sss'|'philhealth'|'pagibig'|'bir', month: 'YYYY-MM-01', paidOn: 'YYYY-MM-DD', moneyAccountId,
 *    referenceNo, lines: { storeId, amount }[], penalty?: string (default '0.00'), notes?: string | null, periodOverride? }.
 *  - source type 'statutory_payment', source id = the payment id, idempotency key `statutory_payment:${paymentId}:post`,
 *    entry date = paidOn, one entry per payment; an audit_log row whose entity_id is the payment id.
 *  - every refusal is a `RefusalError` (name 'RefusalError') carrying the sentence on `userMessage`; every refusal writes NOTHING
 *    (no payment, no line, no entry).
 *
 * Legs are written as `code|store|debit|credit|party` strings and compared as sorted sets (the answer must not depend on how the
 * builder orders lines). The store column is the store NAME; a store party is the other store's CODE (never its uuid).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb, moneyAccountsRepo } from '@shareat/db';
import { recordStatutoryPayment } from '@shareat/domain';
import {
  asOrg, balance, C, count, D, entryCount, legsOf, mkWorld, paidLines, payrollCostDebits, refusal, uid,
  type PayInput, type PayResult, type World,
} from './_fixtures/t193-s3-world';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const sql = postgres(url, { max: 6 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const FLOAT_SENTENCE = /staff cash float, which belongs to one person through a cash request\. Payroll cannot be paid from it\. Choose an office or e-wallet account\./;

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

async function nothingWritten(w: World): Promise<void> {
  expect(await count(sql, w, 'statutory_payments'), 'payment rows').toBe(0);
  expect(await count(sql, w, 'statutory_payment_lines'), 'line rows').toBe(0);
  expect(await entryCount(sql, w), 'statutory_payment entries').toBe(0);
}

describe('world sanity (green today: the figures every leg below assumes)', () => {
  it('owed per store is what payroll credited to 2210-2240, and the money accounts hold what the legs assume', async () => {
    const w = await mkWorld(sql, 'sanity');
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-3180.00');
    expect(await balance(sql, w, '2210', w.malvar)).toBe('-3180.00');
    expect(await balance(sql, w, '2210', w.rosario)).toBe('-1000.00');
    expect(await balance(sql, w, '2220', w.lipa)).toBe('-1040.00');
    expect(await balance(sql, w, '2230', w.lipa)).toBe('-400.00');
    expect(await balance(sql, w, '2240', w.lipa)).toBe('-125.50');
    const [owed] = await sql<{ sss: string; ph: string; pi: string; bir: string }[]>`
      select sum(ps.sss_ee + ps.sss_er + ps.sss_ec)::text as sss, sum(ps.philhealth_ee + ps.philhealth_er)::text as ph,
             sum(ps.pagibig_ee + ps.pagibig_er)::text as pi, sum(ps.withholding)::text as bir
      from payslips ps join pay_runs pr on pr.id = ps.run_id where pr.org_id = ${w.orgId} and pr.store_id = ${w.lipa} and pr.status = 'posted'`;
    expect(owed).toEqual({ sss: '3180.00', ph: '1040.00', pi: '400.00', bir: '125.50' });
    const bal = (id: string, gl: string, storeId: string) =>
      asOrg(w.orgId, (tx) => moneyAccountsRepo.balanceOf(tx, w.orgId, { id, glAccountCode: gl, storeId }));
    expect(await bal(w.lipaOffice, '1130', w.lipa)).toBe('100000.00');
    expect(await bal(w.lipaEwallet, '1140', w.lipa)).toBe('100000.00');
    expect(await bal(w.malvarOffice, '1130', w.malvar)).toBe('100000.00');
    expect(await bal(w.rosarioOffice, '1130', w.rosario)).toBe('0');
    expect(await count(sql, w, 'statutory_payments')).toBe(0);
    const [e] = await sql<{ n: string }[]>`select count(*)::text as n from statutory_employers where org_id = ${w.orgId}`;
    expect(e!.n).toBe('3');
  });
});

describe('case 2 - pay in full, same store (the worked example statutory_payment.same-store)', () => {
  it('Lipa office safe pays Lipa SSS October 3,180.00: Dr 2210 Lipa / Cr 1130 Lipa, nothing else (kills: 6110 debited - the section 16.7 double count)', async () => {
    const w = await mkWorld(sql, 'same');
    const inp = input(w, { referenceNo: 'PRN-0001' });
    const r = await pay(w, inp);
    expect(r.created).toBe(true);
    expect(r.id).toBe(inp.paymentId);
    expect(await legsOf(sql, r.entryId)).toEqual([C('1130', 'Lipa', '3180.00'), D('2210', 'Lipa', '3180.00')].sort());
    expect(await payrollCostDebits(sql, r.entryId)).toBe('0.00');
    // the ledger side: payroll credited 2210 at Lipa 3,180.00, the payment cleared it
    expect(await balance(sql, w, '2210', w.lipa)).toBe('0.00');
    expect(await balance(sql, w, '1130', w.lipa)).toBe('96820.00');
  });

  it('the stored rows: one posted payment, one line, the entry linked, source type statutory_payment, source id = the payment id, key and date as fixed (kills: server-minted id; wrong source type)', async () => {
    const w = await mkWorld(sql, 'rows');
    const inp = input(w, { referenceNo: 'PRN-0001', notes: 'paid at the branch' });
    const r = await pay(w, inp);
    const [p] = await sql<{ id: string; agency: string; month: string; paid_on: string; money_account_id: string; reference_no: string; penalty: string; notes: string | null; status: string; journal_entry_id: string; created_by: string }[]>`
      select id, agency, month::text, paid_on::text, money_account_id, reference_no, penalty::text, notes, status, journal_entry_id, created_by
      from statutory_payments where org_id = ${w.orgId}`;
    expect(p).toMatchObject({
      id: inp.paymentId, agency: 'sss', month: '2026-10-01', paid_on: '2026-11-10', money_account_id: w.lipaOffice,
      reference_no: 'PRN-0001', penalty: '0.00', notes: 'paid at the branch', status: 'posted', journal_entry_id: r.entryId, created_by: w.adminId,
    });
    const lines = await sql<{ store_id: string; amount: string }[]>`select store_id, amount::text from statutory_payment_lines where org_id = ${w.orgId}`;
    expect(lines).toEqual([{ store_id: w.lipa, amount: '3180.00' }]);
    const [e] = await sql<{ source_type: string; source_id: string; idempotency_key: string; entry_date: string; status: string }[]>`
      select source_type, source_id, idempotency_key, entry_date::text, status from journal_entries where id = ${r.entryId}`;
    expect(e).toEqual({
      source_type: 'statutory_payment', source_id: inp.paymentId, idempotency_key: `statutory_payment:${inp.paymentId}:post`,
      entry_date: '2026-11-10', status: 'posted',
    });
    const [a] = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${w.orgId} and entity_id = ${inp.paymentId}`;
    expect(Number(a!.n), 'an audit row for the payment').toBeGreaterThanOrEqual(1);
  });

  it("the audit row's action is the dedicated 'statutory_payment.record', not a reused one (T-193 S3; kills: payroll_rate.change reused)", async () => {
    const w = await mkWorld(sql, 'audit');
    const inp = input(w);
    await pay(w, inp);
    const rows = await sql<{ action: string }[]>`select action from audit_log where org_id = ${w.orgId} and entity_id = ${inp.paymentId}`;
    expect(rows.map((r) => r.action)).toEqual(['statutory_payment.record']);
  });

  it('a super_admin may record too (the capability is admin and up)', async () => {
    const w = await mkWorld(sql, 'super');
    const r = await pay(w, input(w), w.superAdmin);
    expect(r.created).toBe(true);
  });
});

describe('case 3 - cross-store (the worked example statutory_payment.cross-store)', () => {
  it("Lipa's office safe pays MALVAR's SSS 3,180.00: Dr 2210 Malvar / Cr 2150 Malvar (party Lipa's code) / Dr 1250 Lipa (party Malvar's code) / Cr 1130 Lipa (kills: 2210 debited at the paying store - DEF-551; party = uuid)", async () => {
    const w = await mkWorld(sql, 'cross');
    const r = await pay(w, input(w, { lines: [{ storeId: w.malvar, amount: '3180.00' }] }));
    expect(await legsOf(sql, r.entryId)).toEqual(
      [
        D('2210', 'Malvar', '3180.00'),
        C('2150', 'Malvar', '3180.00', `store:${w.codes.lipa}`),
        D('1250', 'Lipa', '3180.00', `store:${w.codes.malvar}`),
        C('1130', 'Lipa', '3180.00'),
      ].sort(),
    );
    // each store's books: Malvar's payable is cleared, Lipa's own payable is untouched, Lipa's safe fell
    expect(await balance(sql, w, '2210', w.malvar)).toBe('0.00');
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-3180.00'); // payroll credit 3,180.00 still there (credit is negative net debit)
    expect(await balance(sql, w, '1130', w.lipa)).toBe('96820.00');
    expect(await balance(sql, w, '1130', w.malvar)).toBe('100000.00');
  });

  it("the other direction: MALVAR's safe pays LIPA's SSS - the pair runs the same way round (kills: the pair hard-wired to Lipa as payer)", async () => {
    const w = await mkWorld(sql, 'cross2');
    const r = await pay(w, input(w, { moneyAccountId: w.malvarOffice, lines: [{ storeId: w.lipa, amount: '3180.00' }] }));
    expect(await legsOf(sql, r.entryId)).toEqual(
      [
        D('2210', 'Lipa', '3180.00'),
        C('2150', 'Lipa', '3180.00', `store:${w.codes.malvar}`),
        D('1250', 'Malvar', '3180.00', `store:${w.codes.lipa}`),
        C('1130', 'Malvar', '3180.00'),
      ].sort(),
    );
  });
});

describe('case 4 - one payment, two stores', () => {
  it('Lipa safe pays Lipa 3,180.00 and Malvar 3,180.00 together (6,360.00): one payment, two lines, ONE entry, one reference no. (kills: only the first line posted)', async () => {
    const w = await mkWorld(sql, 'two');
    const r = await pay(w, input(w, { referenceNo: 'PRN-0004', lines: [{ storeId: w.lipa, amount: '3180.00' }, { storeId: w.malvar, amount: '3180.00' }] }));
    expect(await legsOf(sql, r.entryId)).toEqual(
      [
        D('2210', 'Lipa', '3180.00'),
        D('2210', 'Malvar', '3180.00'),
        C('2150', 'Malvar', '3180.00', `store:${w.codes.lipa}`),
        D('1250', 'Lipa', '3180.00', `store:${w.codes.malvar}`),
        C('1130', 'Lipa', '6360.00'),
      ].sort(),
    );
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await count(sql, w, 'statutory_payment_lines')).toBe(2);
    expect(await entryCount(sql, w)).toBe(1);
    expect(await paidLines(sql, w, 'sss', w.lipa)).toBe('3180.00');
    expect(await paidLines(sql, w, 'sss', w.malvar)).toBe('3180.00');
    expect(await balance(sql, w, '2210', w.lipa)).toBe('0.00');
    expect(await balance(sql, w, '2210', w.malvar)).toBe('0.00');
  });
});

describe('K2 - three stores in one payment, paid from Lipa', () => {
  it('Lipa 3,180.00 + Malvar 3,180.00 + Rosario 1,000.00: Malvar and Rosario each get their OWN 1250/2150 pair with Lipa (kills: owingStoreId = a line store, which pairs Rosario with Malvar)', async () => {
    const w = await mkWorld(sql, 'three');
    const r = await pay(
      w,
      input(w, { lines: [{ storeId: w.lipa, amount: '3180.00' }, { storeId: w.malvar, amount: '3180.00' }, { storeId: w.rosario, amount: '1000.00' }] }),
    );
    expect(await legsOf(sql, r.entryId)).toEqual(
      [
        D('2210', 'Lipa', '3180.00'),
        D('2210', 'Malvar', '3180.00'),
        D('2210', 'Rosario', '1000.00'),
        C('2150', 'Malvar', '3180.00', `store:${w.codes.lipa}`),
        D('1250', 'Lipa', '3180.00', `store:${w.codes.malvar}`),
        C('2150', 'Rosario', '1000.00', `store:${w.codes.lipa}`),
        D('1250', 'Lipa', '1000.00', `store:${w.codes.rosario}`),
        C('1130', 'Lipa', '7360.00'),
      ].sort(),
    );
    for (const s of [w.lipa, w.malvar, w.rosario]) expect(await balance(sql, w, '2210', s), 'every store payable cleared').toBe('0.00');
  });
});

describe('case 7 - late, with the agency penalty (the worked example statutory_payment.with-penalty)', () => {
  it('paid 15 Dec with penalty 63.60: Dr 2210 3,180.00 / Dr 6810 63.60 / Cr 1130 3,243.60 (kills: penalty into 2210 - outstanding -63.60; penalty into 6110)', async () => {
    const w = await mkWorld(sql, 'pen');
    const r = await pay(w, input(w, { paidOn: '2026-12-15', penalty: '63.60' }));
    expect(await legsOf(sql, r.entryId)).toEqual([D('2210', 'Lipa', '3180.00'), D('6810', 'Lipa', '63.60'), C('1130', 'Lipa', '3243.60')].sort());
    expect(await payrollCostDebits(sql, r.entryId)).toBe('0.00');
    expect(await balance(sql, w, '2210', w.lipa)).toBe('0.00'); // not -63.60
    expect(await balance(sql, w, '6810', w.lipa)).toBe('63.60');
    const [p] = await sql<{ penalty: string }[]>`select penalty::text from statutory_payments where org_id = ${w.orgId}`;
    expect(p!.penalty).toBe('63.60');
    expect(await paidLines(sql, w, 'sss', w.lipa), 'the penalty is not part of what was paid against the month').toBe('3180.00');
  });

  it("cross-store WITH a penalty: 6810 sits at the PAYING store and only the 3,180.00 gets a pair - never the penalty (kills: penalty booked at the line store, pairing it)", async () => {
    const w = await mkWorld(sql, 'penx');
    const r = await pay(w, input(w, { paidOn: '2026-12-15', penalty: '63.60', lines: [{ storeId: w.malvar, amount: '3180.00' }] }));
    expect(await legsOf(sql, r.entryId)).toEqual(
      [
        D('2210', 'Malvar', '3180.00'),
        C('2150', 'Malvar', '3180.00', `store:${w.codes.lipa}`),
        D('1250', 'Lipa', '3180.00', `store:${w.codes.malvar}`),
        D('6810', 'Lipa', '63.60'),
        C('1130', 'Lipa', '3243.60'),
      ].sort(),
    );
  });

  it('penalty 0.00 and an absent penalty both post no 6810 leg (kills: a zero leg posted)', async () => {
    const w = await mkWorld(sql, 'pen0');
    const a = await pay(w, input(w, { penalty: '0.00', lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    const b = await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }] }));
    for (const r of [a, b]) expect((await legsOf(sql, r.entryId)).some((l) => l.startsWith('6810|'))).toBe(false);
  });

  it('the penalty alone changes nothing about the ceiling: 3,180.00 owed, 3,180.00 + 63.60 penalty is NOT overpaying', async () => {
    const w = await mkWorld(sql, 'pen2');
    await expect(pay(w, input(w, { penalty: '63.60' }))).resolves.toMatchObject({ created: true });
  });
});

describe('P1 - paid from an e-wallet (1140)', () => {
  it('the credit carries party money_account = the account id (kills: party dropped - the journal trigger refuses with P0001)', async () => {
    const w = await mkWorld(sql, 'ewallet');
    const r = await pay(w, input(w, { moneyAccountId: w.lipaEwallet }));
    expect(await legsOf(sql, r.entryId)).toEqual([D('2210', 'Lipa', '3180.00'), C('1140', 'Lipa', '3180.00', `money_account:${w.lipaEwallet}`)].sort());
  });
});

describe('P2 - the staff float (1120) is refused by name', () => {
  it('refused with the T-486 sentence BEFORE anything is written (kills: assertPayrollMoneyAccount not called)', async () => {
    const w = await mkWorld(sql, 'float');
    const e = await refusal(pay(w, input(w, { moneyAccountId: w.lipaFloat })), 'a payment from the staff float');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(FLOAT_SENTENCE);
    await nothingWritten(w);
  });
});

describe('BIR and the employer-number check (case 13)', () => {
  it('BIR pays 125.50 of withholding from 2240 (the organization TIN is on file): Dr 2240 Lipa / Cr 1130 Lipa', async () => {
    const w = await mkWorld(sql, 'bir');
    const r = await pay(w, input(w, { agency: 'bir', lines: [{ storeId: w.lipa, amount: '125.50' }] }));
    expect(await legsOf(sql, r.entryId)).toEqual([D('2240', 'Lipa', '125.50'), C('1130', 'Lipa', '125.50')].sort());
    expect(await payrollCostDebits(sql, r.entryId)).toBe('0.00');
  });

  it('PhilHealth and Pag-IBIG land on 2220 and 2230 (kills: one account for every agency)', async () => {
    const w = await mkWorld(sql, 'ph');
    const ph = await pay(w, input(w, { agency: 'philhealth', lines: [{ storeId: w.lipa, amount: '1040.00' }] }));
    const pi = await pay(w, input(w, { agency: 'pagibig', lines: [{ storeId: w.lipa, amount: '400.00' }] }));
    expect(await legsOf(sql, ph.entryId)).toEqual([D('2220', 'Lipa', '1040.00'), C('1130', 'Lipa', '1040.00')].sort());
    expect(await legsOf(sql, pi.entryId)).toEqual([D('2230', 'Lipa', '400.00'), C('1130', 'Lipa', '400.00')].sort());
  });

  it('no SSS employer number on file: refused naming SSS, nothing written (kills: check skipped)', async () => {
    const w = await mkWorld(sql, 'nosss');
    await sql`delete from statutory_employers where org_id = ${w.orgId} and agency = 'sss'`;
    const e = await refusal(pay(w, input(w)), 'an SSS payment with no employer number');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/SSS/);
    await nothingWritten(w);
  });

  it('no organization TIN: a BIR payment is refused naming the TIN, nothing written (kills: check skipped for BIR)', async () => {
    const w = await mkWorld(sql, 'notin');
    await sql`update organizations set tin = null where id = ${w.orgId}`;
    const e = await refusal(pay(w, input(w, { agency: 'bir', lines: [{ storeId: w.lipa, amount: '125.50' }] })), 'a BIR payment with no TIN');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/TIN|tax identification/i);
    await nothingWritten(w);
  });

  it('a BIR payment needs no employer-number row (the TIN is the number), and an SSS number does not cover PhilHealth', async () => {
    const w = await mkWorld(sql, 'nph');
    await sql`delete from statutory_employers where org_id = ${w.orgId} and agency = 'philhealth'`;
    const e = await refusal(pay(w, input(w, { agency: 'philhealth', lines: [{ storeId: w.lipa, amount: '1040.00' }] })), 'a PhilHealth payment with no number');
    expect(e.userMessage).toMatch(/PhilHealth/i);
    await expect(pay(w, input(w, { agency: 'bir', lines: [{ storeId: w.lipa, amount: '125.50' }] }))).resolves.toMatchObject({ created: true });
  });
});

describe('case 5 - partial, then the rest, then overpaying', () => {
  it('2,000.00 then 1,181.00 refused (outstanding 1,180.00, naming Lipa and the figure) then 1,180.00 pays it off, then 0.01 refused (kills: ceiling dropped - outstanding -0.01)', async () => {
    const w = await mkWorld(sql, 'partial');
    const first = await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '2000.00' }] }));
    expect(await legsOf(sql, first.entryId)).toEqual([D('2210', 'Lipa', '2000.00'), C('1130', 'Lipa', '2000.00')].sort());
    expect(await balance(sql, w, '2210', w.lipa)).toBe('-1180.00');

    const over = await refusal(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1181.00' }] })), 'overpaying by 1.00');
    expect(over.name).toBe('RefusalError');
    expect(over.userMessage).toMatch(/Lipa/);
    expect(over.userMessage).toMatch(/1,?180\.00/);
    expect(await count(sql, w, 'statutory_payments')).toBe(1);
    expect(await entryCount(sql, w)).toBe(1);

    await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1180.00' }] }));
    expect(await paidLines(sql, w, 'sss', w.lipa)).toBe('3180.00');
    expect(await balance(sql, w, '2210', w.lipa)).toBe('0.00');

    const penny = await refusal(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '0.01' }] })), 'a payment of 0.01 on a paid month');
    expect(penny.name).toBe('RefusalError');
    expect(penny.userMessage).toMatch(/Lipa/);
    expect(await count(sql, w, 'statutory_payments')).toBe(2);
    expect(await entryCount(sql, w)).toBe(2);
  });

  it("a voided payment's lines no longer count as paid: the month can be paid again in full (kills: voided lines counted)", async () => {
    const w = await mkWorld(sql, 'voidedpaid');
    const first = await pay(w, input(w));
    await sql`update statutory_payments set status = 'voided', void_reason = 'test', voided_by = ${w.adminId}, voided_at = now() where id = ${first.id}`;
    await expect(pay(w, input(w))).resolves.toMatchObject({ created: true });
  });

  it('a store with nothing owed is refused naming it (Rosario owes no PhilHealth) and the month is not blocked for the stores that do (kills: ceiling only checked per payment, not per store)', async () => {
    const w = await mkWorld(sql, 'zero');
    const e = await refusal(pay(w, input(w, { agency: 'philhealth', lines: [{ storeId: w.lipa, amount: '1040.00' }, { storeId: w.rosario, amount: '10.00' }] })), 'a store with nothing owed');
    expect(e.name).toBe('RefusalError');
    expect(e.userMessage).toMatch(/Rosario/);
    await nothingWritten(w);
  });

  it("one over-the-ceiling line refuses the WHOLE payment, even when another line is fine (nothing partly posted)", async () => {
    const w = await mkWorld(sql, 'oneover');
    const e = await refusal(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '3180.00' }, { storeId: w.rosario, amount: '1000.01' }] })), 'Rosario overpaid by 0.01');
    expect(e.userMessage).toMatch(/Rosario/);
    await nothingWritten(w);
  });
});

describe('case 19 - money input', () => {
  it.each([
    ['3180.001', 'three decimals'],
    ['-1', 'negative'],
    ['0', 'zero'],
    ['0.00', 'zero with cents'],
    ['NaN', 'not a number'],
    ['1e3', 'exponent'],
    ['', 'empty'],
  ])('a line of %j is refused (%s) and nothing is written', async (amount) => {
    const w = await mkWorld(sql, 'mi');
    const e = await refusal(pay(w, input(w, { lines: [{ storeId: w.lipa, amount }] })), `a line of ${amount}`);
    expect(e.name).toBe('RefusalError');
    await nothingWritten(w);
  });

  it('a penalty of -0.01 is refused and nothing is written', async () => {
    const w = await mkWorld(sql, 'mipen');
    const e = await refusal(pay(w, input(w, { penalty: '-0.01' })), 'a negative penalty');
    expect(e.name).toBe('RefusalError');
    await nothingWritten(w);
  });

  it('a penalty of 63.601 is refused too (three decimals)', async () => {
    const w = await mkWorld(sql, 'mipen3');
    await refusal(pay(w, input(w, { penalty: '63.601' })), 'a penalty with three decimals');
    await nothingWritten(w);
  });

  it('lines 1,000.10 then 2,179.90 pay 3,180.00 EXACTLY - paid, outstanding 0.00, the second is not read as 3,180.0000000000005 (kills: Number() sums)', async () => {
    const w = await mkWorld(sql, 'mifloat');
    await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.10' }] }));
    await pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '2179.90' }] }));
    expect(await paidLines(sql, w, 'sss', w.lipa)).toBe('3180.00');
    expect(await balance(sql, w, '2210', w.lipa)).toBe('0.00');
    expect(await balance(sql, w, '1130', w.lipa)).toBe('96820.00');
  });

  it('two lines for the same store in one payment are refused in words, not left to the unique index (kills: raw 23505 or a doubled line)', async () => {
    const w = await mkWorld(sql, 'dupline');
    const e = await refusal(pay(w, input(w, { lines: [{ storeId: w.lipa, amount: '1000.00' }, { storeId: w.lipa, amount: '1000.00' }] })), 'the same store twice');
    expect(e.name).toBe('RefusalError');
    await nothingWritten(w);
  });

  it('a payment with no lines is refused and nothing is written', async () => {
    const w = await mkWorld(sql, 'nolines');
    const e = await refusal(pay(w, input(w, { lines: [] })), 'a payment with no lines');
    expect(e.name).toBe('RefusalError');
    await nothingWritten(w);
  });
});

describe('case 15 - the month and the date', () => {
  it('a month that is not the 1st is refused in words (kills: left to the CHECK)', async () => {
    const w = await mkWorld(sql, 'm15');
    const e = await refusal(pay(w, input(w, { month: '2026-10-15' })), 'month 15 October');
    expect(e.name).toBe('RefusalError');
    await nothingWritten(w);
  });

  it('a month after the current one is refused in words (kills: future month accepted)', async () => {
    const w = await mkWorld(sql, 'future');
    const e = await refusal(pay(w, input(w, { month: '2099-01-01', paidOn: '2099-02-10' })), 'a month in 2099');
    expect(e.name).toBe('RefusalError');
    await nothingWritten(w);
  });

  it('paid_on before the month is refused and nothing is written', async () => {
    const w = await mkWorld(sql, 'early');
    await refusal(pay(w, input(w, { paidOn: '2026-09-30' })), 'paid before the month began');
    await nothingWritten(w);
  });

  it('a malformed month or date is refused and nothing is written', async () => {
    const w = await mkWorld(sql, 'badfmt');
    await refusal(pay(w, input(w, { month: '10/2026' })), 'a malformed month');
    await refusal(pay(w, input(w, { paidOn: 'tomorrow' })), 'a malformed date');
    await nothingWritten(w);
  });

  it('an agency that is not one of the four is refused and nothing is written', async () => {
    const w = await mkWorld(sql, 'agency');
    await refusal(pay(w, input(w, { agency: 'bpi' as never })), 'an unknown agency');
    await nothingWritten(w);
  });

  it('a blank or padded reference no. is refused and nothing is written (the agency receipt is required)', async () => {
    const w = await mkWorld(sql, 'ref');
    await refusal(pay(w, input(w, { referenceNo: '   ' })), 'a blank reference');
    await refusal(pay(w, input(w, { referenceNo: '' })), 'an empty reference');
    await nothingWritten(w);
  });

  it('the reference no. is stored trimmed (a padded entry is cleaned, or refused - never stored padded)', async () => {
    const w = await mkWorld(sql, 'reftrim');
    await pay(w, input(w, { referenceNo: '  PRN-7  ' })).catch(() => undefined);
    const rows = await sql<{ reference_no: string }[]>`select reference_no from statutory_payments where org_id = ${w.orgId}`;
    for (const r of rows) expect(r.reference_no).toBe('PRN-7');
  });
});

describe('the money account', () => {
  it("an account that cannot cover the payment is refused and nothing is written - Rosario's safe holds nothing (kills: checkDraw skipped)", async () => {
    const w = await mkWorld(sql, 'draw');
    const e = await refusal(pay(w, input(w, { moneyAccountId: w.rosarioOffice, lines: [{ storeId: w.rosario, amount: '1000.00' }] })), 'a payment from an empty safe');
    expect(e.message).toMatch(/recordStatutoryPayment/);
    await nothingWritten(w);
  });

  it('the penalty counts toward the draw: a safe holding exactly the contributions cannot also pay the penalty', async () => {
    const w = await mkWorld(sql, 'drawpen');
    // leave the Malvar safe with exactly 3,180.00
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${w.orgId} and starts_on = '2026-09-01'`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${w.orgId}, '2026-09-02', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id`;
      const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${w.orgId} and code in ('1130', '3900')`;
      const by = new Map(codes.map((c) => [c.code, c.id]));
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values
        (${e!.id}, 1, ${by.get('3900')!}, ${w.malvar}, '96820.00', '0'), (${e!.id}, 2, ${by.get('1130')!}, ${w.malvar}, '0', '96820.00')`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    expect(await balance(sql, w, '1130', w.malvar)).toBe('3180.00');
    const e = await refusal(pay(w, input(w, { moneyAccountId: w.malvarOffice, penalty: '0.01', lines: [{ storeId: w.malvar, amount: '3180.00' }] })), 'a draw of contributions + penalty');
    expect(e.message).toMatch(/recordStatutoryPayment/);
    await nothingWritten(w);
    await expect(pay(w, input(w, { moneyAccountId: w.malvarOffice, lines: [{ storeId: w.malvar, amount: '3180.00' }] }))).resolves.toMatchObject({ created: true });
  });

  it('a money account that does not exist is refused and nothing is written', async () => {
    const w = await mkWorld(sql, 'noacct');
    await refusal(pay(w, input(w, { moneyAccountId: crypto.randomUUID() })), 'an unknown money account');
    await nothingWritten(w);
  });
});
