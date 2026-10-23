import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFirestore, firebaseFirestoreModule, setActiveFake } from '@/test-helpers/fakeFirestore';

vi.mock('firebase/firestore', () => firebaseFirestoreModule());
vi.mock('@/lib/firebase/client', () => ({ db: {} }));
import { commitHandover, readHandoverAttempt, saveHandoverAttempt, type HandoverAttempt } from './handover-submit';

const attempt: HandoverAttempt = {
  id: 'b2d1d320-23b6-4c4a-81a7-67f822059e1c', storeId: 'S1',
  payload: { shiftDayId: '20261020', periodStartMs: 1000, periodEndMs: 2000, periodStartExclusive: false,
    startingCash: 100, cashSales: 500, convertNet: 50, manualCashAdjustment: -10, manualCashAdjustmentReason: 'Till correction',
    deductions: [], deductionsTotal: 0, expectedCash: 640, countedCash: 640, variance: 0,
    outgoingCashierName: 'A', incomingCashierName: 'B', notes: null, createdAtClientMs: 2000, createdByUid: 'staff1', createdByName: 'A' },
};
const recordPath = `stores/S1/cashHandovers/${attempt.id}`;
let fs: FakeFirestore;
beforeEach(() => { fs = new FakeFirestore(); setActiveFake(fs); });

describe('DEF-710 handover submission retains one immutable identity/window', () => {
  it('writes once, and a replay preserves the exact original window, values and timestamp', async () => {
    await commitHandover(attempt);
    const original = fs.get(recordPath);
    await commitHandover(structuredClone(attempt));
    expect(fs.list('stores/S1/cashHandovers')).toHaveLength(1);
    expect(fs.get(recordPath)).toEqual(original);
    expect(original).toMatchObject(attempt.payload);
  });
  it('recovers a committed write whose acknowledgment was lost without creating another record', async () => {
    const real = fs.runTransaction;
    let lose = true;
    fs.runTransaction = async <T>(db: unknown, fn: (tx: any) => Promise<T>) => {
      const result = await real(db, fn);
      if (lose) { lose = false; throw new Error('synthetic lost ack'); }
      return result;
    };
    await expect(commitHandover(attempt)).resolves.toBeUndefined();
    await commitHandover(attempt);
    expect(fs.list('stores/S1/cashHandovers')).toHaveLength(1);
    expect(fs.get(recordPath)).toMatchObject(attempt.payload);
  });
  it('a failed write leaves nothing, gives an honest refusal, and the same attempt can succeed later', async () => {
    fs.failNextCommit();
    await expect(commitHandover(attempt)).rejects.toThrow('Could not confirm this handover. Retry this same handover before logging another.');
    expect(fs.list('stores/S1/cashHandovers')).toEqual([]);
    await commitHandover(attempt);
    expect(fs.list('stores/S1/cashHandovers')).toHaveLength(1);
  });
  it('concurrent submissions of the same attempt create exactly one log', async () => {
    await Promise.all([commitHandover(attempt), commitHandover(structuredClone(attempt))]);
    expect(fs.list('stores/S1/cashHandovers')).toHaveLength(1);
    expect(fs.get(recordPath)).toMatchObject(attempt.payload);
  });
  it('an unconfirmed committed write remains recoverable when its recovery read is also unavailable', async () => {
    const real = fs.runTransaction;
    const read = fs.getDocFromServer;
    fs.runTransaction = async (...args: Parameters<typeof real>) => { await real(...args); throw new Error('lost ack'); };
    fs.getDocFromServer = async () => { throw new Error('offline recovery'); };
    await expect(commitHandover(attempt)).rejects.toThrow('Could not confirm this handover. Retry this same handover before logging another.');
    expect(fs.list('stores/S1/cashHandovers')).toHaveLength(1);
    const saved = fs.get(recordPath);
    fs.runTransaction = real; fs.getDocFromServer = read;
    await commitHandover(attempt);
    expect(fs.list('stores/S1/cashHandovers')).toHaveLength(1);
    expect(fs.get(recordPath)).toEqual(saved);
  });
  it('never overwrites a saved record when the same identity is reused with different values', async () => {
    await commitHandover(attempt);
    const original = fs.get(recordPath);
    await expect(commitHandover({ ...attempt, payload: { ...attempt.payload, countedCash: 999 } })).rejects.toThrow('This handover was already saved with different details. Check History before continuing.');
    expect(fs.get(recordPath)).toEqual(original);
  });
  it('persists the full attempt before posting and restores it only for the same store and staff member', () => {
    const entries = new Map<string, string>();
    const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
    saveHandoverAttempt(storage, 'retry', attempt);
    expect(readHandoverAttempt(storage, 'retry', 'S1', 'staff1')).toEqual(attempt);
    expect(() => readHandoverAttempt(storage, 'retry', 'S2', 'staff1')).toThrow();
    expect(() => readHandoverAttempt(storage, 'retry', 'S1', 'staff2')).toThrow();
    entries.set('retry', '{broken');
    expect(() => readHandoverAttempt(storage, 'retry', 'S1', 'staff1')).toThrow();
  });
  it('does not silently discard an envelope when persistence fails', () => {
    expect(() => saveHandoverAttempt({ setItem: () => { throw new Error('storage unavailable'); } }, 'retry', attempt)).toThrow('storage unavailable');
  });
});
