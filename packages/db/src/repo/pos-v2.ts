/**
 * T-523 - the only place SQL is written for the POS v2 tables (migration 0238; schema in `packages/db/schema/pos-v2.ts`).
 * docs/tasks/523-pos-v2-schema.md.
 *
 * READ HELPERS ONLY. T-524 (domain) owns every write: it records the sale, bumps `pos_stores.state_version`, audits mode changes.
 * Every function takes the caller's transaction first and filters by org AND store; RLS is the backstop.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  posEvents,
  posSalesReceipts,
  posStores,
  tableSessionLines,
  tableSessions,
  type PosEventRow,
  type PosSalesReceiptRow,
  type PosStoreRow,
  type TableSessionLineRow,
  type TableSessionRow,
} from '../../schema/pos-v2';
import type { Tx } from '../client';

export type { PosEventRow, PosSalesReceiptRow, PosStoreRow, TableSessionLineRow, TableSessionRow };

/** The store's POS switch row (mode, live_from, state_version), or undefined when the store has none (treated as `off`). */
export async function getPosStore(tx: Tx, orgId: string, storeId: string): Promise<PosStoreRow | undefined> {
  const [row] = await tx.select().from(posStores).where(and(eq(posStores.orgId, orgId), eq(posStores.storeId, storeId)));
  return row;
}

/** One table session by id (store-scoped). */
export async function getTableSession(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<TableSessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(tableSessions)
    .where(and(eq(tableSessions.id, sessionId), eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId)));
  return row;
}

/** Every open session of a store, oldest first (the floor view). */
export async function listOpenSessions(tx: Tx, orgId: string, storeId: string): Promise<TableSessionRow[]> {
  return tx
    .select()
    .from(tableSessions)
    .where(and(eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId), eq(tableSessions.status, 'open')))
    .orderBy(asc(tableSessions.openedAt), asc(tableSessions.id));
}

/** The lines of one session in the order they were added. */
export async function listSessionLines(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<TableSessionLineRow[]> {
  return tx
    .select()
    .from(tableSessionLines)
    .where(and(eq(tableSessionLines.orgId, orgId), eq(tableSessionLines.storeId, storeId), eq(tableSessionLines.sessionId, sessionId)))
    .orderBy(asc(tableSessionLines.addedAtDevice), asc(tableSessionLines.id));
}

/** One sales receipt by id (store-scoped). */
export async function getSalesReceipt(tx: Tx, orgId: string, storeId: string, receiptId: string): Promise<PosSalesReceiptRow | undefined> {
  const [row] = await tx
    .select()
    .from(posSalesReceipts)
    .where(and(eq(posSalesReceipts.id, receiptId), eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId)));
  return row;
}

/** Quarantined, still-unresolved events of a store, oldest first (the manager's list). The payload is returned as stored: the caller gates who may see it (row 353). */
export async function listQuarantinedEvents(tx: Tx, orgId: string, storeId: string): Promise<PosEventRow[]> {
  return tx
    .select()
    .from(posEvents)
    .where(and(eq(posEvents.orgId, orgId), eq(posEvents.storeId, storeId), eq(posEvents.status, 'quarantined'), isNull(posEvents.resolvedAt)))
    .orderBy(asc(posEvents.receivedAt), asc(posEvents.id));
}
