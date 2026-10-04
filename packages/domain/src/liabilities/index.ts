/**
 * Generic liabilities — what the business owes that nothing else already tracks. T-128.
 *
 * ```
 * charge    DR the expense (or asset)   CR 2500   (party = the liability)
 * payment   DR 2500 (party = it)        CR the money account
 *                                           → 2500 nets to zero when it is settled
 * ```
 *
 * ⛔ **No stored totals.** v1 keeps `outstandingBalance`, `totalCharged` and `totalPaid` on the
 * account, plus a `LiabilityLedgerEntry` with its own running balance (DEF-074) — the fourth time
 * this exact shape has turned up. Every figure here is summed from `2500` by party.
 */
import { journalRepo, liabilitiesRepo, moneyAccountsRepo, transaction, type Tx } from '@shareat/db';
import type { LiabilityCategory } from '@shareat/db/schema';
import { authorize, type Actor } from '@shareat/auth';
import { postEntry } from '../ledger/post-entry';
import { reverseEntry } from '../ledger/reverse-entry';
import { checkDraw } from '../money-accounts/overdraft';
import { refuse } from '../shared/refusal';
import { parseMoneyInput } from '../shared/money-input';
import { compare, isZero, money, ZERO } from '@shareat/core/money';

export const LIABILITY_CONTROL_CODE = '2500';

export interface CreateLiabilityInput {
  storeId: string;
  name: string;
  category?: LiabilityCategory;
  description?: string | null;
  dueOn?: string | null;
  notes?: string | null;
}

export async function createLiability(
  tx: Tx | null,
  actor: Actor,
  input: CreateLiabilityInput,
): Promise<{ id: string }> {
  const run = async (trx: Tx) => {
    await authorize(trx, actor, 'approve_expense', { storeId: input.storeId });
    const name = input.name.trim();
    if (!name) throw new Error('createLiability: say what this obligation is.');
    return liabilitiesRepo.insertLiability(trx, {
      orgId: actor.orgId,
      storeId: input.storeId,
      name,
      category: input.category ?? 'other',
      description: input.description?.trim() || null,
      dueOn: input.dueOn?.trim() || null,
      notes: input.notes?.trim() || null,
      createdBy: actor.personId,
    });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⭐ **The obligation is incurred.** `DR the expense · CR 2500`.
 *
 * ⚠️ The charge names what the money was FOR — usually an expense account, sometimes an asset (a
 * deposit, a prepayment). It is validated rather than assumed, because a charge that lands on the
 * wrong side of the balance sheet is invisible until something else fails to reconcile.
 */
export async function chargeLiability(
  tx: Tx | null,
  actor: Actor,
  input: {
    liabilityId: string;
    amount: string;
    /** The account the obligation was incurred FOR — an expense, or an asset. */
    againstAccountCode: string;
    on: string;
    memo?: string;
  },
): Promise<{ entryId: string; outstanding: string }> {
  const run = async (trx: Tx) => {
    const liability = await liabilitiesRepo.getById(trx, actor.orgId, input.liabilityId);
    if (!liability) throw new Error(`chargeLiability: liability ${input.liabilityId} does not exist.`);
    await authorize(trx, actor, 'approve_expense', { storeId: liability.storeId });
    // ⛔ T-366 S1b / DEF-529 — row-lock the liability before anything reads what it owes.
    await liabilitiesRepo.lockForPayment(trx, actor.orgId, liability.id);
    // Re-read under the lock: a retire that committed while we waited is now visible.
    const locked = await liabilitiesRepo.getById(trx, actor.orgId, liability.id);
    if (locked?.retiredAt) {
      throw refuse(
        'chargeLiability: this obligation is retired.',
        'This obligation has been retired, so nothing more can be charged to it.',
      );
    }

    // ⭐ T-371 — parsed after `authorize()` into a (14,2) brand. A comma or a third decimal place is
    // now refused in words instead of reaching the database (22P02) or being silently rounded
    // (DEF-472, the followups file's O3 and comma legs). The zero-guard's sentence is unchanged.
    const amount = parseMoneyInput(input.amount, 'chargeLiability: the amount', 'The charge amount');
    if (compare(amount, ZERO) <= 0) throw refuse('chargeLiability: a charge has to be greater than zero.', 'A charge has to be greater than zero.');

    await assertChargeableAccount(trx, actor.orgId, input.againstAccountCode);

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'liability_charge',
      sourceId: liability.id,
      idempotencyKey: `liability:${liability.id}:charge:${input.on}:${amount}:${input.againstAccountCode}`,
      memo: input.memo?.trim() || `Charge — ${liability.name}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: input.againstAccountCode,
          storeId: liability.storeId,
          debit: amount,
        },
        {
          accountCode: LIABILITY_CONTROL_CODE,
          storeId: liability.storeId,
          credit: amount,
          partyType: 'liability' as const,
          partyId: liability.id,
        },
      ],
    });
    return {
      entryId: result.entryId,
      outstanding: (await liabilitiesRepo.positionOf(trx, actor.orgId, liability.id)).outstanding,
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⛔ **The charge target is validated, and the refusals are the interesting part.**
 *
 * A liability must not be charged to another liability account: each of those is already owned by a
 * module that accrues and settles it, and recording the same debt in both places counts it twice
 * with nothing reconciling them. ⚠️ Blocking beats silently double-counting — T-122 invariant 7's
 * rule, unchanged.
 */
async function assertChargeableAccount(trx: Tx, orgId: string, code: string): Promise<void> {
  const reserved = liabilitiesRepo.RESERVED_LIABILITY_CODES[code];
  if (reserved) {
    throw new Error(
      `chargeLiability: ${code} is ${reserved}. Charging it here would record the same debt twice, ` +
        `in two accounts, with nothing reconciling them.`,
    );
  }
  const account = await liabilitiesRepo.accountKind(trx, orgId, code);
  if (!account) throw new Error(`chargeLiability: account ${code} does not exist.`);
  if (!account.isPostable) {
    throw new Error(`chargeLiability: ${code} is a header, not something you can post to.`);
  }
  if (account.type === 'liability' || account.type === 'equity') {
    throw new Error(
      `chargeLiability: ${code} is ${account.type}, and a charge records what the obligation was ` +
        `FOR — an expense, or an asset. Crediting one liability to debit another moves a debt ` +
        `without settling it.`,
    );
  }
}

/** ⭐ **The obligation is paid.** `DR 2500 (party = it) · CR the money account`. */
export async function payLiability(
  tx: Tx | null,
  actor: Actor,
  input: { liabilityId: string; amount: string; fromMoneyAccountId: string; on: string; memo?: string },
): Promise<{ entryId: string; outstanding: string; settled: boolean; warning?: string }> {
  const run = async (trx: Tx) => {
    const liability = await liabilitiesRepo.getById(trx, actor.orgId, input.liabilityId);
    if (!liability) throw new Error(`payLiability: liability ${input.liabilityId} does not exist.`);
    await authorize(trx, actor, 'approve_expense', { storeId: liability.storeId });
    // ⛔ T-366 S1 / DEF-374 — row-lock the liability before `positionOf` reads what is owed.
    await liabilitiesRepo.lockForPayment(trx, actor.orgId, liability.id);

    const amount = parseMoneyInput(input.amount, 'payLiability: the amount', 'The payment amount');
    if (compare(amount, ZERO) <= 0) throw refuse('payLiability: a payment has to be greater than zero.', 'A payment has to be greater than zero.');

    // R4 — the ledger's figure is re-minted, never cast; it is always a 2-place string.
    const before = money(
      (await liabilitiesRepo.positionOf(trx, actor.orgId, liability.id)).outstanding,
    );
    // ⛔ Overpaying would turn a liability into a receivable with nobody deciding to — the same
    // ceiling `assertWithinReceivable` puts on an owner settlement.
    if (compare(amount, before) > 0) {
      throw new Error(
        `payLiability: that is more than the ₱${before} still owed on this obligation.`,
      );
    }

    const account = await moneyAccountsRepo.getById(trx, actor.orgId, input.fromMoneyAccountId);
    if (!account) throw new Error('payLiability: that money account does not exist.');
    if (account.storeId !== liability.storeId) {
      throw new Error('payLiability: that account belongs to another store.');
    }
    const warning = await checkDraw(trx, actor.orgId, account, amount, 'payLiability');

    const result = await postEntry(trx, {
      orgId: actor.orgId,
      entryDate: input.on,
      sourceType: 'liability_payment',
      sourceId: liability.id,
      idempotencyKey: `liability:${liability.id}:payment:${input.on}:${amount}`,
      memo: input.memo?.trim() || `Payment — ${liability.name}`,
      postedBy: actor.personId,
      lines: [
        {
          accountCode: LIABILITY_CONTROL_CODE,
          storeId: liability.storeId,
          debit: amount,
          partyType: 'liability' as const,
          partyId: liability.id,
        },
        {
          accountCode: account.glAccountCode,
          storeId: liability.storeId,
          credit: amount,
          ...(account.glAccountCode === '1140'
            ? { partyType: 'money_account' as const, partyId: account.id }
            : {}),
        },
      ],
    });

    const after = await liabilitiesRepo.positionOf(trx, actor.orgId, liability.id);
    return {
      entryId: result.entryId,
      outstanding: after.outstanding,
      // ⭐ Settled is the LEDGER's answer, not a column and not the form's arithmetic.
      settled: compare(money(after.outstanding), ZERO) <= 0,
      ...(warning ? { warning } : {}),
    };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** The only two source types `reverseLiabilityEntry` may target — T-366 S1c / DEF-534. */
const LIABILITY_ENTRY_SOURCE_TYPES = new Set(['liability_charge', 'liability_payment']);

/** ⚠️ Reversal, not deletion — the original and its mirror both stay on the ledger. */
export async function reverseLiabilityEntry(
  tx: Tx | null,
  actor: Actor,
  input: { liabilityId: string; entryId: string; reason: string },
): Promise<{ entryId: string }> {
  const run = async (trx: Tx) => {
    const liability = await liabilitiesRepo.getById(trx, actor.orgId, input.liabilityId);
    if (!liability) {
      throw new Error(`reverseLiabilityEntry: liability ${input.liabilityId} does not exist.`);
    }
    await authorize(trx, actor, 'approve_expense', { storeId: liability.storeId });
    // ⛔ T-366 S1b / DEF-529 — row-lock the liability before anything reads what it owes.
    await liabilitiesRepo.lockForPayment(trx, actor.orgId, liability.id);
    // Re-read under the lock: a retire that committed while we waited is now visible (DEF-535).
    const locked = await liabilitiesRepo.getById(trx, actor.orgId, liability.id);

    // ⛔ T-366 S1c / DEF-534 — `reverseEntry` looks the entry up by id ALONE (`repo/journal.ts:302`),
    // so nothing before this stopped a holder at A's store from reversing B's payment, or ANY
    // posted entry (an opening balance, another module's posting) through this liability. Bind it:
    // the entry must be a liability_charge/liability_payment posting FOR THIS liability.
    const entry = await journalRepo.findEntryById(trx, input.entryId);
    if (!entry || !LIABILITY_ENTRY_SOURCE_TYPES.has(entry.sourceType) || entry.sourceId !== liability.id) {
      throw refuse(
        `reverseLiabilityEntry: entry ${input.entryId} is not a liability_charge/liability_payment posting for liability ${liability.id}.`,
        'That entry does not belong to this obligation.',
      );
    }
    // ⛔ T-366 S1c / DEF-535 — a retired liability is presented as settled and owing nothing;
    // reversing a posting on one would make it owe money again while retirement still hides it.
    if (locked?.retiredAt) {
      throw refuse(
        `reverseLiabilityEntry: liability ${liability.id} is retired.`,
        'This obligation is retired and cannot be reversed.',
      );
    }

    const reason = input.reason.trim();
    if (!reason) throw new Error('reverseLiabilityEntry: say why this is being reversed.');
    const result = await reverseEntry(trx, {
      entryId: input.entryId,
      reason,
      reversedBy: actor.personId,
    });
    return { entryId: result.reversalEntryId };
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * ⚠️ **Retiring is not settling.** Settled is derived from the ledger; this records that somebody
 * decided to stop using the row. ⛔ Refused while money is still owed — retiring an obligation with
 * an outstanding balance would hide a real debt from the register that exists to show it.
 */
export async function retireLiability(
  tx: Tx | null,
  actor: Actor,
  input: { liabilityId: string },
): Promise<void> {
  const run = async (trx: Tx) => {
    const liability = await liabilitiesRepo.getById(trx, actor.orgId, input.liabilityId);
    if (!liability) throw new Error(`retireLiability: liability ${input.liabilityId} does not exist.`);
    await authorize(trx, actor, 'approve_expense', { storeId: liability.storeId });
    // ⛔ T-366 S1b / DEF-529 — row-lock the liability before anything reads what it owes.
    await liabilitiesRepo.lockForPayment(trx, actor.orgId, liability.id);

    const position = await liabilitiesRepo.positionOf(trx, actor.orgId, liability.id);
    if (!isZero(money(position.outstanding))) {
      throw new Error(
        `retireLiability: ₱${position.outstanding} is still owed on this obligation. Settle it or ` +
          `reverse the charge — retiring it would hide a real debt.`,
      );
    }
    await liabilitiesRepo.updateLiability(trx, actor.orgId, liability.id, { retiredAt: new Date() });
  };
  if (tx) return run(tx);
  return transaction(run);
}

/** ⚠️ Overdue is computed, never stored — `due_on` in the past with money still owed. */
export function isOverdue(
  dueOn: string | null,
  outstanding: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): boolean {
  if (!dueOn) return false;
  return dueOn < asOf && compare(money(outstanding), ZERO) > 0;
}
