/**
 * pin_attempt_throttle — check/record/clear. docs/tasks/303-pin-attempt-lockout.md §THE DESIGN.
 *
 * ⛔ Ported from v1's Firestore throttle (`ERP-rebuild/src/lib/actions/attendance-clock.actions.ts:
 * 440-512`), not rediscovered — in particular the concurrency lock-clobber fix: once
 * `locked_until` is in the future, a miss must leave the row untouched rather than resetting the
 * window. Here that is the `ON CONFLICT ... DO UPDATE ... WHERE` guard below, not an
 * application-level `if`, so it holds under real concurrent writers rather than a
 * read-then-write race.
 */
import { and, eq, gt, or, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { pinAttemptThrottle } from '../../schema/pin-attempts';

/** Ian's ruling, T-303 §Tuning: v1's proven threshold and window, a cooldown between v1's 60s
 *  and Ian's first-instinct 5 minutes. One named block, not scattered — this is the part most
 *  likely to be re-tuned from operational experience, exactly as v1's were. */
export const MISS_THRESHOLD = 10;
export const MISS_WINDOW_SECONDS = 60;
export const LOCK_COOLDOWN_SECONDS = 120;

export interface ThrottleStatus {
  locked: boolean;
  lockedUntil: Date | null;
}

/**
 * ⭐ **Checked BEFORE the credential lookup, always** — v1's C-7 rule, ported: a locked store
 * costs one indexed read and no scrypt. Callers must run this under `withOrgPrincipal(orgId, …)`,
 * never the auth door — the whole reason this table classifies `org_column` rather than
 * `system_only` (T-303 §Q2) is that the org is already known by the time this runs.
 */
export async function checkThrottle(tx: Tx, storeId: string): Promise<ThrottleStatus> {
  // ⛔ One clock — bible T-218's standing rule. "Locked" is decided in SQL, against Postgres's own
  // `now()`, never by comparing a fetched timestamp against `Date.now()` in JavaScript afterward;
  // the two can disagree, and disagreeing here means either an early or a late unlock.
  const [row] = await tx
    .select({
      lockedUntil: pinAttemptThrottle.lockedUntil,
      locked: sql<boolean>`${pinAttemptThrottle.lockedUntil} is not null and ${pinAttemptThrottle.lockedUntil} > now()`,
    })
    .from(pinAttemptThrottle)
    .where(eq(pinAttemptThrottle.storeId, storeId))
    .limit(1);
  return { locked: row?.locked ?? false, lockedUntil: row?.lockedUntil ?? null };
}

/**
 * Records one miss. Advances identically whether the PIN was unknown or belonged to someone else
 * — T-303 invariant 2, so the lockout timing is never the oracle the flat sentence refuses to be.
 *
 * One statement, so concurrent misses count (T-303 test 3c) and the lock-clobber guard (test 3b)
 * is enforced by Postgres rather than by a race-prone read-then-write in this function.
 */
export async function recordMiss(tx: Tx, orgId: string, storeId: string): Promise<void> {
  await tx.execute(sql`
    insert into pin_attempt_throttle (org_id, store_id, fail_count, window_started_at, locked_until, updated_at)
    values (${orgId}, ${storeId}, 1, now(), null, now())
    on conflict (store_id) do update set
      fail_count = case
        when now() - pin_attempt_throttle.window_started_at < make_interval(secs => ${MISS_WINDOW_SECONDS})
          then pin_attempt_throttle.fail_count + 1
        else 1
      end,
      window_started_at = case
        when now() - pin_attempt_throttle.window_started_at < make_interval(secs => ${MISS_WINDOW_SECONDS})
          then pin_attempt_throttle.window_started_at
        else now()
      end,
      locked_until = case
        when (case
          when now() - pin_attempt_throttle.window_started_at < make_interval(secs => ${MISS_WINDOW_SECONDS})
            then pin_attempt_throttle.fail_count + 1
          else 1
        end) >= ${MISS_THRESHOLD}
          then now() + make_interval(secs => ${LOCK_COOLDOWN_SECONDS})
        else null
      end,
      updated_at = now()
    where pin_attempt_throttle.locked_until is null or pin_attempt_throttle.locked_until <= now()
  `);
}

/**
 * Clears the counter on a successful PIN. v1's `hadMisses` trick, ported: the `WHERE` guard skips
 * the write entirely when there is nothing to clear, so the ordinary hot path (a correct PIN,
 * first try) touches no row.
 */
export async function clearOnSuccess(tx: Tx, storeId: string): Promise<void> {
  await tx
    .update(pinAttemptThrottle)
    .set({ failCount: 0, windowStartedAt: null, lockedUntil: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(pinAttemptThrottle.storeId, storeId),
        or(gt(pinAttemptThrottle.failCount, 0), sql`${pinAttemptThrottle.lockedUntil} is not null`),
      ),
    );
}
