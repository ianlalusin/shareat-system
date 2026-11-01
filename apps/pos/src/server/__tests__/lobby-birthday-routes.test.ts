/**
 * T-455 S6b (TESTER) - the POS v2 birthday routes: POST /api/pos2/lobby/birthday/{list,accept,decline,play}.
 * docs/tasks/455-customer-lobby.md S6b row, "S6a rulings" 1, 2, 5, 6, 7 and S5 ruling 1/3/4. Numbered ASSUMPTIONS A1..A10 live in
 * src/lib/birthday/player.test.ts's header; this file implements A3 (route names, bodies, port).
 *
 * RED FOR THE RIGHT REASON: `@/server/pos2/lobbyBirthday` and `@/app/api/pos2/lobby/birthday/*` do not exist ("Failed to resolve import").
 *
 * CONTRACT THE BUILDER MATCHES (same shape as S5 lobby.ts: authenticate -> uuid deviceId -> resolveTablet -> port; refusal 409; other 500)
 *   module  @/server/pos2/lobbyBirthday   handleLobbyBirthdayList | Accept | Decline | Play   each `(req, deps: Pos2Deps) => Promise<Response>`
 *   routes  @/app/api/pos2/lobby/birthday/{list,accept,decline,play}/route   `export POST(req)` via runPos2Route
 *   Pos2Deps.lobby gains:
 *     birthdayList(a: LobbyTablet): Promise<{ birthdays: unknown[] }>
 *     birthdayAccept(a: LobbyTablet, i: { requestId: string; scheduledAt: Date }): Promise<{ requestId: string; status: 'accepted'; scheduledAt: Date }>
 *     birthdayDecline(a: LobbyTablet, i: { requestId: string; reason: string }): Promise<{ requestId: string; status: 'declined' }>
 *     birthdayPlay(a: LobbyTablet, i: { requestId: string }): Promise<{ requestId: string; status: 'played' }>
 *   (production wraps domain listBirthdayForTerminal / accept... / decline... / markBirthdayPlayedForTerminal).
 *   Bodies: accept { storeId, deviceId, requestId (uuid), scheduledAt (ISO 8601 string, a past time is allowed = "Now", S6a ruling 7) };
 *           decline { ..., requestId, reason (trimmed 1..80 chars, S6a ruling 6; the route trims and checks BEFORE the port) }; play { ..., requestId }.
 *   Response 200 `{ ok: true, ...portResult }` (list -> `birthdays`); malformed requestId / scheduledAt / reason -> 400 and the port is not called (M9).
 * MUTANTS: M1 no bearer accepted; M2 staff of another store accepted; M3 unlinked/bad deviceId reaches the port; M4 ERP store from the body; M5 non-uuid requestId reaches the port;
 *   M6 refusal answered 500 or with internal message; M7 reason not trimmed / over 80 / blank passes; M8 scheduledAt garbage passes as Date(NaN); M9 diner/celebrant name in server logs; M10 route crashes instead of 503.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, OTHER_STORE, STORE, createFakeFirestore, json, makeDeps, post, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

const NOT_REGISTERED = 'This tablet is not registered for the lobby.';
const ERP_STORE = '019e1111-1111-7111-8111-111111111111';
const TERMINAL_PERSON = '019e2222-2222-7222-8222-222222222222';
const UNLINKED_DEVICE = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const REQ = '019e4444-4444-7444-8444-444444444444';
const CELEBRANT = 'Lola Remedios';
const WHEN = '2026-11-20T11:30:00.000Z';

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
    birthdayList: async (a: unknown) => { calls.push({ fn: 'birthdayList', actor: a }); return { birthdays: [{ requestId: REQ, entryId: 'E1', code: '4821', displayName: 'Ana', standLabel: null, celebrantName: CELEBRANT, status: 'requested', scheduledAt: null, createdAt: WHEN }] }; },
    birthdayAccept: async (a: unknown, i: unknown) => { calls.push({ fn: 'birthdayAccept', actor: a, input: i }); return { requestId: REQ, status: 'accepted', scheduledAt: (i as { scheduledAt: Date }).scheduledAt }; },
    birthdayDecline: async (a: unknown, i: unknown) => { calls.push({ fn: 'birthdayDecline', actor: a, input: i }); return { requestId: REQ, status: 'declined' }; },
    birthdayPlay: async (a: unknown, i: unknown) => { calls.push({ fn: 'birthdayPlay', actor: a, input: i }); return { requestId: REQ, status: 'played' }; },
    ...over,
  };
  return { lobby, calls, resolves };
}

interface Spec { name: string; fn: string; handler: string; route: () => Promise<{ POST: (r: Request) => Promise<Response> }>; body: Record<string, unknown> }
const SPECS: Spec[] = [
  { name: 'list', fn: 'birthdayList', handler: 'handleLobbyBirthdayList', route: () => import('@/app/api/pos2/lobby/birthday/list/route'), body: {} },
  { name: 'accept', fn: 'birthdayAccept', handler: 'handleLobbyBirthdayAccept', route: () => import('@/app/api/pos2/lobby/birthday/accept/route'), body: { requestId: REQ, scheduledAt: WHEN } },
  { name: 'decline', fn: 'birthdayDecline', handler: 'handleLobbyBirthdayDecline', route: () => import('@/app/api/pos2/lobby/birthday/decline/route'), body: { requestId: REQ, reason: 'Too busy right now' } },
  { name: 'play', fn: 'birthdayPlay', handler: 'handleLobbyBirthdayPlay', route: () => import('@/app/api/pos2/lobby/birthday/play/route'), body: { requestId: REQ } },
];

let fs: FakeFirestore;
beforeEach(() => { fs = createFakeFirestore(); seedStaff(fs); seedStore(fs); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function call(spec: Spec, body: Record<string, unknown>, o: { token?: string | null; lobby?: ReturnType<typeof makeLobby> } = {}) {
  const l = o.lobby ?? makeLobby();
  const d = makeDeps(fs);
  const mod = (await import('@/server/pos2/lobbyBirthday')) as Record<string, (r: Request, deps: any) => Promise<Response>>;
  const res = await mod[spec.handler]!(post(`lobby/birthday/${spec.name}`, body, o.token === undefined ? 'tok-cashier' : o.token), { ...d.deps, lobby: l.lobby });
  return { status: res.status, body: await json(res), l };
}
const full = (spec: Spec, over: Record<string, unknown> = {}) => ({ storeId: STORE, deviceId: DEVICE, ...spec.body, ...over });
const untouched = (l: ReturnType<typeof makeLobby>, why: string) => expect(l.calls, `${why}: the port was called`).toEqual([]);

describe.each(SPECS.map((s) => [s.name, s] as const))('%s', (_n, spec) => {
  it('no bearer token: 401, nothing resolved or called [M1]', async () => {
    const r = await call(spec, full(spec), { token: null });
    expect(r.status).toBe(401);
    untouched(r.l, 'unsigned');
    expect(r.l.resolves).toEqual([]);
  });

  it('staff of ANOTHER store, inactive, stranger, or a body naming another store: 403, nothing called [M2]', async () => {
    for (const token of ['tok-elsewhere', 'tok-inactive', 'tok-nobody']) {
      const l = makeLobby();
      const r = await call(spec, full(spec), { token, lobby: l });
      expect(r.status, token).toBe(403);
      untouched(l, token);
    }
    const l = makeLobby();
    const r = await call(spec, full(spec, { storeId: OTHER_STORE }), { lobby: l });
    expect(r.status).toBe(403);
    untouched(l, 'other store in body');
  });

  it('missing, malformed or unlinked deviceId: 403 "This tablet is not registered for the lobby." [M3]', async () => {
    const noDevice: Record<string, unknown> = full(spec);
    delete noDevice.deviceId;
    for (const [why, body] of [['missing', noDevice], ['not a uuid', full(spec, { deviceId: 'nope' })], ['unlinked', full(spec, { deviceId: UNLINKED_DEVICE })]] as const) {
      const l = makeLobby();
      const r = await call(spec, body, { lobby: l });
      expect(r.status, why).toBe(403);
      expect(r.body.error, why).toBe(NOT_REGISTERED);
      untouched(l, why);
    }
  });

  it('a registered tablet: 200, actor is the LINK\'s ERP store + terminal person + the staffer\'s name; the body cannot choose them [M4]', async () => {
    const r = await call(spec, full(spec, { erpStoreId: 'ATTACKER-STORE', terminalPersonId: 'ATTACKER-PERSON', cashierName: 'Hacker' }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.l.calls).toHaveLength(1);
    expect(r.l.calls[0]!.fn).toBe(spec.fn);
    expect(r.l.calls[0]!.actor).toEqual({ erpStoreId: ERP_STORE, terminalPersonId: TERMINAL_PERSON, cashierName: 'Cora Cashier' });
    expect(JSON.stringify(r.l.calls[0])).not.toMatch(/ATTACKER|Hacker/);
  });

  it('a LobbyRefusal answers 409 with its one sentence only [M6]', async () => {
    const l = makeLobby({ [spec.fn]: async () => { throw new FakeLobbyRefusal('LOBBY_BIRTHDAY_CLOSED', 'That birthday request is already closed.'); } });
    const r = await call(spec, full(spec), { lobby: l });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, error: 'That birthday request is already closed.' });
  });

  it('any other error answers a plain 500 and leaks no celebrant name into the body or console [M9]', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l = makeLobby({ [spec.fn]: async () => { throw new Error(`insert failed for ${CELEBRANT}`); } });
    const r = await call(spec, full(spec), { lobby: l });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/insert failed|Lola/);
    expect(JSON.stringify(log.mock.calls)).not.toContain(CELEBRANT);
  });

  it('the route file answers 503 "POS server is not configured" when the box is not configured [M10]', async () => {
    vi.stubEnv('POS_FIREBASE_SA_KEY_FILE', '');
    vi.stubEnv('DATABASE_URL', '');
    const mod = await spec.route();
    const res = await mod.POST(post(`lobby/birthday/${spec.name}`, full(spec), 'tok-cashier'));
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ ok: false, error: 'POS server is not configured' });
  });
});

describe('per-route payloads', () => {
  const spec = (n: string) => SPECS.find((s) => s.name === n)!;

  it('list: the 200 body carries the birthdays the port returned', async () => {
    const r = await call(spec('list'), full(spec('list')));
    expect(r.body.birthdays).toHaveLength(1);
    expect(r.body.birthdays[0]).toMatchObject({ requestId: REQ, status: 'requested', code: '4821' });
  });

  it('accept / decline / play: a non-uuid or missing requestId is 400 and never reaches the port [M5]', async () => {
    for (const n of ['accept', 'decline', 'play']) {
      for (const bad of ['', 'abc', 42, null, undefined, '../../x']) {
        const l = makeLobby();
        const r = await call(spec(n), full(spec(n), { requestId: bad }), { lobby: l });
        expect(r.status, `${n} ${String(bad)}`).toBe(400);
        untouched(l, `${n} ${String(bad)}`);
      }
    }
  });

  it('accept: passes the time to the port as a Date; a past time ("Now") is allowed; garbage or a missing time is 400 [M8]', async () => {
    const ok = await call(spec('accept'), full(spec('accept')));
    expect(ok.l.calls[0]!.input).toEqual({ requestId: REQ, scheduledAt: new Date(WHEN) });
    expect(ok.body).toMatchObject({ ok: true, status: 'accepted' });
    const past = makeLobby();
    const rp = await call(spec('accept'), full(spec('accept'), { scheduledAt: '2020-01-01T00:00:00.000Z' }), { lobby: past });
    expect(rp.status).toBe(200);
    for (const bad of ['', 'tomorrow', 'not-a-date', 12345, null, undefined, {}]) {
      const l = makeLobby();
      const r = await call(spec('accept'), full(spec('accept'), { scheduledAt: bad }), { lobby: l });
      expect(r.status, String(bad)).toBe(400);
      untouched(l, String(bad));
    }
  });

  it('decline: the reason is trimmed and sent; blank, whitespace-only, over 80 and non-string are 400 before the port; exactly 80 is accepted [M7]', async () => {
    const t = await call(spec('decline'), full(spec('decline'), { reason: '  Not available today  ' }));
    expect(t.l.calls[0]!.input).toEqual({ requestId: REQ, reason: 'Not available today' });
    expect(t.body).toMatchObject({ ok: true, status: 'declined' });
    const edge = await call(spec('decline'), full(spec('decline'), { reason: 'x'.repeat(80) }));
    expect(edge.status).toBe(200);
    for (const bad of ['', '   ', 'x'.repeat(81), 7, null, undefined]) {
      const l = makeLobby();
      const r = await call(spec('decline'), full(spec('decline'), { reason: bad }), { lobby: l });
      expect(r.status, String(bad)).toBe(400);
      untouched(l, String(bad));
    }
  });

  it('play: passes only the requestId and answers played', async () => {
    const r = await call(spec('play'), full(spec('play')));
    expect(r.l.calls[0]!.input).toEqual({ requestId: REQ });
    expect(r.body).toMatchObject({ ok: true, status: 'played' });
  });
});
