/**
 * T-511 S6a FIXES (7 Nov 2026, audit) - real Postgres. Items: (1) an invisible or NUL reason is refused in plain words at the preview and at the record;
 * (4) a leg's owner must be the loan's own store, an unknown or malformed loan id is a plain refusal, the same loan in two cases is the duplicate sentence;
 * (5a) a reason given within tolerance is not stored; (5c) two loans cross-store to the SAME owner post two triples. Mutants are named in each title `[kills: ...]`.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { config } from 'dotenv';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
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

const legCount = async (f: Fx) => Number((await sql<{ n: string }[]>`select count(*)::text as n from channel_settlement_loan_legs where org_id = ${f.orgId}`)[0]!.n);
const message = (e: unknown) => `${(e as Error).message} ${String((e as { userMessage?: unknown }).userMessage ?? '')}`;
const RAW = /violates|duplicate key|unique constraint|foreign key|invalid input syntax|22021|22P02|23503|23505|byte sequence|postgres|channel_settlement_loan_legs/i;
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return message(e);
  }
  throw new Error('expected a refusal, but it posted');
}

// gross 10,000.00: tolerance max(50.00, 10%) = 1,000.00, so a net of 5,000.00 is short past tolerance
const SHORT = { grossAmount: '10000.00', netDeposited: '5000.00' };

describe('T-511 S6a fixes - an invisible or NUL reason is refused, in plain words, at the preview and at the record', () => {
  it('a zero-width-only reason (U+200B, U+2060, U+FEFF) does not acknowledge: the preview still needs one, the record refuses naming the reason, nothing is posted [kills: an invisible reason posting]', async () => {
    const f = await fixture('zw');
    await raiseReceivable(f, '10000.00');
    for (const reason of ['​', '​‌‍', '⁠', '﻿ ​']) {
      const p = await prev(f, { ...SHORT, acknowledgeDifference: { reason } });
      expect(p.needsAcknowledgement, JSON.stringify(reason)).toBe(true);
      expect(p.blockers.length).toBeGreaterThan(0);
      const said = await refused(rec(f, { ...SHORT, acknowledgeDifference: { reason } }));
      expect(said, JSON.stringify(reason)).toMatch(/reason/i);
      expect(said).not.toMatch(RAW);
    }
    expect(await settlementCount(f)).toBe(0);
  });

  it('a NUL (or another control character) in the reason: the preview says so in a plain sentence, the record refuses it the same way, never a raw 22021; nothing is posted [kills: a NUL passing the preview and dying in Postgres]', async () => {
    const f = await fixture('nul');
    await raiseReceivable(f, '10000.00');
    for (const reason of ['bad\u0000reason', 'bell\u0007here', 'esc\u001b[0m']) {
      const p = await prev(f, { ...SHORT, acknowledgeDifference: { reason } });
      expect(p.blockers.join(' '), JSON.stringify(reason)).toMatch(/ordinary text/i);
      const said = await refused(rec(f, { ...SHORT, acknowledgeDifference: { reason } }));
      expect(said, JSON.stringify(reason)).toMatch(/ordinary text/i);
      expect(said).not.toMatch(RAW);
    }
    expect(await settlementCount(f)).toBe(0);
  });

  it('zero-width characters inside a real reason are dropped from what is stored; a tab and a line break stay [kills: the raw text stored]', async () => {
    const f = await fixture('zw-store');
    await raiseReceivable(f, '10000.00');
    const r = await rec(f, { ...SHORT, acknowledgeDifference: { reason: ' Short​ paid⁠\nstatement\tattached﻿ ' } });
    expect(await reasonOf(r.settlementId)).toBe('Short paid\nstatement\tattached');
  });

  it('a reason given when the difference is WITHIN tolerance is ignored: nothing stored, nothing refused [kills: any reason stored regardless of the tolerance]', async () => {
    const f = await fixture('within-reason');
    await raiseReceivable(f, '10000.00');
    const r = await rec(f, { grossAmount: '10000.00', netDeposited: '9960.00', acknowledgeDifference: { reason: 'Rounded by the platform' } });
    expect(r.variance).toBe('40.00');
    expect(await reasonOf(r.settlementId)).toBeNull();
  });

  it('an exact settlement with a reason given stores no reason either [kills: a reason stored when there is no difference]', async () => {
    const f = await fixture('exact-reason');
    await raiseReceivable(f, '10000.00');
    const r = await rec(f, { grossAmount: '10000.00', netDeposited: '10000.00', acknowledgeDifference: { reason: 'a reason nobody needed' } });
    expect(await reasonOf(r.settlementId)).toBeNull();
  });
});

describe('T-511 S6a fixes - a leg names a real loan of this organisation, owned by the store it names', () => {
  it('a leg whose owner store is not the loan store is refused in plain words, at the preview and the record: no 2400 debit for a debt the store never owed [kills: the third store debited for another store loan]', async () => {
    const f = await fixture('owner-wrong');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '20000.00');
    const legs = [{ loanId: l3, amount: '2360.00', ownerStoreId: f.third.id }];
    const p = await prev(f, { loanLegs: legs });
    expect(p.blockers.join(' ')).toMatch(/does not belong to the store/i);
    const said = await refused(rec(f, { loanLegs: legs }));
    expect(said).toMatch(/does not belong to the store/i);
    expect(said).not.toMatch(RAW);
    expect(await settlementCount(f)).toBe(0);
    expect(await legCount(f)).toBe(0);
    expect(Number((await position(f, l3)).outstanding)).toBe(5000);
  });

  it('a leg with NO owner store for a loan another store owns is the same refusal (the paying store would be debited for it) [kills: the owner defaulting to the paying store unchecked]', async () => {
    const f = await fixture('owner-missing');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '20000.00');
    expect(await refused(rec(f, { loanLegs: [{ loanId: l3, amount: '2360.00' }] }))).toMatch(/does not belong to the store/i);
    expect(await refused(rec(f, { loanLegs: [{ loanId: l3, amount: '2360.00', ownerStoreId: f.paying.id }] }))).toMatch(/does not belong to the store/i);
    expect(await settlementCount(f)).toBe(0);
  });

  it('the loan own store as owner still posts the cross-store triple [kills: the check refusing the valid cross-store leg]', async () => {
    const f = await fixture('owner-right');
    const l3 = await loanOf(f, f.other, 'L3');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, { loanLegs: [{ loanId: l3, amount: '2360.00', ownerStoreId: f.other.id }] });
    expect((await linesOf(r.entryId)).map((l) => l.code)).toEqual(['1140', '1250', '2400', '2150', '1220']);
  });

  it('an unknown loan id, a malformed one, and another organisation loan are each a plain refusal and a preview blocker, never a raw 23503 / 22P02 [kills: a foreign-key or uuid syntax error reaching the screen]', async () => {
    const f = await fixture('unknown');
    const g = await fixture('unknown-other-org');
    const foreign = await loanOf(g, g.paying, 'F1');
    await raiseReceivable(f, '20000.00');
    for (const loanId of ['018f0000-0000-7000-8000-000000000000', 'not-a-uuid', "1' or '1'='1", foreign]) {
      const legs = [{ loanId, amount: '2360.00' }];
      const p = await prev(f, { loanLegs: legs });
      expect(p.blockers.join(' '), loanId).toMatch(/loans? docked from this payout could not be found/i);
      const said = await refused(rec(f, { loanLegs: legs }));
      expect(said, loanId).toMatch(/could not be found/i);
      expect(said).not.toMatch(RAW);
    }
    expect(await settlementCount(f)).toBe(0);
  });

  it('the same loan typed in two cases (or with spaces) is the plain duplicate sentence, not a database unique violation; a lone upper-case id posts and is stored in lower case [kills: case-sensitive duplicate detection reaching 23505]', async () => {
    const f = await fixture('case');
    const l1 = await loanOf(f, f.paying, 'L1');
    await raiseReceivable(f, '20000.00');
    const dupe = [{ loanId: l1, amount: '500.00' }, { loanId: ` ${l1.toUpperCase()} `, amount: '90.00' }];
    const p = await prev(f, { netDeposited: '19410.00', loanLegs: dupe });
    expect(p.blockers.join(' ')).toMatch(/listed twice/i);
    const said = await refused(rec(f, { netDeposited: '19410.00', loanLegs: dupe }));
    expect(said).toMatch(/listed twice/i);
    expect(said).not.toMatch(RAW);
    expect(await settlementCount(f)).toBe(0);

    const r = await rec(f, { netDeposited: '19410.00', loanLegs: [{ loanId: ` ${l1.toUpperCase()}`, amount: '590.00' }] });
    expect((await sql<{ id: string }[]>`select loan_id::text as id from channel_settlement_loan_legs where settlement_id = ${r.settlementId}`).map((x) => x.id)).toEqual([l1]);
  });
});

describe('T-511 S6a fixes - two loans of the SAME other store, docked from one payout', () => {
  it('each leg posts its own 1250 / 2400 / 2150 triple, both on the same owner store, 1250 equal to 2150, both positions down, and a void undoes both [kills: the second leg of one owner merged into the first or dropped; the due-to side unbalanced]', async () => {
    const f = await fixture('same-owner');
    const l3 = await loanOf(f, f.other, 'L3');
    const l4 = await loanOf(f, f.other, 'L4');
    await raiseReceivable(f, '20000.00');
    const r = await rec(f, {
      loanLegs: [{ loanId: l3, amount: '590.00', ownerStoreId: f.other.id }, { loanId: l4, amount: '1770.00', ownerStoreId: f.other.id }],
    });
    const lines = await linesOf(r.entryId);
    expect(lines.map(shape)).toEqual([
      { code: '1140', debit: '17640.00', store: f.paying.id, party: `money_account:${f.bankId}` },
      { code: '1250', debit: '590.00', store: f.paying.id, party: `store:${f.other.code}` },
      { code: '2400', debit: '590.00', store: f.other.id, party: `loan:${l3}` },
      { code: '2150', credit: '590.00', store: f.other.id, party: `store:${f.paying.code}` },
      { code: '1250', debit: '1770.00', store: f.paying.id, party: `store:${f.other.code}` },
      { code: '2400', debit: '1770.00', store: f.other.id, party: `loan:${l4}` },
      { code: '2150', credit: '1770.00', store: f.other.id, party: `store:${f.paying.code}` },
      { code: '1220', credit: '20000.00', store: f.paying.id, party: `channel:${f.channelId}` },
    ]);
    balanced(lines);
    expect(Number((await position(f, l3)).outstanding)).toBe(4410);
    expect(Number((await position(f, l4)).outstanding)).toBe(3230);

    await asOrg(f.orgId, (tx) => voidChannelSettlement(tx, f.manager, { settlementId: r.settlementId, reason: 'Wrong payout file.' }));
    expect(Number((await position(f, l3)).outstanding)).toBe(5000);
    expect(Number((await position(f, l4)).outstanding)).toBe(5000);
    expect(await legCount(f), 'the legs stay as history after the void').toBe(2);
  });
});
