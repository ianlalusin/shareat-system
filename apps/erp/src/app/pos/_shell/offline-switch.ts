/**
 * T-526 R5 - the offline cashier switch. The PIN is checked on the tablet against the verifier made at that person's last online sign-in
 * (R4), and only while the cached snapshot is no older than the offline limit and still lists the person. Five misses for one Employee ID
 * pause that ID for five minutes, counted in the device store so a reload does not reset it (same rule as T-464, bible row 381).
 * The server still decides every action; this only says who is holding the tablet.
 */
import { getVerifierByEmployeeId, isSnapshotUsable, readSnapshot } from '@/lib/pos-device';
import { verifyPin } from '@/lib/pos-device/pin-verifier';
import {
  POS_OFFLINE_ACTOR_KEY,
  POS_OFFLINE_SNAPSHOT_MAX_AGE_MS,
  POS_PIN_MISS_LIMIT,
  POS_PIN_PAUSE_MS,
} from './constants';
import { POS_OFFLINE_SIGN_IN_EXPIRED, POS_PIN_PAUSED, POS_WRONG_ID_OR_PIN } from './messages';
import type { SnapshotStaff } from './verifier-expiry';

export interface MetaPort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export type OfflineSwitchResult =
  | { ok: true; personId: string; displayName: string; posCapabilities: string[] }
  | { ok: false; reason: 'wrong' | 'paused' | 'snapshot_unusable'; message: string };

interface Misses {
  misses: number;
  pausedUntilMs: number;
}

const wrong = (): OfflineSwitchResult => ({ ok: false, reason: 'wrong', message: POS_WRONG_ID_OR_PIN });
const missKey = (employeeId: string) => `app.offlinePinMisses.${employeeId}`;

function readMisses(raw: unknown): Misses {
  const r = raw as Partial<Misses> | null | undefined;
  return { misses: Number(r?.misses) || 0, pausedUntilMs: Number(r?.pausedUntilMs) || 0 };
}

export async function attemptOfflineSwitch(input: {
  employeeId: string;
  pin: string;
  nowMs: number;
  meta: MetaPort;
  storage: Pick<Storage, 'setItem'>;
}): Promise<OfflineSwitchResult> {
  const { nowMs, meta } = input;
  const snapshot = await readSnapshot();
  if (!snapshot || !isSnapshotUsable(snapshot, nowMs, POS_OFFLINE_SNAPSHOT_MAX_AGE_MS)) {
    return { ok: false, reason: 'snapshot_unusable', message: POS_OFFLINE_SIGN_IN_EXPIRED };
  }
  // Only the numbers the keypad can type, so junk input cannot grow the miss table without bound.
  if (!/^\d{1,3}$/.test(input.employeeId)) return wrong();
  const employeeId = input.employeeId.padStart(3, '0');

  const key = missKey(employeeId);
  const before = readMisses(await meta.get(key));
  if (before.pausedUntilMs > nowMs) return { ok: false, reason: 'paused', message: POS_PIN_PAUSED };

  const staff = ((snapshot.body as { staff?: SnapshotStaff[] }).staff ?? []).find((s) => s.employeeId === employeeId);
  const verifier = await getVerifierByEmployeeId(employeeId);
  const matched = !!staff && !!verifier && verifier.personId === staff.personId && (await verifyPin(input.pin, verifier));

  if (!matched) {
    const misses = before.misses + 1;
    // An unknown ID is counted the same as a wrong PIN, so a pause never hints which half was wrong.
    await meta.set(key, misses >= POS_PIN_MISS_LIMIT ? { misses: 0, pausedUntilMs: nowMs + POS_PIN_PAUSE_MS } : { misses, pausedUntilMs: 0 });
    return wrong();
  }
  await meta.set(key, { misses: 0, pausedUntilMs: 0 });
  input.storage.setItem(POS_OFFLINE_ACTOR_KEY, JSON.stringify({ personId: staff.personId, displayName: staff.displayName, atMs: nowMs }));
  return { ok: true, personId: staff.personId, displayName: staff.displayName, posCapabilities: staff.posCapabilities };
}
