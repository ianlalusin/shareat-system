'use server';

/**
 * Server actions for the money-transfers screen. T-139, bible row 150.
 *
 * Thin adapters: parse `FormData`, call the domain, redirect. ⛔ **The manager-level rule is NOT
 * enforced here** — `createMoneyTransfer` and `voidMoneyTransfer` call `authorize()` themselves.
 * A gate in a server action protects one caller; a gate in the domain protects every caller there
 * will ever be.
 *
 * ⭐ The actor comes from `requireActor()`, never the form (T-138, bible §7.1).
 */
import { assertFieldRules, createMoneyTransfer, settleBetweenStores, voidMoneyTransfer } from '@shareat/domain';
import { TRANSFER_RECORD_RULES, TRANSFER_SETTLE_RULES, TRANSFER_VOID_RULES } from '@shareat/domain/field-rules';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../lib/session';
import { errorMessage } from '@/lib/constraint-messages';
import { redirectWithFlash } from '@/lib/flash';
import { can, verifyAdminApproval } from '@shareat/auth';
import { moneyAccountsRepo } from '@shareat/db';
import { loadDestructiveTarget, recordApproval } from '@/lib/destructive';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createMoneyTransferAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let warning = '';

  try {
    const amountOut = str(formData, 'amountOut');

    // ⭐ A blank "amount that arrived" means the transfer cost nothing — the ordinary case, and by
    // far the common one. The field stays visible and labelled rather than hidden behind a
    // "has a fee?" toggle, because the fee is exactly what a person is checking for when they
    // reconcile the two statements. Blank is a shortcut, not a default that hides a decision.
    const amountIn = str(formData, 'amountIn') || amountOut;

    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      // T-440 / S9 pattern iii (createMoneyTransfer is also called by remittance): the form's own rules are judged only once the
      // actor holds the gate. Capability and store copied from prepareTransfer's first authorize() - 'transfer_funds' at the
      // SOURCE account's store. An account that cannot be loaded (blank, not a uuid, not in this org) has no store to gate on and
      // the domain refuses it by name; do not show field sentences without a successful capability check.
      const fromId = str(formData, 'fromMoneyAccountId');
      const from = UUID_SHAPE.test(fromId) ? await moneyAccountsRepo.getById(tx, actor.orgId, fromId) : null;
      if (from && (await can(tx, actor, 'transfer_funds', { storeId: from.storeId }))) assertFieldRules(TRANSFER_RECORD_RULES, formData);
      return createMoneyTransfer(tx, actor, {
        // DEF-778: minted once when the form rendered; the domain refuses a missing or non-uuid value.
        requestId: str(formData, 'requestId'),
        fromMoneyAccountId: fromId,
        toMoneyAccountId: str(formData, 'toMoneyAccountId'),
        amountOut,
        amountIn,
        transferDate: str(formData, 'transferDate'),
        reference: str(formData, 'reference') || null,
        notes: str(formData, 'notes') || null,
      });
    });
    // ⚠️ Carried out to the page, never swallowed. The transfer POSTED — this says the source
    // could not cover it, which for a cashier drawer is expected and for anyone reading the
    // books is worth knowing.
    if (result.warning) warning = result.warning;
  } catch (err) {
    return await redirectWithFlash('/money-transfers', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/money-transfers', {}, warning ? { ok: 'created', warning } : { ok: 'created' });
}

/**
 * ⭐ T-369 S9 (DEF-557): "Settle between stores". A money transfer that also clears what one store owes the other,
 * capped by what the ledger says is owed. Thin adapter like the others - `settleBetweenStores` authorizes `transfer_funds`
 * at BOTH stores itself, and every refusal it writes reaches `?error=` as its own sentence. `settlementId` is
 * generated when the page renders, so a double click is a replay and not a second settlement.
 */
export async function settleBetweenStoresAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  let warning = '';

  try {
    const amountOut = str(formData, 'amountOut');
    // Blank "amount that arrived" = the settlement cost nothing (the usual case), as on the ordinary transfer form.
    const amountIn = str(formData, 'amountIn') || amountOut;

    const result = await withOrgPrincipal(actor.orgId, async (tx) => {
      // T-440 / S9 pattern iii: the gate sits inside the shared prepareTransfer, after both accounts are loaded, so the rule is
      // judged here once the actor holds it. Capability and store copied from prepareTransfer's first authorize() -
      // 'transfer_funds' at the PAYING account's store. An account that cannot be loaded has no store to gate on and the domain
      // refuses it by name; do not show field sentences without a successful capability check.
      const fromId = str(formData, 'fromMoneyAccountId');
      const from = UUID_SHAPE.test(fromId) ? await moneyAccountsRepo.getById(tx, actor.orgId, fromId) : null;
      if (from && (await can(tx, actor, 'transfer_funds', { storeId: from.storeId }))) assertFieldRules(TRANSFER_SETTLE_RULES, formData);
      return settleBetweenStores(tx, actor, {
        settlementId: str(formData, 'settlementId'),
        fromMoneyAccountId: fromId,
        toMoneyAccountId: str(formData, 'toMoneyAccountId'),
        amountOut,
        amountIn,
        transferDate: str(formData, 'transferDate'),
        reference: str(formData, 'reference') || null,
        notes: str(formData, 'notes') || null,
      });
    });
    if (result.warning) warning = result.warning;
  } catch (err) {
    return await redirectWithFlash('/money-transfers', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/money-transfers', {}, warning ? { ok: 'settled', warning } : { ok: 'settled' });
}

export async function voidMoneyTransferAction(formData: FormData): Promise<void> {
  const actor = await requireActor();

  try {
    const reason = str(formData, 'reason');
    // T-412 Tier P: an administrator's PIN, verified on the server against the RECORD's store.
    const moneyTransferId = str(formData, 'moneyTransferId');
    const target = await loadDestructiveTarget(actor, 'money_transfer', moneyTransferId, ['transfer_funds']);
    assertFieldRules(TRANSFER_VOID_RULES, formData);
    const approval = await verifyAdminApproval(null, { actor, storeId: target.storeId, pin: str(formData, 'adminPin'), capability: 'transfer_funds' });
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await voidMoneyTransfer(tx, actor, { moneyTransferId, reason });
      await recordApproval(tx, actor, approval, { capability: 'transfer_funds', entityType: 'money_transfer', entityId: moneyTransferId, storeId: target.storeId });
    });
  } catch (err) {
    return await redirectWithFlash('/money-transfers', {}, { error: errorMessage(err) });
  }

  return await redirectWithFlash('/money-transfers', {}, { stamp: 'VOID', ok: 'Money transfer voided.' });
}
