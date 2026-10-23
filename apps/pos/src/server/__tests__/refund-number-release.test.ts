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

async function release(b: Record<string, unknown>, token: string | null = 'tok-cashier') {
  const d = makeDeps(fs, { nowMs: () => SAME_DAY });
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
