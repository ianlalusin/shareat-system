/**
 * T-455 S7b (TESTER) - the POS v2 claim routes: POST /api/pos2/lobby/{claims,claim-open,claim-approve,claim-reject}.
 * docs/tasks/455-customer-lobby.md S7b row, "S5 rulings" 1-2, 5 (same trust chain) and "S7a rulings". Same fake-port style as lobby-routes.test.ts
 * (no database: the domain's claims.ts is covered by S7a; the terminal door's other-store refusal answers like a ghost id there).
 *
 * RED FOR THE RIGHT REASON: the four handlers do not exist in `@/server/pos2/lobby` and the four route files do not exist, so each case fails
 * ("handler is not a function" / "Failed to resolve import").
 *
 * ASSUMPTIONS NEEDING A RULING
 *  1. Routes (all POST, JSON, body carries { storeId, deviceId } like the other lobby routes), file per route under app/api/pos2/lobby/:
 *       claims         {}                                                        -> 200 { ok, claims: ClaimListRow[] }   (pending claims of the tablet's ERP store, masked)
 *       claim-open     { claimId }                                               -> 200 { ok, ...OpenClaimView }         (the ONLY answer with name + ID number)
 *       claim-approve  { claimId, cardSeen, sessionId, statutoryDinerId }        -> 200 { ok, claimId, status: 'approved' }
 *       claim-reject   { claimId, reasonCode }                                   -> 200 { ok, claimId, status: 'rejected' }
 *  2. Handlers `handleLobbyClaims | handleLobbyClaimOpen | handleLobbyClaimApprove | handleLobbyClaimReject` in @/server/pos2/lobby, sharing `run()`
 *     (same auth, deviceId, tablet resolution, refusal -> 409, other error -> plain 500, 503 when unconfigured).
 *  3. Pos2LobbyPort gains: claims(a) | claimOpen(a, { claimId }) | claimApprove(a, { claimId, cardSeen, sessionRef, statutoryDinerRef }) |
 *     claimReject(a, { claimId, reason }); the route renames sessionId -> sessionRef and statutoryDinerId -> statutoryDinerRef.
 *  4. claimId must be a uuid (400 before the port otherwise). approve: cardSeen must be the boolean true (400 otherwise: the route is a second
 *     belt over the domain), sessionId and statutoryDinerId non-blank strings, statutoryDinerId <= 80 chars.
 *  5. reject takes `reasonCode` (from LOBBY_REJECT_REASONS in @/lib/pos2/lobbyClaims); the ROUTE turns it into the fixed sentence and passes `reason`
 *     to the port. An unknown code, or a free-text `reason` in the body, is a 400 / ignored: free text can never reach the port or the diner.
 *  6. claim-open answers with `Cache-Control: no-store` (it carries a name and an ID number); the other three need not.
 *  7. The claims list route whitelists its fields (a port that leaked holderName / idNumber would not reach the tablet's list).
 *  8. Logs: no diner name or ID number in console.error on an unexpected failure (like S5 M10); the error NAME only.
 *
 * MUTANTS: M1 no bearer accepted; M2 other-store staff accepted; M3 tablet not resolved / bad deviceId reaches the port; M4 ERP store / person / cashier
 *   from the body; M5 refusal answered 500 or with its internal message; M6 free-text reason reaches the port; M7 cardSeen coerced ("true", 1);
 *   M8 non-uuid claimId reaches the port; M9 PII in the list or in logs; M10 claim-open cached; M11 crash instead of 503.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, OTHER_STORE, STORE, createFakeFirestore, json, makeDeps, post, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';
import { LOBBY_REJECT_REASONS } from '@/lib/pos2/lobbyClaims';

vi.mock('server-only', () => ({}));

const NOT_REGISTERED = 'This tablet is not registered for the lobby.';
const ERP_STORE = '019e1111-1111-7111-8111-111111111111';
const TERMINAL_PERSON = '019e2222-2222-7222-8222-222222222222';
const UNLINKED_DEVICE = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
const CLAIM = '019e4444-4444-7444-8444-444444444444';
const HOLDER = 'Maria Santos';
const ID_NO = '123-456-1187';

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
    claims: async (a: unknown) => {
      calls.push({ fn: 'claims', actor: a });
      return { claims: [{ claimId: CLAIM, entryId: 'e1', code: '4821', displayName: 'Ana', standLabel: '7', partySize: 5, kind: 'senior', idMasked: '****1187', ocrAssisted: false, status: 'pending', createdAt: '2026-11-02T03:00:00.000Z', holderName: HOLDER, idNumber: ID_NO }] };
    },
    claimOpen: async (a: unknown, i: unknown) => {
      calls.push({ fn: 'claimOpen', actor: a, input: i });
      return { claimId: CLAIM, entryId: 'e1', code: '4821', kind: 'senior', holderName: HOLDER, idNumber: ID_NO, idLast4: '1187', ocrAssisted: false, partySize: 5, standLabel: '7', sessionRef: 'SESS-1' };
    },
    claimApprove: async (a: unknown, i: unknown) => { calls.push({ fn: 'claimApprove', actor: a, input: i }); return { claimId: CLAIM, status: 'approved' }; },
    claimReject: async (a: unknown, i: unknown) => { calls.push({ fn: 'claimReject', actor: a, input: i }); return { claimId: CLAIM, status: 'rejected' }; },
    ...over,
  };
  return { lobby, calls, resolves };
}

interface RouteSpec { name: string; fn: string; handler: string; route: () => Promise<{ POST: (r: Request) => Promise<Response> }>; body: Record<string, unknown> }
const SPECS: RouteSpec[] = [
  { name: 'claims', fn: 'claims', handler: 'handleLobbyClaims', route: () => import('@/app/api/pos2/lobby/claims/route'), body: {} },
  { name: 'claim-open', fn: 'claimOpen', handler: 'handleLobbyClaimOpen', route: () => import('@/app/api/pos2/lobby/claim-open/route'), body: { claimId: CLAIM } },
  { name: 'claim-approve', fn: 'claimApprove', handler: 'handleLobbyClaimApprove', route: () => import('@/app/api/pos2/lobby/claim-approve/route'), body: { claimId: CLAIM, cardSeen: true, sessionId: 'SESS-1', statutoryDinerId: 'diner-1' } },
  { name: 'claim-reject', fn: 'claimReject', handler: 'handleLobbyClaimReject', route: () => import('@/app/api/pos2/lobby/claim-reject/route'), body: { claimId: CLAIM, reasonCode: 'id_mismatch' } },
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
  return { status: res.status, body: await json(res), headers: res.headers, l };
}
const full = (spec: RouteSpec, over: Record<string, unknown> = {}) => ({ storeId: STORE, deviceId: DEVICE, ...spec.body, ...over });
const untouched = (l: ReturnType<typeof makeLobby>, why: string) => {
  expect(l.calls, `${why}: the port was called`).toEqual([]);
};
const spec = (n: string) => SPECS.find((s) => s.name === n)!;

describe.each(SPECS.map((s) => [s.name, s] as const))('%s', (_n, sp) => {
  it('no bearer token: 401, nothing resolved or called [kills: M1]', async () => {
    const r = await call(sp, full(sp), { token: null });
    expect(r.status).toBe(401);
    untouched(r.l, 'unsigned');
    expect(r.l.resolves).toEqual([]);
  });

  it('staff of another store, an inactive account, a stranger, or a body naming a store they are not on: 403, nothing resolved or called [kills: M2]', async () => {
    for (const token of ['tok-elsewhere', 'tok-inactive', 'tok-nobody']) {
      const l = makeLobby();
      const r = await call(sp, full(sp), { token, lobby: l });
      expect(r.status, token).toBe(403);
      untouched(l, token);
      expect(l.resolves, token).toEqual([]);
    }
    const l = makeLobby();
    const r = await call(sp, full(sp, { storeId: OTHER_STORE }), { lobby: l });
    expect(r.status).toBe(403);
    untouched(l, 'body names another store');
  });

  it('missing, malformed or unlinked deviceId: 403 "This tablet is not registered for the lobby." [kills: M3]', async () => {
    const missing: Record<string, unknown> = full(sp);
    delete missing.deviceId;
    for (const [why, body] of [['missing', missing], ['not a uuid', full(sp, { deviceId: 'nope' })], ['unlinked', full(sp, { deviceId: UNLINKED_DEVICE })]] as const) {
      const l = makeLobby();
      const r = await call(sp, body, { lobby: l });
      expect(r.status, why).toBe(403);
      expect(r.body.error, why).toBe(NOT_REGISTERED);
      untouched(l, why);
    }
  });

  it("a registered tablet: 200; the actor is the LINK's ERP store + terminal person and the staffer's name from Firestore; the body chooses none of them [kills: M4]", async () => {
    const r = await call(sp, full(sp, { erpStoreId: 'ATTACKER-STORE', orgId: 'ATTACKER-ORG', terminalPersonId: 'ATTACKER-PERSON', cashierName: 'Hacker' }));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.l.resolves).toEqual([{ posStoreId: STORE, deviceId: DEVICE }]);
    expect(r.l.calls).toHaveLength(1);
    expect(r.l.calls[0]!.fn).toBe(sp.fn);
    expect(r.l.calls[0]!.actor).toEqual({ erpStoreId: ERP_STORE, terminalPersonId: TERMINAL_PERSON, cashierName: 'Cora Cashier' });
    expect(JSON.stringify(r.l.calls[0])).not.toMatch(/ATTACKER|Hacker/);
  });

  it("a LobbyRefusal (including another store's claim, which answers like a ghost id) is a 409 with its one sentence, never its internal message [kills: M5]", async () => {
    const l = makeLobby({ [sp.fn]: async () => { throw new FakeLobbyRefusal('LOBBY_NOT_FOUND', 'We could not find that claim.'); } });
    const r = await call(sp, full(sp), { lobby: l });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, error: 'We could not find that claim.' });
  });

  it('any other error: plain 500, no name / ID number in the body or in console.error [kills: M9]', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l = makeLobby({ [sp.fn]: async () => { throw new Error(`update failed for ${HOLDER} ${ID_NO}`); } });
    const r = await call(sp, full(sp), { lobby: l });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/update failed|Maria|123-456/);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged.includes(HOLDER) || logged.includes(ID_NO), 'a name or ID number reached console.error').toBe(false);
  });

  it('the route file answers 503 "POS server is not configured", never a crash [kills: M11]', async () => {
    vi.stubEnv('POS_FIREBASE_SA_KEY_FILE', '');
    vi.stubEnv('DATABASE_URL', '');
    const mod = await sp.route();
    const res = await mod.POST(post(`lobby/${sp.name}`, full(sp), 'tok-cashier'));
    expect(res.status).toBe(503);
    expect(await json(res)).toMatchObject({ ok: false, error: 'POS server is not configured' });
  });
});

describe('claim id checks', () => {
  it('open / approve / reject: a claimId that is not a uuid is a 400 before the port [kills: M8]', async () => {
    for (const n of ['claim-open', 'claim-approve', 'claim-reject']) {
      for (const bad of ['4821', 'abc', '', 7, null, undefined]) {
        const l = makeLobby();
        const r = await call(spec(n), full(spec(n), { claimId: bad }), { lobby: l });
        expect(r.status, `${n} ${String(bad)}`).toBe(400);
        untouched(l, `${n} ${String(bad)}`);
      }
    }
  });
});

describe('claims (the list)', () => {
  it('200 carries the rows with ****last4 and drops anything beyond the list fields (name, ID number) [kills: M9]', async () => {
    const r = await call(spec('claims'), full(spec('claims')));
    expect(r.body.claims).toHaveLength(1);
    expect(r.body.claims[0]).toMatchObject({ claimId: CLAIM, entryId: 'e1', code: '4821', kind: 'senior', idMasked: '****1187', status: 'pending' });
    expect(JSON.stringify(r.body)).not.toMatch(/Maria|Santos|123-456|holderName|idNumber/);
  });
});

describe('claim-open', () => {
  it('passes the claim id only and answers the name and ID number, uncacheable [kills: M10]', async () => {
    const r = await call(spec('claim-open'), full(spec('claim-open')));
    expect(r.l.calls[0]!.input).toEqual({ claimId: CLAIM });
    expect(r.body).toMatchObject({ ok: true, holderName: HOLDER, idNumber: ID_NO, sessionRef: 'SESS-1' });
    expect(r.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });
});

describe('claim-approve', () => {
  it('renames sessionId -> sessionRef and statutoryDinerId -> statutoryDinerRef, passes cardSeen true, trims', async () => {
    const r = await call(spec('claim-approve'), full(spec('claim-approve'), { sessionId: '  SESS-1 ', statutoryDinerId: ' diner-1 ' }));
    expect(r.body).toMatchObject({ ok: true, status: 'approved' });
    expect(r.l.calls[0]!.input).toEqual({ claimId: CLAIM, cardSeen: true, sessionRef: 'SESS-1', statutoryDinerRef: 'diner-1' });
  });

  it('cardSeen must be the boolean true: false, "true", 1, null and missing are 400 before the port [kills: M7]', async () => {
    for (const bad of [false, 'true', 1, null, undefined]) {
      const l = makeLobby();
      const r = await call(spec('claim-approve'), full(spec('claim-approve'), { cardSeen: bad }), { lobby: l });
      expect(r.status, String(bad)).toBe(400);
      untouched(l, String(bad));
    }
  });

  it('a blank / missing / non-string session or diner id, or a diner id over 80 chars, is a 400 before the port', async () => {
    for (const over of [{ sessionId: '' }, { sessionId: '  ' }, { sessionId: 5 }, { sessionId: undefined }, { statutoryDinerId: '' }, { statutoryDinerId: 9 }, { statutoryDinerId: undefined }, { statutoryDinerId: 'x'.repeat(81) }]) {
      const l = makeLobby();
      const r = await call(spec('claim-approve'), full(spec('claim-approve'), over), { lobby: l });
      expect(r.status, JSON.stringify(over)).toBe(400);
      untouched(l, JSON.stringify(over));
    }
  });
});

describe('claim-reject', () => {
  it('every fixed code is turned into its fixed sentence by the ROUTE; the port gets `reason`, never a code or typed text [kills: M6]', async () => {
    for (const r0 of LOBBY_REJECT_REASONS) {
      const r = await call(spec('claim-reject'), full(spec('claim-reject'), { reasonCode: r0.code }));
      expect(r.body).toMatchObject({ ok: true, status: 'rejected' });
      expect(r.l.calls[0]!.input).toEqual({ claimId: CLAIM, reason: r0.label });
    }
  });

  it('an unknown code or missing code is a 400; a free-text `reason` in the body never reaches the port [kills: M6]', async () => {
    for (const bad of ['rude', 'The ID number did not match the card.', '', 7, null, undefined]) {
      const l = makeLobby();
      const r = await call(spec('claim-reject'), full(spec('claim-reject'), { reasonCode: bad }), { lobby: l });
      expect(r.status, String(bad)).toBe(400);
      untouched(l, String(bad));
    }
  });

  // S7b ruling 4 (amends the tester's "ignored"): free text in the body is REFUSED so a client bug is visible, and never reaches the port.
  it('a body carrying free text (`reason`, `note`, `text`, `message`) is a 400 and the port is never called [kills: M6]', async () => {
    for (const key of ['reason', 'note', 'text', 'message']) {
      const l = makeLobby();
      const r = await call(spec('claim-reject'), full(spec('claim-reject'), { [key]: 'Maria lied about her age' }), { lobby: l });
      expect(r.status, key).toBe(400);
      untouched(l, key);
    }
  });
});
