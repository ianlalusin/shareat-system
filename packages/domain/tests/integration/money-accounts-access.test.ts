import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * Who may add an account to the books — bible row 149, and its interaction with the adminless
 * fallback from rows 115–116.
 *
 * > **Ian, 2026-08-26:** *"only admin can add accounts to the books — that must be the rule"*,
 * > then: *"now with that rule, confirm that in absence of admin account manager can do that — a
 * > rule we applied earlier in other session."*
 *
 * ⭐ **The confirmation is the point of this file.** The elevated set is DERIVED
 * (`ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` filters the matrix for admin-yes/manager-no), so a
 * newly admin-only capability enrols itself with no edit anywhere. This proves it actually
 * behaves that way end to end, rather than trusting that it should.
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
import {
  AuthorizationError,
  ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER,
  assignRole,
  type Actor,
} from '@shareat/auth';
import { createMoneyAccount, renameMoneyAccount, retireMoneyAccount } from '@shareat/domain';

const sql = postgres(url, { max: 5 });

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function newOrg(hint: string) {
  const code = uid(`ma-acc-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id
  `;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id
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

const wallet = (storeId: string, name = 'GCash — cashier') =>
  ({ storeId, name, instrument: 'ewallet', custodian: 'cashier' }) as const;

beforeAll(async () => {
  await sql`
    truncate table
      money_transfers, money_accounts, sales_day_tenders, sales_day_channels, sales_days, sales_channels,
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

describe('bible row 149 — only an admin may add an account to the books', () => {
  it('an admin can', async () => {
    const o = await newOrg('admin');
    const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
    await expect(
      asOrg(o.orgId, (tx) => createMoneyAccount(tx, actor(o.orgId, adminId), wallet(o.storeId))),
    ).resolves.toBeTruthy();
  });

  it('⛔ a MANAGER cannot, while the org has an admin', async () => {
    const o = await newOrg('mgr');
    await person(o.orgId, o.storeId, 'Admin', 'admin');
    const managerId = await person(o.orgId, o.storeId, 'Manager', 'manager');
    // A manager RECORDS transactions; only an admin changes what the books can record them
    // against. This is the half of row 149 that does the work.
    await expect(
      asOrg(o.orgId, (tx) => createMoneyAccount(tx, actor(o.orgId, managerId), wallet(o.storeId))),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⛔ a staff member cannot, ever', async () => {
    const o = await newOrg('staff');
    const staffId = await person(o.orgId, o.storeId, 'Staff', 'staff');
    await expect(
      asOrg(o.orgId, (tx) => createMoneyAccount(tx, actor(o.orgId, staffId), wallet(o.storeId))),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe('rows 115–116 — and in the ABSENCE of an admin, a manager can', () => {
  it('⭐ a manager APPOINTED into an admin-less org can add an account', async () => {
    const o = await newOrg('adminless');
    const managerId = await person(o.orgId, o.storeId, 'Lone Manager');

    // Appointed through the real path — the elevated grants are written AT GRANT TIME as stored
    // rows (row 115), never evaluated at check time.
    const result = await asOrg(o.orgId, (tx) =>
      assignRole(tx, { personId: managerId, orgId: o.orgId, role: 'manager', grantedBy: null }),
    );

    // ⭐ The capability enrolled itself. `ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER` is DERIVED from
    // the matrix (admin-yes, manager-no), so making `manage_chart_of_accounts` admin-only in row
    // 149 added it to this set with no edit to any list. Nobody had to remember.
    expect(result.elevatedGrants).toContain('manage_chart_of_accounts');
    expect([...ELEVATED_GRANTS_FOR_ADMINLESS_MANAGER]).toContain('manage_chart_of_accounts');

    // And it actually works, which is the part membership alone does not prove.
    await expect(
      asOrg(o.orgId, (tx) => createMoneyAccount(tx, actor(o.orgId, managerId), wallet(o.storeId))),
    ).resolves.toBeTruthy();
  });

  it('⚠️ but a SITTING manager does NOT gain it when the admin later leaves', async () => {
    const o = await newOrg('adminleft');
    const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
    const managerId = await person(o.orgId, o.storeId, 'Manager', 'manager');

    // The admin's role is revoked. The org now has no admin.
    await sql`update person_roles set revoked_at = now() where person_id = ${adminId}`;

    // ⛔ The manager still cannot. Row 116: "when an admin is removed, managers' access changes
    // ONLY if super-admin explicitly ticks it." Row 115's fallback is applied at GRANT time, so
    // it never fires for someone who was already sitting in the role.
    //
    // ⚠️ Pinned deliberately, because it is the half that surprises people: "in the absence of an
    // admin a manager can" is true of an APPOINTMENT, not of an org that has merely lost its
    // admin. Re-elevation is an explicit act, and that is the point — access that changes by
    // itself when somebody resigns is access nobody decided to give.
    await expect(
      asOrg(o.orgId, (tx) => createMoneyAccount(tx, actor(o.orgId, managerId), wallet(o.storeId))),
    ).rejects.toThrow(AuthorizationError);
  });
});

describe('⛔ an account holding money cannot be retired (Ian, 2026-08-26)', () => {
  it('refuses while the balance is non-zero, and allows it once transferred out', async () => {
    const o = await newOrg('retire');
    const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
    const a = actor(o.orgId, adminId);

    const { id } = await asOrg(o.orgId, (tx) =>
      createMoneyAccount(tx, a, {
        storeId: o.storeId,
        name: 'GCash — closing',
        instrument: 'ewallet',
        custodian: 'cashier',
      }),
    );

    // ₱4,000 collected into it.
    const [period] = await sql<{ id: string }[]>`
      insert into fiscal_periods (org_id, starts_on, ends_on, status)
      values (${o.orgId}, '2026-01-01', '2026-01-31', 'open') returning id
    `;
    const post = async (debitCode: string, creditCode: string, amount: string) => {
      await sql.begin(async (tx) => {
        const [e] = await tx<{ id: string }[]>`
          insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
          values (${o.orgId}, '2026-01-10', ${period!.id}, 'test', ${uid('src')}, 'draft') returning id
        `;
        let n = 0;
        for (const [code, dr, cr] of [[debitCode, amount, '0'], [creditCode, '0', amount]] as const) {
          const [acct] = await tx<{ id: string }[]>`
            select id from accounts where org_id = ${o.orgId} and code = ${code}
          `;
          const party = code === '1140' ? id : null;
          await tx`
            insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
            values (${e!.id}, ${++n}, ${acct!.id}, ${o.storeId}, ${dr}, ${cr},
                    ${party ? 'money_account' : null}, ${party})
          `;
        }
        await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
      });
    };
    await post('1140', '4100', '4000.00');

    // ⛔ Retiring would hide it from every picker, so nothing could ever transfer the ₱4,000 out.
    // A wallet is emptied first and retired second, never the other way round.
    await expect(
      asOrg(o.orgId, (tx) => retireMoneyAccount(tx, a, { moneyAccountId: id })),
    ).rejects.toThrow(/still holds 4000\.00/);

    // Move it to the office safe, and the same call now succeeds.
    await post('1130', '1140', '4000.00');
    await expect(
      asOrg(o.orgId, (tx) => retireMoneyAccount(tx, a, { moneyAccountId: id })),
    ).resolves.toBeUndefined();
  });
});

describe('⭐ the five every store must always have (bible row 156)', () => {
  /** The store's foundation account of one shape. */
  async function foundation(storeId: string, instrument: string, custodian: string) {
    const [row] = await sql<{ id: string; name: string }[]>`
      select id, name from money_accounts
      where store_id = ${storeId} and instrument = ${instrument}
        and custodian = ${custodian} and is_foundation
    `;
    return row;
  }

  it('⭐ a brand-new store is born with all five — nobody has to remember', async () => {
    const o = await newOrg('born');
    const rows = await sql<{ name: string; instrument: string; custodian: string; gl: string }[]>`
      select name, instrument, custodian, gl_account_code as gl from money_accounts
      where store_id = ${o.storeId} and is_foundation
      order by custodian, instrument
    `;
    // ⚠️ The store was inserted with a plain INSERT — no service, no seeder call. There is no
    // createStore path in this codebase, so the guarantee has to live in the database or it does
    // not exist. Since T-139 a cash payment must NAME an account, so a store without these
    // silently cannot record a cash expense at all.
    expect(rows).toEqual([
      { name: 'Cashier cash', instrument: 'cash', custodian: 'cashier', gl: '1110' },
      { name: 'Cashier online', instrument: 'ewallet', custodian: 'cashier', gl: '1140' },
      { name: 'Office cash', instrument: 'cash', custodian: 'office', gl: '1130' },
      { name: 'Office online', instrument: 'ewallet', custodian: 'office', gl: '1140' },
      { name: 'Staff float', instrument: 'cash', custodian: 'staff', gl: '1120' },
    ]);
  });

  it('⛔ none of the five can be retired while the store is trading', async () => {
    const o = await newOrg('unretirable');
    const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
    const till = await foundation(o.storeId, 'cash', 'cashier');

    // ⚠️ It holds ₱0, and that is exactly the case worth pinning: "it happens to be empty today"
    // is not permission to remove the place the day's takings go.
    await expect(
      asOrg(o.orgId, (tx) =>
        retireMoneyAccount(tx, actor(o.orgId, adminId), { moneyAccountId: till!.id }),
      ),
    ).rejects.toThrow(/every trading store must have/);
  });

  it('⭐ but the NAME is editable — that is what the flag is for', async () => {
    const o = await newOrg('rename');
    const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
    const till = await foundation(o.storeId, 'cash', 'cashier');

    // Ian: "cashier cash may be renamed to counter till, office cash may be office vault."
    await asOrg(o.orgId, (tx) =>
      renameMoneyAccount(tx, actor(o.orgId, adminId), {
        moneyAccountId: till!.id,
        name: 'Counter till',
      }),
    );
    const after = await foundation(o.storeId, 'cash', 'cashier');
    expect(after!.name).toBe('Counter till');
    // ⭐ Still foundational, still un-retirable. The name changed; what it IS did not.
    await expect(
      asOrg(o.orgId, (tx) =>
        retireMoneyAccount(tx, actor(o.orgId, adminId), { moneyAccountId: till!.id }),
      ),
    ).rejects.toThrow(/every trading store must have/);
  });

  it('⛔ a manager cannot rename one — it is the chart of accounts (row 149)', async () => {
    const o = await newOrg('renamedeny');
    await person(o.orgId, o.storeId, 'Admin', 'admin');
    const mgrId = await person(o.orgId, o.storeId, 'Manager', 'manager');
    const till = await foundation(o.storeId, 'cash', 'cashier');
    await expect(
      asOrg(o.orgId, (tx) =>
        renameMoneyAccount(tx, actor(o.orgId, mgrId), {
          moneyAccountId: till!.id,
          name: 'Whatever',
        }),
      ),
    ).rejects.toThrow(AuthorizationError);
  });

  it('⚠️ a SECOND wallet of the same shape is ordinary — and retirable', async () => {
    const o = await newOrg('second');
    const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
    const a = actor(o.orgId, adminId);

    // ⭐ This is why `is_foundation` is a FLAG and not an inference from instrument + custodian:
    // nothing about this account's shape distinguishes it from the seeded one.
    const extra = await asOrg(o.orgId, (tx) =>
      createMoneyAccount(tx, a, {
        storeId: o.storeId,
        name: 'GCash — second wallet',
        instrument: 'ewallet',
        custodian: 'cashier',
      }),
    );
    await expect(
      asOrg(o.orgId, (tx) => retireMoneyAccount(tx, a, { moneyAccountId: extra.id })),
    ).resolves.toBeUndefined();
  });

  it('⚠️ a second CASH location is still refused — the GL code IS the location', async () => {
    const o = await newOrg('secondcash');
    const adminId = await person(o.orgId, o.storeId, 'Admin', 'admin');
    // 1110 carries no party, so two cashier-cash accounts at one store could never be told apart
    // in the ledger. The foundation one is the store's till, and there is only one till.
    await expect(
      asOrg(o.orgId, (tx) =>
        createMoneyAccount(tx, actor(o.orgId, adminId), {
          storeId: o.storeId,
          name: 'Second drawer',
          instrument: 'cash',
          custodian: 'cashier',
        }),
      ),
    ).rejects.toThrow(/already has a cashier cash location/);
  });
});
