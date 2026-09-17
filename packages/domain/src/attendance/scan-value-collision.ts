/**
 * T-321/DEF-363/DEF-362 — recognising a scan-value collision from a raw Postgres error. A pure
 * predicate with no dependency on anything in `credentials.ts` — it never belonged there except by
 * convenience, and `callers.mjs` said so: with only one call site it would have been `test-only`
 * and failed the gate; with two it survived on a technicality. This module is the real boundary.
 */
import { ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE } from '@shareat/db/schema';

const UNIQUE_VIOLATION = '23505';

/**
 * ⛔⛔ Matched by Postgres error CODE + constraint name read off the error object, never by
 * `String(error).includes(...)`. A string search on the new name alone fails open against any
 * database not yet past migration 0153 — measured independently by the tester, the auditor, and
 * `/code-review`: `shareat_dev` is in exactly that state right now, and so is every environment
 * mid-rollback (`.github/workflows/deploy.yml` keeps the last 3 releases specifically so a
 * rollback can land NEW schema behind OLD code) or simply not yet migrated. In either case the
 * violation still names one of the two legacy per-column indexes, this `Set` would otherwise miss
 * it, and a raw `PostgresError` escapes the domain — the exact DEF-362 shape, on the one path
 * (`enrolCard`) that used to do it right.
 *
 * ⚠️ The two legacy names are a TRANSITION, not a permanent feature — remove them once every
 * environment (dev, every developer machine, production) is confirmed past 0153, so they do not
 * become cruft nobody dares delete.
 *
 * ⛔ Kept module-private, along with `UNIQUE_VIOLATION` — only `isScanValueCollision` below is
 * exported. A test that could import this `Set` directly would pass whatever the `Set` contained,
 * including after someone deletes a legacy name, which is precisely the regression it exists to
 * catch. Its own name is imported from `@shareat/db/schema` — the ONE place it is defined
 * (Contract 6) — never typed here as a literal.
 */
const SCAN_VALUE_UNIQUE_CONSTRAINTS = new Set<string>([
  ATTENDANCE_CREDENTIALS_SCAN_VALUE_LIVE_UNIQUE,
  'attendance_credentials_card_live_unique',
  'attendance_credentials_token_live_unique',
]);

export function isScanValueCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  // ⚠️ Not a bare `code === '23505'` match — if this table ever gains another unique constraint,
  // that would hand its violation this credential-specific message too. The constraint name is
  // what narrows it to the one index this catch is written for.
  const { code, constraint_name: constraintName } = error as {
    code?: unknown;
    constraint_name?: unknown;
  };
  return (
    code === UNIQUE_VIOLATION &&
    typeof constraintName === 'string' &&
    SCAN_VALUE_UNIQUE_CONSTRAINTS.has(constraintName)
  );
}
