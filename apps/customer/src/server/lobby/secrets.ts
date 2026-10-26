import 'server-only';
import { createHmac } from 'node:crypto';
/**
 * T-455 S3 - the lobby's keyed hashes and per-request configuration. Env is read PER REQUEST, never at import, so a missing setting
 * fails closed with a plain 503 instead of a crash, and never falls back to a default key (an unkeyed hash is a lookup table).
 */

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_SHAPE.test(v);

/** A shorter key is treated as not configured (fail closed). */
export const MIN_SECRET_LENGTH = 32;

export interface LobbyConfig {
  readonly secret: string;
  readonly orgId: string;
}

export function readConfig(env: Record<string, string | undefined> = process.env): LobbyConfig | null {
  const secret = (env.LOBBY_HASH_SECRET ?? '').trim();
  const orgId = (env.LOBBY_ORG_ID ?? '').trim();
  if (secret.length < MIN_SECRET_LENGTH || !isUuid(orgId)) return null;
  return { secret, orgId };
}

/** HMAC-SHA256, lowercase hex, keyed by LOBBY_HASH_SECRET. Used for BOTH the cookie value (device_hash) and the client ip (ip_hash). */
export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * The client network address, from `x-real-ip` ONLY (our nginx overwrites it; `x-forwarded-for` is chosen by the diner and is never read).
 * null when absent: the caller answers 503 rather than putting every diner under one shared value. The only stand-in is the explicit
 * env var LOBBY_TEST_IP_STANDIN (read per request), for calling a route without a proxy.
 */
export function clientIp(req: Request, env: Record<string, string | undefined> = process.env): string | null {
  const v = (req.headers.get('x-real-ip') ?? '').trim();
  if (v.length > 0 && v.length <= 64) return v;
  const standIn = (env.LOBBY_TEST_IP_STANDIN ?? '').trim();
  return standIn.length > 0 && standIn.length <= 64 ? standIn : null;
}
