/**
 * T-352 / DEF-478 — `supersedeConfig`'s field parsing, moved here from
 * `apps/erp/src/app/settings/attendance/actions.ts` so it runs AFTER `authorize()`, in the domain,
 * instead of before it in the action. `docs/tasks/352-def-478-attendance-parse-after-authorize.md`.
 *
 * Every human sentence is byte-identical to the action's old ones (R3) — only the raw (developer)
 * prefix changed, from `updateAttendanceConfigAction:` to `supersedeConfig:`.
 */
import type { ConfigChanges, NumericConfigKeys, ParsedConfigChanges } from './config';
import { refuse } from '../shared/refusal';
import { parseWholeNumberInput } from '../shared/whole-number-input';
import { parseMoneyInput } from '../shared/money-input';
import { compareDecimal, decimal, type Decimal, type Money } from '@shareat/core/money';

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
 * whole-number/range check — `parseWholeNumberInput` in `../shared/whole-number-input.ts` — is
 * reached only by finite non-whole or out-of-range text (`1.5`, `-1`, `70`). **Blank (Ian, Q2)** —
 * `''`/spaces refuses by name; the `fallback` this used to return is gone.
 */
function parseConfigWholeNumber(raw: string | number, key: string, label: string, min: number, max?: number): number {
  const v = String(raw).trim();
  if (v === '') {
    throw refuse(`supersedeConfig: ${key} is blank`, wholeNumberSentence(label, min, max));
  }
  if (!Number.isFinite(Number(v))) {
    throw refuse(`supersedeConfig: ${key} is not a number: ${JSON.stringify(v)}`, `${label} — "${v}" is not a number.`);
  }
  return parseWholeNumberInput(v, `supersedeConfig: ${key}`, label, min, max ?? NO_MAX_CEILING);
}

/**
 * Blank means "not set", never `0` — `Number('')` is `0`, DEF-087's exact failure shape.
 * ⭐ Auto clock-out hour only (Ian, 2026-09-28 confirmed): blank stays `null` — the page's own
 * hint "Blank = this store never auto-clears". A NON-blank value still gets the whole-number/
 * range treatment, same as `parseConfigWholeNumber()`.
 */
function parseConfigWholeNumberOrNull(
  raw: string | number | null,
  key: string,
  label: string,
  min: number,
  max?: number,
): number | null {
  if (raw === null) return null;
  const v = String(raw).trim();
  if (v === '') return null;
  return parseConfigWholeNumber(v, key, label, min, max);
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
function dec2(raw: string, key: string, label: string, min: number, max: number = DEC2_CEILING): Decimal<'4,2'> {
  const v = String(raw).trim();
  if (v === '') {
    throw refuse(`supersedeConfig: ${key} is blank`, `${label} — enter a number.`);
  }
  if (!/^(?=.*\d)\d*(?:\.\d{0,2})?$/.test(v)) {
    throw refuse(
      `supersedeConfig: ${key} is not a valid number: ${JSON.stringify(v)}`,
      `${label} — "${v}" is not a valid number. Use at most two decimal places.`,
    );
  }
  // T-371 C4 — the range checks run in scaled bigint on branded values, never as floats. The shape test above already
  // passed, so the only thing `decimal()` can still refuse is a digit run too long for even (14,2) — which is above
  // `max` by construction, so it gets the at-most sentence. `.5` and `5.` are the shape's own spellings; `decimal()`
  // wants a digit on each side of the point, so they are written out (`0.5`, `5`) before minting, value unchanged.
  const spelled = (v.startsWith('.') ? `0${v}` : v).replace(/\.$/, '');
  const aboveMax = () =>
    refuse(`supersedeConfig: ${key} has to be at most ${max}: ${JSON.stringify(v)}`, `${label} has to be at most ${max}.`);
  let wide: Decimal<'14,2'>;
  try {
    wide = decimal(spelled, '14,2');
  } catch (err) {
    if (err instanceof RangeError) throw aboveMax();
    throw err;
  }
  if (compareDecimal(wide, decimal(min, '14,2')) < 0) {
    throw refuse(`supersedeConfig: ${key} has to be at least ${min}: ${JSON.stringify(v)}`, `${label} has to be at least ${min}.`);
  }
  if (compareDecimal(wide, decimal(max, '14,2')) > 0) {
    throw aboveMax();
  }
  return decimal(spelled, '4,2');
}

/** `null` or blank gives `null` (fixed-OT rate is only meaningful in fixed mode); M4 trims first. */
function parseOvertimeFixedHourly(raw: string | null): Money | null {
  if (raw === null) return null;
  const v = String(raw).trim();
  if (v === '') return null;
  return parseMoneyInput(v, 'supersedeConfig: the overtime fixed hourly', 'The overtime fixed hourly');
}

/**
 * T-371 R6 (✎R13) — blank gives `undefined`: the key is OMITTED, so the successor row inherits the live rate (the
 * column is NOT NULL DEFAULT '0', and a supersede is an update of the policy, so "leave unchanged" is the column's rule).
 * It used to invent `'0'` here; a cleared box no longer silently zeroes a charge policy. M4 trims first.
 */
function parseLateChargePerMinute(raw: string): Money | undefined {
  const v = String(raw).trim();
  if (v === '') return undefined;
  return parseMoneyInput(v, 'supersedeConfig: the late charge per minute', 'The late charge per minute');
}

/**
 * T-374 S5 / DEF-579 — a comma-typed list of whole numbers, parsed after `authorize()`. It replaces the action's
 * `parseIntList`, which silently DROPPED any token that was not an integer (`"9, 1O, 14"` saved as `[9, 14]`).
 * Empty tokens are ignored (`"9,,10,"`); any other token that is not a whole number in `min`..`max` is refused by
 * name; the result is de-duplicated and sorted. A wholly empty list comes back as `[]` — the database CHECKs
 * (`store_attendance_config_allowed_hours_check`, `..._payout_days_range_check`, `..._fixed_days_needed_check`)
 * keep deciding what an empty list means.
 */
function parseWholeNumberList(raw: string, key: string, label: string, min: number, max: number): number[] {
  const seen = new Set<number>();
  for (const token of raw.split(',')) {
    const t = token.trim();
    if (t === '') continue;
    seen.add(parseWholeNumberInput(t, `supersedeConfig: ${key}`, label, min, max));
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * `ConfigChanges` with the ten integer keys and `autoClockOutHour` widened so a caller may pass the
 * raw box string — the action does, now that it no longer parses before `authorize()` (T-352). The two integer
 * ARRAYS (`allowedShiftStartHours`, `payoutDays`) take the raw comma-typed string too (T-374 S5).
 */
export type ConfigChangesInput = Omit<
  ConfigChanges,
  | 'anchorWindowMinutes'
  | 'nightDiffStartHour'
  | 'nightDiffEndHour'
  | 'lateInfractionPoints'
  | 'lateGraceMinutes'
  | 'earlyOutGraceMinutes'
  | 'undertimeGraceMinutes'
  | 'semiMonthlyCutoffDay'
  | 'payoutLagDays'
  | 'maxShiftHours'
  | 'autoClockOutHour'
  | 'allowedShiftStartHours'
  | 'payoutDays'
> & {
  anchorWindowMinutes?: number | string;
  nightDiffStartHour?: number | string;
  nightDiffEndHour?: number | string;
  lateInfractionPoints?: number | string;
  lateGraceMinutes?: number | string;
  earlyOutGraceMinutes?: number | string;
  undertimeGraceMinutes?: number | string;
  semiMonthlyCutoffDay?: number | string;
  payoutLagDays?: number | string;
  maxShiftHours?: number | string;
  autoClockOutHour?: number | string | null;
  allowedShiftStartHours?: number[] | string;
  payoutDays?: number[] | string;
};

type Dec2Key =
  | 'requiredHoursPerShift'
  | 'halfDayHours'
  | 'defaultWorkHours'
  | 'defaultBreakHours'
  | 'nightDiffMultiplier'
  | 'overtimeMultiplier'
  | 'holidayRegularMultiplier'
  | 'holidaySpecialNonWorkingMultiplier'
  | 'holidaySpecialWorkingMultiplier';

type IntKey =
  | 'anchorWindowMinutes'
  | 'nightDiffStartHour'
  | 'nightDiffEndHour'
  | 'lateInfractionPoints'
  | 'lateGraceMinutes'
  | 'earlyOutGraceMinutes'
  | 'undertimeGraceMinutes'
  | 'semiMonthlyCutoffDay'
  | 'payoutLagDays'
  | 'maxShiftHours';

/**
 * R2/B1 item 3 — ONE ordered table mirroring the action's old literal order (`:166-212`), label/
 * min/max copied verbatim from there. A key this table does not name (booleans, enums, the two int
 * arrays) passes through `parseConfigChanges` untouched.
 */
type FieldRow =
  | { kind: 'dec2'; key: Dec2Key; label: string; min: number }
  | { kind: 'int'; key: IntKey; label: string; min: number; max?: number }
  | { kind: 'intOrNull'; key: 'autoClockOutHour'; label: string; min: number; max: number }
  | { kind: 'moneyOrNull'; key: 'overtimeFixedHourly' }
  | { kind: 'moneyBlankOmit'; key: 'lateChargePerMinute' };

const FIELD_TABLE: readonly FieldRow[] = [
  { kind: 'dec2', key: 'requiredHoursPerShift', label: 'The required hours / shift', min: 0.5 },
  { kind: 'dec2', key: 'halfDayHours', label: 'The half-day hours', min: 0.5 },
  { kind: 'int', key: 'anchorWindowMinutes', label: 'The anchor window', min: 0, max: 60 },
  { kind: 'dec2', key: 'defaultWorkHours', label: 'The default work hours', min: 0 },
  { kind: 'dec2', key: 'defaultBreakHours', label: 'The default break hours', min: 0 },
  { kind: 'int', key: 'nightDiffStartHour', label: 'The night diff start hour', min: 0, max: 23 },
  { kind: 'int', key: 'nightDiffEndHour', label: 'The night diff end hour', min: 0, max: 23 },
  { kind: 'dec2', key: 'nightDiffMultiplier', label: 'The night diff multiplier', min: 1 },
  { kind: 'dec2', key: 'overtimeMultiplier', label: 'The overtime multiplier', min: 1 },
  { kind: 'moneyOrNull', key: 'overtimeFixedHourly' },
  { kind: 'dec2', key: 'holidayRegularMultiplier', label: 'The regular holiday multiplier', min: 1 },
  {
    kind: 'dec2',
    key: 'holidaySpecialNonWorkingMultiplier',
    label: 'The special non-working holiday multiplier',
    min: 1,
  },
  { kind: 'dec2', key: 'holidaySpecialWorkingMultiplier', label: 'The special working holiday multiplier', min: 1 },
  { kind: 'moneyBlankOmit', key: 'lateChargePerMinute' },
  { kind: 'int', key: 'lateInfractionPoints', label: 'The late infraction points', min: 0 },
  { kind: 'int', key: 'lateGraceMinutes', label: 'The late grace minutes', min: 0 },
  { kind: 'int', key: 'earlyOutGraceMinutes', label: 'The early-out grace minutes', min: 0 },
  { kind: 'int', key: 'undertimeGraceMinutes', label: 'The undertime grace minutes', min: 0 },
  { kind: 'int', key: 'semiMonthlyCutoffDay', label: 'The semi-monthly cutoff day', min: 1, max: 27 },
  { kind: 'int', key: 'payoutLagDays', label: 'The payout lag days', min: 0, max: 31 },
  { kind: 'intOrNull', key: 'autoClockOutHour', label: 'The auto clock-out hour', min: 0, max: 23 },
  { kind: 'int', key: 'maxShiftHours', label: 'The max shift hours', min: 10 },
] as const;

/** T-352 / DEF-478 — parses every field `supersedeConfig` accepts, called directly after `authorize()`. */
export function parseConfigChanges(c: ConfigChangesInput): ParsedConfigChanges {
  // The integer and pass-through keys ride on `out` (no brand in `ConfigChanges`); the eleven branded numeric columns are
  // collected in `numeric` and joined at the end, so no assertion ever targets a brand (T-371 G3).
  const out = { ...c } as unknown as ConfigChanges;
  const numeric: Pick<ParsedConfigChanges, NumericConfigKeys> = {};
  for (const row of FIELD_TABLE) {
    switch (row.kind) {
      case 'dec2': {
        const raw = c[row.key];
        if (raw === undefined) break;
        numeric[row.key] = dec2(raw, row.key, row.label, row.min);
        break;
      }
      case 'int': {
        const raw = c[row.key];
        if (raw === undefined) break;
        out[row.key] = parseConfigWholeNumber(raw, row.key, row.label, row.min, row.max);
        break;
      }
      case 'intOrNull': {
        const raw = c[row.key];
        if (raw === undefined) break;
        out[row.key] = parseConfigWholeNumberOrNull(raw, row.key, row.label, row.min, row.max);
        break;
      }
      case 'moneyOrNull': {
        const raw = c[row.key];
        if (raw === undefined) break;
        numeric.overtimeFixedHourly = parseOvertimeFixedHourly(raw);
        break;
      }
      case 'moneyBlankOmit': {
        const raw = c[row.key];
        if (raw === undefined) break;
        const parsed = parseLateChargePerMinute(raw);
        if (parsed !== undefined) numeric.lateChargePerMinute = parsed;
        break;
      }
    }
  }
  // T-374 S5 / DEF-579 — the two integer arrays: only a STRING is parsed (a `number[]` passes through untouched, ✎R6).
  if (typeof c.allowedShiftStartHours === 'string') {
    out.allowedShiftStartHours = parseWholeNumberList(c.allowedShiftStartHours, 'allowedShiftStartHours', 'Allowed shift start hours', 0, 23);
  }
  if (typeof c.payoutDays === 'string') {
    out.payoutDays = parseWholeNumberList(c.payoutDays, 'payoutDays', 'Payout days', 1, 31);
  }
  const {
    requiredHoursPerShift, halfDayHours, defaultWorkHours, defaultBreakHours, nightDiffMultiplier, overtimeMultiplier,
    overtimeFixedHourly, holidayRegularMultiplier, holidaySpecialNonWorkingMultiplier, holidaySpecialWorkingMultiplier,
    lateChargePerMinute, ...rest
  } = out;
  void [
    requiredHoursPerShift, halfDayHours, defaultWorkHours, defaultBreakHours, nightDiffMultiplier, overtimeMultiplier,
    overtimeFixedHourly, holidayRegularMultiplier, holidaySpecialNonWorkingMultiplier, holidaySpecialWorkingMultiplier,
    lateChargePerMinute,
  ]; // the raw box strings are replaced by the parsed brands in `numeric`
  return { ...rest, ...numeric };
}
