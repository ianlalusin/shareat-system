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
/**
 * T-416 (DEF-653): administrator-PIN approvals are charged to the PERSON typing them, never to a store or the org.
 * 5 wrong per person in a rolling 24 h; the cap auto-lifts 24 h after it tripped, or when an administrator clears it.
 * TRIPWIRE: tier 1 (MISS_THRESHOLD 10 per 60 s) never fires for an actor bucket because step 2's daily check (cap 5)
 * stops the bucket first, so no `lockout` row is written for it. If either number is re-tuned so tier 1 could fire
 * first, the "this terminal" pause sentence would be wrong for a person.
 */
export const APPROVAL_DAILY_MISS_CAP = 5;
export const APPROVAL_CAP_AUTO_LIFT_MINUTES = 1440;
/**
 * T-464: the per-Employee-ID bucket of a paired POS tablet. 5 wrong PINs for one Employee ID within 5 minutes pause THAT ID for 5 minutes;
 * a success clears it; an unknown code pauses the same. It has no daily budget (a stop would need a manager to reopen a code that may not exist).
 */
export const STAFF_CODE_MISS_THRESHOLD = 5;
export const STAFF_CODE_MISS_WINDOW_SECONDS = 300;
export const STAFF_CODE_LOCK_COOLDOWN_SECONDS = 300;
/** T-395 R11: rows older than this are purged lazily, 500 per charge. */
export const ATTEMPT_RETENTION_DAYS = 90;
const PURGE_BATCH = 500;

/** Raw `tx.execute` returns timestamptz as text (drizzle's column mapping does not apply). */
function toDate(v: Date | string | null | undefined): Date | null {
  return v == null ? null : new Date(v);
}

type ReopenOpts = { stopAutoReopenMinutes?: number | null; dailyMissBudget?: number };

/** T-416: a bucket is a store (sign-in), the organisation's own (0199), or a person (administrator-PIN approvals). */
export type Bucket = { store: string } | { org: true } | { actor: string } | { store: string; staffCode: string };

/** T-464: the key of a per-Employee-ID bucket, normalised so `se-007` and `SE-007` are one bucket. */
export const normaliseStaffCodeKey = (code: string): string => code.trim().toUpperCase();

function autoReopen(opts: ReopenOpts): number | null {
  return opts.stopAutoReopenMinutes === undefined ? STOP_AUTO_REOPEN_MINUTES : opts.stopAutoReopenMinutes;
}

// T-395 S2: statusForStore (below) is the Staff panel's read-only status; its caller is staff/page.tsx.

/** Row filter for one bucket. The org arm excludes actor rows, else the org bucket would count every person's misses. */
function bucketFilter(col: string, orgId: string, b: Bucket) {
  const c = sql.identifier(col);
  if ('staffCode' in b) return sql`${c}.store_id = ${b.store} and ${c}.staff_code = ${normaliseStaffCodeKey(b.staffCode)}`;
  if ('store' in b) return sql`${c}.store_id = ${b.store} and ${c}.staff_code is null`;
  if ('org' in b) return sql`${c}.org_id = ${orgId} and ${c}.store_id is null and ${c}.actor_person_id is null`;
  return sql`${c}.org_id = ${orgId} and ${c}.actor_person_id = ${b.actor}`;
}

/** ON CONFLICT target; the predicate must match the partial unique index exactly (else Postgres raises 42P10). */
function bucketConflict(b: Bucket) {
  if ('staffCode' in b) return sql`on conflict (store_id, staff_code) where staff_code is not null`;
  if ('store' in b) return sql`on conflict (store_id) where staff_code is null`;
  if ('org' in b) return sql`on conflict (org_id) where store_id is null and actor_person_id is null`;
  return sql`on conflict (org_id, actor_person_id) where actor_person_id is not null`;
}

export type Charge =
  /** `newlyStopped` (T-402 S2): this very attempt tripped the daily budget (not an already-stopped store). */
  | { refused: 'stopped' | 'locked'; until: Date | null; newlyStopped?: boolean }
  | { refused: null; missId: string; lockoutId: string | null; startedPause: boolean };

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
  /** `bucket` names the key. `storeId` is the pre-T-416 spelling (a store, or null = the organisation) and is ignored when `bucket` is given. */
  input: { orgId: string; deviceId: string | null; bucket?: Bucket; storeId?: string | null },
  opts: ReopenOpts = {},
): Promise<Charge> {
  const { orgId, deviceId } = input;
  const b: Bucket = input.bucket ?? (input.storeId ? { store: input.storeId } : { org: true });
  const storeId = 'store' in b ? b.store : null;
  const staffCode = 'staffCode' in b ? normaliseStaffCodeKey(b.staffCode) : null;
  const actorId = 'actor' in b ? b.actor : null;
  const auto = autoReopen(opts);
  // T-464: a per-Employee-ID bucket never trips the daily stop (Infinity is never reached by a count) and has its own tier-1 numbers.
  const budget = 'staffCode' in b ? Number.MAX_SAFE_INTEGER : (opts.dailyMissBudget ?? DAILY_MISS_BUDGET);
  const tier1 =
    'staffCode' in b
      ? { threshold: STAFF_CODE_MISS_THRESHOLD, windowSecs: STAFF_CODE_MISS_WINDOW_SECONDS, cooldownSecs: STAFF_CODE_LOCK_COOLDOWN_SECONDS }
      : { threshold: MISS_THRESHOLD, windowSecs: MISS_WINDOW_SECONDS, cooldownSecs: LOCK_COOLDOWN_SECONDS };
  const bucket = (col: string) => bucketFilter(col, orgId, b);
  const conflict = bucketConflict(b);

  // 1. LOCK. A no-op update on conflict still takes the row lock until commit.
  const locked = (await tx.execute(sql`
    insert into pin_attempt_throttle (org_id, store_id, actor_person_id, staff_code)
    values (${orgId}, ${storeId}::uuid, ${actorId}::uuid, ${staffCode})
    ${conflict} do update set updated_at = pin_attempt_throttle.updated_at
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
     where ${bucket('t')}
       and ${bucket('a')}
       and a.kind = 'miss'
       and a.occurred_at > greatest(
             now() - make_interval(hours => ${DAILY_WINDOW_HOURS}),
             coalesce(t.reopened_at, '-infinity'::timestamptz),
             coalesce(
               case when ${auto}::int is not null then t.stopped_at + make_interval(mins => ${auto}::int) end,
               '-infinity'::timestamptz))
  `)) as unknown as Array<{ n: number }>;
  if ((counted[0]?.n ?? 0) >= budget) {
    await tx.execute(
      sql`update pin_attempt_throttle set stopped_at = now(), updated_at = now() where ${bucket('pin_attempt_throttle')}`,
    );
    await tx.execute(sql`
      insert into sign_in_attempts (org_id, store_id, actor_person_id, staff_code, device_id, kind)
      values (${orgId}, ${storeId}::uuid, ${actorId}::uuid, ${staffCode}, ${deviceId}::uuid, 'stopped')
    `);
    return { refused: 'stopped', until: null, newlyStopped: true };
  }

  // 3. PAUSE CHECK (T-303's lock-clobber rule: a refused attempt writes nothing).
  if (state.pauseLive) return { refused: 'locked', until: toDate(state.lockedUntil) };

  // 4. CHARGE - the tier-1 increment exactly as T-303's recordMiss did it.
  const bumped = (await tx.execute(sql`
    update pin_attempt_throttle set
      fail_count = case
        when now() - window_started_at < make_interval(secs => ${tier1.windowSecs}) then fail_count + 1
        else 1
      end,
      window_started_at = case
        when now() - window_started_at < make_interval(secs => ${tier1.windowSecs}) then window_started_at
        else now()
      end,
      locked_until = case
        when (case
          when now() - window_started_at < make_interval(secs => ${tier1.windowSecs}) then fail_count + 1
          else 1
        end) >= ${tier1.threshold}
          then now() + make_interval(secs => ${tier1.cooldownSecs})
        else null
      end,
      updated_at = now()
    where ${bucket('pin_attempt_throttle')}
    returning (locked_until is not null) as "startedPause"
  `)) as unknown as Array<{ startedPause: boolean }>;
  const miss = (await tx.execute(sql`
    insert into sign_in_attempts (org_id, store_id, actor_person_id, staff_code, device_id, kind)
    values (${orgId}, ${storeId}::uuid, ${actorId}::uuid, ${staffCode}, ${deviceId}::uuid, 'miss')
    returning id
  `)) as unknown as Array<{ id: string }>;
  let lockoutId: string | null = null;
  if (bumped[0]?.startedPause) {
    const lockout = (await tx.execute(sql`
      insert into sign_in_attempts (org_id, store_id, actor_person_id, staff_code, device_id, kind)
      values (${orgId}, ${storeId}::uuid, ${actorId}::uuid, ${staffCode}, ${deviceId}::uuid, 'lockout')
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

  return { refused: null, missId: miss[0]!.id, lockoutId, startedPause: !!bumped[0]?.startedPause }; // INSERT ... RETURNING always yields the row
}

/**
 * A correct PIN refunds ONLY its own charge (R3, R14): its miss row, and the lockout row its
 * charge wrote if any. Then tier 1 is cleared as before. Never touches another attempt's rows or
 * stopped_at.
 */
export async function refundOnSuccess(
  tx: Tx,
  orgId: string,
  bucket: Bucket,
  charge: { missId: string; lockoutId: string | null },
): Promise<void> {
  const ids = charge.lockoutId ? [charge.missId, charge.lockoutId] : [charge.missId];
  await tx.execute(sql`
    delete from sign_in_attempts a
     where ${bucketFilter('a', orgId, bucket)} and a.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  await clearOnSuccess(tx, orgId, bucket);
}

/**
 * A manager reopens a stopped store. Not stopped: returns { reopened: false } and writes nothing.
 * Clears tier 1 too, so the first attempt after a reopen is not paused by stale counters.
 */
export async function reopen(
  tx: Tx,
  storeId: string,
  actorPersonId: string,
): Promise<{ reopened: boolean; stoppedAt: Date | null; reopenedAt: Date | null }> {
  const rows = (await tx.execute(sql`
    update pin_attempt_throttle t set
      stopped_at = null, reopened_at = now(), reopened_by = ${actorPersonId}::uuid,
      fail_count = 0, window_started_at = null, locked_until = null, updated_at = now()
    from (select stopped_at from pin_attempt_throttle where store_id = ${storeId} and staff_code is null and stopped_at is not null for update) old
    where t.store_id = ${storeId} and t.staff_code is null and t.stopped_at is not null
    returning old.stopped_at as "stoppedAt", t.reopened_at as "reopenedAt"
  `)) as unknown as Array<{ stoppedAt: Date | string | null; reopenedAt: Date | string | null }>;
  return rows[0]
    ? { reopened: true, stoppedAt: toDate(rows[0].stoppedAt), reopenedAt: toDate(rows[0].reopenedAt) }
    : { reopened: false, stoppedAt: null, reopenedAt: null };
}

/**
 * Clears the counter on a successful PIN. v1's `hadMisses` trick, ported: the `WHERE` guard skips
 * the write entirely when there is nothing to clear, so the ordinary hot path (a correct PIN,
 * first try) touches no row.
 */
export async function clearOnSuccess(tx: Tx, orgId: string, bucket: Bucket): Promise<void> {
  await tx
    .update(pinAttemptThrottle)
    .set({ failCount: 0, windowStartedAt: null, lockedUntil: null, updatedAt: sql`now()` })
    .where(
      and(
        'staffCode' in bucket
          ? and(eq(pinAttemptThrottle.storeId, bucket.store), eq(pinAttemptThrottle.staffCode, normaliseStaffCodeKey(bucket.staffCode)))
          : 'store' in bucket
          ? and(eq(pinAttemptThrottle.storeId, bucket.store), sql`${pinAttemptThrottle.staffCode} is null`)
          : 'org' in bucket
            ? and(
                eq(pinAttemptThrottle.orgId, orgId),
                sql`${pinAttemptThrottle.storeId} is null`,
                sql`${pinAttemptThrottle.actorPersonId} is null`,
              )
            : and(eq(pinAttemptThrottle.orgId, orgId), eq(pinAttemptThrottle.actorPersonId, bucket.actor)),
        or(gt(pinAttemptThrottle.failCount, 0), sql`${pinAttemptThrottle.lockedUntil} is not null`),
      ),
    );
}

/** T-416: is this person's administrator-PIN bucket capped right now? Applies the auto-lift rule (a lifted cap reads "not capped"). */
export async function statusForActor(
  tx: Tx,
  orgId: string,
  personId: string,
): Promise<{ capped: boolean; cappedAt: Date | null }> {
  const rows = (await tx.execute(sql`
    select stopped_at as "stoppedAt"
      from pin_attempt_throttle
     where org_id = ${orgId} and actor_person_id = ${personId}
       and stopped_at is not null and stopped_at + make_interval(mins => ${APPROVAL_CAP_AUTO_LIFT_MINUTES}::int) > now()
  `)) as unknown as Array<{ stoppedAt: Date | string }>;
  return rows[0] ? { capped: true, cappedAt: toDate(rows[0].stoppedAt) } : { capped: false, cappedAt: null };
}

/**
 * T-416: an administrator clears a person's cap. Not capped (including an auto-lifted cap): { cleared: false }, nothing written.
 * Mirrors `reopen`, but applies the auto-lift rule.
 */
export async function resetActorCap(
  tx: Tx,
  orgId: string,
  personId: string,
  byPersonId: string,
): Promise<{ cleared: boolean; cappedAt: Date | null; resetAt: Date | null }> {
  const rows = (await tx.execute(sql`
    update pin_attempt_throttle t set
      stopped_at = null, reopened_at = now(), reopened_by = ${byPersonId}::uuid,
      fail_count = 0, window_started_at = null, locked_until = null, updated_at = now()
    from (select id, stopped_at from pin_attempt_throttle
           where org_id = ${orgId} and actor_person_id = ${personId} and stopped_at is not null
             and stopped_at + make_interval(mins => ${APPROVAL_CAP_AUTO_LIFT_MINUTES}::int) > now()
           for update) old
    where t.id = old.id
    returning old.stopped_at as "stoppedAt", t.reopened_at as "reopenedAt"
  `)) as unknown as Array<{ stoppedAt: Date | string | null; reopenedAt: Date | string | null }>;
  return rows[0]
    ? { cleared: true, cappedAt: toDate(rows[0].stoppedAt), resetAt: toDate(rows[0].reopenedAt) }
    : { cleared: false, cappedAt: null, resetAt: null };
}

export interface PinSignInStatus {
  stopped: boolean;
  stoppedAt: Date | null;
  paused: boolean;
  pausedUntil: Date | null;
  missesLast24h: number;
  /** Misses in the 24h before stopped_at (0 when not stopped): what the stop was about, however old it is. */
  missesBeforeStop: number;
}

/** The Staff panel's read: normal, paused (tier 1) or stopped (tier 2), and the rolling 24-hour miss count. */
export async function statusForStore(tx: Tx, storeId: string): Promise<PinSignInStatus> {
  const auto = STOP_AUTO_REOPEN_MINUTES;
  const rows = (await tx.execute(sql`
    select (t.stopped_at is not null and (${auto}::int is null or t.stopped_at + make_interval(mins => ${auto}::int) > now())) as stopped,
           t.stopped_at as stopped_at,
           (t.locked_until is not null and t.locked_until > now()) as paused,
           t.locked_until as locked_until,
           (select count(*)::int from sign_in_attempts a
             where a.store_id = t.store_id and a.staff_code is null and a.kind = 'miss'
               and a.occurred_at > greatest(now() - interval '24 hours', coalesce(t.reopened_at, '-infinity'::timestamptz))) as misses,
           (select count(*)::int from sign_in_attempts a
             where a.store_id = t.store_id and a.staff_code is null and a.kind = 'miss' and t.stopped_at is not null
               and a.occurred_at > t.stopped_at - interval '24 hours' and a.occurred_at <= t.stopped_at) as misses_before_stop
      from pin_attempt_throttle t where t.store_id = ${storeId} and t.staff_code is null
  `)) as unknown as {
    stopped: boolean;
    stopped_at: Date | string | null;
    paused: boolean;
    locked_until: Date | string | null;
    misses: number;
    misses_before_stop: number;
  }[];
  const r = rows[0];
  if (!r) return { stopped: false, stoppedAt: null, paused: false, pausedUntil: null, missesLast24h: 0, missesBeforeStop: 0 };
  return {
    stopped: r.stopped,
    stoppedAt: r.stopped && r.stopped_at ? new Date(r.stopped_at) : null,
    paused: r.paused,
    pausedUntil: r.paused && r.locked_until ? new Date(r.locked_until) : null,
    missesLast24h: r.misses,
    missesBeforeStop: r.stopped ? r.misses_before_stop : 0,
  };
}
