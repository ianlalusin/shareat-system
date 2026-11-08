/**
 * T-526 R4 - a revoked staffer loses offline sign-in at the next snapshot refresh (A6): every verifier whose person is no longer in
 * the snapshot's staff list is deleted. Called only after a successful 200, never on a 304 or a failure.
 */
import { deleteVerifier, listVerifiers } from '@/lib/pos-device';

export interface SnapshotStaff {
  personId: string;
  displayName: string;
  employeeId: string;
  posCapabilities: string[];
}

export async function expireRevokedVerifiers(staff: readonly Pick<SnapshotStaff, 'personId'>[]): Promise<void> {
  const current = new Set(staff.map((s) => s.personId));
  for (const v of await listVerifiers()) if (!current.has(v.personId)) await deleteVerifier(v.personId);
}
