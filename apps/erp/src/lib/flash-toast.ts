import { cookies } from 'next/headers';
import { decodeFlash, flashCookieName } from '@/lib/flash';

/**
 * T-387 S4: what the root layout hands the Toaster. Server side only.
 *
 * How the layout learns the current flash token: a layout cannot read the page URL's `f` (Next 16 gives a Server
 * Component no pathname or query, and a request header from proxy.ts would mean widening its matcher from `/clock` to
 * every route). So it takes the token from the flash cookie itself: `n` IS the value `redirectWithFlash` put in the
 * URL as `f`. The signature and expiry checks are the same ones `withFlash` makes.
 *
 * The one difference from `withFlash`: this does not compare against the URL's `f`, so a cookie still alive for its
 * 60 s can reach the Toaster on a page the redirect did not target. That is harmless: the Toaster de-dupes on this same
 * token in sessionStorage (L7), so each flash shows exactly once, on the first render that carries it. The banner and
 * form refills stay URL-gated by `withFlash`; this reads `ok` and `stamp` only.
 */
export async function readToastFlash(): Promise<{ token: string; ok?: string; stamp?: string } | null> {
  const raw = (await cookies()).get(flashCookieName())?.value;
  if (!raw) return null;
  const payload = decodeFlash(raw);
  if (!payload || payload.exp <= Date.now()) return null;
  const { ok, stamp } = payload.msg;
  if (!ok && !stamp) return null;
  return { token: payload.n, ...(ok ? { ok } : {}), ...(stamp ? { stamp } : {}) };
}
