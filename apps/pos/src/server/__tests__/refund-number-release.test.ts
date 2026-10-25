/**
 * T-474 (DEF-756) - POST /api/pos2/refund-numbers/release: a refund number is CLOSED on the server before the tablet calls it unused.
 * docs/tasks/474-pos-refund-final-outcome-and-z-fixes.md Finding 5. Module: @/server/pos2/refund-number-release, export handleRefundNumberRelease.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, SAME_DAY, STORE, createFakeFirestore, json, makeDeps, post, PIN_OK, seedSale, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';

vi.mock('server-only', () => ({}));

let fs: FakeFirestore;
const NUM = 'SHT-01-000002';
const numPath = (n = NUM) => `stores/${STORE}/receiptNumbers/${n}`;
const body = (over: Record<string, unknown> = {}) => ({ storeId: STORE, deviceId: DEVICE, terminalNo: 1, terminalSeq: 2, receiptNumber: NUM, ...over });

async function release(b: Record<string, unknown>, token: string | null = 'tok-cashier', over: Record<string, unknown> = {}) {
  const d = makeDeps(fs, { nowMs: () => SAME_DAY, ...over });
  const { handleRefundNumberRelease } = await import('@/server/pos2/refund-number-release');
  const res = await handleRefundNumberRelease(post('refund-numbers/release', b, token), d.deps as any);
  return { status: res.status, body: await json(res), calls: d.calls };
}
async function refund(b: Record<string, unknown> = {}) {
  const d = makeDeps(fs, { nowMs: () => SAME_DAY });
  const { handleRefund } = await import('@/server/pos2/refunds');
  const res = await handleRefund(post('refunds', {
    storeId: STORE, parentReceiptId: 'r1', lines: [{ lineId: 'l1', qty: 1 }], tenderMethodId: 'm-cash', reason: 'returned',
    terminalNo: 1, terminalSeq: 2, receiptNumber: NUM, pin: PIN_OK, deviceId: DEVICE, ...b,
  }, 'tok-cashier'), d.deps as any);
  return { status: res.status, body: await json(res) };
}

beforeEach(async () => {
  fs = createFakeFirestore();
  seedStaff(fs);
  seedStore(fs);
  await seedSale(fs, { id: 'r1', lines: [{ id: 'l1', unit: 100, qty: 3 }], total: 300 });
});

describe('DEF-756 - release closes an unused refund number', () => {
  it('absent -> creates the closed number document and answers released', async () => {
    const r = await release(body());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, state: 'released', terminalSeq: 2 });
    expect(fs.get(numPath())).toMatchObject({ released: true, kind: 'refund-number-released', terminalNo: 1, terminalSeq: 2, releasedBy: { uid: 'cashier', role: 'cashier' } });
    expect(r.calls.approve, 'no PIN: it moves no money').toHaveLength(0);
  });

  it('is idempotent: a second release answers released and writes nothing', async () => {
    await release(body());
    const writes = () => fs.commits.flatMap((c) => c.writes).length;
    const before = writes();
    const r = await release(body());
    expect(r.body).toMatchObject({ ok: true, state: 'released', terminalSeq: 2 });
    expect(writes()).toBe(before);
  });

  it('a number a refund already used answers used (with the stored receipt id) and is not changed', async () => {
    const a = await refund();
    expect(a.status).toBe(200);
    const before = JSON.stringify(fs.get(numPath()));
    const r = await release(body());
    expect(r.body).toMatchObject({ ok: true, state: 'used', terminalSeq: 2, receiptId: a.body.refundReceiptId });
    expect(JSON.stringify(fs.get(numPath()))).toBe(before);
  });

  it('release first: a later refund with that number is refused and writes no receipt', async () => {
    await release(body());
    const receiptsBefore = fs.list(`stores/${STORE}/receipts`).length;
    const r = await refund();
    expect(r.status).toBe(409);
    expect(fs.list(`stores/${STORE}/receipts`)).toHaveLength(receiptsBefore);
    expect(fs.get(numPath())).toMatchObject({ released: true });
  });

  it('validation: bad terminalNo / terminalSeq / mismatching number are 400 and nothing is written', async () => {
    for (const bad of [{ terminalNo: 0 }, { terminalNo: 100 }, { terminalSeq: 0 }, { terminalSeq: 1_000_000 }, { receiptNumber: 'SHT-01-000003' }, { receiptNumber: '' }]) {
      const r = await release(body(bad));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(fs.list(`stores/${STORE}/receiptNumbers`)).toHaveLength(0);
  });

  it('roles and store: no token 401-ish, kitchen refused, a store the caller cannot access refused', async () => {
    fs.seed('staff/kitchen', { uid: 'kitchen', status: 'active', role: 'kitchen', assignedStoreIds: [STORE], displayName: 'Kim' });
    for (const [tok, why] of [[null, 'no token'], ['tok-kitchen', 'kitchen'], ['tok-elsewhere', 'other store']] as const) {
      const r = await release(body(), tok);
      expect(r.status, why).toBeGreaterThanOrEqual(400);
      expect(r.status, why).toBeLessThan(500);
    }
    expect(fs.get(numPath())).toBeUndefined();
    expect((await release(body(), 'tok-manager')).status).toBe(200);
  });
});

describe('DEF-771 (T-477) - release is bound to the caller\'s registered terminal and a plausible sequence', () => {
  const numbers = () => fs.list(`stores/${STORE}/receiptNumbers`);
  const seqNum = (n: number, tt = '01') => `SHT-${tt}-${String(n).padStart(6, '0')}`;
  /** Existing numbers for terminal 1 with highest seq 5 (a used one and a released tombstone), plus terminal 2 noise at 50000. */
  const seedHigh = () => {
    fs.seed(numPath(seqNum(3)), { receiptId: 'rX', terminalNo: 1, terminalSeq: 3 });
    fs.seed(numPath(seqNum(5)), { released: true, kind: 'refund-number-released', terminalNo: 1, terminalSeq: 5 });
    fs.seed(numPath(seqNum(50000, '02')), { receiptId: 'rY', terminalNo: 2, terminalSeq: 50000 });
  };

  it('missing / invalid deviceId -> 400 and nothing is written', async () => {
    for (const bad of [{ deviceId: undefined }, { deviceId: 'not-a-uuid' }, { deviceId: 7 }]) {
      const r = await release(body(bad));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(numbers()).toHaveLength(0);
  });

  it('the device is resolved through the trusted link port, with the store and device from the request', async () => {
    const r = await release(body());
    expect(r.status).toBe(200);
    expect(r.calls.terminal).toEqual([{ posStoreId: STORE, deviceId: DEVICE }]);
  });

  it('a device with no registered link -> 403 and no tombstone', async () => {
    const r = await release(body(), 'tok-cashier', { resolveTerminalNo: async () => null });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/not registered/i);
    expect(numbers()).toHaveLength(0);
  });

  it('a tablet registered for terminal 2 cannot close a terminal-1 number -> 403 and no tombstone', async () => {
    const r = await release(body(), 'tok-cashier', { resolveTerminalNo: async () => 2 });
    expect(r.status).toBe(403);
    expect(numbers()).toHaveLength(0);
  });

  it('a link lookup that fails (not "no link") is not turned into an answer: the route does not write', async () => {
    const r = await release(body(), 'tok-cashier', { resolveTerminalNo: async () => { throw new Error('db down'); } });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(numbers()).toHaveLength(0);
  });

  it('terminalSeq 999999 with highest existing seq 5 -> 409 and no tombstone (the claim cannot be poisoned)', async () => {
    seedHigh();
    const before = numbers().length;
    const r = await release(body({ terminalSeq: 999999, receiptNumber: seqNum(999999) }));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/too far ahead/i);
    expect(numbers()).toHaveLength(before);
    expect(fs.get(numPath(seqNum(999999)))).toBeUndefined();
  });

  it('the window edge: highest + 1000 is allowed, highest + 1001 is refused (tombstones count; other terminals do not)', async () => {
    seedHigh();
    // Refused first: a successful release is itself a tombstone and raises the highest number.
    const tooFar = await release(body({ terminalSeq: 1006, receiptNumber: seqNum(1006) }));
    expect(tooFar.status).toBe(409);
    expect(fs.get(numPath(seqNum(1006)))).toBeUndefined();
    const ok = await release(body({ terminalSeq: 1005, receiptNumber: seqNum(1005) }));
    expect(ok.status).toBe(200);
    expect(fs.get(numPath(seqNum(1005)))).toMatchObject({ released: true, terminalSeq: 1005 });
  });

  it('a store with no numbers yet: highest is 0, so 1001 is refused and 1000 is allowed', async () => {
    expect((await release(body({ terminalSeq: 1001, receiptNumber: seqNum(1001) }))).status).toBe(409);
    expect((await release(body({ terminalSeq: 1000, receiptNumber: seqNum(1000) }))).status).toBe(200);
  });
});
