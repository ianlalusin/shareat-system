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
import { and, asc, eq, gte, isNull, like, lte, sql } from 'drizzle-orm';
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

/**
 * The still-standing POSTED entries a source document wrote, by `(source_type, source_id prefix)`
 * — the pair `journal_entries_source_type_source_id_idx` indexes. DEF-141 (2026-09-03): a usage
 * record posts one entry per (inventory account, COGS category) group under
 * `source_id = '<recordId>:<account>:<category>'` and stores no entry id anywhere, so its void
 * could not find what to reverse. This is how it finds them.
 *
 * ⚠️ Excludes reversals (`reversal_of_entry_id IS NOT NULL`) and anything not `posted`: a reversal
 * carries the SAME source pair as its original (reverse-entry.ts), so a naive match would hand a
 * second void the first void's own entries. The prefix's `%`/`_` are escaped — a uuid has neither,
 * but a caller passing anything else must not turn a prefix into a pattern.
 */
export async function findPostedEntriesBySource(
  tx: Tx,
  orgId: string,
  sourceType: string,
  sourceIdPrefix: string,
): Promise<{ id: string; sourceId: string }[]> {
  const escaped = sourceIdPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
  return tx
    .select({ id: journalEntries.id, sourceId: journalEntries.sourceId })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.sourceType, sourceType),
        like(journalEntries.sourceId, `${escaped}%`),
        eq(journalEntries.status, 'posted'),
        isNull(journalEntries.reversalOfEntryId),
      ),
    )
    .orderBy(asc(journalEntries.sourceId));
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
  /** T-118's counterparty, threaded through by DEF-049's fix — see post-entry.ts's
   * PostEntryLine comment for the full story. Both-or-neither and the requires_party
   * cross-table rule are enforced by triggers, not here (T-105's own "do not re-implement"
   * precedent). */
  partyType: string | null;
  partyId: string | null;
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
      partyType: line.partyType,
      partyId: line.partyId,
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

// -----------------------------------------------------------------------------------------
// Reversal (docs/tasks/106-reverse-entry.md) — extends this same repo. reverseEntry
// (packages/domain/src/ledger/reverse-entry.ts) drives these; it reuses postEntry above
// for the actual draft -> lines -> posted write of the reversal entry itself and only
// calls the functions below for what postEntry cannot do on its own: reading the
// original entry back, exempting its OWN lines from the active-account check, and
// linking the two entries together afterward.
// -----------------------------------------------------------------------------------------

export interface JournalEntryRow {
  id: string;
  orgId: string;
  entryDate: string;
  periodId: string;
  status: 'draft' | 'posted' | 'reversed';
  sourceType: string;
  sourceId: string;
  memo: string | null;
  reversalOfEntryId: string | null;
}

/** The entry itself, by id — undefined if it does not exist. No org filter: the caller
 * (reverseEntry) does not know the org in advance, and derives it FROM this row. */
export async function findEntryById(tx: Tx, entryId: string): Promise<JournalEntryRow | undefined> {
  const [row] = await tx
    .select({
      id: journalEntries.id,
      orgId: journalEntries.orgId,
      entryDate: journalEntries.entryDate,
      periodId: journalEntries.periodId,
      status: journalEntries.status,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      memo: journalEntries.memo,
      reversalOfEntryId: journalEntries.reversalOfEntryId,
    })
    .from(journalEntries)
    .where(eq(journalEntries.id, entryId))
    .limit(1);
  return row as JournalEntryRow | undefined;
}

/** The fiscal period by id (as opposed to `findPeriodForDate`, keyed by date) — reverseEntry
 * needs the ORIGINAL entry's own period's current status, not a new date-based lookup. */
export async function findPeriodById(tx: Tx, periodId: string): Promise<PeriodForDate | undefined> {
  const [row] = await tx
    .select({
      id: fiscalPeriods.id,
      status: fiscalPeriods.status,
      startsOn: fiscalPeriods.startsOn,
      endsOn: fiscalPeriods.endsOn,
    })
    .from(fiscalPeriods)
    .where(eq(fiscalPeriods.id, periodId))
    .limit(1);
  return row;
}

/** The entry (if any) whose `reversal_of_entry_id` names `originalEntryId` — used only
 * to name the existing reversal when a caller tries to reverse an already-reversed
 * entry a second time (Contract §6 / invariant 8). */
export async function findReversalOfEntry(
  tx: Tx,
  orgId: string,
  originalEntryId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.reversalOfEntryId, originalEntryId)))
    .limit(1);
  return row;
}

export interface EntryLineWithAccountCode {
  lineNo: number;
  accountCode: string;
  storeId: string | null;
  channelId: string | null;
  /** T-118's counterparty, added by DEF-049's fix so a party-bearing line (e.g. an AP or
   * staff-advance line) can actually be reversed — without this, reverseEntry silently
   * dropped party on the mirrored line, and the reversal insert would then be rejected by
   * the very requires_party trigger the original posting satisfied. */
  partyType: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
  lineMemo: string | null;
}

/** A posted entry's own lines, joined back to `accounts.code` — postEntry's
 * PostEntryLine takes an accountCode, never an accountId (Contract §1), so reverseEntry
 * needs the code back to hand the mirrored lines to postEntry the same way any other
 * caller would. */
export async function findLinesForEntryWithAccountCodes(
  tx: Tx,
  entryId: string,
): Promise<EntryLineWithAccountCode[]> {
  const rows = await tx
    .select({
      lineNo: journalLines.lineNo,
      accountCode: accounts.code,
      storeId: journalLines.storeId,
      channelId: journalLines.channelId,
      partyType: journalLines.partyType,
      partyId: journalLines.partyId,
      debit: journalLines.debit,
      credit: journalLines.credit,
      lineMemo: journalLines.lineMemo,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(eq(journalLines.entryId, entryId))
    .orderBy(journalLines.lineNo);
  return rows;
}

/**
 * Sets a transaction-LOCAL flag (`set_config(..., true)` — cleared at commit/rollback,
 * never visible to any other transaction or pooled connection) that exempts this
 * transaction's journal_lines INSERTs from the active-account-status check (migration
 * 0005). Must be called BEFORE postEntry builds the reversal's lines within the SAME
 * transaction reverseEntry owns. Never called by ordinary postEntry callers — see
 * invariant 17 (the exemption must not leak into ordinary postings).
 */
export async function beginReversalPostingContext(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('app.reversal_posting', 'on', true)`);
}

/**
 * T-264 slice 3 (DEF-284, docs/plans/264-slice3-plan.md). Sets a transaction-LOCAL flag, exact
 * same shape as `beginReversalPostingContext` above (migration 0005's idiom, reused rather than
 * invented a second time): `set_config(..., true)` — cleared at commit/rollback, never visible to
 * any other transaction or pooled connection — that the period-open triggers (migration 0143)
 * read as `coalesce(current_setting('app.period_override', true), '') = 'on'`, so an unset flag
 * reads as NOT exempt. Must be called by `postEntry` ONLY after `authorize(actor,
 * 'override_period_lock')` has succeeded — never from a caller-supplied parameter (bible §7.1,
 * landmine 17). Never called by any other path.
 */
export async function beginPeriodOverrideContext(tx: Tx): Promise<void> {
  await tx.execute(sql`select set_config('app.period_override', 'on', true)`);
}

/**
 * Backfills the reversal entry's OWN `reversal_of_entry_id`, pointing at the original it
 * unwinds (Contract §2). Necessarily an UPDATE, after postEntry has already posted the
 * new entry — postEntry (T-105, untouched by this task) has no field for it, and the
 * row does not exist to be linked until postEntry creates it. Relies on migration
 * 0005's narrow immutability exception (NULL -> a value, once, nothing else changing in
 * the same statement). Throws if the target row does not exist, is not posted, or
 * already has a reversal_of_entry_id set (the exception's own guard would otherwise
 * reject a second call with a less specific error).
 */
export async function setReversalOfEntryId(
  tx: Tx,
  entryId: string,
  originalEntryId: string,
): Promise<void> {
  const updated = await tx
    .update(journalEntries)
    .set({ reversalOfEntryId: originalEntryId, updatedAt: sql`now()` })
    .where(and(eq(journalEntries.id, entryId), sql`${journalEntries.reversalOfEntryId} is null`))
    .returning({ id: journalEntries.id });

  if (updated.length === 0) {
    throw new Error(
      `setReversalOfEntryId: entry ${entryId} does not exist or already has a reversal_of_entry_id`,
    );
  }
}

/**
 * Flips the ORIGINAL entry's status posted -> reversed (Contract §2's "the original
 * transitions posted -> reversed. T-103 already permits exactly that transition and no
 * other mutation" — migration 0003's trigger already allows this; migration 0005 only
 * adds the separate reversal_of_entry_id-backfill exception above, for the NEW entry).
 */
export async function markEntryReversed(tx: Tx, entryId: string): Promise<void> {
  const updated = await tx
    .update(journalEntries)
    .set({ status: 'reversed', updatedAt: sql`now()` })
    .where(and(eq(journalEntries.id, entryId), eq(journalEntries.status, 'posted')))
    .returning({ id: journalEntries.id });

  if (updated.length === 0) {
    throw new Error(`markEntryReversed: entry ${entryId} was not a posted entry`);
  }
}
