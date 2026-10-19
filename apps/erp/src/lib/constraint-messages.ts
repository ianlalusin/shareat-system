/**
 * DB CHECK/unique-constraint names → a message a person can read. Hoisted out of
 * `payroll/actions.ts` by T-201 so `settings/attendance/actions.ts` doesn't fork the map — one
 * constraint name has exactly one English sentence, project-wide.
 *
 * ⚠️ Only the WORDING is ours. Re-checking these in TypeScript would be a second source of truth
 * for a rule the database already enforces (bible §3, "the three that catch people out" #3).
 *
 * ⛔ **This file is NOT the only place a constraint failure is turned into a sentence** — DEF-257
 * (T-252, docs/tasks/252-*.md §2): only 9 of the ~48 action files that produce a user-facing
 * error actually import `errorMessage` from here; `remittance/actions.ts` and `till/actions.ts`
 * keep their own screen-specific `CONSTRAINT_MESSAGES` and loop; ~38 more define a fully
 * independent local fallback that never references this file at all. What changes below closes
 * DEF-246 only for the callers that route through this module.
 */
import { recordConstraintRefusal } from '@shareat/domain';
import { logger } from '@shareat/core/logger';
import { containsIdentifier, hasStringCode, isPresentable, looksLikeADump, UUID_SHAPE } from './error-shape';

const SALES_LOCKED_SENTENCE =
  "Sales figures for this store come only from POS and can't be changed here. A wrong sale is refunded on the POS.";

export const CONSTRAINT_MESSAGES: Record<string, string> = {
  // T-375 S4 (R6): the 0185 lock on a linked store's sales figures, tender rows and channel rows, and the link's store.
  sales_days_figures_locked: SALES_LOCKED_SENTENCE,
  sales_day_tenders_locked: SALES_LOCKED_SENTENCE,
  sales_day_channels_locked: SALES_LOCKED_SENTENCE,
  pos_v1_store_links_store_fixed: SALES_LOCKED_SENTENCE,
  // T-382 (0187): the unlink's two CHECKs. The screen and the domain check first; these are the database's last word.
  pos_v1_store_links_unlink_shape_check: 'An unlink needs who, when and why together.',
  pos_v1_store_links_unlink_reason_check: 'Say why this store is being unlinked, in under 500 characters.',
  // T-385 (0188): the order open -> submitted -> verified. The domain refuses first; this is the database's last word.
  sales_days_verify_requires_submitted: 'A sales day can be verified only after it has been submitted.',
  // T-369 S7: with a voided day freeing its date, two managers can race to re-enter it and the loser meets
  // the unique index (now partial, migration 0177).
  sales_days_org_id_store_id_business_date_unique:
    'Someone else just entered a sales day for this date. Reload the page.',
  pay_runs_no_overlapping_posted_period:
    'A posted run already covers part of that period. ⛔ Periods may not overlap — the overlap ' +
    'would be paid twice. Void the existing run first, or choose dates outside it.',
  pay_rates_employment_from_unique:
    'That job already has a rate starting on that date. Pick a different effective date, or ' +
    'supersede it from the day the new rate really begins.',
  pay_rates_amount_positive_check: 'A pay rate has to be more than zero.',
  payslips_run_employment_unique: 'That person already has a payslip in this run.',
  attendance_days_frozen_by_pay_run_fk: 'Those days belong to a pay run that still exists.',

  // T-201 — the settings screen's own writes, all against `store_attendance_config`.
  store_attendance_config_charge_rate_check:
    'A store charging for lateness needs a per-minute rate above zero — otherwise the policy ' +
    'looks enforced and costs nothing.',
  store_attendance_config_half_day_below_required_check:
    'Half-day hours must be less than the required hours for a full shift.',
  store_attendance_config_positive_hours_check:
    'Required hours and half-day hours must both be more than zero.',
  store_attendance_config_grace_non_negative_check:
    'Grace minutes (late, early-out, undertime) cannot be negative.',
  store_attendance_config_allowed_hours_check:
    'Allowed shift-start hours must be real hours (0–23), with no duplicates.',
  store_attendance_config_overtime_mode_check: 'Overtime mode must be "multiplier" or "fixed".',
  store_attendance_config_fixed_ot_needs_amount_check:
    'A flat overtime rate needs a peso amount — a fixed mode with no amount would price every ' +
    'overtime hour at zero.',
  store_attendance_config_fixed_ot_positive_check: 'The flat overtime rate has to be more than zero.',
  store_attendance_config_holiday_multipliers_check:
    'Holiday multipliers must all be 1 or higher — a premium below 1 would turn into a deduction.',
  store_attendance_config_semi_monthly_two_days_check:
    'A semi-monthly store pays on exactly two different days of the month. Enter two payout days, for example 10,25.',
  store_attendance_config_period_type_check:
    'Pay period type must be monthly, semi-monthly, or weekly.',
  store_attendance_config_cutoff_day_check:
    'The semi-monthly cutoff day must be between 1 and 27 — 28 or later leaves February\'s second ' +
    'period empty or inverted.',
  store_attendance_config_payout_mode_check: 'Payout mode must be "lag" or "fixed_days".',
  store_attendance_config_fixed_days_needed_check:
    'A store paying on fixed days must say which days — otherwise payday would silently fall ' +
    'back to the period end.',
  store_attendance_config_payout_days_range_check: 'Payout days must each be between 1 and 31.',
  store_attendance_config_anchor_window_check: 'The anchor window must be between 0 and 60 minutes.',
  store_attendance_config_night_window_check: 'Night-differential start and end hours must be 0–23.',
  store_attendance_config_time_mode_check: 'Time mode must be "open" or "fixed".',
  store_attendance_config_late_policy_check:
    'Late policy must be "record_only", "charge_per_minute", or "infraction".',

  // T-230 — sales channels. ⚠️ The unique INDEX is listed here too: `errorMessage` substring-matches
  // the raw driver error, and Postgres names the index in a unique violation exactly as it names a
  // constraint in a check violation.
  sales_channels_non_remitted_needs_receivable_check:
    'A channel that settles later needs a receivable account — without one its sales would have ' +
    'nowhere to land and the money would be silently lost rather than refused.',
  sales_channels_wastage_type_mode_check:
    'A channel’s wastage policy must be either "reviewed" or "decided on the spot".',
  sales_channels_org_id_store_id_name_unique:
    'This store already has a sales channel with that name. Names are compared ignoring case and ' +
    'spacing, so "Foodpanda" and "foodpanda " would be the same channel twice.',
  // T-378 R1 — no default unit or kind: a blank or foreign value reaches the CHECK, which speaks.
  items_base_unit_check: 'Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll.',
  item_requests_base_unit_check: 'Choose the unit this item is measured in: pcs, kg, g, ltr, ml or roll.',
  items_kind_check: 'Choose what kind of item this is.',
  item_requests_kind_check: 'Choose what kind of item this is.',
  // T-383 R4 - the blank guards (0047); no ids, no names.
  items_name_not_blank_check: 'Give the item a name people will recognise.',
  items_code_not_blank_check: 'Give the item a code.',
  // T-386 S6 R12 (0192): the shape; = R5's override-shape sentence.
  items_code_shape_check: 'An item code is 4 letters or numbers, a dash and 3 digits, like CHWN-001.',
  // T-391 S1 (0193): the item's default buying unit. Written for a person; no ids, no names.
  items_purchase_pair_check: "Give the buying unit and how many of the item's own unit it holds together, or neither.",
  items_purchase_unit_check: 'Choose a buying unit that is different from the unit the item is measured in.',
  items_purchase_factor_check: "How many of the item's own unit one buying unit holds must be more than zero.",
  // T-386 R5 (0189): a number once given out under an item-code stem is never given out again. The domain refuses first
  // with the sentence that names the next free code; this is the database's last word. item_code_counters_forward_only
  // gets no sentence: no screen can reach it.
  items_code_never_reused:
    "That code's number has already been given out under those letters. Leave the code blank to get the next free one.",
  // T-378 R2 - the history guard (migration 0186); no ids, no names (I3).
  items_base_unit_fixed:
    "This item's unit can no longer change: it already has stock, counts, invoices, recipes, prices or orders " +
    'recorded in its current unit, and changing it would re-read every one of them in the new unit.',
  // T-443 (0210) - item variations and the open-request backstop. The domain speaks first; these are the database's last word.
  items_variant_guard:
    'That variation is not allowed: variations go one level only, must be the same kind as their parent, and a parent that has ' +
    'variations cannot change kind or be merged.',
  items_variant_not_self_check: 'An item cannot be a variation of itself.',
  item_requests_open_name_key: 'Someone has already asked for an item with that name; it is waiting for a super-admin.',
};

/**
 * T-327 §2 — a SUFFIX rule, not one `CONSTRAINT_MESSAGES` entry per column. Migration `0155`
 * (docs/tasks/327-a-poison-value-that-passes-every-guard.md) adds a `_finite_check` CHECK to all
 * 160 base-table `numeric` columns, mirrored in `packages/db/schema/*.ts`'s `check()` entries —
 * every one of those 160 constraint names ends in this exact suffix, so ONE rule here resolves
 * all of them to one sentence. The rejected alternative is 160 copies of the same wording that
 * drift the first time one of them is edited and the other 159 are not (spec §2).
 *
 * ⛔ Matched on the LITERAL SUFFIX ALONE, never by parsing a table or column name back out of the
 * constraint name. Two of the 160 (`store_attendance_config`'s two longest columns) had their
 * middle segment abbreviated in migration `0155` to fit Postgres's 63-byte identifier limit
 * (`store_attendance_config_holiday_spcl_nonwk_mult_finite_check`,
 * `store_attendance_config_holiday_spcl_working_mult_finite_check`) and no longer contain their
 * full column name — the suffix is the only part of any of these 160 names guaranteed stable.
 *
 * Checked by `mappedMessage` only after an exact `CONSTRAINT_MESSAGES` hit misses, so a screen
 * that ever wants a MORE specific sentence for one particular `_finite_check` name can still add
 * an exact entry above without this rule swallowing it first.
 */
const SUFFIX_CONSTRAINT_MESSAGES: ReadonlyArray<{ suffix: string; message: string }> = [
  {
    suffix: '_finite_check',
    message: 'That is not a valid amount. Enter a figure like 1234.50.',
  },
];

function suffixConstraintMessage(constraintName: string): string | undefined {
  for (const rule of SUFFIX_CONSTRAINT_MESSAGES) {
    if (constraintName.endsWith(rule.suffix)) return rule.message;
  }
  return undefined;
}

/**
 * T-327 slice 2 — the audit found `errorMessage` (exact, then suffix) and
 * `recordIfUnmappedConstraint` (exact only) answering "is this constraint mapped?" two different
 * ways, so every one of the 160 `_finite_check` names read as MAPPED on the screen and UNMAPPED to
 * the refusal counter — the register T-252/DEF-246 built to surface constraints that still need a
 * sentence, flooded instead with 160 that already have one, on every screen that reaches the
 * database through `expenses/lib.ts`'s `withOrgPrincipal` chokepoint (T-261/DEF-274).
 *
 * ⛔ THE ONE RESOLVER — the exact sentence above this file's `recordIfUnmappedConstraint` already
 * names the fix required: *"a pattern hand-copied across callers drifts, so it lives once here
 * instead of once per caller."* That sentence being false of this very file, for "is this
 * constraint mapped", was the defect. `errorMessage` and `recordIfUnmappedConstraint` both call
 * ONLY this function now — they are structurally incapable of disagreeing about mapped-ness,
 * rather than merely agreeing again until the next caller is hand-copied instead of shared.
 */
function mappedMessage(constraintName: string): string | undefined {
  return CONSTRAINT_MESSAGES[constraintName] ?? suffixConstraintMessage(constraintName);
}

/**
 * Extracts a constraint/index name from raw Postgres driver text — the `constraint "name"` shape
 * shared by a CHECK violation (`violates check constraint "…"`) and a unique violation
 * (`violates unique constraint "…"`; this file already relies on constraint/index name parity —
 * see the T-230 comment above). Returns `null` for anything that doesn't look like a constraint
 * violation at all, so non-constraint errors are never affected by the fallback below.
 */
export function parseConstraintName(raw: string): string | null {
  return /constraint "([a-zA-Z0-9_]+)"/.exec(raw)?.[1] ?? null;
}

/**
 * ⭐ T-270/DEF-279 — prefers the driver's own structured `constraint_name` field over parsing it
 * out of the message text. Verified live (`docs/discovery/33-def-279-live-trigger-bodies.md`):
 * `RAISE EXCEPTION ... USING CONSTRAINT` populates ONLY this field, never the message — a
 * hand-written raise's constraint name is invisible to `parseConstraintName` alone. A REAL Postgres
 * constraint violation populates both, so preferring the structured field is strictly more robust
 * than parsing English prose Postgres is free to reword in any release. `parseConstraintName` stays
 * the fallback, unchanged, for anything that doesn't expose the field.
 */
export function resolveConstraintName(err: unknown): string | null {
  // Drizzle wraps the driver's structured error in cause; never parse or display its SQL dump.
  const seen = new Set<unknown>();
  let current = err;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current === 'object' && 'constraint_name' in current) {
      const name = (current as { constraint_name?: unknown }).constraint_name;
      if (typeof name === 'string' && name.length > 0) return name;
    }
    const parsed = parseConstraintName(current instanceof Error ? current.message : String(current));
    if (parsed) return parsed;
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return null;
}

/**
 * bible §13 row 189 — the sanitised fallback. A single line, naming the record type in plain
 * words where the raw text gives one, never the constraint name or the SQL grammar around it.
 */
function genericConstraintMessage(raw: string): string {
  const relation = /relation "([a-zA-Z0-9_]+)"/.exec(raw)?.[1];
  const noun = relation ? relation.replace(/_/g, ' ') : 'that record';
  return `That change isn't allowed for ${noun} — please check the values you entered.`;
}

/**
 * Strips a leading `SomeErrorClass: ` prefix so a thrown message reads as one plain sentence —
 * the fall-through step (4) below, for a codeless application error.
 *
 * ⛔ bible §13 row 189 / DEF-246: an UNMAPPED constraint violation used to fall through to this
 * step unchanged — and the raw Postgres text has no `Ctor: ` prefix to strip, so it rendered
 * verbatim, SQL grammar and all, to the person moving the money. Step 3 below degrades that to a
 * generic but presentable sentence instead. A MAPPED constraint and a non-constraint error are
 * both unaffected — see docs/tasks/252-*.md §7 invariants 1 and 3.
 *
 * ⭐ T-271/DEF-301: the map (step 1) is matched on the RESOLVED constraint name —
 * `resolveConstraintName`, which prefers the driver's structured `err.constraint_name` over
 * parsing prose — never a substring search over the raw message. DEF-301's own register
 * disposition floated keeping the substring scan as a fallback for anything the resolver cannot
 * name; that is deliberately NOT done here (system32-85, T-271 READY): it would preserve DEF-301's
 * failure mode — a confident, WRONG sentence by coincidental substring match — in exactly the
 * population where the resolver has already failed to find a structural name, which is the most
 * dangerous and least visible place to keep it. An unresolved name degrades to the generic
 * sentence or the raw fallback instead, which is a quiet, correct failure. The before/after pass
 * (`apps/erp/tests/integration/constraint-message-lookup*.test.ts`) proves this is
 * behaviour-preserving for all 26 mapped keys.
 *
 * ⛔ **The LOOKUP and the SANITISER answer different questions and must use different resolvers —
 * a real regression caught in review, not a hypothetical.** The lookup (step 1) asks "which
 * constraint is this?", and the structured field is strictly better there. `genericConstraintMessage`
 * (step 3) exists to sanitise RAW POSTGRES GRAMMAR a person must never read (DEF-246/bible row
 * 189) — and the signal for "this is raw grammar" is specifically that the constraint name
 * appears in the PROSE, i.e. `parseConstraintName(raw)`, not merely that a name resolved at all.
 * DEF-279's five hand-raised `RAISE EXCEPTION ... USING CONSTRAINT` invariants populate the
 * structured field but never their own name in the message text — gating step 3 on
 * `resolveConstraintName` instead of `parseConstraintName` would sanitise their hand-authored,
 * precise sentences into the content-free generic one, exactly the regression T-270 deliberately
 * reverted (DEF-301's register row: "the five keep rendering their own hand-authored text... and
 * is BETTER than the generic fallback"). Step 2 below protects that same population, and every
 * OTHER hand-authored `RAISE` besides — see its own comment for why the key is `code === 'P0001'`
 * and not a resolved constraint name.
 */

/**
 * bible §13 row 189 / DEF-378, T-326 — the fall-through's ONLY sanitised sentence for a database
 * error not otherwise resolved above. Deliberately one sentence, not one per SQLSTATE class: the
 * contract asks for "a presentable sentence", and every T2 case (`22P02`, `42703`, `42P01`,
 * `22003`) needs only that no SQL grammar survives, not a distinct wording per class.
 */
const DATABASE_ERROR_FALLBACK =
  'The database refused that change for a reason this screen cannot show. The detail is in the server log.';

/** §2a, T-326 — the codeless-dump sentence. Reuses `looksLikeADump`; see `./error-shape`. */
const CONFIGURATION_DUMP_FALLBACK =
  'Something failed before it could be processed. The reason is in the server log.';

/**
 * T-343 S1 / DEF-417 part 2, Amendment R1 — used ONLY when a candidate sentence carrying an
 * identifier cannot be redacted in place: the candidate is a dump (`looksLikeADump`), or redacting
 * every UUID out of it leaves nothing. The ordinary case — a sentence with a UUID somewhere inside
 * it — is redacted in place (`sanitiseForScreen` below), never blanked to this.
 */
const UNPRESENTABLE_FALLBACK =
  'That could not be done, and the reason is not one this screen can show yet. It has been logged for your admin.';

/**
 * PostgreSQL's default SQLSTATE for a `RAISE EXCEPTION` that sets no explicit `ERRCODE`. A REAL
 * constraint violation is never P0001 — those land in class 23 (`23505` unique, `23514` check,
 * `23503` fk, `23502` not-null) or other driver-assigned classes. So P0001 is a principled
 * discriminator for "a human wrote this RAISE on purpose," not an enumerable one.
 */
const APPLICATION_RAISE_SQLSTATE = 'P0001';

/** Amendment R3 item 6 — hoisted so `sanitiseForScreen` builds this RegExp once, not per call. */
const UUID_SHAPE_GLOBAL = new RegExp(UUID_SHAPE.source, 'gi');

/**
 * T-343 S1, Amendment R1 — the final gate EVERY branch of `errorMessage` passes through. A
 * candidate with no identifier in it is returned completely unchanged (Invariant 11: mapped
 * constraint sentences and id-free P0001 sentences render exactly as today). One that does is
 * redacted IN PLACE — every UUID becomes `[hidden]`, the rest of the sentence survives — and
 * logged once with the raw diagnostic (Invariant 3: sanitising is not discarding). Only a
 * candidate that is a dump, or empty once every UUID is stripped out of it, falls back to
 * `UNPRESENTABLE_FALLBACK`.
 */
function sanitiseForScreen(candidate: string, raw: string, err: unknown): string {
  if (!containsIdentifier(candidate)) return candidate;
  // Amendment R3 item 3 — routine P0001 redactions were flooding error-level alerts; warn instead.
  logger.warn({ err, raw }, 'user-facing error carried an identifier, sanitised for the screen');
  const redacted = candidate.replace(UUID_SHAPE_GLOBAL, '[hidden]').trim();
  if (redacted === '' || looksLikeADump(redacted)) return UNPRESENTABLE_FALLBACK;
  return redacted;
}

/**
 * ⭐ T-326/DEF-378, corrected after `/code-review` — resolution order is UNCHANGED from before
 * this task; the `code` check gates ONLY the fall-through (step 4), except for the P0001
 * carve-out (step 2), which runs regardless of whether steps 1/3 would otherwise apply.
 *
 * ⛔⛔ **The carve-out is keyed on `code === 'P0001'`, NOT on a resolved `constraint_name`.**
 * Measured across `packages/db/migrations/*.sql`: 95 `RAISE EXCEPTION` occurrences, only 5 ever
 * got `USING CONSTRAINT` retrofitted onto them (`0142`, DEF-279). Every OTHER hand-authored raise
 * — "journal entry % is unbalanced", "cannot post journal entry into period %", "cash request %
 * is not approved", dozens more — defaults to SQLSTATE P0001, sets no `constraint_name`, and
 * carries no `constraint "…"` in its prose. Keying the carve-out on a resolved constraint name
 * protected only the five retrofitted sentences and silently sanitised the other ~90 into
 * `DATABASE_ERROR_FALLBACK` — the T-270 regression this task exists to avoid, at ninety times the
 * scale. P0001 **subsumes** the five DEF-279 sentences (`USING CONSTRAINT` doesn't change the
 * SQLSTATE PostgreSQL assigns), so they keep exactly today's behaviour under the corrected key.
 *
 * 1. Mapped constraint → its sentence. Runs first regardless of `code`: a real constraint
 *    violation the map knows about must win even though it's never P0001. ⭐ T-327: resolved via
 *    `mappedMessage` — an exact `CONSTRAINT_MESSAGES` hit, then `suffixConstraintMessage` — today,
 *    the one `_finite_check` suffix rule (§2 above). `recordIfUnmappedConstraint` below calls the
 *    same resolver, so the two can no longer disagree about whether a name is mapped (T-327 slice
 *    2 — they briefly did, exact-only there, exact-then-suffix here).
 * 2. **P0001 → APPLICATION-AUTHORED. Preserve the text.** Never discarded — but as of T-343
 *    Amendment R1 it is no longer "never sanitised, never logged": a P0001 sentence that carries
 *    an identifier is redacted IN PLACE by `sanitiseForScreen` (every UUID → `[hidden]`, the rest
 *    of the hand-authored sentence intact) and logged once when that happens. Only an id-free
 *    P0001 sentence passes through completely untouched and unlogged, exactly as before this task.
 * 3. Resolvable-but-unmapped constraint whose prose DOES carry `constraint "…"` → the existing
 *    generic constraint sentence (unchanged). (A real constraint violation is never P0001, so this
 *    step and step 2 never compete for the same error.)
 * 4. Fall-through — the only step this task changes:
 *    - no `code` → unchanged `Word: ` prefix strip (the DEF-301 path), except a codeless
 *      multi-line dump (§2a — `env()`'s banner shape), which degrades to a generic sentence too.
 *    - any string `code` (guaranteed not P0001 at this point) → a presentable sentence, never the
 *      raw text. The raw text still reaches the server log at `error` level (Invariant 3) —
 *      sanitising is not discarding.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Step 0 (T-343 S1) — a presentable error's own sentence wins outright, ahead of every other
  // resolution step; steps 1-4 below run only when it is not.
  if (isPresentable(err)) {
    return sanitiseForScreen(err.userMessage, raw, err);
  }

  const constraintName = resolveConstraintName(err);
  const mapped = constraintName ? mappedMessage(constraintName) : undefined;
  if (mapped !== undefined) return sanitiseForScreen(mapped, raw, err);

  if (hasStringCode(err) && (err as { code: string }).code === APPLICATION_RAISE_SQLSTATE) {
    return sanitiseForScreen(raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, ''), raw, err);
  }

  if (parseConstraintName(raw)) return sanitiseForScreen(genericConstraintMessage(raw), raw, err);

  if (!hasStringCode(err)) {
    if (looksLikeADump(raw)) {
      logger.error(
        { err, raw },
        'application error message looked like a configuration dump, sanitised for the screen',
      );
      return CONFIGURATION_DUMP_FALLBACK;
    }
    return sanitiseForScreen(raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, ''), raw, err);
  }

  logger.error({ err, raw }, 'database error sanitised for the operator screen');
  return DATABASE_ERROR_FALLBACK;
}

/**
 * NEW — not called by any existing caller in this task. See docs/tasks/252-*.md §3: `errorMessage`
 * stays synchronous and pure; this is the separate, explicitly-invoked entry point a caller with
 * an `orgId` in scope threads in. Re-exported so a caller in `apps/erp` needs only this module's
 * import line — the mechanism itself lives in `packages/domain/src/shared/constraint-refusals.ts`.
 */
export { recordConstraintRefusal };

/**
 * T-343 S5.1b — turns a commissary `Outcome`'s failure arm into a screen sentence. `userReason`,
 * when present, passes the S1 gate as `errorMessage`'s presentable arm (step 0); its absence still
 * routes `reason` through `errorMessage`'s fallback sanitisation, so a raw id never reaches a URL
 * either way.
 */
export function outcomeMessage(result: {
  readonly ok: false;
  readonly reason: string;
  readonly userReason?: string;
}): string {
  return errorMessage(
    Object.assign(new Error(result.reason), result.userReason ? { userMessage: result.userReason } : {}),
  );
}

/**
 * Constraint NAMES that a screen-local `CONSTRAINT_MESSAGES` map already covers — `till/actions.ts`
 * and `remittance/actions.ts` each keep one, and this module cannot see them. Names only, never
 * sentences: see the ⛔ below `recordIfUnmappedConstraint`.
 */
export const LOCALLY_MAPPED_CONSTRAINT_NAMES: ReadonlySet<string> = new Set([
  // till/actions.ts
  'till_custody_shifts_one_open_per_store',
  'till_custody_shifts_prev_unique',
  'till_custody_shifts_store_date_no_unique',
  'till_count_lines_shift_moment_account_unique',
  'till_count_lines_counted_nonnegative_check',
  // remittance/actions.ts
  'stores_pooling_requires_ceiling_check',
  'stores_unremitted_ceiling_positive_check',
  'stores_remittance_cadence_check',
  // ⭐ expenses/actions.ts — T-266, migration 0141. Mapped on the screen rather than here for
  // the reason documented below `recordIfUnmappedConstraint`: neither constraint can be reached
  // from the unauthenticated `/setup` page, so neither sentence belongs in the allowlist that
  // gates what text may appear in that page's URL. The count guard in
  // `apps/erp/tests/constraint-messages.test.ts` caught a first pass that put them there.
  'suppliers_credit_terms_days_check',
  'expense_payments_cash_request_id_fkey',
]);

/**
 * Records a hit ONLY when `err` is an unmapped constraint violation; a no-op otherwise (already
 * mapped, locally mapped on a screen this module cannot see, or not constraint-shaped at all).
 * Bundles the parse-and-check every wired caller would otherwise repeat — DEF-242's own lesson is
 * that a pattern hand-copied across callers drifts, so it lives once here instead of once per
 * caller.
 *
 * ⛔ **"Mapped" is `mappedMessage(constraintName) !== undefined` — the SAME resolver `errorMessage`
 * uses, not a re-implementation.** T-327 slice 2 audit: this used to be `constraintName in
 * CONSTRAINT_MESSAGES` on its own, an exact-only check with no suffix awareness, so every one of
 * the 160 `_finite_check` names (mapped via the suffix rule, §2) read as MAPPED to `errorMessage`
 * and UNMAPPED here — a refusal recorded, on every screen, for a constraint that already has a
 * sentence. Sharing one resolver makes the two questions structurally the same question.
 *
 * ⛔ **Why `LOCALLY_MAPPED_CONSTRAINT_NAMES` holds NAMES, never sentences.**
 * `pre-session-message.ts:137` builds `WRITTEN_FOR_A_PERSON` as
 * `new Set(Object.values(CONSTRAINT_MESSAGES))`, which gates what text may appear in the URL of the
 * unauthenticated `/setup` page. Promoting these 8 sentences into `CONSTRAINT_MESSAGES` would widen
 * that security allowlist by 8 entries as a side effect of a counting change. Names never reach
 * `Object.values(...)`, so this cannot happen by construction.
 */
export async function recordIfUnmappedConstraint(
  err: unknown,
  context: { orgId: string; storeId: string | null; actorPersonId: string | null },
): Promise<void> {
  const constraintName = resolveConstraintName(err);
  if (!constraintName) return;
  if (mappedMessage(constraintName) !== undefined) return;
  if (LOCALLY_MAPPED_CONSTRAINT_NAMES.has(constraintName)) return;
  await recordConstraintRefusal({ ...context, constraintName });
}
