/**
 * The only place SQL is written for prerequisite refusals. T-245.
 *
 * ⛔ **This module has no opinion about which transaction it runs on.** `record()` is a plain
 * INSERT against whatever `Tx` it is handed — the decision that it must NOT be the throwing
 * caller's own transaction lives one layer up, in
 * `packages/domain/src/attendance/credentials.ts`'s `recordPrerequisiteRefusal`, which opens an
 * independent transaction via `withOrgPrincipal` before calling this. See
 * `docs/tasks/245-prerequisite-refusal-counter.md` §3.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

export interface RecordRefusalInput {
  readonly orgId: string;
  readonly storeId: string | null;
  readonly reasonCode: string;
  readonly domain: string;
  readonly actorPersonId: string | null;
}

export async function record(tx: Tx, input: RecordRefusalInput): Promise<void> {
  await tx.execute(sql`
    insert into prerequisite_refusals (org_id, store_id, reason_code, domain, actor_person_id)
    values (${input.orgId}, ${input.storeId}, ${input.reasonCode}, ${input.domain}, ${input.actorPersonId})
  `);
}

export interface RefusalCount {
  readonly reasonCode: string;
  readonly domain: string;
  readonly count: number;
  readonly lastOccurredAt: Date;
}

/**
 * The read-back for `/admin/prerequisite-refusals` — bible §4.2 rule 7: `count(*)`/`max()` over
 * the raw rows, computed at read time, never a value stored anywhere else.
 */
export async function countByReason(tx: Tx, orgId: string, since?: Date): Promise<RefusalCount[]> {
  const rows = await tx.execute(sql`
    select reason_code, domain, count(*)::int as count, max(occurred_at) as last_occurred_at
    from prerequisite_refusals
    where org_id = ${orgId}
      ${since ? sql`and occurred_at >= ${since}` : sql``}
    group by reason_code, domain
    order by count(*) desc
  `);
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    reasonCode: String(r.reason_code),
    domain: String(r.domain),
    count: Number(r.count),
    lastOccurredAt: new Date(r.last_occurred_at as string),
  }));
}
