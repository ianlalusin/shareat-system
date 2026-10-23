import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFirestore, firebaseFirestoreModule, setActiveFake } from '@/test-helpers/fakeFirestore';
import { mkDiner, mkLine } from '@/test-helpers/statutoryOracle';
const identity = vi.hoisted(() => ({ uid: 'staff1' }));
vi.mock('firebase/firestore', () => firebaseFirestoreModule());
vi.mock('@/lib/firebase/client', () => ({ db: {}, auth: { get currentUser() { return identity.uid ? { uid: identity.uid } : null; } } }));
import { mutateStatutoryDiners } from './mutations';
let fs: FakeFirestore;
const sessionPath = 'stores/S1/sessions/s1';
const actor = { uid: 'staff1', name: 'Cashier', role: 'cashier' };
const add = () => mutateStatutoryDiners('S1', 's1', actor,
  { type: 'add', entry: { kind: 'senior', name: 'Mina Diaz', idNo: 'OSCA-1187' }, heads: 4 });
beforeEach(() => {
  identity.uid = 'staff1'; fs = new FakeFirestore(); setActiveFake(fs);
  fs.seed(sessionPath, { status: 'active', isPaid: false, billingRevision: 3, guestCountFinal: 4, statutoryDiners: [] });
});
describe('atomic statutory capture and masked audit trail', () => {
  it('adds one person and atomically stores masked activity in both existing log collections', async () => {
    await add();
    expect(fs.get(sessionPath)).toMatchObject({ billingRevision: 4, statutoryDiners: [{ name: 'Mina Diaz', idNo: 'OSCA-1187', addedByUid: 'staff1' }] });
    const logs = fs.list(`${sessionPath}/activityLogs`);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.data.actorUid).toBe('staff1');
    expect(JSON.stringify(logs)).toContain('****1187');
    expect(JSON.stringify(logs)).not.toContain('OSCA-1187');
    expect(JSON.stringify(logs)).not.toContain('OSCA1187');
    const partition = logs[0]!.data.dayId;
    expect(fs.list(`stores/S1/activityLogsByDay/${partition}/logs`)).toHaveLength(1);
  });
  it('a concurrent duplicate ID is refused and never creates two qualifiers', async () => {
    const outcomes = await Promise.allSettled([add(), add()]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(fs.get(sessionPath).statutoryDiners).toHaveLength(1);
    expect(fs.list(`${sessionPath}/activityLogs`)).toHaveLength(1);
  });
  it('refuses a closed session before any write', async () => {
    fs.seed(sessionPath, { status: 'closed', isPaid: true, billingRevision: 3 });
    const before = fs.get(sessionPath);
    await expect(add()).rejects.toThrow('This bill is closed. Senior / PWD entries cannot be changed.');
    expect(fs.get(sessionPath)).toEqual(before);
    expect(fs.list(`${sessionPath}/activityLogs`)).toEqual([]);
  });
  it('a failed transaction leaves neither an entry nor an audit log', async () => {
    fs.failNextCommit(); const before = fs.get(sessionPath);
    await expect(add()).rejects.toThrow('Could not confirm this change. Check the diner list before trying again.');
    expect(fs.get(sessionPath)).toEqual(before);
    expect(fs.list(`${sessionPath}/activityLogs`)).toEqual([]);
  });
  it('prunes an assigned dish using the actual current line, not a cached form copy', async () => {
    fs.seed(sessionPath, { ...fs.get(sessionPath), statutoryDiners: [mkDiner(1, { dishLineIds: ['a'] })] });
    fs.seed(`${sessionPath}/sessionBillLines/a`, mkLine({ id: 'a', type: 'addon', priceC: 10000, qty: 1, voided: 1 }));
    await mutateStatutoryDiners('S1', 's1', actor, { type: 'prune' });
    expect(fs.get(sessionPath).statutoryDiners[0].dishLineIds).toEqual([]);
    expect(fs.get(sessionPath).billingRevision).toBe(4);
  });
  it('refuses a missing or voided dish assignment before changing the list', async () => {
    fs.seed(sessionPath, { ...fs.get(sessionPath), statutoryDiners: [mkDiner(1)] });
    const before = fs.get(sessionPath);
    await expect(mutateStatutoryDiners('S1', 's1', actor, { type: 'assign', dinerId: 'd1', lineId: 'missing' })).rejects.toThrow('Choose an active dish from this bill.');
    expect(fs.get(sessionPath)).toEqual(before);
  });
  it('requires an authenticated actor matching the signed-in account', async () => {
    identity.uid = '';
    await expect(add()).rejects.toThrow('Sign in again before changing the qualifying diners.');
    expect(fs.get(sessionPath).billingRevision).toBe(3);
  });
  it('lets staff remove excess people one at a time after a guest-count reduction', async () => {
    fs.seed(sessionPath, { ...fs.get(sessionPath), guestCountFinal: 1, statutoryDiners: [mkDiner(1), mkDiner(2), mkDiner(3)] });
    await mutateStatutoryDiners('S1', 's1', actor, { type: 'remove', dinerId: 'd1' });
    expect(fs.get(sessionPath).statutoryDiners.map((diner: any) => diner.id)).toEqual(['d2', 'd3']);
  });
  it('allows removing one duplicate record to repair the list before payment', async () => {
    fs.seed(sessionPath, { ...fs.get(sessionPath), statutoryDiners: [mkDiner(1), mkDiner(2, { idNo: 'ID-1001' })] });
    await mutateStatutoryDiners('S1', 's1', actor, { type: 'remove', dinerId: 'd2' });
    expect(fs.get(sessionPath).statutoryDiners).toHaveLength(1);
    expect(JSON.stringify(fs.list(`${sessionPath}/activityLogs`))).not.toContain('ID-1001');
  });
});
