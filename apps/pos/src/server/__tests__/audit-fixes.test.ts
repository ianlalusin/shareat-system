/**
 * T-424 audit fixes (refunds): the money cap across refunds, a negative line weight, and the terminal number matching the registration.
 * Each test fails without its fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE, PIN_OK, STORE, createFakeFirestore, json, makeDeps, post, seedRefundRecord, seedSale, seedStaff, seedStore } from '@/test-helpers/pos2';
import type { FakeFirestore } from '@/test-helpers/fakeFirestore';
import { paidShares } from '@/lib/money/refundShare';

vi.mock('server-only', () => ({}));

const body = (over: Record<string, unknown> = {}) => ({
  storeId: STORE, parentReceiptId: 'r1', lines: [{ lineId: 'l1', qty: 1 }], tenderMethodId: 'm-cash', reason: 'returned',
  terminalNo: 1, terminalSeq: 2, receiptNumber: 'SHT-01-000002', pin: PIN_OK, deviceId: DEVICE, ...over,
});
async function refund(fs: FakeFirestore, b: Record<string, unknown>, deps = makeDeps(fs)) {
  const { handleRefund } = await import('@/server/pos2/refunds');
  const res = await handleRefund(post('refunds', b, 'tok-cashier'), deps.deps as any);
  return { status: res.status, body: await json(res) };
}
let fs: FakeFirestore;
beforeEach(() => { fs = createFakeFirestore(); seedStaff(fs); seedStore(fs); });

describe('refunds of one receipt can never add up to more than its total (money cap)', () => {
  it('a refund that would push the sum past the total is refused with a plain 409', async () => {
    await seedSale(fs, { id: 'r1', lines: [{ id: 'l1', unit: 50, qty: 2 }], total: 100 });
    seedRefundRecord(fs, 'prev', 'r1', [{ id: 'other', qty: 1, unit: 90 }], 90); // 90 already paid back on a line the unit counts do not see
    const r = await refund(fs, body());
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/more than the customer paid/);
    expect(fs.list(`stores/${STORE}/receipts`).filter((d) => d.data.isRefund)).toHaveLength(1);
  });
});

describe('a negative line weight is not a 500', () => {
  it('paidShares clamps a negative net to 0 and shares the total over the other lines', () => {
    expect(paidShares([{ id: 'a', qtyOrdered: 1, unitPrice: 100 }, { id: 'b', qtyOrdered: 1, unitPrice: -20 }], 80)).toEqual([8000, 0]);
    expect(paidShares([{ id: 'b', qtyOrdered: 1, unitPrice: -20 }], 80)).toBeNull();
  });
  it('the route refunds the positive line, and refuses with 409 when every weight is 0', async () => {
    await seedSale(fs, { id: 'r1', lines: [{ id: 'l1', unit: 100, qty: 1 }, { id: 'l2', unit: -20, qty: 1 }], total: 80 });
    const ok = await refund(fs, body());
    expect(ok.status).toBe(200);
    expect(ok.body.refundTotalCentavos).toBe(8000);
    const fs2 = createFakeFirestore(); seedStaff(fs2); seedStore(fs2);
    await seedSale(fs2, { id: 'r1', lines: [{ id: 'l2', unit: -20, qty: 1 }], total: 80 });
    const none = await refund(fs2, body({ lines: [{ lineId: 'l2', qty: 1 }] }));
    expect(none.status).toBe(409);
  });
});

describe("the body's terminalNo must equal the registered link's", () => {
  it('a different terminal number is a 400 and nothing is written', async () => {
    await seedSale(fs, { id: 'r1', lines: [{ id: 'l1', unit: 100, qty: 1 }], total: 100 });
    const d = makeDeps(fs, { approveManagerPin: async () => ({ ok: true, approverPersonId: 'p', terminalNo: 2 }) });
    const r = await refund(fs, body({ terminalNo: 1 }), d);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/terminal number/i);
    expect(fs.list(`stores/${STORE}/receipts`).filter((x) => x.data.isRefund)).toHaveLength(0);
    const same = await refund(fs, body({ terminalNo: 2, receiptNumber: 'SHT-02-000002' }), d);
    expect(same.status).toBe(200);
  });
});
