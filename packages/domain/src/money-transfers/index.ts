/**
 * Money transfers — moving money between the places it sits. T-139, bible row 150.
 *
 * > **Ian, 2026-08-26:** *"Each account can move money in any direction — cashier cash to cashier
 * > online, office to office, office to cashier, cashier to office, depending on transaction."*
 *
 * The 4th most-used entry in v1 (`POSTING-PATTERNS.md` §Transfer, **926 legs**).
 *
 * ## ⭐ Manager-level, deliberately NOT admin-only
 *
 * > **Ian, 2026-08-26:** *"yes manager level money transfer."*
 *
 * Bible row 149 made **opening** an account admin-only; row 150 keeps **moving money between
 * accounts that already exist** at manager. The distinction is the whole point: adding an account
 * changes what the books can record against, while a transfer RECORDS something that happened. A
 * manager who may accept a remittance — the single largest transfer this business makes — cannot
 * coherently be barred from moving ₱500 between two drawers.
 */
import { authorize, type Actor } from '@shareat/auth';
import { moneyAccountsRepo, moneyTransfersRepo, type Tx } from '@shareat/db';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { prepareTransfer } from './prepare';

// ⭐ T-369 S9 (DEF-557): the settlement lives in `settle.ts`; both it and `createMoneyTransfer` share `prepare.ts`.
export { settleBetweenStores } from './settle';
export type { SettleBetweenStoresInput, SettleBetweenStoresResult } from './settle';

export interface CreateMoneyTransferInput {
  fromMoneyAccountId: string;
  toMoneyAccountId: string;
  /**
   * ⭐ **Both figures are stated; the fee is DERIVED** (T-139 §3).
   *
   * `amountOut` left the source, `amountIn` reached the destination. v1 takes a single `amount`
   * and charges the source `amount + fee`; this project's own posting doc narrates the same three
   * legs the other way round. The legs are identical either way — but the same number typed in the
   * same box would produce two different transfers, and **both readings are real here**: a bank
   * wire adds its fee to the source (send ₱10,000, get debited ₱10,050), a cash-out deducts it
   * from the target (cash out ₱10,000, receive ₱9,950).
   *
   * Asking for both removes the convention entirely, and each is a figure a person reads off the
   * statement they are reconciling against — which is what makes a transfer checkable at all.
   */
  amountOut: string;
  amountIn: string;
  transferDate: string;
  feeAccountCode?: string;
  reference?: string | null;
  notes?: string | null;
}

export interface CreateMoneyTransferResult {
  id: string;
  entryId: string;
  fee: string;
  /** ⚠️ Present when the source could not cover the draw but was allowed anyway — a cashier
   *  account whose day is not yet verified. Show it; never swallow it. */
  warning?: string;
}

export async function createMoneyTransfer(
  tx: Tx,
  actor: Actor,
  input: CreateMoneyTransferInput,
): Promise<CreateMoneyTransferResult> {
  return runCreate(tx, actor, input);
}

async function runCreate(
  tx: Tx,
  actor: Actor,
  input: CreateMoneyTransferInput,
): Promise<CreateMoneyTransferResult> {
  // T-369 S9: everything up to the amounts is `prepareTransfer` (prepare.ts), a pure move out of here, in its old order.
  const { from, to, crossStore, amountOut, amountIn, fee, feeAccountCode, memo, lines, ...prepared } = await prepareTransfer(tx, actor, input);
  // ⛔/⚠️ The overdraw rule (bible row 154) — `checkDraw` is the whole of it, shared with `approveExpense`.
  const warning = await prepared.checkDraw();

  if (crossStore) {
    // ⭐ THE DUE-FROM / DUE-TO PAIR — the same four-leg shape `commissary_dispatch.transfer`
    // already uses, with cash in place of inventory. Without it each store's own books would not
    // balance on their own: Malvar would show money leaving and nothing received, Lipa the
    // reverse.
    //
    // ⚠️ These must ELIMINATE at entity level — total 1250 across all stores equals total 2150
    // (bible invariant 6's reciprocal check). That is what makes the group's cash correct while
    // each store still carries what it owes the other.
    const codes = await moneyTransfersRepo.storeCodes(tx, actor.orgId, [from.storeId, to.storeId]);
    const fromCode = codes.get(from.storeId);
    const toCode = codes.get(to.storeId);
    if (!fromCode || !toCode) {
      throw new Error('createMoneyTransfer: could not resolve both store codes for the transfer.');
    }
    lines.push(
      // The source is owed what actually LANDED — not what left. The fee is its own cost, not a
      // debt the other store incurred.
      {
        accountCode: '1250',
        storeId: from.storeId,
        debit: amountIn,
        partyType: 'store' as const,
        partyId: toCode,
        lineMemo: `Due from ${toCode} — ${memo}`,
      },
      {
        accountCode: '2150',
        storeId: to.storeId,
        credit: amountIn,
        partyType: 'store' as const,
        partyId: fromCode,
        lineMemo: `Due to ${fromCode} — ${memo}`,
      },
    );
  }

  // The id is generated up front so the idempotency key and the row's own id agree — a retry of
  // the SAME transfer is a no-op, while a genuinely repeated transfer (two ₱500 top-ups on one
  // day, which happens) gets its own id and posts properly.
  const id = crypto.randomUUID();
  const posted = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: input.transferDate,
    sourceType: 'transfer',
    sourceId: id,
    idempotencyKey: `transfer:${id}:post`,
    memo,
    postedBy: actor.personId,
    lines,
  });

  const row = await moneyTransfersRepo.insertMoneyTransfer(tx, {
    orgId: actor.orgId,
    storeId: from.storeId,
    fromMoneyAccountId: from.id,
    toMoneyAccountId: to.id,
    amountOut,
    amountIn,
    feeAccountCode,
    transferDate: input.transferDate,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
    journalEntryId: posted.entryId,
    createdBy: actor.personId,
  });

  return { id: row.id, entryId: posted.entryId, fee, ...(warning ? { warning } : {}) };
}

/**
 * ⛔ Void, never delete — through `reverseEntry`, never a hand-written opposite entry.
 *
 * The original entry stays, the reversal stays, and the row that names them both stays. v1's
 * `adminDeleteRecordAction` goes straight to `ref.delete()` with no reversal branch, which is
 * how a ledger ends up holding legs that point at nothing.
 */
export async function voidMoneyTransfer(
  tx: Tx,
  actor: Actor,
  input: { moneyTransferId: string; reason: string; voidDate?: string },
): Promise<{ reversalEntryId: string }> {
  return runVoid(tx, actor, input);
}

async function runVoid(
  tx: Tx,
  actor: Actor,
  input: { moneyTransferId: string; reason: string; voidDate?: string },
): Promise<{ reversalEntryId: string }> {
  const transfer = await moneyTransfersRepo.getById(tx, actor.orgId, input.moneyTransferId);
  if (!transfer) {
    throw new Error(
      `voidMoneyTransfer: money transfer ${input.moneyTransferId} does not exist in this org.`,
    );
  }
  await authorize(tx, actor, 'transfer_funds', { storeId: transfer.storeId });
  // ⚠️ T-369 S9·N1 (DEF-558): creating a cross-store transfer needed `transfer_funds` at BOTH ends (bible row 153), so
  // undoing it - a settlement or an ordinary one - needs both too. Only the source store was asked here, so a manager
  // at the source alone could pull money back out of a store they have no standing in.
  const destination = await moneyAccountsRepo.getById(tx, actor.orgId, transfer.toMoneyAccountId);
  if (destination && destination.storeId !== transfer.storeId) {
    await authorize(tx, actor, 'transfer_funds', { storeId: destination.storeId });
  }

  const reason = input.reason.trim();
  if (!reason) {
    throw new Error(
      'voidMoneyTransfer: a reason is required — a reversal with no reason is a gap.',
    );
  }
  if (transfer.status !== 'posted') {
    throw new Error(`voidMoneyTransfer: this transfer is already ${transfer.status}.`);
  }
  if (!transfer.journalEntryId) {
    throw new Error('voidMoneyTransfer: this transfer has no journal entry to reverse.');
  }

  const reversal = await reverseEntry(tx, {
    entryId: transfer.journalEntryId,
    reason,
    reversalDate: input.voidDate,
    reversedBy: actor.personId,
    idempotencyKey: `transfer:${transfer.id}:void`,
  });

  await moneyTransfersRepo.markVoided(tx, actor.orgId, transfer.id, {
    voidedOn: input.voidDate ?? transfer.transferDate,
    voidReason: reason,
    voidedBy: actor.personId,
  });

  return { reversalEntryId: reversal.reversalEntryId };
}
