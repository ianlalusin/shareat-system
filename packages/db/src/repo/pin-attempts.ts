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

/** T-395 R2: tier 2, a rolling daily budget of wrong PINs per store. */
export const DAILY_MISS_BUDGET = 50;
export const DAILY_WINDOW_HOURS = 24;
/** T-395 R4 / Q1: null = a stop lasts until a manager reopens it; option b sets 60. */
export const STOP_AUTO_REOPEN_MINUTES: number | null = null;
/** T-395 R11: rows older than this are purged lazily, 500 per charge. */
export const ATTEMPT_RETENTION_DAYS = 90;
const PURGE_BATCH = 500;

/** Raw `tx.execute` returns timestamptz as text (drizzle's column mapping does not apply). */
function toDate(v: Date | string | null | undefined): Date | null {
  return v == null ? null : new Date(v);
}

type ReopenOpts = { stopAutoReopenMinutes?: number | null };

function autoReopen(opts: ReopenOpts): number | null {
  return opts.stopAutoReopenMinutes === undefined ? STOP_AUTO_REOPEN_MINUTES : opts.stopAutoReopenMinutes;
}

// checkThrottle / statusForStore (the read-only panel status) arrive with S2's caller, the Staff
// panel: the production-caller ratchet refuses a function nothing calls.

export type Charge =
  | { refused: 'stopped' | 'locked'; until: Date | null }
  | { refused: null; missId: string; lockoutId: string | null };

/**
 * T-395 R14 / invariant I12 - charge every attempt BEFORE the credential lookup, in ONE
 * transaction, under the store's throttle-row lock. Step order is fixed:
 *   1 lock, 2 stop check, 3 pause check, 4 charge, 5 purge.
 * Step 1 serialises every attempt for the store, so each later statement sees every earlier
 * attempt's committed rows and the bounds are exact (10 per tier-1 window, 50 per tier-2 window).
 * Callers must COMMIT this transaction before running the lookup, and must run it under
 * `withOrgPrincipal(orgId, ...)`, never the auth door.
 *
 * Advances identically whether the PIN is later found unknown or belonging to someone else
 * (T-303 invariant 2, T-395 I5): the charge happens before anything is known about the PIN.
 */
export async function chargeAttempt(
  tx: Tx,
  input: { orgId: string; storeId: string; deviceId: string | null },
  opts: ReopenOpts = {},
): Promise<Charge> {
  const { orgId, storeId, deviceId } = input;
  const auto = autoReopen(opts);

  // 1. LOCK. A no-op update on conflict still takes the row lock until commit.
  const locked = (await tx.execute(sql`
    insert into pin_attempt_throttle (org_id, store_id)
    values (${orgId}, ${storeId})
    on conflict (store_id) do update set updated_at = pin_attempt_throttle.updated_at
    returning
      locked_until as "lockedUntil",
      (locked_until is not null and locked_until > now()) as "pauseLive",
      (stopped_at is not null and (${auto}::int is null or stopped_at + make_interval(mins => ${auto}::int) > now())) as "stopLive"
  `)) as unknown as Array<{ lockedUntil: Date | string | null; pauseLive: boolean; stopLive: boolean }>;
  const state = locked[0]!; // an upsert with RETURNING always yields the row

  // 2. STOP CHECK.
  if (state.stopLive) return { refused: 'stopped', until: null };
  const counted = (await tx.execute(sql`
    select count(*)::int as n
      from sign_in_attempts a, pin_attempt_throttle t
     where t.store_id = ${storeId}
       and a.store_id = ${storeId}
       and a.kind = 'miss'
       and a.occurred_at > greatest(
             now() - make_interval(hours => ${DAILY_WINDOW_HOURS}),
             coalesce(t.reopened_at, '-infinity'::timestamptz),
             coalesce(
               case when ${auto}::int is not null then t.stopped_at + make_interval(mins => ${auto}::int) end,
               '-infinity'::timestamptz))
  `)) as unknown as Array<{ n: number }>;
  if ((counted[0]?.n ?? 0) >= DAILY_MISS_BUDGET) {
    await tx.execute(
      sql`update pin_attempt_throttle set stopped_at = now(), updated_at = now() where store_id = ${storeId}`,
    );
    await tx.execute(sql`
      insert into sign_in_attempts (org_id, store_id, device_id, kind)
      values (${orgId}, ${storeId}, ${deviceId}::uuid, 'stopped')
    `);
    return { refused: 'stopped', until: null };
  }

  // 3. PAUSE CHECK (T-303's lock-clobber rule: a refused attempt writes nothing).
  if (state.pauseLive) return { refused: 'locked', until: toDate(state.lockedUntil) };

  // 4. CHARGE - the tier-1 increment exactly as T-303's recordMiss did it.
  const bumped = (await tx.execute(sql`
    update pin_attempt_throttle set
      fail_count = case
        when now() - window_started_at < make_interval(secs => ${MISS_WINDOW_SECONDS}) then fail_count + 1
        else 1
      end,
      window_started_at = case
        when now() - window_started_at < make_interval(secs => ${MISS_WINDOW_SECONDS}) then window_started_at
        else now()
      end,
      locked_until = case
        when (case
          when now() - window_started_at < make_interval(secs => ${MISS_WINDOW_SECONDS}) then fail_count + 1
          else 1
        end) >= ${MISS_THRESHOLD}
          then now() + make_interval(secs => ${LOCK_COOLDOWN_SECONDS})
        else null
      end,
      updated_at = now()
    where store_id = ${storeId}
    returning (locked_until is not null) as "startedPause"
  `)) as unknown as Array<{ startedPause: boolean }>;
  const miss = (await tx.execute(sql`
    insert into sign_in_attempts (org_id, store_id, device_id, kind)
    values (${orgId}, ${storeId}, ${deviceId}::uuid, 'miss')
    returning id
  `)) as unknown as Array<{ id: string }>;
  let lockoutId: string | null = null;
  if (bumped[0]?.startedPause) {
    const lockout = (await tx.execute(sql`
      insert into sign_in_attempts (org_id, store_id, device_id, kind)
      values (${orgId}, ${storeId}, ${deviceId}::uuid, 'lockout')
      returning id
    `)) as unknown as Array<{ id: string }>;
    lockoutId = lockout[0]!.id; // INSERT ... RETURNING always yields the row
  }

  // 5. PURGE, bounded: this org's rows past retention, 500 per charge, skipping rows others hold.
  // MATERIALIZED: a plain `id in (select ... limit ... for update)` can be re-planned as a semi-join
  // that re-evaluates the LIMIT per outer row and deletes far more than one batch.
  await tx.execute(sql`
    with batch as materialized (
      select id from sign_in_attempts
       where org_id = ${orgId} and occurred_at < now() - make_interval(days => ${ATTEMPT_RETENTION_DAYS})
       limit ${PURGE_BATCH}
       for update skip locked)
    delete from sign_in_attempts where id in (select id from batch)
  `);

  return { refused: null, missId: miss[0]!.id, lockoutId }; // INSERT ... RETURNING always yields the row
}

/**
 * A correct PIN refunds ONLY its own charge (R3, R14): its miss row, and the lockout row its
 * charge wrote if any. Then tier 1 is cleared as before. Never touches another attempt's rows or
 * stopped_at.
 */
export async function refundOnSuccess(
  tx: Tx,
  storeId: string,
  charge: { missId: string; lockoutId: string | null },
): Promise<void> {
  const ids = charge.lockoutId ? [charge.missId, charge.lockoutId] : [charge.missId];
  await tx.execute(sql`
    delete from sign_in_attempts
     where store_id = ${storeId} and id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  await clearOnSuccess(tx, storeId);
}

/**
 * A manager reopens a stopped store. Not stopped: returns { reopened: false } and writes nothing.
 * Clears tier 1 too, so the first attempt after a reopen is not paused by stale counters.
 */
export async function reopen(
  tx: Tx,
  storeId: string,
  actorPersonId: string,
): Promise<{ reopened: boolean; stoppedAt: Date | null }> {
  const rows = (await tx.execute(sql`
    update pin_attempt_throttle t set
      stopped_at = null, reopened_at = now(), reopened_by = ${actorPersonId}::uuid,
      fail_count = 0, window_started_at = null, locked_until = null, updated_at = now()
    from (select stopped_at from pin_attempt_throttle where store_id = ${storeId} and stopped_at is not null for update) old
    where t.store_id = ${storeId} and t.stopped_at is not null
    returning old.stopped_at as "stoppedAt"
  `)) as unknown as Array<{ stoppedAt: Date | string | null }>;
  return rows[0] ? { reopened: true, stoppedAt: toDate(rows[0].stoppedAt) } : { reopened: false, stoppedAt: null };
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
