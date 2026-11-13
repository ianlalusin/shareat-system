import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-511 S6a (TESTER, 7 Nov 2026) - several loan legs per channel settlement, and the acknowledged difference.
 * docs/tasks/511-settlement-upload-s6-spec.md "S6a"; docs/designs/channel-settlement-upload.md Component H items 1-2. Real Postgres, real posting.
 *
 * RED TODAY: `RecordSettlementInput` has one `loan` and no `loanLegs`; there is no legs table; a shortfall past tolerance is refused outright and a gain needs
 * `recognizeGain`; the preview says `needsGainAcknowledgement`. Each test below fails for its own reason (a missing 2400 line, a refusal that still names
 * recognizeGain, a missing column).
 *
 * PINNED (builder meets these or asks BOSS to change the tests):
 *  P1  `recordChannelSettlement` / `previewChannelSettlement` take `loanLegs?: { loanId: string; amount: string; ownerStoreId?: string | null }[]` and no
 *      `loan`. The loan deduction is the SUM of the legs (centavos, exact); there is no separate deduction input, so "legs != deduction" cannot be typed into
 *      the domain: the database trigger (t511-s6a-migration.test.ts) and the staged-line builder (t511-s6a-settlement-input.test.ts) are where it is caught.
 *      A leg with a blank loanId is dropped (as the single loan was); an empty or absent list is a settlement with no loan.
 *  P2  `ownerStoreId` absent, null, or equal to the paying store = a same-store leg: 2400 debit only. Another store = the 1250 / 2400 / 2150 triple.
 *      Lines are posted in this order: the bank deposit, the fees, the variance / gain, then each leg's lines IN THE ORDER GIVEN, then the 1220 credit.
 *  P3  Two legs of the same (loan, owner store) are refused with a plain sentence that names the loan; the preview lists the same sentence as a blocker.
 *  P4  `channelSettlementsRepo.getById(...)` and every row of `listSettlements(...)` carry `loanLegs: { loanId, ownerStoreId, amount }[]` (same-store legs
 *      carry the paying store's id), and no longer carry `loanId` / `loanOwnerStoreId`.
 *  P5  `acknowledgeDifference?: { reason: string }` replaces `recognizeGain`. It is REQUIRED when the difference is past tolerance, either sign. The refusal and
 *      the preview blocker name `acknowledgeDifference`. A blank (after trim) or over-500-character reason is refused with a sentence naming the reason. The
 *      trimmed reason is stored in `channel_settlements.difference_reason`. A shortfall books to 6420, a gain to 7100. `recognizeGain` no longer does anything.
 *  P6  The preview returns `needsAcknowledgement: boolean` (replacing `needsGainAcknowledgement`), `difference: string` (the absolute difference, 2 decimals,
 *      whatever the tolerance) and `differenceSign: 'short' | 'over' | 'none'`. `variance` and `settlementGain` stay as they are.
 *
 * "Over-repay refused as today" (brief) is NOT tested: nothing in the settlement path refuses a leg above the loan's outstanding today (that refusal is
 * `recordLoanPayment`'s). Pinning one here would invent behaviour; it is listed as an ambiguity in the hand-back.
 *
 * MUTANTS are named in each title `[kills: ...]`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, channelSettlementsRepo, loansRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { previewChannelSettlement, recordChannelSettlement, voidChannelSettlement } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`s6a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string; code: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id, code`;
    return { id: s!.id, code: s!.code };
  };
  const paying = await mkStore('malvar');
  const other = await mkStore('lipa');
  const third = await mkStore('sto-tomas');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  for (const s of [paying, other, third]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s.id})`;
  const [bank] = await sql<{ id: string }[]>`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${paying.id}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${orgId}, ${paying.id}, ${`Grab ${uid('c')}`}, false, '1220', ${bank!.id}) returning id`;
  const [day] = await sql<{ id: string }[]>`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${orgId}, ${paying.id}, '2026-01-10', 0, 0, 0, ${p!.id}) returning id`;
  return { orgId, paying, other, third, bankId: bank!.id, channelId: channel!.id, salesDayId: day!.id, manager: actor(orgId, p!.id), personId: p!.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

async function raiseReceivable(f: Fx, amount: string, date = '2026-01-10') {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: date, sourceType: 'sales_day', sourceId: f.salesDayId, idempotencyKey: `sales_day:${f.salesDayId}:${amount}:${date}`,
      memo: 'Channel day', postedBy: f.personId,
      lines: [
        { accountCode: '1220', storeId: f.paying.id, debit: amount, partyType: 'channel', partyId: f.channelId },
        { accountCode: '4150', storeId: f.paying.id, credit: amount },
      ],
    }),
  );
}

/** A loan owned by `store`, disbursed 5,000.00 (so a repayment moves a real position). */
async function loanOf(f: Fx, store: { id: string }, name: string): Promise<string> {
  const [loan] = await sql<{ id: string }[]>`
    insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, created_by)
    values (${f.orgId}, ${store.id}, 'Grab', ${uid(name)}, 5000, 0, 'month', 'straight', 'monthly', 6, '2026-01-01', ${f.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'loan_disbursement', sourceId: loan!.id, idempotencyKey: `loan_disbursement:${loan!.id}`, memo: 'Draw', postedBy: f.personId,
      lines: [
        { accountCode: '1130', storeId: store.id, debit: '5000.00' },
        { accountCode: '2400', storeId: store.id, credit: '5000.00', partyType: 'loan', partyId: loan!.id },
      ],
    }),
  );
  return loan!.id;
}

interface Leg { loanId: string; amount: string; ownerStoreId?: string | null }

/** The args are cast: the input type is the builder's to create, this file only pins its shape. */
const args = (f: Fx, over: Record<string, unknown>) =>
  ({ storeId: f.paying.id, channelId: f.channelId, businessDate: '2026-01-10', grossAmount: '20000.00', netDeposited: '17640.00', ...over }) as never;
const rec = (f: Fx, over: Record<string, unknown>) =>
  asOrg(f.orgId, (tx) => recordChannelSettlement(tx, f.manager, args(f, { salesDayId: f.salesDayId, settledOn: '2026-01-15', ...over })));
const prev = (f: Fx, over: Record<string, unknown>) => asOrg(f.orgId, (tx) => previewChannelSettlement(tx, f.manager, args(f, over)));

interface Line { code: string; debit: string; credit: string; store_id: string; party_type: string | null; party_id: string | null }
async function linesOf(entryId: string): Promise<Line[]> {
  return sql<Line[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.store_id::text, jl.party_type, jl.party_id
      from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by jl.line_no`;
}
const money = (l: Line) => (Number(l.debit) > 0 ? { debit: l.debit } : { credit: l.credit });
const shape = (l: Line) => ({ code: l.code, ...money(l), store: l.store_id, party: l.party_type ? `${l.party_type}:${l.party_id}` : null });
const balanced = (ls: Line[]) => expect(ls.reduce((t, l) => t + Math.round(Number(l.debit) * 100), 0)).toBe(ls.reduce((t, l) => t + Math.round(Number(l.credit) * 100), 0));

const position = (f: Fx, loanId: string) => asOrg(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, loanId));
const outstanding = (f: Fx) => asOrg(f.orgId, (tx) => channelSettlementsRepo.outstandingFor(tx, f.orgId, f.channelId));
const settlementCount = async (f: Fx) => Number((await sql<{ n: string }[]>`select count(*)::text as n from channel_settlements where org_id = ${f.orgId}`)[0]!.n);
const legRowsOf = (settlementId: string) =>
  sql<{ loan_id: string; owner_store_id: string; amount: string }[]>`select loan_id::text, owner_store_id::text, amount::text from channel_settlement_loan_legs where settlement_id = ${settlementId} order by id`;
const reasonOf = async (settlementId: string) => (await sql<{ r: string | null }[]>`select difference_reason as r from channel_settlements where id = ${settlementId}`)[0]!.r;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =====================================================================================================================
// several legs
// =====================================================================================================================

describe('T-511 S6a - two loans docked out of one payout', () => {
  it('two same-store loans: a 2400 debit per loan against its own party, the lines exact and balanced, the loan_deduction the sum, both positions down [kills: only the first leg posts; both legs merged onto one loan; a leg on the wrong store; the sum miscomputed; a leg row missing]', async () => {
    const f = await fixture('two-same');
    const l1 = await loanOf(f, f.paying, 'L1');
    const l2 = await loanOf(f, f.paying, 'L2');
    await raiseReceivable(f, '20000.00');
    // one leg names no owner store, the other names the paying store itself: both are same-store
    const r = await rec(f, { loanLegs: [{ loanId: l1, amount: '590.00' }, { loanId: l2, amount: '1770.00', ownerStoreId: f.paying.id }] satisfies Leg[] });

    const lines = await linesOf(r.entryId);
    expect(lines.map(shape)).toEqual([
      { code: '1140', debit: '17640.00', store: f.paying.id, party: `money_account:${f.bankId}` },
      { code: '2400', debit: '590.00', store: f.paying.id, party: `loan:${l1}` },
      { code: '2400', debit: '1770.00', store: f.paying.id, party: `loan:${l2}` },
      { code: '1220', credit: '20000.00', store: f.paying.id, party: `channel:${f.channelId}` },
    ]);
    balanced(lines);

    const [row] = await sql<{ loan_deduction: string }[]>`select loan_deduction::text from channel_settlements where id = ${r.settlementId}`;
    expect(row!.loan_deduction).toBe('2360.00');
    expect(await legRowsOf(r.settlementId)).toEqual([
      { loan_id: l1, owner_store_id: f.paying.id, amount: '590.00' },
      { loan_id: l2, owner_store_id: f.paying.id, amount: '1770.00' },
    ]);
    expect(Number((await position(f, l1)).outstanding)).toBe(4410);
    expect(Number((await position(f, l2)).outstanding)).toBe(3230);
    expect(Number(await outstanding(f))).toBe(0);
  });

  it('one same-store loan and one cross-store loan: the 2400 line, then the 1250 / 2400 / 2150 triple, exactly, the two stores reciprocal [kills: the cross-store leg posted as same-store; the triple on the wrong stores or parties; the order of legs lost]', async () => {
    const f = await fixture('same-cross');
    const l1 = await loanOf(f, f.paying, 'L1');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, { loanLegs: [{ loanId: l1, amount: '590.00' }, { loanId: l3, amount: '1770.00', ownerStoreId: f.other.id }] satisfies Leg[] });

    const lines = await linesOf(r.entryId);
    expect(lines.map(shape)).toEqual([
      { code: '1140', debit: '17640.00', store: f.paying.id, party: `money_account:${f.bankId}` },
      { code: '2400', debit: '590.00', store: f.paying.id, party: `loan:${l1}` },
      { code: '1250', debit: '1770.00', store: f.paying.id, party: `store:${f.other.code}` },
      { code: '2400', debit: '1770.00', store: f.other.id, party: `loan:${l3}` },
      { code: '2150', credit: '1770.00', store: f.other.id, party: `store:${f.paying.code}` },
      { code: '1220', credit: '20000.00', store: f.paying.id, party: `channel:${f.channelId}` },
    ]);
    balanced(lines);
    expect(await legRowsOf(r.settlementId)).toEqual([
      { loan_id: l1, owner_store_id: f.paying.id, amount: '590.00' },
      { loan_id: l3, owner_store_id: f.other.id, amount: '1770.00' },
    ]);
    expect(Number((await position(f, l1)).outstanding)).toBe(4410);
    expect(Number((await position(f, l3)).outstanding)).toBe(3230);
  });

  it('two cross-store legs to DIFFERENT owner stores: a triple each, each owner debited and credited on its own books, 1250 and 2150 equal and opposite in total [kills: both triples on the first owner; the second owner dropped; a due-to against the wrong paying store]', async () => {
    const f = await fixture('cross-cross');
    const l3 = await loanOf(f, f.other, 'L3');
    const l4 = await loanOf(f, f.third, 'L4');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, { loanLegs: [{ loanId: l3, amount: '1000.00', ownerStoreId: f.other.id }, { loanId: l4, amount: '1360.00', ownerStoreId: f.third.id }] satisfies Leg[] });

    const lines = await linesOf(r.entryId);
    expect(lines.map(shape)).toEqual([
      { code: '1140', debit: '17640.00', store: f.paying.id, party: `money_account:${f.bankId}` },
      { code: '1250', debit: '1000.00', store: f.paying.id, party: `store:${f.other.code}` },
      { code: '2400', debit: '1000.00', store: f.other.id, party: `loan:${l3}` },
      { code: '2150', credit: '1000.00', store: f.other.id, party: `store:${f.paying.code}` },
      { code: '1250', debit: '1360.00', store: f.paying.id, party: `store:${f.third.code}` },
      { code: '2400', debit: '1360.00', store: f.third.id, party: `loan:${l4}` },
      { code: '2150', credit: '1360.00', store: f.third.id, party: `store:${f.paying.code}` },
      { code: '1220', credit: '20000.00', store: f.paying.id, party: `channel:${f.channelId}` },
    ]);
    balanced(lines);
    const sum = (code: string, side: 'debit' | 'credit') => lines.filter((l) => l.code === code).reduce((t, l) => t + Math.round(Number(l[side]) * 100), 0);
    expect(sum('1250', 'debit')).toBe(sum('2150', 'credit'));
    expect(Number((await position(f, l3)).outstanding)).toBe(4000);
    expect(Number((await position(f, l4)).outstanding)).toBe(3640);
  });

  it('legs, fees and a below-tolerance shortfall in one settlement: every line present, balanced, the receivable cleared exactly [kills: legs breaking the identity; fees dropped when legs are present]', async () => {
    const f = await fixture('mixed');
    const l1 = await loanOf(f, f.paying, 'L1');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '10000.00');
    // 10,000 - 2,500 commission - (590 + 1,770) legs = 5,140 expected; banked 5,130, so 10.00 short (within the 1,000 tolerance)
    const r = await rec(f, {
      grossAmount: '10000.00', netDeposited: '5130.00', deductions: { commission: '2500.00' },
      loanLegs: [{ loanId: l1, amount: '590.00' }, { loanId: l3, amount: '1770.00', ownerStoreId: f.other.id }] satisfies Leg[],
    });
    expect(r.variance).toBe('10.00');
    const lines = await linesOf(r.entryId);
    expect(lines.map((l) => l.code)).toEqual(['1140', '6400', '6420', '2400', '1250', '2400', '2150', '1220']);
    balanced(lines);
    expect(Number(await outstanding(f))).toBe(0);
  });

  it('the preview with two legs reports their sum as the loan deduction and posts nothing [kills: a preview that still reads one leg; a preview that writes]', async () => {
    const f = await fixture('preview-legs');
    const l1 = await loanOf(f, f.paying, 'L1');
    const l2 = await loanOf(f, f.paying, 'L2');
    await raiseReceivable(f, '20000.00');
    const p = await prev(f, { loanLegs: [{ loanId: l1, amount: '590.00' }, { loanId: l2, amount: '1770.00' }] satisfies Leg[] });
    expect(p.loanDeduction).toBe('2360.00');
    expect(p.variance).toBe('0.00');
    expect(p.settlementGain).toBe('0.00');
    expect(p.blockers).toEqual([]);
    expect(await settlementCount(f)).toBe(0);
    expect(Number(await outstanding(f))).toBe(20000);
  });
});

describe('T-511 S6a - what the legs list may and may not be', () => {
  it('an empty list and a missing list are a settlement with no loan: no 2400 line, loan_deduction 0.00, no leg rows [kills: a phantom leg of zero; a loan required]', async () => {
    for (const over of [{ loanLegs: [] }, {}]) {
      const f = await fixture('no-legs');
      await raiseReceivable(f, '20000.00');
      const r = await rec(f, { ...over, netDeposited: '20000.00' });
      expect((await linesOf(r.entryId)).map((l) => l.code), JSON.stringify(over)).toEqual(['1140', '1220']);
      expect((await sql<{ d: string }[]>`select loan_deduction::text as d from channel_settlements where id = ${r.settlementId}`)[0]!.d).toBe('0.00');
      expect(await legRowsOf(r.settlementId)).toEqual([]);
    }
  });

  it('a leg with a blank loanId is a picker left open and is dropped (as the single loan was); the other leg still posts and the deduction is only its amount [kills: a blank leg posted against no loan; a blank leg counted into the deduction]', async () => {
    const f = await fixture('blank-leg');
    const l1 = await loanOf(f, f.paying, 'L1');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, { netDeposited: '19410.00', loanLegs: [{ loanId: '', amount: '500.00' }, { loanId: l1, amount: '590.00' }] satisfies Leg[] });
    expect((await linesOf(r.entryId)).map((l) => l.code)).toEqual(['1140', '2400', '1220']);
    expect(await legRowsOf(r.settlementId)).toEqual([{ loan_id: l1, owner_store_id: f.paying.id, amount: '590.00' }]);
  });

  it('⛔ the same (loan, owner store) twice is refused with a plain sentence that names the loan, nothing is posted, and the preview lists that same sentence [kills: the database unique violation leaking; both legs posted; a silent merge]', async () => {
    const f = await fixture('dupe-leg');
    const l1 = await loanOf(f, f.paying, 'L1');
    await raiseReceivable(f, '20000.00');
    const legs = [{ loanId: l1, amount: '500.00' }, { loanId: l1, amount: '90.00', ownerStoreId: f.paying.id }] satisfies Leg[];
    let thrown: unknown;
    try {
      await rec(f, { netDeposited: '19410.00', loanLegs: legs });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'the duplicate leg must be refused').toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    const plain = String((thrown as { userMessage?: unknown }).userMessage ?? message);
    expect(`${message} ${plain}`).toMatch(/loan/i);
    expect(`${message} ${plain}`, 'a plain sentence, not a constraint or SQL error').not.toMatch(/violates|duplicate key|unique constraint|channel_settlement_loan_legs|23505/i);
    expect(await settlementCount(f)).toBe(0);
    expect(Number(await outstanding(f))).toBe(20000);

    const p = await prev(f, { netDeposited: '19410.00', loanLegs: legs });
    expect(p.blockers.length, 'the preview refuses it as a blocker, it does not throw').toBeGreaterThan(0);
    expect(p.blockers.some((b) => message.includes(b) || b === plain), 'the sentence the posting throws is one of the preview blockers').toBe(true);
  });

  it('a negative leg amount is refused, as the negative single loan was; nothing is posted [kills: a negative leg turning into a credit to 2400]', async () => {
    const f = await fixture('neg-leg');
    const l1 = await loanOf(f, f.paying, 'L1');
    await raiseReceivable(f, '20000.00');
    let thrown: unknown;
    try {
      await rec(f, { netDeposited: '20590.00', loanLegs: [{ loanId: l1, amount: '-590.00' }] satisfies Leg[] });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'the negative leg must be refused').toBeInstanceOf(Error);
    expect((thrown as { userMessage?: string }).userMessage, 'the field rule carries the words in userMessage').toMatch(/negative|amount docked/i);
    expect(await settlementCount(f)).toBe(0);
  });

  it('a refused settlement leaves no leg rows behind (the legs are written with the header, in its transaction) [kills: legs committed before the posting that then fails]', async () => {
    const f = await fixture('atomic');
    const l1 = await loanOf(f, f.paying, 'L1');
    await raiseReceivable(f, '20000.00');
    // net 100.00 against 2,360 of legs: the day is short by ~17,540, past tolerance, no acknowledgement: refused
    await expect(rec(f, { netDeposited: '100.00', loanLegs: [{ loanId: l1, amount: '2360.00' }] satisfies Leg[] })).rejects.toThrow(/acknowledgeDifference/);
    const n = (await sql<{ n: string }[]>`select count(*)::text as n from channel_settlement_loan_legs where org_id = ${f.orgId}`)[0]!.n;
    expect(Number(n)).toBe(0);
  });
});

describe('T-511 S6a - reading the legs back, and voiding them', () => {
  it('getById and every list row carry loanLegs (same-store legs with the paying store as owner) and no longer carry loanId / loanOwnerStoreId [kills: legs written but unreadable; the old single-loan fields kept as a second source of truth]', async () => {
    const f = await fixture('read');
    const l1 = await loanOf(f, f.paying, 'L1');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, { loanLegs: [{ loanId: l1, amount: '590.00' }, { loanId: l3, amount: '1770.00', ownerStoreId: f.other.id }] satisfies Leg[] });
    const byAmount = (a: { amount: string }, b: { amount: string }) => Number(a.amount) - Number(b.amount);
    const expected = [
      { loanId: l1, ownerStoreId: f.paying.id, amount: '590.00' },
      { loanId: l3, ownerStoreId: f.other.id, amount: '1770.00' },
    ];

    const row = (await asOrg(f.orgId, (tx) => channelSettlementsRepo.getById(tx, f.orgId, r.settlementId))) as unknown as Record<string, unknown>;
    expect(row, 'the settlement row').toBeDefined();
    expect([...(row.loanLegs as { amount: string }[])].sort(byAmount)).toEqual(expected);
    expect('loanId' in row).toBe(false);
    expect('loanOwnerStoreId' in row).toBe(false);

    const list = (await asOrg(f.orgId, (tx) => channelSettlementsRepo.listSettlements(tx, f.orgId, { limit: 10 }))) as unknown as Record<string, unknown>[];
    const mine = list.find((x) => x.id === r.settlementId);
    expect(mine, 'the settlement is in the list').toBeDefined();
    expect([...(mine!.loanLegs as { amount: string }[])].sort(byAmount)).toEqual(expected);
    for (const x of list) expect('loanId' in x, 'no list row carries loanId').toBe(false);
  });

  it('a settlement with no loan reads back an empty loanLegs, not undefined [kills: loanLegs missing on a plain settlement]', async () => {
    const f = await fixture('read-plain');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, { netDeposited: '20000.00' });
    const row = (await asOrg(f.orgId, (tx) => channelSettlementsRepo.getById(tx, f.orgId, r.settlementId))) as unknown as { loanLegs: unknown };
    expect(row.loanLegs).toEqual([]);
  });

  it('⭐ void reverses EVERY leg: the reversal nets each leg to zero, all three positions return to 5,000.00, the receivable is back, and the legs stay as history [kills: only the first leg reversed; legs deleted by the void; a leg left on the books]', async () => {
    const f = await fixture('void');
    const l1 = await loanOf(f, f.paying, 'L1');
    const l2 = await loanOf(f, f.paying, 'L2');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, {
      netDeposited: '17000.00',
      loanLegs: [{ loanId: l1, amount: '590.00' }, { loanId: l2, amount: '1000.00' }, { loanId: l3, amount: '1410.00', ownerStoreId: f.other.id }] satisfies Leg[],
    });
    expect(Number((await position(f, l3)).outstanding)).toBe(3590);

    const v = await asOrg(f.orgId, (tx) => voidChannelSettlement(tx, f.manager, { settlementId: r.settlementId, reason: 'Wrong payout file.' }));
    const reversal = await linesOf(v.reversedEntryId);
    const original = await linesOf(r.entryId);
    expect(reversal.length).toBe(original.length);
    // per (account, store, party): original + reversal nets to zero
    const net = new Map<string, number>();
    for (const l of [...original, ...reversal]) {
      const k = `${l.code}|${l.store_id}|${l.party_type}:${l.party_id}`;
      net.set(k, (net.get(k) ?? 0) + Math.round((Number(l.debit) - Number(l.credit)) * 100));
    }
    expect([...net.entries()].filter(([, v]) => v !== 0)).toEqual([]);

    for (const [loan, store] of [[l1, f.paying], [l2, f.paying], [l3, f.other]] as const) {
      const pos = await position(f, loan);
      expect(Number(pos.outstanding), `loan at ${store.code}`).toBe(5000);
      expect(Number(pos.principalPaid)).toBe(0);
    }
    expect(Number(await outstanding(f))).toBe(20000);
    expect(await legRowsOf(r.settlementId), 'the legs remain as history').toHaveLength(3);
    expect((await sql<{ s: string }[]>`select status as s from channel_settlements where id = ${r.settlementId}`)[0]!.s).toBe('voided');
  });
});

// =====================================================================================================================
// the acknowledged difference
// =====================================================================================================================

describe('T-511 S6a - a difference past tolerance needs an acknowledgement with a reason, either sign', () => {
  // gross 10,000.00 -> tolerance max(50.00, 10% = 1,000.00) = 1,000.00 at the rule defaults
  const base = { grossAmount: '10000.00' };
  const REASON = 'Platform short-paid this payout; statement line attached.';

  it('⛔ a SHORTFALL past tolerance is refused without an acknowledgement, naming acknowledgeDifference, and nothing is posted [kills: a shortfall that books silently; the old "reconcile it" refusal that cannot be acknowledged]', async () => {
    const f = await fixture('short-refused');
    await raiseReceivable(f, '10000.00');
    await expect(rec(f, { ...base, netDeposited: '5000.00' })).rejects.toThrow(/acknowledgeDifference/);
    expect(await settlementCount(f)).toBe(0);
    expect(Number(await outstanding(f))).toBe(10000);
  });

  it('a SHORTFALL past tolerance with an acknowledgement posts: 6420 debit of the difference, the receivable cleared exactly, the trimmed reason stored [kills: a shortfall to 7100; the reason not stored; the reason stored untrimmed; 1220 left over]', async () => {
    const f = await fixture('short-ack');
    await raiseReceivable(f, '10000.00');
    const r = await rec(f, { ...base, netDeposited: '5000.00', acknowledgeDifference: { reason: `  ${REASON}  ` } });
    expect(r.variance).toBe('5000.00');
    expect(r.settlementGain).toBe('0.00');
    expect((await linesOf(r.entryId)).map(shape)).toEqual([
      { code: '1140', debit: '5000.00', store: f.paying.id, party: `money_account:${f.bankId}` },
      { code: '6420', debit: '5000.00', store: f.paying.id, party: null },
      { code: '1220', credit: '10000.00', store: f.paying.id, party: `channel:${f.channelId}` },
    ]);
    expect(await reasonOf(r.settlementId)).toBe(REASON);
    expect(Number(await outstanding(f))).toBe(0);
  });

  it('⛔ a GAIN past tolerance is refused without an acknowledgement (naming acknowledgeDifference), and the old recognizeGain flag no longer acknowledges anything [kills: recognizeGain kept as a second switch; a gain that books silently]', async () => {
    const f = await fixture('gain-refused');
    await raiseReceivable(f, '10000.00');
    await expect(rec(f, { ...base, netDeposited: '13000.00' })).rejects.toThrow(/acknowledgeDifference/);
    await expect(rec(f, { ...base, netDeposited: '13000.00', recognizeGain: true })).rejects.toThrow(/acknowledgeDifference/);
    expect(await settlementCount(f)).toBe(0);
  });

  it('a GAIN past tolerance with an acknowledgement posts: 7100 credit of the difference, the reason stored [kills: a gain to 6420; the reason not stored]', async () => {
    const f = await fixture('gain-ack');
    await raiseReceivable(f, '10000.00');
    const r = await rec(f, { ...base, netDeposited: '13000.00', acknowledgeDifference: { reason: 'Staff under-reported the day; payout statement is right.' } });
    expect(r.settlementGain).toBe('3000.00');
    expect(r.variance).toBe('0.00');
    expect((await linesOf(r.entryId)).map(shape)).toEqual([
      { code: '1140', debit: '13000.00', store: f.paying.id, party: `money_account:${f.bankId}` },
      { code: '7100', credit: '3000.00', store: f.paying.id, party: null },
      { code: '1220', credit: '10000.00', store: f.paying.id, party: `channel:${f.channelId}` },
    ]);
    expect(await reasonOf(r.settlementId)).toBe('Staff under-reported the day; payout statement is right.');
  });

  it('within tolerance NEEDS none: a 40.00 shortfall posts to 6420 as before with no reason stored [kills: an acknowledgement demanded for rounding differences]', async () => {
    const f = await fixture('within');
    await raiseReceivable(f, '10000.00');
    const r = await rec(f, { ...base, netDeposited: '9960.00' });
    expect(r.variance).toBe('40.00');
    expect(await reasonOf(r.settlementId)).toBeNull();
    expect((await linesOf(r.entryId)).find((l) => l.code === '6420')?.debit).toBe('40.00');
  });

  it('the boundary is the tolerance itself: exactly 1,000.00 short needs none, 1,000.01 short needs one, for a shortfall and for a gain alike [kills: > vs >= off by one; a tolerance applied to one sign only]', async () => {
    const f = await fixture('boundary');
    await raiseReceivable(f, '10000.00');
    const need = async (net: string) => (await prev(f, { ...base, netDeposited: net })).needsAcknowledgement;
    expect(await need('9000.00')).toBe(false);
    expect(await need('8999.99')).toBe(true);
    expect(await need('11000.00')).toBe(false);
    expect(await need('11000.01')).toBe(true);
  });

  it('⛔ an empty or whitespace-only reason is refused with a sentence naming the reason, either sign, nothing posted [kills: an acknowledgement with no reason; a reason check without trim]', async () => {
    const f = await fixture('blank-reason');
    await raiseReceivable(f, '10000.00');
    for (const net of ['5000.00', '13000.00']) {
      for (const reason of ['', '   ', '\t\n']) {
        await expect(rec(f, { ...base, netDeposited: net, acknowledgeDifference: { reason } }), `net ${net}, reason ${JSON.stringify(reason)}`).rejects.toThrow(/reason/i);
      }
    }
    expect(await settlementCount(f)).toBe(0);
  });

  it('a reason of 500 characters is accepted and 501 is refused (the cap of the reject-day reason) [kills: no cap; a cap of the wrong size]', async () => {
    const f = await fixture('cap');
    await raiseReceivable(f, '10000.00');
    await expect(rec(f, { ...base, netDeposited: '5000.00', acknowledgeDifference: { reason: 'x'.repeat(501) } })).rejects.toThrow(/reason/i);
    expect(await settlementCount(f)).toBe(0);
    const r = await rec(f, { ...base, netDeposited: '5000.00', acknowledgeDifference: { reason: 'x'.repeat(500) } });
    expect((await reasonOf(r.settlementId))!.length).toBe(500);
  });

  it('a preview reports the difference and its sign, and whether it needs an acknowledgement: short, over, within tolerance, exact [kills: needsGainAcknowledgement kept; no sign; no difference]', async () => {
    const f = await fixture('preview-sign');
    await raiseReceivable(f, '10000.00');
    const short = await prev(f, { ...base, netDeposited: '5000.00' });
    expect(short).toMatchObject({ needsAcknowledgement: true, difference: '5000.00', differenceSign: 'short', variance: '5000.00', settlementGain: '0.00' });
    expect(short.blockers.join(' ')).toMatch(/acknowledgeDifference/);
    expect('needsGainAcknowledgement' in short).toBe(false);

    const over = await prev(f, { ...base, netDeposited: '13000.00' });
    expect(over).toMatchObject({ needsAcknowledgement: true, difference: '3000.00', differenceSign: 'over', variance: '0.00', settlementGain: '3000.00' });
    expect(over.blockers.join(' ')).toMatch(/acknowledgeDifference/);

    const within = await prev(f, { ...base, netDeposited: '9960.00' });
    expect(within).toMatchObject({ needsAcknowledgement: false, difference: '40.00', differenceSign: 'short' });
    expect(within.blockers).toEqual([]);

    const exact = await prev(f, { ...base, netDeposited: '10000.00' });
    expect(exact).toMatchObject({ needsAcknowledgement: false, difference: '0.00', differenceSign: 'none', blockers: [] });
  });

  it('with a reason the preview clears (needsAcknowledgement false, no blockers); with a blank reason it does not [kills: a preview that accepts a blank reason; a preview that ignores the acknowledgement]', async () => {
    const f = await fixture('preview-ack');
    await raiseReceivable(f, '10000.00');
    for (const net of ['5000.00', '13000.00']) {
      const ok = await prev(f, { ...base, netDeposited: net, acknowledgeDifference: { reason: REASON } });
      expect(ok.needsAcknowledgement, `net ${net} with a reason`).toBe(false);
      expect(ok.blockers).toEqual([]);
      const blank = await prev(f, { ...base, netDeposited: net, acknowledgeDifference: { reason: '  ' } });
      expect(blank.blockers.length, `net ${net} with a blank reason`).toBeGreaterThan(0);
      expect(blank.blockers.join(' ')).toMatch(/reason/i);
    }
    expect(await settlementCount(f)).toBe(0);
  });

  it('the acknowledgement works with legs: a two-loan day that is short past tolerance posts all its lines plus 6420 and stores the reason [kills: the acknowledgement path dropping the legs]', async () => {
    const f = await fixture('ack-and-legs');
    const l1 = await loanOf(f, f.paying, 'L1');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '10000.00');
    // expected net 10,000 - 590 - 1,770 = 7,640; banked 5,000 -> 2,640 short, past the 1,000 tolerance
    const r = await rec(f, {
      ...base, netDeposited: '5000.00', acknowledgeDifference: { reason: REASON },
      loanLegs: [{ loanId: l1, amount: '590.00' }, { loanId: l3, amount: '1770.00', ownerStoreId: f.other.id }] satisfies Leg[],
    });
    expect(r.variance).toBe('2640.00');
    const lines = await linesOf(r.entryId);
    expect(lines.map((l) => l.code)).toEqual(['1140', '6420', '2400', '1250', '2400', '2150', '1220']);
    balanced(lines);
    expect(await legRowsOf(r.settlementId)).toHaveLength(2);
    expect(await reasonOf(r.settlementId)).toBe(REASON);
  });
});
