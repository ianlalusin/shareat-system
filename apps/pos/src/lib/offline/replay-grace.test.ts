/** T-423 audit fix: a queued void's loyalty reversal is never dropped while young; only a server read of "not voided" after 10 minutes drops it. */
import { describe, expect, it, vi } from 'vitest';
import { replayDeferredEffects, VOID_DROP_GRACE_MS } from '@/lib/offline/replayDeferredEffects';
import type { QueuedPayment } from '@/lib/offline/payment-queue';

const item = (queuedAtMs: number): QueuedPayment => ({
  id: 'q1', storeId: 'S1', sessionId: 'sess1', receiptId: 'sess1', queuedAtMs, status: 'pending', kind: 'void',
  ctx: { amount: 0, redemptionIds: ['R1'] },
  effects: { analytics: 'skip', loyaltyFinalize: 'skip', loyaltyEarn: 'skip', pinFinalize: 'skip', loyaltyReverse: 'pending' },
});
const deps = (now: number, voided: boolean) => ({
  getToken: async () => 't',
  fetchImpl: vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch,
  isSessionVoided: async () => voided,
  now: () => now,
});

describe('replay grace period', () => {
  it('a young item whose session is not voided yet stays pending (the commit may still land)', async () => {
    const out = await replayDeferredEffects(item(1000), deps(1000 + VOID_DROP_GRACE_MS - 1, false));
    expect(out.item.effects.loyaltyReverse).toBe('pending');
    expect(out.complete).toBe(false);
  });
  it('an old item whose session is still not voided is dropped', async () => {
    const out = await replayDeferredEffects(item(1000), deps(1000 + VOID_DROP_GRACE_MS, false));
    expect(out.item.effects.loyaltyReverse).toBe('skip');
  });
  it('a young item whose session IS voided is reversed', async () => {
    const out = await replayDeferredEffects(item(1000), deps(2000, true));
    expect(out.item.effects.loyaltyReverse).toBe('done');
  });
});
