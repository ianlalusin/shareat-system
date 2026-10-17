'use server';

/**
 * Server actions for the owner-equity screens. T-127.
 *
 * ⛔ The gates live in the services, not here. A gate in a server action protects one caller.
 */
import {
  assertFieldRules,
  closeDrawingMonth,
  createOwner,
  recordContribution,
  recordDrawing,
  recoverFromPay,
  repayFromOwner,
  writeOffReceivable,
} from '@shareat/domain';
import type { DrawingLimitPeriod, PersonalExpenseTreatment } from '@shareat/db/schema';
import {
  OWNERS_CLOSE_MONTH_RULES,
  OWNERS_CONTRIBUTION_RULES,
  OWNERS_CREATE_RULES,
  OWNERS_DRAWING_RULES,
  OWNERS_SETTLE_RULES,
} from '@shareat/domain/field-rules';
import { verifyAdminApproval } from '@shareat/auth';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export async function createOwnerAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let id = '';
  try {
    // T-440: "Choose a store." / "Choose who this is." are now rule sentences, the same ones the screen shows live.
    assertFieldRules(OWNERS_CREATE_RULES, formData);
    const storeId = str(formData, 'storeId');
    const personId = str(formData, 'personId');
    const limit = str(formData, 'drawingLimit');
    const period = str(formData, 'drawingLimitPeriod');
    const created = await withOrgPrincipal(actor.orgId, (tx) =>
      createOwner(tx, actor, {
        storeId,
        personId,
        role: str(formData, 'role') || null,
        ownershipPercentage: str(formData, 'ownershipPercentage') || null,
        drawingLimit: limit || null,
        drawingLimitPeriod: (period as DrawingLimitPeriod) || null,
        personalExpenseTreatment: str(formData, 'personalExpenseTreatment') as PersonalExpenseTreatment,
        notes: str(formData, 'notes') || null,
      }),
    );
    id = created.id;
  } catch (err) {
    return await redirectWithFlash('/owners', {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/owners/${id}`, {}, { ok: 'Recorded.' });
}

export async function contributionAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'ownerId');
  try {
    assertFieldRules(OWNERS_CONTRIBUTION_RULES, formData);
    await withOrgPrincipal(actor.orgId, (tx) =>
      recordContribution(tx, actor, {
        ownerId: id,
        amount: str(formData, 'amount'),
        intoMoneyAccountId: str(formData, 'intoMoneyAccountId'),
        on: str(formData, 'on'),
      }),
    );
  } catch (err) {
    return await redirectWithFlash(`/owners/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/owners/${id}`, {}, { ok: 'Capital in. Equity is up by that much.' });
}

export async function drawingAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'ownerId');
  let message = 'Drawn. Equity is down by that much.';
  try {
    assertFieldRules(OWNERS_DRAWING_RULES, formData);
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      recordDrawing(tx, actor, {
        ownerId: id,
        amount: str(formData, 'amount'),
        fromMoneyAccountId: str(formData, 'fromMoneyAccountId'),
        on: str(formData, 'on'),
      }),
    );
    // ⚠️ Surfaced, not swallowed — a cashier account can read short because its count is unverified,
    // which is why the overdraft guard warns rather than blocks (row 154).
    if (result.warning) message += ` ⚠️ ${result.warning}`;
  } catch (err) {
    return await redirectWithFlash(`/owners/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/owners/${id}`, {}, { ok: message });
}

export async function settleAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'ownerId');
  const how = str(formData, 'how');
  const amount = str(formData, 'amount');
  let message = '';
  try {
    assertFieldRules(OWNERS_SETTLE_RULES, formData);
    if (how === 'cash') {
      const result = await withOrgPrincipal(actor.orgId, (tx) =>
        repayFromOwner(tx, actor, {
          ownerId: id,
          amount,
          intoMoneyAccountId: str(formData, 'intoMoneyAccountId'),
          on: str(formData, 'on'),
        }),
      );
      message = `Repaid. ₱${result.outstanding} still owed.`;
    } else if (how === 'pay') {
      const result = await withOrgPrincipal(actor.orgId, (tx) =>
        recoverFromPay(tx, actor, { ownerId: id, amount, on: str(formData, 'on') }),
      );
      // ⚠️ Says plainly that nothing has been recovered yet. "Recovered from pay" reads as done.
      message =
        `Moved to salary advance — ₱${result.outstanding} still on the owner account. ` +
        `⚠️ No cash has come back yet; payroll nets it when it runs, so it still counts against ` +
        `the drawing limit.`;
    } else if (how === 'writeoff') {
      // T-412 Tier P (DEF-654): writing a posted receivable off is an administrator's PIN, checked on the server against the
      // RECORD's store. Only this branch is guarded: repaying in cash or from pay moves money back, it forgives nothing.
      const target = await loadDestructiveTarget(actor, 'owner', id, ['approve_expense']);
      const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId!, pin: str(formData, 'adminPin'), capability: 'approve_expense' });
      const result = await withOrgPrincipal(actor.orgId, async (tx) => {
        const written = await writeOffReceivable(tx, actor, {
          ownerId: id,
          amount,
          reason: str(formData, 'reason'),
          on: str(formData, 'on'),
        });
        await recordApproval(tx, actor, approval, { capability: 'approve_expense', entityType: 'owner', entityId: id, storeId: target.storeId });
        return written;
      });
      message =
        `Written off. It is a drawing now, so equity is down by ₱${amount} — ` +
        `₱${result.outstanding} still owed.`;
    } else {
      throw new Error('Choose how this is being settled.');
    }
  } catch (err) {
    return await redirectWithFlash(`/owners/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/owners/${id}`, {}, { ok: message });
}

export async function closeMonthAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const id = str(formData, 'ownerId');
  let message = '';
  try {
    assertFieldRules(OWNERS_CLOSE_MONTH_RULES, formData);
    const acknowledged = str(formData, 'acknowledgedAmount');
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      closeDrawingMonth(tx, actor, {
        ownerId: id,
        month: str(formData, 'month'),
        ...(acknowledged ? { acknowledgedAmount: acknowledged } : {}),
        ...(str(formData, 'adjustmentReason')
          ? { adjustmentReason: str(formData, 'adjustmentReason') }
          : {}),
        on: str(formData, 'on'),
        notes: str(formData, 'notes') || null,
      }),
    );
    message = `Closed at ₱${result.acknowledgedAmount}. That month is now locked for this owner.`;
    if (result.adjustmentAmount) {
      // ⭐ Says the adjustment POSTED. "Visible and enforced" is the whole requirement.
      message += ` An adjustment of ₱${result.adjustmentAmount} was posted to the books.`;
    }
  } catch (err) {
    return await redirectWithFlash(`/owners/${id}`, {}, { error: errorMessage(err) });
  }
  return await redirectWithFlash(`/owners/${id}`, {}, { ok: message });
}
