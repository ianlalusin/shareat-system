import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpLobbyData } from '@/data/http-lobby-data';

/**
 * DEF-782 follow-up: a phone that refuses cookies (an in-app webview) gets 428 LOBBY_COOKIE_NEEDED twice. The check-in PAGE must then show the
 * counter sentence. The customer tests run in plain node (no DOM), so this is the same two-part pattern as lobby-wait.test.ts: the real http data
 * layer against a stubbed fetch gives the exact `error` the page receives, and the page source is pinned to show that `error` and nothing else.
 */
const ID = '0190aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PAGE = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'check-in', 'page.tsx'), 'utf8');

describe('check-in page after two cookie-needed refusals', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('the page receives the counter sentence and renders exactly the result error [kills: the server try-again sentence reaching the diner; a page that swallows or rewrites r.error]', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Please try again.', code: 'LOBBY_COOKIE_NEEDED' }), { status: 428, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    const r = await createHttpLobbyData().checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('Please check in at the counter.');
    expect(PAGE).toMatch(/else setServerError\(r\.error\)/);
    expect(PAGE).toMatch(/serverError \? <ErrorLine>\{serverError\}<\/ErrorLine>/);
  });
});
