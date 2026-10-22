import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-366 S2 (DEF-105 regression, C9) — `chargeTillShortage` (`packages/domain/src/till/index.ts:
 * 273-343`) is being rewired to call the new shared `postStaffShortageCharge` helper
 * (`packages/domain/src/shared/staff-shortage-charge.ts`) that the remittance charge (C1-C8) also
 * calls. This file pins the till's posted shape byte-identical, captured from HEAD before the
 * build: `Dr 1230 {employee, personId} / Cr <line's own account>`, `sourceType
 * 'tillcountshortage'`, `sourceId = countLineId`, `idempotencyKey 'tillcount:<countLineId>:
 * shortage'`. Fixture copied from `till-custody.test.ts` (`fixture`, `tillMovement`,
 * `grantEverydayPositionAccess`).
 *
 * ⛔ TESTER, not BUILDER. Green today (this is what HEAD already does); must STAY green once the
 * extraction lands — a value that changes here is the regression DEF-105 exists to catch.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, tillShiftsRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { chargeTillShortage, closeTillShift, openTillShift, recordTillCount } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function person(orgId: string, storeId: string, name: string, role?: string) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
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

async function fixture(hint: string) {
  const code = uid(`till-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  await seedChartOfAccounts(sql, org!.id);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org!.id}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${org!.id}, '2026-01-01', '2026-01-31', 'open')`;
  const orgId = org!.id;
  const storeId = store!.id;
  const adminId = await person(orgId, storeId, 'Admin', 'admin');
  const cashierId = await person(orgId, storeId, 'Cashier', 'staff');
  const [drawer] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [cashierEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${cashierId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: cashierEmployment!.id, personId: cashierId, setBy: adminId });
  return { orgId, storeId, adminId, cashierId, admin: actor(orgId, adminId), cashier: actor(orgId, cashierId), drawer: drawer!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function tillMovement(f: Fixture, date: string, amount: string) {
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} limit 1`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
    const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '1110'`;
    const [rev] = await tx<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = '4100'`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${f.storeId}, ${amount}, '0')`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${rev!.id}, ${f.storeId}, '0', ${amount})`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
}

describe('C9 (DEF-105 regression) — chargeTillShortage posts the same lines before and after the extraction', () => {
  it('Dr 1230 {employee, cashierId} 150.00 / Cr 1110 150.00, source_type tillcountshortage, idempotencyKey tillcount:<lineId>:shortage', async () => {
    const f = await fixture('c9');
    await tillMovement(f, '2026-01-06', '10000.00');

    const { shiftId } = await asOrg(f.orgId, (tx) => openTillShift(tx, f.admin, { storeId: f.storeId, businessDate: '2026-01-06' }));
    await asOrg(f.orgId, (tx) => recordTillCount(tx, f.admin, { shiftId, moment: 'close', counts: [{ moneyAccountId: f.drawer, counted: '9850.00' }] }));
    await asOrg(f.orgId, (tx) => closeTillShift(tx, f.admin, { shiftId }));

    const [line] = await asOrg(f.orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));
    expect(line!.variance).toBe('-150.00');

    const out = await asOrg(f.orgId, (tx) => chargeTillShortage(tx, f.admin, { countLineId: line!.id, personId: f.cashierId }));
    expect(out.posted).toBe(true);

    const legs = await sql<{ code: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]>`
      select a.code, l.debit, l.credit, l.party_type, l.party_id
      from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
      where e.org_id = ${f.orgId} and e.source_type = 'tillcountshortage' order by a.code`;
    expect(legs.map((l) => l.code)).toEqual(['1110', '1230']);
    expect(legs[0]!.credit).toBe('150.00');
    expect(legs[0]!.party_type).toBeNull();
    expect(legs[1]!.debit).toBe('150.00');
    expect(legs[1]!.party_type).toBe('employee');
    expect(legs[1]!.party_id).toBe(f.cashierId);

    const [entry] = await sql<{ source_id: string; idempotency_key: string }[]>`
      select source_id, idempotency_key from journal_entries where org_id = ${f.orgId} and source_type = 'tillcountshortage'`;
    expect(entry!.source_id).toBe(line!.id);
    expect(entry!.idempotency_key).toBe(`tillcount:${line!.id}:shortage`);
  });
});
