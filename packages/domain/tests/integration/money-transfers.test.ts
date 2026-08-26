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
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
  `;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${org!.id}, '2026-01-01', '2026-01-31', 'open')
  `;
  return { orgId: org!.id, storeId: store!.id };
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

  it('⛔ both ends must be at the same store — cross-store has to eliminate', async () => {
    const f = await fixture('crossstore');
    const [other] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('other')}, 'Other store')
      returning id
    `;
    const far = await asOrg(f.orgId, (tx) =>
      createMoneyAccount(tx, f.admin, {
        storeId: other!.id,
        name: 'Other office safe',
        instrument: 'cash',
        custodian: 'office',
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        createMoneyTransfer(tx, f.admin, {
          fromMoneyAccountId: f.drawer.id,
          toMoneyAccountId: far.id,
          amountOut: '100.00',
          amountIn: '100.00',
          transferDate: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/same store/);
  });

  it('⛔ an account in another org is not reachable', async () => {
    const mine = await fixture('mine');
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
