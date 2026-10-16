/**
 * T-424 audit - what a failed `session-voids` call means for the queued loyalty reversal (decided in the void dialog).
 *   'voided'  : the void already happened (409 "already voided"): keep the reversal, let it replay.
 *   'refused' : the server definitely said no (a 4xx other than the above): nothing was voided, take the queued reversal back out.
 *   'unknown' : no answer (status 0), a 5xx, or anything else: the void may have committed, so KEEP the reversal (the replay checks the session first).
 */
export const ALREADY_VOIDED = "That table was already voided.";

export function voidOutcome(err: { status?: unknown; message?: unknown } | null | undefined): "voided" | "refused" | "unknown" {
  const status = typeof err?.status === "number" ? err.status : -1;
  if (status === 409 && String(err?.message ?? "") === ALREADY_VOIDED) return "voided";
  if (status >= 400 && status < 500) return "refused";
  return "unknown";
}
