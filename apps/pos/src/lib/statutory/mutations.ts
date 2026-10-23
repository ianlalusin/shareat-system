import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase/client';
import { getDayIdFromTimestamp } from '@/lib/analytics/daily';
import { addStatutoryDiner, assignDishToDiner, removeStatutoryDiner, resolveHeads, statutoryActivityEntry, statutoryPaymentBlockers } from './capture';
import { pruneDishAssignments } from './shares';
import type { PendingSession, SessionBillLine, StatutoryDiner } from '@/lib/types';

type Command = { type: 'add'; entry: { kind: string; name: string; idNo: string }; heads: number }
  | { type: 'remove'; dinerId: string } | { type: 'assign'; dinerId: string; lineId: string }
  | { type: 'heads'; heads: number } | { type: 'prune' } | { type: 'unassign'; lineId: string };
class Refusal extends Error {}

/** Existing store-scoped Firestore rules authorize the write; the transaction protects closed bills and concurrent edits. */
export async function mutateStatutoryDiners(storeId: string, sessionId: string,
  actor: { uid: string; name: string; role: string }, command: Command): Promise<{ warnings: string[] }> {
  if (!auth.currentUser || actor.uid !== auth.currentUser.uid) throw new Refusal('Sign in again before changing the qualifying diners.');
  if ([storeId, sessionId].some(id => !id || id.includes('/'))) throw new Refusal('Open a bill before changing its qualifying diners.');
  const eventId = crypto.randomUUID();
  const now = Date.now(), dayId = getDayIdFromTimestamp(now);
  try {
    return await runTransaction(db, async tx => {
      const sessionRef = doc(db, 'stores', storeId, 'sessions', sessionId);
      const snapshot = await tx.get(sessionRef);
      if (!snapshot.exists()) throw new Refusal('This bill is no longer available. Refresh the list.');
      const session = snapshot.data() as PendingSession;
      if (session.status !== 'active' || session.isPaid) throw new Refusal('This bill is closed. Senior / PWD entries cannot be changed.');
      const original = session.statutoryDiners ?? [];
      if (!Array.isArray(original)) throw new Refusal('Review the Senior / PWD list before changing this bill.');
      const invalid = command.type === 'remove' ? undefined : statutoryPaymentBlockers({ diners: original, heads: resolveHeads(session), lines: [] })
        .find(blocker => blocker.code === 'invalid-diner' || blocker.code === 'duplicate-id');
      if (invalid) throw new Refusal(invalid.message);
      const ids = new Set(command.type === 'remove' ? [] : original.flatMap(diner => diner.dishLineIds));
      if (command.type === 'assign') ids.add(command.lineId);
      if ([...ids].some(id => !id || id.includes('/'))) throw new Refusal('Choose an active dish from this bill.');
      const snapshots = await Promise.all([...ids].map(id => tx.get(doc(db, 'stores', storeId, 'sessions', sessionId, 'sessionBillLines', id))));
      const lines = snapshots.filter(snapshot => snapshot.exists()).map(snapshot => ({ ...snapshot.data(), id: snapshot.id } as SessionBillLine));
      let diners = command.type === 'remove' ? original : pruneDishAssignments(original, lines);
      let heads = session.statutoryHeadCount;
      let activity: ReturnType<typeof statutoryActivityEntry> | null = null;
      let warnings: string[] = [];
      if (command.type === 'add' || command.type === 'heads') {
        if (!Number.isInteger(command.heads) || command.heads <= 0 || command.heads > 1000) throw new Refusal('Enter a whole number of diners from 1 to 1,000.');
        heads = command.heads;
      }
      const resolved = resolveHeads({ ...session, statutoryHeadCount: heads });
      if (command.type === 'add') {
        const result = addStatutoryDiner({ diners, entry: command.entry, heads: resolved, actor, nowMs: now });
        if (!result.ok) throw new Refusal(result.message);
        diners = result.diners; warnings = result.warnings;
        activity = statutoryActivityEntry('add', result.diner, actor, now);
      } else if (command.type === 'remove') {
        const diner = diners.find(diner => diner.id === command.dinerId);
        if (diner && (typeof diner.idNo !== 'string' || (diner.kind !== 'senior' && diner.kind !== 'pwd'))) throw new Refusal('Ask a manager to repair this entry before removing it.');
        if (diner) activity = statutoryActivityEntry('remove', diner, actor, now);
        diners = removeStatutoryDiner(diners, command.dinerId);
      } else if (command.type === 'assign') {
        const line = lines.find(line => line.id === command.lineId);
        if (!line || line.type !== 'addon' || line.id.startsWith('bundleextra_')
          || line.qtyOrdered - (line.voidedQty ?? 0) - (line.freeQty ?? 0) <= 0) throw new Refusal('Choose an active dish from this bill.');
        if (!diners.some(diner => diner.id === command.dinerId)) throw new Refusal('That diner is no longer on this bill. Refresh the list.');
        diners = assignDishToDiner(diners, command.dinerId, command.lineId);
      } else if (command.type === 'unassign') {
        diners = diners.map(diner => ({ ...diner, dishLineIds: diner.dishLineIds.filter(id => id !== command.lineId) }));
      }
      if ((command.type === 'add' || command.type === 'heads') && diners.length > (resolved ?? 0)) throw new Refusal('There cannot be more qualifying diners than people at the table.');
      if (JSON.stringify(diners) === JSON.stringify(original) && heads === session.statutoryHeadCount) return { warnings };
      tx.update(sessionRef, { statutoryDiners: diners, ...(heads !== undefined ? { statutoryHeadCount: heads } : {}),
        billingRevision: Number(session.billingRevision ?? 0) + 1, updatedAt: serverTimestamp() });
      if (activity) {
        const log = { storeId, sessionId, dayId, action: activity.type === 'statutory_diner_added' ? 'STATUTORY_DINER_ADDED' : 'STATUTORY_DINER_REMOVED',
          actorUid: actor.uid, actorRole: actor.role, actorName: actor.name, createdAt: serverTimestamp(), createdAtClientMs: now,
          note: `${activity.type === 'statutory_diner_added' ? 'Added' : 'Removed'} ${activity.kind === 'senior' ? 'Senior' : 'PWD'} diner (${activity.idMasked}).`,
          sessionStatus: session.status, sessionMode: session.sessionMode ?? null, customerName: session.customerName ?? null,
          tableNumber: session.tableNumber ?? null, meta: { statutory: activity } };
        tx.set(doc(db, 'stores', storeId, 'sessions', sessionId, 'activityLogs', eventId), log);
        tx.set(doc(db, 'stores', storeId, 'activityLogsByDay', dayId, 'logs', eventId), log);
      }
      return { warnings };
    });
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Error('Could not confirm this change. Check the diner list before trying again.');
  }
}
