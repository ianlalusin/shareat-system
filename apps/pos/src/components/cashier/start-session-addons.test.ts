/**
 * T-518 tester: startSession with optional initialAddons (docs/tasks/518-pos-alacarte-at-table-start.md rulings 3-4, orchestrator notes).
 *
 * CONTRACT for the builder (components/cashier/firestore.ts):
 *   StartSessionPayload gains `initialAddons?: BuiltAddonLine[]` (BuiltAddonLine from @/lib/pos2/addon-line-builder; lines already merged).
 *   No exported builder is assumed: startSession itself is called against the fake Firestore. With initialAddons it must, in the SAME
 *   single writeBatch/commit as the package: set sessions/{sid}/sessionBillLines/{lineId} = payload for each line; for each line whose
 *   payload.kitchenLocationId is set, one kitchen ticket (type 'addon', billLineId, qty = qtyOrdered, station FROM THE LINE) via
 *   createKitchenTickets(..., {batch}); and update the session doc billingRevision: increment(initialAddons.length)
 *   (the modal adds billingRevision +1 per added line). Without initialAddons the writes are today's (see start-session-today.test.ts).
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
import { buildAddonLine, type BuiltAddonLine } from '@/lib/pos2/addon-line-builder';

let fs: FakeFirestore;
beforeEach(() => { fs = createFakeFirestore(); setActiveFake(fs); vi.stubGlobal('window', { localStorage: memoryLocalStorage() }); });

const pkg = { packageId: 'pk1', packageName: 'Unli Pack', pricePerHead: 299, kitchenLocationId: 'kl-main', kitchenLocationName: 'Main' } as any;
const base = { tableId: 't1', tableNumber: '1', displayName: 'Table 1', guestCount: 2, package: pkg, sessionMode: 'package_dinein' as const, customer: { name: 'Ana' } };
const actor = { uid: user.uid, username: 'cashier1' };
const line = (id: string, qty: number, station: string | null, mods: any[] = []) =>
  buildAddonLine({ addon: { id, displayName: id, sellingPrice: 100, kitchenLocationId: station, kitchenLocationName: station ? `N-${station}` : null }, qty, modifiers: mods, modifiersText: mods.length ? 'm' : '', modifiersTotal: 0 }, actor);

function seedTable() {
  fs.seed(`stores/${STORE_ID}/tables/t1`, { status: 'available', currentSessionId: null });
  fs.seed(`stores/${STORE_ID}/storeConfig/current/tables/t1`, { status: 'available', currentSessionId: null });
}
async function run(initialAddons?: BuiltAddonLine[]) {
  seedTable();
  const sid = await startSession(STORE_ID, { ...base, ...(initialAddons ? { initialAddons } : {}) } as any, user);
  await Promise.resolve();
  return sid;
}
const tickets = (sid: string) => fs.list(`stores/${STORE_ID}/sessions/${sid}/kitchentickets`).map((t) => t.data);

describe('empty initialAddons', () => {
  it('behaves like none: one commit, no add-on lines, no billingRevision', async () => {
    const sid = await run([]);
    expect(fs.commits).toHaveLength(1);
    expect(fs.list(`stores/${STORE_ID}/sessions/${sid}/sessionBillLines`).map((l) => l.id)).toEqual(['package_pk1']);
    expect(fs.get(`stores/${STORE_ID}/sessions/${sid}`)).not.toHaveProperty('billingRevision');
  });
});

describe('startSession with initialAddons', () => {
  it('ONE batch, ONE commit: package line + add-on lines + a ticket per stationed line; nothing outside the batch', async () => {
    const a = line('wings', 2, 'kl-fry');
    const b = line('rice', 1, null);
    const sid = await run([a, b]);
    expect(fs.commits).toHaveLength(1); // kills a second batch/commit or a stray setDoc/updateDoc (the fake logs those as commits too)
    expect(fs.commits[0].kind).toBe('batch');
    const lines = `stores/${STORE_ID}/sessions/${sid}/sessionBillLines`;
    expect(fs.get(`${lines}/package_pk1`)).toMatchObject({ type: 'package' });
    expect(fs.get(`${lines}/${a.lineId}`)).toMatchObject({ type: 'addon', itemId: 'wings', qtyOrdered: 2, kitchenLocationId: 'kl-fry' });
    expect(fs.get(`${lines}/${b.lineId}`)).toMatchObject({ type: 'addon', itemId: 'rice', qtyOrdered: 1, kitchenLocationId: null });
    const addonTickets = tickets(sid).filter((t: any) => t.type === 'addon');
    expect(addonTickets).toHaveLength(1); // station-less line: billed, no ticket
    expect(addonTickets[0]).toMatchObject({ billLineId: a.lineId, itemId: 'wings', qty: 2, qtyOrdered: 2, kitchenLocationId: 'kl-fry', kitchenLocationName: 'N-kl-fry' });
    expect(tickets(sid).filter((t: any) => t.type === 'package')).toHaveLength(1);
  });
  it('ticket station comes from the item, never a hard-coded location or the package station', async () => {
    const sid = await run([line('x', 1, 'kl-bar'), line('y', 1, 'kl-grill')]);
    const stations = tickets(sid).filter((t: any) => t.type === 'addon').map((t: any) => t.kitchenLocationId).sort();
    expect(stations).toEqual(['kl-bar', 'kl-grill']);
    const rt = (id: string) => fs.get(`stores/${STORE_ID}/rtKdsTickets/${id}`);
    expect(Object.keys(rt('kl-bar').tickets)).toHaveLength(1);
    expect(Object.keys(rt('kl-main').tickets)).toHaveLength(1); // only the package ticket
  });
  it('modifiers ride on the ticket as the modal sends them', async () => {
    const mods = [{ valueId: 'v1', name: 'Hot', priceDelta: 0 }];
    const sid = await run([line('wings', 1, 'kl-fry', mods)]);
    const t: any = tickets(sid).find((x: any) => x.type === 'addon');
    expect(t).toMatchObject({ modifiers: mods, modifiersText: 'm' });
  });
  it('billingRevision equals what the modal path leaves: +1 per added line', async () => {
    const sid = await run([line('a', 1, 'k'), line('b', 1, null), line('c', 3, 'k2')]);
    expect(fs.get(`stores/${STORE_ID}/sessions/${sid}`)).toMatchObject({ billingRevision: 3 });
  });
  it('all-or-nothing: a failed commit saves no session, no lines, no tickets', async () => {
    seedTable();
    const before = fs.docs.size;
    fs.failNextCommit();
    await startSession(STORE_ID, { ...base, initialAddons: [line('wings', 1, 'kl-fry')] } as any, user).catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.commits).toHaveLength(0);
    expect(fs.docs.size).toBe(before);
  });
});
