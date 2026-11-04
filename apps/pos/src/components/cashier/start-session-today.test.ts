/**
 * T-518 tester: GREEN-NOW guard. startSession without initialAddons writes exactly today's batch (kills a regression for every normal
 * table start). Kept in its own file so it does not depend on the new builder module.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFirestore, setActiveFake, type FakeFirestore } from '@/test-helpers/fakeFirestore';
import { STORE_ID, memoryLocalStorage, user } from '@/test-helpers/posFixtures';

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

import { startSession } from './firestore';

let fs: FakeFirestore;
beforeEach(() => { fs = createFakeFirestore(); setActiveFake(fs); vi.stubGlobal('window', { localStorage: memoryLocalStorage() }); });

const pkg = { packageId: 'pk1', packageName: 'Unli Pack', pricePerHead: 299, kitchenLocationId: 'kl-main', kitchenLocationName: 'Main' } as any;
const base = { tableId: 't1', tableNumber: '1', displayName: 'Table 1', guestCount: 2, package: pkg, sessionMode: 'package_dinein' as const, customer: { name: 'Ana' } };
function seedTable() {
  fs.seed(`stores/${STORE_ID}/tables/t1`, { status: 'available', currentSessionId: null });
  fs.seed(`stores/${STORE_ID}/storeConfig/current/tables/t1`, { status: 'available', currentSessionId: null });
}
async function run(initialAddons?: unknown[]) {
  seedTable();
  const sid = await startSession(STORE_ID, { ...base, ...(initialAddons ? { initialAddons } : {}) } as any, user);
  await Promise.resolve();
  return sid;
}
const norm = (sid: string, s: string) => s.split(sid).join('SID').replace(/kitchentickets\/[^/]+/g, 'kitchentickets/TID');
const writeList = (sid: string) => fs.commits[0].writes.map((w: any) =>
  `${w.op} ${norm(sid, w.path)} [${Object.keys(w.data ?? {}).map((k) => k.replace(/^(tickets|sessionIndex)\..*/, '$1.*')).sort().join(',')}]`);
const TODAY: string[] = [
  'set stores/S1/sessions/SID [createdAt,customer,customerName,guestCountCashierInitial,guestCountFinal,guestCountServerVerified,guestCountVerifyLocked,id,initialFlavorIds,isPaid,notes,ownerTerminalId,packageOfferingId,packageSnapshot,revision,sessionLabel,sessionMode,startedAt,startedAtClientMs,startedByUid,status,storeId,tableDisplayName,tableId,tableNumber,updatedAt,verifiedAt,verifiedByUid]',
  'update stores/S1/tables/t1 [currentSessionId,status,updatedAt]',
  'update stores/S1/storeConfig/current/tables/t1 [currentSessionId,customerName,guestCount,packageLabel,sessionType,startedAtMs,status,updatedAt]',
  'set stores/S1/activeSessions/SID [customerName,guestCountCashierInitial,guestCountFinal,id,initialFlavorIds,ownerTerminalId,packageName,packageOfferingId,packageSnapshot,revision,sessionMode,startedAt,startedAtClientMs,status,tableDisplayName,tableId,tableNumber,updatedAt]',
  'set stores/S1/sessions/SID/sessionBillLines/package_pk1 [createdAt,discountQty,discountType,discountValue,freeQty,id,itemId,itemName,qtyOrdered,type,unitPrice,updatedAt,updatedByName,updatedByUid,voidedQty]',
  'set stores/S1/sessions/SID/kitchentickets/TID [createdAt,createdAtClientMs,createdByUid,customerName,guestCount,id,itemId,itemName,kitchenLocationId,kitchenLocationName,notes,qty,sessionId,sessionLabel,sessionMode,status,storeId,tableDisplayName,tableId,tableNumber,type]',
  'set stores/S1/rtKdsTickets/kl-main [kitchenLocationId,meta]',
  'update stores/S1/rtKdsTickets/kl-main [activeIds,sessionIndex.*,tickets.*]',
];

describe('no initialAddons = today exactly', () => {
  it('one batch whose write list is the package-only list', async () => {
    const sid = await run();
    expect(fs.commits).toHaveLength(1);
    expect(writeList(sid)).toEqual(TODAY);
  });
});
