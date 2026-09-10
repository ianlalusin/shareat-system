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

export const CONSTRAINT_MESSAGES: Record<string, string> = {
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
};

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
 * bible §13 row 189 — the sanitised fallback. A single line, naming the record type in plain
 * words where the raw text gives one, never the constraint name or the SQL grammar around it.
 */
function genericConstraintMessage(raw: string): string {
  const relation = /relation "([a-zA-Z0-9_]+)"/.exec(raw)?.[1];
  const noun = relation ? relation.replace(/_/g, ' ') : 'that record';
  return `That change isn't allowed for ${noun} — please check the values you entered.`;
}

/**
 * Strips a leading `SomeErrorClass: ` prefix so a thrown message reads as one plain sentence.
 *
 * ⛔ bible §13 row 189 / DEF-246: an UNMAPPED constraint violation used to fall through to this
 * function's last line unchanged — and the raw Postgres text has no `Ctor: ` prefix to strip, so
 * it rendered verbatim, SQL grammar and all, to the person moving the money. Now it degrades to a
 * generic but presentable sentence instead. A MAPPED constraint and a non-constraint error are
 * both unaffected — see docs/tasks/252-*.md §7 invariants 1 and 3.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (raw.includes(constraint)) return message;
  }
  const constraintName = parseConstraintName(raw);
  if (constraintName) return genericConstraintMessage(raw);
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '');
}

/**
 * NEW — not called by any existing caller in this task. See docs/tasks/252-*.md §3: `errorMessage`
 * stays synchronous and pure; this is the separate, explicitly-invoked entry point a caller with
 * an `orgId` in scope threads in. Re-exported so a caller in `apps/erp` needs only this module's
 * import line — the mechanism itself lives in `packages/domain/src/shared/constraint-refusals.ts`.
 */
export { recordConstraintRefusal };

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
]);

/**
 * Records a hit ONLY when `err` is an unmapped constraint violation; a no-op otherwise (already
 * mapped, locally mapped on a screen this module cannot see, or not constraint-shaped at all).
 * Bundles the parse-and-check every wired caller would otherwise repeat — DEF-242's own lesson is
 * that a pattern hand-copied across callers drifts, so it lives once here instead of once per
 * caller.
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
  const raw = err instanceof Error ? err.message : String(err);
  const constraintName = parseConstraintName(raw);
  if (!constraintName) return;
  if (constraintName in CONSTRAINT_MESSAGES) return;
  if (LOCALLY_MAPPED_CONSTRAINT_NAMES.has(constraintName)) return;
  await recordConstraintRefusal({ ...context, constraintName });
}
