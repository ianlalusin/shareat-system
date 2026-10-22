/**
 * T-425 S3 - GET /api/pos2/health. The tablet's reachability probe (Ruling 4) and the source of "latest version" for Check for update
 * (Ruling 8). UNAUTHENTICATED and deliberately dependency-free: no Firestore, no database, no admin SDK, no token check, so it answers while
 * everything behind it is down. CORS for the APK origin is already handled for every /api path by src/middleware.ts.
 */
import pkg from '../../../../../package.json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req?: Request): Promise<Response> {
  const version = process.env.NEXT_PUBLIC_APP_VERSION || (typeof pkg.version === 'string' && pkg.version) || 'dev';
  return new Response(JSON.stringify({ ok: true, version }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
