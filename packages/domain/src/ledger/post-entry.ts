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
 *
 * ⭐ **T-264 slice 3 (DEF-284, docs/plans/264-slice3-plan.md) adds ONE narrow exception to "does
 * not re-check any of them":** an optional `periodOverride` lets `admin`/`super_admin` post into a
 * CLOSED period. This is NOT the period-open rule being reimplemented here — the database is
 * still the sole authority (migration 0143's triggers decide, independently); this function only
 * decides who may raise a transaction-local flag, after `authorize()` confirms the capability, and
 * writes the audit row. See `PeriodOverride` below for the contract. `locked` periods are entirely
 * out of the override's reach and are refused before `periodOverride` is even considered.
 */
import { fiscalPeriodsRepo, journalRepo, schema, transaction, type Tx } from '@shareat/db';
import { authorize, type Actor } from '@shareat/auth';

export interface PostEntryLine {
  /** e.g. '6200' — never a uuid. The repo resolves code -> id (Contract §1). */
  accountCode: string;
  storeId?: string | null;
  channelId?: string | null;
  /**
   * The counterparty (T-118, docs/tasks/118-subledger-party-on-line.md). Both-or-neither —
   * the same CHECK `journal_lines_party_both_or_neither_check` enforces at the row. Required
   * on the nine `requires_party` control accounts (2110, 1210, 1220, 1230, 1240, 2130, 1250,
   * 2150, 2400) and forbidden everywhere else — `journal_lines_check_party_requirement`
   * (migration 0007) rejects both directions; postEntry does not re-check this itself, same
   * "do not re-implement a DB-enforced rule" precedent as every other invariant here.
   *
   * DEF-049: added post-T-108. T-118 gave the schema and the trigger a party but never
   * threaded one through this, the ONLY sanctioned write path — every one of T-118's own
   * tests posted party via raw SQL, never through postEntry, which hid the gap. See
   * docs/DEFECTS-REGISTER.md DEF-049 and the T-108 task report.
   */
  partyType?: string | null;
  partyId?: string | null;
  /** Money as a decimal string, matching numeric(14,2). Defaults to '0'. */
  debit?: string;
  credit?: string;
  lineMemo?: string | null;
}

/**
 * T-264 slice 3 (DEF-284, docs/plans/264-slice3-plan.md). Nested — never a top-level `postEntry`
 * parameter — so every existing caller's `PostEntryInput` object literal stays valid with no
 * edits: this field is purely additive. Absent, nothing about `postEntry`'s behaviour changes at
 * all (~100% of postings).
 */
export interface PeriodOverride {
  /** Checked by `authorize(actor, 'override_period_lock')` — never trusted from a boolean or a
   *  caller-supplied "isAdmin" flag (bible §7.1, landmine 17). */
  actor: Actor;
  /** Typed enum, never free text and never a boolean — see `packages/db/schema/period-overrides.ts`
   *  for the members and why each exists. ⚠️ Only the RE-POST of a correction needs this; a
   *  reversal of an entry in an already-closed period is already legitimate on its own (migration
   *  0003 lines 202-208) and must never be wrapped in an override. */
  reason: schema.PeriodOverrideReason;
  note?: string | null;
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
  /** Posts into a CLOSED period only — see `PeriodOverride`. Never applies to a `locked` period;
   *  that stays refused unconditionally, override or not (bible row 193, docs/plans/264-slice3-plan.md). */
  periodOverride?: PeriodOverride;
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

  // T-264 slice 3 (DEF-284): 'locked' is entirely out of the override's reach, ruled by
  // system32-85 (docs/plans/264-slice3-plan.md) — a later fiscal year's close already depends on
  // this period's balances (ADR-006 §7.5), and the exemption bible row 193 authorises is for
  // 'closed' periods only. Refused here, before periodOverride is even considered: no
  // authorize() call, no GUC, no audit row, for a request migration 0143's triggers refuse
  // unconditionally regardless of the flag. Distinct message, deliberately — an admin holding
  // `override_period_lock` must be able to tell, from the text alone, that their capability does
  // not reach this case, rather than reading a generic "not open" and filing a bug report against
  // a correctly-working system (same reasoning as the trigger's own locked branch).
  if (period.status === 'locked') {
    throw new Error(
      `postEntry: fiscal period ${period.id} (${period.startsOn}..${period.endsOn}) is locked ` +
        `— a later fiscal year's close already depends on its balances, and the period-override ` +
        `capability does not apply to locked periods`,
    );
  }

  // Narrowed explicitly, once, right after the 'locked' branch returns above — never re-read
  // `period.status` after this point, so nothing downstream depends on TypeScript retaining a
  // narrowing across several intervening `await`s.
  const periodStatus: 'open' | 'closed' = period.status;

  if (periodStatus !== 'open' && !input.periodOverride) {
    // Only 'closed' can reach here now ('locked' returned above). Byte-identical to pre-T-264
    // behaviour when no override is offered.
    throw new Error(
      `postEntry: fiscal period ${period.id} (${period.startsOn}..${period.endsOn}) is ${periodStatus} — cannot post an entry dated ${input.entryDate}`,
    );
  }

  // T-264 slice 3 — the contract (docs/plans/264-slice3-plan.md, contract point 2): runs
  // UNCONDITIONALLY whenever the caller passes periodOverride, independent of period.status
  // (including when it is already 'open'). Ruled by system32-85: the period's status can be
  // changed by a concurrent transaction between this read and the row written below, so the app
  // can never reliably know in advance whether the exemption will actually be consumed —
  // authorizing and recording whenever the capability was INVOKED never under-records, and
  // over-recording is the safe direction for an audit trail. `periodStatusAtPost` (below) is what
  // lets a reader tell which rows actually bypassed a lock.
  let overrideInvoked = false;
  if (input.periodOverride) {
    await authorize(tx, input.periodOverride.actor, 'override_period_lock', { orgId: input.orgId });
    await journalRepo.beginPeriodOverrideContext(tx);
    overrideInvoked = true;
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
      partyType: line.partyType ?? null,
      partyId: line.partyId ?? null,
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

  // T-264 slice 3 — written in the SAME transaction, immediately after the entry posts: a
  // rollback leaves no row, a commit cannot fail to have one. `periodStatus` is 'open' or
  // 'closed' only ('locked' returned earlier) — exactly `periodStatusAtPost`'s domain.
  if (overrideInvoked && input.periodOverride) {
    await fiscalPeriodsRepo.insertPeriodOverride(tx, {
      orgId: input.orgId,
      periodId: period.id,
      entryId,
      actorPersonId: input.periodOverride.actor.personId,
      reason: input.periodOverride.reason,
      note: input.periodOverride.note ?? null,
      periodStatusAtPost: periodStatus,
    });
  }

  return { entryId, created: true };
}
