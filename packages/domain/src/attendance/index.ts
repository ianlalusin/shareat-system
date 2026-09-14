/**
 * Attendance — the shift-day calendar and the store policy that governs a day.
 * Phase 4, lane B. `docs/plans/phase-4-attendance.md`.
 *
 * The punch model (T-156), the adjudication engine (T-157) and manager adjustments (T-158) land
 * here too. Nothing in this module posts to the ledger — attendance touches money only through
 * payroll, in Phase 5, which is what makes Phase 4 a genuinely parallel track.
 */
export * from './shift-day';
export * from './config';
export * from './punches';
export * from './compute-day';
export * from './adjudicate';
export * from './adjustments';
export * from './review';
export * from './sweep';
export * from './terminals';
export * from './credentials';
// ⭐ T-314 slice A. Added by the orchestrator at integration, not by the lane (shared barrel).
// ⚠️ This is the SERVER reach — enrolment gets the fingerprint logic through `@shareat/domain`
// like everything else here. The CLOCK TERMINAL is a client path and must NOT come this way:
// it imports `@shareat/domain/attendance/fingerprint`, the DB-free leaf, because this barrel
// re-exports modules that pull `@shareat/db` behind them (T-266). The leaf's own header says so.
export * from './fingerprint';
