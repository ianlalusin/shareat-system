import { config } from 'dotenv';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-500 (TESTER) H6-H8 - Padre Garcia (created by the real onboardFranchiseOrganization from the MOCK file): leave decisions and rate isolation.
 * (M1-M4 + H5 live in apps/erp/tests/integration/t500-pg-rates-page.test.ts: they drive the rates-page actions.)
 *
 * H6  PG staff leave decided by PG's owner (store-scoped manager)            GREEN-AS-GUARD today. Kills: a guard that demands super-admin for everyone.
 * H7  an admin holding every super-admin grant approves their own leave      RED today. Kills: isSuperAdmin keeps the role-literal check.
 *     (allowed + audited leave.self_approved); a plain admin is still refused LEAVE_OWN_APPROVAL (guard).
 * H8  isolation: PG's admin adds a rate; Ian's org rows unchanged; PG cannot read Ian's rates through RLS     GREEN-AS-GUARD.
 *     Kills: a write that takes the franchisor org id; a read policy that leaks across companies.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { closeDb } from '@shareat/db';
import { SUPER_ADMIN_ONLY_CAPABILITIES } from '@shareat/auth';
import { addStatutoryRate, approveLeave, requestLeave } from '@shareat/domain';
import { asOrg, mkPg, tag, type Pg } from './_fixtures/t500-pg';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const day = (date: string) => ({ date, kind: 'leave' as const });
const request = (pg: Pg, who: { personId: string; orgId: string }, employmentId: string, date: string) =>
  asOrg(pg.pgOrgId, (tx) => requestLeave(tx, who, { employmentId, leaveType: 'sick', days: [day(date)] } as never)) as Promise<{ requestId: string }>;
const approve = (pg: Pg, who: { personId: string; orgId: string }, requestId: string) =>
  asOrg(pg.pgOrgId, (tx) => approveLeave(tx, who, { requestId } as never));
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from leave_requests where id = ${id}`)[0]!.status;
const auditActions = async (orgId: string, entityId: string) =>
  (await sql<{ action: string }[]>`select action from audit_log where org_id = ${orgId} and entity_id = ${entityId} order by recorded_at, id`).map((r) => r.action);

/** A job at the PG store for the given person (the admin has no employment after onboarding). */
async function giveJob(pg: Pg, personId: string): Promise<string> {
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, person_id, store_id, staff_code, started_on, employment_status, created_by)
    values (${pg.pgOrgId}, ${personId}, ${pg.storeId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, '2026-01-01', 'regular', ${pg.pgAdminId}) returning id`;
  return e!.id;
}
const FUTURE = () => `${new Date().getUTCFullYear() + 1}-03-02`;

describe('H6 - PG staff leave decided by PG owner (manager)', () => {
  it('the owner (store-scoped manager, no employment) approves a staff member\'s leave', async () => {
    const pg = await mkPg(sql);
    const r = await request(pg, pg.worker, pg.employmentId, FUTURE());
    expect(await statusOf(r.requestId)).toBe('pending');
    await approve(pg, pg.owner, r.requestId);
    expect(await statusOf(r.requestId)).toBe('approved');
  });
});

describe('H7 - an admin holding every super-admin grant may approve their own leave', () => {
  it('allowed and audited leave.self_approved; a plain admin without the grants is still refused LEAVE_OWN_APPROVAL', async () => {
    expect(SUPER_ADMIN_ONLY_CAPABILITIES.length, 'there are super-admin-only capabilities to hold').toBeGreaterThan(0);
    const pg = await mkPg(sql);
    // two fresh admins at the PG store (Ian's PG person may already hold grants from onboarding, so do not reuse it)
    const mkAdmin = async (name: string) => {
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${pg.pgOrgId}, ${`${name} ${tag()}`}) returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${pg.pgOrgId}, 'admin')`;
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${pg.storeId})`;
      return { id: p!.id, who: { personId: p!.id, orgId: pg.pgOrgId }, job: await giveJob(pg, p!.id) };
    };
    const plainAdmin = await mkAdmin('Plain Admin');
    const superish = await mkAdmin('Admin With Every Grant');

    // plain admin: refused (control)
    const plain = await request(pg, plainAdmin.who, plainAdmin.job, FUTURE());
    const refusal = await approve(pg, plainAdmin.who, plain.requestId).then(() => null, (e: { code?: string }) => e);
    expect(refusal?.code, 'a plain admin cannot approve their own leave').toBe('LEAVE_OWN_APPROVAL');
    expect(await statusOf(plain.requestId)).toBe('pending');

    // admin + every super-admin-only capability as a grant row
    for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
      await sql`insert into person_grants (person_id, grant_name) values (${superish.id}, ${cap})`;
    }
    const mine = await request(pg, superish.who, superish.job, FUTURE());
    await approve(pg, superish.who, mine.requestId);
    expect(await statusOf(mine.requestId)).toBe('approved');
    expect(await auditActions(pg.pgOrgId, mine.requestId)).toContain('leave.self_approved');
  });
});

describe('H8 - isolation between Ian\'s company and PG', () => {
  it('PG admin adds a rate: it lands in PG; Ian\'s rows are unchanged; PG cannot read Ian\'s rates (RLS)', async () => {
    const pg = await mkPg(sql);
    const t = tag();
    await sql`insert into statutory_rates (org_id, agency, effective_from, ee_rate, er_rate, base_kind, floor, ceiling, source_ref, confirmed_at, confirmed_by)
              values (${pg.franchisor.orgId}, 'sss', '2026-01-01', '0.05', '0.10', 'gross', '5000', '35000', ${`IAN-${t}`}, now(), ${pg.franchisor.adminId})`;
    const ianBefore = JSON.stringify(await sql`select * from statutory_rates where org_id = ${pg.franchisor.orgId} order by id`);

    const added = await asOrg(pg.pgOrgId, (tx) =>
      addStatutoryRate(tx, pg.pgAdmin, { agency: 'sss', effectiveFrom: '2026-01-01', eeRate: '0.05', erRate: '0.10', baseKind: 'gross', floor: '5000', ceiling: '35000', sourceRef: `PG-${t}` }));
    const [row] = await sql<{ org_id: string }[]>`select org_id from statutory_rates where id = ${added.id}`;
    expect(row!.org_id, 'the new row is PG\'s').toBe(pg.pgOrgId);
    expect(JSON.stringify(await sql`select * from statutory_rates where org_id = ${pg.franchisor.orgId} order by id`), 'Ian\'s rates unchanged').toBe(ianBefore);

    const seen = await asOrg(pg.pgOrgId, async (tx) => (await tx.execute(dsql`select org_id, source_ref from statutory_rates`)) as unknown as { org_id: string; source_ref: string }[]);
    const rows = Array.from(seen);
    expect(rows.length, 'PG sees its own row').toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === pg.pgOrgId), 'PG sees no row of Ian\'s org').toBe(true);
    expect(rows.some((r) => r.source_ref === `IAN-${t}`)).toBe(false);
  });
});
