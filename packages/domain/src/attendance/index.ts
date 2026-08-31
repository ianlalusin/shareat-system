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
