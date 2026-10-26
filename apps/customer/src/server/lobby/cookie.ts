import 'server-only';
import { randomBytes } from 'node:crypto';
/**
 * T-455 S3 - the diner's device cookie. The only thing that identifies a diner: 32 random bytes, base64url (43 chars). The server keeps
 * only its HMAC. Path-scoped to /api/lobby, no Domain, Secure always (nginx terminates TLS), HttpOnly, SameSite=Lax.
 */

export const COOKIE_NAME = 'lobby_dev';
export const COOKIE_MAX_AGE_SECONDS = 3 * 60 * 60;
const COOKIE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function newCookieValue(): string {
  return randomBytes(32).toString('base64url');
}

/** The cookie value if the request carries a well-formed one; anything else counts as absent. */
export function readCookie(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return COOKIE_SHAPE.test(value) ? value : null;
  }
  return null;
}

export function setCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/api/lobby; HttpOnly; Secure; SameSite=Lax`;
}
