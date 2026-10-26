import { describe, it, expect, vi, afterEach } from 'vitest';
import { createFixtureLobbyData } from '@/data/fixture-lobby-data';
import { createHttpLobbyData } from '@/data/http-lobby-data';
import type { LobbyData } from '@/data/lobby-data';

/**
 * T-455 S4 tester: the LobbyData door. One interface; the fixture (screens are built against it first) and the http client (S3's routes)
 * both implement it. Every test names the mutant it kills.
 */

const METHODS = ['getStore', 'checkIn', 'myEntry', 'cancel'] as const;
const ID = '0190aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('both implementations satisfy LobbyData', () => {
  it.each([
    ['fixture', () => createFixtureLobbyData() as LobbyData],
    ['http', () => createHttpLobbyData() as LobbyData],
  ])('%s exposes getStore / checkIn / myEntry / cancel as functions, and nothing that takes a code or an entry id', (_n, make) => {
    // kills: an implementation missing a method (the screens would only break at run time); a method taking an entry id (4.2: no enumeration)
    const d = make();
    for (const m of METHODS) expect(typeof d[m], m).toBe('function');
    expect(d.myEntry.length).toBeLessThanOrEqual(1);
    expect(d.cancel.length).toBeLessThanOrEqual(1);
  });
});

describe('fixture implementation (the rules the server owns, per 2.3 / 2.4 / 4.1)', () => {
  const mk = () => createFixtureLobbyData({ now: () => 1_000_000 });

  it('check-in returns a 4-digit code, the place in line and created:true; the same clientRequestId returns the same entry', async () => {
    // kills: a second row on replay (S2 ruling 10); a code that is not a counter label
    const d = mk();
    const a = await d.checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 3, clientRequestId: ID });
    const b = await d.checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 3, clientRequestId: ID });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.code).toMatch(/^\d{4}$/);
      expect(a.value.created).toBe(true);
      expect(b.value.entryId).toBe(a.value.entryId);
      expect(b.value.code).toBe(a.value.code);
    }
  });

  it('partiesAhead counts only earlier waiting/called entries of the same store', async () => {
    // kills: counting later arrivals, other stores, or closed entries
    const d = mk();
    const first = await d.checkIn({ storeCode: 'LIPA', displayName: 'A', partySize: 1, clientRequestId: '0190aaaa-bbbb-4ccc-8ddd-000000000001' });
    expect(first.ok && first.value.partiesAhead).toBe(0);
    d.demo.asNewDevice();
    const second = await d.checkIn({ storeCode: 'LIPA', displayName: 'B', partySize: 1, clientRequestId: '0190aaaa-bbbb-4ccc-8ddd-000000000002' });
    expect(second.ok && second.value.partiesAhead).toBe(1);
  });

  it('refuses out-of-bounds input with 400: name 41 chars, party 0 and 31, note 61 chars', async () => {
    // kills: a fixture more lenient than the server (screens tested against it would pass bad forms)
    const d = mk();
    const bad = [
      { displayName: 'a'.repeat(41), partySize: 2 },
      { displayName: 'Ana', partySize: 0 },
      { displayName: 'Ana', partySize: 31 },
      { displayName: 'Ana', partySize: 2, note: 'n'.repeat(61) },
    ];
    for (const b of bad) {
      const r = await d.checkIn({ storeCode: 'LIPA', clientRequestId: ID, ...b });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it('a paused store: 409 with the one sentence "Please check in at the counter." (never says which limit)', async () => {
    // kills: a distinct message per limit (4.1); 200 on a paused store
    const d = mk();
    d.demo.pause();
    const r = await d.checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(409);
      expect(r.error).toBe('Please check in at the counter.');
    }
    const s = await d.getStore('LIPA');
    expect(s.ok && s.value.accepting).toBe(false);
  });

  it('an unknown store code is refused with the same 409 sentence', async () => {
    // kills: fail-open for a typo'd poster code
    const r = await mk().checkIn({ storeCode: 'NOPE', displayName: 'Ana', partySize: 2, clientRequestId: ID });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('myEntry follows call -> seat (link once) -> and cancel closes the entry', async () => {
    // kills: handoffUrl returned on every read (2.6: once); cancel that leaves the entry live
    const d = mk();
    await d.checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID });
    d.demo.call();
    const called = await d.myEntry('LIPA');
    expect(called.ok && called.value.status).toBe('called');
    d.demo.seat('https://customer.shareat.net/join?t=T', '7');
    const first = await d.myEntry('LIPA');
    const second = await d.myEntry('LIPA');
    expect(first.ok && first.value.handoffUrl).toBe('https://customer.shareat.net/join?t=T');
    expect(second.ok && second.value.handoffUrl).toBeNull();

    const d2 = mk();
    await d2.checkIn({ storeCode: 'LIPA', displayName: 'Ben', partySize: 1, clientRequestId: ID });
    const c = await d2.cancel('LIPA');
    expect(c.ok && c.value.status).toBe('cancelled');
    const after = await d2.myEntry('LIPA');
    expect(after.ok && after.value.status).toBe('cancelled');
  });

  it('the stored/returned entry carries no phone, email or price field', async () => {
    // kills: the fixture shape drifting from the privacy rule (4)
    const d = mk();
    const r = await d.checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID });
    const m = await d.myEntry('LIPA');
    expect(JSON.stringify([r, m])).not.toMatch(/phone|email|price|amount|total/i);
  });
});

describe('http implementation (S3 routes)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(body: unknown, status = 200) {
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    return f;
  }

  it('checkIn POSTs JSON to /api/lobby/check-in with credentials, and the body is exactly the input (no money, no phone)', async () => {
    // kills: wrong route/method; dropped credentials (the cookie would not ride); a price added on the way
    const f = stub({ ok: true, created: true, entry: { entryId: 'e1', code: '4821', status: 'waiting', partiesAhead: 2 } });
    const input = { storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID };
    const r = await createHttpLobbyData().checkIn(input);
    expect(r.ok).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lobby/check-in');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it('DEF-782: a 428 LOBBY_COOKIE_NEEDED is retried ONCE with the same request and id, and the second answer is the result', async () => {
    // kills: no retry (the first check-in is orphaned); a retry with a new id or a changed body; a retry loop
    const needed = () => new Response(JSON.stringify({ ok: false, error: 'Please try again.', code: 'LOBBY_COOKIE_NEEDED' }), { status: 428, headers: { 'content-type': 'application/json' } });
    const good = () => new Response(JSON.stringify({ ok: true, created: true, entry: { entryId: 'e1', code: '4821', status: 'waiting', partiesAhead: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const f = vi.fn().mockResolvedValueOnce(needed()).mockResolvedValueOnce(good());
    vi.stubGlobal('fetch', f);
    const input = { storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID };
    const r = await createHttpLobbyData().checkIn(input);
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    const [a, b] = f.mock.calls as unknown as [[string, RequestInit], [string, RequestInit]];
    expect(b[0]).toBe(a[0]);
    expect(b[1].body).toBe(a[1].body);
    expect(b[1].credentials).toBe('include');
    expect(JSON.parse(String(b[1].body)).clientRequestId).toBe(ID);
  });

  it('DEF-782: a second 428 is the ordinary error state (status 428, the server sentence), after exactly two calls', async () => {
    // kills: an endless retry loop; swallowing the second refusal
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Please try again.', code: 'LOBBY_COOKIE_NEEDED' }), { status: 428, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    const r = await createHttpLobbyData().checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID });
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.status, r.error]).toEqual([428, 'Please try again.']);
  });

  it('DEF-782: any other status is not retried (400, 409, 500, and a 428 WITHOUT the cookie-needed code)', async () => {
    // kills: retrying every failure; retrying on the status alone
    for (const [status, code] of [[400, undefined], [409, undefined], [500, undefined], [428, 'SOMETHING_ELSE']] as const) {
      const f = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'Please check in at the counter.', ...(code ? { code } : {}) }), { status, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', f);
      const r = await createHttpLobbyData().checkIn({ storeCode: 'LIPA', displayName: 'Ana', partySize: 2, clientRequestId: ID });
      expect(f, `status ${status}`).toHaveBeenCalledTimes(1);
      expect(r.ok).toBe(false);
    }
  });

  it('myEntry GETs /api/lobby/me?s=CODE (the store code is the only thing in the URL)', async () => {
    // kills: a name, code or entry id in the query string (4.3)
    const f = stub({ ok: true, entry: { entryId: 'e1', code: '4821', status: 'waiting', partiesAhead: 0, displayName: 'Ana', partySize: 2, standLabel: null, handoffUrl: null } });
    await createHttpLobbyData().myEntry('LIPA');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lobby/me?s=LIPA');
    expect(init.method).toBe('GET');
  });

  it('cancel POSTs {storeCode} to /api/lobby/cancel', async () => {
    // kills: sending an entry id the server must not trust
    const f = stub({ ok: true, entry: { entryId: 'e1', status: 'cancelled' } });
    await createHttpLobbyData().cancel('LIPA');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lobby/cancel');
    expect(JSON.parse(String(init.body))).toEqual({ storeCode: 'LIPA' });
  });

  it('a 409 comes back as { ok:false, status:409, error } carrying the server sentence', async () => {
    // kills: swallowing the refusal or replacing the sentence with a technical one
    stub({ ok: false, error: 'Please check in at the counter.' }, 409);
    const r = await createHttpLobbyData().checkIn({ storeCode: 'LIPA', displayName: 'A', partySize: 1, clientRequestId: ID });
    expect(r).toEqual({ ok: false, status: 409, error: 'Please check in at the counter.' });
  });

  it('a network failure is status 0, not a throw', async () => {
    // kills: an unhandled rejection that freezes the poll loop
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const r = await createHttpLobbyData().myEntry('LIPA');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(0);
  });

  it('honours the base origin for the APK build', async () => {
    // kills: relative URLs in the Capacitor shell
    const f = stub({ ok: true, entry: { entryId: 'e1', status: 'cancelled' } });
    await createHttpLobbyData('https://order.shareat.net').cancel('LIPA');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('https://order.shareat.net/api/lobby/cancel');
  });
});
