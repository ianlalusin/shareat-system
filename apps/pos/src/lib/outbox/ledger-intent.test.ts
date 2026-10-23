import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeIdb, type FakeIdbFactory } from '@/test-helpers/fakeIdb';
import { saleOps } from '@/test-helpers/outbox';
import * as counter from '@/lib/terminal/counter';
import * as ledger from './ledger';

let idb: FakeIdbFactory;
beforeEach(async () => {
  idb = createFakeIdb({ commitDelayMs: 0 });
  vi.stubGlobal('indexedDB', idb);
  await counter.saveTerminalClaim({ storeId: 'S1', terminalNo: 1, deviceId: 'DEV-A', nextSeq: 5 });
});
afterEach(() => vi.unstubAllGlobals());

const args = (receiptId = 's1') => ({
  kind: 'sale' as const, storeId: 'S1', storeCode: 'SHT', receiptId,
  totalCentavos: 59800, linesHash: 'lines', intentFingerprint: 'all-payment-inputs',
  tenders: [{ method: 'Cash', centavos: 60000, toCheck: false, reference: null }],
  buildOps: vi.fn((n: { receiptNumber: string; terminalSeq: number; deviceId: string }) =>
    saleOps({ sessionId: receiptId, ...n })),
});
// Export presence is part of the target: before implementation this fails as a missing function, not a fake SDK success.
const reserve = (a = args()) => (ledger as typeof ledger & {
  reserveOfflineSaleIntent: (a: ReturnType<typeof args>) => Promise<{ event: ledger.LedgerEvent; created: boolean }>;
}).reserveOfflineSaleIntent(a);

describe('T-458 atomic offline sale intent', () => {
  it('concurrent identical requests commit one number/event/pointer and build only once', async () => {
    const a = args();
    const results = await Promise.all([reserve(a), reserve(a), reserve(a)]);
    expect(results.map(r => r.created)).toEqual([true, false, false]);
    expect(results[0]!.event).toEqual(results[1]!.event);
    expect(a.buildOps).toHaveBeenCalledTimes(1);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
    expect(idb.rows('events')).toHaveLength(1);
    expect(idb.rows('meta')).toHaveLength(1);
  });

  it('reopening the database returns the original complete ops and timestamp without rebuilding', async () => {
    const first = await reserve();
    const retry = args();
    retry.buildOps.mockImplementation(() => { throw new Error('must not rebuild'); });
    expect(await reserve(retry)).toEqual({ event: first.event, created: false });
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it.each(['intentFingerprint', 'totalCentavos', 'linesHash', 'tenders'] as const)('refuses changed %s with nothing written', async field => {
    await reserve();
    const before = structuredClone([idb.rows('terminal'), idb.rows('events'), idb.rows('meta')]);
    const changed = args();
    if (field === 'totalCentavos') changed.totalCentavos++;
    else if (field === 'tenders') changed.tenders[0]!.centavos++;
    else changed[field] += '-changed';
    await expect(reserve(changed)).rejects.toThrow('This payment differs from the sale already saved on this tablet. Sync it before taking another payment.');
    expect([idb.rows('terminal'), idb.rows('events'), idb.rows('meta')]).toEqual(before);
  });

  it.each(['reserved', 'stuck', 'rejected', 'quarantined'] as const)('refuses %s history before consuming a number', async status => {
    const original = await ledger.reserveOnlineEvent(args());
    await ledger.patchEvent(original.deviceId, original.terminalSeq, { status });
    await expect(reserve()).rejects.toThrow('This payment already has a saved attempt. Sync it before taking another payment.');
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
    expect(idb.rows('events')).toHaveLength(1);
  });

  it('preserves a confirmed skipped attempt and allocates a fresh number', async () => {
    const original = await ledger.reserveOnlineEvent(args());
    await ledger.markSkipped(original.deviceId, original.terminalSeq);
    expect((await reserve()).event.terminalSeq).toBe(6);
    expect(idb.rows('events').map(e => e.status)).toEqual(['skipped', 'unsent']);
  });

  it('does not infer equality for an old unsent event without a fingerprint/pointer', async () => {
    await ledger.reserveOfflineEvent(args());
    await expect(reserve()).rejects.toThrow('This payment already has a saved attempt. Sync it before taking another payment.');
    expect(idb.rows('events')).toHaveLength(1);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('switching online cannot reserve another number for a durable offline intent', async () => {
    await reserve();
    await expect(ledger.reserveOnlineEvent(args())).rejects.toThrow('This payment already has a saved attempt. Sync it before taking another payment.');
    expect(idb.rows('events')).toHaveLength(1);
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('acknowledged retries reuse the number, and pruning leaves a blocking tombstone', async () => {
    const first = await reserve();
    await ledger.markAcknowledged(first.event.deviceId, first.event.terminalSeq);
    expect(await reserve()).toMatchObject({ created: false, event: { status: 'acknowledged', terminalSeq: 5 } });
    await ledger.pruneLedger(first.event.createdAtClientMs + ledger.PRUNE_AFTER_MS + 1);
    expect(idb.rows('events')).toHaveLength(0);
    expect(idb.rows('meta')).toHaveLength(1);
    await expect(reserve()).rejects.toThrow('This payment already has a saved attempt. Sync it before taking another payment.');
    expect(idb.rows('terminal')[0].nextSeq).toBe(6);
  });

  it('storage failure rolls back all three stores; a fresh attempt uses the unconsumed number', async () => {
    idb.failNextTransaction();
    await expect(reserve()).rejects.toThrow(ledger.SALE_NOT_SAVED_MESSAGE);
    expect(idb.rows('terminal')[0].nextSeq).toBe(5);
    expect(idb.rows('events')).toEqual([]);
    expect(idb.rows('meta')).toEqual([]);
    expect((await reserve()).event.terminalSeq).toBe(5);
  });

  it('refuses another store while separate receipts get distinct numbers', async () => {
    await expect(reserve({ ...args(), storeId: 'OTHER' })).rejects.toThrow('This terminal belongs to another store. Set up this store before taking payment.');
    const [a, b] = await Promise.all([reserve(args('s1')), reserve(args('s2'))]);
    expect([a.event.terminalSeq, b.event.terminalSeq]).toEqual([5, 6]);
    expect(idb.rows('meta')).toHaveLength(2);
  });
});
