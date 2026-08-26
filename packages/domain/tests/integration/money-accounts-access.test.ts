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
import { createMoneyAccount } from '@shareat/domain';

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
      money_accounts, sales_day_tenders, sales_day_channels, sales_days, sales_channels,
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
