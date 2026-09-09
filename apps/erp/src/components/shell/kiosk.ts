/**
 * DEF-233 / T-246. Set by `proxy.ts` (matcher-scoped to `/clock`) on the way in; read by
 * `AppShell` via `headers()`. ⛔ Presentation only — `/clock`'s own Firebase auth is unrelated and
 * unaffected; this header decides chrome, never access.
 */
export const KIOSK_HEADER = 'x-shareat-kiosk';
