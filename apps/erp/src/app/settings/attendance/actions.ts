'use server';

/**
 * Server action for `/settings/attendance`. T-201.
 *
 * ⛔ The gate is `authorize(tx, actor, 'manage_store_settings', …)` **inside** `supersedeConfig` —
 * this action does not re-check it. A gate here would protect only this one caller, and the
 * screen would be one new form away from a hole (bible §3, "the database enforces the rules").
 *
 * ⭐ One form, one submit, one `supersedeConfig` call — every field on the row changes together,
 * because the row itself is the unit `supersedeConfig` writes. See the task spec §2.2.
 */
import { redirect } from 'next/navigation';
import { supersedeConfig, parseShiftDay, refuse, type ConfigChanges } from '@shareat/domain';
import { parseMoneyInput } from '@shareat/domain/money-input';
import { requireActor } from '../../../lib/session';
import { errorMessage } from '../../../lib/constraint-messages';
import { withOrgPrincipal, parseIntList } from './lib';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

function bool(fd: FormData, key: string): boolean {
  return fd.get(key) === 'on';
}

/**
 * S5.5w Amendment A2 items 1/2 — a deliberate sane ceiling, far inside int4: no grace period,
 * points value or minutes count is legitimately larger than a five-figure number, so a field with
 * no explicit `max` still needs SOME bound to keep a wildly mistyped value out of the column — and
 * the sentence must still name a real number, never "unbounded". Applies only to the malformed/
 * out-of-range sentence (a typed value); the BLANK sentence is unchanged (`${min} or more`) — Ian's
 * Q2 ruling never asked for a ceiling on "not decided".
 */
const NO_MAX_CEILING = 99999;

/** `${label} — enter a whole number from ${min} to ${max}.` / `…, ${min} or more.` without `max`. */
function wholeNumberSentence(label: string, min: number, max: number | undefined, value?: string): string {
  if (value !== undefined) {
    return `${label} — "${value}" is not a whole number from ${min} to ${max ?? NO_MAX_CEILING}.`;
  }
  return max !== undefined
    ? `${label} — enter a whole number from ${min} to ${max}.`
    : `${label} — enter a whole number, ${min} or more.`;
}

/**
 * S5.5w item 5 — `min`/`max` moved here from the page's dropped `IntField` attributes.
 * **Order is load-bearing for `1,5`:** `Number('1,5')` is `NaN`, so S5.5q's finiteness refusal
 * (sentence unchanged, pinned by `t343-s5-5q-followups.test.ts:167,187`) fires FIRST; the
 * whole-number/range sentence below is reached only by finite non-whole or out-of-range text
 * (`1.5`, `-1`, `70`). **Blank (Ian, Q2)** — `''`/spaces refuses by name; the `fallback` this used
 * to return is gone.
 */
function int(fd: FormData, key: string, label: string, min: number, max?: number): number {
  const v = str(fd, key);
  if (v === '') {
    throw refuse(`updateAttendanceConfigAction: ${key} is blank`, wholeNumberSentence(label, min, max));
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} is not a number: ${JSON.stringify(v)}`,
      `${label} — "${v}" is not a number.`,
    );
  }
  if (!/^\d+$/.test(v) || n < min || n > (max ?? NO_MAX_CEILING)) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} is not a whole number from ${min} to ${max ?? NO_MAX_CEILING}: ${JSON.stringify(v)}`,
      wholeNumberSentence(label, min, max, v),
    );
  }
  return n;
}

/**
 * Blank means "not set", never `0` — `Number('')` is `0`, DEF-087's exact failure shape.
 * ⭐ Auto clock-out hour only (Ian, 2026-09-28 confirmed): blank stays `null` — the page's own
 * hint "Blank = this store never auto-clears". A NON-blank value still gets the whole-number/
 * range treatment, same as `int()`.
 */
function intOrNull(fd: FormData, key: string, label: string, min: number, max?: number): number | null {
  const v = str(fd, key);
  if (v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} is not a number: ${JSON.stringify(v)}`,
      `${label} — "${v}" is not a number.`,
    );
  }
  if (!/^\d+$/.test(v) || n < min || n > (max ?? NO_MAX_CEILING)) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} is not a whole number from ${min} to ${max ?? NO_MAX_CEILING}: ${JSON.stringify(v)}`,
      wholeNumberSentence(label, min, max, v),
    );
  }
  return n;
}

/** `numeric(4,2)`'s own ceiling — two integer digits, two decimal digits. */
const DEC2_CEILING = 99.99;

/**
 * S5.5w item 5 — the nine `numeric(4,2)` `NumField`s (everything except `overtimeFixedHourly` and
 * `lateChargePerMinute`, which are money and use `parseMoneyInput` instead). Returns the validated
 * raw string; the column itself holds the two-decimal value, not a JS number.
 *
 * S5.5w Amendment A3 item 1 — the shape must not narrow what was already accepted (".5" is
 * `halfDayHours`/`requiredHoursPerShift`'s own MINIMUM, and a leading-zero run like "005" is a
 * digit run, not the value): shape first, then the value against `numeric(4,2)`'s own ceiling and
 * the field's own min (no field currently needs a narrower `max` than the column's own).
 */
function dec2(fd: FormData, key: string, label: string, min: number, max: number = DEC2_CEILING): string {
  const v = str(fd, key);
  if (v === '') {
    throw refuse(`updateAttendanceConfigAction: ${key} is blank`, `${label} — enter a number.`);
  }
  if (!/^(?=.*\d)\d*(?:\.\d{0,2})?$/.test(v)) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} is not a valid number: ${JSON.stringify(v)}`,
      `${label} — "${v}" is not a valid number. Use at most two decimal places.`,
    );
  }
  const n = Number(v);
  if (n < min) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} has to be at least ${min}: ${JSON.stringify(v)}`,
      `${label} has to be at least ${min}.`,
    );
  }
  if (n > max) {
    throw refuse(
      `updateAttendanceConfigAction: ${key} has to be at most ${max}: ${JSON.stringify(v)}`,
      `${label} has to be at most ${max}.`,
    );
  }
  return v;
}

function back(store: string, params: Record<string, string>): never {
  redirect(`/settings/attendance?${new URLSearchParams({ store, ...params }).toString()}`);
}

export async function updateAttendanceConfigAction(formData: FormData): Promise<void> {
  const actor = await requireActor();
  const store = str(formData, 'storeId');
  const effectiveFrom = str(formData, 'effectiveFrom');

  const overtimeMode = (str(formData, 'overtimeMode') || 'multiplier') as 'multiplier' | 'fixed';
  const latePolicy = (str(formData, 'latePolicy') || 'record_only') as
    | 'record_only'
    | 'charge_per_minute'
    | 'infraction';
  const payrollPeriodType = (str(formData, 'payrollPeriodType') || 'semi_monthly') as
    | 'monthly'
    | 'semi_monthly'
    | 'weekly';
  const payoutMode = (str(formData, 'payoutMode') || 'lag') as 'lag' | 'fixed_days';
  const timeMode = (str(formData, 'timeMode') || 'open') as 'open' | 'fixed';

  try {
    const changes: ConfigChanges = {
      requiredHoursPerShift: dec2(formData, 'requiredHoursPerShift', 'The required hours / shift', 0.5),
      halfDayHours: dec2(formData, 'halfDayHours', 'The half-day hours', 0.5),
      allowedShiftStartHours: parseIntList(str(formData, 'allowedShiftStartHours')),
      anchorWindowMinutes: int(formData, 'anchorWindowMinutes', 'The anchor window', 0, 60),
      timeMode,
      defaultWorkHours: dec2(formData, 'defaultWorkHours', 'The default work hours', 0),
      defaultBreakHours: dec2(formData, 'defaultBreakHours', 'The default break hours', 0),
      breakEnabled: bool(formData, 'breakEnabled'),
      halfDayOnMissingTap: bool(formData, 'halfDayOnMissingTap'),

      credentialNfc: bool(formData, 'credentialNfc'),
      credentialFingerprint: bool(formData, 'credentialFingerprint'),
      credentialFace: bool(formData, 'credentialFace'),

      shortShiftHalfDayOt: bool(formData, 'shortShiftHalfDayOt'),
      nightDiffEnabled: bool(formData, 'nightDiffEnabled'),
      nightDiffStartHour: int(formData, 'nightDiffStartHour', 'The night diff start hour', 0, 23),
      nightDiffEndHour: int(formData, 'nightDiffEndHour', 'The night diff end hour', 0, 23),
      nightDiffMultiplier: dec2(formData, 'nightDiffMultiplier', 'The night diff multiplier', 1),
      overtimeMode,
      overtimeMultiplier: dec2(formData, 'overtimeMultiplier', 'The overtime multiplier', 1),
      overtimeFixedHourly:
        overtimeMode === 'fixed' && str(formData, 'overtimeFixedHourly')
          ? parseMoneyInput(str(formData, 'overtimeFixedHourly'), 'updateAttendanceConfigAction: the overtime fixed hourly', 'The overtime fixed hourly')
          : null,

      holidayRegularMultiplier: dec2(formData, 'holidayRegularMultiplier', 'The regular holiday multiplier', 1),
      holidaySpecialNonWorkingMultiplier: dec2(formData, 'holidaySpecialNonWorkingMultiplier', 'The special non-working holiday multiplier', 1),
      holidaySpecialWorkingMultiplier: dec2(formData, 'holidaySpecialWorkingMultiplier', 'The special working holiday multiplier', 1),

      latePolicy,
      lateChargePerMinute: str(formData, 'lateChargePerMinute')
        ? parseMoneyInput(str(formData, 'lateChargePerMinute'), 'updateAttendanceConfigAction: the late charge per minute', 'The late charge per minute')
        : '0',
      lateInfractionPoints: int(formData, 'lateInfractionPoints', 'The late infraction points', 0),
      lateGraceMinutes: int(formData, 'lateGraceMinutes', 'The late grace minutes', 0),
      earlyOutGraceMinutes: int(formData, 'earlyOutGraceMinutes', 'The early-out grace minutes', 0),
      undertimeGraceMinutes: int(formData, 'undertimeGraceMinutes', 'The undertime grace minutes', 0),

      payrollPeriodType,
      semiMonthlyCutoffDay: int(formData, 'semiMonthlyCutoffDay', 'The semi-monthly cutoff day', 1, 27),
      payoutMode,
      payoutLagDays: int(formData, 'payoutLagDays', 'The payout lag days', 0, 31),
      payoutDays: parseIntList(str(formData, 'payoutDays')),

      autoClockOutHour: intOrNull(formData, 'autoClockOutHour', 'The auto clock-out hour', 0, 23),
      maxShiftHours: int(formData, 'maxShiftHours', 'The max shift hours', 10),
    };

    await withOrgPrincipal(actor.orgId, (tx) =>
      supersedeConfig(tx, actor, {
        storeId: store,
        effectiveFrom: parseShiftDay(effectiveFrom),
        changes,
      }),
    );
  } catch (err) {
    back(store, { error: errorMessage(err) });
  }
  back(store, { ok: `Saved. The new policy takes effect from ${effectiveFrom}.` });
}
