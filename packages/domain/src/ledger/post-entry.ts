/**
 * postEntry — the only way anything writes to journal_entries / journal_lines.
 * docs/tasks/105-posting-engine.md.
 *
 * Everything that ever posts to this ledger — expenses, sales, payroll, the ETL — goes
 * through this function. It is deliberately thin (bible §4.3, "Why the service is
 * thin" in the task spec): T-103 already put balance, minimum-two-lines, account
 * eligibility, period-open, and posted-immutability into the database as constraints
 * and triggers. `postEntry` does not re-check any of them — a second copy in
 * TypeScript would be a second source of truth, and the two would drift. It only:
 *
 *   1. Resolves `entryDate` to a fiscal period (never accepts a period id from the
 *      caller), and rejects with a message naming the date or the period + status,
 *      rather than letting a raw trigger message surface.
 *   2. Resolves each line's `accountCode` to an `accountId` (rejecting an unknown code
 *      by name — see packages/db/src/repo/journal.ts's `resolveAccountId`).
 *   3. Applies the idempotency short-circuit (Contract §3 / bible §4.2 rule 10).
 *   4. Writes in the ORDER that closes DEF-031: insert the entry as `draft`, insert
 *      every line while it is still `draft`, then flip it to `posted` as the LAST
 *      statement. Migration 0004 makes a line INSERT onto a non-draft entry
 *      impossible, so this ordering is not just tidy — it is the only ordering that
 *      still works.
 *
 * All of it runs inside ONE transaction (bible §4.3): join the caller's if one is
 * supplied, otherwise open and own one.
 */
import { journalRepo, transaction, type Tx } from '@shareat/db';

export interface PostEntryLine {
  /** e.g. '6200' — never a uuid. The repo resolves code -> id (Contract §1). */
  accountCode: string;
  storeId?: string | null;
  channelId?: string | null;
  /** Money as a decimal string, matching numeric(14,2). Defaults to '0'. */
  debit?: string;
  credit?: string;
  lineMemo?: string | null;
}

export interface PostEntryInput {
  orgId: string;
  /** The business date this entry belongs to — YYYY-MM-DD. Resolved to a period, never
   *  supplied as one (Contract §4). */
  entryDate: string;
  sourceType: string;
  sourceId: string;
  /**
   * Required — never optional (Contract §3). Derive it from the source document, e.g.
   * `expense:{id}:post`. Never from a timestamp or a random value; both defeat the
   * purpose of a retry guard.
   */
  idempotencyKey: string;
  memo?: string | null;
  postedBy?: string | null;
  lines: PostEntryLine[];
}

export interface PostEntryResult {
  entryId: string;
  /** false means the idempotency key already existed and nothing new was written. */
  created: boolean;
}

/**
 * Writes a balanced journal entry, in one transaction, safely re-runnable.
 *
 * `tx` — pass an open transaction to JOIN it (this call becomes part of a larger unit
 * of work, e.g. an expense-posting service that itself owns a transaction); pass
 * `null` to let `postEntry` open and own its own transaction.
 */
export async function postEntry(tx: Tx | null, input: PostEntryInput): Promise<PostEntryResult> {
  if (!input.idempotencyKey) {
    throw new Error('postEntry: idempotencyKey is required');
  }

  if (tx) {
    return runPostEntry(tx, input);
  }
  return transaction((trx) => runPostEntry(trx, input));
}

async function runPostEntry(tx: Tx, input: PostEntryInput): Promise<PostEntryResult> {
  // Idempotency is checked FIRST, before any other work. A retry of an
  // already-completed post must always be a cheap, safe no-op — even if the fiscal
  // period has since closed or an account code has since been retired — because that
  // is exactly the situation a retry (offline replay, webhook, cron, double-click)
  // shows up in. Resolving the period or accounts before this check would turn a
  // legitimate, side-effect-free retry into a spurious error. See the task report:
  // the Contract's own pseudocode does not show this branch explicitly, so this
  // ordering is a decision this implementation makes, not one the spec states.
  const existing = await journalRepo.findEntryByIdempotencyKey(tx, input.orgId, input.idempotencyKey);
  if (existing) {
    return { entryId: existing.id, created: false };
  }

  // Period resolution — Contract §4: the caller passes a date, never a period id.
  const period = await journalRepo.findPeriodForDate(tx, input.orgId, input.entryDate);
  if (!period) {
    throw new Error(
      `postEntry: no fiscal period covers entry date ${input.entryDate} for org ${input.orgId}`,
    );
  }
  if (period.status !== 'open') {
    throw new Error(
      `postEntry: fiscal period ${period.id} (${period.startsOn}..${period.endsOn}) is ${period.status} — cannot post an entry dated ${input.entryDate}`,
    );
  }

  // accountCode -> accountId. An unknown code is rejected here, naming the code
  // (Contract §1). A reserved or header code resolves fine here and is rejected by
  // T-103's eligibility trigger when the line is inserted below (invariants 6 and 7)
  // — not re-checked here, per the task's explicit "do not re-implement" rule.
  const resolvedLines = await Promise.all(
    input.lines.map(async (line, index) => ({
      lineNo: index + 1,
      accountId: await journalRepo.resolveAccountId(tx, input.orgId, line.accountCode),
      storeId: line.storeId ?? null,
      channelId: line.channelId ?? null,
      debit: line.debit ?? '0',
      credit: line.credit ?? '0',
      lineMemo: line.lineMemo ?? null,
    })),
  );

  // ---- The ordering that closes DEF-031 (Contract §2) ----
  const { id: entryId, created } = await journalRepo.insertDraftEntry(tx, {
    orgId: input.orgId,
    entryDate: input.entryDate,
    periodId: period.id,
    memo: input.memo ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    idempotencyKey: input.idempotencyKey,
  });

  if (!created) {
    // Lost a race with a concurrent postEntry using the same key (invariant 10).
    return { entryId, created: false };
  }

  await journalRepo.insertLines(tx, entryId, resolvedLines);
  await journalRepo.postDraftEntry(tx, entryId, input.postedBy ?? null);

  return { entryId, created: true };
}
