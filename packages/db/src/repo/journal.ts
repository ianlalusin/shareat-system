/**
 * journal repo — the ONLY place journal SQL is written (PROJECT_BIBLE.md §4.3).
 * docs/tasks/105-posting-engine.md.
 *
 * Every function here takes a `Tx` (an open Drizzle transaction), never the base
 * connection — so it is impossible to write outside a transaction by accident (see
 * packages/db/src/client.ts's own comment to that effect). No business rule lives
 * here: balance, minimum-two-lines, account eligibility, period-open and
 * posted-immutability are all enforced by T-103's constraints and triggers (and, for
 * DEF-031, migration 0004's replacement trigger). This file only:
 *
 *   - resolves `accountCode` -> `account_id`, naming the code when it is unknown (the
 *     one thing the database itself cannot do, since there is no row to attach the
 *     error to) — it does NOT check `is_postable` or `status`; that is account
 *     ELIGIBILITY, and the `journal_lines_account_eligible` trigger already owns it.
 *   - resolves an `entryDate` to the fiscal period covering it.
 *   - composes the plain SQL for the draft-first write sequence that
 *     `packages/domain/src/ledger/post-entry.ts` drives: insert draft, insert lines,
 *     flip to posted.
 */
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { accounts, fiscalPeriods, journalEntries, journalLines } from '../../schema';
import type { Tx } from '../client';

// -----------------------------------------------------------------------------------------
// Account code resolution — callers pass `accountCode` ('6200'), never a uuid (Contract §1).
// -----------------------------------------------------------------------------------------

/**
 * Resolves an account code to its id for this org. Throws, NAMING THE CODE, when no
 * account with that code exists for the org. Does not check eligibility — an existing
 * but reserved or header account resolves fine here and is rejected later, by T-103's
 * trigger, on the line INSERT itself. Checking it twice would be the second
 * source-of-truth the task spec explicitly forbids.
 */
export async function resolveAccountId(tx: Tx, orgId: string, code: string): Promise<string> {
  const [row] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.code, code)))
    .limit(1);

  if (!row) {
    throw new Error(`postEntry: unknown account code '${code}' for org ${orgId}`);
  }
  return row.id;
}

// -----------------------------------------------------------------------------------------
// Period resolution — the caller passes a date, never a period id (Contract §4).
// -----------------------------------------------------------------------------------------

export interface PeriodForDate {
  id: string;
  status: 'open' | 'closed' | 'locked';
  startsOn: string;
  endsOn: string;
}

/** The fiscal period covering `entryDate` for this org, or undefined if none does. */
export async function findPeriodForDate(
  tx: Tx,
  orgId: string,
  entryDate: string,
): Promise<PeriodForDate | undefined> {
  const [row] = await tx
    .select({
      id: fiscalPeriods.id,
      status: fiscalPeriods.status,
      startsOn: fiscalPeriods.startsOn,
      endsOn: fiscalPeriods.endsOn,
    })
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.orgId, orgId),
        lte(fiscalPeriods.startsOn, entryDate),
        gte(fiscalPeriods.endsOn, entryDate),
      ),
    )
    .limit(1);
  return row;
}

// -----------------------------------------------------------------------------------------
// Idempotency (Contract §3 / bible §4.2 rule 10).
// -----------------------------------------------------------------------------------------

/** The already-written entry for this (org, idempotencyKey), if one exists. */
export async function findEntryByIdempotencyKey(
  tx: Tx,
  orgId: string,
  idempotencyKey: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row;
}

export interface InsertDraftEntryInput {
  orgId: string;
  entryDate: string;
  periodId: string;
  memo: string | null;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
}

export interface InsertDraftEntryResult {
  id: string;
  created: boolean;
}

/**
 * Inserts the entry header as `status = 'draft'` (Contract §2 — step one of the
 * three-statement draft -> lines -> posted sequence). Idempotent by
 * `UNIQUE (org_id, idempotency_key)`: on conflict, nothing is written and the existing
 * row is returned with `created: false`.
 *
 * The `ON CONFLICT (...) WHERE idempotency_key IS NOT NULL DO NOTHING` target matches
 * the PARTIAL unique index T-103 created
 * (`journal_entries_org_id_idempotency_key_unique`) — without the matching predicate
 * Postgres has no conflict target to arbitrate against and the statement errors.
 *
 * Safe under concurrency (invariant 10): a second, concurrent INSERT for the same key
 * waits on Postgres's speculative-insertion arbitration for the first transaction to
 * commit or roll back, then either sees the conflict (and this function falls through
 * to the SELECT below) or, if the first transaction rolled back, inserts normally.
 * Neither branch can deadlock — this is exactly the case `ON CONFLICT` exists to
 * handle without an application-level retry loop.
 */
export async function insertDraftEntry(
  tx: Tx,
  input: InsertDraftEntryInput,
): Promise<InsertDraftEntryResult> {
  const [inserted] = await tx
    .insert(journalEntries)
    .values({
      orgId: input.orgId,
      entryDate: input.entryDate,
      periodId: input.periodId,
      memo: input.memo,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      idempotencyKey: input.idempotencyKey,
      status: 'draft',
    })
    .onConflictDoNothing({
      target: [journalEntries.orgId, journalEntries.idempotencyKey],
      where: sql`${journalEntries.idempotencyKey} is not null`,
    })
    .returning({ id: journalEntries.id });

  if (inserted) {
    return { id: inserted.id, created: true };
  }

  const existing = await findEntryByIdempotencyKey(tx, input.orgId, input.idempotencyKey);
  if (!existing) {
    // Unreachable in practice: a DO NOTHING conflict means a row satisfying the unique
    // index already exists, and the transaction that created it must have committed for
    // us to have lost the race at all. Never silently swallow an impossible state.
    throw new Error(
      `insertDraftEntry: idempotency conflict for org ${input.orgId} key '${input.idempotencyKey}' but no existing entry found`,
    );
  }
  return { id: existing.id, created: false };
}

// -----------------------------------------------------------------------------------------
// Lines (Contract §2) — inserted only while the parent entry is still 'draft'. Once
// flipped to 'posted', migration 0004's replacement trigger rejects any further INSERT
// onto this entry's lines — that is the DEF-031 fix.
// -----------------------------------------------------------------------------------------

export interface InsertLineInput {
  lineNo: number;
  accountId: string;
  storeId: string | null;
  channelId: string | null;
  debit: string;
  credit: string;
  lineMemo: string | null;
}

export async function insertLines(tx: Tx, entryId: string, lines: InsertLineInput[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(journalLines).values(
    lines.map((line) => ({
      entryId,
      lineNo: line.lineNo,
      accountId: line.accountId,
      storeId: line.storeId,
      channelId: line.channelId,
      debit: line.debit,
      credit: line.credit,
      lineMemo: line.lineMemo,
    })),
  );
}

// -----------------------------------------------------------------------------------------
// The flip (Contract §2, the LAST statement) — draft -> posted.
// -----------------------------------------------------------------------------------------

/**
 * Flips a draft entry to posted. Deliberately the LAST statement of the posting
 * sequence: it is what makes the deferred balance / minimum-two-lines constraint
 * triggers (T-103) fire, at COMMIT, against the entry's final, complete set of lines.
 */
export async function postDraftEntry(tx: Tx, entryId: string, postedBy: string | null): Promise<void> {
  const updated = await tx
    .update(journalEntries)
    .set({ status: 'posted', postedAt: sql`now()`, postedBy, updatedAt: sql`now()` })
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.status, 'draft')))
    .returning({ id: journalEntries.id });

  if (updated.length === 0) {
    throw new Error(
      `postDraftEntry: entry ${entryId} was not a draft entry (already posted, reversed, or missing)`,
    );
  }
}
