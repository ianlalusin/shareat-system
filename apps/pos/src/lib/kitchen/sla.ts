/**
 * Kitchen serve-time service level.
 *
 * A ticket is "late" once its order → serve lapse passes this. Lives in a plain
 * module (not the `"use client"` KDS card that first defined it) so pure logic —
 * the session timeline's serve-time summary, for one — can import it too.
 *
 * Note the lapse this grades is order → serve, never prepare → serve: the KDS
 * writes `preparedAt` at the same instant as `servedAt`, so there is no separate
 * prep segment to measure.
 */
export const DEFAULT_SLA_MINUTES = 10;

export const DEFAULT_SLA_MS = DEFAULT_SLA_MINUTES * 60_000;

/** `null`/unknown lapses are never late — absence of data is not a breach. */
export function isServeLate(lapseMs: number | null | undefined): boolean {
  return typeof lapseMs === "number" && Number.isFinite(lapseMs) && lapseMs >= DEFAULT_SLA_MS;
}

/** Twice the SLA — the "this needs explaining" threshold. */
export function isServeVeryLate(lapseMs: number | null | undefined): boolean {
  return typeof lapseMs === "number" && Number.isFinite(lapseMs) && lapseMs >= DEFAULT_SLA_MS * 2;
}
