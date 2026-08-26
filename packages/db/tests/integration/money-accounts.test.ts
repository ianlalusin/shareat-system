import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * ADR-010's model against a real PostgreSQL (bible §9 rule 3) — never a mock.
 *
 * ⭐ **The claim these tests exist to prove is that there is no second copy of the money.** Every
 * position figure is read from `journal_lines`; this table only says who holds each place. So the
 * central test is not "the balance column is right" — there is no balance column — it is that
 * the derived figure equals the ledger, and that `information_schema` confirms nothing was
 * quietly added to store it.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { seedChartOfAccounts } from '../../seed/chart-of-accounts';
import { CUTOVER_CLASSIFICATION } from '../../src/cutover/classification';
import { RLS_REGISTRY } from '../../src/rls/registry';
import { closeDb, moneyAccountsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

interface Fixture {
  orgId: string;
  storeId: string;
  storeId2: string;
  personId: string;
}

async function setup(hint: string): Promise<Fixture> {
  const code = uid(`ma-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')
  `;
  const mkStore = async (h: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgId}, ${uid(h)}, ${`Store ${h}`}) returning id
    `;
    return r!.id;
  };
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${`${hint} Staff`}) returning id
  `;
  return {
    orgId,
    storeId: await mkStore(`${hint}-s1`),
    storeId2: await mkStore(`${hint}-s2`),
    personId: p!.id,
  };
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

async function asOrgRaw<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${APP_ROLE}`);
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(tx)) as never;
  })) as T;
}

/** Posts a balanced entry straight through SQL. Deliberately NOT via postEntry — these tests are
 *  about how the money model READS the ledger, not about how entries get written.
 *
 *  ⚠️ Entry and lines must share ONE transaction. `journal_entries_balance_check` is a DEFERRABLE
 *  INITIALLY DEFERRED constraint trigger that fires at COMMIT, so inserting the header in its own
 *  statement commits an entry with zero lines and is refused — which is the trigger working, and
 *  is how the first version of this helper failed. */
async function postLegs(
  f: Fixture,
  entryDate: string,
  legs: { code: string; debit: string; credit: string; partyType?: string; partyId?: string }[],
) {
  const [period] = await sql<{ id: string }[]>`
    select id from fiscal_periods where org_id = ${f.orgId} limit 1
  `;
  return (await sql.begin(async (tx) => {
    const [entry] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status, memo)
      values (${f.orgId}, ${entryDate}, ${period!.id}, 'test', ${uid('src')}, 'draft', 'money model test')
      returning id
    `;
    let n = 0;
    for (const l of legs) {
      const [acct] = await tx<{ id: string }[]>`
        select id from accounts where org_id = ${f.orgId} and code = ${l.code}
      `;
      await tx`
        insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
        values (${entry!.id}, ${++n}, ${acct!.id}, ${f.storeId}, ${l.debit}, ${l.credit},
                ${l.partyType ?? null}, ${l.partyId ?? null})
      `;
    }
    await tx`update journal_entries set status = 'posted' where id = ${entry!.id}`;
    return entry!.id as never;
  })) as string;
}

beforeAll(async () => {
  await sql`
    truncate table
      money_accounts,
      fixed_assets, asset_category_lives, asset_policy,
      sales_day_channels, sales_days, sales_channels,
      expense_payments, expenses, expense_categories,
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

// =========================================================================================
// Invariant 1 — there is no stored balance, and there is nowhere to put one
// =========================================================================================

describe('invariant 1 — the money is only in the ledger', () => {
  it('⛔ money_accounts has no balance-shaped column', async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'money_accounts'
    `;
    const names = rows.map((r) => r.column_name);
    // ⭐ The strongest form: not "the balance is right" but "there is no balance to be wrong".
    for (const forbidden of ['balance', 'current_balance', 'total_debits', 'total_credits', 'amount']) {
      expect(names, `money_accounts must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// =========================================================================================
// Invariant 2 — the internal view is derived, and equals the ledger
// =========================================================================================

describe('invariant 2 — custodian positions are read from journal_lines', () => {
  it('attributes cash by GL code, with no party needed', async () => {
    const f = await setup('cash');
    // A sale: cash into the till.
    await postLegs(f, '2026-01-05', [
      { code: '1110', debit: '5000.00', credit: '0' },
      { code: '4100', debit: '0', credit: '5000.00' },
    ]);
    // Office pays a supplier from the safe.
    await postLegs(f, '2026-01-06', [
      { code: '6500', debit: '1200.00', credit: '0' },
      { code: '1130', debit: '0', credit: '1200.00' },
    ]);

    const rows = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.custodianPositions(tx, f.orgId, { asOf: '2026-01-31' }),
    );
    const byKey = new Map(rows.map((r) => [`${r.custodian}:${r.glAccountCode}`, Number(r.balance)]));
    expect(byKey.get('cashier:1110')).toBe(5000);
    expect(byKey.get('office:1130')).toBe(-1200);
  });

  it('⛔ ONLINE attribution is NOT enabled yet — 1140 still refuses a party', async () => {
    const f = await setup('online');
    const wallet = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.insertMoneyAccount(tx, {
        orgId: f.orgId,
        storeId: f.storeId,
        name: 'GCash — cashier',
        instrument: 'ewallet',
        glAccountCode: '1140',
        custodian: 'cashier',
      }),
    );

    // ⚠️ This is the CONTRACT step ADR-010 needs and this slice deliberately did not take.
    // `journal_lines_party_requirement` is bidirectional: it refuses a party on an account whose
    // `requires_party` is false, exactly as it refuses a missing one where it is true. So naming a
    // wallet is impossible until 1140 is flipped — and flipping it breaks BOTH shipped posting
    // sites (expenses/routing.ts and sales-days/routing.ts), the second of which has one
    // `online_collected` figure per day with no per-wallet breakdown to supply.
    //
    // ⭐ Pinned as a test rather than left as a comment, because this is the precise boundary of
    // what was built: the model exists and cash works; online waits for a task that reshapes
    // T-123's data, not for someone to remember.
    await expect(
      postLegs(f, '2026-01-07', [
        { code: '1140', debit: '3000.00', credit: '0', partyType: 'money_account', partyId: wallet.id },
        { code: '4100', debit: '0', credit: '3000.00' },
      ]),
    ).rejects.toThrow(/does not accept a party/);
  });

  it('a staff float is attributed to staff by its GL code (1120)', async () => {
    const f = await setup('float');
    // Office releases ₱2,000 to a staff member.
    await postLegs(f, '2026-01-09', [
      { code: '1120', debit: '2000.00', credit: '0' },
      { code: '1130', debit: '0', credit: '2000.00' },
    ]);
    const rows = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.custodianPositions(tx, f.orgId, { asOf: '2026-01-31' }),
    );
    const byKey = new Map(rows.map((r) => [`${r.custodian}:${r.glAccountCode}`, Number(r.balance)]));
    expect(byKey.get('staff:1120')).toBe(2000);
    expect(byKey.get('office:1130')).toBe(-2000);
  });

  it('ignores DRAFT entries and respects the as-of date', async () => {
    const f = await setup('asof');
    await postLegs(f, '2026-01-05', [
      { code: '1110', debit: '1000.00', credit: '0' },
      { code: '4100', debit: '0', credit: '1000.00' },
    ]);
    await postLegs(f, '2026-01-20', [
      { code: '1110', debit: '400.00', credit: '0' },
      { code: '4100', debit: '0', credit: '400.00' },
    ]);

    const mid = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.custodianPositions(tx, f.orgId, { asOf: '2026-01-10' }),
    );
    expect(Number(mid.find((r) => r.custodian === 'cashier')!.balance)).toBe(1000);

    const end = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.custodianPositions(tx, f.orgId, { asOf: '2026-01-31' }),
    );
    expect(Number(end.find((r) => r.custodian === 'cashier')!.balance)).toBe(1400);
  });
});

// =========================================================================================
// Invariant 3 — undeposited funds needs no account (bible row 143)
// =========================================================================================

describe('invariant 3 — undeposited funds is a GROUP BY, not an account', () => {
  it('⭐ equals the cashier custodian total, and excludes the office safe', async () => {
    const f = await setup('undep');
    // ₱6,000 cash in the till, not remitted.
    await postLegs(f, '2026-01-11', [
      { code: '1110', debit: '6000.00', credit: '0' },
      { code: '4100', debit: '0', credit: '6000.00' },
    ]);
    // The office safe holds far more — and it is NOT undeposited. This is the distinction the
    // figure exists to make: undeposited means "has not reached the office yet", not "is cash".
    await postLegs(f, '2026-01-11', [
      { code: '1130', debit: '90000.00', credit: '0' },
      { code: '3100', debit: '0', credit: '90000.00' },
    ]);
    // A staff float is out with staff, which is also not the cashier's undeposited money.
    await postLegs(f, '2026-01-11', [
      { code: '1120', debit: '2000.00', credit: '0' },
      { code: '1130', debit: '0', credit: '2000.00' },
    ]);

    const undeposited = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.undepositedFunds(tx, f.orgId, { asOf: '2026-01-31' }),
    );
    expect(undeposited).toBe('6000.00');

    // ⚠️ Once 1140 carries a wallet, a cashier-custodian wallet's balance joins this figure with
    // no change to `undepositedFunds` itself — the join is already written.
  });

  it('falls to zero once the cashier remits, with no separate account to clear', async () => {
    const f = await setup('remit');
    await postLegs(f, '2026-01-12', [
      { code: '1110', debit: '5000.00', credit: '0' },
      { code: '4100', debit: '0', credit: '5000.00' },
    ]);
    expect(
      await asOrg(f.orgId, (tx) => moneyAccountsRepo.undepositedFunds(tx, f.orgId, { asOf: '2026-01-31' })),
    ).toBe('5000.00');

    // The remittance: cashier out, office in. Two asset accounts, no P&L.
    await postLegs(f, '2026-01-13', [
      { code: '1130', debit: '5000.00', credit: '0' },
      { code: '1110', debit: '0', credit: '5000.00' },
    ]);
    expect(
      await asOrg(f.orgId, (tx) => moneyAccountsRepo.undepositedFunds(tx, f.orgId, { asOf: '2026-01-31' })),
    ).toBe('0.00');
  });
});

// =========================================================================================
// Invariant 4 — the table's own rules
// =========================================================================================

describe('invariant 4 — a money account must be a money location', () => {
  it('⛔ refuses a GL code outside the 11xx money range', async () => {
    const f = await setup('glguard');
    await expect(
      asOrg(f.orgId, (tx) =>
        moneyAccountsRepo.insertMoneyAccount(tx, {
          orgId: f.orgId,
          storeId: f.storeId,
          name: 'Revenue, somehow',
          instrument: 'bank',
          glAccountCode: '4100',
          custodian: 'office',
        }),
      ),
    ).rejects.toThrow(/money_accounts_gl_code_is_money_check/);
  });

  it('refuses a second account with the same name at one store, and allows it at another', async () => {
    const f = await setup('dupe');
    const mk = (storeId: string) =>
      asOrg(f.orgId, (tx) =>
        moneyAccountsRepo.insertMoneyAccount(tx, {
          orgId: f.orgId,
          storeId,
          name: 'GCash',
          instrument: 'ewallet',
          glAccountCode: '1140',
          custodian: 'cashier',
        }),
      );
    await mk(f.storeId);
    // Per ACCOUNT, not per provider (bible row 142) — two "GCash" rows at one branch is the exact
    // ambiguity this table removes, so they must be named apart.
    await expect(mk(f.storeId)).rejects.toThrow(/money_accounts_org_store_name_unique/);
    // A different branch's GCash is a different place, and is fine.
    await expect(mk(f.storeId2)).resolves.toBeTruthy();
  });

  it('retires rather than deletes, and refuses a second retire', async () => {
    const f = await setup('retire');
    const { id } = await asOrg(f.orgId, (tx) =>
      moneyAccountsRepo.insertMoneyAccount(tx, {
        orgId: f.orgId,
        storeId: f.storeId,
        name: 'Old wallet',
        instrument: 'ewallet',
        glAccountCode: '1140',
        custodian: 'cashier',
      }),
    );
    await asOrg(f.orgId, (tx) => moneyAccountsRepo.retireMoneyAccount(tx, f.orgId, id));

    // Gone from the default listing, still there for an audit.
    expect(await asOrg(f.orgId, (tx) => moneyAccountsRepo.listMoneyAccounts(tx, f.orgId, {}))).toHaveLength(0);
    expect(
      await asOrg(f.orgId, (tx) => moneyAccountsRepo.listMoneyAccounts(tx, f.orgId, { activeOnly: false })),
    ).toHaveLength(1);

    await expect(
      asOrg(f.orgId, (tx) => moneyAccountsRepo.retireMoneyAccount(tx, f.orgId, id)),
    ).rejects.toThrow(/already retired/);
  });
});

// =========================================================================================
// Wave 0 holds
// =========================================================================================

describe('Wave 0 holds for money_accounts', () => {
  it('is classified for cutover and registered for RLS', () => {
    expect(CUTOVER_CLASSIFICATION['money_accounts']).toBeDefined();
    expect(RLS_REGISTRY['money_accounts']).toBeDefined();
  });

  it('has RLS enabled AND forced', async () => {
    const [row] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = 'money_accounts'
    `;
    expect(row!.relrowsecurity).toBe(true);
    expect(row!.relforcerowsecurity).toBe(true);
  });

  it("⛔ one org cannot see another org's money accounts, with no WHERE clause at all", async () => {
    const a = await setup('isoA');
    const b = await setup('isoB');
    const mk = (f: Fixture) =>
      asOrg(f.orgId, (tx) =>
        moneyAccountsRepo.insertMoneyAccount(tx, {
          orgId: f.orgId,
          storeId: f.storeId,
          name: 'Wallet',
          instrument: 'ewallet',
          glAccountCode: '1140',
          custodian: 'cashier',
        }),
      );
    await mk(a);
    await mk(b);

    // Raw postgres.js — a query builder always writes SOME where clause, and the point is to
    // prove isolation with none.
    const seen = await asOrgRaw(a.orgId, async (tx) => {
      const rows = await tx<{ n: number }[]>`select count(*)::int as n from money_accounts`;
      return rows[0]!.n;
    });
    expect(seen).toBe(1);
  });
});
