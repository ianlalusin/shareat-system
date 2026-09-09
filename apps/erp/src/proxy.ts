/**
 * DEF-233 / T-246 — `/clock`, the wall-mounted kiosk, authenticates through Firebase entirely
 * separately from the ERP's `__session` cookie, so a manager holding an ERP session in the same
 * browser could otherwise see the full ERP sidebar/topbar on the kiosk. `AppShell` is a Server
 * Component and Next 16 does not support reading the current pathname from one
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-pathname.md`) — this is
 * the framework's supported answer: tag the request here, read the tag in `AppShell` via
 * `headers()`.
 *
 * ⚠️ **`middleware.ts` is deprecated in this Next version (16.3.2, installed) and renamed to
 * `proxy.ts`** — same capability, `middleware.md` says so verbatim. Do not rename this file back.
 *
 * ⛔ `{ request: { headers: requestHeaders } }`, never `{ headers: requestHeaders }` — the wrapped
 * form is what reaches a Server Component's `headers()`; the bare form instead exposes the header
 * to the CLIENT (`proxy.md`, "Setting Headers").
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { KIOSK_HEADER } from './components/shell/kiosk';

export function proxy(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(KIOSK_HEADER, '1');
  return NextResponse.next({ request: { headers: requestHeaders } });
}

// ⛔ Statically analysed at build time — cannot be built from a shared constant or a loop
// (middleware.md / proxy.md: "matcher values need to be constants"). Scoped to exactly the one
// route this fixes: proxy does not run on the other 100 routes at all.
export const config = {
  matcher: ['/clock', '/clock/:path*'],
};
