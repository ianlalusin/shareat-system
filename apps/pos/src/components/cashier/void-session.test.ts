/**
 * T-423 slice T - the client half of voiding an UNPAID session. Ruling 9, Acceptance 10 (the three race defects in "Facts verified").
 *
 * CONTRACT for the builder (S3):
 *   voidSession({ storeId, sessionId, reason, actor })   (components/cashier/firestore.ts) - same signature, same return value.
 *   Inside the Firestore transaction it must:
 *     - re-read (tx.get) every kitchen ticket the pre-read query found, and cancel only those still `preparing` or `ready`;
 *     - re-read the table doc (tx.get) and free the table and its storeConfig projection ONLY if `currentSessionId === sessionId`;
 *     - enqueue the loyalty reversal through the existing queue (`addToQueue` in lib/offline/payment-queue.ts) BEFORE the commit, as ONE item
 *       { storeId, sessionId, receiptId: sessionId, kind: 'void', ctx: { amount: 0, redemptionIds }, effects: { loyaltyReverse: 'pending',
 *       analytics: 'skip', loyaltyFinalize: 'skip', loyaltyEarn: 'skip', pinFinalize: <any> } }; a transaction RETRY or a second call must not
 *       add a second item for the same session (dedupe on sessionId + kind 'void'); no redemptions => no loyaltyReverse item;
 *       a session that is already voided/closed/paid queues nothing and changes nothing.
 *   lib/offline/replayDeferredEffects.ts: `ReplayDeps` gains `isSessionVoided?: (storeId: string, sessionId: string) => Promise<boolean>`.
 *     For an item with kind 'void' and loyaltyReverse 'pending', when the dep is supplied the replay calls it FIRST: false => no DELETE is sent
 *     and the loyaltyReverse effect leaves 'pending' (becomes 'skip': the item is dropped); true => reverses as today; a throw => nothing is
 *     sent and the effect stays 'pending' (retry later). Without the dep, behaviour is unchanged. Production callers pass a dep that reads the
 *     session doc (`status === 'voided'`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore, setActiveFake, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { STORE_ID, memoryLocalStorage, seedSession, user } from '@/test-helpers/posFixtures';

vi.mock('firebase/firestore', async () => (await import('@/test-helpers/fakeFirestore')).firebaseFirestoreModule());
vi.mock('@/lib/firebase/client', () => ({ db: { __fake: true }, auth: { currentUser: null } }));
vi.mock('@/context/auth-context', () => ({}));
vi.mock('@/components/cashier/activity-log', () => ({ writeActivityLog: vi.fn(async () => {}) }));
vi.mock('@/lib/server-profiles/activeLocalProfile', () => ({ getActiveLocalProfile: () => null }));
vi.mock('@/lib/printing/kitchenBackupPrint', () => ({ printKitchenTicketBackup: vi.fn() }));
vi.mock('@/lib/printing/kitchenBackupDeps', () => ({ makeKitchenBackupDeps: vi.fn(() => ({})) }));
vi.mock('@/lib/analytics/applyAnalyticsDeltaV2', () => ({ applyAnalyticsDeltaV2: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyReceiptDeltaServerFirst', () => ({ applyReceiptDeltaServerFirst: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsTicketDelta', () => ({ applyKdsTicketDelta: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/applyKdsDeltaServerFirst', () => ({ applyKdsDeltaServerFirst: vi.fn(async () => {}) }));

import type { QueuedPayment } from '@/lib/offline/payment-queue';
import { replayDeferredEffects } from '@/lib/offline/replayDeferredEffects';

let fs: FakeFirestore;
const SP = `stores/${STORE_ID}/sessions/sess1`;
const TABLE = `stores/${STORE_ID}/tables/t1`;
const TABLE_PROJ = `stores/${STORE_ID}/storeConfig/current/tables/t1`;
const ticket = (id: string) => fs.get(`${SP}/kitchentickets/${id}`)!;
const R = [{ redemptionId: 'R1', type: 'fixed' as const, value: 50 }, { redemptionId: 'R2', type: 'percent' as const, value: 10 }];

beforeEach(() => {
  fs = createFakeFirestore();
  setActiveFake(fs);
  vi.stubGlobal('localStorage', memoryLocalStorage());
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('replay checks that the session really is voided before it reverses loyalty points', () => {
  const item = (): QueuedPayment => ({
    id: 'q1', storeId: STORE_ID, sessionId: 'sess1', receiptId: 'sess1', queuedAtMs: 0, status: 'pending', kind: 'void',
    ctx: { amount: 0, redemptionIds: ['R1'] },
    effects: { analytics: 'skip', loyaltyFinalize: 'skip', loyaltyEarn: 'skip', pinFinalize: 'skip', loyaltyReverse: 'pending' },
  });
  const okFetch = () => vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({}) }) as Response);
  const deleted = (f: ReturnType<typeof okFetch>) => f.mock.calls.filter((c) => String(c[0]).includes('/api/loyalty/redeem') && (c[1])?.method === 'DELETE');

  it('session NOT voided (the commit never happened): no reversal is sent and the item is dropped', async () => {
    const fetchImpl = okFetch();
    const out = await replayDeferredEffects(item(), { getToken: async () => 't', fetchImpl: fetchImpl as unknown as typeof fetch, isSessionVoided: async () => false } as any);
    expect(deleted(fetchImpl)).toHaveLength(0);
    expect(out.item.effects.loyaltyReverse).not.toBe('pending');
    expect(out.complete).toBe(true);
  });

  it('session voided: the reversal is sent and marked done', async () => {
    const fetchImpl = okFetch();
    const out = await replayDeferredEffects(item(), { getToken: async () => 't', fetchImpl: fetchImpl as unknown as typeof fetch, isSessionVoided: async () => true } as any);
    expect(deleted(fetchImpl)).toHaveLength(1);
    expect(out.item.effects.loyaltyReverse).toBe('done');
  });

  it('the check itself fails (offline): nothing is sent and the effect stays pending for the next try', async () => {
    const fetchImpl = okFetch();
    const out = await replayDeferredEffects(item(), {
      getToken: async () => 't', fetchImpl: fetchImpl as unknown as typeof fetch, isSessionVoided: async () => { throw new Error('offline'); },
    } as any);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.item.effects.loyaltyReverse).toBe('pending');
    expect(out.complete).toBe(false);
  });
});
