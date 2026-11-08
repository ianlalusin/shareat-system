/**
 * T-526 R5 - may a saved offline cashier be put back after a reload? Only while the tablet is OFFLINE, only on a usable snapshot that still lists
 * the person, and only while that person's verifier is still in the device store (a revoked or expired verifier means no offline sign-in, so
 * nothing in sessionStorage can bring them back). Pure.
 */
import type { SnapshotStaff } from './verifier-expiry';

export interface OfflineActor {
  personId: string;
  displayName: string;
  posCapabilities: string[];
}

export function restoredOfflineActor(input: {
  raw: string | null;
  online: boolean;
  snapshotUsable: boolean;
  staff: readonly SnapshotStaff[];
  verifierPersonIds: ReadonlySet<string>;
}): OfflineActor | null {
  if (input.online || !input.snapshotUsable || !input.raw) return null;
  let saved: { personId?: unknown } | null;
  try {
    saved = JSON.parse(input.raw) as { personId?: unknown } | null;
  } catch {
    return null;
  }
  const me = typeof saved?.personId === 'string' ? input.staff.find((s) => s.personId === saved.personId) : undefined;
  if (!me || !input.verifierPersonIds.has(me.personId)) return null;
  return { personId: me.personId, displayName: me.displayName, posCapabilities: me.posCapabilities };
}
