'use server';

/**
 * Server actions for the liability screens. T-128.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import {
  chargeLiability,
  createLiability,
  payLiability,
  retireLiability,
  reverseLiabilityEntry,
} from '@shareat/domain';
import type { LiabilityCategory } from '@shareat/db/schema';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { verifyAdminApproval } from '@shareat/auth';
import { loadDestructiveTarget, recordApproval, retypeRefusalError } from '@/lib/destructive';
import { retypeMatches } from '@/lib/retype';
import { refuse } from '@shareat/db';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createLiabilityAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    const storeId = str(formData, 'storeId');
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createLiability(tx, actor, {
        storeId,
        name: str(formData, 'name'),
        category: (str(formData, 'category') || 'other') as LiabilityCategory,
        description: str(formData, 'description') || null,
        dueOn: str(formData, 'dueOn') || null,
        notes: str(formData, 'notes') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    return await redirectWithFlash('/liabilities', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/liabilities/${id}`, {}, {
    ok: 'Recorded. ⚠️ Nothing is owed yet — charge it to put the obligation on the books.',
  });
}

export async function chargeAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      chargeLiability(tx, actor, {
        requestId: str(formData, 'requestId'),
        liabilityId: id,
        amount: str(formData, 'amount'),
        againstAccountCode: str(formData, 'againstAccountCode'),
        on: str(formData, 'on'),
        memo: str(formData, 'memo') || undefined,
      }),
    );
    message = `Charged. ₱${result.outstanding} now owed.`;
  } catch (err) {
    return await redirectWithFlash(`/liabilities/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/liabilities/${id}`, {}, { ok: message });
}

export async function payAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  let message = '';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      payLiability(tx, actor, {
        requestId: str(formData, 'requestId'),
        liabilityId: id,
        amount: str(formData, 'amount'),
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        on: str(formData, 'on'),
        memo: str(formData, 'memo') || undefined,
      }),
    );
    // ⭐ Reports the LEDGER's answer, not the form's arithmetic.
    message = result.settled
      ? 'Paid. That settles it — the balance is zero.'
      : `Paid. ₱${result.outstanding} still owed.`;
    // ⚠️ Surfaced, not swallowed: a cashier account can read short because its count is unverified.
    if (result.warning) message += ` ⚠️ ${result.warning}`;
  } catch (err) {
    return await redirectWithFlash(`/liabilities/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/liabilities/${id}`, {}, { ok: message });
}

export async function reverseAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  try {
    const reason = str(formData, 'reason');
    if (!reason) throw new Error('Say why this is being reversed.');
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const target = await loadDestructiveTarget(actor, 'liability', id, ['approve_expense']);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'approve_expense' });
    const entryId = str(formData, 'entryId');
    await withOrgPrincipal(actor.orgId, async (tx) => {
      const reversed = await reverseLiabilityEntry(tx, actor, { liabilityId: id, entryId, reason });
      // A second reversal of the same entry is a harmless no-op in the domain: nothing was approved or changed, so no
      // approval event is written and the person is told.
      if (!reversed.created) throw refuse(`reverseLiabilityEntry: entry ${entryId} was already reversed`, 'That entry was already reversed - nothing changed.');
      await recordApproval(tx, actor, approval, { capability: 'approve_expense', entityType: 'liability_entry', entityId: entryId, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash(`/liabilities/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/liabilities/${id}`, {}, {
    ok: 'Reversed. Both entries stay on the ledger and net to nothing.',
  });
}

export async function retireAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'liabilityId');
  try {
    // T-412 Tier R: the person retypes the liability's name; the server compares it with the name IT loads.
    const target = await loadDestructiveTarget(actor, 'liability', id, ['approve_expense']);
    if (!retypeMatches(str(formData, 'confirmName'), target.name ?? '')) throw retypeRefusalError(target.name ?? '');
    await withOrgPrincipal(actor.orgId, (tx) => retireLiability(tx, actor, { liabilityId: id }));
  } catch (err) {
    return await redirectWithFlash(`/liabilities/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash('/liabilities', {}, { });
}
