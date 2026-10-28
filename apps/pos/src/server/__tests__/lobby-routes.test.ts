/**
 * T-455 S5 (TESTER) - the POS v2 lobby routes: POST /api/pos2/lobby/{list,park,call,seat,remove,pause}.
 * docs/tasks/455-customer-lobby.md "S5 rulings (POS session, Opus, 2026-10-29)" 1, 3, 4, 5, 7 and the S5 row of section 5.
 *
 * RED FOR THE RIGHT REASON: `@/server/pos2/lobby` and `@/app/api/pos2/lobby/*` do not exist, so every case fails on "Failed to resolve import".
 *
 * CONTRACT THE BUILDER MATCHES
 *   module  @/server/pos2/lobby     handleLobbyList | handleLobbyPark | handleLobbyCall | handleLobbySeat | handleLobbyRemove | handleLobbyPause
 *                                   each `(req: Request, deps: Pos2Deps) => Promise<Response>`
 *   routes  @/app/api/pos2/lobby/{list,park,call,seat,remove,pause}/route   `export POST(req)` via runPos2Route (503 'POS server is not configured')
 *   bodies  all JSON, all carry { storeId (the POS store id), deviceId (uuid) }:
 *             list   {}                                          park   { displayName, partySize, phone?, note? }
 *             call   { entryId }   remove { entryId }            seat   { entryId, sessionId, standLabel, joinUrl? }
 *             pause  { paused: boolean }
 *   Pos2Deps gains a `lobby` port (the test fake below is the shape; production wraps resolvePosTerminalLink + the domain's terminal.ts
 *   inside withOrgPrincipal(POS_ORG_ID)):
 *     lobby: {
 *       resolveTablet(i: { posStoreId: string; deviceId: string }): Promise<{ erpStoreId: string; terminalPersonId: string } | null>   // null = no live store link / no ACTIVE terminal link
 *       list(a: LobbyTablet): Promise<{ lobbyEnabled: boolean; paused: boolean; entries: unknown[] }>
 *       park(a: LobbyTablet, i: { displayName: string; partySize: number; phone: string | null; note: string | null }): Promise<{ entryId: string; code: string }>
 *       call(a: LobbyTablet, i: { entryId: string }): Promise<{ entryId: string; status: 'called' }>
 *       seat(a: LobbyTablet, i: { entryId: string; sessionId: string; standLabel: string; joinUrl: string | null }): Promise<{ entryId: string; status: 'seated' }>
 *       remove(a: LobbyTablet, i: { entryId: string }): Promise<{ entryId: string; status: 'removed' }>
 *       pause(a: LobbyTablet, i: { paused: boolean }): Promise<{ paused: boolean }>
 *     }   where LobbyTablet = { erpStoreId: string; terminalPersonId: string; cashierName: string }  (orgId is the port's own: single-organisation like approveManagerPin)
 *   A refusal is any thrown error whose `name === 'LobbyRefusal'` with a string `userMessage` (POS tests cannot import @shareat/domain; the real class has both).
 *   Responses: 200 `{ ok: true, ...portResult }` ; refusal 409 `{ ok:false, error: userMessage }` ; unexpected 500 (guarded) ; no tablet 403 NOT_REGISTERED.
 *
 * MUTANTS: M1 no bearer accepted; M2 staff of another store accepted; M3 tablet not resolved / bad deviceId reaches the port; M4 ERP store taken from the body;
 *   M5 cashier name taken from the body; M6 LobbyRefusal answered 500 or with its internal message; M7 non-https joinUrl forwarded; M8 resolve before identity;
 *   M9 ghost-id probing reaches the database (non-uuid entryId); M10 diner name/phone in server logs; M11 route crashes instead of 503.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, OTHER_STORE, STORE, createFakeFirestore, json, makeDeps, post, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

const NOT_REGISTERED = 'This tablet is not registered for the lobby.';
const ERP_STORE = '019e1111-1111-7111-8111-111111111111';
const TERMINAL_PERSON = '019e2222-2222-7222-8222-222222222222';
const UNLINKED_DEVICE = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const ENTRY = '019e3333-3333-7333-8333-333333333333';
const DINER = 'Ana Reyes';
const PHONE = '+63 917 555 0100';

class FakeLobbyRefusal extends Error {
  constructor(readonly code: string, readonly userMessage: string) {
    super(`${code}: internal detail that a tablet must never read`);
    this.name = 'LobbyRefusal';
  }
}

type Call = { fn: string; actor?: unknown; input?: unknown };
function makeLobby(over: Partial<Record<string, (...a: any[]) => Promise<unknown>>> = {}) {
  const calls: Call[] = [];
  const resolves: { posStoreId: string; deviceId: string }[] = [];
  const lobby = {
    resolveTablet: async (i: { posStoreId: string; deviceId: string }) => {
      resolves.push(i);
      return i.deviceId === UNLINKED_DEVICE ? null : { erpStoreId: ERP_STORE, terminalPersonId: TERMINAL_PERSON };
    },
    list: async (a: unknown) => { calls.push({ fn: 'list', actor: a }); return { lobbyEnabled: true, paused: false, entries: [{ entryId: ENTRY, code: '4821', displayName: DINER, partySize: 5, status: 'waiting', source: 'lobby', lines: [] }] }; },
    park: async (a: unknown, i: unknown) => { calls.push({ fn: 'park', actor: a, input: i }); return { entryId: ENTRY, code: '4821' }; },
    call: async (a: unknown, i: unknown) => { calls.push({ fn: 'call', actor: a, input: i }); return { entryId: ENTRY, status: 'called' }; },
    seat: async (a: unknown, i: unknown) => { calls.push({ fn: 'seat', actor: a, input: i }); return { entryId: ENTRY, status: 'seated' }; },
    remove: async (a: unknown, i: unknown) => { calls.push({ fn: 'remove', actor: a, input: i }); return { entryId: ENTRY, status: 'removed' }; },
    pause: async (a: unknown, i: unknown) => { calls.push({ fn: 'pause', actor: a, input: i }); return { paused: (i as { paused: boolean }).paused }; },
    ...over,
  };
  return { lobby, calls, resolves };
}

interface RouteSpec { name: string; fn: string; handler: string; route: () => Promise<{ POST: (r: Request) => Promise<Response> }>; body: Record<string, unknown> }
const SPECS: RouteSpec[] = [
  { name: 'list', fn: 'list', handler: 'handleLobbyList', route: () => import('@/app/api/pos2/lobby/list/route'), body: {} },
  { name: 'park', fn: 'park', handler: 'handleLobbyPark', route: () => import('@/app/api/pos2/lobby/park/route'), body: { displayName: DINER, partySize: 5, phone: PHONE, note: 'window seat' } },
  { name: 'call', fn: 'call', handler: 'handleLobbyCall', route: () => import('@/app/api/pos2/lobby/call/route'), body: { entryId: ENTRY } },
  { name: 'seat', fn: 'seat', handler: 'handleLobbySeat', route: () => import('@/app/api/pos2/lobby/seat/route'), body: { entryId: ENTRY, sessionId: 'SESS-1', standLabel: '7', joinUrl: 'https://customer.shareat.net/join?token=abc' } },
  { name: 'remove', fn: 'remove', handler: 'handleLobbyRemove', route: () => import('@/app/api/pos2/lobby/remove/route'), body: { entryId: ENTRY } },
  { name: 'pause', fn: 'pause', handler: 'handleLobbyPause', route: () => import('@/app/api/pos2/lobby/pause/route'), body: { paused: true } },
];

let fs: FakeFirestore;
beforeEach(() => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function call(spec: RouteSpec, body: Record<string, unknown>, o: { token?: string | null; lobby?: ReturnType<typeof makeLobby> } = {}) {
  const l = o.lobby ?? makeLobby();
  const d = makeDeps(fs);
  const mod = (await import('@/server/pos2/lobby')) as Record<string, (r: Request, deps: any) => Promise<Response>>;
  const res = await mod[spec.handler]!(post(`lobby/${spec.name}`, body, o.token === undefined ? 'tok-cashier' : o.token), { ...d.deps, lobby: l.lobby });
  return { status: res.status, body: await json(res), l };
}
const full = (spec: RouteSpec, over: Record<string, unknown> = {}) => ({ storeId: STORE, deviceId: DEVICE, ...spec.body, ...over });
const untouched = (l: ReturnType<typeof makeLobby>, why: string) => {
  expect(l.calls, `${why}: the port was called`).toEqual([]);
};

describe.each(SPECS.map((s) => [s.name, s] as const))('%s', (_n, spec) => {
  it('no bearer token: 401, nothing resolved or called [kills: M1, M8]', async () => {
    const r = await call(spec, full(spec), { token: null });
    expect(r.status).toBe(401);
    expect(r.body.ok).toBe(false);
    untouched(r.l, 'unsigned');
    expect(r.l.resolves).toEqual([]);
  });

  it('staff assigned only to ANOTHER store, an inactive account, and a stranger: 403, nothing resolved or called [kills: M2, M8]', async () => {
    for (const token of ['tok-elsewhere', 'tok-inactive', 'tok-nobody']) {
      const l = makeLobby();
      const r = await call(spec, full(spec), { token, lobby: l });
      expect(r.status, token).toBe(403);
      untouched(l, token);
      expect(l.resolves, token).toEqual([]);
    }
    // the same staffer is refused when the BODY names the other store, too
    const l = makeLobby();
    const r = await call(spec, full(spec, { storeId: OTHER_STORE }), { token: 'tok-cashier', lobby: l });
    expect(r.status).toBe(403);
    untouched(l, 'cashier naming a store they are not assigned to');
  });

  it('missing, malformed or unlinked deviceId: 403 "This tablet is not registered for the lobby."; no move is made [kills: M3]', async () => {
    const bodies: Array<[string, Record<string, unknown>]> = [
      ['missing', (() => { const b: Record<string, unknown> = full(spec); delete b.deviceId; return b; })()],
      ['not a uuid', full(spec, { deviceId: 'not-a-uuid' })],
      ['number', full(spec, { deviceId: 12345 })],
      ['uuid with no terminal link', full(spec, { deviceId: UNLINKED_DEVICE })],
    ];
    for (const [why, body] of bodies) {
      const l = makeLobby();
      const r = await call(spec, body, { lobby: l });
      expect(r.status, why).toBe(403);
      expect(r.body.error, why).toBe(NOT_REGISTERED);
      untouched(l, why);
    }
  });

  it('a registered tablet: 200, the actor is the LINK\'s ERP store and terminal person plus the staffer\'s name from Firestore; the body cannot choose any of them [kills: M4, M5]', async () => {
    const r = await call(spec, full(spec, { erpStoreId: 'ATTACKER-STORE', orgId: 'ATTACKER-ORG', terminalPersonId: 'ATTACKER-PERSON', cashierName: 'Hacker', role: 'admin' }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.l.resolves).toEqual([{ posStoreId: STORE, deviceId: DEVICE }]);
    expect(r.l.calls.length).toBe(1);
    expect(r.l.calls[0]!.fn).toBe(spec.fn);
    expect(r.l.calls[0]!.actor).toEqual({ erpStoreId: ERP_STORE, terminalPersonId: TERMINAL_PERSON, cashierName: 'Cora Cashier' });
    expect(JSON.stringify(r.l.calls[0])).not.toMatch(/ATTACKER|Hacker/);
  });

  it('a LobbyRefusal answers 409 with its one sentence, never its internal message [kills: M6]', async () => {
    const l = makeLobby({ [spec.fn]: async () => { throw new FakeLobbyRefusal('LOBBY_NOT_FOUND', 'We could not find that place in line.'); } });
    const r = await call(spec, full(spec), { lobby: l });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, error: 'We could not find that place in line.' });
  });

  it('any other error answers the plain 500 sentence and leaks nothing, not even into the server log [kills: M10]', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l = makeLobby({ [spec.fn]: async () => { throw new Error(`insert failed for ${DINER} ${PHONE}`); } });
    const r = await call(spec, full(spec), { lobby: l });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/insert failed|Ana|917/);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged.includes(DINER) || logged.includes(PHONE), 'a diner name or phone reached console.error').toBe(false);
  });

  it('the route file answers 503 "POS server is not configured", never a crash, when the box is not configured [kills: M11]', async () => {
    vi.stubEnv('POS_FIREBASE_SA_KEY_FILE', '');
    vi.stubEnv('DATABASE_URL', '');
    const mod = await spec.route();
    const res = await mod.POST(post(`lobby/${spec.name}`, full(spec), 'tok-cashier'));
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ ok: false, error: 'POS server is not configured' });
  });
});

describe('per-route payloads', () => {
  const spec = (n: string) => SPECS.find((s) => s.name === n)!;

  it('list: the 200 body carries lobbyEnabled, paused and the entries the port returned', async () => {
    const r = await call(spec('list'), full(spec('list')));
    expect(r.body).toMatchObject({ ok: true, lobbyEnabled: true, paused: false });
    expect(r.body.entries).toHaveLength(1);
    expect(r.body.entries[0]).toMatchObject({ code: '4821', partySize: 5 });
  });

  it('park: passes name, party, phone and note through (trimmed to null when blank) and answers the code', async () => {
    const r = await call(spec('park'), full(spec('park')));
    expect(r.body).toMatchObject({ ok: true, entryId: ENTRY, code: '4821' });
    expect(r.l.calls[0]!.input).toEqual({ displayName: DINER, partySize: 5, phone: PHONE, note: 'window seat' });
    const l2 = makeLobby();
    await call(spec('park'), full(spec('park'), { phone: '', note: undefined }), { lobby: l2 });
    expect(l2.calls[0]!.input).toEqual({ displayName: DINER, partySize: 5, phone: null, note: null });
  });

  it('seat: an https joinUrl is forwarded; http, javascript:, data:, garbage, a non-string and a missing one are all dropped to null, never stored [kills: M7]', async () => {
    const ok = await call(spec('seat'), full(spec('seat')));
    expect(ok.l.calls[0]!.input).toEqual({ entryId: ENTRY, sessionId: 'SESS-1', standLabel: '7', joinUrl: 'https://customer.shareat.net/join?token=abc' });
    for (const bad of ['http://customer.shareat.net/join?token=abc', 'javascript:alert(1)', 'data:text/html,hi', 'customer.shareat.net/join', '', 42, { u: 1 }, null, undefined]) {
      const l = makeLobby();
      const r = await call(spec('seat'), full(spec('seat'), { joinUrl: bad }), { lobby: l });
      expect(r.status, String(bad)).toBe(200);
      expect((l.calls[0]!.input as { joinUrl: unknown }).joinUrl, `joinUrl ${JSON.stringify(bad)} must be dropped`).toBeNull();
    }
  });

  it('call / seat / remove: an entryId that is not a uuid is a 400 before the port (no database syntax error can be provoked) [kills: M9]', async () => {
    for (const n of ['call', 'seat', 'remove']) {
      for (const bad of ['4821', 'abc', '', 7, undefined]) {
        const l = makeLobby();
        const r = await call(spec(n), full(spec(n), { entryId: bad }), { lobby: l });
        expect(r.status, `${n} ${String(bad)}`).toBe(400);
        untouched(l, `${n} ${String(bad)}`);
      }
    }
  });

  it('pause: paused must be a real boolean (400 otherwise); true and false are passed as given', async () => {
    for (const bad of ['true', 1, null, undefined]) {
      const l = makeLobby();
      const r = await call(spec('pause'), full(spec('pause'), { paused: bad }), { lobby: l });
      expect(r.status, String(bad)).toBe(400);
      untouched(l, String(bad));
    }
    const on = await call(spec('pause'), full(spec('pause'), { paused: true }));
    const off = await call(spec('pause'), full(spec('pause'), { paused: false }));
    expect(on.body).toMatchObject({ ok: true, paused: true });
    expect(off.body).toMatchObject({ ok: true, paused: false });
    expect(off.l.calls[0]!.input).toEqual({ paused: false });
  });
});
