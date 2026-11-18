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
import { advisoryLocksRepo, moneyAccountsRepo, moneyTransfersRepo, storesRepo, type Tx } from '@shareat/db';
import { equals, formatMoney, fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import { logger } from '@shareat/core/logger';
import { postEntryOnce, requireRequestId } from '../ledger/replay';
import { refuse } from '../shared/refusal';
import { reverseEntry } from '../ledger/reverse-entry';
import { prepareTransfer } from './prepare';

// ⭐ T-369 S9 (DEF-557): the settlement lives in `settle.ts`; both it and `createMoneyTransfer` share `prepare.ts`.
export { settleBetweenStores } from './settle';
export type { SettleBetweenStoresInput, SettleBetweenStoresResult } from './settle';

export interface CreateMoneyTransferInput {
  /**
   * DEF-778: generated when the form renders and submitted back. The journal key is `transfer:${requestId}:post` and the
   * `money_transfers` row's id IS this, so a double click is a replay (the first result comes back) and the primary key
   * backstops a racing one. A missing or non-uuid value is refused; a replay with other figures is refused.
   */
  requestId: string;
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
  const requestId = requireRequestId('createMoneyTransfer', input.requestId);
  // T-369 S9: everything up to the amounts is `prepareTransfer` (prepare.ts), a pure move out of here, in its old order.
  const { from, to, crossStore, amountOut, amountIn, fee, feeAccountCode, memo, lines, ...prepared } = await prepareTransfer(tx, actor, input);
  // DEF-876: a cross-store transfer moves what the pair owes each other, so it takes the same per-pair lock a settlement
  // and a void take - first, then the account draw lock (the order `settleBetweenStores` uses).
  if (crossStore) await advisoryLocksRepo.lockInterStorePair(tx, from.storeId, to.storeId);

  // DEF-778: the replay is looked up BEFORE the overdraw rule - after the first call spent the money, judging the same
  // request afresh would refuse a harmless double click (or, worse, warn about it).
  const replayed = await moneyTransfersRepo.getById(tx, actor.orgId, requestId);
  const replayWanted = {
    from,
    to,
    amountOut,
    amountIn,
    transferDate: input.transferDate,
    fee,
    feeAccountCode,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
  };
  if (replayed) return replayOf(replayed, replayWanted);
  // ⛔/⚠️ The overdraw rule (bible row 154) — `checkDraw` is the whole of it, shared with `approveExpense`.
  // DEF-778 audit: take the T-501 lock on the source BEFORE judging the draw, then look for the replay once more. A simultaneous
  // double submit queues on this lock; by the time it gets it, the first has committed and spent the money, so judging the
  // draw afresh would refuse a harmless double click as "cannot cover".
  await moneyAccountsRepo.lockForDraw(tx, actor.orgId, from.id);
  const replayedAfterLock = await moneyTransfersRepo.getById(tx, actor.orgId, requestId);
  if (replayedAfterLock) return replayOf(replayedAfterLock, replayWanted);
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

  // The form's request id is the key and the row's own id - a retry of the SAME submit is a no-op, while a genuinely
  // repeated transfer (two ₱500 top-ups on one day, which happens) is a new render with its own id and posts properly.
  const id = requestId;
  const posted = await postEntryOnce(tx, {
    orgId: actor.orgId,
    entryDate: input.transferDate,
    sourceType: 'transfer',
    sourceId: id,
    idempotencyKey: `transfer:${id}:post`,
    memo,
    postedBy: actor.personId,
    lines,
  });

  if (!posted.created) {
    // A racing double click: the other transaction committed the entry (and its row) while this one waited on the key.
    const winner = await moneyTransfersRepo.getById(tx, actor.orgId, id);
    if (winner) return replayOf(winner, replayWanted);
  }

  const inserted = await moneyTransfersRepo.insertMoneyTransfer(tx, {
    id,
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

  if (!inserted) {
    // A simultaneous double submit committed this id first - or the id belongs to another org, which org-scoped reads cannot see.
    const winner = await moneyTransfersRepo.getById(tx, actor.orgId, id);
    if (!winner) {
      throw refuse(
        `createMoneyTransfer: requestId ${id} already belongs to a row outside this org.`,
        'This form is out of date. Reload the page and try again.',
      );
    }
    return replayOf(winner, replayWanted);
  }

  return { id: inserted.id, entryId: posted.entryId, fee, ...(warning ? { warning } : {}) };
}

/** DEF-778: a replayed request returns the first result, but only if it asked for the same transfer. */
function replayOf(
  row: NonNullable<Awaited<ReturnType<typeof moneyTransfersRepo.getById>>>,
  now: {
    from: { id: string };
    to: { id: string };
    amountOut: Money;
    amountIn: Money;
    transferDate: string;
    fee: string;
    feeAccountCode: string | null;
    reference: string | null;
    notes: string | null;
  },
): CreateMoneyTransferResult {
  if (row.status === 'voided') {
    throw refuse(`createMoneyTransfer: requestId ${row.id} was voided.`, 'This was voided. Reload the page and start a new one.');
  }
  const same =
    (row.feeAccountCode ?? null) === (now.feeAccountCode ?? null) &&
    (row.reference ?? null) === now.reference &&
    (row.notes ?? null) === now.notes &&
    row.fromMoneyAccountId === now.from.id &&
    row.toMoneyAccountId === now.to.id &&
    equals(money(row.amountOut), now.amountOut) &&
    equals(money(row.amountIn), now.amountIn) &&
    String(row.transferDate).slice(0, 10) === String(now.transferDate).slice(0, 10);
  if (!same || !row.journalEntryId) {
    throw refuse(
      `createMoneyTransfer: requestId ${row.id} was already posted with different accounts, amounts or date.`,
      'This was already recorded with different figures. Reload the page and try again.',
    );
  }
  return { id: row.id, entryId: row.journalEntryId, fee: now.fee };
}

/**
 * ⛔ Void, never delete — through `reverseEntry`, never a hand-written opposite entry.
 *
 * The original entry stays, the reversal stays, and the row that names them both stays. v1's
 * `adminDeleteRecordAction` goes straight to `ref.delete()` with no reversal branch, which is
 * how a ledger ends up holding legs that point at nothing.
 */
export interface VoidMoneyTransferInput {
  moneyTransferId: string;
  reason: string;
  voidDate?: string;
  /** DEF-875: set ONLY by `reverseRemittance`, which voids its own legs. Anyone else is refused a remittance leg. */
  viaRemittanceReversal?: boolean;
}

export async function voidMoneyTransfer(
  tx: Tx,
  actor: Actor,
  input: VoidMoneyTransferInput,
): Promise<{ reversalEntryId: string }> {
  return runVoid(tx, actor, input);
}

async function runVoid(
  tx: Tx,
  actor: Actor,
  input: VoidMoneyTransferInput,
): Promise<{ reversalEntryId: string }> {
  let transfer = await moneyTransfersRepo.getById(tx, actor.orgId, input.moneyTransferId);
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
  const otherStore = destination && destination.storeId !== transfer.storeId ? destination.storeId : null;
  if (otherStore) {
    await authorize(tx, actor, 'transfer_funds', { storeId: otherStore });
    // DEF-876: the pair lock a settlement and a cross-store create take. Re-read the row once it is ours - a void that
    // held the lock first has committed by now, and the status read above would be stale.
    await advisoryLocksRepo.lockInterStorePair(tx, transfer.storeId, otherStore);
    transfer = (await moneyTransfersRepo.getById(tx, actor.orgId, transfer.id)) ?? transfer;
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
  // ⛔ DEF-875: a remittance leg is undone by reversing the remittance. Voiding it alone returns the cash to the till but
  // leaves the days "remitted", and `reverseRemittance` then fails forever on the already-voided leg.
  if (!input.viaRemittanceReversal && (await moneyTransfersRepo.isPostedRemittanceLeg(tx, transfer.id))) {
    throw refuse(
      `voidMoneyTransfer: transfer ${transfer.id} is a leg of a posted remittance.`,
      'This transfer is part of a remittance (a cashier handover). Reverse the remittance instead - that undoes this transfer and reopens its days.',
    );
  }
  // ⛔ DEF-876: voiding a debt-creating cross-store transfer takes its amount off what the destination store (the debtor)
  // owes the source (the creditor) IN THIS DIRECTION. It is refused only when that would leave the debtor having settled
  // more than it owes in this direction - read per direction (the debtor's 2150 toward the creditor), never on the net, or two
  // plain transfers in opposite directions would trap each other. A settlement's own void only restores a debt: never checked.
  if (otherStore && !(await moneyTransfersRepo.entrySettles(tx, transfer.journalEntryId, transfer.storeId))) {
    const position = await moneyTransfersRepo.interStorePosition(tx, actor.orgId, otherStore, transfer.storeId);
    // The same guard `settleBetweenStores` has: if the two stores' books disagree, refuse rather than judge by one side.
    if (!equals(money(position.owedPerDebtor), money(position.owedPerCreditor))) {
      logger.warn(
        { debtorStoreId: otherStore, creditorStoreId: transfer.storeId, owedPerDebtor: position.owedPerDebtor, owedPerCreditor: position.owedPerCreditor },
        'voidMoneyTransfer: the two stores disagree on what is owed',
      );
      throw refuse(
        `voidMoneyTransfer: the debtor's books say ${position.owedPerDebtor} is owed, the creditor's say ${position.owedPerCreditor}.`,
        "The two stores' records of what is owed don't match, so this can't be reversed yet. Ask the accountant to check the stores' due-to and due-from balances.",
      );
    }
    const owedInDirection = money(await moneyTransfersRepo.interStoreDirectionOwed(tx, actor.orgId, otherStore, transfer.storeId));
    const settledOfThis = toCentavos(money(transfer.amountIn)) - toCentavos(owedInDirection);
    if (settledOfThis > 0n) {
      const [source, dest] = await Promise.all([
        storesRepo.getById(tx, actor.orgId, transfer.storeId),
        storesRepo.getById(tx, actor.orgId, otherStore),
      ]);
      throw refuse(
        `voidMoneyTransfer: voiding ${transfer.id} (${transfer.amountIn}) would leave ${otherStore} owing ${transfer.storeId} less than it has settled (owes ${owedInDirection} in this direction).`,
        `${dest?.name ?? 'The receiving store'} has already settled ${formatMoney(fromCentavos(settledOfThis))} of this with ${source?.name ?? 'the sending store'}. Reverse that settlement first, then reverse this transfer.`,
      );
    }
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
