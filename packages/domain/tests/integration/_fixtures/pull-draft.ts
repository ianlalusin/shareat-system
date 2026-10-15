import type postgres from 'postgres';
import type { Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { postUsage, saveUsageDraft } from '@shareat/domain';

/**
 * T-401 S6 (Ian 15 Oct): finalizing the v1 POS usage pull writes a usage DRAFT (one per store + day, lines = expected, author
 * = system) and moves NO stock. These readers say what the old tests used to say with `onHand`.
 */
type Sql = ReturnType<typeof postgres>;

export interface DayRecord {
  readonly id: string;
  readonly status: string;
  readonly createdBy: string;
  readonly locationId: string;
  readonly lines: Readonly<Record<string, string>>;
}

/** Every non-void usage record of the store on that business date, with its lines as { itemId: quantity }. */
export async function usageRecordsOfDay(sql: Sql, storeId: string, date: string): Promise<DayRecord[]> {
  const recs = await sql<{ id: string; status: string; created_by: string; location_id: string }[]>`
    select id, status, created_by, location_id from stock_usage_records
     where store_id = ${storeId} and used_on = ${date} and kind = 'usage' and status <> 'void' order by created_at, id`;
  const out: DayRecord[] = [];
  for (const r of recs) {
    const lines = await sql<{ item_id: string; q: string }[]>`
      select item_id, sum(quantity)::text as q from stock_usage_lines where record_id = ${r.id} group by item_id`;
    out.push({ id: r.id, status: r.status, createdBy: r.created_by, locationId: r.location_id, lines: Object.fromEntries(lines.map((l) => [l.item_id, l.q])) });
  }
  return out;
}

/** Stock movements of the org: a finalized pull must add none. */
export async function movementCount(sql: Sql, orgId: string): Promise<number> {
  const [r] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${orgId}`;
  return Number(r!.n);
}

/**
 * A LEGACY pull: production has pulls finalized before S6, whose usage records were POSTED and linked to the pull's lines. Today's
 * finalize makes a draft instead, so a test that needs the legacy state first finalizes (or only plans), then calls this: it drops the
 * day's draft (and its pull-line links), then posts one real usage record per room through the real draft + post path (a reason covers
 * any band) and links the pull lines to it. Stock, journal entries and links end up exactly as the old finalize left them.
 */
export async function legacyPostPull(
  sql: Sql,
  asOrg: <T>(orgId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>,
  manager: Actor,
  o: { pullId: string; storeId: string; date: string; lines: readonly { key: string; itemId: string; locationId: string; quantity: string }[] },
): Promise<string[]> {
  const drafts = await sql<{ id: string }[]>`
    select id from stock_usage_records where store_id = ${o.storeId} and used_on = ${o.date} and kind = 'usage' and status = 'draft'`;
  for (const d of drafts) {
    await sql`update pos_usage_pull_lines set usage_record_id = null where usage_record_id = ${d.id}`;
    await sql`delete from stock_usage_lines where record_id = ${d.id}`;
    await sql`delete from stock_usage_records where id = ${d.id}`;
  }
  const rooms = new Map<string, typeof o.lines[number][]>();
  for (const l of o.lines) rooms.set(l.locationId, [...(rooms.get(l.locationId) ?? []), l]);
  const ids: string[] = [];
  for (const [locationId, lines] of rooms) {
    const saved = await asOrg(manager.orgId, (tx) =>
      saveUsageDraft(tx, manager, { orgId: manager.orgId, storeId: o.storeId, locationId, kind: 'usage', usedOn: o.date, lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })) }),
    );
    if (!saved.ok) throw new Error(`legacyPostPull: draft refused: ${saved.reason}`);
    const posted = await asOrg(manager.orgId, (tx) => postUsage(tx, manager, { recordId: saved.recordId, verifyOutOfTolerance: { reason: 'legacy pull fixture' } }));
    if (!posted.ok) throw new Error(`legacyPostPull: post refused: ${posted.reason}`);
    for (const l of lines) await sql`update pos_usage_pull_lines set usage_record_id = ${saved.recordId} where pull_id = ${o.pullId} and line_key = ${l.key}`;
    ids.push(saved.recordId);
  }
  return ids;
}
