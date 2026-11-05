/**
 * T-510 S1b - the only place SQL is written for menu dayparts (migration 0233). docs/tasks/510-menu-dayparts.md R1.
 *
 * Plain reads and writes. The rules (non-empty days, end <> start, unique active name, retire refused while a live offer uses the
 * daypart, overlap) live in the database; authorize, audit and plain-word refusals are the domain's (slice S2). The DB role may
 * UPDATE exactly name, days, start_time, end_time, status and updated_at, so `updateDaypart` cannot move a daypart to another store.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { menuDayparts, type MenuStatus } from '../../schema/menu';
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

export async function insertDaypart(tx: Tx, input: InsertDaypartInput): Promise<MenuDaypartRow> {
  const [row] = await tx.insert(menuDayparts).values(input).returning();
  return row!;
}

export async function updateDaypart(tx: Tx, id: string, patch: UpdateDaypartPatch): Promise<MenuDaypartRow> {
  const [row] = await tx
    .update(menuDayparts)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(menuDayparts.id, id))
    .returning();
  return row!;
}

/** The store's IANA timezone (`stores.timezone`); every daypart window is wall clock in it. undefined when the store is not visible. */
export async function storeTimezone(tx: Tx, storeId: string): Promise<string | undefined> {
  const [row] = await tx.select({ timezone: stores.timezone }).from(stores).where(eq(stores.id, storeId));
  return row?.timezone;
}
