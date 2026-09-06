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
// ⚠️ Imported from source rather than restated as a literal `5`: `anchorMinute` is measured from
// the shift day's start, and a copy of that constant here would drift the day it ever moves.
import { SHIFT_DAY_START_HOUR as SHIFT_DAY_START } from '../../packages/domain/src/attendance/shift-day';

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

/**
 * ⚠️ **v1's own defaults, and applying them is part of replaying v1 faithfully.**
 *
 * Captured from production: **Lipa's config carries 22 keys; Malvar's carries 3 and Banay-Banay's
 * carries 1.** Everything absent falls back to `DEFAULT_ATTENDANCE_CONFIG` at READ time via v1's
 * config merge — so two of three operating stores are running almost entirely on defaults nobody
 * chose. That is precisely the hazard T-155's *"every column NOT NULL, so 'unset' cannot exist"*
 * was written against, found live rather than theorised. See DEF-087.
 *
 * Transcribed from `ERP-rebuild/src/types/attendance-config.ts`.
 */
const V1_DEFAULTS = {
  requiredHoursPerShift: 9,
  halfDayHours: 5,
  shortShiftHalfDayOt: false,
  halfDayOnMissingTap: false,
  allowedShiftStartHours: [9, 10, 11, 14, 15, 16, 17, 18],
  lateGraceMinutes: 0,
  earlyOutGraceMinutes: 0,
  undertimeGraceMinutes: 0,
  nightDiffEnabled: true,
  nightDiffStartHour: 22,
  nightDiffEndHour: 6,
  defaultBreakHours: 1,
} as const;

interface Specimen {
  id: string;
  sessionDate: string;
  rawClockInMs: number;
  rawClockOutMs: number;
  breakMinutes?: number;
  config: Partial<Record<keyof typeof V1_DEFAULTS, unknown>>;
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

function toPolicy(raw: Specimen['config']): DayPolicy {
  const c = { ...V1_DEFAULTS, ...raw } as Record<keyof typeof V1_DEFAULTS, never>;
  const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
  return {
    requiredMinutes: Math.round(num(c.requiredHoursPerShift, 9) * 60),
    halfDayMinutes: Math.round(num(c.halfDayHours, 5) * 60),
    shortShiftHalfDayOt: Boolean(c.shortShiftHalfDayOt),
    // ⭐ v1's own value, from the captured store document — all three stores have it ON.
    halfDayOnMissingTap: Boolean(c.halfDayOnMissingTap),
    allowedShiftStartHours: Array.isArray(c.allowedShiftStartHours)
      ? (c.allowedShiftStartHours as number[])
      : [...V1_DEFAULTS.allowedShiftStartHours],
    lateGraceMinutes: num(c.lateGraceMinutes, 0),
    earlyOutGraceMinutes: num(c.earlyOutGraceMinutes, 0),
    undertimeGraceMinutes: num(c.undertimeGraceMinutes, 0),
    nightDiffEnabled: c.nightDiffEnabled !== false,
    nightDiffStartHour: num(c.nightDiffStartHour, 22),
    nightDiffEndHour: num(c.nightDiffEndHour, 6),
    allowableBreakMinutes: Math.round(num(c.defaultBreakHours, 1) * 60),
    // ⚠️ v1 has no such setting, so the replay uses v2's default. It is unreachable on a full
    // hourly grid anyway (30 is the maximum possible distance); on a sparse grid it is exactly the
    // divergence class this comparison is meant to expose.
    anchorWindowMinutes: 30,
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

  /**
   * ⭐ **The corpus has TWO ERAS, and only one of them is a fair comparison.**
   *
   * Ian's span-based start-anchor rule shipped on **2026-08-20** (`shift-boundaries.ts:191-198`).
   * Sessions written before it were computed by the OLD rule — *"the old rule floored every tap DOWN
   * to the preceding allowed start"* — and carry no `startAnchorMode` at all; v1's own type says
   * *"Absent on sessions written before 2026-08-20; treat as 'previous'."*
   *
   * **357 of the 550 captured sessions predate it.** Comparing v2's anchor against those would be
   * comparing it to a rule Ian deliberately replaced — and v2 AGREEING with them would be the bug.
   * So the assertion runs on the 193 sessions computed under the current rule, and the older era is
   * reported separately as context rather than silently dropped.
   */
  const ANCHOR_RULE_SHIPPED = '2026-08-20';

  it.runIf(present)('the corpus is real, and its two eras are named', () => {
    expect(specimens.length).toBeGreaterThan(0);
    const post = specimens.filter((s) => s.sessionDate >= ANCHOR_RULE_SHIPPED);
    const pre = specimens.length - post.length;
    console.log(
      `golden corpus: ${specimens.length} sessions — ${post.length} under the current anchor rule, ` +
        `${pre} under the pre-${ANCHOR_RULE_SHIPPED} rule (reported, not asserted).`,
    );
    expect(post.length).toBeGreaterThan(50);
  });

  it.runIf(present)('every divergence from v1 falls into a TRIAGED class', () => {
    const unexplained: string[] = [];
    const paysLess: string[] = [];
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };

    for (const s of specimens.filter((x) => x.sessionDate >= ANCHOR_RULE_SHIPPED)) {
      const day = parseShiftDay(s.sessionDate);
      const punches: DayPunch[] = [
        { occurredAt: new Date(s.rawClockInMs), intent: 'in', arrivalLagMs: 0 },
        { occurredAt: new Date(s.rawClockOutMs), intent: 'out', arrivalLagMs: 0 },
      ];
      const policy = toPolicy(s.config);
      const got = computeDay({ shiftDay: day, punches, policy });

      const v1Hours = s.expected.computedHours;
      const v2Hours = got.computedMinutes / 60;
      // ⚠️ Ian's minimum-day rule routes a sub-half-day stint entirely into PENDING overtime, so
      // comparing paid hours alone would report "5 hours less" for time that is not lost at all —
      // it is waiting for a manager. The honest comparison is everything v2 claims.
      const v2Total = (got.computedMinutes + got.pendingOtMinutes) / 60;
      const presentMinutes = (s.rawClockOutMs - s.rawClockInMs) / 60_000;
      const hoursDiffer = Math.abs(v1Hours - v2Hours) > 1e-9;
      const modeDiffers = got.anchorMode !== s.expected.startAnchorMode;
      const halfDayDiffers = got.isHalfDay !== s.expected.isHalfDay;
      const nightDiffers = Math.abs(got.nightDiffMinutes / 60 - s.expected.nightDiffHours) > 1e-9;

      /**
       * ⭐ **DEF-170 — the anchor HOUR, which is what the mode label is about.**
       *
       * `anchorMinute` is measured from the shift day's 05:00 start, so `+5` recovers the wall
       * clock hour. Compared against v1's own `shiftStartHour`, this separates the two things a
       * mode difference can mean, which the label alone conflates:
       *
       * - **Same anchor hour** — cosmetic. A punch at 14:59:32 rounds into the 15:00 start, so v2
       *   says `exact` where v1 said `next`. Identical anchor, identical pay basis.
       * - **Different anchor hour** — material. The day is credited from a different time.
       */
      const anchorHourV2 =
        got.anchorMinute == null ? null : (Math.floor(got.anchorMinute / 60) + SHIFT_DAY_START) % 24;
      const sameAnchorHour =
        s.expected.shiftStartHour !== null && anchorHourV2 === s.expected.shiftStartHour % 24;
      /**
       * ⛔ **The fix that closed DEF-170's compound cases.** The classes below carry strict
       * single-field signatures (`!modeDiffers && !hoursDiffer && …`), so a specimen with TWO
       * independent, individually-understood causes fell through every one of them and was reported
       * as unexplained. That is a limitation of the triage's shape, not a finding about the engine.
       *
       * A cosmetic relabel is not a divergence to explain, so it no longer blocks a class that
       * explains the *other* field. ⚠️ It is still counted (class C) rather than hidden.
       */
      const modeDiffersMaterially = modeDiffers && !sameAnchorHour;

      if (!hoursDiffer && !modeDiffers && !halfDayDiffers && !nightDiffers) { bump('identical'); continue; }

      // ── Class A — DEF-088. v1 credited far more than the person was present for. v2 is right.
      if (v1Hours * 60 > presentMinutes * 2) { bump('A: DEF-088 v1 over-credits presence'); continue; }

      // ── Class B — D5. Real-minute pay against v1's hour-floor. Sub-hour by construction.
      if (hoursDiffer && Math.abs(v1Hours - v2Hours) < 1) {
        bump('B: D5 sub-hour precision');
        // ⚠️ Surfaced separately: v2 paying LESS than v1 is the one direction that moves real
        // money against a real person, and it needs Ian rather than a passing test.
        if (v2Total < v1Hours) {
          paysLess.push(`${s.id}: v1 ${v1Hours}h -> v2 ${v2Total.toFixed(2)}h claimed (${Math.round((v1Hours - v2Total) * 60)}m less)`);
        }
        continue;
      }

      // ── Class E — ⭐ THE CONFIG CHANGED AFTER THESE SESSIONS WERE COMPUTED.
      //
      // Ian corrected every store's `allowedShiftStartHours` on 2026-08-29 ("whatever is set on v1
      // today is correct. i updated it just now"). The captured `config` is therefore TODAY's,
      // while every captured `expected` output was produced under the PREVIOUS one — so a session
      // v1 anchored at 18:00 is being replayed against a grid that no longer contains 18:00.
      //
      // ⚠️ **This is the same two-era problem as the 2026-08-20 anchor rule, and it is detected
      // exactly rather than assumed:** v1's own `shiftStartHour` is checked against the CURRENT
      // allowed hours, and a session whose anchor is no longer an allowed start cannot be a fair
      // comparison — v2 agreeing with it would mean v2 was ignoring the corrected config.
      const currentHours = Array.isArray(s.config.allowedShiftStartHours)
        ? (s.config.allowedShiftStartHours as number[])
        : [...V1_DEFAULTS.allowedShiftStartHours];
      if (
        s.expected.shiftStartHour !== null &&
        !currentHours.includes(s.expected.shiftStartHour % 24)
      ) {
        bump('E: v1 anchor is no longer an allowed start (config corrected)');
        continue;
      }

      // ── Class H — ⭐ NIGHT-DIFF WAS ON WHEN THIS SESSION RAN. DEF-170.
      //
      // Same family as Class E — `attendanceConfig` is a single live, unversioned document per
      // store, so today's capture pairs a historical session's stored result with TODAY's config.
      // `session-hours.ts`'s own formula is `config.nightDiffEnabled === false ? 0 : nightDiffHoursInWindow(...)`
      // — verified byte-for-byte identical to `nightDiffMinutes` above — so v1 could only have
      // credited real night-diff hours if the flag was TRUE at the time. Every store's captured
      // config today reads `nightDiffEnabled: false`; nothing else about the specimen differs.
      if (
        nightDiffers && !hoursDiffer && !modeDiffersMaterially && !halfDayDiffers &&
        !policy.nightDiffEnabled && s.expected.nightDiffHours > 0
      ) {
        bump('H: nightDiffEnabled was on when this session ran (DEF-170, config drift)');
        continue;
      }

      // ── Class I — ⭐ requiredHoursPerShift WAS SMALLER WHEN THIS SESSION RAN. DEF-170.
      //
      // Same family as E and H. v1 caps `computedHours` at `config.requiredHoursPerShift` — verified
      // identical to v2's `Math.min(rawHours, requiredMinutes)` cap. v2 hits exactly TODAY's cap;
      // v1's stored answer is smaller; and there was enough raw presence to have been capped at
      // v2's value too — the only way v1 lands lower is a smaller cap in force back then. Malvar and
      // Banay-Banay's captured `requiredHoursPerShift` reads `10` today.
      const requiredHoursV2 = policy.requiredMinutes / 60;
      if (
        hoursDiffer && !modeDiffersMaterially && !halfDayDiffers && !nightDiffers &&
        Math.abs(v2Hours - requiredHoursV2) < 1e-9 &&
        v1Hours < v2Hours &&
        presentMinutes / 60 >= v2Hours
      ) {
        bump('I: requiredHoursPerShift was smaller when this session ran (DEF-170, config drift)');
        continue;
      }

      // ── Class D — T-157b. v2 anchored to the punch's OWN hour because it is beyond
      // `anchorWindowMinutes` from any allowed start. ⭐ Against a full hourly grid this class is
      // EMPTY by construction (30 minutes is the maximum possible distance); every member of it
      // exists because Lipa's stored grid has no 12, 13 or 14. **This class is DEF-087 showing
      // itself as pay** — the staff were not off-schedule, the config is stale.
      if (got.anchorMode === 'unallowed' && s.expected.startAnchorMode !== 'unallowed') {
        bump('D: beyond the window on a STALE grid (DEF-087)');
        if (v2Total < v1Hours) {
          paysLess.push(`${s.id}: v1 ${v1Hours}h -> v2 ${v2Total.toFixed(2)}h claimed (${Math.round((v1Hours - v2Total) * 60)}m less) [stale grid]`);
        }
        continue;
      }

      // ── Class J — ⭐ THE MIRROR OF CLASS D, AND THE LAST UNEXPLAINED SPECIMEN. DEF-170.
      //
      // Class D covers v2 refusing to anchor where v1 did. **This is the other direction**: v1
      // recorded `unallowed` with a null `shiftStartHour` and raised `shift_start_not_allowed`,
      // while v2 anchored successfully — because `anchorWindowMinutes` is a v2-only setting with no
      // v1 equivalent (see `toPolicy`'s own note). v1 demanded an exact grid hit; v2 treats a punch
      // within 30 minutes of an allowed hour as aiming for it.
      //
      // ⛔ **This is not v2 being lax — it is v2 declining to send a payroll question to a human
      // for a data-entry problem.** `lipa-0359` punched in at 06:40:43 against a grid whose first
      // allowed hour is 07:00: twenty minutes early, on a stale grid (DEF-087). v1 could not anchor
      // it, credited the full 9h cap, and flagged the day `needs_review`. v2 anchors 07:00, credits
      // 8h of real presence, and — by Ian's OWN `shortShiftHalfDayOt` rule, which this store has ON
      // — books 5h as a half day and raises the remaining 3h as PENDING overtime.
      //
      // ⚠️ **So it pays less on the automatic path and it is surfaced by name below.** Nothing is
      // taken from the staffer: the 3h is waiting for a manager rather than gone. But v1 paid 9h
      // outright for 8.43h of presence, and that is the comparison Ian needs to see rather than a
      // count — which is why this class reports into `paysLess` exactly as B, D, F and G do.
      if (
        s.expected.startAnchorMode === 'unallowed' &&
        s.expected.shiftStartHour === null &&
        got.anchorMode !== 'unallowed'
      ) {
        bump('J: v1 could not anchor on a stale grid; v2 anchored within the window (DEF-087)');
        if (v2Total < v1Hours) {
          paysLess.push(
            `${s.id}: v1 ${v1Hours}h -> v2 ${v2Total.toFixed(2)}h claimed (${Math.round((v1Hours - v2Total) * 60)}m less) [v1 could not anchor]`,
          );
        }
        continue;
      }

      // ── Class C — a mode RELABEL with identical pay. A punch at 14:59:30 rounds into the 15:00
      // start, so v2 calls it `exact` where v1 called it `next`. Same anchor, same hours, same
      // lateness: cosmetic.
      if (modeDiffers && !hoursDiffer && !halfDayDiffers && !nightDiffers) { bump('C: mode relabel, pay identical'); continue; }

      // ── Class G — ⭐ Ian's MINIMUM-DAY rule (2026-08-29). v1 credited a sub-half-day stint as
      // pay; v2 credits no day at all and routes the whole thing into PENDING overtime a manager
      // must accept. *"that must be not counted at all min half day 5 hours, 1><5 hour record as
      // unverified OT to be accepted by manager."*
      //
      // ⚠️ Nothing is lost to the staffer here — the time moves from automatic pay to approved
      // overtime. It is a separate class from B precisely so that is legible rather than looking
      // like a pay cut.
      if (got.computedMinutes === 0 && got.pendingOtMinutes > 0 && v1Hours > 0) {
        bump('G: under the half day — no day, raised as unverified OT');
        if (v2Total < v1Hours) {
          paysLess.push(
            `${s.id}: v1 ${v1Hours}h -> v2 ${v2Total.toFixed(2)}h claimed (${Math.round((v1Hours - v2Total) * 60)}m less) [minimum-day]`,
          );
        }
        continue;
      }

      // ── Class F — ⭐ nearest-hour chose a LATER anchor than v1's floor-to-previous, and the pay
      // moved with it. This is the intended consequence of Ian's "nearest hour" (T-157b §1): a
      // 13:45 punch was aiming for 14:00, not 13:00, so it is credited from 14:00 — which is more
      // accurate and, on a short day, can drop it under the half-day bar.
      //
      // ⚠️ It is separated from class C (relabel, pay identical) precisely BECAUSE the pay moves,
      // and any member that pays LESS is surfaced by name below rather than absorbed into a count.
      if (modeDiffers && got.anchorMode === 'next' && s.expected.startAnchorMode === 'previous') {
        bump('F: nearest-hour anchored later than v1 (pay moved)');
        if (v2Total < v1Hours) {
          paysLess.push(
            `${s.id}: v1 ${v1Hours}h -> v2 ${v2Total.toFixed(2)}h claimed (${Math.round((v1Hours - v2Total) * 60)}m less) [nearest-hour]`,
          );
        }
        continue;
      }

      unexplained.push(
        `${s.id}: hours v1=${v1Hours} v2=${v2Hours.toFixed(3)} | mode v1=${s.expected.startAnchorMode} v2=${got.anchorMode} | halfDay v1=${s.expected.isHalfDay} v2=${got.isHalfDay} | night v1=${s.expected.nightDiffHours} v2=${(got.nightDiffMinutes / 60).toFixed(2)} | present=${presentMinutes.toFixed(1)}m`,
      );
    }

    const summary = Object.entries(counts).sort().map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`);
    // ⚠️ The label used to read "...of class B". It has not been B-only for some time — the list
    // aggregates every class that surfaces movement (B, D, F, G and now J), and each entry is
    // tagged with its own cause. A heading that names one class invites reading the rest as B.
    console.log(['golden triage:', ...summary, `  ${String(paysLess.length).padStart(4)}  ...v2 claims LESS than v1 (needs Ian; cause tagged per row):`, ...paysLess.map((p) => `        ${p}`)].join(String.fromCharCode(10)));

    // ⛔ Only an UNTRIAGED divergence fails. A class that has been reasoned about and recorded is
    // knowledge; an unexplained one is a bug nobody has looked at yet.
    expect(unexplained, [`${unexplained.length} untriaged divergence(s):`, ...unexplained].join(String.fromCharCode(10))).toEqual([]);
  });
});
