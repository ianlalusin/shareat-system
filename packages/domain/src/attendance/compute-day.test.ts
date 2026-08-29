import { describe, expect, it } from 'vitest';
import {
  computeDay,
  paidEndMinute,
  nightDiffMinutesInWindow,
  resolveStartAnchor,
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
  allowedShiftStartHours: [9, 10, 11, 14, 15, 16, 17, 18],
  lateGraceMinutes: 0,
  earlyOutGraceMinutes: 0,
  undertimeGraceMinutes: 0,
  nightDiffEnabled: true,
  nightDiffStartHour: 22,
  nightDiffEndHour: 6,
  allowableBreakMinutes: 60,
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

describe('T-157 D5 — v2 pays REAL MINUTES; the hour-floor is gone', () => {
  const paid = (endHour: number, endMin: number, grace: number, anchorHour = 14, requiredH = 9) =>
    paidEndMinute({
      actualEndMinute: fromHour(endHour, endMin),
      anchorMinute: fromHour(anchorHour),
      requiredMinutes: requiredH * 60,
      earlyOutGraceMinutes: grace,
    });

  it('⭐ with no grace, 23:45 pays to 23:45 — v1 would floor it to 23:00 and cost 45 minutes', () => {
    expect(paid(23, 45, 0)).toBe(fromHour(23, 45));
  });

  it('the early-out grace forgives an early departure, up to a full shift and no further', () => {
    // Anchor 14:00, required 9h ⇒ a full shift ends at 23:00. Out at 22:50 with a 15-minute grace
    // is credited to 23:00, not 23:05 — forgiveness must not manufacture hours nobody worked.
    expect(paid(22, 50, 15)).toBe(fromHour(23));
  });

  it('⛔ a departure FURTHER early than the grace is not forgiven at all', () => {
    // Anchor 14:00, required 9h ⇒ full shift ends 23:00. Out at 22:00 is an hour early, well past a
    // 15-minute grace — so it pays exactly what was worked. ⚠️ The first version added the grace to
    // every end, and the golden master caught it: a two-minute Lipa session was credited 1h12m.
    expect(paid(22, 0, 15)).toBe(fromHour(22));
  });

  it('someone who stayed PAST a full shift is untouched by the grace', () => {
    expect(paid(23, 40, 15)).toBe(fromHour(23, 40));
  });

  it('grace 0 is the identity', () => {
    expect(paid(21, 17, 0)).toBe(fromHour(21, 17));
  });
});

describe('T-157 §2 — the start anchor, Ian’s 2026-08-20 rule', () => {
  it('⭐ Tier 1: a 14:15 in that ran to 23:45 anchors at 15:00, NOT late', () => {
    // The case v1's own comment uses: the old rule floored every tap DOWN, making this "14:00,
    // 15 minutes late" — which only reads as a 15:00 shift they arrived early for.
    //
    // ⚠️ Two things this test had wrong the first time, both worth keeping written down:
    //   1. The end passed here is ALREADY grace-adjusted — `computeDay` floors 23:45 to 23:00
    //      before calling. Passing 23:45 raw tests a call that never happens.
    //   2. The comment's example only holds where the NEXT anchor still delivers a full shift.
    //      At the 9h default, 15:00 -> 23:00 is 8h and Tier 1 correctly does NOT fire; the day
    //      really is a full 9h from 14:00. An 8h store is the one the comment describes.
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 15),
      effectiveEndMinute: fromHour(23),
      policy: policy({ allowedShiftStartHours: [14, 15], requiredMinutes: 8 * 60 }),
    });
    expect(a.anchorMinute).toBe(fromHour(15));
    expect(a.mode).toBe('next');
    expect(a.lateMinutes).toBe(0);
  });

  it('a punch exactly on an allowed start is `exact` and is never reinterpreted', () => {
    const a = resolveStartAnchor({
      startMinute: fromHour(14),
      effectiveEndMinute: fromHour(23),
      policy: policy(),
    });
    expect(a.mode).toBe('exact');
    expect(a.lateMinutes).toBe(0);
  });

  it('falls back to the preceding start, and records the lateness, when the span does not cover', () => {
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 15),
      effectiveEndMinute: fromHour(20),
      policy: policy({ allowedShiftStartHours: [14, 15] }),
    });
    expect(a.anchorMinute).toBe(fromHour(14));
    expect(a.mode).toBe('previous');
    expect(a.lateMinutes).toBe(15);
  });

  it('a punch before every allowed start is `unallowed`, anchored to its own hour', () => {
    const a = resolveStartAnchor({
      startMinute: fromHour(6, 20),
      effectiveEndMinute: fromHour(15),
      policy: policy(),
    });
    expect(a.mode).toBe('unallowed');
    expect(a.anchorMinute).toBe(fromHour(6));
  });

  it('a store with NO allowed starts anchors to the punch’s own hour', () => {
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 40),
      effectiveEndMinute: fromHour(23),
      policy: policy({ allowedShiftStartHours: [] }),
    });
    expect(a.mode).toBe('unallowed');
    expect(a.anchorMinute).toBe(fromHour(14));
  });

  it('⛔ Gate A: a day FULL from the preceding start is never demoted to shed a late mark', () => {
    // 14:15 → 22:50 pays 9h from 14:00. Without Gate A the lower half-day bar from 15:00 (7h50 >= 5h)
    // would demote a full day to a half day purely to lose the lateness.
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 15),
      effectiveEndMinute: fromHour(23),
      policy: policy({ allowedShiftStartHours: [14, 15], shortShiftHalfDayOt: true }),
    });
    // 23:00 - 15:00 = 8h < 9h, so Tier 1 does not fire and Tier 2 is reached. Gate A then sees
    // spanPrev = 23:00 - 14:00 = 9h, which IS the full requirement — so the day is genuinely full
    // from the preceding start and must stay there, late mark and all. Demoting it to a half day
    // purely to shed the late mark is exactly what Gate A exists to prevent.
    expect(a.mode).toBe('previous');
    expect(a.lateMinutes).toBe(15);
  });

  it('⛔ Gate A, precisely: spanPrev covering `required` keeps the previous anchor', () => {
    const p = policy({ allowedShiftStartHours: [14, 15], shortShiftHalfDayOt: true, requiredMinutes: 8 * 60 });
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 15),
      effectiveEndMinute: fromHour(22, 30),
      policy: p,
    });
    // spanPrev = 22:30 - 14:00 = 8h30 >= required 8h ⇒ genuinely full ⇒ fallback, late.
    expect(a.mode).toBe('previous');
    expect(a.lateMinutes).toBe(15);
  });

  it('⭐ Gate B: a tie resolves to the LATE reading, so the tie-break never costs the staffer', () => {
    // required 9h, halfDay 5h, spanPrev exactly 7h ⇒ (9-7) = 2 and (7-5) = 2 ⇒ tie ⇒ fallback.
    const p = policy({ allowedShiftStartHours: [14, 15], shortShiftHalfDayOt: true });
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 30),
      effectiveEndMinute: fromHour(21),
      policy: p,
    });
    expect(a.mode).toBe('previous');
  });

  it('Tier 2 fires when the span sits closer to the half day', () => {
    const p = policy({ allowedShiftStartHours: [14, 15], shortShiftHalfDayOt: true });
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 30),
      effectiveEndMinute: fromHour(20),
      policy: p,
    });
    // spanPrev = 6h; (9-6)=3 > (6-5)=1 ⇒ closer to the half day ⇒ snap to 15:00 (spanNext 5h >= 5h).
    expect(a.mode).toBe('next');
    expect(a.anchorMinute).toBe(fromHour(15));
  });

  it('⚠️ Tier 2 CANNOT fire with the short-shift rule off — moving forward would then cut pay', () => {
    const p = policy({ allowedShiftStartHours: [14, 15], shortShiftHalfDayOt: false });
    const a = resolveStartAnchor({
      startMinute: fromHour(14, 30),
      effectiveEndMinute: fromHour(20),
      policy: p,
    });
    expect(a.mode).toBe('previous');
  });
});

describe('T-157 invariant 1 — ⛔ moving the anchor forward NEVER reduces paid minutes', () => {
  /**
   * ⭐ Property-based, per bible §15.2 and the shape T-111 was supposed to have (DEF-080 records
   * that its property tests were never written — not repeating that here).
   *
   * The invariant is a claim about the RULE, not about a handful of cases: for any config and any
   * span, the anchor the resolver picks must never pay less than the preceding-anchor reading.
   */
  it('holds across generated configs and spans', () => {
    let checked = 0;
    for (let required = 6 * 60; required <= 11 * 60; required += 60) {
      for (let halfDay = 3 * 60; halfDay < required; halfDay += 60) {
        for (const shortShift of [false, true]) {
          for (let startOffset = 0; startOffset <= 55; startOffset += 5) {
            for (let spanMinutes = 60; spanMinutes <= 13 * 60; spanMinutes += 30) {
              const p = policy({
                requiredMinutes: required,
                halfDayMinutes: halfDay,
                shortShiftHalfDayOt: shortShift,
                allowedShiftStartHours: [14, 15],
              });
              const startMinute = fromHour(14) + startOffset;
              const effectiveEndMinute = startMinute + spanMinutes;

              const chosen = resolveStartAnchor({ startMinute, effectiveEndMinute, policy: p });
              const previousAnchor = fromHour(14);

              const paidFrom = (anchorMinute: number) => {
                const raw = Math.max(0, effectiveEndMinute - anchorMinute);
                const capped = Math.min(raw, required);
                if (p.shortShiftHalfDayOt && capped < required && capped >= halfDay) return halfDay;
                return capped;
              };

              expect(
                paidFrom(chosen.anchorMinute),
                `anchor ${chosen.anchorMinute} (${chosen.mode}) paid less than the previous anchor ` +
                  `for required=${required} halfDay=${halfDay} shortShift=${shortShift} ` +
                  `start=+${startOffset} span=${spanMinutes}`,
              ).toBeGreaterThanOrEqual(paidFrom(previousAnchor));
              checked++;
            }
          }
        }
      }
    }
    // The floor that stops a broken generator making this pass vacuously.
    expect(checked).toBeGreaterThan(5000);
  });
});

describe('T-157 invariant 2 — undertime grace runs BEFORE the short-shift rule', () => {
  it('⭐ an 8h50m day against 9h with 60 minutes forgiven is a FULL day, not a half day', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(22, 50), 'out')],
      {
        allowedShiftStartHours: [14],
        undertimeGraceMinutes: 60,
        shortShiftHalfDayOt: true,
      },
    );
    // 14:00 -> 22:50 is 8h50m against 9h — 10 minutes short, well inside the grace. It runs BEFORE
    // the short-shift rule, so the day is never demoted to a half day the grace would have to undo.
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.isHalfDay).toBe(false);
    expect(r.undertimeForgivenMinutes).toBe(10);
    expect(r.pendingOtMinutes).toBe(0);
  });

  it('⭐ DEF-086 FIXED — a grace under 60 minutes now fires, because pay is in real minutes', () => {
    // v1 could not do this: its anchor and its floored end were both hour boundaries, so the
    // shortfall was always a whole hour and a 30-minute grace forgave nothing, silently. Paying
    // real minutes makes the setting mean what its name says. D5 — Ian: "we do it right".
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(22, 40), 'out')],
      { allowedShiftStartHours: [14], undertimeGraceMinutes: 30, shortShiftHalfDayOt: true },
    );
    // 14:00 -> 22:40 is 8h40m against 9h: 20 minutes short, inside the 30-minute grace.
    expect(r.undertimeForgivenMinutes).toBe(20);
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.isHalfDay).toBe(false);
  });

  it('a shortfall beyond the grace is still short, and still becomes a half day', () => {
    const r = day(
      [punch(fromHour(14), 'in'), punch(fromHour(21), 'out')],
      { allowedShiftStartHours: [14], undertimeGraceMinutes: 30, shortShiftHalfDayOt: true },
    );
    expect(r.undertimeForgivenMinutes).toBe(0);
    expect(r.isHalfDay).toBe(true);
  });
});

describe('T-157 invariants 6 & 7 — the caps and the premiums', () => {
  it('computedMinutes never exceeds required; the excess becomes nothing automatically', () => {
    const r = day([punch(fromHour(14), 'in'), punch(fromHour(2), 'out')], { allowedShiftStartHours: [14] });
    expect(r.computedMinutes).toBe(9 * 60);
    expect(r.cappedAtRequired).toBe(true);
    // ⛔ Staying longer does not auto-pay. An approved overtime record is Phase 5's job.
    expect(r.pendingOtMinutes).toBe(0);
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
