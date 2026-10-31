/**
 * The part of `createMoneyTransfer` that a settlement shares with it. T-369 S9 (DEF-557) — a pure move out of `index.ts`.
 * Internal to `money-transfers/`: `index.ts` and `settle.ts` import from here and the barrel does not re-export it.
 */
import { authorize, type Actor } from '@shareat/auth';
import { compare, isZero, subtract, ZERO, type Money } from '@shareat/core/money';
import { moneyAccountsRepo, type MoneyAccountRow, type Tx } from '@shareat/db';
import { checkDraw } from '../money-accounts/overdraft';
import type { PostEntryLine } from '../ledger/post-entry';
import { parseMoneyInput } from '../shared/money-input';
import type { CreateMoneyTransferInput } from './index';

/** Where a fee lands when the transfer costs something. `6870` Bank charges — the account
 *  POSTING-PATTERNS §Transfer's own worked example uses. */
export const DEFAULT_FEE_ACCOUNT_CODE = '6870';

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

export interface PreparedTransfer {
  from: MoneyAccountRow;
  to: MoneyAccountRow;
  crossStore: boolean;
  amountOut: Money;
  amountIn: Money;
  fee: Money;
  feeAccountCode: string | null;
  memo: string;
  /** The cash legs and the fee leg only — a cross-store transfer or a settlement appends its own pair. */
  lines: PostEntryLine[];
  /** ⛔/⚠️ The overdraw rule (bible row 154), as a thunk so a caller that must look up a replay FIRST can do that
   *  before asking whether the source still holds the money. `createMoneyTransfer` calls it straight away. */
  checkDraw: () => Promise<string | null | undefined>;
}

/**
 * The shared half of `createMoneyTransfer` and `settleBetweenStores`, in the order the transfer always ran:
 * the accounts differ → both ends load → office to office across stores (bible row 152) → `transfer_funds` at the
 * source, and at the destination when it is another store (row 153) → both amounts parsed → money that arrives
 * without leaving is refused. Internal to this directory (`index.ts` and `settle.ts` import it; it is NOT re-exported from the barrel).
 */
export async function prepareTransfer(
  tx: Tx,
  actor: Actor,
  input: Omit<CreateMoneyTransferInput, 'requestId'>,
): Promise<PreparedTransfer> {
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

  const amountOut = parseMoneyInput(input.amountOut, 'createMoneyTransfer: amountOut', 'The amount sent');
  const amountIn = parseMoneyInput(input.amountIn, 'createMoneyTransfer: amountIn', 'The amount received');
  // T-371: both figures are `Money` brands from `parseMoneyInput`, so every comparison below is scaled bigint
  // (`compare`) — never `Number()`, which a NaN would slip past.
  if (compare(amountOut, ZERO) <= 0 || compare(amountIn, ZERO) <= 0) {
    throw new Error('createMoneyTransfer: both amounts must be greater than zero.');
  }
  // ⛔ Money arriving that never left is not a transfer — it is income, and it must not be
  // enterable here.
  if (compare(amountIn, amountOut) > 0) {
    throw new Error(
      `createMoneyTransfer: ${amountIn} arrived but only ${amountOut} left. Money ` +
        'that arrives without leaving somewhere is income, not a transfer.',
    );
  }

  const fee = subtract(amountOut, amountIn);
  const feeAccountCode = isZero(fee) ? null : (input.feeAccountCode ?? DEFAULT_FEE_ACCOUNT_CODE);

  // ⭐ Party goes on 1140 legs ONLY. `1110`/`1120`/`1130` already say who holds them — the code IS
  // the location — while one control account covers every wallet, so only 1140 is ambiguous.
  // Requiring a party on all four would be ceremony for three of them, and 0024's trigger only
  // demands it where it resolves something.
  const partyFor = (a: MoneyAccountRow) =>
    a.glAccountCode === '1140' ? { partyType: 'money_account' as const, partyId: a.id } : {};

  const memo = `Transfer — ${from.name} to ${to.name}`;
  const lines: PostEntryLine[] = [
    { accountCode: to.glAccountCode, storeId: to.storeId, debit: amountIn, ...partyFor(to) },
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
      credit: amountOut,
      ...partyFor(from),
    },
  ];

  return {
    from,
    to,
    crossStore,
    amountOut,
    amountIn,
    fee,
    feeAccountCode,
    memo,
    lines,
    // ⛔/⚠️ OVERDRAWING — blocked for an office or staff account, WARNED for a cashier one.
    //
    // The whole rule lives in `checkDraw` (bible row 154) so this and `approveExpense` cannot
    // drift: the same act must not be legal on one screen and refused on the next.
    //
    // ⚠️ Deliberately NOT applied to a reversal. Voiding takes money back out of the destination,
    // which can overdraw it if the money has since moved on — but refusing the reversal would leave
    // a wrong entry with no way to correct it. A correction must always be possible; the resulting
    // negative is the signal to fix what came after it.
    checkDraw: () => checkDraw(tx, actor.orgId, from, amountOut, 'createMoneyTransfer'),
  };
}

