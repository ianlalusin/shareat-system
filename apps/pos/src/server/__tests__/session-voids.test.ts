/**
 * T-424 slice T - POST /api/pos2/session-voids. Acceptance 8 (cashier without PIN refused; manager role or manager PIN passes; paid session refused).
 * Contract: header of `@/test-helpers/pos2`. The route runs T-423's transactional voidSession logic with the Admin SDK: tickets and the table are
 * re-read INSIDE the transaction, the table is freed only if it still points at this session.
 *
 * RED FOR THE RIGHT REASON: `@/server/pos2/session-voids` does not exist yet.
 * MUTANTS: M1 any signed-in staff may void; M2 body role trusted; M3 PIN not checked; M4 paid/closed session voided; M5 table freed without the
 *   currentSessionId check; M6 a ticket served in the meantime is cancelled; M7 write before the PIN check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, PIN_BAD, PIN_OK, STORE, createFakeFirestore, json, makeDeps, post, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';
import { seedSession } from '@/test-helpers/posFixtures';

vi.mock('server-only', () => ({}));

let fs: FakeFirestore;
const SP = `stores/${STORE}/sessions/sess1`;
const TABLE = `stores/${STORE}/tables/t1`;
const TABLE_PROJ = `stores/${STORE}/storeConfig/current/tables/t1`;
const body = (over: Record<string, unknown> = {}) => ({ storeId: STORE, sessionId: 'sess1', reason: 'walk-out', pin: PIN_OK, deviceId: DEVICE, ...over });
const noPin = (over: Record<string, unknown> = {}) => {
  const { pin: _p, deviceId: _d, ...rest } = body(over);
  return rest;
};

async function voidIt(b: Record<string, unknown>, token = 'tok-cashier') {
  const d = makeDeps(fs);
  const { handleSessionVoid } = await import('@/server/pos2/session-voids');
  const res = await handleSessionVoid(post('session-voids', b, token), d.deps as any);
  return { status: res.status, body: await json(res), calls: d.calls };
}
const ticket = (id: string) => fs.get(`${SP}/kitchentickets/${id}`)!;
const sessionUntouched = () => {
  expect(fs.get(SP)).toMatchObject({ status: 'active' });
  expect(fs.get(TABLE)).toMatchObject({ status: 'occupied', currentSessionId: 'sess1' });
  expect(fs.commits).toHaveLength(0);
};

beforeEach(() => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
  seedSession(fs, { tickets: [{ id: 'k1', status: 'preparing' }, { id: 'k2', status: 'ready' }, { id: 'k3', status: 'served' }] });
});

describe('Acceptance 8 - who may void an unpaid session', () => {
  it('a cashier WITHOUT a PIN is refused and nothing changes (M1, M3)', async () => {
    const r = await voidIt(noPin());
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.body.ok).toBe(false);
    sessionUntouched();
    expect(r.calls.approve).toHaveLength(0);
  });

  it("a body that claims role manager does not make a cashier a manager (M2)", async () => {
    const r = await voidIt({ ...noPin(), role: 'manager', staffRole: 'admin' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    sessionUntouched();
  });

  it('a cashier with a WRONG manager PIN: 403 with the approval message, nothing written (M7)', async () => {
    const r = await voidIt(body({ pin: PIN_BAD }));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('That PIN cannot approve this. Ask a store manager.');
    sessionUntouched();
  });

  it('a cashier with a right manager PIN voids the session: tickets cancelled, table freed, projection moved', async () => {
    const r = await voidIt(body());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sessionId: 'sess1' });
    expect(r.calls.approve).toEqual([{ posStoreId: STORE, deviceId: DEVICE, pin: PIN_OK }]);
    expect(fs.get(SP)).toMatchObject({ status: 'voided', voidReason: 'walk-out', voidedByUid: 'cashier' });
    expect(ticket('k1').status).toBe('cancelled');
    expect(ticket('k2').status).toBe('cancelled');
    expect(ticket('k3').status).toBe('served');
    expect(fs.get(TABLE)).toMatchObject({ status: 'available', currentSessionId: null });
    expect(fs.get(TABLE_PROJ)).toMatchObject({ status: 'available', currentSessionId: null });
    expect(fs.has(`stores/${STORE}/activeSessions/sess1`)).toBe(false);
    expect(fs.get(`stores/${STORE}/closedSessions/sess1`)).toMatchObject({ status: 'voided' });
    expect(JSON.stringify([...fs.docs.entries()]).includes(PIN_OK), 'no PIN stored').toBe(false);
  });

  it.each(['tok-manager', 'tok-admin'])('%s: a manager or admin by STAFF ROLE voids without a PIN, and the approval port is not asked', async (token) => {
    const r = await voidIt(noPin(), token);
    expect(r.status).toBe(200);
    expect(r.calls.approve).toHaveLength(0);
    expect(fs.get(SP)).toMatchObject({ status: 'voided', voidedByUid: token.slice(4) });
  });

  it('a PAID or closed or already-voided session is refused (M4)', async () => {
    for (const patch of [{ isPaid: true, status: 'closed' }, { status: 'closed' }, { status: 'voided' }, { isPaid: true }]) {
      const f = createFakeFirestore();
      seedStaff(f);
      seedStore(f);
      seedSession(f);
      f.seed(SP, { ...f.get(SP)!, ...patch });
      fs = f;
      const r = await voidIt(body(), 'tok-manager');
      expect(r.status, JSON.stringify(patch)).toBe(409);
      expect(r.body.ok).toBe(false);
      expect(fs.get(TABLE)).toMatchObject({ status: 'occupied', currentSessionId: 'sess1' });
      expect(fs.commits).toHaveLength(0);
    }
  });

  it('an unknown session is a 404; a blank reason is a 400', async () => {
    expect((await voidIt(body({ sessionId: 'ghost' }), 'tok-manager')).status).toBe(404);
    expect((await voidIt(body({ reason: '  ' }), 'tok-manager')).status).toBe(400);
    expect(fs.commits).toHaveLength(0);
  });
});

describe('Acceptance 8 - the T-423 races, now on the server', () => {
  it('a ticket served and a table re-seated between the first read and the commit: the ticket is left alone and the other session keeps its table (M5, M6)', async () => {
    fs.seed(`stores/${STORE}/sessions/other`, { status: 'active', isPaid: false, tableId: 't1' });
    fs.beforeNextTransaction(() => {
      fs.seed(`${SP}/kitchentickets/k1`, { ...ticket('k1'), status: 'served' });
      fs.seed(TABLE, { status: 'occupied', currentSessionId: 'other' });
    });
    const r = await voidIt(body(), 'tok-manager');
    expect(r.status).toBe(200);
    expect(ticket('k1').status, 'served in the meantime: not cancelled').toBe('served');
    expect(ticket('k2').status).toBe('cancelled');
    expect(fs.get(TABLE), "re-seated to another session: not freed").toMatchObject({ status: 'occupied', currentSessionId: 'other' });
    expect(fs.get(SP)).toMatchObject({ status: 'voided' });
  });

  it('a transaction retry does not double-apply', async () => {
    fs.retryNextTransaction();
    const r = await voidIt(body(), 'tok-manager');
    expect(r.status).toBe(200);
    expect(fs.get(SP)).toMatchObject({ status: 'voided' });
    expect(fs.commits.filter((c) => c.kind === 'transaction')).toHaveLength(1);
  });
});
