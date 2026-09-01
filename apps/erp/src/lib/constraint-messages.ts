/**
 * DB CHECK/unique-constraint names → a message a person can read. Hoisted out of
 * `payroll/actions.ts` by T-201 so `settings/attendance/actions.ts` doesn't fork the map — one
 * constraint name has exactly one English sentence, project-wide.
 *
 * ⚠️ Only the WORDING is ours. Re-checking these in TypeScript would be a second source of truth
 * for a rule the database already enforces (bible §3, "the three that catch people out" #3).
 */
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
};

/** Strips a leading `SomeErrorClass: ` prefix so a thrown message reads as one plain sentence. */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [constraint, message] of Object.entries(CONSTRAINT_MESSAGES)) {
    if (raw.includes(constraint)) return message;
  }
  return raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '');
}
