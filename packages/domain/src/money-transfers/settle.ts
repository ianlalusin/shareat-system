/**
 * ⭐ T-369 S9 (DEF-557) — settle between stores. `docs/tasks/369-unwired-money-screens.md` §S9.
 *
 * Nothing used to clear 1250/2150: a Lipa → Malvar transfer meant to REPAY posted the ordinary cross-store pair
 * (DR 1250 at Lipa, CR 2150 at Malvar), which adds a second, opposite debt beside the first, so both stores' balances
 * grew forever. A settlement is the same single entry as the cash move, capped by what the ledger says is owed:
 * the cash legs of a normal transfer, then the CLEARING pair for what the creditor actually received —
 *
 *   DR 2150 at the DEBTOR  (party = the creditor's code)   the debtor's debt goes down
 *   CR 1250 at the CREDITOR (party = the debtor's code)    the creditor's claim goes down
 *
 * `sourceType` stays `'transfer'` (`remittance.ts` excludes it from custody movement; a new type would leak
 * settlements into the cashier's remittance figures). No new capability: `transfer_funds` at BOTH stores, exactly as a
 * cross-store transfer.
 *
 * `prepareTransfer` (in `prepare.ts`) is the part of `createMoneyTransfer` the two share — load both ends, the
 * office-only rule, both `authorize` calls, the amounts, the fee and the cash legs.
 */
import type { Actor } from '@shareat/auth';
import { equals, fromCentavos, formatMoney, money, negate, toCentavos } from '@shareat/core/money';
import { logger } from '@shareat/core/logger';
import { advisoryLocksRepo, journalRepo, moneyTransfersRepo, storesRepo, type Tx } from '@shareat/db';
import { postEntry } from '../ledger/post-entry';
import { internalFault, refuse } from '../shared/refusal';
import type { CreateMoneyTransferResult } from './index';
import { prepareTransfer } from './prepare';

export interface SettleBetweenStoresInput {
  /** ⭐ Generated when the form renders. The journal key is `transfer:${settlementId}:post` and the `money_transfers`
   *  row's id IS this, so a replay returns the first result and the primary key backstops a racing double click. */
  settlementId: string;
  fromMoneyAccountId: string;
  toMoneyAccountId: string;
  amountOut: string;
  amountIn: string;
  transferDate: string;
  feeAccountCode?: string;
  reference?: string | null;
  notes?: string | null;
}

export type SettleBetweenStoresResult = CreateMoneyTransferResult & {
  /** What the debtor still owes the creditor after this settlement. */
  owedAfter: string;
};

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The debtor's accounts pay, the creditor's receive. Order: `prepareTransfer` → the same-store refusal → the pair lock
 * → the replay lookup → the owed position (both stores' books) → the direction, cap and agreement refusals → the
 * overdraw rule → the cash legs plus the clearing pair in ONE entry → the row (id = `settlementId`).
 *
 * Partial settlement is allowed: any `amountIn` from ₱0.01 up to what is owed; the remainder stays owed.
 */
export async function settleBetweenStores(
  tx: Tx,
  actor: Actor,
  input: SettleBetweenStoresInput,
): Promise<SettleBetweenStoresResult> {
  return runSettle(tx, actor, input);
}

async function runSettle(tx: Tx, actor: Actor, input: SettleBetweenStoresInput): Promise<SettleBetweenStoresResult> {
  if (!UUID_SHAPE.test(input.settlementId ?? '')) {
    throw refuse(
      'settleBetweenStores: settlementId is missing or not a uuid',
      'This settlement form is out of date. Reload the page and try again.',
    );
  }
  const settlementId = input.settlementId;
  const prepared = await prepareTransfer(
    tx,
    actor,
    {
      fromMoneyAccountId: input.fromMoneyAccountId,
      toMoneyAccountId: input.toMoneyAccountId,
      amountOut: input.amountOut,
      amountIn: input.amountIn,
      transferDate: input.transferDate,
      ...(input.feeAccountCode ? { feeAccountCode: input.feeAccountCode } : {}),
    },
  );
  const { from, to } = prepared;
  const debtorStoreId = from.storeId;
  const creditorStoreId = to.storeId;
  const [debtor, creditor] = await Promise.all([
    storesRepo.getById(tx, actor.orgId, debtorStoreId),
    storesRepo.getById(tx, actor.orgId, creditorStoreId),
  ]);
  const debtorName = debtor?.name ?? 'The paying store';
  const creditorName = creditor?.name ?? 'the receiving store';

  if (debtorStoreId === creditorStoreId) {
    throw refuse(
      `settleBetweenStores: both accounts belong to store ${debtorStoreId}`,
      `Both accounts belong to ${debtorName} — there is nothing to settle between stores.`,
    );
  }

  // Serialise per UNORDERED pair, after both `authorize` calls and before the replay lookup and the owed read.
  await advisoryLocksRepo.lockInterStorePair(tx, debtorStoreId, creditorStoreId);

  // Both store CODES, up front: the position and the clearing pair name the other store by its code, so a store with
  // none is a data fault, never "nothing owed".
  const codes = await moneyTransfersRepo.storeCodes(tx, actor.orgId, [debtorStoreId, creditorStoreId]);
  const debtorCode = codes.get(debtorStoreId);
  const creditorCode = codes.get(creditorStoreId);
  if (!debtorCode || !creditorCode) {
    throw internalFault('settleBetweenStores: could not resolve both store codes for the settlement.');
  }

  // The replay is looked up BEFORE the cap: after a committed settlement the balance can be 0, and a replay must
  // return that result rather than be refused as "nothing owed".
  const idempotencyKey = `transfer:${settlementId}:post`;
  const replayed = await journalRepo.findEntryByIdempotencyKey(tx, actor.orgId, idempotencyKey);
  if (replayed) {
    const row = await moneyTransfersRepo.getById(tx, actor.orgId, settlementId);
    const same =
      !!row &&
      row.fromMoneyAccountId === from.id &&
      row.toMoneyAccountId === to.id &&
      equals(money(row.amountOut), money(prepared.amountOut)) &&
      equals(money(row.amountIn), money(prepared.amountIn));
    if (!same) {
      throw refuse(
        'settleBetweenStores: settlementId was already posted with different accounts or amounts.',
        'This settlement was already recorded with different figures. Reload the page and try again.',
      );
    }
    const now = await moneyTransfersRepo.interStorePosition(tx, actor.orgId, debtorStoreId, creditorStoreId);
    return { id: settlementId, entryId: replayed.id, fee: prepared.fee, owedAfter: now.owedPerDebtor };
  }

  // What is owed, read from BOTH stores' books. They are posted together, so they agree; if they ever differ the
  // settlement is refused rather than cleared against one side's number.
  const position = await moneyTransfersRepo.interStorePosition(tx, actor.orgId, debtorStoreId, creditorStoreId);
  const owedPerDebtor = money(position.owedPerDebtor);
  const owedPerCreditor = money(position.owedPerCreditor);
  if (!equals(owedPerDebtor, owedPerCreditor)) {
    logger.warn(
      { debtorStoreId, creditorStoreId, owedPerDebtor: position.owedPerDebtor, owedPerCreditor: position.owedPerCreditor },
      'settleBetweenStores: the two stores disagree on what is owed',
    );
    throw refuse(
      `settleBetweenStores: the debtor's books say ${position.owedPerDebtor} is owed, the creditor's say ${position.owedPerCreditor}.`,
      "The two stores' records of what is owed don't match, so this can't be settled yet. Ask the accountant to check the stores' due-to and due-from balances.",
    );
  }
  const owed = owedPerDebtor;
  const owedCentavos = toCentavos(owed);
  if (owedCentavos === 0n) {
    throw refuse(
      `settleBetweenStores: stores ${debtorStoreId} and ${creditorStoreId} owe each other nothing.`,
      `${debtorName} and ${creditorName} owe each other nothing.`,
    );
  }
  if (owedCentavos < 0n) {
    throw refuse(
      `settleBetweenStores: ${creditorStoreId} owes ${debtorStoreId}, not the other way round.`,
      `${debtorName} doesn't owe ${creditorName} — ${creditorName} owes ${debtorName} ${formatMoney(negate(owed))}. Swap the accounts.`,
    );
  }
  const amountIn = money(prepared.amountIn);
  if (toCentavos(amountIn) > owedCentavos) {
    throw refuse(
      `settleBetweenStores: ${prepared.amountIn} is more than the ${position.owedPerDebtor} owed.`,
      `${debtorName} owes ${creditorName} ${formatMoney(owed)}, so ${formatMoney(amountIn)} is more than the debt. Send the difference as an ordinary transfer.`,
    );
  }

  const warning = await prepared.checkDraw();

  const memo = `Settlement — ${debtorName} to ${creditorName}`;
  const posted = await postEntry(tx, {
    orgId: actor.orgId,
    entryDate: input.transferDate,
    sourceType: 'transfer',
    sourceId: settlementId,
    idempotencyKey,
    memo,
    postedBy: actor.personId,
    lines: [
      ...prepared.lines,
      // The clearing pair, for what the creditor actually RECEIVED (the fee is the debtor's own cost, as in a transfer).
      {
        accountCode: '2150',
        storeId: debtorStoreId,
        debit: prepared.amountIn,
        partyType: 'store' as const,
        partyId: creditorCode,
        lineMemo: `Due to ${creditorCode} repaid — ${memo}`,
      },
      {
        accountCode: '1250',
        storeId: creditorStoreId,
        credit: prepared.amountIn,
        partyType: 'store' as const,
        partyId: debtorCode,
        lineMemo: `Due from ${debtorCode} repaid — ${memo}`,
      },
    ],
  });

  const row = await moneyTransfersRepo.insertMoneyTransfer(tx, {
    id: settlementId,
    orgId: actor.orgId,
    storeId: debtorStoreId,
    fromMoneyAccountId: from.id,
    toMoneyAccountId: to.id,
    amountOut: prepared.amountOut,
    amountIn: prepared.amountIn,
    feeAccountCode: prepared.feeAccountCode,
    transferDate: input.transferDate,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
    journalEntryId: posted.entryId,
    createdBy: actor.personId,
  });
  if (!row) {
    throw refuse(
      `settleBetweenStores: settlementId ${settlementId} already belongs to a row this caller cannot replay.`,
      'This form is out of date. Reload the page and try again.',
    );
  }

  return {
    id: row.id,
    entryId: posted.entryId,
    fee: prepared.fee,
    owedAfter: fromCentavos(owedCentavos - toCentavos(amountIn)),
    ...(warning ? { warning } : {}),
  };
}
