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

/**
 * A comma-typed list of integers → sorted, de-duplicated numbers. Used for
 * `allowedShiftStartHours` and `payoutDays`, both stored as `integer[]`.
 *
 * ⛔ Does not enforce range or non-emptiness — the DB's own CHECK constraints do that
 * (`store_attendance_config_allowed_hours_check`, `..._payout_days_range_check`,
 * `..._fixed_days_needed_check`), and `constraint-messages.ts` turns a violation into a readable
 * sentence. Duplicating the range here would be a second copy of a rule the database already owns.
 */
export function parseIntList(input: string): number[] {
  const seen = new Set<number>();
  for (const token of input.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    const n = Number(trimmed);
    if (Number.isFinite(n) && Number.isInteger(n)) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}
