/**
 * T-526 R4 - the offline PIN verifier's two-step birth. At online sign-in the browser derives a verifier from the typed PIN and parks it
 * in sessionStorage as PENDING (the PIN itself is never stored or sent). On the first /pos load it is promoted into the device store only
 * if it is fresh and belongs to the person who actually signed in; the pending entry is then ALWAYS deleted, so a wrong PIN, which never
 * reaches /pos, can never be promoted and the next attempt simply replaces it.
 */
import { putVerifier } from '@/lib/pos-device';
import { POS_VERIFIER_ITERATIONS, POS_VERIFIER_MAX_ITERATIONS, deriveVerifier } from '@/lib/pos-device/pin-verifier';
import { POS_PROMOTE_COOKIE } from './constants';
import type { SnapshotStaff } from './verifier-expiry';

export const POS_PENDING_VERIFIER_KEY = 'shareat_pos_pending_verifier';
/** The promote window: the sign-in redirect lands on /pos within seconds, so a pending verifier older than this is stale. Inclusive. */
export const POS_PENDING_VERIFIER_MAX_AGE_MS = 300_000;

type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface Pending {
  employeeId: string;
  salt: string;
  hash: string;
  iterations: number;
  createdAtMs: number;
}

export async function savePendingVerifier(storage: PendingStorage, input: { employeeId: string; pin: string; nowMs: number }): Promise<void> {
  const v = await deriveVerifier(input.pin);
  const pending: Pending = { employeeId: input.employeeId, ...v, createdAtMs: input.nowMs };
  storage.setItem(POS_PENDING_VERIFIER_KEY, JSON.stringify(pending));
}

function parsePending(raw: string | null): Pending | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<Pending> | null;
    if (!p || typeof p !== 'object') return null;
    const { employeeId, salt, hash, iterations, createdAtMs } = p;
    if (typeof employeeId !== 'string' || typeof salt !== 'string' || typeof hash !== 'string') return null;
    if (typeof iterations !== 'number' || iterations < POS_VERIFIER_ITERATIONS || iterations > POS_VERIFIER_MAX_ITERATIONS || typeof createdAtMs !== 'number') return null;
    return { employeeId, salt, hash, iterations, createdAtMs };
  } catch {
    return null;
  }
}

export async function promotePendingVerifier(input: {
  storage: PendingStorage;
  staff: readonly SnapshotStaff[];
  personId: string;
  nowMs: number;
}): Promise<void> {
  const pending = parsePending(input.storage.getItem(POS_PENDING_VERIFIER_KEY));
  input.storage.removeItem(POS_PENDING_VERIFIER_KEY);
  if (!pending) return;
  const me = input.staff.find((s) => s.personId === input.personId);
  if (!me || me.employeeId !== pending.employeeId) return;
  if (input.nowMs - pending.createdAtMs > POS_PENDING_VERIFIER_MAX_AGE_MS) return;
  await putVerifier({ personId: me.personId, ...pending });
}

/** The promote flag as the browser holds it (`document.cookie`); a port so the rule below is testable without a DOM. */
export interface PromoteJar {
  has(): boolean;
  clear(): void;
}

export function browserPromoteJar(): PromoteJar {
  return {
    has: () => document.cookie.split('; ').includes(`${POS_PROMOTE_COOKIE}=1`),
    clear: () => void (document.cookie = `${POS_PROMOTE_COOKIE}=; path=/pos; max-age=0`),
  };
}

/**
 * The only door the shell uses. A verifier is promoted ONLY when the tablet-PIN sign-in set the promote flag; a mistyped PIN followed by a
 * manager's email sign-in leaves a pending entry but no flag, so nothing is stored. Both the flag and the pending entry are always deleted.
 */
export async function promoteAfterTabletSignIn(input: {
  storage: PendingStorage;
  jar: PromoteJar;
  staff: readonly SnapshotStaff[];
  personId: string;
  nowMs: number;
}): Promise<void> {
  const signedInByTablet = input.jar.has();
  input.jar.clear();
  if (!signedInByTablet) {
    input.storage.removeItem(POS_PENDING_VERIFIER_KEY);
    return;
  }
  await promotePendingVerifier(input);
}
