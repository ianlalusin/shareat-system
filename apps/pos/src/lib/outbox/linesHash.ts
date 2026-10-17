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
