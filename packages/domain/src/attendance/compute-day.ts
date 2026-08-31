/**
 * What a day pays. T-157, and the densest logic in the project.
 * `docs/tasks/157-attendance-adjudication.md`.
 *
 * ## ⛔ ONE resolver. This is it
 *
 * v1's own header on `workday.ts` explains why, and it is the best argument in the module:
 *
 * > *"This arithmetic used to exist in three hand-maintained copies — the clock-out path, the
 * > manager review recompute, and the Late / Next-in decision — and they had drifted: a review edit
 * > silently dropped short-shift OT, so correcting a short shift **cut the staffer's pay** by the
 * > remainder the clock terminal would have raised; a review edit never re-derived `lateMinutes`,
 * > leaving a corrected session carrying a false lateness that the scorecard counts."*
 *
 * Every caller in v2 — the ingestor, the manager screen, the payroll preview, the roster — goes
 * through `adjudicateDay`, which calls this and nothing else recomputes.
 *
 * ## ⭐ Integer MINUTES throughout, which is the one deliberate divergence from v1
 *
 * v1 computes in fractional hours as floats, and its own source shows the cost: `EPS = 1e-9` in
 * `resolveStartAnchor`, `1e-6` in the undertime check and again in `graceAdjustedEndHour`, each with
 * a comment explaining that a staffer *"must not lose an hour of pay to a representation artifact on
 * the very boundary the store said it would honour"*.
 *
 * Bible §6 bans floats for money. **Hours are money one multiplication away**, and the same argument
 * applies with the same force. Every epsilon disappears — an epsilon is not a business rule, it is
 * an apology for the number type, and each one is a place where "exactly 5 hours" might not be.
 *
 * ⚠️ This can move an answer on an exact boundary, which is what the golden master exists to
 * surface. A divergence found there is a finding to report, not a number to match (bible §1.3).
 *
 * ## The coordinate system
 *
 * **Minutes from the shift day's 05:00 start**, throughout. An overnight shift therefore runs to a
 * value above 1140 without wrapping, and an 01:00 punch sorts correctly *after* an 18:00 one — which
 * is the whole reason `shiftDayOffsetMsForHour` exists (see `shift-day.ts`).
 */
import { shiftDayOffsetMsForHour, shiftDayRange, type ShiftDay } from './shift-day';

const MIN_MS = 60_000;
const DAY_MIN = 24 * 60;

/** How a day's start anchor was chosen. v1's `startAnchorMode`, unchanged. */
export type AnchorMode = 'exact' | 'previous' | 'next' | 'unallowed';

export type Anomaly =
  | 'missing_in'
  | 'missing_out'
  | 'no_punches'
  | 'overlapping'
  | 'start_not_allowed'
  | 'break_not_closed'
  | 'late_event_arrival'
  | 'inverted_window'
  /** ⛔ Credited far more time than the person was actually present. See DEF-088. */
  | 'implausible_span';

/** Everything the computation reads. Values, never a database — which is what makes it testable. */
export interface DayPolicy {
  requiredMinutes: number;
  halfDayMinutes: number;
  shortShiftHalfDayOt: boolean;
  /** Wall-clock hours, 0-23, sorted and distinct (the DB guarantees that shape). */
  allowedShiftStartHours: number[];
  lateGraceMinutes: number;
  earlyOutGraceMinutes: number;
  undertimeGraceMinutes: number;
  nightDiffEnabled: boolean;
  nightDiffStartHour: number;
  nightDiffEndHour: number;
  allowableBreakMinutes: number;
  /** T-157b: how far a clock-in may be from an allowed hour and still count as aiming for it. */
  anchorWindowMinutes: number;
}

/** A punch, reduced to what the arithmetic needs. */
export interface DayPunch {
  occurredAt: Date;
  intent: 'in' | 'out' | 'break_start' | 'break_end';
  /** Milliseconds between the event and the server seeing it. */
  arrivalLagMs: number;
}

/** The manager's decisions (T-158), as INPUTS. Never patches on the output. */
export interface DayAdjustments {
  /** The Late / Next-in call: minutes-from-shift-start the day is paid from. */
  startAnchorMinute?: number;
  /** Pay to the scheduled end rather than the actual out. */
  earlyOutApprovedToMinute?: number;
  /** Force a half day on or off, overriding the automatic rule. */
  halfDayOverride?: boolean;
  /**
   * ⛔ **DEF-115.** The manager's sign-off or discard, as an INPUT like every other decision.
   *
   * T-158 §7 promised *"`verify` moves the day to `verified`"* and *"`void` moves it to `voided`.
   * A voided day contributes nothing to payroll"* — and nothing ever wrote either status, so a
   * voided day stayed `computed` and **was paid in full**. Carried here rather than patched onto
   * the row afterwards, because that is the architecture the whole adjustment table rests on:
   * decisions are attributed inputs, never patches on an output.
   */
  managerDecision?: 'verified' | 'voided';
}

export interface DayComputation {
  anchorMinute: number | null;
  anchorMode: AnchorMode;
  endMinute: number | null;
  computedMinutes: number;
  isHalfDay: boolean;
  cappedAtRequired: boolean;
  /** RAW. Never grace-adjusted — T-157b §5. */
  lateMinutes: number;
  /** What a late policy may charge: raw minus the grace. */
  lateChargeableMinutes: number;
  /** `max(0, targetEnd − actualOut)`. Recorded even on a full day. */
  earlyOutMinutes: number;
  undertimeForgivenMinutes: number;
  breakMinutes: number;
  allowableBreakMinutes: number;
  breakOverMinutes: number;
  nightDiffMinutes: number;
  pendingOtMinutes: number;
  anomalies: Anomaly[];
  /** Why it came out this way, in plain sentences. v1 calls this `explain` and it earns its place:
   *  a payroll dispute is answered by reading it rather than by re-running the code. */
  explain: string[];
}

/** 72h — see `punches.ts`. Here it only raises a flag; it never rejects. */
const LATE_ARRIVAL_MS = 72 * 60 * 60 * 1000;

/**
 * ⛔ **DEF-088 — a day may not be credited more than this multiple of the time actually present.**
 *
 * Found in the real v1 corpus (D4), not theorised: **12 of 550 August sessions were credited more
 * than twice the time between the first and last tap — 40.4 excess hours across two stores in one
 * month — and every one was `auto_paired`.** Nothing flagged them, so they flowed straight to
 * payroll. The worst was **1.6 minutes present, 5 hours paid.**
 *
 * The mechanism is not a bug in any single rule. It is the *combination* of two deliberate ones: a
 * late arrival is credited from the previous allowed start (v1 pays the full shift and recovers
 * lateness through the CHARGE, not through hours), and the end used to floor to the hour. Apply
 * both to a double-tap seconds apart and the day pays hours nobody worked.
 *
 * ⚠️ **v2 is not automatically safe.** Paying real minutes removes the end-flooring half, but the
 * anchor half is a policy we deliberately keep — so a 30-second double tap at 20:09 against an
 * 18:00 allowed start would still credit two hours. This is the guard for that, and it flags
 * rather than refuses: the day may be genuine and only a manager can tell.
 *
 * ⚠️ **The number needs Ian.** `2` says "credited at most twice what was present". It is a
 * deliberately loose first cut — every one of the twelve is far past it — chosen so a genuine
 * late arrival paid from a scheduled start is not swept up. It is a named constant precisely so
 * it can be argued with.
 */
export const MAX_CREDIT_TO_PRESENCE_RATIO = 2;

/**
 * ⭐ **The minimum stint that is worth anything at all.** Ian, 2026-08-29, answering DEF-088:
 * *"that must be not counted at all min half day 5 hours, 1><5 hour record as unverified OT to be
 * accepted by manager."*
 *
 * Three bands, and they replace the old "pro-rate whatever was worked" tail:
 *
 * | Worked | Credited |
 * |---|---|
 * | under 1 hour | **nothing at all** |
 * | 1 hour to `halfDayMinutes` | **nothing as a day** — the whole stint becomes PENDING overtime a manager must accept |
 * | `halfDayMinutes` or more | the half day, then the existing rule |
 *
 * ⛔ **This is the structural fix for DEF-088**, and a better one than the ratio guard alone. The
 * 8.9-second session that v1 credited two hours now credits **zero** and raises two hours a manager
 * has to look at and accept — rather than being paid silently. The day is no longer the unit that
 * can be manufactured by a double-tap; the smallest unit is a half day, and everything under it has
 * to be approved by a human before it becomes money.
 *
 * ⚠️ The one hour is Ian's number and is a plain constant rather than config, because nothing yet
 * suggests it varies by store. `halfDayMinutes` above it IS per-store config.
 */
export const MINIMUM_CREDITABLE_MINUTES = 60;

// -------------------------------------------------------------------------------------

/**
 * The paid end minute — **v1's rule, restored deliberately**.
 *
 * ## ⚠️ This REVERSES part of D5, on Ian's instruction
 *
 * D5 removed v1's hour-flooring so that pay was computed in real minutes. Ian, 2026-08-29, on the
 * eight sessions where that made v2 pay less than v1: *"mirror v1. we will improve later for now
 * use what is on v1."*
 *
 * So the flooring is back, exactly as `graceAdjustedEndHour` (`shift-boundaries.ts:104-141`) does
 * it: the clock-out floors to the hour, and within `earlyOutGraceMinutes` of the NEXT hour it is
 * credited as having reached it. 23:45 with a 30-minute grace pays as 00:00; 23:20 with the same
 * grace still floors to 23:00.
 *
 * ⛔ **What this re-opens, knowingly: DEF-086.** Because the anchor is an hour boundary and the
 * paid end is now one again, the shortfall against a whole-hour requirement is always a whole
 * hour — so `undertimeGraceMinutes` below 60 forgives nothing, silently. **Lipa has it set to 15.**
 * That is the "improve later" Ian named, and it is pinned by a test rather than left to memory.
 *
 * ⭐ **Note what is NOT reverted.** Overtime is still measured from the RAW clock-out, not this
 * rounded one — which is what makes Ian's own example come out at 30 minutes rather than 60. And
 * every duration is still an integer minute. The reversal is this function alone.
 */
export function paidEndMinute(params: {
  actualEndMinute: number;
  anchorMinute: number;
  requiredMinutes: number;
  earlyOutGraceMinutes: number;
}): number {
  const { actualEndMinute, earlyOutGraceMinutes } = params;
  const floored = Math.floor(actualEndMinute / 60) * 60;
  const grace = Math.max(0, Math.min(59, earlyOutGraceMinutes));
  if (grace === 0) return floored;
  const into = actualEndMinute - floored;
  // Integers, so `>=` is exact. v1 needs an EPS here because the hour arrives as a float and an out
  // at exactly :45 can land on 44.99999999999999 — a staffer must not lose an hour to that.
  return into >= 60 - grace ? floored + 60 : floored;
}

export interface StartAnchor {
  anchorMinute: number;
  mode: AnchorMode;
  lateMinutes: number;
}

/**
 * ⭐ **The anchor is the allowed hour the staffer was AIMING FOR — the nearest one.**
 *
 * Ian, 2026-08-29, T-157b: *"staff are allowed to start at any hour exact hour like 9:00, 10:00,
 * 12:00 13:00 14:00 … now the dilema is staff do not clock in exacctly at :00 so the app needs to
 * know which is the target time the staff is clocking in for"* — and, asked directly, *"nearest
 * hour"*.
 *
 * ## ⛔ This REPLACES the span-based Tier 1 / Tier 2 rule, and that is a deliberate reversal
 *
 * The rule it replaces asked whether the day *delivered* the required hours from each candidate
 * start, with two tiers and two gates. It was Ian's 2026-08-20 decision and I ported it faithfully
 * in T-157 — but the research pass found that **v1's attendance has never paid anybody**: 624
 * sessions a month, 136 overtime records, and `payrollRuns`/`payrollStaffPayouts` at **zero**,
 * ever. Bible §1.2b says read v1 as requirements *because staff use it daily*; for the punch
 * capture that holds, for the adjudication rule it does not. The tiers are a failed attempt, not
 * proven practice, and Ian names them as why the module was never adopted.
 *
 * ⭐ **The simplification is larger than it looks: the anchor no longer depends on the span at
 * all.** No end time, no tiers, no gates — which also dissolves the circular dependency between
 * the anchor and the early-out grace that produced a real regression earlier today.
 *
 * ## Ties go to the EARLIER hour
 *
 * The one principle worth keeping from the deleted Gate B: *"ties go to the late reading … so the
 * tie-break can never cost the staffer."* A 13:30 punch against `[13, 14]` is 30 minutes from
 * either; anchoring earlier credits the time they were actually present, anchoring later discards
 * half an hour of it.
 *
 * ## Beyond the window, it does not snap
 *
 * A punch further than `anchorWindowMinutes` from any allowed hour was not aiming for one. It
 * anchors to its own hour and raises `start_not_allowed` — **advisory, never blocking.**
 *
 * ⚠️ Measured, not assumed: against a full hourly grid **0 of 550 real sessions** are more than 30
 * minutes out (30 is the maximum possible when every hour is allowed), so on Ian's stated model
 * this branch is unreachable. Against Lipa's *stored* grid `[9,10,11,15,16,17,18]` — no 12, 13 or
 * 14 — **42% are**. That is a stale config, not off-schedule staff (DEF-087), and the anomaly has
 * to be advisory or it would block nearly half a store's pay for a data-entry problem.
 */
export function resolveStartAnchor(params: {
  startMinute: number;
  policy: DayPolicy;
}): StartAnchor {
  const { startMinute, policy } = params;
  const ownHour = Math.floor(startMinute / 60) * 60;

  const offsets = policy.allowedShiftStartHours
    .map((h) => shiftDayOffsetMsForHour(h) / MIN_MS)
    .sort((a, b) => a - b);

  if (offsets.length === 0) {
    return { anchorMinute: ownHour, mode: 'unallowed', lateMinutes: 0 };
  }

  // Distance to each allowed hour, measured the short way round the clock so a 04:30 punch is 30
  // minutes from an 05:00 start rather than 23.5 hours from it. Strict `<` with the list sorted
  // ascending means a tie keeps the EARLIER hour.
  let best = offsets[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const offset of offsets) {
    const direct = Math.abs(startMinute - offset);
    const distance = Math.min(direct, DAY_MIN - direct);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = offset;
    }
  }

  if (bestDistance > Math.max(0, policy.anchorWindowMinutes)) {
    return { anchorMinute: ownHour, mode: 'unallowed', lateMinutes: 0 };
  }

  // Signed, wrapped: positive means the punch came AFTER the hour (late for it).
  let delta = startMinute - best;
  if (delta > DAY_MIN / 2) delta -= DAY_MIN;
  if (delta < -DAY_MIN / 2) delta += DAY_MIN;

  return {
    anchorMinute: best,
    mode: delta === 0 ? 'exact' : delta > 0 ? 'previous' : 'next',
    lateMinutes: Math.max(0, delta),
  };
}

/**
 * ⭐ **Overtime in half-hour steps: 25 minutes earns the half, 50 earns the whole.**
 *
 * Ian: *"OT is pending paid when verified and counted by .5 so .5 , 1 , 1.5 , 2 hour 35 =30 mins
 * 45 = 30 mins 55 = 60 mins or 1 hour"*, then the thresholds: *"25, for half 50 for whole"*.
 *
 * ⚠️ **This is NOT v1's rule**, and the difference was invisible until Ian gave the second
 * threshold. `ot-rounding.ts` rounds up at 25 minutes into each *half-hour* block, so it yields 30
 * at fifty minutes where this yields 60. All three of Ian's examples (35, 45, 55) fit **both**
 * rules — they diverge only between 46 and 54 minutes. v1's is also explicitly display-only and
 * never changed what was filed; this is the filed figure.
 */
export function roundOvertimeMinutes(minutes: number): number {
  if (minutes <= 0) return 0;
  const wholeHours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder >= 50) return (wholeHours + 1) * 60;
  if (remainder >= 25) return wholeHours * 60 + 30;
  return wholeHours * 60;
}

/**
 * Minutes of the paid window that fall inside the night-differential window.
 *
 * The window is wall-clock and may wrap midnight (the default is 22:00–06:00). Working in shift-day
 * offsets, one instance of the window is `[offset(startHour), offset(startHour) + length)`; the
 * neighbouring instances at ±24h catch a paid window that overlaps the edges — a 05:30 start is
 * inside a 22:00–06:00 window and would otherwise be missed.
 *
 * ⚠️ v1 shipped this hardcoded to 22:00–06:00 *"while `nightDiffStartHour` / `nightDiffEndHour` sat
 * editable-but-ignored in the settings UI — a screen that lied about what it controlled."* The
 * config is read here, always.
 */
export function nightDiffMinutesInWindow(
  fromMinute: number,
  toMinute: number,
  startHour: number,
  endHour: number,
): number {
  const windowLength = (((endHour - startHour) % 24) + 24) % 24 * 60;
  if (windowLength === 0) return 0;
  const base = shiftDayOffsetMsForHour(startHour) / MIN_MS;

  let total = 0;
  for (const k of [-1, 0, 1]) {
    const lo = base + k * DAY_MIN;
    const hi = lo + windowLength;
    total += Math.max(0, Math.min(toMinute, hi) - Math.max(fromMinute, lo));
  }
  return total;
}

// -------------------------------------------------------------------------------------

/**
 * Adjudicate one shift day. **Pure** — values in, values out, no database, no clock.
 *
 * The nine steps run in the order the task spec fixes, and the order is itself a business decision
 * twice over (undertime before short-shift; break after both).
 */
export function computeDay(params: {
  shiftDay: ShiftDay;
  punches: DayPunch[];
  policy: DayPolicy;
  adjustments?: DayAdjustments;
  isHoliday?: boolean;
}): DayComputation {
  const { shiftDay, punches, policy } = params;
  const adjustments = params.adjustments ?? {};
  const explain: string[] = [];
  const anomalies: Anomaly[] = [];

  const dayStartMs = shiftDayRange(shiftDay).start.getTime();
  const toMinute = (d: Date) => Math.round((d.getTime() - dayStartMs) / MIN_MS);

  const empty = (): DayComputation => ({
    anchorMinute: null,
    anchorMode: 'unallowed',
    endMinute: null,
    computedMinutes: 0,
    isHalfDay: false,
    cappedAtRequired: false,
    lateMinutes: 0,
    lateChargeableMinutes: 0,
    earlyOutMinutes: 0,
    undertimeForgivenMinutes: 0,
    breakMinutes: 0,
    allowableBreakMinutes: policy.allowableBreakMinutes,
    breakOverMinutes: 0,
    nightDiffMinutes: 0,
    pendingOtMinutes: 0,
    anomalies,
    explain,
  });

  if (punches.some((p) => p.arrivalLagMs > LATE_ARRIVAL_MS)) {
    anomalies.push('late_event_arrival');
    explain.push(
      'At least one punch reached the server more than 72 hours after it happened — recorded and ' +
        'adjudicated, but a manager should confirm it.',
    );
  }

  // ---- Step 1: pair -----------------------------------------------------------------
  const ordered = [...punches].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (ordered.length === 0) {
    anomalies.push('no_punches');
    explain.push('No punches on this shift day.');
    return empty();
  }

  const ins = ordered.filter((p) => p.intent === 'in');
  const outs = ordered.filter((p) => p.intent === 'out');
  if (ins.length === 0) anomalies.push('missing_in');
  if (outs.length === 0) anomalies.push('missing_out');
  if (ins.length > 1 || outs.length > 1) {
    // ⚠️ Middle punches are audit only — v1: *"Breaks aren't logged at the biometric, so middle taps
    // are kept for audit only."* Their existence is still worth flagging.
    anomalies.push('overlapping');
    explain.push(
      `${ins.length} in and ${outs.length} out punches — first in and last out are used; the rest ` +
        'are kept as evidence and are not part of the arithmetic.',
    );
  }

  if (ins.length === 0 || outs.length === 0) {
    explain.push('An unpaired day cannot be credited hours until a manager settles it.');
    return empty();
  }

  const rawStart = toMinute(ins[0]!.occurredAt);
  const rawEnd = toMinute(outs[outs.length - 1]!.occurredAt);

  // ---- Breaks: pair starts with ends, in order --------------------------------------
  let breakMinutes = 0;
  let openBreakAt: number | null = null;
  for (const p of ordered) {
    if (p.intent === 'break_start') openBreakAt = toMinute(p.occurredAt);
    else if (p.intent === 'break_end' && openBreakAt !== null) {
      breakMinutes += Math.max(0, toMinute(p.occurredAt) - openBreakAt);
      openBreakAt = null;
    }
  }
  if (openBreakAt !== null) {
    // ⛔ NOT treated as a zero-length break. An unclosed break is a day a manager must look at —
    // silently crediting it as no break at all pays for time nobody can account for.
    anomalies.push('break_not_closed');
    explain.push('A break was started and never ended — the day needs review.');
  }

  // ---- The manager's decisions, as INPUTS -------------------------------------------
  const paidStart = adjustments.startAnchorMinute ?? rawStart;
  const paidEndRaw = adjustments.earlyOutApprovedToMinute ?? rawEnd;

  // ⛔ C1 — the inverted-window guard (v1 `workday.ts:126-165`). A Late/Next-in decision combined
  // with an early-out approval can put the paid END at or before the paid START. v1's pairer sorts
  // its two taps by time, so an inverted window would *"silently swap in/out and fabricate a large
  // fictitious shift"*. Defence in depth: T-158 refuses the combination at creation, and this
  // clamps if one ever arrives anyway (bible §15.11).
  if (paidEndRaw <= paidStart) {
    anomalies.push('inverted_window');
    explain.push(
      `Paid window inverted (start ${paidStart}m, end ${paidEndRaw}m) — credited 0h rather than ` +
        'letting the pair reorder itself into a fictitious shift.',
    );
    return empty();
  }

  // ---- Step 2: the start anchor ------------------------------------------------------
  //
  // The resolver is handed the RAW clock-out and applies the early-out grace itself, once per
  // candidate anchor — see `resolveStartAnchor`, and the regression its comment records.
  const anchor =
    adjustments.startAnchorMinute !== undefined
      ? // A manager's explicit decision is authoritative and is not re-derived from the span.
        { anchorMinute: adjustments.startAnchorMinute, mode: 'exact' as AnchorMode, lateMinutes: Math.max(0, rawStart - adjustments.startAnchorMinute) }
      : resolveStartAnchor({ startMinute: paidStart, policy });

  // ---- Step 3: the paid end, with the early-out grace ---------------------------------
  const endMinute = paidEndMinute({
    actualEndMinute: paidEndRaw,
    anchorMinute: anchor.anchorMinute,
    requiredMinutes: policy.requiredMinutes,
    earlyOutGraceMinutes: policy.earlyOutGraceMinutes,
  });
  if (endMinute > paidEndRaw) {
    explain.push(
      `Clock-out ${paidEndRaw}m credited to ${endMinute}m by the ${policy.earlyOutGraceMinutes}-minute ` +
        'early-out grace — they were sent home, not short.',
    );
  }

  // ---- Step 3b: the target shift end, and the two facts measured against it ------------
  //
  // ⭐ Both are measured against the ACTUAL clock-out, not the graced one. The grace decides what
  // is PAID; these record what HAPPENED, and a manager asking "did they leave early" must not be
  // told no because the store forgave it (T-157b §5).
  const targetEndMinute = anchor.anchorMinute + policy.requiredMinutes;
  const earlyOutMinutes = Math.max(0, targetEndMinute - paidEndRaw);
  if (earlyOutMinutes > 0) {
    explain.push(`Left ${earlyOutMinutes}m before the ${policy.requiredMinutes / 60}h shift end.`);
  }

  // ⛔ Late-out overtime. Until T-157b this time was capped away and DISCARDED — Ian's own example
  // (13:45 → 23:35) produced zero overtime where he expects thirty minutes. It is PENDING: the
  // approval gate is Phase 5, and nothing here pays it.
  const rawOvertimeMinutes = Math.max(0, paidEndRaw - targetEndMinute);
  const lateOutOtMinutes = roundOvertimeMinutes(rawOvertimeMinutes);
  if (lateOutOtMinutes > 0) {
    explain.push(
      `Worked ${rawOvertimeMinutes}m past the shift end — ${lateOutOtMinutes}m raised as PENDING ` +
        'overtime, which pays only once approved.',
    );
  }

  if (anchor.mode === 'unallowed') anomalies.push('start_not_allowed');
  explain.push(
    `Anchored at ${anchor.anchorMinute}m (${anchor.mode})` +
      (anchor.lateMinutes > 0 ? `, ${anchor.lateMinutes} minutes late` : ''),
  );

  // ---- Step 4: raw minutes, capped at required ---------------------------------------
  const required = policy.requiredMinutes;
  const rawMinutes = Math.max(0, endMinute - anchor.anchorMinute);
  const cappedAtRequired = rawMinutes > required;
  let computedMinutes = cappedAtRequired ? required : rawMinutes;
  if (cappedAtRequired) {
    explain.push(
      `Capped at the required ${required} minutes — staying longer does not pay itself; the excess ` +
        'needs an approved overtime record.',
    );
  }

  // ---- Step 5: undertime grace, BEFORE the short-shift rule ---------------------------
  // ⛔ v1's comment is explicit about the order: run it after, *"a 8h50m day against a 9h requirement
  // would already have been demoted to a 5h half day, and 'forgive 10 minutes' would then have to
  // UNDO a half day — the two rules would be fighting over the same session."*
  let undertimeForgivenMinutes = 0;
  if (policy.undertimeGraceMinutes > 0 && computedMinutes < required) {
    const short = required - computedMinutes;
    if (short <= policy.undertimeGraceMinutes) {
      undertimeForgivenMinutes = short;
      computedMinutes = required;
      explain.push(`${short} minutes short of the requirement, forgiven by the undertime grace.`);
    }
  }

  // ---- Step 6: short-shift half day + pending OT --------------------------------------
  let isHalfDay = false;
  // ⚠️ Seeded with the late-out figure. The short-shift rule below ADDS to it rather than
  // replacing it: the two are normally mutually exclusive, but a long unpaid break can make a day
  // short even though it ran past the shift end, and both are then real.
  let pendingOtMinutes = lateOutOtMinutes;

  if (computedMinutes < policy.halfDayMinutes) {
    // ⛔ Below the half-day bar there is NO DAY. Ian, 2026-08-29 — see MINIMUM_CREDITABLE_MINUTES.
    // This is what makes a double-tap unable to manufacture pay: the smallest unit anyone can be
    // credited is a half day, and anything under it needs a human before it becomes money.
    const worked = computedMinutes;
    computedMinutes = 0;

    if (worked < MINIMUM_CREDITABLE_MINUTES) {
      explain.push(
        `Only ${worked}m — under the ${MINIMUM_CREDITABLE_MINUTES}-minute minimum, so it is not ` +
          'counted at all.',
      );
    } else {
      const credited = roundOvertimeMinutes(worked);
      pendingOtMinutes += credited;
      explain.push(
        `${worked}m is under the ${policy.halfDayMinutes}m half day, so no day is credited — ` +
          `${credited}m is raised as UNVERIFIED overtime for a manager to accept.`,
      );
    }
  } else if (policy.shortShiftHalfDayOt && computedMinutes < required) {
    const remainder = computedMinutes - policy.halfDayMinutes;
    pendingOtMinutes += remainder;
    computedMinutes = policy.halfDayMinutes;
    isHalfDay = true;
    explain.push(
      `Short shift credited as a half day (${policy.halfDayMinutes}m); the remaining ${remainder}m ` +
        'is raised as PENDING overtime and pays only once approved.',
    );
  }

  if (adjustments.halfDayOverride !== undefined && adjustments.halfDayOverride !== isHalfDay) {
    isHalfDay = adjustments.halfDayOverride;
    explain.push(`Half-day status set to ${isHalfDay} by a manager override.`);
  }

  // ---- Step 7: night differential, over the PAID window -------------------------------
  const nightDiffMinutes = policy.nightDiffEnabled
    ? nightDiffMinutesInWindow(
        anchor.anchorMinute,
        anchor.anchorMinute + computedMinutes,
        policy.nightDiffStartHour,
        policy.nightDiffEndHour,
      )
    : 0;

  // ---- Step 7b: is this day even plausible? (DEF-088) ---------------------------------
  // Compared against the RAW span — how long they were actually on the premises — not against the
  // paid window, which is the thing under suspicion.
  const presentMinutes = Math.max(0, rawEnd - rawStart);
  // ⚠️ Weighed against credited pay PLUS pending overtime, not pay alone. Ian's minimum-day bands
  // route a sub-half-day stint entirely into pending OT, so a check that looked only at
  // `computedMinutes` would see zero and stay quiet on exactly the DEF-088 shape it exists for —
  // the 8.9-second session now credits 0 and raises 2 hours, and the two hours are the problem.
  const claimedMinutes = computedMinutes + pendingOtMinutes;
  if (claimedMinutes > 0 && claimedMinutes > presentMinutes * MAX_CREDIT_TO_PRESENCE_RATIO) {
    anomalies.push('implausible_span');
    explain.push(
      `Present for ${presentMinutes}m but claiming ${claimedMinutes}m (${computedMinutes}m paid, ` +
        `${pendingOtMinutes}m pending) — more than ${MAX_CREDIT_TO_PRESENCE_RATIO}x. A manager must ` +
        'confirm this day before any of it can pay.',
    );
  }

  // ---- Step 8: breaks — only the EXCESS over the allowance costs pay -------------------
  // Discovery 15 §1: *"Staff get a paid break allowance; only the EXCESS over that allowance costs
  // them pay — matches how the business actually compensates breaks."*
  const breakOverMinutes = Math.max(0, breakMinutes - policy.allowableBreakMinutes);
  if (breakOverMinutes > 0) {
    computedMinutes = Math.max(0, computedMinutes - breakOverMinutes);
    explain.push(
      `Break ${breakMinutes}m against a ${policy.allowableBreakMinutes}m paid allowance — ` +
        `${breakOverMinutes}m deducted.`,
    );
  }

  return {
    anchorMinute: anchor.anchorMinute,
    anchorMode: anchor.mode,
    endMinute,
    computedMinutes,
    isHalfDay,
    cappedAtRequired,
    lateMinutes: anchor.lateMinutes,
    lateChargeableMinutes: Math.max(0, anchor.lateMinutes - policy.lateGraceMinutes),
    earlyOutMinutes,
    undertimeForgivenMinutes,
    breakMinutes,
    allowableBreakMinutes: policy.allowableBreakMinutes,
    breakOverMinutes,
    nightDiffMinutes,
    pendingOtMinutes,
    anomalies,
    explain,
  };
}
