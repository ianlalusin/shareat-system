/**
 * Physical counts — T-169's SQL. The only place `count_sessions` / `count_session_locations` /
 * `count_lines` are read or written.
 *
 * ⭐ The freeze itself is enforced by `stock_movements_check_not_frozen_trg` (migration 0068) —
 * nothing here re-checks it. `insertCountSession` relies on `count_session_locations_one_active_trg`
 * to refuse a room that is already frozen, and translates the trigger's message rather than
 * pre-querying for the same fact twice.
 *
 * ⛔ `listActiveLocationsLike` duplicates the shape of `stock-locations.ts`'s `listActiveLocations`
 * on purpose — that file belongs to the T-160 lane (docs/tasks/169 §"do not edit"), so a location
 * read this module needs lives here instead of adding a second writer to a file another lane owns.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { countLines, countSessionLocations, countSessions, type CountSessionStatus } from '../../schema/count-sessions';
import { items } from '../../schema/items';
import { persons } from '../../schema/persons';
import { stockLocations } from '../../schema/stock-locations';
import { stockMovements } from '../../schema/stock-ledger';
import { stores } from '../../schema/stores';
import type { Tx } from '../client';
import type { Quantity } from '@shareat/core/money';

export interface CountSessionRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly status: CountSessionStatus;
  readonly countedOn: string;
  readonly note: string | null;
  readonly committedAt: Date | null;
  readonly journalEntryId: string | null;
  readonly openedBy: string;
  readonly openedAt: Date;
  readonly closedBy: string | null;
  readonly closedAt: Date | null;
  readonly locations: readonly { id: string; name: string }[];
}

export interface CountSessionListRow {
  readonly id: string;
  readonly status: CountSessionStatus;
  readonly countedOn: string;
  readonly note: string | null;
  readonly openedBy: string;
  readonly openedAt: Date;
  readonly locations: readonly { id: string; name: string }[];
  readonly lineCount: number;
}

export interface CountLineRow {
  readonly id: string;
  readonly sessionId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly itemKind: string;
  readonly baseUnit: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly countedQuantity: string;
  readonly expectedQuantity: string | null;
  readonly variance: string | null;
  readonly movementId: string | null;
  readonly countedBy: string;
  readonly countedAt: Date;
}

export interface ExpectedItemRow {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly itemKind: string;
  readonly baseUnit: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly quantity: string;
}

export interface ActiveLocationRow {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly purpose: string;
  readonly isDefault: boolean;
  readonly status: string;
}

export interface FreezingSessionRow {
  readonly id: string;
  readonly status: string | null;
  readonly locationIds: readonly string[];
}

/**
 * Opens a session and freezes every named room in one statement each. ⚠️ **A room already held by
 * an active session throws the trigger's own message** — this function does not pre-check, because
 * pre-checking and then inserting is two reads of the same fact with a race between them; the
 * trigger is the single source of truth and always runs inside this same transaction.
 */
export async function insertCountSession(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly storeId: string;
    readonly countedOn: string;
    readonly note: string | null;
    readonly openedBy: string;
    readonly locationIds: readonly string[];
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(countSessions)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      countedOn: input.countedOn,
      note: input.note,
      openedBy: input.openedBy,
    })
    .returning({ id: countSessions.id });
  const session = row!;

  await tx.insert(countSessionLocations).values(
    input.locationIds.map((locationId) => ({ sessionId: session.id, locationId })),
  );

  return session;
}

export async function getCountSession(tx: Tx, id: string): Promise<CountSessionRow | undefined> {
  const [session] = await tx
    .select({
      id: countSessions.id,
      orgId: countSessions.orgId,
      storeId: countSessions.storeId,
      status: countSessions.status,
      countedOn: countSessions.countedOn,
      note: countSessions.note,
      committedAt: countSessions.committedAt,
      journalEntryId: countSessions.journalEntryId,
      openedBy: countSessions.openedBy,
      openedAt: countSessions.openedAt,
      closedBy: countSessions.closedBy,
      closedAt: countSessions.closedAt,
    })
    .from(countSessions)
    .where(eq(countSessions.id, id));
  if (!session) return undefined;

  const locations = await tx
    .select({ id: stockLocations.id, name: stockLocations.name })
    .from(countSessionLocations)
    .innerJoin(stockLocations, eq(stockLocations.id, countSessionLocations.locationId))
    .where(eq(countSessionLocations.sessionId, id))
    .orderBy(asc(stockLocations.name));

  return { ...session, locations };
}

/** Newest first, with room names and how many lines have been counted so far. */
export async function listCountSessions(tx: Tx, storeId: string): Promise<CountSessionListRow[]> {
  const sessions = await tx
    .select({
      id: countSessions.id,
      status: countSessions.status,
      countedOn: countSessions.countedOn,
      note: countSessions.note,
      openedBy: countSessions.openedBy,
      openedAt: countSessions.openedAt,
    })
    .from(countSessions)
    .where(eq(countSessions.storeId, storeId))
    .orderBy(desc(countSessions.openedAt));
  if (sessions.length === 0) return [];

  const ids = sessions.map((s) => s.id);
  const [locRows, lineCounts] = await Promise.all([
    tx
      .select({ sessionId: countSessionLocations.sessionId, id: stockLocations.id, name: stockLocations.name })
      .from(countSessionLocations)
      .innerJoin(stockLocations, eq(stockLocations.id, countSessionLocations.locationId))
      .where(inArray(countSessionLocations.sessionId, ids)),
    tx
      .select({ sessionId: countLines.sessionId, n: sql<number>`count(*)::int` })
      .from(countLines)
      .where(inArray(countLines.sessionId, ids))
      .groupBy(countLines.sessionId),
  ]);

  const locBySession = new Map<string, { id: string; name: string }[]>();
  for (const r of locRows) {
    const list = locBySession.get(r.sessionId) ?? [];
    list.push({ id: r.id, name: r.name });
    locBySession.set(r.sessionId, list);
  }
  const lineCountBySession = new Map(lineCounts.map((r) => [r.sessionId, r.n]));

  return sessions.map((s) => ({
    ...s,
    locations: (locBySession.get(s.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    lineCount: lineCountBySession.get(s.id) ?? 0,
  }));
}

export async function setCountSessionStatus(tx: Tx, id: string, status: CountSessionStatus): Promise<void> {
  await tx.update(countSessions).set({ status }).where(eq(countSessions.id, id));
}

/** Insert a counted line, or overwrite the existing session+item+location row — a recount before
 *  commit replaces the earlier answer rather than stacking a second one beside it. */
export async function upsertCountLine(
  tx: Tx,
  input: {
    readonly sessionId: string;
    readonly itemId: string;
    readonly locationId: string;
    readonly countedQuantity: Quantity;
    readonly countedBy: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(countLines)
    .values({
      sessionId: input.sessionId,
      itemId: input.itemId,
      locationId: input.locationId,
      countedQuantity: input.countedQuantity,
      countedBy: input.countedBy,
    })
    .onConflictDoUpdate({
      target: [countLines.sessionId, countLines.itemId, countLines.locationId],
      set: { countedQuantity: input.countedQuantity, countedBy: input.countedBy, countedAt: new Date() },
    })
    .returning({ id: countLines.id });
  return row!;
}

/** The one count line's id for a (session, item, room), or undefined when nothing has been typed there yet. */
export async function lineIdFor(tx: Tx, sessionId: string, itemId: string, locationId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: countLines.id })
    .from(countLines)
    .where(and(eq(countLines.sessionId, sessionId), eq(countLines.itemId, itemId), eq(countLines.locationId, locationId)))
    .limit(1);
  return row?.id;
}

export async function listCountLines(tx: Tx, sessionId: string): Promise<CountLineRow[]> {
  return tx
    .select({
      id: countLines.id,
      sessionId: countLines.sessionId,
      itemId: countLines.itemId,
      itemCode: items.code,
      itemName: items.name,
      itemKind: items.kind,
      baseUnit: items.baseUnit,
      locationId: countLines.locationId,
      locationName: stockLocations.name,
      countedQuantity: countLines.countedQuantity,
      expectedQuantity: countLines.expectedQuantity,
      variance: countLines.variance,
      movementId: countLines.movementId,
      countedBy: countLines.countedBy,
      countedAt: countLines.countedAt,
    })
    .from(countLines)
    .innerJoin(items, eq(items.id, countLines.itemId))
    .innerJoin(stockLocations, eq(stockLocations.id, countLines.locationId))
    .where(eq(countLines.sessionId, sessionId))
    .orderBy(asc(items.name));
}

export async function setCountLineResult(
  tx: Tx,
  lineId: string,
  input: { readonly expectedQuantity: Quantity; readonly variance: Quantity; readonly movementId: string | null },
): Promise<void> {
  await tx
    .update(countLines)
    .set({ expectedQuantity: input.expectedQuantity, variance: input.variance, movementId: input.movementId })
    .where(eq(countLines.id, lineId));
}

/** ⚠️ Sets `committed_at` for the FIRST time — `count_sessions_commit_once_trg` refuses a second
 *  call by comparing against the OLD value, so this function is never retried on an already-closed
 *  session. */
export async function markCountCommitted(
  tx: Tx,
  id: string,
  input: {
    readonly committedAt: Date;
    readonly journalEntryId: string | null;
    readonly closedBy: string;
    readonly closedAt: Date;
  },
): Promise<void> {
  await tx
    .update(countSessions)
    .set({
      status: 'closed',
      committedAt: input.committedAt,
      journalEntryId: input.journalEntryId,
      closedBy: input.closedBy,
      closedAt: input.closedAt,
    })
    .where(eq(countSessions.id, id));
}

export async function markCountCancelled(
  tx: Tx,
  id: string,
  input: { readonly closedBy: string; readonly closedAt: Date },
): Promise<void> {
  await tx
    .update(countSessions)
    .set({ status: 'cancelled', closedBy: input.closedBy, closedAt: input.closedAt })
    .where(eq(countSessions.id, id));
}

/**
 * Every item with a non-zero balance in any of these rooms — the count sheet's row list, and the
 * set invariant 4 checks a commit against. ⚠️ One row per (item, location) pair, same shape as
 * `stockLedgerRepo.onHandByStore` but scoped to specific rooms rather than a whole store, because a
 * session freezes rooms, not stores.
 */
export async function expectedItemsAt(tx: Tx, locationIds: readonly string[]): Promise<ExpectedItemRow[]> {
  if (locationIds.length === 0) return [];
  return tx
    .select({
      itemId: stockMovements.itemId,
      itemCode: items.code,
      itemName: items.name,
      itemKind: items.kind,
      baseUnit: items.baseUnit,
      locationId: stockMovements.locationId,
      locationName: stockLocations.name,
      quantity: sql<string>`sum(${stockMovements.quantity})::text`,
    })
    .from(stockMovements)
    .innerJoin(items, eq(items.id, stockMovements.itemId))
    .innerJoin(stockLocations, eq(stockLocations.id, stockMovements.locationId))
    .where(inArray(stockMovements.locationId, [...locationIds]))
    .groupBy(stockMovements.itemId, items.code, items.name, items.kind, items.baseUnit, stockMovements.locationId, stockLocations.name)
    .having(sql`sum(${stockMovements.quantity}) <> 0`)
    .orderBy(asc(items.name));
}

/** T-169's own read: a store's active rooms. See this file's header for why it is not
 *  `stock-locations.ts`'s `listActiveLocations`. */
export async function listActiveLocationsLike(tx: Tx, storeId: string): Promise<ActiveLocationRow[]> {
  return tx
    .select({
      id: stockLocations.id,
      name: stockLocations.name,
      role: stockLocations.role,
      purpose: stockLocations.purpose,
      isDefault: stockLocations.isDefault,
      status: stockLocations.status,
    })
    .from(stockLocations)
    .where(and(eq(stockLocations.storeId, storeId), eq(stockLocations.status, 'active')))
    .orderBy(asc(stockLocations.name));
}

/**
 * Every session that holds AT LEAST ONE of the given rooms, with the FULL set of rooms it holds and
 * its own status — the shape `isFrozenBySessions` (packages/domain/src/stock/count-workflow.ts)
 * checks per room for the UI's "frozen" badge. ⚠️ Read-only: the trigger is the enforcement, this is
 * only what a screen shows.
 */
export async function freezingSessionsFor(tx: Tx, locationIds: readonly string[]): Promise<FreezingSessionRow[]> {
  if (locationIds.length === 0) return [];

  // ⭐ Two plain queries rather than one raw `array_agg` — the target session ids first, then
  // every room EACH of those sessions holds (not just the ones asked about), which is what the
  // pure predicate needs to answer "does session X hold room Y" for any Y.
  const hits = await tx
    .selectDistinct({ sessionId: countSessionLocations.sessionId })
    .from(countSessionLocations)
    .where(inArray(countSessionLocations.locationId, [...locationIds]));
  if (hits.length === 0) return [];
  const sessionIds = hits.map((h) => h.sessionId);

  const [sessionRows, locRows] = await Promise.all([
    tx.select({ id: countSessions.id, status: countSessions.status }).from(countSessions).where(inArray(countSessions.id, sessionIds)),
    tx
      .select({ sessionId: countSessionLocations.sessionId, locationId: countSessionLocations.locationId })
      .from(countSessionLocations)
      .where(inArray(countSessionLocations.sessionId, sessionIds)),
  ]);

  const locsBySession = new Map<string, string[]>();
  for (const r of locRows) {
    const list = locsBySession.get(r.sessionId) ?? [];
    list.push(r.locationId);
    locsBySession.set(r.sessionId, list);
  }

  return sessionRows.map((s) => ({ id: s.id, status: s.status, locationIds: locsBySession.get(s.id) ?? [] }));
}

// -----------------------------------------------------------------------------------------
// ⭐ bible §4.3 layering fix (2026-09-03). Two small reads `apps/erp/.../counts/lib.ts` needs from
// tables this file does not own (`persons`, `stores`) — kept HERE rather than in a `persons`/`stores`
// repo of their own, same reasoning as `listActiveLocationsLike` above: a screen-specific read is
// not a reason to go add a dependency on (or into) another table's repo file.
// -----------------------------------------------------------------------------------------

/** Display names for a set of person ids — the register's "opened by" / "closed by" columns. */
export async function personNamesById(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: persons.id, displayName: persons.displayName })
    .from(persons)
    .where(inArray(persons.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

/** The store's display name, for the count-session detail header. `undefined` if the store id does
 *  not resolve — the caller falls back to the raw id rather than treating that as an error. */
export async function storeName(tx: Tx, storeId: string): Promise<string | undefined> {
  const [row] = await tx.select({ name: stores.name }).from(stores).where(eq(stores.id, storeId));
  return row?.name;
}
