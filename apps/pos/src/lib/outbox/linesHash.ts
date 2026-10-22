/**
 * T-425 S1 - a short fingerprint of a receipt's `lines`, used by reconcile to tell "the same sale" from "a different sale under the same
 * receipt id". The SAME function hashes the local copy and the copy read back from the server, so it hashes a STABLE form:
 * object keys sorted at every depth, `undefined` removed (Firestore drops them), array order kept, timestamps left out (a pending server
 * timestamp is null locally and resolved on the server), and every number turned into integer centavos with the one money function so
 * 299 and 299.0000001 agree. Synchronous: crypto.subtle is async and the ledger transaction cannot await.
 */
import { storedPesosToCentavos } from '@/lib/money/centavos';

function stable(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === 'number') return storedPesosToCentavos(v);
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v === undefined || v instanceof Date) return undefined;
  if (typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') return undefined;
  if (Array.isArray(v)) return v.map((x) => stable(x) ?? null);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const s = stable((v as Record<string, unknown>)[k]);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return undefined;
}

/** cyrb53: a well-mixed 53-bit string hash (not a security hash; a conflict detector). */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function computeLinesHash(lines: unknown[]): string {
  const text = JSON.stringify(stable(Array.isArray(lines) ? lines : []));
  return `${cyrb53(text, 0).toString(16)}${cyrb53(text, 1).toString(16)}-${text.length.toString(16)}`;
}

/** T-460: the exact JSON shape produced by the old cleaner from an SDK Timestamp. */
function legacyClock(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  const { seconds, nanoseconds } = value as Record<string, unknown>;
  return keys.length === 2 && keys.includes('seconds') && keys.includes('nanoseconds') &&
    typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= -62135596800 && seconds <= 253402300799 &&
    typeof nanoseconds === 'number' && Number.isSafeInteger(nanoseconds) && nanoseconds >= 0 && nanoseconds <= 999999999;
}

/**
 * Second comparison against the ORIGINAL saved hash, never a replacement hash or stored-data edit.
 * The normal hash excludes SDK Timestamp instances. Repair only top-level line clock fields flattened
 * by the old cleaner; preserve every financial field and all other metadata/sentinel maps.
 */
export function legacyClockLinesHash(lines: unknown[]): string | null {
  let converted = false;
  const candidate = lines.map(line => {
    if (line === null || typeof line !== 'object' || Array.isArray(line)) return line;
    const prototype = Object.getPrototypeOf(line);
    if (prototype !== Object.prototype && prototype !== null) return line;
    const copy = { ...line } as Record<string, unknown>;
    for (const key of ['createdAt', 'updatedAt']) {
      if (legacyClock(copy[key])) { delete copy[key]; converted = true; }
    }
    return copy;
  });
  return converted ? computeLinesHash(candidate) : null;
}
