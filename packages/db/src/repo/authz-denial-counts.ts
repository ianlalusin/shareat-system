/**
 * authz_denial_counts - the hourly counters behind aggregated authorisation denials (T-402 R9). S2 owns
 * `registerDenial` / `increment`; S5 owns the roll-up and the delete.
 *
 * The counter table is NOT the log and is NOT append-only. The FIRST denial per (org, actor, capability, store,
 * Manila business day) is a real `security.authorize_denied` row, written by the caller; every later one that day
 * only bumps the counter for its hour bucket. "First of the day" is read from `audit_log` itself (not from the
 * counter), so it stays true after S5 has rolled the counter rows up and deleted them.
 *
 * Both functions run under `withOrgPrincipal(orgId, ...)` in the security-event outbox's own transaction
 * (`packages/auth/src/security-events.ts`), never in the refused caller's transaction.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

interface DenialKey {
  orgId: string;
  actorPersonId: string;
  capability: string;
  storeId: string | null;
  /** Any instant inside the hour bucket (and the Manila day) the denials belong to. */
  at: Date;
}

/** Add `by` denials (default 1) to their hour bucket (created at `by` on first sight). */
export async function increment(tx: Tx, input: DenialKey & { by?: number }): Promise<void> {
  const by = input.by ?? 1;
  if (by <= 0) return;
  await tx.execute(sql`
    insert into authz_denial_counts (org_id, actor_person_id, capability, store_id, hour_bucket, count)
    values (${input.orgId}, ${input.actorPersonId}, ${input.capability}, ${input.storeId}::uuid,
            date_trunc('hour', ${input.at.toISOString()}::timestamptz), ${by})
    on conflict (org_id, actor_person_id, capability, store_id, hour_bucket)
    do update set count = authz_denial_counts.count + ${by}
  `);
}

/**
 * Decide first-of-day vs counted, atomically, for `count` coalesced denials. Takes a transaction-scoped advisory lock on
 * the key (the multi-process truth: two processes racing serialise, the loser sees the winner's row), then asks
 * `audit_log` whether a `security.authorize_denied` row for this key already exists in the Manila business day of `at`.
 * The scan is bounded by `recorded_at` as well as `occurred_at` (recorded_at >= occurred_at always), so only the
 * partitions of the current day are touched.
 *
 * Returns `{ first: true }` when none exists (the caller appends the row; `count - 1` are counted), otherwise counts all
 * `count` and returns `{ first: false }`. `assumeSeen` (the outbox already wrote this key today) skips lock and scan.
 */
export async function registerDenial(
  tx: Tx,
  input: DenialKey & { count?: number; assumeSeen?: boolean },
): Promise<{ first: boolean }> {
  const count = input.count ?? 1;
  if (input.assumeSeen) {
    await increment(tx, { ...input, by: count });
    return { first: false };
  }
  const at = input.at.toISOString();
  const day = (await tx.execute(sql`select ((${at}::timestamptz at time zone 'Asia/Manila')::date)::text as d`)) as unknown as Array<{
    d: string;
  }>;
  // Locked on the Manila DAY (not the hour), so requests in different hours of one business day still serialise.
  const lockKey = `authz-denial:${input.orgId}:${input.actorPersonId}:${input.capability}:${input.storeId ?? '-'}:${day[0]!.d}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const seen = (await tx.execute(sql`
    select 1 as x from audit_log
     where org_id = ${input.orgId}
       and action = 'security.authorize_denied'
       and actor_person_id = ${input.actorPersonId}
       and after ->> 'capability' = ${input.capability}
       and coalesce(after ->> 'deniedAtStoreId', '') = ${input.storeId ?? ''}
       and occurred_at >= (date_trunc('day', ${at}::timestamptz at time zone 'Asia/Manila') at time zone 'Asia/Manila')
       and occurred_at < (date_trunc('day', ${at}::timestamptz at time zone 'Asia/Manila') + interval '1 day') at time zone 'Asia/Manila'
       and recorded_at >= (date_trunc('day', ${at}::timestamptz at time zone 'Asia/Manila') at time zone 'Asia/Manila')
       and recorded_at < (date_trunc('day', ${at}::timestamptz at time zone 'Asia/Manila') + interval '2 day') at time zone 'Asia/Manila'
     limit 1
  `)) as unknown as unknown[];
  if (seen.length === 0) {
    await increment(tx, { ...input, by: count - 1 });
    return { first: true };
  }
  await increment(tx, { ...input, by: count });
  return { first: false };
}

/** The org a person belongs to, as the caller's RLS shows it (a foreign person reads as absent). */
export async function orgIdOfPerson(tx: Tx, personId: string): Promise<string | null> {
  const rows = (await tx.execute(sql`select org_id as "orgId" from persons where id = ${personId}`)) as unknown as Array<{
    orgId: string;
  }>;
  return rows[0]?.orgId ?? null;
}
