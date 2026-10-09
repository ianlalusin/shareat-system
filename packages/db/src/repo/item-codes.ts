/**
 * The only place SQL is written for item-code numbering. T-386 R4/R9.
 *
 * `item_code_counters.last_seq` is the highest number ever issued under a 4-character stem, per org. The database's own trigger
 * (`items_code_never_reused`, migration 0189) raises it on every shaped code written, so these functions only READ it or take its
 * row lock; none of them writes a number.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { items, itemCodeCounters, type ItemStatus } from '../../schema/items';

export interface SameStemItem {
  id: string;
  code: string;
  name: string;
  status: ItemStatus;
}

/**
 * The highest number held by an item whose code has the shape once upper-cased (`chwn-001`). The trigger only guards the upper-case
 * form (the unique index stops the case twin), so a lower-case legacy code is not in the counters; the allocator must still see it.
 */
async function heldMax(tx: Tx, orgId: string, stem: string): Promise<number> {
  const rows = await tx.execute(
    sql`select max(right(code, 3)::int) as m from items where org_id = ${orgId} and upper(code) ~ ${`^${stem}-[0-9]{3}$`}`,
  );
  return Number((rows as unknown as { m: number | null }[])[0]?.m ?? 0);
}

/** The mark for a stem, or 0 when none was ever issued. Read-only: never creates the counter row, never locks (I6). */
export async function peekItemCodeStem(tx: Tx, orgId: string, stem: string): Promise<number> {
  const [row] = await tx
    .select({ lastSeq: itemCodeCounters.lastSeq })
    .from(itemCodeCounters)
    .where(and(eq(itemCodeCounters.orgId, orgId), eq(itemCodeCounters.stem, stem)))
    .limit(1);
  return Math.max(row?.lastSeq ?? 0, await heldMax(tx, orgId, stem));
}

/**
 * The mark for a stem, with its row LOCKED until the transaction ends. The row is ensured first (mark 0), so two simultaneous
 * allocations for a new stem serialise on it too. The row lock is the allocation lock: different stems never wait.
 */
export async function lockItemCodeStem(tx: Tx, orgId: string, stem: string): Promise<number> {
  await tx.insert(itemCodeCounters).values({ orgId, stem, lastSeq: 0 }).onConflictDoNothing();
  const [row] = await tx
    .select({ lastSeq: itemCodeCounters.lastSeq })
    .from(itemCodeCounters)
    .where(and(eq(itemCodeCounters.orgId, orgId), eq(itemCodeCounters.stem, stem)))
    .for('update');
  return Math.max(row?.lastSeq ?? 0, await heldMax(tx, orgId, stem));
}

/** Items of ANY status whose code starts with `{STEM}-`, ordered by code, at most `limit` (default 10). */
export async function itemsSharingStem(
  tx: Tx,
  orgId: string,
  stem: string,
  opts: { excludeItemId?: string; limit?: number } = {},
): Promise<SameStemItem[]> {
  const conditions = [eq(items.orgId, orgId), sql`upper(${items.code}) like ${`${stem}-%`}`];
  if (opts.excludeItemId) conditions.push(ne(items.id, opts.excludeItemId));
  const rows = await tx
    .select({ id: items.id, code: items.code, name: items.name, status: items.status })
    .from(items)
    .where(and(...conditions))
    .orderBy(asc(items.code), asc(items.id))
    .limit(opts.limit ?? 10);
  return rows as SameStemItem[];
}
