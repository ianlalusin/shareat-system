import 'server-only';
/** T-424 - JSON responses and the small validation helpers every POS v2 route shares. */

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { ok: false, error, ...extra });
}

export const UNEXPECTED_ERROR = 'Something went wrong on the POS server. Nothing was changed. Try again, and tell a manager if it keeps happening.';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_SHAPE.test(v);

export const isNonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A business refusal: thrown from a handler or a transaction callback, answered once as `status` with `message`. */
export class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

/** Runs a handler body and answers any Refusal as its status; anything else is logged (no body, no PIN) and answered as 500. */
export async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Refusal) return fail(err.status, err.message);
    // A create() that lost a race (the receipt number, or the concurrency slot): another device wrote first. Nothing of ours was committed.
    const e = err as { code?: unknown; message?: unknown } | null;
    if (e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e.message ?? '')))) {
      return fail(409, 'Another device just changed this receipt. Check the receipt and try again.');
    }
    console.error('[pos2] unexpected error', err instanceof Error ? `${err.name}: ${err.message}` : 'non-error thrown');
    return fail(500, UNEXPECTED_ERROR);
  }
}

/** Canonical JSON (sorted keys) then sha256 hex: the "same request" test for an idempotent retry. The caller leaves out the PIN. */
export async function bodyHash(value: unknown): Promise<string> {
  const { createHash } = await import('node:crypto');
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}
