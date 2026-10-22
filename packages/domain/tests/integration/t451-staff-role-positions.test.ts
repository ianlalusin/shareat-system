import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { accessRepo, closeDb, employmentRepo } from '@shareat/db';
import { can } from '@shareat/auth';
import { createEmployment, setEmploymentPositions } from '@shareat/domain';
import { asOrg, fixture, uid } from './_fixtures/t433-b2b';
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url || !/shareat_test|_test(\?|$)/.test(url)) throw new Error('A test PostgreSQL database is required.');
const sql = postgres(url, { max: 5 });
afterAll(async () => { await closeDb(); await sql.end({ timeout: 5 }); });
async function roleFixture(hint: string) {
  const f = await fixture(sql, hint);
  await asOrg(f.orgId, tx => employmentRepo.seedCanonical(tx, f.orgId));
  // The broader trade fixture uses timestamp staff codes; hiring exercises the real sequence allocator.
  await sql`update employments set staff_code='SE-001' where person_id=${f.staff.personId} and store_id=${f.storeId}`;
  await sql`update employments set staff_code='SE-002' where person_id=${f.collector.personId} and store_id=${f.storeId}`;
  return f;
}

describe('T-451 privileged roles do not require staff positions', () => {
  it.each(['manager', 'admin', 'super_admin'] as const)('%s can clear legacy assignments without changing role authority', async role => {
    const f = await roleFixture(`451-clear-${role}`);
    const target = role === 'manager' ? f.manager : role === 'admin' ? f.admin : f.superAdmin;
    const [emp] = await sql`insert into employments (org_id,store_id,person_id,staff_code,employment_status,started_on)
      values (${f.orgId},${f.storeId},${target.personId},${uid('SE')},'regular','2026-01-01') returning id`;
    const [position] = await sql`select id from positions where org_id = ${f.orgId} and name = 'Cashier'`;
    await sql`insert into employment_positions (employment_id,position_id,is_primary) values (${emp!.id},${position!.id},true)`;
    const beforeRole = await asOrg(f.orgId, tx => accessRepo.activeRoleForPerson(tx, target.personId, f.orgId));
    await asOrg(f.orgId, tx => setEmploymentPositions(tx, f.admin, { employmentId: emp!.id, positionIds: [], primaryPositionId: '' }));
    expect(await asOrg(f.orgId, tx => employmentRepo.listEmploymentPositions(tx, emp!.id))).toEqual([]);
    expect((await asOrg(f.orgId, tx => employmentRepo.listActiveRoster(tx, f.storeId))).find(row => row.id === emp!.id)?.role).toBe(role);
    expect(await asOrg(f.orgId, tx => accessRepo.activeRoleForPerson(tx, target.personId, f.orgId))).toEqual(beforeRole);
    expect(await asOrg(f.orgId, tx => can(tx, target, 'enrol_staff', { storeId: f.storeId }))).toBe(true);
  });

  it.each(['manager', 'admin', 'super_admin'] as const)('%s hire does not silently assign a default staff position', async role => {
    const f = await roleFixture(`451-hire-${role}`);
    const target = role === 'manager' ? f.manager : role === 'admin' ? f.admin : f.superAdmin;
    const hired = await asOrg(f.orgId, tx => createEmployment(tx, f.admin, { personId: target.personId, storeId: f.storeId, startedOn: '2026-01-01', employmentStatus: 'regular' }));
    expect(await asOrg(f.orgId, tx => employmentRepo.listEmploymentPositions(tx, hired.id))).toEqual([]);
  });

  it.each(['manager', 'admin', 'super_admin'] as const)('%s cannot be assigned a staff job through an old form', async role => {
    const f = await roleFixture(`451-refuse-${role}`);
    const target = role === 'manager' ? f.manager : role === 'admin' ? f.admin : f.superAdmin;
    const hired = await asOrg(f.orgId, tx => createEmployment(tx, f.admin, { personId: target.personId, storeId: f.storeId, startedOn: '2026-01-01', employmentStatus: 'regular' }));
    const [cashier] = await sql`select id from positions where org_id=${f.orgId} and name='Cashier'`;
    if (!cashier) throw new Error('Canonical Cashier fixture is missing.');
    await expect(asOrg(f.orgId, tx => setEmploymentPositions(tx, f.admin, { employmentId: hired.id, positionIds: [cashier.id], primaryPositionId: cashier.id })))
      .rejects.toThrow('Managers and administrators use their role, not a staff position. Remove the position assignments.');
    expect(await asOrg(f.orgId, tx => employmentRepo.listEmploymentPositions(tx, hired.id))).toEqual([]);
    expect((await asOrg(f.orgId, tx => accessRepo.activeRoleForPerson(tx, target.personId, f.orgId)))?.role).toBe(role);
  });

  it('staff cannot clear the primary position, including a revoked former manager', async () => {
    const f = await roleFixture('451-staff');
    await sql`insert into person_roles (person_id,org_id,role,revoked_at) values (${f.staff.personId},${f.orgId},'manager',now())`;
    const [emp] = await sql`select id from employments where person_id = ${f.staff.personId} and store_id = ${f.storeId}`;
    await expect(asOrg(f.orgId, tx => setEmploymentPositions(tx, f.admin, { employmentId: emp!.id, positionIds: [], primaryPositionId: '' })))
      .rejects.toThrow('Choose a primary position for this staff member.');
  });
});
