# Attendance
## Overview
Phase 4 attendance domain: the 05:00-to-05:00 shift-day calendar, per-store attendance policy, raw punch recording, the single day-pay resolver (`computeDay`/`adjudicateDay`), manager adjustments, the review screen's read side, the open-day sweep, clock terminals and credentials. Attendance never posts to the ledger; it reaches money only through payroll.
## Interface
- `shift-day.ts`: `SHIFT_DAY_START_HOUR`, types `ShiftDay`/`RawShiftDay`, `toShiftDay`, `parseShiftDay`, `shiftDayRange`, `addShiftDays`, `shiftDayOffsetMsForHour`.
- `config.ts` / `config-input.ts`: `AttendanceConfigError`, `getLiveConfig`, `getConfigForShiftDay`, `supersedeConfig`, `seedAttendanceConfig`, types `ConfigChanges`/`NumericConfigKeys`/`ParsedConfigChanges`/`ConfigChangesInput`, `parseConfigChanges`.
- `punches.ts`: `PunchError`, `LATE_ARRIVAL_THRESHOLD_MS`, `recordPunch`, `arrivalLag`, `listPunchesForDay`, types `RecordPunchInput`/`RecordPunchResult`.
- `compute-day.ts` (pure): `computeDay`, `resolveStartAnchor`, `paidEndMinute`, `roundOvertimeMinutes`, `nightDiffMinutesInWindow`, `MAX_CREDIT_TO_PRESENCE_RATIO`, `MINIMUM_CREDITABLE_MINUTES`, types `AnchorMode`/`Anomaly`/`DayPolicy`/`DayPunch`/`DayAdjustments`/`DayComputation`/`StartAnchor`.
- `adjudicate.ts`: `AdjudicationError`, `isBlockingAnomaly`, `policyFromConfig`, `adjudicateDay`, `adjudicateRange`, `toDayAdjustments`, type `AdjudicateInput`.
- `adjustments.ts`: `AdjustmentError`, `recordAdjustment`, `listAdjustments`, `isStartDecisionMaterial`, type `RecordAdjustmentInput`.
- `review.ts`: `REVIEW_REASON_TEXT`, `attendanceReviewQueue`, `attendanceRoster`, `attendanceDayDetail`, type `DayReviewDetail` (re-exports `QueuedDay`/`ReviewDayRow`/`ReviewReason`).
- `today-state.ts`: `todayStateFor`, types `LiveState`/`TodayStateEntry`/`TodayState`.
- `sweep.ts`: `MIN_OPEN_MINUTES`, `verdictFor` (pure), `minutesSinceCutoff`, `sweepStore`, types `SweepPolicy`/`OpenDayFacts`/`SweepVerdict`/`SweptDay`.
- `terminals.ts`: `TerminalError`, `TerminalIdentityDriver`, `provisionTerminal`, `mintTerminalToken`, `activateTerminal`, `revokeTerminal`, `listTerminals`, `isReady`.
- `credentials.ts`: `CredentialError`, `MAX_TEMPLATES`, `summarise`, `enrolCard`, `enrolFingerprint`, `revokeCredential`, `listCredentials`, type `CredentialSummary`.
- `scan-value-collision.ts`: `isScanValueCollision` (not in the barrel).
- `index.ts`: barrel for all of the above except `scan-value-collision.ts`; also re-exports `./fingerprint`.
- [./fingerprint/README.md](./fingerprint/README.md) (DB-free leaf; clock-terminal clients import `@shareat/domain/attendance/fingerprint`, not this barrel)
## Invariants
- `ShiftDay` is a separate brand from `BusinessDate`; the 05:00 cut lives here, not in `@shareat/core/datetime`.
- `shift_day` is computed on write by `toShiftDay`, never re-derived at read time.
- `recordPunch` is the only writer of `attendance_punches`; the store is derived from the employment; a replay (`alreadyProcessed: true`) is a success, not an error; no `authorize()` by design.
- `computeDay` is the one resolver of day pay: pure, integer minutes (no floats), minutes measured from the shift day's 05:00 start. Everything calls `adjudicateDay`; nothing else recomputes.
- A day is judged by the config in force on that shift day (`getConfigForShiftDay`); never substitute the live config for a missing historical one.
- `isBlockingAnomaly`: `start_not_allowed` and `half_day_near_full` are advisory; the listed blocking anomalies hold a day out of pay.
- `recordAdjustment` supersedes the live decision of the same kind and re-adjudicates the day in the same transaction; it requires `manage_attendance` and refuses missing, cross-org or unmanageable employments with one uniform `AuthorizationError`.
- Original punches are never rewritten; review reads are `manage_attendance`-gated and read-only.
- `sweepStore` writes no punch (never invents a clock-out), uses the caller's `nowMs` not the DB clock, and has no `authorize()`/`Actor` (system principal).
- Credentials: no function returns a raw fingerprint template; `MAX_TEMPLATES` is 2; scan-value collisions are matched by Postgres code plus constraint name.
## Side Effects
- DB writes through `@shareat/db` repos on the caller's `Tx`: punches, attendance days, adjustments, store attendance config, clock terminals, credentials; `sweepStore` and parts of `config.ts` also run raw SQL.
- `recordPrerequisiteRefusal` (credentials.ts) opens an independent transaction via `withOrgPrincipal`, committing even if the caller's transaction aborts.
- Reads the clock/env: `new Date()` defaults in `toShiftDay`/`todayStateFor`; `randomBytes` in `credentials.ts`; logger output.
- Terminal provisioning calls the injected `TerminalIdentityDriver` (network, supplied by `packages/sync-firestore`). No ledger posting.
## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
