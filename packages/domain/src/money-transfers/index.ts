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
import {
  moneyAccountsRepo,
  moneyTransfersRepo,
  transaction,
  type MoneyAccountRow,
  type Tx,
} from '@shareat/db';
import { checkDraw } from '../money-accounts/overdraft';
import { postEntry, type PostEntryLine } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';

/** Where a fee lands when the transfer costs something. `6870` Bank charges — the account
 *  POSTING-PATTERNS §Transfer's own worked example uses. */
export const DEFAULT_FEE_ACCOUNT_CODE = '6870';

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
  tx: Tx | null,
  actor: Actor,
  input: CreateMoneyTransferInput,
): Promise<CreateMoneyTransferResult> {
  if (tx) return runCreate(tx, actor, input);
  return transaction((trx) => runCreate(trx, actor, input));
}

async function loadEnd(
  tx: Tx,
  actor: Actor,
  id: string,
  side: 'source' | 'destination',
): Promise<MoneyAccountRow> {
  const account = await moneyAccountsRepo.getById(tx, actor.orgId, id);
  if (!account) {
    throw new Error(`createMoneyTransfer: the ${side} account ${id} does not exist in this org.`);
  }
  // ⛔ A retired account cannot be either end. Retirement already refuses to hide an account
  // holding money; letting a transfer target one would put money back into a place no picker
  // offers — the same stranding, arrived at from the other direction.
  if (!account.isActive) {
    throw new Error(
      `createMoneyTransfer: "${account.name}" is retired and cannot be the ${side} of a transfer.`,
    );
  }
  return account;
}

async function runCreate(
  tx: Tx,
  actor: Actor,
  input: CreateMoneyTransferInput,
): Promise<CreateMoneyTransferResult> {
  if (input.fromMoneyAccountId === input.toMoneyAccountId) {
    throw new Error('createMoneyTransfer: the source and destination must be different accounts.');
  }

  const from = await loadEnd(tx, actor, input.fromMoneyAccountId, 'source');
  const to = await loadEnd(tx, actor, input.toMoneyAccountId, 'destination');

  // ⭐ CROSS-STORE IS ALLOWED, BUT ONLY OFFICE TO OFFICE (bible row 152).
  //
  // > **Ian, 2026-08-26:** *"a manager of lipa and malvar who is not allowed to get remittance is
  // > able to collect money from malvar to spend on lipa but that's deeply wrong … the right
  // > pattern is malvar remits to office first before lipa can use it."*
  //
  // ⛔ **This check IS that rule.** The abuse is a manager reaching into another store's TILL, so
  // the fix is not to ban cross-store movement — the business genuinely needs it — but to force it
  // through the office. Malvar's cashier remits to Malvar's office in the ordinary way; only then
  // can that money fund Lipa. A cashier or staff account at either end is refused, which makes the
  // bypass unrepresentable rather than merely discouraged.
  //
  // Landing it in the destination's OFFICE (not straight into a till) keeps one due-from/due-to
  // pair per movement; Lipa then moves it onward with an ordinary same-store transfer.
  const crossStore = from.storeId !== to.storeId;
  if (crossStore && (from.custodian !== 'office' || to.custodian !== 'office')) {
    throw new Error(
      `createMoneyTransfer: money moves between stores office to office only, and "${from.name}" ` +
        `(${from.custodian}) → "${to.name}" (${to.custodian}) is not. A store remits to its own ` +
        'office first; only office money can fund another store.',
    );
  }

  // Store-scoped: the authority is over THIS store's money.
  await authorize(tx, actor, 'transfer_funds', { storeId: from.storeId });

  // ⭐ A CROSS-STORE MOVE NEEDS STORE ACCESS TO **BOTH** ENDS (Ian, 2026-08-26; bible row 153).
  //
  // > *"cross store money movement will only be possible for manager initiated transactions,
  // > with manager having access … to both stores."*
  //
  // ⚠️ **Authorising only the source was a real hole**, and it is the same hole Ian described
  // from the other side: a manager scoped to Malvar alone could push Malvar's office money into
  // Lipa — a store they have no standing in — and Lipa would simply find money it did not ask
  // for and now owes for. Requiring scope at BOTH ends means only someone who actually answers
  // for both stores can create a debt between them.
  //
  // `authorize` checks `personHasStoreScope` per call, so a second call IS the rule — no new
  // helper, and the denial message names the store that is missing.
  if (crossStore) {
    await authorize(tx, actor, 'transfer_funds', { storeId: to.storeId });
  }

  const out = Number(input.amountOut);
  const inn = Number(input.amountIn);
  if (!(out > 0) || !(inn > 0)) {
    throw new Error('createMoneyTransfer: both amounts must be greater than zero.');
  }
  // ⛔ Money arriving that never left is not a transfer — it is income, and it must not be
  // enterable here.
  if (inn > out) {
    throw new Error(
      `createMoneyTransfer: ${input.amountIn} arrived but only ${input.amountOut} left. Money ` +
        'that arrives without leaving somewhere is income, not a transfer.',
    );
  }

  // ⛔/⚠️ OVERDRAWING — blocked for an office or staff account, WARNED for a cashier one.
  //
  // The whole rule lives in `checkDraw` (bible row 154) so this and `approveExpense` cannot
  // drift: the same act must not be legal on one screen and refused on the next.
  //
  // ⚠️ Deliberately NOT applied to a reversal. Voiding takes money back out of the destination,
  // which can overdraw it if the money has since moved on — but refusing the reversal would leave
  // a wrong entry with no way to correct it. A correction must always be possible; the resulting
  // negative is the signal to fix what came after it.
  const warning = await checkDraw(tx, actor.orgId, from, out, 'createMoneyTransfer');

  const fee = (out - inn).toFixed(2);
  const feeAccountCode = Number(fee) > 0 ? (input.feeAccountCode ?? DEFAULT_FEE_ACCOUNT_CODE) : null;

  // ⭐ Party goes on 1140 legs ONLY. `1110`/`1120`/`1130` already say who holds them — the code IS
  // the location — while one control account covers every wallet, so only 1140 is ambiguous.
  // Requiring a party on all four would be ceremony for three of them, and 0024's trigger only
  // demands it where it resolves something.
  const partyFor = (a: MoneyAccountRow) =>
    a.glAccountCode === '1140' ? { partyType: 'money_account' as const, partyId: a.id } : {};

  const memo = `Transfer — ${from.name} to ${to.name}`;
  const lines: PostEntryLine[] = [
    { accountCode: to.glAccountCode, storeId: to.storeId, debit: input.amountIn, ...partyFor(to) },
    // ⚠️ The fee sits at the SOURCE store, because the source is who paid it — it was deducted
    // from their money, not the recipient's.
    ...(feeAccountCode
      ? [
          {
            accountCode: feeAccountCode,
            storeId: from.storeId,
            debit: fee,
            lineMemo: `Fee on ${memo}`,
          },
        ]
      : []),
    {
      accountCode: from.glAccountCode,
      storeId: from.storeId,
      credit: input.amountOut,
      ...partyFor(from),
    },
  ];

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
        debit: input.amountIn,
        partyType: 'store' as const,
        partyId: toCode,
        lineMemo: `Due from ${toCode} — ${memo}`,
      },
      {
        accountCode: '2150',
        storeId: to.storeId,
        credit: input.amountIn,
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
    amountOut: input.amountOut,
    amountIn: input.amountIn,
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
  tx: Tx | null,
  actor: Actor,
  input: { moneyTransferId: string; reason: string; voidDate?: string },
): Promise<{ reversalEntryId: string }> {
  if (tx) return runVoid(tx, actor, input);
  return transaction((trx) => runVoid(trx, actor, input));
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
