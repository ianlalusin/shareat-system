import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkDiner, mkLine } from '@/test-helpers/statutoryOracle';
vi.mock('@/lib/firebase/client', () => ({ auth: { currentUser: { getIdToken: async () => 'test-token' } } }));
import { assertStatutoryPaymentReady } from './payment';
const input = { storeId: 'S1', session: { statutoryDiners: [mkDiner(1, { dishLineIds: ['a'] })], statutoryHeadCount: 1 },
  lines: [mkLine({ id: 'a', type: 'addon', priceC: 50000, qty: 1 })],
  loyalty: [{ redemptionId: 'reward1' }, { redemptionId: 'reward2' }] };
afterEach(() => vi.unstubAllGlobals());
describe('points cannot stay spent after a fully qualifying bill is refused', () => {
  it('online releases each existing redemption through the existing authorized reversal API, then refuses payment for review', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetcher);
    await expect(assertStatutoryPaymentReady(input)).rejects.toThrow('Points cannot be used when every diner gets the senior/PWD discount');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => JSON.parse((call[1] as any).body).redemptionId)).toEqual(['reward1', 'reward2']);
    expect(fetcher.mock.calls.every(call => (call[1] as any).method === 'DELETE')).toBe(true);
  });
  it('offline refuses before any server call and requires reconnecting to release points', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(assertStatutoryPaymentReady({ ...input, offline: true })).rejects.toThrow('Connect to the internet to release the points before payment.');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('an unknown release response never says points were released', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('lost response'); }));
    await expect(assertStatutoryPaymentReady(input)).rejects.toThrow('Could not confirm that all points were released.');
  });
});
