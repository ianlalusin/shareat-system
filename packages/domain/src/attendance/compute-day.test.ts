import { describe, expect, it } from 'vitest';
import {
  computeDay,
  paidEndMinute,
  nightDiffMinutesInWindow,
  resolveStartAnchor,
  MINIMUM_CREDITABLE_MINUTES,
  roundOvertimeMinutes,
  type DayPolicy,
  type DayPunch,
} from './compute-day';
import { parseShiftDay, shiftDayRange } from './shift-day';

/**
 * T-157 — the adjudication engine. `docs/tasks/157-attendance-adjudication.md`.
 *
 * ⚠️ Pure and TZ-independent: every instant is built from the shift day's own start, and the file
 * asserts nothing that depends on the machine's zone.
 */

const DAY = parseShiftDay('2026-03-10');
const DAY_START = shiftDayRange(DAY).start.getTime();

/** A punch at `HH:MM` wall clock on (or after) this shift day. */
const at = (minutesFromShiftStart: number): Date => new Date(DAY_START + minutesFromShiftStart * 60_000);
/** Wall-clock hour -> minutes from the 05:00 shift start. */
const fromHour = (hour: number, minute = 0) => (((hour - 5) % 24) + 24) % 24 * 60 + minute;

const policy = (over: Partial<DayPolicy> = {}): DayPolicy => ({
  requiredMinutes: 9 * 60,
  halfDayMinutes: 5 * 60,
  shortShiftHalfDayOt: false,
  halfDayOnMissingTap: false,
  allowedShiftStartHours: [9, 10, 11, 14, 15, 16, 17, 18],
  lateGraceMinutes: 0,
  earlyOutGraceMinutes: 0,
  undertimeGraceMinutes: 0,
  nightDiffEnabled: true,
  nightDiffStartHour: 22,
  nightDiffEndHour: 6,
  allowableBreakMinutes: 60,
  anchorWindowMinutes: 30,
  ...over,
});

const punch = (minutes: number, intent: DayPunch['intent'], lagMs = 0): DayPunch => ({
  occurredAt: at(minutes),
  intent,
  arrivalLagMs: lagMs,
});

const day = (punches: DayPunch[], p: Partial<DayPolicy> = {}, adjustments = {}) =>
  computeDay({ shiftDay: DAY, punches, policy: policy(p), adjustments });

// -------------------------------------------------------------------------------------

describe('T-157b — the paid end floors to the hour, mirroring v1', () => {
  const paid = (endHour: number, endMin: number, grace: number, anchorHour = 14, requiredH = 9) =>
    paidEndMinute({
      actualEndMinute: fromHour(endHour, endMin),
      anchorMinute: fromHour(anchorHour),
      requiredMinutes: requiredH * 60,
      earlyOutGraceMinutes: grace,
    });

  // ⚠️ This block REVERSES D5 on Ian's instruction, 2026-08-29: "mirror v1. we will improve later
  // for now use what is on v1." An earlier version of these tests asserted real-minute pay; they
  // are rewritten rather than deleted so the reversal is legible instead of looking like drift.

  it('with no grace, 23:45 floors to 23:00 — v1s rule, and it costs the 45 minutes', () => {
    expect(paid(23, 45, 0)).toBe(fromHour(23));
  });

  it('within the grace of the NEXT hour, it is credited as having reached it', () => {
    expect(paid(23, 45, 30)).toBe(fromHour(23) + 60);
    expect(paid(23, 30, 30)).toBe(fromHour(23) + 60);
  });

  it('outside the grace it still floors — this is not a round-half-up', () => {
    expect(paid(23, 20, 30)).toBe(fromHour(23));
    expect(paid(23, 30, 15)).toBe(fromHour(23));
  });

  it('the boundary is exact, with no epsilon', () => {
    // v1 needs EPS = 1e-6 here because the hour arrives as a float and :45 can land on
    // 44.99999999999999. In integer minutes `>=` is exact.
    expect(paid(20, 45, 15)).toBe(fromHour(21));
    expect(paid(20, 44, 15)).toBe(fromHour(20));
  });

  it('grace 0 floors, always', () => {
    expect(paid(21, 17, 0)).toBe(fromHour(21));
  });
});

describe('T-157b §1 — the anchor is the NEAREST allowed hour', () => {
  const anchor = (h: number, m: number, p = policy()) =>
    resolveStartAnchor({ startMinute: fromHour(h, m), policy: p });

  it('⭐ EX1 — 14:05 anchors at 14:00, five minutes late', () => {
    const a = anchor(14, 5, policy({ allowedShiftStartHours: [13, 14, 15] }));
    expect(a.anchorMinute).toBe(fromHour(14));
    expect(a.mode).toBe('previous');
    expect(a.lateMinutes).toBe(5);
  });

  it('⭐ EX2 — 13:45 anchors at 14:00, NOT late — the span no longer decides', () => {
    // The span-based rule this replaces asked whether the day covered the required hours from
    // 14:00. It does not ask any more: 13:45 is 15 minutes from 14:00 and 45 from 13:00, so 14:00
    // is the shift they were aiming for, whatever they went on to work.
    const a = anchor(13, 45, policy({ allowedShiftStartHours: [13, 14, 15] }));
    expect(a.anchorMinute).toBe(fromHour(14));
    expect(a.mode).toBe('next');
    expect(a.lateMinutes).toBe(0);
  });

  it('a punch exactly on an allowed hour is `exact` with zero late', () => {
    const a = anchor(14, 0, policy({ allowedShiftStartHours: [13, 14, 15] }));
    expect(a.mode).toBe('exact');
    expect(a.lateMinutes).toBe(0);
  });

  it('⭐ a tie goes to the EARLIER hour, so the tie-break never costs the staffer', () => {
    // 13:30 is 30 minutes from both 13:00 and 14:00. The earlier anchor credits the time they
    // were actually present; the later one would silently discard half an hour of it.
    const a = anchor(13, 30, policy({ allowedShiftStartHours: [13, 14] }));
    expect(a.anchorMinute).toBe(fromHour(13));
    expect(a.lateMinutes).toBe(30);
  });

  it('⛔ beyond the window it anchors to its own hour and is flagged, not snapped', () => {
    // Lipa's real stored grid has a four-hour hole between 11:00 and 15:00.
    const p = policy({ allowedShiftStartHours: [9, 10, 11, 15, 16, 17, 18] });
    const a = anchor(13, 0, p);
    expect(a.mode).toBe('unallowed');
    expect(a.anchorMinute).toBe(fromHour(13));
    expect(a.lateMinutes).toBe(0);
  });

  it('...and the day carries `start_not_allowed`, which does NOT block pay', () => {
    const r = day(
      [punch(fromHour(13), 'in'), punch(fromHour(22), 'out')],
      { allowedShiftStartHours: [9, 10, 11, 15, 16, 17, 18] },
    );
    expect(r.anomalies).toContain('start_not_allowed');
    expect(r.computedMinutes).toBe(9 * 60);
  });

  it('a wider window snaps what a narrow one flags', () => {
    const p = (w: number) => policy({ allowedShiftStartHours: [11, 15], anchorWindowMinutes: w });
    expect(anchor(14, 40, p(30)).mode).toBe('next');
    expect(anchor(14, 20, p(30)).mode).toBe('unallowed');
    expect(anchor(14, 20, p(60)).mode).toBe('next');
  });

  it('a store with NO allowed starts anchors to the punch own hour', () => {
    const a = anchor(14, 40, policy({ allowedShiftStartHours: [] }));
    expect(a.mode).toBe('unallowed');
    expect(a.anchorMinute).toBe(fromHour(14));
  });
});

describe('T-157b §4 — ⭐ overtime rounds at 25 for the half, 50 for the whole', () => {
  // Ian: "counted by .5 so .5, 1, 1.5, 2 ... 35 = 30 mins, 45 = 30 mins, 55 = 60 mins",
  // then "25, for half 50 for whole".
  //
  // ⚠️ NOT v1's rule. `ot-rounding.ts` rounds up at 25 minutes into each HALF-hour block, which
  // gives 30 at fifty minutes. Ian's three examples fit both; they diverge only at 46-54.
  it.each([
    [0, 0], [24, 0], [25, 30], [35, 30], [45, 30], [49, 30],
    [50, 60], [55, 60], [60, 60], [85, 90], [110, 120], [130, 120],
  ])('%i minutes of overtime credits %i', (raw, credited) => {
    expect(roundOvertimeMinutes(raw)).toBe(credited);
  });

  it('always lands on a half-hour and never invents more than one', () => {
    for (let m = 0; m <= 600; m++) {
      expect(roundOvertimeMinutes(m) % 30).toBe(0);
      expect(roundOvertimeMinutes(m)).toBeLessThanOrEqual(m + 30);
    }
  });
});

describe('T-157b §3 — late-out overtime, which used to be discarded', () => {
  it('⭐ EX2 end to end: 13:45 to 23:35 is a 14:00 shift, 9h, no late, 30 minutes pending OT', () => {
    const r = day(
      [punch(fromHour(13, 45), 'in'), punch(fromHour(23, 35), 'out')],
      { allowedShiftStartHours: [13, 14, 15] },
    );
    expect(r.anchorMinute).toBe(fromHour(14));
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.lateMinutes).toBe(0);
    expect(r.earlyOutMinutes).toBe(0);
    expect(r.pendingOtMinutes).toBe(30);
  });

  it('⭐ EX1 end to end: 14:05 to 22:56 is a whole day, 5 late, 4 early out, no OT', () => {
    const r = day(
      [punch(fromHour(14, 5), 'in'), punch(fromHour(22, 56), 'out')],
      {
        allowedShiftStartHours: [13, 14, 15],
        lateGraceMinutes: 5,
        earlyOutGraceMinutes: 30,
        undertimeGraceMinutes: 15,
      },
    );
    expect(r.anchorMinute).toBe(fromHour(14));
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.lateMinutes).toBe(5);
    expect(r.earlyOutMinutes).toBe(4);
    expect(r.pendingOtMinutes).toBe(0);
  });

  it('twenty-four minutes past the end earns nothing', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(23, 24), 'out')],
      { allowedShiftStartHours: [14] },
    );
    expect(r.pendingOtMinutes).toBe(0);
  });

  it('overtime past an hour rounds within its own hour', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(24, 25), 'out')],
      { allowedShiftStartHours: [14] },
    );
    expect(r.pendingOtMinutes).toBe(90);
  });
});

describe('T-157b §5 — the facts are recorded, not destroyed', () => {
  it('⛔ lateMinutes is RAW; the grace only reduces what may be CHARGED', () => {
    const r = day(
      [punch(fromHour(14, 12), 'in'), punch(fromHour(23), 'out')],
      { allowedShiftStartHours: [14], lateGraceMinutes: 5 },
    );
    expect(r.lateMinutes).toBe(12);
    expect(r.lateChargeableMinutes).toBe(7);
  });

  it('a lateness entirely inside the grace is still RECORDED', () => {
    const r = day(
      [punch(fromHour(14, 3), 'in'), punch(fromHour(23), 'out')],
      { allowedShiftStartHours: [14], lateGraceMinutes: 5 },
    );
    expect(r.lateMinutes).toBe(3);
    expect(r.lateChargeableMinutes).toBe(0);
  });

  it('earlyOutMinutes is recorded even when the day is credited in full', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(22, 50), 'out')],
      { allowedShiftStartHours: [14], earlyOutGraceMinutes: 30 },
    );
    expect(r.earlyOutMinutes).toBe(10);
    expect(r.computedMinutes).toBe(9 * 60);
  });
});

describe('T-157 invariant 2 — undertime grace runs BEFORE the short-shift rule', () => {
  it('⭐ an 8h day against 9h with 60 minutes forgiven is a FULL day, not a half day', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(22, 50), 'out')],
      {
        allowedShiftStartHours: [14],
        undertimeGraceMinutes: 60,
        shortShiftHalfDayOt: true,
      },
    );
    // 22:50 floors to 22:00 (no early-out grace here), so the day is 8h against a 9h requirement.
    // The 60-minute grace forgives it, and runs BEFORE the short-shift rule so the day is never
    // demoted to a half day the grace would then have to undo.
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.isHalfDay).toBe(false);
    expect(r.undertimeForgivenMinutes).toBe(60);
    expect(r.pendingOtMinutes).toBe(0);
  });

  it('⛔ DEF-086 RE-OPENED, knowingly — a grace under 60 cannot fire while hours are whole', () => {
    // Ian, 2026-08-29: "mirror v1. we will improve later for now use what is on v1." So v1's
    // hour-flooring is back, and with it this hole: the anchor is an hour boundary and the paid end
    // is one again, so the shortfall against a whole-hour requirement is ALWAYS a whole hour and a
    // 30-minute grace forgives nothing.
    //
    // ⚠️ LIPA HAS undertimeGraceMinutes SET TO 15. This is not hypothetical — it is a live setting
    // at a real store that cannot do anything. Pinned here so "improve later" stays visible.
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(22, 50), 'out')],
      { allowedShiftStartHours: [14], undertimeGraceMinutes: 30, shortShiftHalfDayOt: true },
    );
    expect(r.undertimeForgivenMinutes).toBe(0);
    expect(r.isHalfDay).toBe(true);
  });
});

describe('T-157b §5 — ⭐ the minimum day: under 5 hours is not a day at all', () => {
  // Ian, 2026-08-29, answering DEF-088: "that must be not counted at all min half day 5 hours,
  // 1><5 hour record as unverified OT to be accepted by manager."
  //
  // ⛔ This is the structural fix for DEF-088. The day stops being a unit a double-tap can
  // manufacture: the smallest thing anyone can be credited is a half day, and everything below it
  // has to pass a human before it becomes money.

  it('the minimum is one hour, and it is a named constant', () => {
    expect(MINIMUM_CREDITABLE_MINUTES).toBe(60);
  });

  it('⛔ under an hour is NOT COUNTED AT ALL — no pay, and no overtime either', () => {
    // 14:00 in, 14:45 out. Floors to 14:00, so 0 minutes; nothing is owed and nothing is claimed.
    const r = day([punch(fromHour(14), 'in'), punch(fromHour(14, 45), 'out')], {
      allowedShiftStartHours: [14],
    });
    expect(r.computedMinutes).toBe(0);
    expect(r.pendingOtMinutes).toBe(0);
    expect(r.isHalfDay).toBe(false);
  });

  it('⭐ between one hour and the half day: NO day is credited, the whole stint becomes pending OT', () => {
    // 14:00 to 17:00 is three hours — real work, but not a day. It pays nothing by itself and
    // waits for a manager to accept it.
    const r = day([punch(fromHour(14), 'in'), punch(fromHour(17), 'out')], {
      allowedShiftStartHours: [14],
    });
    expect(r.computedMinutes).toBe(0);
    expect(r.pendingOtMinutes).toBe(3 * 60);
    expect(r.isHalfDay).toBe(false);
  });

  it('the one-hour boundary is exact: 60 minutes earns pending OT, 59 earns nothing', () => {
    const p = { allowedShiftStartHours: [14], earlyOutGraceMinutes: 0 };
    const sixty = day([punch(fromHour(14), 'in'), punch(fromHour(15), 'out')], p);
    expect(sixty.pendingOtMinutes).toBe(60);
    expect(sixty.computedMinutes).toBe(0);

    // 14:59 floors to 14:00 — 0 minutes, which is under the minimum.
    const under = day([punch(fromHour(14), 'in'), punch(fromHour(14, 59), 'out')], p);
    expect(under.pendingOtMinutes).toBe(0);
  });

  it('the OT rounding applies to the band — 3h35m credits 3h30m', () => {
    const r = day([punch(fromHour(14), 'in'), punch(fromHour(17, 35), 'out')], {
      allowedShiftStartHours: [14],
      earlyOutGraceMinutes: 30,
    });
    // 17:35 with a 30-minute grace rounds up to 18:00 = 4h. Still under the 5h half day.
    expect(r.computedMinutes).toBe(0);
    expect(r.pendingOtMinutes).toBe(4 * 60);
  });

  it('at exactly the half day it IS a day again, and is credited', () => {
    const r = day([punch(fromHour(14), 'in'), punch(fromHour(19), 'out')], {
      allowedShiftStartHours: [14],
      shortShiftHalfDayOt: true,
    });
    expect(r.computedMinutes).toBe(5 * 60);
    expect(r.isHalfDay).toBe(true);
    expect(r.pendingOtMinutes).toBe(0);
  });

  it('⭐ DEF-088, end to end: five minutes present cannot become an hour of pay', () => {
    // The real shape from Lipa, generalised: a punch pair minutes apart, far from any allowed
    // start, where v1's floor-back-to-the-previous-hour plus its end rounding manufactured hours.
    //
    // v2: 17:50 is 170 minutes from the nearest allowed start, so it anchors to its own hour and
    // is flagged. The end rounds to 18:00, giving one hour — which is UNDER the half day, so it
    // credits NOTHING and raises an hour a manager has to look at. And because the claim is more
    // than twice the time present, the day is flagged implausible on top.
    const r = day([punch(fromHour(17, 50), 'in'), punch(fromHour(17, 55), 'out')], {
      allowedShiftStartHours: [15],
      earlyOutGraceMinutes: 30,
    });
    expect(r.computedMinutes).toBe(0);
    expect(r.pendingOtMinutes).toBe(60);
    expect(r.anomalies).toContain('implausible_span');
    expect(r.anomalies).toContain('start_not_allowed');
  });

  it('⚠️ the implausibility guard weighs PENDING overtime too, not just pay', () => {
    // Without this the guard would look at `computedMinutes`, see zero, and stay silent on exactly
    // the shape it exists to catch — because the bands route the whole stint into pending OT.
    const r = day([punch(fromHour(17, 50), 'in'), punch(fromHour(17, 55), 'out')], {
      allowedShiftStartHours: [15],
      earlyOutGraceMinutes: 30,
    });
    expect(r.computedMinutes).toBe(0);
    expect(r.pendingOtMinutes).toBeGreaterThan(0);
    expect(r.anomalies).toContain('implausible_span');
  });
});

describe('T-157 invariants 6 & 7 — the caps and the premiums', () => {
  it('computedMinutes never exceeds required; the excess becomes PENDING overtime', () => {
    // ⭐ CHANGED by T-157b §3, and the change is the point. Until then the excess was capped away
    // and DISCARDED — this test asserted `pendingOtMinutes` was 0, which is why Ian's own example
    // produced no overtime. ⛔ The comment below still holds: staying longer does not AUTO-PAY.
    // It is pending, and the approval gate is Phase 5.
    const r = day([punch(fromHour(14), 'in'), punch(fromHour(2), 'out')], { allowedShiftStartHours: [14] });
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.cappedAtRequired).toBe(true);
    expect(r.pendingOtMinutes).toBe(3 * 60);
  });

  it('night differential is measured over the PAID window and honours the configured hours', () => {
    const r = day([punch(fromHour(18), 'in'), punch(fromHour(3), 'out')], { allowedShiftStartHours: [18] });
    // Paid 18:00 -> 03:00 = 9h; the 22:00-06:00 window covers 22:00 -> 03:00 = 5h.
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.nightDiffMinutes).toBe(5 * 60);
  });

  it('a narrowed night window is honoured rather than the hardcoded 22-06', () => {
    const r = day(
      [punch(fromHour(18), 'in'), punch(fromHour(3), 'out')],
      { allowedShiftStartHours: [18], nightDiffStartHour: 0, nightDiffEndHour: 3 },
    );
    expect(r.nightDiffMinutes).toBe(3 * 60);
  });

  it('night differential is zero when the master switch is off', () => {
    const r = day(
      [punch(fromHour(18), 'in'), punch(fromHour(3), 'out')],
      { allowedShiftStartHours: [18], nightDiffEnabled: false },
    );
    expect(r.nightDiffMinutes).toBe(0);
  });

  it('a window wrapping midnight catches an early-morning paid window too', () => {
    // 05:30 -> 06:00 is inside 22:00-06:00 even though the paid window starts after midnight.
    expect(nightDiffMinutesInWindow(30, 90, 22, 6)).toBe(30);
  });
});

describe('T-157 invariant 5 — only break minutes OVER the allowance reduce pay', () => {
  it('a break within the allowance costs nothing', () => {
    const r = day(
      [
        punch(fromHour(14), 'in'),
        punch(fromHour(18), 'break_start'),
        punch(fromHour(18, 45), 'break_end'),
        punch(fromHour(23), 'out'),
      ],
      { allowedShiftStartHours: [14] },
    );
    expect(r.breakMinutes).toBe(45);
    expect(r.breakOverMinutes).toBe(0);
    expect(r.computedMinutes).toBe(9 * 60);
  });

  it('only the excess is deducted', () => {
    const r = day(
      [
        punch(fromHour(14), 'in'),
        punch(fromHour(18), 'break_start'),
        punch(fromHour(19, 30), 'break_end'),
        punch(fromHour(23), 'out'),
      ],
      { allowedShiftStartHours: [14] },
    );
    expect(r.breakMinutes).toBe(90);
    expect(r.breakOverMinutes).toBe(30);
    expect(r.computedMinutes).toBe(9 * 60 - 30);
  });

  it('⛔ an unclosed break is an ANOMALY, not a zero-length break', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(18), 'break_start'), punch(fromHour(23), 'out')],
      { allowedShiftStartHours: [14] },
    );
    expect(r.anomalies).toContain('break_not_closed');
  });
});

describe('T-157 invariant 12 — the unpaired and unusable shapes', () => {
  it('no punches at all', () => {
    const r = day([]);
    expect(r.anomalies).toContain('no_punches');
    expect(r.computedMinutes).toBe(0);
  });

  it('an in with no out is missing_out and credits nothing', () => {
    const r = day([punch(fromHour(14), 'in')]);
    expect(r.anomalies).toContain('missing_out');
    expect(r.computedMinutes).toBe(0);
  });

  it('an out with no in is missing_in', () => {
    const r = day([punch(fromHour(23), 'out')]);
    expect(r.anomalies).toContain('missing_in');
  });

  it('extra punches are flagged as overlapping but first-in/last-out still decide', () => {
    const r = day(
      [
        punch(fromHour(14), 'in'),
        punch(fromHour(15), 'in'),
        punch(fromHour(22), 'out'),
        punch(fromHour(23), 'out'),
      ],
      { allowedShiftStartHours: [14] },
    );
    expect(r.anomalies).toContain('overlapping');
    expect(r.anchorMinute).toBe(fromHour(14));
    expect(r.endMinute).toBe(fromHour(23));
  });

  it('a punch that arrived more than 72 hours late is FLAGGED, never rejected', () => {
    const r = day(
      [punch(fromHour(14), 'in', 80 * 3_600_000), punch(fromHour(23), 'out')],
      { allowedShiftStartHours: [14] },
    );
    expect(r.anomalies).toContain('late_event_arrival');
    // ⭐ And it still adjudicates — the divergence from v1, which rejects and dead-letters.
    expect(r.computedMinutes).toBe(9 * 60);
  });
});

describe('T-157 §3 — ⛔ C1, the inverted-window guard', () => {
  it('an early-out approval before the decided start credits 0h and flags it', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(23), 'out')],
      { allowedShiftStartHours: [14, 18] },
      { startAnchorMinute: fromHour(18), earlyOutApprovedToMinute: fromHour(17) },
    );
    expect(r.anomalies).toContain('inverted_window');
    expect(r.computedMinutes).toBe(0);
  });
});

describe('T-157 — the manager’s decisions are INPUTS', () => {
  it('a chosen start anchor is authoritative and is not re-derived from the span', () => {
    const r = day(
      [punch(fromHour(14, 15), 'in'), punch(fromHour(23, 45), 'out')],
      { allowedShiftStartHours: [14, 15] },
      { startAnchorMinute: fromHour(14) },
    );
    expect(r.anchorMinute).toBe(fromHour(14));
    expect(r.lateMinutes).toBe(15);
  });

  it('an early-out approval pays to the scheduled end', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(20), 'out')],
      { allowedShiftStartHours: [14] },
      { earlyOutApprovedToMinute: fromHour(23) },
    );
    expect(r.computedMinutes).toBe(9 * 60);
  });

  it('a half-day override wins over the automatic rule', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(23), 'out')],
      { allowedShiftStartHours: [14] },
      { halfDayOverride: true },
    );
    expect(r.isHalfDay).toBe(true);
  });
});

describe('T-157 invariant 13 — every duration is an integer', () => {
  it('no fractional minute reaches the result, on a deliberately awkward day', () => {
    const r = day(
      [
        punch(fromHour(14, 17), 'in'),
        punch(fromHour(18, 3), 'break_start'),
        punch(fromHour(19, 41), 'break_end'),
        punch(fromHour(23, 52), 'out'),
      ],
      { allowedShiftStartHours: [14, 15], earlyOutGraceMinutes: 12, undertimeGraceMinutes: 7 },
    );
    for (const v of [
      r.computedMinutes,
      r.lateMinutes,
      r.breakMinutes,
      r.breakOverMinutes,
      r.nightDiffMinutes,
      r.pendingOtMinutes,
      r.undertimeForgivenMinutes,
      r.anchorMinute ?? 0,
      r.endMinute ?? 0,
    ]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});
