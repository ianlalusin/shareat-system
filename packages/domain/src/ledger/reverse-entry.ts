/**
 * reverseEntry — unwinds a posted journal entry by writing its exact opposite.
 * docs/tasks/106-reverse-entry.md.
 *
 * T-103 and T-105 already made editing a posted entry impossible. This does not add a
 * prohibition — it makes the only remaining legal path (write a new, dated, opposite
 * entry) convenient, so a correction is a new fact, never a quiet edit to history
 * (bible §16.1 invariant 5).
 *
 * Reuses `postEntry` for the actual draft -> lines -> posted write of the reversal
 * entry — T-105's ordering is not duplicated here. What this function adds on top,
 * because postEntry alone cannot do it:
 *
 *   1. Reads the original entry and its lines back (journalRepo.findEntryById /
 *      findLinesForEntryWithAccountCodes), and mirrors each line with debit and credit
 *      swapped — same account, same store_id, same channel_id, same amount.
 *   2. Decides which period the reversal posts to (Contract §4): the original's own
 *      date if its period is still open; otherwise the caller-supplied `reversalDate`,
 *      which MUST resolve to an open period, and the memo is prefixed `[prior period]`.
 *   3. Opens a narrow, transaction-local exemption (journalRepo.beginReversalPostingContext,
 *      migration 0005) from T-103's active-account-status check for exactly this
 *      transaction's line inserts — an account that was active when the original
 *      posted may since have been archived or reserved, and an entry that cannot be
 *      unwound is a trap (Contract §5). The exemption never covers is_postable: a
 *      header was never postable, so no original line could ever have targeted one.
 *      Never set by ordinary postEntry callers, so it cannot leak into ordinary
 *      postings (invariant 17).
 *   4. After postEntry returns with the new entry already posted, backfills that
 *      entry's own `reversal_of_entry_id` to point at the original
 *      (journalRepo.setReversalOfEntryId) — this cannot happen any earlier: the row
 *      does not exist until postEntry creates it, and postEntry's own input has no
 *      field for it (this task's Scope forbids modifying postEntry). Migration 0005
 *      adds the one narrow immutability exception this backfill relies on. See the
 *      task report for why this makes the migration necessary for Contract §2 itself,
 *      not only for §5 as the spec anticipated.
 *   5. Flips the ORIGINAL entry's status posted -> reversed
 *      (journalRepo.markEntryReversed) — a transition T-103's own trigger already
 *      permits, unconditionally.
 *
 * Idempotency mirrors postEntry's own philosophy: the check runs FIRST, before status
 * or period validation, so a retried reversal (offline replay, double-click) is always
 * a cheap, safe no-op — even if the original has since been reversed by this very call
 * on its first, successful attempt.
 */
import { money } from '@shareat/core/money';
import { journalRepo, transaction, type Tx } from '@shareat/db';
import { postEntry } from './post-entry';

export interface ReverseEntryInput {
  /** The posted entry to unwind. */
  entryId: string;
  /**
   * Required — never optional (Contract §3). An empty or whitespace-only reason is an
   * untraceable hole in the audit trail and is rejected. Stored on the reversal's
   * `memo`, prefixed `[prior period]` when Contract §4's prior-period case applies.
   */
  reason: string;
  /**
   * The date the reversal itself posts on. Required when the original's fiscal period
   * is no longer open (Contract §4) — omitting it there is rejected, naming the
   * period. When the original's period is still open and this is omitted, defaults to
   * the original's own `entryDate`. Always subject to postEntry's own period-open
   * check, whichever way it was resolved.
   */
  reversalDate?: string;
  reversedBy?: string | null;
  /** Defaults to `reverse:{entryId}` (Contract §7). */
  idempotencyKey?: string;
}

export interface ReverseEntryResult {
  reversalEntryId: string;
  /** false means the idempotency key already existed and nothing new was written —
   * this call did not touch the original or write a second reversal. */
  created: boolean;
}

/**
 * Writes the exact opposite of a posted journal entry, in one transaction, safely
 * re-runnable.
 *
 * `tx` — pass an open transaction to JOIN it; pass `null` to let `reverseEntry` open
 * and own its own transaction (same contract as `postEntry`).
 */
export async function reverseEntry(
  tx: Tx | null,
  input: ReverseEntryInput,
): Promise<ReverseEntryResult> {
  if (tx) {
    return runReverseEntry(tx, input);
  }
  return transaction((trx) => runReverseEntry(trx, input));
}

async function runReverseEntry(tx: Tx, input: ReverseEntryInput): Promise<ReverseEntryResult> {
  const reason = (input.reason ?? '').trim();
  if (!reason) {
    throw new Error('reverseEntry: reason is required and cannot be empty or whitespace-only');
  }

  const idempotencyKey = input.idempotencyKey ?? `reverse:${input.entryId}`;

  const original = await journalRepo.findEntryById(tx, input.entryId);
  if (!original) {
    throw new Error(`reverseEntry: journal entry ${input.entryId} does not exist`);
  }

  // Idempotency is checked FIRST, before status or period validation — a retry must
  // always be a cheap, safe no-op, even on an original that this very idempotency key's
  // first, successful call has since flipped to 'reversed'. Mirrors postEntry's own
  // documented ordering decision (post-entry.ts).
  const existingByKey = await journalRepo.findEntryByIdempotencyKey(tx, original.orgId, idempotencyKey);
  if (existingByKey) {
    return { reversalEntryId: existingByKey.id, created: false };
  }

  if (original.status === 'draft') {
    throw new Error(
      `reverseEntry: journal entry ${input.entryId} is a draft — nothing has been posted yet to reverse; delete it instead`,
    );
  }
  if (original.status === 'reversed') {
    const existingReversal = await journalRepo.findReversalOfEntry(tx, original.orgId, original.id);
    throw new Error(
      `reverseEntry: journal entry ${input.entryId} was already reversed by entry ${
        existingReversal?.id ?? '(unknown — data inconsistency)'
      }`,
    );
  }
  // original.status === 'posted' from here — includes a reversal entry itself, which
  // stays 'posted' forever (invariant 9: reversing a reversal is legitimate).

  const originalPeriod = await journalRepo.findPeriodById(tx, original.periodId);
  if (!originalPeriod) {
    // Unreachable in practice (the FK guarantees the period exists) — named rather
    // than silently falling through, per this codebase's own convention.
    throw new Error(
      `reverseEntry: fiscal period ${original.periodId} for entry ${input.entryId} does not exist`,
    );
  }

  let reversalDate: string;
  let memoPrefix = '';
  if (originalPeriod.status === 'open') {
    // Contract §4: defaults to the original's own entryDate when the caller does not
    // override it. An explicit reversalDate is still honoured here — postEntry itself
    // is the one thing that ultimately validates whatever date resolves, whether that
    // date came from this default or from the caller.
    reversalDate = input.reversalDate ?? original.entryDate;
  } else {
    if (!input.reversalDate) {
      throw new Error(
        `reverseEntry: journal entry ${input.entryId}'s fiscal period ${original.periodId} is ${originalPeriod.status} — supply reversalDate in an open period`,
      );
    }
    reversalDate = input.reversalDate;
    // Contract §4: the classification lives in the ledger itself, not inferred from
    // dates — a closed-period correction is always visibly tagged.
    memoPrefix = '[prior period] ';
  }

  const memo = `${memoPrefix}${reason}`;

  const originalLines = await journalRepo.findLinesForEntryWithAccountCodes(tx, original.id);

  const reversalLines = originalLines.map((line) => ({
    accountCode: line.accountCode,
    storeId: line.storeId,
    channelId: line.channelId,
    // DEF-049: the party travels with the account, unchanged — only debit/credit swap
    // (Contract §2). Without this, a reversal of any party-bearing line (AP, AR, a staff
    // advance, ...) would insert with no party and be rejected by the same
    // requires_party trigger the original posting satisfied — turning "always reversible"
    // (Contract §5 / bible invariant 5) into false for exactly the control accounts that
    // matter most.
    partyType: line.partyType,
    partyId: line.partyId,
    // The mirror: debit and credit swapped, everything else identical (Contract §2).
    // T-371 R4 — re-minted from the stored row, never cast (0155 keeps NaN out, so this never refuses).
    debit: money(line.credit),
    credit: money(line.debit),
    lineMemo: line.lineMemo,
  }));

  // Contract §5 — scoped to exactly this transaction's line inserts, set immediately
  // before postEntry runs them. See migration 0005 and this file's top comment.
  await journalRepo.beginReversalPostingContext(tx);

  const posted = await postEntry(tx, {
    orgId: original.orgId,
    entryDate: reversalDate,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    idempotencyKey,
    memo,
    postedBy: input.reversedBy ?? null,
    lines: reversalLines,
  });

  if (posted.created) {
    // Only when THIS call is the one that actually created the reversal — a
    // concurrent caller that lost the idempotency race (postEntry's own invariant 10)
    // returns created:false here too, and must not also try to link/flip, since the
    // winner's transaction already does (or is doing) both.
    await journalRepo.setReversalOfEntryId(tx, posted.entryId, original.id);
    await journalRepo.markEntryReversed(tx, original.id);
  }

  return { reversalEntryId: posted.entryId, created: posted.created };
}
