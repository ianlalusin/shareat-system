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
  | 'inverted_window';

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
}

export interface DayComputation {
  anchorMinute: number | null;
  anchorMode: AnchorMode;
  endMinute: number | null;
  computedMinutes: number;
  isHalfDay: boolean;
  cappedAtRequired: boolean;
  lateMinutes: number;
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

// -------------------------------------------------------------------------------------

/**
 * The clock-out minute, with the store's early-out leeway applied.
 *
 * ⭐ The end is FLOORED to the hour, which turns a small kindness into a large deduction: a closer
 * sent home at 23:45 floors to 23:00 and loses a **full hour**, not the fifteen minutes they
 * actually left early. Within the grace window the hour is credited as reached.
 *
 * ⚠️ Deliberately NOT a round-half-up: 23:30 with a 15-minute grace still floors to 23:00. The store
 * decides how much leeway it grants; anything past it is a genuinely short shift and the short-shift
 * rule must see it as one. (v1 `shift-boundaries.ts:104-134`.)
 */
export function graceAdjustedEndMinute(endMinute: number, graceMinutes: number): number {
  const floored = Math.floor(endMinute / 60) * 60;
  const grace = Math.max(0, Math.min(59, graceMinutes));
  if (grace === 0) return floored;
  const into = endMinute - floored;
  // Integers: `>=` is exact. v1 needs an EPS here because `into` arrives as a float and an out at
  // exactly :45 can land on 44.99999999999999.
  return into >= 60 - grace ? floored + 60 : floored;
}

export interface StartAnchor {
  anchorMinute: number;
  mode: AnchorMode;
  lateMinutes: number;
}

/**
 * Which allowed start the day is credited from, read from its SPAN rather than from the punch alone.
 *
 * Ian's rule, 2026-08-20 (`shift-boundaries.ts:191-198`), verbatim:
 *
 * > *"**always try the next start first**, judge whether the hours are covered from there, and only
 * > fall back to the prior start — and record the lateness — when they are not."*
 * >
 * > - **Tier 1 (full day)** — the next start still delivers `requiredHours` ⇒ anchor there, not late.
 * > - **Tier 2 (half day)** — the day is short from the preceding anchor too, and its span sits
 * >   closer to `halfDayHours` than to the required hours ⇒ anchor at the next start as a clean
 * >   half day.
 * > - **otherwise** — the preceding allowed start, and record the lateness.
 *
 * ⛔ **The safety property any future change must keep** (`:192-198`):
 *
 * > *"Moving the anchor forward NEVER reduces a day's guaranteed paid hours."* Tier 1 — both anchors
 * > cap at `required`, so pay is identical and only the lateness disappears. Tier 2 — both credit
 * > `halfDayMinutes`, so pay is again identical; only the *pending, approval-gated* OT remainder
 * > shrinks.
 *
 * ⚠️ Re-derive that property; do not merely match today's outputs. A reimplementation that agrees on
 * the corpus but does not hold it will diverge the first time a store changes `requiredHours`.
 */
export function resolveStartAnchor(params: {
  startMinute: number;
  effectiveEndMinute: number | null;
  policy: DayPolicy;
}): StartAnchor {
  const { startMinute, effectiveEndMinute, policy } = params;

  const offsets = policy.allowedShiftStartHours
    .map((h) => shiftDayOffsetMsForHour(h) / MIN_MS)
    .sort((a, b) => a - b);

  // No schedule configured: anchor to the punch's own hour, exactly as the pairer always did.
  if (offsets.length === 0) {
    return { anchorMinute: Math.floor(startMinute / 60) * 60, mode: 'unallowed', lateMinutes: 0 };
  }

  let prev: number | null = null;
  let next: number | null = null;
  for (const o of offsets) {
    if (o <= startMinute) prev = o;
    else if (next === null) next = o;
  }

  const fallback: StartAnchor = {
    anchorMinute: prev ?? Math.floor(startMinute / 60) * 60,
    mode: prev !== null ? 'previous' : 'unallowed',
    lateMinutes: prev !== null ? Math.max(0, startMinute - prev) : 0,
  };

  // ⭐ Landing exactly on an allowed start leaves nothing to reinterpret — and this is also what
  // keeps a manager's explicit Late/Next-in decision authoritative, because its chosen anchor is
  // always exactly an allowed start and therefore lands here rather than being second-guessed by
  // the span.
  if (prev !== null && fallback.lateMinutes === 0) return { ...fallback, mode: 'exact' };

  if (effectiveEndMinute === null || next === null) return fallback;

  const required = policy.requiredMinutes;
  if (required <= 0) return fallback;

  const spanNext = effectiveEndMinute - next;
  const spanPrev = effectiveEndMinute - fallback.anchorMinute;
  const snapToNext: StartAnchor = { anchorMinute: next, mode: 'next', lateMinutes: 0 };

  // Tier 1 — the next start still delivers a full shift.
  if (spanNext >= required) return snapToNext;

  // ⚠️ Tier 2 exists ONLY because the short-shift rule does. Without it a short day pays its raw
  // hours and moving the anchor forward WOULD cut pay — violating the invariant above.
  const halfDay = policy.halfDayMinutes;
  if (!policy.shortShiftHalfDayOt || halfDay <= 0 || halfDay >= required) return fallback;

  // ⛔ Gate A — the preceding anchor must be GENUINELY short. Without this *"a day that is FULL from
  // the preceding start (14:15→22:50 pays 9h from 14:00) would still clear the lower half-day bar
  // from the next start (8h ≥ 5h) and get demoted to a half day purely to shed a late mark."*
  // Undertime the store already forgives does not count as shortness either.
  const forgiven = Math.max(0, policy.undertimeGraceMinutes);
  if (spanPrev >= required - forgiven) return fallback;

  // Gate B — the delivered span decides which shift was being worked. Ian: *"if the hour covered is
  // 6, 7, 8, decide by which it is closer to."*
  // ⭐ Ties go to the LATE reading, deliberately: it keeps today's behaviour and preserves the
  // larger OT remainder, *"so the tie-break can never cost the staffer."*
  const closerToHalfDay = required - spanPrev > spanPrev - halfDay;
  if (!closerToHalfDay) return fallback;

  return spanNext >= halfDay ? snapToNext : fallback;
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

  // ---- Step 2: grace-adjust the end -------------------------------------------------
  const endMinute = graceAdjustedEndMinute(paidEndRaw, policy.earlyOutGraceMinutes);
  if (endMinute > paidEndRaw) {
    explain.push(
      `Clock-out ${paidEndRaw}m rounded up to ${endMinute}m by the ${policy.earlyOutGraceMinutes}-minute ` +
        'early-out grace — without it the floor to the hour would have cost the whole remainder.',
    );
  }

  // ---- Step 3: the start anchor ------------------------------------------------------
  const anchor =
    adjustments.startAnchorMinute !== undefined
      ? // A manager's explicit decision is authoritative and is not re-derived from the span.
        { anchorMinute: adjustments.startAnchorMinute, mode: 'exact' as AnchorMode, lateMinutes: Math.max(0, rawStart - adjustments.startAnchorMinute) }
      : resolveStartAnchor({ startMinute: paidStart, effectiveEndMinute: endMinute, policy });

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
  let pendingOtMinutes = 0;
  if (policy.shortShiftHalfDayOt && computedMinutes < required) {
    if (computedMinutes >= policy.halfDayMinutes) {
      pendingOtMinutes = computedMinutes - policy.halfDayMinutes;
      computedMinutes = policy.halfDayMinutes;
      isHalfDay = true;
      explain.push(
        `Short shift credited as a half day (${policy.halfDayMinutes}m); the remaining ` +
          `${pendingOtMinutes}m is raised as PENDING overtime and pays only once approved.`,
      );
    } else {
      // Below the half-day bar there is no half day and no OT — it pro-rates to actual hours.
      explain.push('Below the half-day threshold — pro-rated to the hours actually worked.');
    }
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
    lateMinutes: Math.max(0, anchor.lateMinutes - policy.lateGraceMinutes),
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
