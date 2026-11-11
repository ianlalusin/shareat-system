/**
 * T-510 S1b - the only place SQL is written for menu dayparts (migration 0233). docs/tasks/510-menu-dayparts.md R1.
 *
 * Plain reads and writes. The rules (non-empty days, end <> start, unique active name, retire refused while a live offer uses the
 * daypart, overlap) live in the database; authorize, audit and plain-word refusals are the domain's (slice S2). The DB role may
 * UPDATE exactly name, days, start_time, end_time, status and updated_at, so `updateDaypart` cannot move a daypart to another store.
 */
import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { menuDaypartVersions, menuDayparts, type MenuStatus } from '../../schema/menu';
import { stores } from '../../schema/stores';
import type { Tx } from '../client';

export type MenuDaypartRow = typeof menuDayparts.$inferSelect;

export interface InsertDaypartInput {
  orgId: string;
  storeId: string;
  name: string;
  /** 0 = Sunday .. 6; the day the window starts on. */
  days: number[];
  /** 'HH:MM' store-local. */
  startTime: string;
  /** 'HH:MM' store-local; earlier than start means overnight. */
  endTime: string;
  createdBy: string;
}

export interface UpdateDaypartPatch {
  name?: string;
  days?: number[];
  startTime?: string;
  endTime?: string;
  status?: MenuStatus;
}

/** Every daypart of one store, all statuses, by start time then name. */
export async function listDaypartsOfStore(tx: Tx, orgId: string, storeId: string): Promise<MenuDaypartRow[]> {
  return tx
    .select()
    .from(menuDayparts)
    .where(and(eq(menuDayparts.orgId, orgId), eq(menuDayparts.storeId, storeId)))
    .orderBy(asc(menuDayparts.startTime), asc(menuDayparts.name), asc(menuDayparts.id));
}

export async function getDaypart(tx: Tx, orgId: string, id: string): Promise<MenuDaypartRow | undefined> {
  const [row] = await tx.select().from(menuDayparts).where(and(eq(menuDayparts.id, id), eq(menuDayparts.orgId, orgId)));
  return row;
}

/**
 * The daypart row, locked FOR NO KEY UPDATE (the FIRST lock of the 0233 order), and read fresh once the lock is won: two concurrent edits or
 * retires of one daypart run one after the other, and the second one's `before` is the row the first left. It does not block the FOR SHARE
 * and KEY SHARE locks of offer writes beyond what a real update would.
 */
export async function lockDaypartForUpdate(tx: Tx, orgId: string, id: string): Promise<MenuDaypartRow | undefined> {
  const [row] = await tx
    .select()
    .from(menuDayparts)
    .where(and(eq(menuDayparts.id, id), eq(menuDayparts.orgId, orgId)))
    .for('no key update');
  return row;
}

/** T-565 (0251): the window version 1 is opened by the menu_dayparts_version_sync trigger, not here. */
export async function insertDaypart(tx: Tx, input: InsertDaypartInput): Promise<MenuDaypartRow> {
  const [row] = await tx.insert(menuDayparts).values(input).returning();
  return row!;
}

/** T-565 (0251): an edit or retire closes the open window version and opens the next in the database (trigger menu_dayparts_version_sync), not here. */
export async function updateDaypart(tx: Tx, id: string, patch: UpdateDaypartPatch): Promise<MenuDaypartRow> {
  const [row] = await tx
    .update(menuDayparts)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(menuDayparts.id, id))
    .returning();
  return row!;
}

export type MenuDaypartVersionRow = typeof menuDaypartVersions.$inferSelect;

/**
 * T-565 (0251): the window of every daypart of one store as it stood at `at` (retired dayparts included, status as then): the version with
 * `valid_from <= at < coalesce(valid_to, infinity)`. At "now" this is exactly `listDaypartsOfStore`. A daypart created after `at` has no row.
 */
export async function listDaypartWindowsAsOf(tx: Tx, orgId: string, storeId: string, at: Date): Promise<MenuDaypartVersionRow[]> {
  return tx
    .select()
    .from(menuDaypartVersions)
    .where(
      and(
        eq(menuDaypartVersions.orgId, orgId),
        eq(menuDaypartVersions.storeId, storeId),
        lte(menuDaypartVersions.validFrom, at),
        or(isNull(menuDaypartVersions.validTo), gt(menuDaypartVersions.validTo, at)),
      ),
    )
    .orderBy(asc(menuDaypartVersions.startTime), asc(menuDaypartVersions.name), asc(menuDaypartVersions.daypartId));
}

/** The store's IANA timezone (`stores.timezone`); every daypart window is wall clock in it. undefined when the store is not visible. */
export async function storeTimezone(tx: Tx, storeId: string): Promise<string | undefined> {
  const [row] = await tx.select({ timezone: stores.timezone }).from(stores).where(eq(stores.id, storeId));
  return row?.timezone;
}

/** Takes the daypart row FOR SHARE: the FIRST lock of the 0233 lock order (daypart row, item key, variant key), so an offer write that follows cannot deadlock a retire or window edit. */
export async function lockDaypartShare(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`select 1 from menu_dayparts where id = ${id}::uuid for share`);
}

/**
 * How many (variant, channel) slots of this daypart are live: live now, or with a non-withdrawn row scheduled later. The text of the 0233
 * update guard's retire count, so the domain refuses in a sentence first; the guard stays the authority.
 */
export async function countLiveOfferSlots(tx: Tx, id: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n from (
      select o.variant_id, o.channel from menu_offers o
       where o.daypart_id = ${id}::uuid
       group by o.variant_id, o.channel
      having bool_or(not o.withdrawn and o.effective_from > now())
          or coalesce((select not x.withdrawn from menu_offers x
                        where x.daypart_id = ${id}::uuid and x.variant_id = o.variant_id and x.channel = o.channel and x.effective_from <= now()
                        order by x.effective_from desc limit 1), false)
    ) s`)) as unknown as { n: number }[];
  return rows[0]!.n;
}

/** Would giving this daypart the window (days, start, end) make two live offers of one variant and channel overlap? The same function the 0233 update guard calls. null = fine. */
export async function windowConflict(
  tx: Tx,
  id: string,
  w: { days: number[]; startTime: string; endTime: string },
): Promise<'mixed_all_day_and_daypart' | 'overlapping_dayparts' | null> {
  const rows = (await tx.execute(sql`
    select menu_offer_slot_conflict(r.store_id, r.variant_id, r.channel, false, null, null, null, ${id}::uuid,
           ${`{${w.days.join(',')}}`}::smallint[], ${w.startTime}::time, ${w.endTime}::time, null) as c
      from (select distinct store_id, variant_id, channel from menu_offers where daypart_id = ${id}::uuid) r`)) as unknown as {
    c: 'mixed_all_day_and_daypart' | 'overlapping_dayparts' | null;
  }[];
  return rows.find((r) => r.c !== null)?.c ?? null;
}
