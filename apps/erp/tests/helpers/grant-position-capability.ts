/**
 * T-577: floor staff who READ a record (an expense draft, a sales day) hold the matching everyday capability at that store by POSITION, as in
 * production (T-318). Fixtures that built a floor person who holds NOTHING now need this one grant, because the single-record pages are
 * store-gated (DEF-834). Employment + position + grant, the same end state `reconcilePositionGrants` makes.
 */
import type postgres from 'postgres';
import type { Capability } from '@shareat/auth';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

export async function grantPositionCapability(
  sql: postgres.Sql,
  o: { orgId: string; storeId: string; personId: string; setBy: string; capability: Capability },
): Promise<void> {
  const [e] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, created_by)
    values (${o.orgId}, ${o.storeId}, ${o.personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e9)}`}, 'regular', '2025-01-01', ${o.setBy}) returning id`;
  await grantEverydayPositionAccess(sql, {
    orgId: o.orgId, storeId: o.storeId, employmentId: e!.id, personId: o.personId, setBy: o.setBy, capabilities: [o.capability],
  });
}
