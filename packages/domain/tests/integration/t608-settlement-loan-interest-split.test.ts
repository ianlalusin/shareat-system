import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-608 (DEF-931) - a platform dock on a SCHEDULED loan splits into principal (2400) and interest (7200), cumulatively, in the loan's fixed ratio I/T.
 * docs/tasks/608-settlement-loan-interest-split.md. Real Postgres, real posting; synthetic data only. Grab Quick Cash shape: 150,000.00 drawn,
 * repayment 1,771.88 x 90 -> T = 159,469.20, I = 9,469.20, a full leg = 1,666.67 principal + 105.21 interest.
 *
 * MUTANTS (each test title ends with `[kills: ...]`): the whole leg stays on 2400; the 7200 line carries no party (the position never sees it); the interest is
 * rounded per leg instead of cumulatively; the cross-store 1250/2150 pair carries only the principal; the catch-up ignores interest already booked / is not
 * clamped to the leg; the loan check keeps reading principal outstanding; an unscheduled loan is split anyway; the void forgets the 7200 line.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - name must contain "_test".`);

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, loansRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { recordChannelSettlement, voidChannelSettlement } from '@shareat/domain';
import { postEntry } from '../../src/ledger/post-entry';
import { checkLoanDay, loadLoanCheckContext } from '../../src/settlement-intake/loan-check';

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
  const code = uid(`t608-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
    (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open'), (${orgId}, '2026-03-01', '2026-03-31', 'open'),
    (${orgId}, '2026-04-01', '2026-04-30', 'open'), (${orgId}, '2026-05-01', '2026-05-31', 'open'), (${orgId}, '2026-06-01', '2026-06-30', 'open')`;
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string; code: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id, code`;
    return { id: s!.id, code: s!.code };
  };
  const paying = await mkStore('malvar');
  const other = await mkStore('lipa');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'manager')`;
  for (const s of [paying, other]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s.id})`;
  const [bank] = await sql<{ id: string }[]>`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian) values (${orgId}, ${paying.id}, 'Payout wallet', 'bank', '1140', 'office') returning id`;
  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, destination_money_account_id)
    values (${orgId}, ${paying.id}, ${`Grab ${uid('c')}`}, false, '1220', ${bank!.id}) returning id`;
  return { orgId, paying, other, bankId: bank!.id, channelId: channel!.id, manager: actor(orgId, p!.id), personId: p!.id };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const cents = (s: string) => BigInt(s.replace('.', ''));
const fmt = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

/** A loan owned by `store`, 150,000.00 drawn. `repayment` null = no schedule recorded. */
async function loanOf(f: Fx, store: { id: string }, repayment: string | null, term = 90): Promise<string> {
  const [loan] = await sql<{ id: string }[]>`
    insert into loans (org_id, store_id, lender_name, name, principal_amount, interest_rate, rate_period, interest_method, payment_frequency, term_periods, start_date, repayment_amount, created_by)
    values (${f.orgId}, ${store.id}, 'Grab', ${uid('QuickCash')}, 150000, 0, 'month', 'straight', 'daily', ${term}, '2026-01-01', ${repayment}, ${f.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2026-01-02', sourceType: 'loan_disbursement', sourceId: loan!.id, idempotencyKey: `loan_disbursement:${loan!.id}`, memo: 'Draw', postedBy: f.personId,
      lines: [
        { accountCode: '1130', storeId: store.id, debit: '150000.00' },
        { accountCode: '2400', storeId: store.id, credit: '150000.00', partyType: 'loan', partyId: loan!.id },
      ],
    }),
  );
  return loan!.id;
}

let dayNo = 0;
/** One platform payout that docks `leg` from `loanId`: its own receivable (gross = leg + 100.00), a settlement on its own date. */
async function dock(f: Fx, loanId: string, leg: string, ownerStoreId?: string) {
  const gross = fmt(cents(leg) + 10000n);
  const net = fmt(10000n);
  const d = new Date(Date.UTC(2026, 0, 15 + ++dayNo)).toISOString().slice(0, 10);
  // one settlement per channel per sales day: every payout gets a day of its own
  const [day] = await sql<{ id: string }[]>`insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by) values (${f.orgId}, ${f.paying.id}, ${d}, 0, 0, 0, ${f.personId}) returning id`;
  const salesDayId = day!.id;
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: d, sourceType: 'sales_day', sourceId: salesDayId, idempotencyKey: `sales_day:${salesDayId}:${gross}:${d}`, memo: 'Channel day', postedBy: f.personId,
      lines: [
        { accountCode: '1220', storeId: f.paying.id, debit: gross, partyType: 'channel', partyId: f.channelId },
        { accountCode: '4150', storeId: f.paying.id, credit: gross },
      ],
    }),
  );
  return asOrg(f.orgId, (tx) =>
    recordChannelSettlement(tx, f.manager, {
      storeId: f.paying.id, channelId: f.channelId, businessDate: d, grossAmount: gross, netDeposited: net, salesDayId, settledOn: d,
      loanLegs: [{ loanId, amount: leg, ...(ownerStoreId ? { ownerStoreId } : {}) }],
    } as never),
  );
}

interface Line { code: string; debit: string; credit: string; store_id: string; party_type: string | null; party_id: string | null }
async function linesOf(entryId: string): Promise<Line[]> {
  return sql<Line[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.store_id::text, jl.party_type, jl.party_id
      from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${entryId} order by jl.line_no`;
}
const loanLines = (ls: Line[]) => ls.filter((l) => l.code === '2400' || l.code === '7200' || l.code === '1250' || l.code === '2150');
const shape = (l: Line) => ({ code: l.code, amount: Number(l.debit) > 0 ? l.debit : l.credit, side: Number(l.debit) > 0 ? 'Dr' : 'Cr', store: l.store_id, party: l.party_type ? `${l.party_type}:${l.party_id}` : null });
const position = (f: Fx, loanId: string) => asOrg(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, loanId));

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-608 - a platform dock on a scheduled loan splits principal / interest', () => {
  it('1. same store: a full leg posts 1,666.67 to 2400 and 105.21 to 7200 (party = the loan), and the position reads both [kills: the whole leg stays on 2400; the 7200 line has no party so the position misses it]', async () => {
    const f = await fixture('same');
    const loan = await loanOf(f, f.paying, '1771.88');
    const r = await dock(f, loan, '1771.88');
    const ls = await linesOf(r.entryId);
    expect(loanLines(ls).map(shape)).toEqual([
      { code: '2400', amount: '1666.67', side: 'Dr', store: f.paying.id, party: `loan:${loan}` },
      { code: '7200', amount: '105.21', side: 'Dr', store: f.paying.id, party: `loan:${loan}` },
    ]);
    const p = await position(f, loan);
    expect(p.principalPaid).toBe('1666.67');
    expect(p.interestPaid).toBe('105.21');
    expect(p.outstanding).toBe('148333.33');
  });

  it('2. cross-store: 1250 and 2150 carry the FULL leg, the owner store gets 2400 + 7200, the entry balances and the pair is reciprocal [kills: the pair carries only the principal; the interest lands on the paying store]', async () => {
    const f = await fixture('cross');
    const loan = await loanOf(f, f.other, '1771.88');
    const r = await dock(f, loan, '1771.88', f.other.id);
    const ls = await linesOf(r.entryId);
    expect(loanLines(ls).map(shape)).toEqual([
      { code: '1250', amount: '1771.88', side: 'Dr', store: f.paying.id, party: `store:${f.other.code}` },
      { code: '2400', amount: '1666.67', side: 'Dr', store: f.other.id, party: `loan:${loan}` },
      { code: '7200', amount: '105.21', side: 'Dr', store: f.other.id, party: `loan:${loan}` },
      { code: '2150', amount: '1771.88', side: 'Cr', store: f.other.id, party: `store:${f.paying.code}` },
    ]);
    const sum = (side: 'debit' | 'credit') => ls.reduce((t, l) => t + cents(l[side]), 0n);
    expect(sum('debit')).toBe(sum('credit'));
    expect(ls.filter((l) => l.code === '1250').reduce((t, l) => t + cents(l.debit), 0n)).toBe(ls.filter((l) => l.code === '2150').reduce((t, l) => t + cents(l.credit), 0n));
    const p = await position(f, loan);
    expect([p.principalPaid, p.interestPaid]).toEqual(['1666.67', '105.21']);
  });

  it('3. the same day split over two payouts (1,350.30 + 421.58) books the same interest as one 1,771.88 leg [kills: interest rounded per leg instead of cumulatively]', async () => {
    const f = await fixture('split');
    const whole = await loanOf(f, f.paying, '1771.88');
    const parts = await loanOf(f, f.paying, '1771.88');
    await dock(f, whole, '1771.88');
    await dock(f, parts, '1350.30');
    await dock(f, parts, '421.58');
    const w = await position(f, whole);
    const p = await position(f, parts);
    expect(p.interestPaid).toBe(w.interestPaid);
    expect(p.interestPaid).toBe('105.21');
    expect(p.principalPaid).toBe(w.principalPaid);
  });

  it('4. catch-up: a leg already booked as all principal is made good by the next leg, and interest never exceeds the leg [kills: interest already booked ignored; no clamp to the leg]', async () => {
    const f = await fixture('catchup');
    const loan = await loanOf(f, f.paying, null); // no schedule yet: today's behaviour, all principal
    const first = await dock(f, loan, '1771.88');
    expect(loanLines(await linesOf(first.entryId)).map(shape)).toEqual([{ code: '2400', amount: '1771.88', side: 'Dr', store: f.paying.id, party: `loan:${loan}` }]);
    await sql`update loans set repayment_amount = '1771.88' where id = ${loan}`;
    const second = await dock(f, loan, '1771.88');
    // cumulative: after 2 legs interest should be 210.43, none booked yet, so this leg carries all of it (twice the usual 105.21, plus a rounding centavo)
    expect(loanLines(await linesOf(second.entryId)).map(shape)).toEqual([
      { code: '2400', amount: '1561.45', side: 'Dr', store: f.paying.id, party: `loan:${loan}` },
      { code: '7200', amount: '210.43', side: 'Dr', store: f.paying.id, party: `loan:${loan}` },
    ]);

    // a huge earlier all-principal leg: the catch-up is bigger than the next leg, so the whole 50.00 is interest and 2400 gets no line
    const big = await loanOf(f, f.paying, null);
    await dock(f, big, '100000.00');
    await sql`update loans set repayment_amount = '1771.88' where id = ${big}`;
    const small = await dock(f, big, '50.00');
    expect(loanLines(await linesOf(small.entryId)).map(shape)).toEqual([{ code: '7200', amount: '50.00', side: 'Dr', store: f.paying.id, party: `loan:${big}` }]);
    const p = await position(f, big);
    expect([p.principalPaid, p.interestPaid]).toEqual(['100000.00', '50.00']);
  });

  it('5. the 90th full leg lands interest on exactly I and principal on exactly the principal; the loan check then reads "left to pay", not principal [kills: per-leg rounding drift; the loan check keeps reading principal outstanding]', async () => {
    const f = await fixture('last');
    const loan = await loanOf(f, f.paying, '1771.88');
    for (let i = 0; i < 89; i++) await dock(f, loan, '1771.88');
    const before = await position(f, loan);
    // what the loan check sees on the final day: 1,771.88 left to pay (it is NOT the principal still owed)
    const left = await asOrg(f.orgId, async (tx) => (await loadLoanCheckContext(tx, f.orgId, '2026-06-01')).outstanding.get(loan)!);
    expect(left).toBe('1771.88');
    expect(Number(before.outstanding)).toBeLessThan(1771.88); // principal alone is smaller: the old reading would call the final payment a mismatch
    const check = checkLoanDay({
      salesDate: '2026-06-01',
      loans: [{ loanId: loan, name: 'QuickCash', ownerStoreId: f.paying.id, ownerStoreName: 'Malvar', startDate: '2026-01-01', repaymentAmount: '1771.88' as never, outstandingBefore: left }],
      rows: [{ key: 'r1', storeId: f.paying.id, amount: '1771.88' as never }],
      storesNeedingFile: [],
      storesWithFile: new Set(),
    });
    expect(check.status).toBe('ok');
    expect(check.byLoan[0]!.final).toBe(true);

    await dock(f, loan, '1771.88');
    const p = await position(f, loan);
    expect(p.interestPaid).toBe('9469.20');
    expect(p.principalPaid).toBe('150000.00');
    expect(p.outstanding).toBe('0.00');
    const done = await asOrg(f.orgId, async (tx) => (await loadLoanCheckContext(tx, f.orgId, '2026-06-02')).outstanding.get(loan)!);
    expect(done).toBe('0.00');
  }, 240_000);

  it("6. a loan with no schedule keeps today's behaviour: the whole leg is principal, no 7200 line [kills: an unscheduled loan split anyway]", async () => {
    const f = await fixture('unsched');
    const loan = await loanOf(f, f.paying, null);
    const r = await dock(f, loan, '1771.88');
    expect(loanLines(await linesOf(r.entryId)).map(shape)).toEqual([{ code: '2400', amount: '1771.88', side: 'Dr', store: f.paying.id, party: `loan:${loan}` }]);
    expect((await position(f, loan)).interestPaid).toBe('0.00');
  });

  it('7. voiding the settlement reverses the 7200 line too, and the interest paid goes back [kills: the void forgets the 7200 line; the position nets a reversal wrongly]', async () => {
    const f = await fixture('void');
    const loan = await loanOf(f, f.paying, '1771.88');
    const r = await dock(f, loan, '1771.88');
    expect((await position(f, loan)).interestPaid).toBe('105.21');
    const v = await asOrg(f.orgId, (tx) => voidChannelSettlement(tx, f.manager, { settlementId: r.settlementId, reason: 'Wrong payout file.' }));
    const rev = loanLines(await linesOf(v.reversedEntryId)).map(shape);
    expect(rev).toEqual([
      { code: '2400', amount: '1666.67', side: 'Cr', store: f.paying.id, party: `loan:${loan}` },
      { code: '7200', amount: '105.21', side: 'Cr', store: f.paying.id, party: `loan:${loan}` },
    ]);
    const p = await position(f, loan);
    expect([p.principalPaid, p.interestPaid, p.outstanding]).toEqual(['0.00', '0.00', '150000.00']);
    // and the next dock after a void starts from nothing again
    await dock(f, loan, '1771.88');
    expect((await position(f, loan)).interestPaid).toBe('105.21');
  });
});
