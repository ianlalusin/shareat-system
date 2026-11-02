import 'server-only';
import { createHmac, randomBytes } from 'node:crypto';

/**
 * T-455 S9a item 3 - a small in-process limiter for the PUBLIC lobby reads (docs/tasks/455-customer-lobby.md "S9 rulings"). Stock Caddy has no `limit_req`, and
 * the customer server is ONE process, so a fixed-window counter in memory is enough: 60 requests per minute per client address on `GET /api/lobby/store` (and the
 * menu read when S4b lands). Memory only: a restart forgets every count, which is fine for a rate limit. The domain's check-in limits (5 per hour per IP and store,
 * the live cap) are separate and unchanged.
 *
 * IPv6 is counted per /64 prefix (one household, or one attacker with a whole /64, owns billions of addresses and would otherwise get 60 reads per address); IPv4 stays per
 * address, and an IPv4-mapped IPv6 address (::ffff:a.b.c.d) counts as that IPv4 address. When the table fills with live windows it is cleared whole: a flood can at worst forget
 * counts, never grow memory.
 *
 * The key is a keyed hash of the bucket derived from `x-real-ip` (the header OUR Caddy overwrites; `x-forwarded-for` is chosen by the diner and is never read), keyed by a random
 * per-process value, so the table never holds an address and nothing about it survives the process. A request with no `x-real-ip` is not limited: the store read
 * works without a proxy (S4 contract), and in production Caddy always sets the header.
 */

export interface FixedWindowLimiter {
  /** Counts one hit for `key`; true = allowed, false = over the limit for the current window. */
  hit(key: string): boolean;
  size(): number;
}

export function createFixedWindowLimiter(o: { limit: number; windowMs: number; maxKeys: number; now: () => number }): FixedWindowLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  const sweepExpired = (now: number): void => {
    for (const [k, w] of windows) if (now - w.start >= o.windowMs) windows.delete(k);
  };
  return {
    hit(key: string): boolean {
      const now = o.now();
      const w = windows.get(key);
      if (w && now - w.start < o.windowMs) {
        if (w.count >= o.limit) return false;
        w.count += 1;
        return true;
      }
      if (!w && windows.size >= o.maxKeys) {
        sweepExpired(now);
        // Still full of live windows: start over rather than grow. A flood of one-off addresses can at worst forget some counts; it can never exhaust memory.
        if (windows.size >= o.maxKeys) windows.clear();
      }
      windows.set(key, { start: now, count: 1 });
      return true;
    },
    size: () => windows.size,
  };
}

export const LOBBY_READ_LIMIT = 60;
export const LOBBY_READ_WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

let processKey = randomBytes(32);
let limiter = createFixedWindowLimiter({ limit: LOBBY_READ_LIMIT, windowMs: LOBBY_READ_WINDOW_MS, maxKeys: MAX_KEYS, now: Date.now });

/** The limiter's bucket for one client address: `v6:` + the first four groups (the /64), `v4:` + the address, or `raw:` + the text when it is neither. Never throws. */
export function addressBucket(address: string): string {
  const ip = address.split('%')[0]!.trim().toLowerCase();
  if (!ip.includes(':')) return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? `v4:${ip}` : `raw:${address}`;
  const mapped = /^(?:0{0,4}:){2,5}ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) return `v4:${mapped[1]}`;
  const halves = ip.split('::');
  if (halves.length > 2) return `raw:${address}`;
  const head = halves[0] === '' ? [] : halves[0]!.split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1]!.split(':')) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return `raw:${address}`;
  return `v6:${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}`;
}

/** True when this request may proceed. Reads only `x-real-ip`; none = not limited. */
export function lobbyReadAllowed(req: Request): boolean {
  const ip = (req.headers.get('x-real-ip') ?? '').trim();
  if (ip.length === 0 || ip.length > 64) return true;
  return limiter.hit(createHmac('sha256', processKey).update(addressBucket(ip)).digest('hex'));
}

/** Tests only: a fresh table and a fresh key. */
export function resetLobbyReadLimiterForTests(): void {
  processKey = randomBytes(32);
  limiter = createFixedWindowLimiter({ limit: LOBBY_READ_LIMIT, windowMs: LOBBY_READ_WINDOW_MS, maxKeys: MAX_KEYS, now: Date.now });
}
