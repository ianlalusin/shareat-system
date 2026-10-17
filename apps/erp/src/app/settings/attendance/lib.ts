/**
 * Server-only helpers for `/settings/attendance`. T-201.
 *
 * ⭐ This screen adds no domain logic of its own — `getLiveConfig` and `supersedeConfig`
 * (`@shareat/domain`, T-155) already do the whole job: read the live policy, write a new one from
 * a chosen day, refuse a backdate over adjudicated days. This file only bridges form strings to
 * the shape those two functions already expect.
 */
import { attendanceConfigRepo, employmentRepo, type AttendanceConfigRow } from '@shareat/db';
import { listLeaveCaps, listLeaveTypes } from '@shareat/domain';
import { withOrgPrincipal, listStores } from '../../expenses/lib';

export { withOrgPrincipal, listStores };

export async function liveConfigFor(
  orgId: string,
  storeId: string,
): Promise<AttendanceConfigRow | undefined> {
  return withOrgPrincipal(orgId, (tx) => attendanceConfigRepo.findLive(tx, storeId));
}

/**
 * T-436: what the "Leave limits" section draws - the kinds, the caps that apply at this store (org defaults + its own rows) and the
 * positions a cap can be narrowed to. The reads authorize in the domain (`manage_attendance` at the store).
 */
export async function leaveSettingsFor(actor: { orgId: string; personId: string }, storeId: string) {
  return withOrgPrincipal(actor.orgId, async (tx) => ({
    kinds: await listLeaveTypes(tx, actor),
    caps: await listLeaveCaps(tx, actor, { storeId }),
    positions: await employmentRepo.listPositions(tx, actor.orgId, storeId),
  }));
}
