import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-521 - an agreement's per-payroll limit holds across ONE person's payslips in one run (fifty-third pass leftover).
 * docs/tasks/521-deduction-limit-per-run.md. Two employments of one person (a rehire, same store) = two payslips in one run.
 * Agreement A (1,000 owed, limit 100), B (1,000 owed, limit 900). The slip that is posted FIRST has a tiny gross, so it recovers
 * far less than the agreed 1,000; the second slip must not give A its limit a second time.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedStatutoryRates } from './_fixtures/statutory-rates';
import { agree, chargeEntry } from './_fixtures/t519-agreements';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { postPayRun, seedAttendanceConfig, seedCanonicalPositions } from '@shareat/domain';

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

async function fixture(hint: string) {
  const code = uid(`t521-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
            select ${orgId}::uuid, d::date, (d + interval '1 month' - interval '1 day')::date, 'open'
            from generate_series('2025-01-01'::date, '2027-12-01'::date, '1 month') d`;
  await asOrg(orgId, (tx) => seedCanonicalPositions(tx, orgId));
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('A')}, 'Store A') returning id`;
  const storeId = s!.id;
  await asOrg(orgId, (tx) => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2025-01-01' }));
  const [office] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  await seedStatutoryRates(orgId, actor(orgId, adminId), [storeId], '645.00');
  const workerId = await mk('Worker', 'staff');
  // The run orders one person's slips by employment id, so the ids are chosen here: `first` sorts before `second`.
  const [first, second] = [randomUUID(), randomUUID()].sort((a, b) => a.localeCompare(b)) as [string, string];
  const emp = async (id: string, startedOn: string, endedOn: string | null, rate: string) => {
    await sql`
      insert into employments (id, org_id, person_id, store_id, staff_code, started_on, ended_on, employment_status, created_by)
      values (${id}, ${orgId}, ${workerId}, ${storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, ${startedOn}, ${endedOn}, ${endedOn ? 'resigned' : 'regular'}, ${adminId})`;
    await sql`insert into pay_rates (org_id, employment_id, basis, amount, effective_from, created_by)
              values (${orgId}, ${id}, 'daily', ${rate}, ${startedOn}, ${adminId})`;
  };
  const [cfg] = await sql<{ id: string }[]>`select id from store_attendance_config where store_id = ${storeId} order by effective_from desc limit 1`;
  const day = (employmentId: string, shiftDay: string) => sql`
    insert into attendance_days (org_id, store_id, person_id, employment_id, shift_day, attendance_config_id, anchor_mode, status, computed_minutes)
    values (${orgId}, ${storeId}, ${workerId}, ${employmentId}, ${shiftDay}, ${cfg!.id}, 'exact', 'verified', 540)`;
  return { orgId, storeId, officeId: office!.id, adminId, workerId, first, second, emp, day, admin: actor(orgId, adminId) };
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-521 - per-payroll limit is per agreement per run, not per payslip', () => {
  it('slip 1 (gross 50) recovers little; slip 2 must not give agreement A (limit 100) its limit again', async () => {
    const f = await fixture('two');
    await f.emp(f.first, '2025-01-01', '2026-01-10', '50.00'); // posted first, tiny gross
    await f.emp(f.second, '2026-01-11', null, '1000.00');
    await f.day(f.first, '2026-01-05');
    // 5 x 1,000.00 + 50.00 = 5,050.00 combined gross, so the 20% wage cap (1,010.00) is above the agreed 1,000.00
    for (const d of ['2026-01-11', '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15']) await f.day(f.second, d);
    const c1 = await chargeEntry(sql, f, f.workerId, '1000.00', 'tillcountshortage');
    const c2 = await chargeEntry(sql, f, f.workerId, '1000.00', 'trade_discrepancy');
    const a = await agree(sql, f, f.admin, f.workerId, c1, { amount: '1000.00', perPayrollLimit: '100.00' });
    const b = await agree(sql, f, f.admin, f.workerId, c2, { amount: '1000.00', perPayrollLimit: '900.00' });

    await asOrg(f.orgId, (tx) =>
      postPayRun(tx, f.admin, { storeId: f.storeId, periodStart: '2026-01-01', periodEnd: '2026-01-15', moneyAccountId: f.officeId }));

    const slips = await sql<{ employment_id: string; advance_recovered: string }[]>`
      select employment_id, advance_recovered::text from payslips where org_id = ${f.orgId}`;
    const slip = (id: string) => Number(slips.find((s) => s.employment_id === id)!.advance_recovered);
    expect(slip(f.first), 'the small slip recovers something, but less than A\'s 100.00 limit').toBeGreaterThan(0);
    expect(slip(f.first)).toBeLessThan(100);

    const rows = await sql<{ agreement_id: string; amount: string }[]>`
      select agreement_id, sum(amount)::text as amount from staff_deduction_recoveries where org_id = ${f.orgId} group by agreement_id`;
    const of = (id: string) => Number(rows.find((r) => r.agreement_id === id)?.amount ?? '0');
    expect(of(a.id), 'A never recovers more than its signed 100.00 in one run').toBeLessThanOrEqual(100);
    expect(of(b.id)).toBeLessThanOrEqual(900);
    expect(of(a.id) + of(b.id), 'the whole agreed 1,000.00 is still recovered').toBe(1000);
  });
});
