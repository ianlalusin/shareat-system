/**
 * The three dispositions, and each is a different account — T-174.
 *
 * ⭐ **What is stranded and why.** T-173 posts a short receipt at what arrived and leaves the
 * difference in `1340 Inventory in transit` on the commissary's books. That is not an accounting
 * convenience: goods that visibly left one building and did not reach another are a real asset
 * until somebody says what happened to them. This module is where somebody says.
 *
 * ```
 * AUDIT ONLY     nothing               the gap stays in 1340 with a note, and STILL BLOCKS
 * LOSS           Dr 5300  Cr 1340      genuinely lost, damaged or spoiled in transit
 * CHARGE         Dr 1230  Cr 1340      recovered from a named staffer, at the transfer value
 * LATE RECEIPT   nothing here          the rest turned up; T-173's own path posts the balance
 * ```
 *
 * ⚠️ **`5300` and not `5400`.** A count variance is a *correction* to the books; goods that left
 * one building and did not reach another are a *loss*. Different facts, different accounts — the
 * same distinction T-164 §2 draws, and the reason both accounts exist.
 *
 * ⭐ **`audit` is a decision to WAIT, not a resolution.** It records that a human looked and chose
 * to leave the value where it is, and the row stays `open`, so the day-open block keeps refusing.
 * ⛔ That is deliberate: an escape hatch that stopped the blocking would be a way to make the
 * dispute disappear without deciding it, which is the state this whole task exists to prevent.
 */
import { compare, money, ZERO, type Money } from '@shareat/core/money';
import { tradeDiscrepanciesRepo, type Tx } from '@shareat/db';
import { postEntry } from '../ledger/post-entry';
import type { Outcome } from './outcome';
import { IN_TRANSIT_ACCOUNT } from './transfer';

/** T-164's account for a real loss, as opposed to `5400`'s correction of a count. */
export const LOSS_ACCOUNT = '5300';
/** ⚠️ A receivable from the staffer, `party_type = 'employee'` — never a P&L account. */
export const STAFF_CHARGE_ACCOUNT = '1230';

export type Disposition = 'audit' | 'loss' | 'charge' | 'late_receipt';

export interface ResolveDiscrepancyInput {
  readonly orgId: string;
  readonly discrepancyId: string;
  readonly commissaryStoreId: string;
  readonly disposition: Disposition;
  /** Required for `charge`, refused for everything else. */
  readonly chargePersonId?: string | null;
  readonly note?: string | null;
  readonly resolvedOn: string;
  readonly resolvedBy: string;
}

/**
 * Resolve one discrepancy: the posting and the status change, in one transaction.
 *
 * ⭐ **The row is read `FOR UPDATE` first**, so two managers deciding the same dispute at the same
 * moment cannot both post — the second one finds it resolved and is refused by the terminality
 * trigger rather than double-relieving `1340`.
 */
export async function resolveDiscrepancy(
  tx: Tx,
  input: ResolveDiscrepancyInput,
): Promise<Outcome<{ entryId: string | null; value: Money }>> {
  const row = await tradeDiscrepanciesRepo.findById(tx, input.discrepancyId);
  if (!row) return { ok: false, reason: `discrepancy ${input.discrepancyId} does not exist` };
  if (row.storeId !== input.commissaryStoreId) {
    // ⚠️ Invariant 11: the goods are the COMMISSARY's asset. The branch reports what arrived and
    // does not decide what the difference was.
    return {
      ok: false,
      reason: 'only the dispatching commissary may resolve this — the branch reports, it does not decide',
    };
  }
  if (row.status === 'resolved') {
    return {
      ok: false,
      reason: `discrepancy ${row.id} is already resolved as ${row.disposition} — reverse it and resolve again`,
    };
  }

  if (input.disposition === 'charge' && !input.chargePersonId) {
    return { ok: false, reason: 'a charge must name the person it is recovered from' };
  }
  if (input.disposition !== 'charge' && input.chargePersonId) {
    return { ok: false, reason: `a ${input.disposition} disposition cannot name a person to charge` };
  }

  const value = money(row.value);
  if (compare(value, ZERO) <= 0) {
    return { ok: false, reason: `discrepancy ${row.id} has no value to dispose of` };
  }

  // ⛔ Neither of these posts. `audit` leaves the value in `1340` on purpose; `late_receipt` is
  // closed by T-173's second confirm, which posts the balance itself — posting here as well would
  // relieve `1340` twice for one lot of goods.
  if (input.disposition === 'audit' || input.disposition === 'late_receipt') {
    await tradeDiscrepanciesRepo.resolve(tx, {
      id: row.id,
      disposition: input.disposition,
      note: input.note ?? null,
      resolvedBy: input.resolvedBy,
    });
    return { ok: true, entryId: null, value };
  }

  const posted = await postEntry(tx, {
    orgId: input.orgId,
    entryDate: input.resolvedOn,
    sourceType: 'trade_discrepancy',
    sourceId: row.id,
    idempotencyKey: `trade_discrepancy:${row.id}:${input.disposition}`,
    memo:
      input.disposition === 'loss'
        ? 'Goods lost in transit to branch'
        : 'Transit shortfall charged to staff',
    postedBy: input.resolvedBy,
    lines:
      input.disposition === 'loss'
        ? [
            { accountCode: LOSS_ACCOUNT, storeId: input.commissaryStoreId, debit: value },
            { accountCode: IN_TRANSIT_ACCOUNT, storeId: input.commissaryStoreId, credit: value },
          ]
        : [
            {
              accountCode: STAFF_CHARGE_ACCOUNT,
              storeId: input.commissaryStoreId,
              debit: value,
              partyType: 'employee',
              partyId: input.chargePersonId!,
            },
            { accountCode: IN_TRANSIT_ACCOUNT, storeId: input.commissaryStoreId, credit: value },
          ],
  });

  await tradeDiscrepanciesRepo.resolve(tx, {
    id: row.id,
    disposition: input.disposition,
    chargePersonId: input.chargePersonId ?? null,
    note: input.note ?? null,
    journalEntryId: posted.entryId,
    resolvedBy: input.resolvedBy,
  });

  return { ok: true, entryId: posted.entryId, value };
}

/**
 * Push the decision to a date. ⛔ **Once.** The second attempt is refused by the database
 * (`trade_discrepancies_defer_once_trg`), not by this function — a rule that lives in a service is
 * a rule the next caller routes around.
 */
export async function deferDiscrepancy(
  tx: Tx,
  input: { orgId: string; discrepancyId: string; commissaryStoreId: string; toDate: string },
): Promise<Outcome<{ deferredTo: string }>> {
  const row = await tradeDiscrepanciesRepo.findById(tx, input.discrepancyId);
  if (!row) return { ok: false, reason: `discrepancy ${input.discrepancyId} does not exist` };
  if (row.storeId !== input.commissaryStoreId) {
    return { ok: false, reason: 'only the dispatching commissary may defer this' };
  }
  if (row.status === 'resolved') {
    return { ok: false, reason: `discrepancy ${row.id} is already resolved — it cannot be deferred` };
  }
  await tradeDiscrepanciesRepo.defer(tx, row.id, input.toDate);
  return { ok: true, deferredTo: input.toDate };
}
