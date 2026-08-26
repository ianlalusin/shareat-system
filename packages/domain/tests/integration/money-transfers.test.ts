import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-139 — money transfers. `docs/tasks/139-money-transfers.md`.
 *
 * The 4th most-used entry in v1 (POSTING-PATTERNS.md §Transfer, 926 legs), so the legs themselves
 * are checked here rather than assumed: **the entry balances whether or not the fee leg is
 * included, and only the ACCOUNT would be wrong** — nothing fails loudly on its own.
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
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, ROLES, CAPABILITY_MATRIX, type Actor } from '@shareat/auth';
import { createMoneyAccount, createMoneyTransfer, voidMoneyTransfer } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`mt-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const storeCode = uid(hint);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${storeCode}, ${`Store ${hint}`}) returning id
  `;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${org!.id}, '2026-01-01', '2026-01-31', 'open')
  `;
  return { orgId: org!.id, storeId: store!.id, storeCode };
}

async function person(orgId: string, storeId: string, name: string, role?: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id
  `;
  if (role) {
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  }
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** Legs of an entry, as `code debit credit party` — the shape POSTING-PATTERNS tables use. */
async function legsOf(entryId: string) {
  return sql<{ code: string; debit: string; credit: string; party_id: string | null }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId}
    order by a.code
  `;
}

/** A store with a cashier drawer, an office safe, and a wallet — the three ADR-010 shapes. */
async function fixture(hint: string) {
  const o = await newOrg(hint);
  const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
  const admin = actor(o.orgId, adminId);
  const mk = (name: string, instrument: 'cash' | 'ewallet', custodian: 'cashier' | 'office') =>
    asOrg(o.orgId, (tx) =>
      createMoneyAccount(tx, admin, { storeId: o.storeId, name, instrument, custodian }),
    );
  const drawer = await mk('Cashier drawer', 'cash', 'cashier');
  const safe = await mk('Office safe', 'cash', 'office');
  const gcash = await mk('GCash — cashier', 'ewallet', 'cashier');
  return { ...o, adminId, admin, drawer, safe, gcash };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Posts a plain balanced entry directly, bypassing every service.
 *
 * ⚠️ Deliberately raw: the overdraw guard reads the LEDGER, so proving it works means putting
 * money in by a route the guard knows nothing about. If it only ever saw money that arrived via
 * `createMoneyTransfer`, the test would be proving the service agrees with itself.
 */
async function postCash(f: Fixture, debitCode: string, creditCode: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-05', ${period!.id}, 'test', ${uid('src')}, 'draft') returning id
    `;
    let n = 0;
    for (const [code, dr, cr] of [
      [debitCode, amount, '0'],
      [creditCode, '0', amount],
    ] as const) {
      const [acct] = await tx<{ id: string }[]>`
        select id from accounts where org_id = ${f.orgId} and code = ${code}
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
        values (${e!.id}, ${++n}, ${acct!.id}, ${f.storeId}, ${dr}, ${cr})
      `;
    }
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

/**
 * Puts money into a 1140 wallet. ⚠️ Separate from `postCash` because `1140` is ONE control account
 * for every wallet — a line without a party belongs to no wallet in particular, and `balanceOf`
 * would not see it. This is the asymmetry ADR-010 §2 describes, showing up in a test fixture.
 */
async function fundWallet(f: Fixture, moneyAccountId: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} limit 1
  `;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, '2026-01-05', ${period!.id}, 'test', ${uid('src')}, 'draft') returning id
    `;
    const [wallet] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '1140'
    `;
    const [rev] = await tx<{ id: string }[]>`
      select id from accounts where org_id = ${f.orgId} and code = '4100'
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${wallet!.id}, ${f.storeId}, ${amount}, '0', 'money_account', ${moneyAccountId})
    `;
    await tx`
      insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${rev!.id}, ${f.storeId}, '0', ${amount})
    `;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

beforeAll(async () => {
  await sql`
    truncate table
      money_transfers, money_accounts, sales_day_tenders, sales_day_channels, sales_days,
      sales_channels, expense_payments, expenses, expense_categories,
      person_grants, person_store_scope, person_roles,
      journal_lines, journal_entries, audit_log, fiscal_periods, accounts,
      person_identities, persons, stores, organizations
    restart identity cascade
  `;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('the posting — POSTING-PATTERNS.md §Transfer', () => {
  it('transfer.cash.simple — drawer to safe, two legs, no party on either', async () => {
    const f = await fixture('simple');
    await postCash(f, '1110', '4100', '15000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.drawer.id,
        toMoneyAccountId: f.safe.id,
        amountOut: '15000.00',
        amountIn: '15000.00',
        transferDate: '2026-01-10',
      }),
    );
    expect(r.fee).toBe('0.00');

    const legs = await legsOf(r.entryId);
    expect(legs).toEqual([
      // 1110 cashier OUT, 1130 office IN. ⚠️ Neither carries a party: the GL code IS the
      // location for cash, so a party would be ceremony that resolves nothing.
      { code: '1110', debit: '0.00', credit: '15000.00', party_id: null },
      { code: '1130', debit: '15000.00', credit: '0.00', party_id: null },
    ]);
  });

  it('⭐ transfer.cash.with-fee — the THIRD leg, and it is a real expense', async () => {
    const f = await fixture('fee');
    await fundWallet(f, f.gcash.id, '10000.00');
    // ₱10,000 leaves the wallet, ₱9,950 reaches the safe. The ₱50 is a bank charge.
    const r = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.gcash.id,
        toMoneyAccountId: f.safe.id,
        amountOut: '10000.00',
        amountIn: '9950.00',
        transferDate: '2026-01-10',
        reference: 'GC-88213',
      }),
    );
    expect(r.fee).toBe('50.00');

    const legs = await legsOf(r.entryId);
    expect(legs).toEqual([
      // ⭐ The wallet leg carries the party — 1140 is ONE control account for every wallet, so
      // it is the only one of the four where the code cannot say which place moved.
      { code: '1140', debit: '0.00', credit: '10000.00', party_id: f.gcash.id },
      { code: '1130', debit: '9950.00', credit: '0.00', party_id: null },
      // ⚠️ Without this leg the entry would STILL BALANCE (9,950 out, 9,950 in) and the ₱50 would
      // vanish from the P&L in silence. That is the trap POSTING-PATTERNS §Transfer names.
      { code: '6870', debit: '50.00', credit: '0.00', party_id: null },
    ].sort((a, b) => a.code.localeCompare(b.code)));
  });

  it('⛔ no `fee` column exists — it is amount_out − amount_in', async () => {
    const cols = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'money_transfers' and column_name in ('fee', 'fee_amount', 'balance')
    `;
    expect(cols).toEqual([]);
  });
});

describe('the refusals — T-139 §5', () => {
  it('⛔ source and destination must differ', async () => {
    const f = await fixture('same');
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.drawer.id,
          toMoneyAccountId: f.drawer.id,
          amountOut: '100.00',
          amountIn: '100.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/different accounts/);
  });

  it('⛔ money cannot arrive that never left — that is income, not a transfer', async () => {
    const f = await fixture('income');
    await postCash(f, '1110', '4100', '200.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.drawer.id,
          toMoneyAccountId: f.safe.id,
          amountOut: '100.00',
          amountIn: '150.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/income, not a transfer/);
  });

  it('⛔ a retired account cannot be either end', async () => {
    const f = await fixture('retired');
    await sql`update money_accounts set is_active = false where id = ${f.gcash.id}`;
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.gcash.id,
          toMoneyAccountId: f.safe.id,
          amountOut: '100.00',
          amountIn: '100.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/retired and cannot be the source/);
  });

  it('⛔ an account in another org is not reachable', async () => {
    const mine = await fixture('mine');
    await postCash(mine, '1110', '4100', '200.00');
    const theirs = await fixture('theirs');
    await expect(
      asOrg(mine.orgId, (tx) =>
        createMoneyTransfer(tx, mine.admin, {
          fromMoneyAccountId: mine.drawer.id,
          toMoneyAccountId: theirs.safe.id,
          amountOut: '100.00',
          amountIn: '100.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/does not exist in this org/);
  });
});

describe('bible row 150 — transfer_funds is MANAGER level', () => {
  it('⭐ a manager can move money between accounts that already exist', async () => {
    const f = await fixture('mgr');
    await postCash(f, '1130', '4100', '2000.00');
    const managerId = await person(f.orgId, f.storeId, 'Manager', 'manager');
    // The distinction row 150 draws: this same manager may NOT create either account
    // (manage_chart_of_accounts, row 149), but moving money between them is recording, not
    // changing what the books can record against.
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, actor(f.orgId, managerId), {
          fromMoneyAccountId: f.safe.id,
          toMoneyAccountId: f.drawer.id,
          amountOut: '2000.00',
          amountIn: '2000.00',
          transferDate: '2026-01-10',
          notes: 'Petty cash top-up',
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('⛔ a staff member cannot', async () => {
    const f = await fixture('staff');
    const staffId = await person(f.orgId, f.storeId, 'Staff', 'staff');
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, actor(f.orgId, staffId), {
          fromMoneyAccountId: f.drawer.id,
          toMoneyAccountId: f.safe.id,
          amountOut: '100.00',
          amountIn: '100.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('the matrix agrees, and every role it says ✗ for is actually denied', () => {
    // Derived from the matrix rather than hand-listed, so a later change to row 150 cannot
    // leave this test asserting the old decision.
    const denied = ROLES.filter((r) => !CAPABILITY_MATRIX.transfer_funds[r]);
    expect(denied).toEqual(['staff']);
  });
});

describe('void — through reverseEntry, never a delete', () => {
  it('reverses the entry, marks the row, and leaves both entries in the ledger', async () => {
    const f = await fixture('void');
    await postCash(f, '1110', '4100', '500.00');
    const r = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.drawer.id,
        toMoneyAccountId: f.safe.id,
        amountOut: '500.00',
        amountIn: '500.00',
        transferDate: '2026-01-10',
      }),
    );

    const v = await asOrg(f.orgId, (tx) =>
      voidMoneyTransfer(tx, f.admin, { moneyTransferId: r.id, reason: 'Wrong drawer' }),
    );

    const [row] = await sql<{ status: string; void_reason: string }[]>`
      select status, void_reason from money_transfers where id = ${r.id}
    `;
    expect(row).toMatchObject({ status: 'voided', void_reason: 'Wrong drawer' });

    // ⭐ The original is still there. A reversal ADDS an entry; it never removes one.
    const reversalLegs = await legsOf(v.reversalEntryId);
    expect(reversalLegs).toEqual([
      { code: '1110', debit: '500.00', credit: '0.00', party_id: null },
      { code: '1130', debit: '0.00', credit: '500.00', party_id: null },
    ]);

    // And the two entries net to nothing, which is what "reversed" has to mean.
    const [net] = await sql<{ total: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as total
      from journal_lines jl join accounts a on a.id = jl.account_id
      where a.code = '1130' and jl.entry_id in (${r.entryId}, ${v.reversalEntryId})
    `;
    expect(net!.total).toBe('0.00');
  });

  it('⛔ refuses a second void, and refuses an empty reason', async () => {
    const f = await fixture('void2');
    await postCash(f, '1110', '4100', '500.00');
    const r = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.drawer.id,
        toMoneyAccountId: f.safe.id,
        amountOut: '500.00',
        amountIn: '500.00',
        transferDate: '2026-01-10',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        voidMoneyTransfer(tx, f.admin, { moneyTransferId: r.id, reason: '   ' }),
      ),
    ).rejects.toThrow(/reason is required/);

    await asOrg(f.orgId, (tx) =>
      voidMoneyTransfer(tx, f.admin, { moneyTransferId: r.id, reason: 'Duplicate' }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        voidMoneyTransfer(tx, f.admin, { moneyTransferId: r.id, reason: 'Again' }),
      ),
    ).rejects.toThrow(/already voided/);
  });
});

describe('⛔ overdrawing (Ian, 2026-08-26: "for transfer block overdraw")', () => {
  it('⭐ a CASHIER drawer is WARNED, not refused — the till holds what the ledger cannot see', async () => {
    const f = await fixture('overdraw');
    // The drawer reads ₱0 because today's sales are not verified yet. In the real world it is
    // full of cash. Refusing here would refuse a shortfall that is not real.
    const r = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.drawer.id,
        toMoneyAccountId: f.safe.id,
        amountOut: '5000.00',
        amountIn: '5000.00',
        transferDate: '2026-01-10',
      }),
    );
    expect(r.warning).toMatch(/short 5000\.00/);
    expect(r.warning).toMatch(/unverified/);

    // ⭐ And it really posted — the warning is information, not a soft failure.
    const legs = await legsOf(r.entryId);
    expect(legs).toHaveLength(2);
  });

  it('⛔ an OFFICE safe is REFUSED — nothing is waiting to be posted into it', async () => {
    const f = await fixture('officedraw');
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.safe.id,
          toMoneyAccountId: f.drawer.id,
          amountOut: '5000.00',
          amountIn: '5000.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/balance is complete/);

    // Fund the safe and the identical call succeeds, with nothing to warn about.
    await postCash(f, '1130', '4100', '5000.00');
    const r = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.safe.id,
        toMoneyAccountId: f.drawer.id,
        amountOut: '5000.00',
        amountIn: '5000.00',
        transferDate: '2026-01-10',
      }),
    );
    expect(r.warning).toBeUndefined();
  });

  it('the guard reads the LEDGER, so money arriving from anywhere counts', async () => {
    const f = await fixture('ledgerbal');
    // Not a transfer — a plain collection into the safe. The guard has no idea where money came
    // from, only what the account now holds, which is the point of deriving it.
    await postCash(f, '1130', '4100', '750.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.safe.id,
          toMoneyAccountId: f.drawer.id,
          amountOut: '750.01',
          amountIn: '750.01',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/holds 750\.00/);
  });

  it('a REVERSAL is not blocked, even when it overdraws the destination', async () => {
    const f = await fixture('reversedraw');
    await postCash(f, '1110', '4100', '1000.00');
    const t = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.drawer.id,
        toMoneyAccountId: f.safe.id,
        amountOut: '1000.00',
        amountIn: '1000.00',
        transferDate: '2026-01-10',
      }),
    );
    // The safe then spends it, so reversing takes out money that is no longer there.
    await postCash(f, '6160', '1130', '1000.00');

    // Still allowed. Refusing would leave a wrong entry with no way to correct it -- a
    // correction must always be possible, and the resulting negative is the signal to fix
    // whatever came after it.
    await expect(
      asOrg(f.orgId, (tx) =>
        voidMoneyTransfer(tx, f.admin, { moneyTransferId: t.id, reason: 'Recorded twice' }),
      ),
    ).resolves.toBeTruthy();
  });
});

describe('cross-store -- office to office only (Ian, 2026-08-26; bible row 152)', () => {
  async function secondStore(f: Fixture, code: string) {
    const [store] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${code}, ${'Store ' + code})
      returning id
    `;
    const mk = (name: string, custodian: 'cashier' | 'office') =>
      asOrg(f.orgId, (tx) =>
        createMoneyAccount(tx, f.admin, {
          storeId: store!.id,
          name,
          instrument: 'cash',
          custodian,
        }),
      );
    // ⭐ The actor is scoped into the second store. Bible row 153: a cross-store move needs
    // store access at BOTH ends, so a fixture that performs one must grant both — and the
    // denial test below proves the grant is doing real work.
    await sql`insert into person_store_scope (person_id, store_id) values (${f.adminId}, ${store!.id})`;
    return {
      id: store!.id,
      code,
      safe: await mk('Lipa office safe', 'office'),
      drawer: await mk('Lipa drawer', 'cashier'),
    };
  }

  it('⛔ REFUSES when the actor has no store scope at the far end (bible row 153)', async () => {
    const f = await fixture('noscope');
    const lipa = await secondStore(f, uid('LIPA'));
    await postCash(f, '1130', '4100', '5000.00');

    // A manager who answers for Malvar only. ⚠️ This is Ian's scenario from the other side:
    // without the far-end check, they could push Malvar's money into a store they have no
    // standing in, and Lipa would find money it never asked for and now owes for.
    const outsiderId = await person(f.orgId, f.storeId, 'Malvar-only manager', 'manager');
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, actor(f.orgId, outsiderId), {
          fromMoneyAccountId: f.safe.id,
          toMoneyAccountId: lipa.safe.id,
          amountOut: '5000.00',
          amountIn: '5000.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);

    // ⭐ Same person, same transfer, once they are scoped into Lipa too.
    await sql`insert into person_store_scope (person_id, store_id) values (${outsiderId}, ${lipa.id})`;
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, actor(f.orgId, outsiderId), {
          fromMoneyAccountId: f.safe.id,
          toMoneyAccountId: lipa.safe.id,
          amountOut: '5000.00',
          amountIn: '5000.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses a TILL at either end -- the bypass Ian named is unrepresentable', async () => {
    const f = await fixture('bypass');
    const lipa = await secondStore(f, uid('LIPA'));
    await postCash(f, '1110', '4100', '9000.00');
    await postCash(f, '1130', '4100', '9000.00');

    // Exactly the "deeply wrong" move: reaching into Malvar's till to spend at Lipa.
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.drawer.id,
          toMoneyAccountId: lipa.safe.id,
          amountOut: '9000.00',
          amountIn: '9000.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/office to office only/);

    // And landing in the other store's till is refused too -- it would skip the office on the
    // receiving side and leave the due-from/due-to pair sitting against a cashier.
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.safe.id,
          toMoneyAccountId: lipa.drawer.id,
          amountOut: '9000.00',
          amountIn: '9000.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/office to office only/);
  });

  it('office to office posts FOUR legs and eliminates', async () => {
    const f = await fixture('interstore');
    const lipa = await secondStore(f, uid('LIPA'));
    // Malvar's cashier has already remitted to Malvar's office -- the pattern Ian requires.
    await postCash(f, '1130', '4100', '20000.00');

    const r = await asOrg(f.orgId, (tx) =>
      createMoneyTransfer(tx, f.admin, {
        fromMoneyAccountId: f.safe.id,
        toMoneyAccountId: lipa.safe.id,
        amountOut: '20000.00',
        amountIn: '20000.00',
        transferDate: '2026-01-10',
        notes: 'Funding Lipa operations',
      }),
    );

    const legs = await sql<
      { code: string; debit: string; credit: string; party_id: string | null; store_id: string }[]
    >`
      select a.code, jl.debit::text, jl.credit::text, jl.party_id, jl.store_id::text
      from journal_lines jl join accounts a on a.id = jl.account_id
      where jl.entry_id = ${r.entryId} order by a.code, jl.debit desc
    `;

    // Four legs: cash out at Malvar, cash in at Lipa, and the reciprocal pair that lets each
    // store's own books balance on their own.
    expect(legs.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ['1130', '20000.00', '0.00'],
      ['1130', '0.00', '20000.00'],
      ['1250', '20000.00', '0.00'],
      ['2150', '0.00', '20000.00'],
    ]);

    // The store-party lines carry the OTHER store's CODE, not its id -- the convention the
    // commissary legs already use, so one reciprocal check covers both.
    const dueFrom = legs.find((l) => l.code === '1250')!;
    const dueTo = legs.find((l) => l.code === '2150')!;
    expect(dueFrom.party_id).toBe(lipa.code);
    expect(dueTo.party_id).toBe(f.storeCode);
    expect(dueFrom.store_id).toBe(f.storeId);
    expect(dueTo.store_id).toBe(lipa.id);

    // THE ELIMINATION -- bible invariant 6's reciprocal check. Total 1250 across every store
    // must equal total 2150. If they do not net, an inter-store movement went missing.
    const [recip] = await sql<{ due_from: string; due_to: string }[]>`
      select
        coalesce(sum(case when a.code = '1250' then jl.debit - jl.credit else 0 end), 0)::text as due_from,
        coalesce(sum(case when a.code = '2150' then jl.credit - jl.debit else 0 end), 0)::text as due_to
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a on a.id = jl.account_id
      where je.org_id = ${f.orgId} and je.status <> 'draft'
    `;
    expect(recip!.due_from).toBe('20000.00');
    expect(recip!.due_to).toBe(recip!.due_from);
  });
});
