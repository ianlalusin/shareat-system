/**
 * T-593 / DEF-870 - the till screen's charge action, through the real domain.
 * A count line charged to one person, then to another: the second is refused with the shared sentence plus a pointer to
 * where the first charge can be seen, and the refusal names neither person.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { transaction, tillShiftsRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { closeTillShift, openTillShift, recordTillCount } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function redirectOf(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

async function person(orgId: string, storeId: string, name: string, role: string) {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

describe('DEF-870 - chargeShortageAction on a count line that is already charged', () => {
  it('the second person is refused: the shared sentence, the pointer, and no names', async () => {
    const code = uid('t593till');
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;
    await seedChartOfAccounts(sql, orgId);
    const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('t593')}, 'Store t593') returning id`;
    const storeId = store!.id;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
    const adminId = await person(orgId, storeId, 'Admin Anna', 'admin');
    const firstId = await person(orgId, storeId, 'Cashier Carla', 'staff');
    const secondId = await person(orgId, storeId, 'Cashier Dante', 'staff');
    const admin = actor(orgId, adminId);
    const [drawer] = await sql<{ id: string }[]>`
      select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'cashier' and is_foundation`;

    // 10,000.00 in the till, counted 9,850.00: a 150.00 shortage.
    const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${orgId} limit 1`;
    await sql.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
        values (${orgId}, '2026-01-06', ${period!.id}, 'sale', ${uid('src')}, 'draft') returning id`;
      const [cash] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '1110'`;
      const [rev] = await tx<{ id: string }[]>`select id from accounts where org_id = ${orgId} and code = '4100'`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${cash!.id}, ${storeId}, '10000.00', '0')`;
      await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${rev!.id}, ${storeId}, '0', '10000.00')`;
      await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
    });
    const { shiftId } = await asOrg(orgId, (tx) => openTillShift(tx, admin, { storeId, businessDate: '2026-01-06' }));
    await asOrg(orgId, (tx) => recordTillCount(tx, admin, { shiftId, moment: 'close', counts: [{ moneyAccountId: drawer!.id, counted: '9850.00' }] }));
    await asOrg(orgId, (tx) => closeTillShift(tx, admin, { shiftId }));
    const [line] = await asOrg(orgId, (tx) => tillShiftsRepo.countsFor(tx, shiftId));

    ACTOR_HOLDER.actor = admin;
    const { chargeShortageAction } = await import('../../src/app/till/actions');
    const form = (personId: string) => {
      const fd = new FormData();
      fd.set('storeId', storeId);
      fd.set('countLineId', line!.id);
      fd.set('personId', personId);
      return fd;
    };
    const first = await redirectOf(() => chargeShortageAction(form(firstId)));
    expect(paramsOf(first).get('error')).toBeNull();
    const second = await redirectOf(() => chargeShortageAction(form(secondId)));
    const error = paramsOf(second).get('error') ?? '';
    expect(error.endsWith('Open the count to see who was charged.')).toBe(true);
    expect(error).not.toContain('Carla');
    expect(error).not.toContain('Dante');
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entries where org_id = ${orgId} and source_type = 'tillcountshortage'`;
    expect(Number(row!.n)).toBe(1);
  });
});
