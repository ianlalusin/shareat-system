import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-488 (DEF-777) — nine posting paths used to key their journal entry on (document, date, amount), so a genuine
 * second identical transaction on the same day was read by `postEntry` as a retry and silently dropped while the
 * caller was told it had worked. The key is now the form's per-render `requestId`.
 *
 * For each of the nine: (a) different ids, same figures, same day -> TWO entries; (b) the same id twice -> ONE entry and
 * the second call hands back the first's id; (c) the same id with a different amount -> refused, nothing written;
 * (d) a missing / garbage id -> refused, nothing written.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { postEntryOnce } from '../../src/ledger/replay';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  chargeLiability,
  createLiability,
  createLoan,
  createOwner,
  disburseLoan,
  payLiability,
  recordContribution,
  recordDrawing,
  recoverFromPay,
  refundSupplierCredit,
  repayFromOwner,
  writeOffReceivable,
} from '@shareat/domain';

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

async function person(orgId: string, storeId: string, name: string, role: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

/** A posted opening-balance entry: Dr `cashCode` / Cr 3900, so a money account has cash to pay out of. */
async function fund(orgId: string, storeId: string, cashCode: '1110' | '1130', amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${orgId} order by starts_on limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${orgId}, '2026-01-01', ${period!.id}, 'opening_balance', ${uid('ob')}, 'draft') returning id
    `;
    const codes = await tx<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${orgId} and code in (${cashCode}, '3900')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 1, ${by.get(cashCode)!}, ${storeId}, ${amount}, '0'),
             (${e!.id}, 2, ${by.get('3900')!}, ${storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/** A posted entry that leaves `ownerId` owing `amount` (1260 against the owner) — the receivable the settle paths clear. */
async function owesUs(f: Fixture, ownerId: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= '2026-01-12' and ends_on >= '2026-01-12'
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-12', ${period!.id}, 'expense', ${uid('pe')}, 'draft') returning id
    `;
    const codes = await tx<{ id: string; code: string }[]>`
      select id, code from accounts where org_id = ${f.orgId} and code in ('1260', '1110')
    `;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${by.get('1260')!}, ${f.storeId}, ${amount}, '0', 'owner', ${ownerId})
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${by.get('1110')!}, ${f.storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

async function fixture(hint: string) {
  const code = uid(`t488-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  const storeId = store!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')
  `;
  const adminId = await person(orgId, storeId, 'Admin', 'admin');
  const anaId = await person(orgId, storeId, 'Ana', 'staff');
  const [till] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation
  `;
  const [safe] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'office' and is_foundation
  `;
  await fund(orgId, storeId, '1110', '500000.00');
  await fund(orgId, storeId, '1130', '500000.00');
  return { orgId, storeId, adminId, anaId, admin: actor(orgId, adminId), till: till!.id, safe: safe!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function newOwner(f: Fixture, over: Record<string, unknown> = {}) {
  const created = await asOrg(f.orgId, (tx) =>
    createOwner(tx, f.admin, { storeId: f.storeId, personId: f.anaId, role: 'Managing Partner', ...over }),
  );
  return created.id;
}

type Amount = '2000.00' | '3000.00';

interface Scenario {
  orgId: string;
  /** What the entries are filed under, to count them. */
  sourceType: string;
  sourceId: string;
  /** Runs the function inside an org-scoped transaction with these figures; resolves to the entry id it reports. */
  call: (tx: Tx, requestId: unknown, amount: Amount) => Promise<string>;
}

// `requestId` is typed via a cast on purpose: the (d) cases hand in garbage.
const rq = (v: unknown) => ({ requestId: v as string });

async function ownerScenario(
  hint: string,
  sourceType: string,
  needsReceivable: boolean,
  call: (f: Fixture, ownerId: string, tx: Tx, requestId: unknown, amount: Amount) => Promise<{ entryId: string }>,
): Promise<Scenario> {
  const f = await fixture(hint);
  const id = await newOwner(f);
  if (needsReceivable) await owesUs(f, id, '20000.00');
  return {
    orgId: f.orgId,
    sourceType,
    sourceId: id,
    call: async (tx, requestId, amount) => (await call(f, id, tx, requestId, amount)).entryId,
  };
}

async function liabilityScenario(hint: string, sourceType: 'liability_charge' | 'liability_payment'): Promise<Scenario> {
  const f = await fixture(hint);
  const created = await asOrg(f.orgId, (tx) =>
    createLiability(tx, f.admin, { storeId: f.storeId, name: 'Accrued rent — January', category: 'accrued_expenses' }),
  );
  if (sourceType === 'liability_payment') {
    // Something owed, so a payment is not refused as an overpayment (its own id, its own figures).
    await asOrg(f.orgId, (tx) =>
      chargeLiability(tx, f.admin, {
        liabilityId: created.id, amount: '20000.00', againstAccountCode: '6200', on: '2026-01-31', ...rq(randomUUID()),
      }),
    );
  }
  return {
    orgId: f.orgId,
    sourceType,
    sourceId: created.id,
    call: async (tx, requestId, amount) =>
      sourceType === 'liability_charge'
        ? (await chargeLiability(tx, f.admin, { liabilityId: created.id, amount, againstAccountCode: '6200', on: '2026-01-31', ...rq(requestId) })).entryId
        : (await payLiability(tx, f.admin, { liabilityId: created.id, amount, fromMoneyAccountId: f.safe, on: '2026-02-05', ...rq(requestId) })).entryId,
  };
}

const builders: Record<string, () => Promise<Scenario>> = {
  recordContribution: () =>
    ownerScenario('contrib', 'capital_contribution', false, (f, ownerId, tx, requestId, amount) =>
      recordContribution(tx, f.admin, { ownerId, amount, intoMoneyAccountId: f.till, on: '2026-01-08', ...rq(requestId) }),
    ),
  recordDrawing: () =>
    ownerScenario('draw', 'drawing', false, (f, ownerId, tx, requestId, amount) =>
      recordDrawing(tx, f.admin, { ownerId, amount, fromMoneyAccountId: f.till, on: '2026-01-09', ...rq(requestId) }),
    ),
  repayFromOwner: () =>
    ownerScenario('repay', 'owner_repayment', true, (f, ownerId, tx, requestId, amount) =>
      repayFromOwner(tx, f.admin, { ownerId, amount, intoMoneyAccountId: f.till, on: '2026-01-20', ...rq(requestId) }),
    ),
  recoverFromPay: () =>
    ownerScenario('recover', 'owner_pay_recovery', true, (f, ownerId, tx, requestId, amount) =>
      recoverFromPay(tx, f.admin, { ownerId, amount, on: '2026-01-20', ...rq(requestId) }),
    ),
  writeOffReceivable: () =>
    ownerScenario('writeoff', 'owner_writeoff', true, (f, ownerId, tx, requestId, amount) =>
      writeOffReceivable(tx, f.admin, { ownerId, amount, reason: 'agreed with the partners', on: '2026-02-05', ...rq(requestId) }),
    ),
  chargeLiability: () => liabilityScenario('lchg', 'liability_charge'),
  payLiability: () => liabilityScenario('lpay', 'liability_payment'),
  disburseLoan: async () => {
    const f = await fixture('loan');
    const loan = await asOrg(f.orgId, (tx) =>
      createLoan(tx, f.admin, {
        storeId: f.storeId, lenderName: 'Grab', name: 'Grab cash advance', principalAmount: '200000.00',
        interestRate: '2', ratePeriod: 'month', interestMethod: 'straight', paymentFrequency: 'daily',
        termPeriods: 90, startDate: '2026-01-05',
      }),
    );
    return {
      orgId: f.orgId,
      sourceType: 'loan_disbursement',
      sourceId: loan.id,
      call: async (tx, requestId, amount) =>
        (await disburseLoan(tx, f.admin, { loanId: loan.id, amount, intoMoneyAccountId: f.safe, on: '2026-01-10', ...rq(requestId) })).entryId,
    };
  },
  refundSupplierCredit: async () => {
    const f = await fixture('refund');
    const [supplier] = await sql<{ id: string }[]>`
      insert into suppliers (org_id, name, created_by) values (${f.orgId}, 'Acme Meats', ${f.anaId}) returning id
    `;
    const supplierId = supplier!.id;
    // A credit we hold with the supplier: Dr 1240 (party = supplier) / Cr 3900, raw, so the returns module is not under test.
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} order by starts_on limit 1`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${f.orgId}, '2026-01-02', ${period!.id}, 'opening_balance', ${uid('adv')}, 'draft') returning id
      `;
      const codes = await tx<{ id: string; code: string }[]>`
        select id, code from accounts where org_id = ${f.orgId} and code in ('1240', '3900')
      `;
      const by = new Map(codes.map((c) => [c.code, c.id]));
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
        values (${e!.id}, 1, ${by.get('1240')!}, ${f.storeId}, '20000.00', '0', 'supplier', ${supplierId})
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, 2, ${by.get('3900')!}, ${f.storeId}, '0', '20000.00')
      `;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    return {
      orgId: f.orgId,
      sourceType: 'supplier_credit_refund',
      sourceId: supplierId,
      call: async (tx, requestId, amount) => {
        const res = await refundSupplierCredit(tx, {
          storeId: f.storeId, supplierId, moneyAccountId: f.till, amount, businessDate: '2026-01-20', actor: f.admin, ...rq(requestId),
        });
        if (!res.ok) throw new Error(`refundSupplierCredit refused: ${res.reason}`);
        return res.entryId;
      },
    };
  },
};

async function entriesOf(s: Scenario): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from journal_entries
    where org_id = ${s.orgId} and source_type = ${s.sourceType} and source_id = ${s.sourceId}
  `;
  return Number(row!.n);
}

const run = (s: Scenario, requestId: unknown, amount: Amount) =>
  asOrg(s.orgId, (tx) => s.call(tx, requestId, amount));

/** The sentence a refused caller is shown (`RefusalError.userMessage`); fails if the call did not reject at all. */
async function userMessageOf(call: Promise<unknown>): Promise<string> {
  const outcome = await call.then(
    () => ({ rejected: false as const }),
    (err: unknown) => ({ rejected: true as const, err }),
  );
  if (!outcome.rejected) throw new Error('expected the call to be refused, but it succeeded');
  return (outcome.err as { userMessage?: string }).userMessage ?? `not a refusal: ${String(outcome.err)}`;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe.each(Object.keys(builders))('T-488 — %s keys on the form’s requestId', (name) => {
  it('(a) two calls, same figures, different requestIds, same day -> TWO entries', async () => {
    const s = await builders[name]!();
    const first = await run(s, randomUUID(), '2000.00');
    const second = await run(s, randomUUID(), '2000.00');
    expect(second).not.toBe(first);
    expect(await entriesOf(s)).toBe(2);
  });

  it('(b) the same requestId twice -> ONE entry; the second call returns the first entry’s id', async () => {
    const s = await builders[name]!();
    const id = randomUUID();
    const first = await run(s, id, '2000.00');
    const second = await run(s, id, '2000.00');
    expect(second).toBe(first);
    expect(await entriesOf(s)).toBe(1);
  });

  it('(c) the same requestId with a different amount -> refused, nothing new written', async () => {
    const s = await builders[name]!();
    const id = randomUUID();
    await run(s, id, '2000.00');
    expect(await userMessageOf(run(s, id, '3000.00'))).toBe(
      'This was already recorded with different figures. Reload the page and try again.',
    );
    expect(await entriesOf(s)).toBe(1);
  });

  it.each([[undefined], [''], ['not-a-uuid'], ['12345678-1234-1234-1234-12345678901']])(
    '(d) requestId %j -> refused, nothing written',
    async (bad) => {
      const s = await builders[name]!();
      expect(await userMessageOf(run(s, bad, '2000.00'))).toBe(
        'This form is out of date. Reload the page and try again.',
      );
      expect(await entriesOf(s)).toBe(0);
    },
  );
});

describe('T-488 — recordDrawing: every distinct drawing counts against the cap', () => {
  it('two ₱2,000 drawings with different ids both post; a third that would pass 5,000 is refused', async () => {
    const f = await fixture('cap');
    const id = await newOwner(f, { drawingLimit: '5000.00', drawingLimitPeriod: 'monthly' });
    const draw = (requestId: string) =>
      asOrg(f.orgId, (tx) =>
        recordDrawing(tx, f.admin, {
          ownerId: id, amount: '2000.00', fromMoneyAccountId: f.till, on: '2026-01-09', ...rq(requestId),
        }),
      );
    const one = await draw(randomUUID());
    const two = await draw(randomUUID());
    expect(two.entryId).not.toBe(one.entryId);
    await expect(draw(randomUUID())).rejects.toThrow(/limit/i);
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries where org_id = ${f.orgId} and source_type = 'drawing' and source_id = ${id}
    `;
    expect(row!.n).toBe('2');
  });
});

describe('T-488 — postEntryOnce compares a multi-line entry as a set, not by position', () => {
  it('a three-line entry replayed with the lines in another order and "2000" for "2000.00" is accepted; a changed line is refused', async () => {
    const f = await fixture('multi');
    const key = `t488:multi:${randomUUID()}`;
    const line = (accountCode: string, side: 'debit' | 'credit', amount: string) => ({
      accountCode, storeId: f.storeId, [side]: amount,
    });
    const first = [line('1110', 'debit', '1000.00'), line('1130', 'debit', '500'), line('3900', 'credit', '1500.00')];
    const post = (lines: typeof first) =>
      asOrg(f.orgId, (tx) =>
        postEntryOnce(tx, {
          orgId: f.orgId, entryDate: '2026-01-15', sourceType: 'opening_balance', sourceId: uid('t488m'),
          idempotencyKey: key, postedBy: f.adminId, lines,
        }),
      );
    const a = await post(first);
    expect(a.created).toBe(true);
    const b = await post([first[2]!, first[0]!, first[1]!].map((l) => ({ ...l })) as typeof first);
    expect(b).toEqual({ entryId: a.entryId, created: false });
    expect(
      await userMessageOf(post([line('1110', 'debit', '1000.00'), line('1130', 'debit', '600.00'), line('3900', 'credit', '1600.00')])),
    ).toBe('This was already recorded with different figures. Reload the page and try again.');
  });
});

describe('T-488 S2 (DEF-787) — a replay must also match the entry date', () => {
  const REFUSED = 'This was already recorded with different figures. Reload the page and try again.';

  async function postOn(f: Fixture, key: string, entryDate: string, sourceId: string) {
    return asOrg(f.orgId, (tx) =>
      postEntryOnce(tx, {
        orgId: f.orgId, entryDate, sourceType: 'opening_balance', sourceId,
        idempotencyKey: key, postedBy: f.adminId,
        lines: [
          { accountCode: '1110', storeId: f.storeId, debit: '1000.00' },
          { accountCode: '3900', storeId: f.storeId, credit: '1000.00' },
        ],
      }),
    );
  }
  const countOf = async (orgId: string, key: string) => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries where org_id = ${orgId} and idempotency_key = ${key}
    `;
    return Number(row!.n);
  };

  it('same requestId + same lines, 31 Jan then 1 Feb -> refused, nothing new written', async () => {
    const f = await fixture('s2a');
    const key = `t488:s2a:${randomUUID()}`;
    const src = uid('s2a');
    await postOn(f, key, '2026-01-31', src);
    expect(await userMessageOf(postOn(f, key, '2026-02-01', src))).toBe(REFUSED);
    expect(await countOf(f.orgId, key)).toBe(1);
  });

  it('dates two months apart -> refused', async () => {
    const f = await fixture('s2b');
    const key = `t488:s2b:${randomUUID()}`;
    const src = uid('s2b');
    await postOn(f, key, '2026-01-10', src);
    expect(await userMessageOf(postOn(f, key, '2026-03-10', src))).toBe(REFUSED);
    expect(await countOf(f.orgId, key)).toBe(1);
  });

  it('an identical retry after the original month is CLOSED -> returns the original entry (created: false)', async () => {
    const f = await fixture('s2c');
    const key = `t488:s2c:${randomUUID()}`;
    const src = uid('s2c');
    const first = await postOn(f, key, '2026-01-31', src);
    expect(first.created).toBe(true);
    await sql`
      update fiscal_periods set status = 'closed'
      where org_id = ${f.orgId} and starts_on = '2026-01-01'
    `;
    const again = await postOn(f, key, '2026-01-31', src);
    expect(again).toEqual({ entryId: first.entryId, created: false });
    expect(await countOf(f.orgId, key)).toBe(1);
  });

  it('disburseLoan with only `on` changed -> refused, one entry', async () => {
    const s = await builders.disburseLoan!();
    const f2 = s; // scenario owns its fixture; reuse its call but vary the date through a direct second call below
    const id = randomUUID();
    await run(f2, id, '2000.00');
    // Same scenario helper pins `on: 2026-01-10`; replay the same call with another date via the domain function.
    const [loan] = await sql<{ id: string; created_by: string | null }[]>`
      select id, null as created_by from loans where org_id = ${s.orgId} and id = ${s.sourceId}
    `;
    const [adminRow] = await sql<{ person_id: string }[]>`
      select person_id from person_roles where org_id = ${s.orgId} and role = 'admin' limit 1
    `;
    const [safe] = await sql<{ id: string }[]>`
      select ma.id from money_accounts ma join stores st on st.id = ma.store_id
      where st.org_id = ${s.orgId} and ma.instrument = 'cash' and ma.custodian = 'office' and ma.is_foundation limit 1
    `;
    expect(
      await userMessageOf(
        asOrg(s.orgId, (tx) =>
          disburseLoan(tx, actor(s.orgId, adminRow!.person_id), {
            loanId: loan!.id, amount: '2000.00', intoMoneyAccountId: safe!.id, on: '2026-02-11', requestId: id,
          }),
        ),
      ),
    ).toBe(REFUSED);
    expect(await entriesOf(s)).toBe(1);
  });
});
