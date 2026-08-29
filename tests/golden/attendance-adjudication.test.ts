import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeDay,
  parseShiftDay,
  shiftDayRange,
  type DayPolicy,
  type DayPunch,
} from '../../packages/domain/src/attendance';

/**
 * T-157 §6 — GOLDEN MASTER over real v1 attendance sessions.
 *
 * Bible §15.2 calls golden-master testing *"the most important practice here"*, and the reason
 * applies with unusual force to this module: a hand-written suite for the adjudication engine
 * encodes MY reading of the rules, and my reading is the thing most likely to be wrong. Only real
 * v1 inputs replayed against real v1 outputs can catch that.
 *
 * ## ⚠️ The corpus is not captured yet, and that is a BLOCKED decision, not an oversight
 *
 * Capturing it means running
 *   `npm run capture -- --collection attendanceSessions`
 * against the LIVE ERP Firebase project with a read-only service-account key. That reaches
 * production data and needs Ian's explicit go-ahead — so this session did not do it. Until the file
 * exists these tests **skip with a named reason** rather than passing vacuously, which is the
 * honest state: the harness is real and ready, the evidence is missing, and nothing is credited that
 * has not run.
 *
 * ## What a specimen looks like
 *
 * Each row carries v1's own INPUTS (the raw taps and the store config that was in force) and v1's
 * own OUTPUTS (`computedHours`, `shiftStartHour`, `startAnchorMode`, `isHalfDay`, `nightDiffHours`).
 * We replay the inputs through v2 and diff the outputs.
 *
 * ⭐ **Every divergence is triaged, never suppressed** — three legitimate outcomes:
 *   1. v2 is wrong  → fix v2.
 *   2. v1 was wrong → log it in `DEFECTS-REGISTER.md` A–D with `file:line` and pin v2's behaviour
 *      with a test naming the row. Bible §1.3: *"Where v1 and correct accounting disagree, practice
 *      wins — and the divergence is recorded. A v1-vs-v2 difference is a FINDING, not a failure."*
 *   3. The integer-minutes change (task §3) moved an exact boundary → record it as expected, with
 *      the case.
 */

const CORPUS = join(
  fileURLToPath(new URL('.', import.meta.url)),
  'fixtures',
  'attendance-sessions.json',
);

interface Specimen {
  id: string;
  sessionDate: string;
  rawClockInMs: number;
  rawClockOutMs: number;
  breakMinutes?: number;
  config: {
    requiredHoursPerShift: number;
    halfDayHours: number;
    shortShiftHalfDayOt: boolean;
    allowedShiftStartHours: number[];
    lateGraceMinutes?: number;
    earlyOutGraceMinutes?: number;
    undertimeGraceMinutes?: number;
    nightDiffEnabled?: boolean;
    nightDiffStartHour?: number;
    nightDiffEndHour?: number;
    defaultBreakHours?: number;
  };
  expected: {
    computedHours: number;
    shiftStartHour: number | null;
    startAnchorMode: 'exact' | 'previous' | 'next' | 'unallowed';
    isHalfDay: boolean;
    nightDiffHours: number;
  };
}

const present = existsSync(CORPUS);
const specimens: Specimen[] = present ? (JSON.parse(readFileSync(CORPUS, 'utf8')) as Specimen[]) : [];

function toPolicy(c: Specimen['config']): DayPolicy {
  return {
    requiredMinutes: Math.round(c.requiredHoursPerShift * 60),
    halfDayMinutes: Math.round(c.halfDayHours * 60),
    shortShiftHalfDayOt: c.shortShiftHalfDayOt,
    allowedShiftStartHours: c.allowedShiftStartHours,
    lateGraceMinutes: c.lateGraceMinutes ?? 0,
    earlyOutGraceMinutes: c.earlyOutGraceMinutes ?? 0,
    undertimeGraceMinutes: c.undertimeGraceMinutes ?? 0,
    nightDiffEnabled: c.nightDiffEnabled ?? true,
    nightDiffStartHour: c.nightDiffStartHour ?? 22,
    nightDiffEndHour: c.nightDiffEndHour ?? 6,
    allowableBreakMinutes: Math.round((c.defaultBreakHours ?? 1) * 60),
  };
}

describe('T-157 golden master — v2 against real v1 attendance sessions', () => {
  it.skipIf(present)(
    '⚠️ BLOCKED: the corpus is not captured. Needs Ian — `npm run capture -- --collection attendanceSessions` reaches PRODUCTION',
    () => {
      // Intentionally empty. This case exists so the blocker is VISIBLE in the test output rather
      // than being an absence nobody notices. See this file's header for the three triage outcomes.
    },
  );

  it.runIf(present)('every captured session either matches, or has a documented divergence', () => {
    expect(specimens.length).toBeGreaterThan(0);

    const divergences: string[] = [];
    for (const s of specimens) {
      const day = parseShiftDay(s.sessionDate);
      const dayStart = shiftDayRange(day).start.getTime();
      const punches: DayPunch[] = [
        { occurredAt: new Date(s.rawClockInMs), intent: 'in', arrivalLagMs: 0 },
        { occurredAt: new Date(s.rawClockOutMs), intent: 'out', arrivalLagMs: 0 },
      ];

      const got = computeDay({ shiftDay: day, punches, policy: toPolicy(s.config) });

      const gotHours = got.computedMinutes / 60;
      if (Math.abs(gotHours - s.expected.computedHours) > 1e-9) {
        divergences.push(
          `${s.id}: computedHours v1=${s.expected.computedHours} v2=${gotHours}`,
        );
      }
      if (got.anchorMode !== s.expected.startAnchorMode) {
        divergences.push(
          `${s.id}: startAnchorMode v1=${s.expected.startAnchorMode} v2=${got.anchorMode}`,
        );
      }
      const gotNight = got.nightDiffMinutes / 60;
      if (Math.abs(gotNight - s.expected.nightDiffHours) > 1e-9) {
        divergences.push(`${s.id}: nightDiffHours v1=${s.expected.nightDiffHours} v2=${gotNight}`);
      }
      if (got.isHalfDay !== s.expected.isHalfDay) {
        divergences.push(`${s.id}: isHalfDay v1=${s.expected.isHalfDay} v2=${got.isHalfDay}`);
      }
      void dayStart;
    }

    // ⛔ A divergence is a FINDING to triage, not a number to match. If this fires, read the three
    // outcomes in this file's header before touching either side.
    expect(divergences, `\n${divergences.join('\n')}\n`).toEqual([]);
  });
});
