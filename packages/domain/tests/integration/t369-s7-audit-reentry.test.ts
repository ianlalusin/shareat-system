import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, APP_ROLE, salesDaysRepo, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import * as D from '@shareat/domain';
import { submitThenVerify } from './_fixtures/sales-day-flow';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DATE = '2026-01-10';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

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
  const code = uid(`t369s7-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('lipa')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const staffId = await mk('Staff', 'staff');
  const managerId = await mk('Manager', 'manager');
  const [channel] = await sql<{ id: string }[]>`insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });
  return { orgId, storeId, channelId: channel!.id, staff: actor(orgId, staffId), manager: actor(orgId, managerId) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const figures = (f: Fixture) => ({
  totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00', channels: [{ channelId: f.channelId, amount: '1000.00' }],
});
const create = (f: Fixture, who: Actor, date = DATE) => asOrg(f.orgId, (tx) => D.createSalesDay(tx, who, { storeId: f.storeId, businessDate: date, ...figures(f) }));
const withdraw = (f: Fixture, id: string) => asOrg(f.orgId, (tx) => D.voidSalesDay(tx, f.manager, id, 'Typed wrong'));
const rowsOn = (f: Fixture, date = DATE) => sql<{ id: string; status: string }[]>`select id, status from sales_days where org_id = ${f.orgId} and store_id = ${f.storeId} and business_date = ${date} order by created_at`;

async function rejection(p: Promise<unknown>, what: string): Promise<{ message: string; userMessage?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; userMessage?: string };
    return { message: String(e.message ?? err), userMessage: e.userMessage };
  }
  throw new Error(`NOT REFUSED — ${what} succeeded instead (the defect this leg targets)`);
}


/**
 * T-369 S7 AUDIT legs A and D (orchestrator, 2026-10-01). Leg B (wastage sentence) and C (concurrent re-entry sentence)
 * need the server-action layer and live in `apps/erp/tests/integration/t369-s7-audit-web.test.ts`.
 *
 *   A. A VERIFIED day withdrawn while a POSTED remittance allocation sits on its store+date: re-entering that date is
 *      refused with "Cash handed over has been counted against this date. Reverse that handover first." (no ids), and
 *      writes nothing. Controls: once that remittance is reversed the re-entry succeeds; ANOTHER store's handover on the
 *      same date does not block. The allocation is inserted by SQL (the rule reads `remittance_allocations` joined to a
 *      `posted` remittance), and the "reverse" control flips the remittance row the way `reverseRemittance` does
 *      (status/reversed_on/reverse_reason) so the leg does not depend on a funded till.
 *   D. `getPosDayReconciliation` over a withdrawn date reads as "no ledger day" and does not throw (pin; may be green).
 */
async function postedHandover(f: Fixture, storeId: string, date: string, salesDayId: string | null) {
  const [r] = await sql<{ id: string }[]>`
    insert into remittances (org_id, store_id, remitted_on, accepted_by, created_by)
    values (${f.orgId}, ${storeId}, ${date}, ${f.manager.personId}, ${f.manager.personId}) returning id`;
  await sql`
    insert into remittance_allocations (remittance_id, business_date, sales_day_id, amount, source)
    values (${r!.id}, ${date}, ${salesDayId}, '1000.00', 'cash')`;
  return r!.id;
}
const reverseRow = (id: string) =>
  sql`update remittances set status = 'reversed', reversed_on = ${DATE}, reverse_reason = 'fixture reversal' where id = ${id}`;
const SENTENCE = 'Cash handed over has been counted against this date. Reverse that handover first.';

describe('S7 audit A — a posted handover counted against the date blocks re-entering it', () => {
  it('manager re-entry is refused with the handover sentence (no id), nothing is written; reversing the handover lets the SAME re-entry succeed', async () => {
    const f = await fixture('auditA');
    const { id: first } = await create(f, f.staff);
    await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.manager, first, f.staff));
    const remittanceId = await postedHandover(f, f.storeId, DATE, first);
    await withdraw(f, first);

    const refused = await rejection(create(f, f.manager), 'a manager re-entering a date that has a posted handover');
    expect(refused.userMessage, `raw text leaked: ${refused.message}`).toBe(SENTENCE);
    expect(refused.userMessage ?? '').not.toMatch(UUID);
    expect((await rowsOn(f)).map((r) => r.status), 'the refused create left a row behind').toEqual(['voided']);

    await reverseRow(remittanceId);
    const { id: second } = await create(f, f.manager);
    expect(second).not.toBe(first);
    expect((await rowsOn(f)).map((r) => r.status).sort()).toEqual(['open', 'voided']);
  });

  it("another store's handover on the same date does NOT block this store's re-entry (control: the rule is per store+date)", async () => {
    const f = await fixture('auditA-other');
    const [other] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${f.orgId}, ${uid('malvar')}, 'Malvar') returning id`;
    await postedHandover(f, other!.id, DATE, null);
    const { id: first } = await create(f, f.staff);
    await withdraw(f, first);
    const { id: second } = await create(f, f.manager);
    expect(second).not.toBe(first);
  });
});

describe('S7 audit D — the POS reconciliation over a withdrawn date', () => {
  it('reads as "no ledger day" (exists:false) and does not throw; once the date is re-entered it reads the new day', async () => {
    const f = await fixture('auditD');
    const { id: first } = await create(f, f.staff);
    await withdraw(f, first);
    const recon = () =>
      asOrg(f.orgId, (tx) => D.getPosDayReconciliation(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: DATE }));

    const over = await recon();
    expect(over.ledger, 'a withdrawn day was read as the date\'s ledger day').toEqual({ exists: false });
    expect(over.delta).toBeNull();
    expect(over.matches).toBeNull();

    const { id: second } = await create(f, f.manager);
    const again = await recon();
    expect(again.ledger.exists).toBe(true);
    if (again.ledger.exists) expect(again.ledger.status).toBe('open');
    expect(second).not.toBe(first);
  });
});
