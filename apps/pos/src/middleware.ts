/**
 * T-424 Ruling 1 - CORS for the APK. The Android app is served from the origin `https://localhost` (Capacitor) and calls the POS v2 server on
 * another origin, so the server must answer a preflight for that ONE origin and no other. Server build only: `scripts/build-cap.mjs` stashes
 * this file (and `src/app/api`) during the static export.
 *
 * Allowed: exactly `https://localhost`. Any other origin (including `*` and `null`) gets no CORS header at all.
 */
import { NextResponse, type NextRequest } from 'next/server';

const ALLOWED_ORIGIN = 'https://localhost';

export function middleware(req: NextRequest): NextResponse {
  const origin = req.headers.get('origin');
  const allowed = origin === ALLOWED_ORIGIN;

  if (req.method === 'OPTIONS') {
    const res = new NextResponse(null, { status: 204 });
    if (allowed) applyCors(res);
    return res;
  }
  const res = NextResponse.next();
  if (allowed) applyCors(res);
  return res;
}

function applyCors(res: NextResponse): void {
  res.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  // T-510 S4b: GET /api/pos2/menu is a cross-origin GET with custom request headers (preflighted) and the APK must read two response headers.
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match, x-pos-store-id, x-device-id');
  res.headers.set('Access-Control-Expose-Headers', 'ETag, x-next-change-at');
  res.headers.set('Access-Control-Max-Age', '600');
  res.headers.append('Vary', 'Origin');
}

export const config = { matcher: '/api/:path*' };
