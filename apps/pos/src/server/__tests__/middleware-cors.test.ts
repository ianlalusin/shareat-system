/**
 * T-424 Ruling 1 + T-510 S4b - the APK (origin https://localhost) must be able to call GET /api/pos2/menu: a preflight that allows GET and the
 * menu's custom request headers, and a response that exposes ETag and x-next-change-at. Any other origin still gets no CORS header at all.
 */
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../middleware';

const call = (method: string, origin: string | null) =>
  middleware(new NextRequest('https://pos2.example.test/api/pos2/menu', { method, headers: origin ? { origin } : {} }));

describe('POS middleware CORS', () => {
  it('answers the menu preflight for https://localhost: GET allowed, custom headers allowed', () => {
    const res = call('OPTIONS', 'https://localhost');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://localhost');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const h of ['authorization', 'if-none-match', 'x-pos-store-id', 'x-device-id']) expect(allowed).toContain(h);
  });

  it('exposes ETag and x-next-change-at so the device can read them cross-origin', () => {
    const exposed = (call('GET', 'https://localhost').headers.get('access-control-expose-headers') ?? '').toLowerCase();
    expect(exposed).toContain('etag');
    expect(exposed).toContain('x-next-change-at');
  });

  it.each(['https://evil.example', 'null', '*'])('origin %s gets no CORS header', (origin) => {
    expect(call('OPTIONS', origin).headers.get('access-control-allow-origin')).toBeNull();
    expect(call('GET', origin).headers.get('access-control-allow-origin')).toBeNull();
  });
});
