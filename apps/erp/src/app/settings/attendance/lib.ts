/**
 * Server-only helpers for `/settings/attendance`. T-201.
 *
 * ⭐ This screen adds no domain logic of its own — `getLiveConfig` and `supersedeConfig`
 * (`@shareat/domain`, T-155) already do the whole job: read the live policy, write a new one from
 * a chosen day, refuse a backdate over adjudicated days. This file only bridges form strings to
 * the shape those two functions already expect.
 */
import { attendanceConfigRepo, type AttendanceConfigRow } from '@shareat/db';
import { withOrgPrincipal, listStores } from '../../expenses/lib';

export { withOrgPrincipal, listStores };

export async function liveConfigFor(
  orgId: string,
  storeId: string,
): Promise<AttendanceConfigRow | undefined> {
  return withOrgPrincipal(orgId, (tx) => attendanceConfigRepo.findLive(tx, storeId));
}
