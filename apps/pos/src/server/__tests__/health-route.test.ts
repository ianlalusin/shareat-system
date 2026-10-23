/**
 * T-425 slice T - GET /api/pos2/health (Ruling 4 probe; Ruling 8 version for "Check for update"). Acceptance 10, 14.
 *
 * CONTRACT for the builder (S3) - file `apps/pos/src/app/api/pos2/health/route.ts`:
 *   export const runtime = 'nodejs'; export const dynamic = 'force-dynamic';
 *   export async function GET(req?: Request): Promise<Response>
 *     200, content-type application/json, `cache-control: no-store`, body EXACTLY `{ "ok": true, "version": "<non-empty string>" }`
 *     (version from process.env.NEXT_PUBLIC_APP_VERSION, else the app's package.json version, else 'dev').
 *     UNAUTHENTICATED, no Firestore, no database, no firebase-admin, no `@/server/pos2/deps`, no token check: it must answer when everything behind it is down.
 *     (CORS for https://localhost is already handled for every /api/pos2/* by the T-424 middleware; this route adds nothing to it.)
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const routeFile = path.resolve(__dirname, '..', '..', 'app', 'api', 'pos2', 'health', 'route.ts');

describe('health route', () => {
  it('exists in the pos2 api tree', () => {
    expect(existsSync(routeFile)).toBe(true);
  });

  it('GET returns 200 {ok:true, version} as no-store JSON, with no request headers needed', async () => {
    const { GET } = await import('@/app/api/pos2/health/route');
    const res = await GET(new Request('http://localhost/api/pos2/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['ok', 'version']);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });

  it('answers with no request object and no Authorization header (unauthenticated)', async () => {
    const { GET } = await import('@/app/api/pos2/health/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('reports NEXT_PUBLIC_APP_VERSION when it is set', async () => {
    const prev = process.env.NEXT_PUBLIC_APP_VERSION;
    process.env.NEXT_PUBLIC_APP_VERSION = '7.8.9-test';
    try {
      const { GET } = await import('@/app/api/pos2/health/route');
      expect((await (await GET(new Request('http://localhost/api/pos2/health'))).json()).version).toBe('7.8.9-test');
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION; else process.env.NEXT_PUBLIC_APP_VERSION = prev;
    }
  });

  it('imports no Firestore, database, admin SDK or POS v2 server dependency (it must work when they are all down)', () => {
    expect(existsSync(routeFile)).toBe(true);
    const src = readFileSync(routeFile, 'utf8');
    const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/firebase|@shareat\/(db|auth|domain)|server\/pos2|\/deps|identity|roles/);
    }
    expect(src).not.toMatch(/getIdToken|verifyIdToken|Authorization|authorization/);
  });
});
