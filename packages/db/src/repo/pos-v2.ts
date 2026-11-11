/**
 * T-523 - the only place SQL is written for the POS v2 tables (migration 0238; schema in `packages/db/schema/pos-v2.ts`).
 * docs/tasks/523-pos-v2-schema.md. T-524 (docs/tasks/524-pos-v2-domain.md) adds the write helpers: the domain decides every rule,
 * these only write.
 *
 * Every function takes the caller's transaction first and filters by org AND store; RLS is the backstop. The domain bumps
 * `pos_stores.state_version` (`bumpStateVersion`) once per call that changes anything a screen shows.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  posDayCloseTenders,
  posDayCloses,
  posDiscountPresets,
  posEvents,
  posSalesReceiptLineDiscounts,
  posSalesReceiptLines,
  posSalesReceiptPayments,
  posSalesReceipts,
  posStands,
  posStores,
  posTerminals,
  tableSessionLineDiscounts,
  tableSessionLines,
  tableSessions,
  type PosDayCloseRow,
  type PosDiscountPresetRow,
  type PosEventRow,
  type PosSalesReceiptRow,
  type PosStandRow,
  type PosStoreRow,
  type PosTerminalRow,
  type TableSessionLineDiscountRow,
  type TableSessionLineRow,
  type TableSessionRow,
} from '../../schema/pos-v2';
import { employments } from '../../schema/employment';
import { persons } from '../../schema/persons';
import { posTabletPairings } from '../../schema/pos-tablet-pairings';
import { tenders } from '../../schema/pos-v1';
import type { Money } from '@shareat/core/money';
import type { Tx } from '../client';

export type {
  PosDayCloseRow,
  PosDiscountPresetRow,
  PosEventRow,
  PosSalesReceiptRow,
  PosStandRow,
  PosStoreRow,
  PosTerminalRow,
  TableSessionLineDiscountRow,
  TableSessionLineRow,
  TableSessionRow,
};

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
    .orderBy(asc(tableSessionLines.addedAtDevice), asc(tableSessionLines.addedAt), asc(tableSessionLines.id));
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

// ---------------------------------------------------------------------------------------------------------------------
// T-524 writes and reads for the domain (packages/domain/src/pos). No rule lives here.
// ---------------------------------------------------------------------------------------------------------------------

/** Bumps the store's polling counter by 1 and returns the new value. The domain calls it once per call that changes anything a screen shows. */
export async function bumpStateVersion(tx: Tx, orgId: string, storeId: string): Promise<number> {
  const [row] = await tx
    .update(posStores)
    .set({ stateVersion: sql`${posStores.stateVersion} + 1` })
    .where(and(eq(posStores.orgId, orgId), eq(posStores.storeId, storeId)))
    .returning({ v: posStores.stateVersion });
  return row!.v;
}

/** A live (not revoked) pairing of this store, or undefined. */
export async function getLivePairing(tx: Tx, orgId: string, storeId: string, pairingId: string): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: posTabletPairings.id })
    .from(posTabletPairings)
    .where(
      and(
        eq(posTabletPairings.id, pairingId),
        eq(posTabletPairings.orgId, orgId),
        eq(posTabletPairings.storeId, storeId),
        isNull(posTabletPairings.revokedAt),
      ),
    );
  return row;
}

export async function getStand(tx: Tx, orgId: string, storeId: string, standId: string): Promise<PosStandRow | undefined> {
  const [row] = await tx
    .select()
    .from(posStands)
    .where(and(eq(posStands.id, standId), eq(posStands.orgId, orgId), eq(posStands.storeId, storeId)));
  return row;
}

export async function getTerminalByNo(tx: Tx, orgId: string, storeId: string, terminalNo: number): Promise<PosTerminalRow | undefined> {
  const [row] = await tx
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.orgId, orgId), eq(posTerminals.storeId, storeId), eq(posTerminals.terminalNo, terminalNo)));
  return row;
}

export async function getStoreOrgId(tx: Tx, storeId: string): Promise<string | undefined> {
  const res = await tx.execute(sql`select org_id from stores where id = ${storeId}`);
  return (res as unknown as { org_id: string }[])[0]?.org_id;
}

/** The terminal person of the store's ACTIVE terminal link (pos_terminal_links), or undefined: whose PIN bucket a manager-PIN approval charges. */
export async function getActiveTerminalPersonId(tx: Tx, orgId: string, storeId: string): Promise<string | undefined> {
  const res = await tx.execute(sql`select terminal_person_id from pos_terminal_links where org_id = ${orgId} and store_id = ${storeId} and revoked_at is null limit 1`);
  return (res as unknown as { terminal_person_id: string }[])[0]?.terminal_person_id;
}

export async function getStoreCode(tx: Tx, orgId: string, storeId: string): Promise<string | undefined> {
  const res = await tx.execute(sql`select code from stores where id = ${storeId} and org_id = ${orgId}`);
  return (res as unknown as { code: string }[])[0]?.code;
}

/** The organization's tax type as stored ('vat' | ...); descriptive only (bible row 75). */
export async function getOrgTaxType(tx: Tx, orgId: string): Promise<string | undefined> {
  const res = await tx.execute(sql`select tax_type from organizations where id = ${orgId}`);
  return (res as unknown as { tax_type: string }[])[0]?.tax_type;
}

export async function insertSession(
  tx: Tx,
  row: {
    id: string;
    orgId: string;
    storeId: string;
    standId: string | null;
    mode: 'dine_in' | 'take_out';
    headsCashier: number;
    openedBy: string;
    openedAtDevice: Date;
    openedOnPairingId: string;
  },
): Promise<void> {
  await tx.insert(tableSessions).values(row);
}

/** The session row locked FOR UPDATE (serialises two tablets acting on one table). */
export async function lockSession(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<TableSessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(tableSessions)
    .where(and(eq(tableSessions.id, sessionId), eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId)))
    .for('update');
  return row;
}

export async function setSessionHeads(
  tx: Tx,
  orgId: string,
  storeId: string,
  sessionId: string,
  heads: { headsCashier?: number; headsServer?: number },
): Promise<void> {
  await tx
    .update(tableSessions)
    .set(heads)
    .where(and(eq(tableSessions.id, sessionId), eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId)));
}

export async function markSessionPaid(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<void> {
  await tx
    .update(tableSessions)
    .set({ status: 'paid' })
    .where(and(eq(tableSessions.id, sessionId), eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId)));
}

export async function markSessionVoided(
  tx: Tx,
  orgId: string,
  storeId: string,
  sessionId: string,
  v: { voidedBy: string; voidedAtDevice: Date; voidReason: string; voidedOffline: boolean },
): Promise<void> {
  await tx
    .update(tableSessions)
    .set({ status: 'voided', ...v })
    .where(and(eq(tableSessions.id, sessionId), eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId)));
}

export interface NewSessionLine {
  id: string;
  orgId: string;
  storeId: string;
  sessionId: string;
  kind: 'package' | 'item' | 'refill';
  menuItemId: string;
  menuItemVariantId: string | null;
  name: string;
  qty: number;
  unitPrice: Money;
  /** N > 1 for a "(up to N)" bundle line, else null. */
  bundleHeads: number | null;
  kitchenStationId: string | null;
  note: string | null;
  addedBy: string;
  addedOnPairingId: string | null;
  addedAtDevice: Date;
  /** Only to give a re-made line the place of the one it replaces (T-527b); normally the server clock at insert. */
  addedAt?: Date;
}

export async function insertLines(tx: Tx, rows: NewSessionLine[]): Promise<void> {
  // added_at is the server clock per ROW (clock_timestamp, not the transaction's now()): a batch keeps its order when two lines share a device time.
  if (rows.length === 0) return;
  await tx.insert(tableSessionLines).values(
    rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      storeId: r.storeId,
      sessionId: r.sessionId,
      kind: r.kind,
      menuItemId: r.menuItemId,
      menuItemVariantId: r.menuItemVariantId,
      name: r.name,
      qty: r.qty,
      unitPrice: r.unitPrice,
      bundleHeads: r.bundleHeads,
      kitchenStationId: r.kitchenStationId,
      note: r.note,
      addedBy: r.addedBy,
      addedOnPairingId: r.addedOnPairingId,
      addedAtDevice: r.addedAtDevice,
      addedAt: r.addedAt ?? sql`clock_timestamp()`,
    })),
  );
}

export async function getLine(tx: Tx, orgId: string, storeId: string, lineId: string): Promise<TableSessionLineRow | undefined> {
  const [row] = await tx
    .select()
    .from(tableSessionLines)
    .where(and(eq(tableSessionLines.id, lineId), eq(tableSessionLines.orgId, orgId), eq(tableSessionLines.storeId, storeId)));
  return row;
}

export async function getLinesByIds(tx: Tx, orgId: string, storeId: string, ids: string[]): Promise<TableSessionLineRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(tableSessionLines)
    .where(and(inArray(tableSessionLines.id, ids), eq(tableSessionLines.orgId, orgId), eq(tableSessionLines.storeId, storeId)));
}

export async function markLineServed(tx: Tx, orgId: string, storeId: string, lineId: string, by: string, at: Date): Promise<void> {
  await tx
    .update(tableSessionLines)
    .set({ kitchenStatus: 'served', servedBy: by, servedAtDevice: at })
    .where(and(eq(tableSessionLines.id, lineId), eq(tableSessionLines.orgId, orgId), eq(tableSessionLines.storeId, storeId)));
}

export async function markLinesCancelled(tx: Tx, orgId: string, storeId: string, lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
  await tx
    .update(tableSessionLines)
    .set({ kitchenStatus: 'cancelled' })
    .where(and(inArray(tableSessionLines.id, lineIds), eq(tableSessionLines.orgId, orgId), eq(tableSessionLines.storeId, storeId)));
}

export async function getPreset(tx: Tx, orgId: string, storeId: string, presetId: string): Promise<PosDiscountPresetRow | undefined> {
  const [row] = await tx
    .select()
    .from(posDiscountPresets)
    .where(and(eq(posDiscountPresets.id, presetId), eq(posDiscountPresets.orgId, orgId), eq(posDiscountPresets.storeId, storeId)));
  return row;
}

export interface NewLineDiscount {
  id: string;
  orgId: string;
  storeId: string;
  sessionLineId: string;
  kind: 'senior' | 'pwd' | 'preset' | 'custom';
  presetId: string | null;
  valueType: 'percent' | 'fixed';
  value: Money;
  qty: number;
  dinerNo: number | null;
  appliedBy: string;
  appliedAtDevice: Date;
}

export async function insertLineDiscounts(tx: Tx, rows: NewLineDiscount[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(tableSessionLineDiscounts).values(
    rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      storeId: r.storeId,
      sessionLineId: r.sessionLineId,
      kind: r.kind,
      presetId: r.presetId,
      valueType: r.valueType,
      value: r.value,
      qty: r.qty,
      dinerNo: r.dinerNo,
      appliedBy: r.appliedBy,
      appliedAtDevice: r.appliedAtDevice,
    })),
  );
}

export async function getLineDiscount(tx: Tx, orgId: string, storeId: string, discountId: string): Promise<TableSessionLineDiscountRow | undefined> {
  const [row] = await tx
    .select()
    .from(tableSessionLineDiscounts)
    .where(and(eq(tableSessionLineDiscounts.id, discountId), eq(tableSessionLineDiscounts.orgId, orgId), eq(tableSessionLineDiscounts.storeId, storeId)));
  return row;
}

/** Every discount (active and removed) of the given lines, in creation order: device time, then id. */
export async function listLineDiscounts(tx: Tx, orgId: string, storeId: string, lineIds: string[]): Promise<TableSessionLineDiscountRow[]> {
  if (lineIds.length === 0) return [];
  return tx
    .select()
    .from(tableSessionLineDiscounts)
    .where(and(inArray(tableSessionLineDiscounts.sessionLineId, lineIds), eq(tableSessionLineDiscounts.orgId, orgId), eq(tableSessionLineDiscounts.storeId, storeId)))
    .orderBy(asc(tableSessionLineDiscounts.appliedAtDevice), asc(tableSessionLineDiscounts.id));
}

export async function removeLineDiscounts(tx: Tx, orgId: string, storeId: string, discountIds: string[], by: string, at: Date): Promise<void> {
  if (discountIds.length === 0) return;
  await tx
    .update(tableSessionLineDiscounts)
    .set({ status: 'removed', removedBy: by, removedAtDevice: at })
    .where(and(inArray(tableSessionLineDiscounts.id, discountIds), eq(tableSessionLineDiscounts.orgId, orgId), eq(tableSessionLineDiscounts.storeId, storeId)));
}

export async function listTenders(tx: Tx, orgId: string, tenderIds: string[]): Promise<{ id: string; storeId: string; kind: 'cash' | 'wallet'; isActive: boolean }[]> {
  if (tenderIds.length === 0) return [];
  return tx
    .select({ id: tenders.id, storeId: tenders.storeId, kind: tenders.kind, isActive: tenders.isActive })
    .from(tenders)
    .where(and(inArray(tenders.id, tenderIds), eq(tenders.orgId, orgId)));
}

export async function getReceiptBySession(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<PosSalesReceiptRow | undefined> {
  const [row] = await tx
    .select()
    .from(posSalesReceipts)
    .where(and(eq(posSalesReceipts.tableSessionId, sessionId), eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId)));
  return row;
}

export async function terminalSeqUsed(tx: Tx, orgId: string, terminalId: string, terminalSeq: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: posSalesReceipts.id })
    .from(posSalesReceipts)
    .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.terminalId, terminalId), eq(posSalesReceipts.terminalSeq, terminalSeq)));
  return row !== undefined;
}

export interface NewReceipt {
  id: string;
  orgId: string;
  storeId: string;
  terminalId: string;
  terminalSeq: number;
  tableSessionId: string;
  cashierId: string;
  issuedAtDevice: Date;
  subtotal: Money;
  discountTotal: Money;
  total: Money;
  deviceTotal: Money;
  offline: boolean;
}
export interface NewReceiptLine {
  id: string;
  orgId: string;
  receiptId: string;
  lineNo: number;
  sessionLineId: string;
  kind: 'package' | 'item' | 'refill';
  name: string;
  qty: number;
  unitPrice: Money;
  gross: Money;
  discountTotal: Money;
  net: Money;
}
export interface NewReceiptPayment {
  orgId: string;
  receiptId: string;
  tenderId: string;
  amount: Money;
  changeGiven: Money;
  referenceNo: string | null;
  toCheck: boolean;
}
export interface NewReceiptLineDiscount {
  orgId: string;
  receiptLineId: string;
  kind: 'senior' | 'pwd' | 'preset' | 'custom';
  presetId: string | null;
  label: string;
  valueType: 'percent' | 'fixed';
  value: Money;
  qty: number;
  dinerNo: number | null;
  vatRemoved: Money;
  discountAmount: Money;
  statutoryRecordId: string | null;
}

/** Parent first, then its children, in the CALLER'S one transaction (migration 0240's append guard refuses a child under an earlier transaction's receipt). */
export async function insertReceipt(tx: Tx, r: NewReceipt): Promise<void> {
  await tx.insert(posSalesReceipts).values({
    id: r.id,
    orgId: r.orgId,
    storeId: r.storeId,
    terminalId: r.terminalId,
    terminalSeq: r.terminalSeq,
    tableSessionId: r.tableSessionId,
    cashierId: r.cashierId,
    issuedAtDevice: r.issuedAtDevice,
    subtotal: r.subtotal,
    discountTotal: r.discountTotal,
    total: r.total,
    deviceTotal: r.deviceTotal,
    offline: r.offline,
  });
}
export async function insertReceiptLines(tx: Tx, rows: NewReceiptLine[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(posSalesReceiptLines).values(
    rows.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      receiptId: r.receiptId,
      lineNo: r.lineNo,
      sessionLineId: r.sessionLineId,
      kind: r.kind,
      name: r.name,
      qty: r.qty,
      unitPrice: r.unitPrice,
      gross: r.gross,
      discountTotal: r.discountTotal,
      net: r.net,
    })),
  );
}
export async function insertReceiptPayments(tx: Tx, rows: NewReceiptPayment[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(posSalesReceiptPayments).values(
    rows.map((r) => ({
      orgId: r.orgId,
      receiptId: r.receiptId,
      tenderId: r.tenderId,
      amount: r.amount,
      changeGiven: r.changeGiven,
      referenceNo: r.referenceNo,
      toCheck: r.toCheck,
    })),
  );
}
export async function insertReceiptLineDiscounts(tx: Tx, rows: NewReceiptLineDiscount[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(posSalesReceiptLineDiscounts).values(
    rows.map((r) => ({
      orgId: r.orgId,
      receiptLineId: r.receiptLineId,
      kind: r.kind,
      presetId: r.presetId,
      label: r.label,
      valueType: r.valueType,
      value: r.value,
      qty: r.qty,
      dinerNo: r.dinerNo,
      vatRemoved: r.vatRemoved,
      discountAmount: r.discountAmount,
      statutoryRecordId: r.statutoryRecordId,
    })),
  );
}

/** The window_end of the store's latest Z (any terminal), or undefined before the first Z. */
export async function lastDayCloseEnd(tx: Tx, orgId: string, storeId: string): Promise<Date | undefined> {
  const [row] = await tx
    .select({ windowEnd: posDayCloses.windowEnd })
    .from(posDayCloses)
    .where(and(eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId)))
    .orderBy(desc(posDayCloses.windowEnd))
    .limit(1);
  return row?.windowEnd;
}

/** Sales receipts of the open Z window (issued at or after `since`; all of them before the first Z), newest first. */
export async function listReceiptsSince(tx: Tx, orgId: string, storeId: string, since: Date | undefined): Promise<PosSalesReceiptRow[]> {
  const where = and(
    eq(posSalesReceipts.orgId, orgId),
    eq(posSalesReceipts.storeId, storeId),
    since ? sql`${posSalesReceipts.issuedAtDevice} >= ${since}` : undefined,
  );
  return tx.select().from(posSalesReceipts).where(where).orderBy(desc(posSalesReceipts.issuedAtDevice), desc(posSalesReceipts.id));
}

/** Open sessions with their stand number (the floor view). */
export async function listOpenSessionsWithStand(tx: Tx, orgId: string, storeId: string) {
  return tx
    .select({ session: tableSessions, standNumber: posStands.number })
    .from(tableSessions)
    .leftJoin(posStands, and(eq(posStands.id, tableSessions.standId), eq(posStands.storeId, tableSessions.storeId)))
    .where(and(eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId), eq(tableSessions.status, 'open')))
    .orderBy(asc(tableSessions.openedAt), asc(tableSessions.id));
}

/** Session lines of a store still queued (kitchen), optionally one station, optionally only refills; voided sessions left out. */
export async function listQueuedLines(tx: Tx, orgId: string, storeId: string, o: { stationId?: string; refillsOnly?: boolean } = {}) {
  return tx
    .select({ line: tableSessionLines, standNumber: posStands.number, sessionMode: tableSessions.mode, askedBy: persons.displayName })
    .from(tableSessionLines)
    .innerJoin(tableSessions, and(eq(tableSessions.id, tableSessionLines.sessionId), eq(tableSessions.storeId, tableSessionLines.storeId)))
    .leftJoin(posStands, and(eq(posStands.id, tableSessions.standId), eq(posStands.storeId, tableSessions.storeId)))
    .leftJoin(persons, and(eq(persons.orgId, tableSessionLines.orgId), eq(persons.id, tableSessionLines.addedBy)))
    .where(
      and(
        eq(tableSessionLines.orgId, orgId),
        eq(tableSessionLines.storeId, storeId),
        eq(tableSessionLines.kitchenStatus, 'queued'),
        ne(tableSessions.status, 'voided'),
        o.stationId ? eq(tableSessionLines.kitchenStationId, o.stationId) : undefined,
        o.refillsOnly ? eq(tableSessionLines.kind, 'refill') : undefined,
      ),
    )
    .orderBy(asc(tableSessionLines.addedAtDevice), asc(tableSessionLines.id));
}

/** T-529: the open dine-in tables holding a live package line (the refill picker), one row per package line, by stand number. */
export async function listRefillableTables(tx: Tx, orgId: string, storeId: string) {
  return tx
    .select({ sessionId: tableSessions.id, standNumber: posStands.number, headsCashier: tableSessions.headsCashier, headsServer: tableSessions.headsServer, packageVariantId: tableSessionLines.menuItemVariantId })
    .from(tableSessions)
    .innerJoin(posStands, and(eq(posStands.id, tableSessions.standId), eq(posStands.storeId, tableSessions.storeId)))
    .innerJoin(
      tableSessionLines,
      and(eq(tableSessionLines.sessionId, tableSessions.id), eq(tableSessionLines.storeId, tableSessions.storeId), eq(tableSessionLines.kind, 'package'), ne(tableSessionLines.kitchenStatus, 'cancelled')),
    )
    .where(and(eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId), eq(tableSessions.status, 'open'), eq(tableSessions.mode, 'dine_in')))
    .orderBy(asc(posStands.number), asc(tableSessionLines.addedAtDevice), asc(tableSessionLines.id));
}

// ---------------------------------------------------------------------------------------------------------------------
// T-525 - the events inbox, the snapshot and the state poll (packages/domain/src/pos/inbox.ts, snapshot.ts). No rule lives here.
// ---------------------------------------------------------------------------------------------------------------------

export interface NewPosEvent {
  orgId: string;
  storeId: string;
  pairingId: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  /** The person the device named. Stored NULL when that id is not a person of this organisation (the column has a same-org FK). */
  personId: string;
  occurredAtDevice: Date;
  status: 'applied' | 'quarantined';
  error: string | null;
}

/** Inserts one event row. A second `(pairing_id, seq)` raises 23505 `pos_events_pairing_seq_unique`: the caller reads that as "already received". */
export async function insertPosEvent(tx: Tx, e: NewPosEvent): Promise<{ id: string }> {
  const [row] = await tx
    .insert(posEvents)
    .values({
      orgId: e.orgId,
      storeId: e.storeId,
      pairingId: e.pairingId,
      seq: e.seq,
      kind: e.kind,
      payload: e.payload,
      personId: sql`(select p.id from persons p where p.id = ${e.personId} and p.org_id = ${e.orgId})`,
      occurredAtDevice: e.occurredAtDevice,
      status: e.status,
      error: e.error,
    })
    .returning({ id: posEvents.id });
  return row!;
}

export async function getPosEventByPairingSeq(tx: Tx, orgId: string, storeId: string, pairingId: string, seq: number): Promise<PosEventRow | undefined> {
  const [row] = await tx
    .select()
    .from(posEvents)
    .where(and(eq(posEvents.orgId, orgId), eq(posEvents.storeId, storeId), eq(posEvents.pairingId, pairingId), eq(posEvents.seq, seq)));
  return row;
}

/** One event by id (store-scoped). `forUpdate` locks it, so two managers resolving one row take turns. */
export async function getPosEvent(tx: Tx, orgId: string, storeId: string, id: string, o: { forUpdate?: boolean } = {}): Promise<PosEventRow | undefined> {
  const q = tx
    .select()
    .from(posEvents)
    .where(and(eq(posEvents.id, id), eq(posEvents.orgId, orgId), eq(posEvents.storeId, storeId)));
  const [row] = await (o.forUpdate ? q.for('update') : q);
  return row;
}

/** Sets the three resolution columns, once (the table's frozen trigger allows nothing else). False when the row was already resolved. */
export async function resolvePosEvent(
  tx: Tx,
  orgId: string,
  storeId: string,
  id: string,
  r: { resolvedBy: string; resolution: 'replayed' | 'discarded' },
): Promise<boolean> {
  const rows = await tx
    .update(posEvents)
    .set({ resolvedBy: r.resolvedBy, resolvedAt: sql`now()`, resolution: r.resolution })
    .where(and(eq(posEvents.id, id), eq(posEvents.orgId, orgId), eq(posEvents.storeId, storeId), isNull(posEvents.resolvedAt)))
    .returning({ id: posEvents.id });
  return rows.length > 0;
}

/** The highest stored seq of the pairing, any status; 0 before the first. */
export async function maxSeqForPairing(tx: Tx, orgId: string, storeId: string, pairingId: string): Promise<number> {
  const [row] = await tx
    .select({ m: sql<string>`coalesce(max(${posEvents.seq}), 0)::text` })
    .from(posEvents)
    .where(and(eq(posEvents.orgId, orgId), eq(posEvents.storeId, storeId), eq(posEvents.pairingId, pairingId)));
  return Number(row?.m ?? 0);
}

/** The highest receipt number printed on this store's terminal; 0 before the first sale. */
export async function maxTerminalSeq(tx: Tx, orgId: string, storeId: string, terminalNo: number): Promise<number> {
  const [row] = await tx
    .select({ m: sql<string>`coalesce(max(${posSalesReceipts.terminalSeq}), 0)::text` })
    .from(posSalesReceipts)
    .innerJoin(posTerminals, eq(posTerminals.id, posSalesReceipts.terminalId))
    .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId), eq(posTerminals.terminalNo, terminalNo)));
  return Number(row?.m ?? 0);
}

export async function listActiveStands(tx: Tx, orgId: string, storeId: string): Promise<PosStandRow[]> {
  return tx
    .select()
    .from(posStands)
    .where(and(eq(posStands.orgId, orgId), eq(posStands.storeId, storeId), eq(posStands.status, 'active')))
    .orderBy(asc(posStands.number));
}

export async function listActivePresets(tx: Tx, orgId: string, storeId: string): Promise<PosDiscountPresetRow[]> {
  return tx
    .select()
    .from(posDiscountPresets)
    .where(and(eq(posDiscountPresets.orgId, orgId), eq(posDiscountPresets.storeId, storeId), eq(posDiscountPresets.status, 'active')))
    .orderBy(asc(posDiscountPresets.name), asc(posDiscountPresets.id));
}

/** The till this pairing currently acts as (`pos_terminals.pairing_id`), or undefined. */
export async function getTerminalForPairing(tx: Tx, orgId: string, storeId: string, pairingId: string): Promise<PosTerminalRow | undefined> {
  const [row] = await tx
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.orgId, orgId), eq(posTerminals.storeId, storeId), eq(posTerminals.pairingId, pairingId)));
  return row;
}

/** The store's polling counter (one indexed row), or undefined when the store has no switch row. */
export async function getStateVersion(tx: Tx, orgId: string, storeId: string): Promise<number | undefined> {
  const [row] = await tx
    .select({ v: posStores.stateVersion })
    .from(posStores)
    .where(and(eq(posStores.orgId, orgId), eq(posStores.storeId, storeId)));
  return row?.v;
}

/**
 * R4 clause 3: did this person sign in with a PIN on THIS pairing, issued in [from, to]? An ended session counts, except one that was revoked.
 * `sessions.device_id` is text, so the pairing id is compared as text.
 */
export async function hasPinSessionOnPairing(tx: Tx, orgId: string, personId: string, storeId: string, pairingId: string, from: Date, to: Date): Promise<boolean> {
  const rows = (await tx.execute(sql`
    select 1 as ok
      from sessions s
      join persons p on p.id = s.person_id
     where p.org_id = ${orgId}
       and s.person_id = ${personId}
       and s.store_id = ${storeId}
       and s.device_id = ${pairingId}::text
       and s.credential_kind = 'pin'
       and s.issued_at >= ${from.toISOString()}::timestamptz
       and s.issued_at <= ${to.toISOString()}::timestamptz
       and (s.ended_reason is null or s.ended_reason <> 'revoked')
     limit 1
  `)) as unknown as { ok: number }[];
  return rows.length > 0;
}

/** R4 clause 1: the person, if they belong to this organisation (RLS hides another organisation's people too). */
export async function getPersonOfOrg(tx: Tx, orgId: string, personId: string): Promise<{ id: string; displayName: string; isActive: boolean } | undefined> {
  const [row] = await tx
    .select({ id: persons.id, displayName: persons.displayName, isActive: persons.isActive })
    .from(persons)
    .where(and(eq(persons.orgId, orgId), eq(persons.id, personId)));
  return row;
}

export async function listPersonNames(tx: Tx, orgId: string, personIds: string[]): Promise<Map<string, string>> {
  if (personIds.length === 0) return new Map();
  const rows = await tx.select({ id: persons.id, displayName: persons.displayName }).from(persons).where(and(eq(persons.orgId, orgId), inArray(persons.id, personIds)));
  return new Map(rows.map((r) => [r.id, r.displayName]));
}

/** Active people with an OPEN employment at the store, with their staff code (`SE-007`): the candidates for the tablet's sign-in list. The caller applies `personMaySignInAtStore`. */
export async function listOpenEmploymentsAtStore(tx: Tx, orgId: string, storeId: string): Promise<{ personId: string; displayName: string; staffCode: string }[]> {
  return tx
    .select({ personId: employments.personId, displayName: persons.displayName, staffCode: employments.staffCode })
    .from(employments)
    .innerJoin(persons, and(eq(persons.id, employments.personId), eq(persons.orgId, employments.orgId)))
    .where(and(eq(employments.orgId, orgId), eq(employments.storeId, storeId), isNull(employments.endedOn), eq(persons.isActive, true)))
    .orderBy(asc(employments.staffCode));
}

// ---------------------------------------------------------------------------------------------------------------------
// T-546: the tills of a store (pos_terminals) and their receipt printer settings. The domain (`pos/terminals.ts`) decides every rule; these only read and write.
// ---------------------------------------------------------------------------------------------------------------------
export interface TillRow {
  readonly id: string;
  readonly terminalNo: number;
  readonly pairingId: string | null;
  readonly pairingLabel: string | null;
  readonly receiptPaperMm: number;
  readonly receiptCopies: number;
}

/** The store's tills in number order, each with the label of the tablet acting as it (null when none). */
export async function listTillsForStore(tx: Tx, orgId: string, storeId: string): Promise<TillRow[]> {
  return tx
    .select({
      id: posTerminals.id,
      terminalNo: posTerminals.terminalNo,
      pairingId: posTerminals.pairingId,
      pairingLabel: posTabletPairings.label,
      receiptPaperMm: posTerminals.receiptPaperMm,
      receiptCopies: posTerminals.receiptCopies,
    })
    .from(posTerminals)
    .leftJoin(posTabletPairings, eq(posTabletPairings.id, posTerminals.pairingId))
    .where(and(eq(posTerminals.orgId, orgId), eq(posTerminals.storeId, storeId)))
    .orderBy(asc(posTerminals.terminalNo));
}

/** The store's live (not revoked) pairings that act as no till yet: the tablets a manager may choose. */
export async function listFreeLivePairings(tx: Tx, orgId: string, storeId: string): Promise<{ id: string; label: string }[]> {
  return tx
    .select({ id: posTabletPairings.id, label: posTabletPairings.label })
    .from(posTabletPairings)
    .where(
      and(
        eq(posTabletPairings.orgId, orgId),
        eq(posTabletPairings.storeId, storeId),
        isNull(posTabletPairings.revokedAt),
        sql`not exists (select 1 from ${posTerminals} where ${posTerminals.pairingId} = ${posTabletPairings.id})`,
      ),
    )
    .orderBy(asc(posTabletPairings.pairedAt), asc(posTabletPairings.id));
}

/** One till of this store, locked for the change that follows (store-scoped: another store's till is never found). */
export async function getTillForUpdate(tx: Tx, orgId: string, storeId: string, terminalId: string): Promise<PosTerminalRow | undefined> {
  const [row] = await tx
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.id, terminalId), eq(posTerminals.orgId, orgId), eq(posTerminals.storeId, storeId)))
    .for('update');
  return row;
}

export async function insertTill(tx: Tx, input: { orgId: string; storeId: string; terminalNo: number; createdBy: string }): Promise<PosTerminalRow> {
  const [row] = await tx.insert(posTerminals).values(input).returning();
  return row!;
}

/** Points the till at a tablet, or at none (null). `pairing_id` and `updated_at` are the only columns shareat_app may change besides the printer ones. */
export async function setTillPairing(tx: Tx, orgId: string, storeId: string, terminalId: string, pairingId: string | null): Promise<void> {
  await tx
    .update(posTerminals)
    .set({ pairingId, updatedAt: sql`now()` })
    .where(and(eq(posTerminals.id, terminalId), eq(posTerminals.orgId, orgId), eq(posTerminals.storeId, storeId)));
}

export async function setTillPrinter(tx: Tx, orgId: string, storeId: string, terminalId: string, receiptPaperMm: number, receiptCopies: number): Promise<void> {
  await tx
    .update(posTerminals)
    .set({ receiptPaperMm, receiptCopies, updatedAt: sql`now()` })
    .where(and(eq(posTerminals.id, terminalId), eq(posTerminals.orgId, orgId), eq(posTerminals.storeId, storeId)));
}

// ---------------------------------------------------------------------------------------------------------------------
// T-531 - the day close (the Z): reads for the reading, the one-time receipt freeze, the Z rows. No rule lives here
// (packages/domain/src/pos/day-close.ts decides). docs/tasks/531-pos-day-close.md.
// ---------------------------------------------------------------------------------------------------------------------

/** The store's latest Z by BUSINESS DATE (any terminal), as `YYYY-MM-DD`, or undefined before the first Z. T-531 ruling 1: the next Z, and every receipt after it, is dated after this. */
export async function lastDayCloseBusinessDate(tx: Tx, orgId: string, storeId: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ d: sql<string | null>`max(${posDayCloses.businessDate})::text` })
    .from(posDayCloses)
    .where(and(eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId)));
  return row?.d ?? undefined;
}

/** The latest Z of ONE terminal (by z_no), or undefined before its first. */
export async function lastDayCloseOfTerminal(tx: Tx, orgId: string, storeId: string, terminalId: string): Promise<PosDayCloseRow | undefined> {
  const [row] = await tx
    .select()
    .from(posDayCloses)
    .where(and(eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId), eq(posDayCloses.terminalId, terminalId)))
    .orderBy(desc(posDayCloses.zNo))
    .limit(1);
  return row;
}

export async function getDayClose(tx: Tx, orgId: string, storeId: string, id: string): Promise<PosDayCloseRow | undefined> {
  const [row] = await tx
    .select()
    .from(posDayCloses)
    .where(and(eq(posDayCloses.id, id), eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId)));
  return row;
}

/** One terminal of the store by id. */
export async function getTerminal(tx: Tx, orgId: string, storeId: string, terminalId: string): Promise<PosTerminalRow | undefined> {
  const [row] = await tx
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.id, terminalId), eq(posTerminals.orgId, orgId), eq(posTerminals.storeId, storeId)));
  return row;
}

/** The receipts of one terminal not yet in any Z (day_close_id IS NULL), oldest first. */
export async function listOpenReceipts(tx: Tx, orgId: string, storeId: string, terminalId: string): Promise<PosSalesReceiptRow[]> {
  return tx
    .select()
    .from(posSalesReceipts)
    .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId), eq(posSalesReceipts.terminalId, terminalId), isNull(posSalesReceipts.dayCloseId)))
    .orderBy(asc(posSalesReceipts.issuedAtDevice), asc(posSalesReceipts.id));
}

/** The receipts frozen to one Z, oldest first. */
export async function listReceiptsOfClose(tx: Tx, orgId: string, storeId: string, dayCloseId: string): Promise<PosSalesReceiptRow[]> {
  return tx
    .select()
    .from(posSalesReceipts)
    .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId), eq(posSalesReceipts.dayCloseId, dayCloseId)))
    .orderBy(asc(posSalesReceipts.issuedAtDevice), asc(posSalesReceipts.id));
}

export interface NewDayClose {
  id: string;
  orgId: string;
  storeId: string;
  terminalId: string;
  zNo: number;
  businessDate: string;
  windowStart: Date;
  windowEnd: Date;
  receiptCount: number;
  grossTotal: Money;
  closedBy: string;
  approvedBy: string;
}

export async function insertDayClose(tx: Tx, z: NewDayClose): Promise<void> {
  await tx.insert(posDayCloses).values(z);
}

export async function insertDayCloseTenders(tx: Tx, rows: { orgId: string; dayCloseId: string; tenderId: string; amount: Money }[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(posDayCloseTenders).values(rows);
}

/**
 * Freezes the receipts to the Z: sets `day_close_id` (the one column the 0238 grant lets the app write, NULL -> value once). `WHERE day_close_id IS NULL`, so a
 * receipt a racing close already took is not touched; the CALLER compares the returned row count with the count it read and refuses when they differ.
 */
export async function closeReceipts(tx: Tx, orgId: string, storeId: string, dayCloseId: string, receiptIds: string[]): Promise<number> {
  if (receiptIds.length === 0) return 0;
  const rows = await tx
    .update(posSalesReceipts)
    .set({ dayCloseId })
    .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId), inArray(posSalesReceipts.id, receiptIds), isNull(posSalesReceipts.dayCloseId)))
    .returning({ id: posSalesReceipts.id });
  return rows.length;
}

export interface DayCloseWithTenders {
  close: PosDayCloseRow;
  tenders: { tenderId: string; amount: string }[];
}

async function withTenders(tx: Tx, orgId: string, closes: PosDayCloseRow[]): Promise<DayCloseWithTenders[]> {
  if (closes.length === 0) return [];
  const rows = await tx
    .select({ dayCloseId: posDayCloseTenders.dayCloseId, tenderId: posDayCloseTenders.tenderId, amount: posDayCloseTenders.amount })
    .from(posDayCloseTenders)
    .where(and(eq(posDayCloseTenders.orgId, orgId), inArray(posDayCloseTenders.dayCloseId, closes.map((c) => c.id))));
  return closes.map((close) => ({ close, tenders: rows.filter((r) => r.dayCloseId === close.id).map((r) => ({ tenderId: r.tenderId, amount: r.amount })) }));
}

/** The store's Zs (all terminals), newest first, with their tender rows. */
export async function listDayCloses(tx: Tx, orgId: string, storeId: string, limit: number): Promise<DayCloseWithTenders[]> {
  const closes = await tx
    .select()
    .from(posDayCloses)
    .where(and(eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId)))
    .orderBy(desc(posDayCloses.businessDate), desc(posDayCloses.zNo))
    .limit(limit);
  return withTenders(tx, orgId, closes);
}

/** Every Z of the store on one business date (any terminal) with its tender rows, in z_no order. */
export async function listDayClosesOfDate(tx: Tx, orgId: string, storeId: string, businessDate: string): Promise<DayCloseWithTenders[]> {
  const closes = await tx
    .select()
    .from(posDayCloses)
    .where(and(eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId), eq(posDayCloses.businessDate, businessDate)))
    .orderBy(asc(posDayCloses.zNo));
  return withTenders(tx, orgId, closes);
}

/** Sums over the receipts of one window, as exact decimal text (the domain turns them into Money). */
export interface ReceiptFigures {
  /** Σ gross of package lines, Σ gross of every other line. */
  packageGross: string;
  otherGross: string;
  /** Σ (vat_removed + discount_amount) per discount kind. */
  discountByKind: Record<'senior' | 'pwd' | 'preset' | 'custom', string>;
  /** Distinct statutory rows (senior / PWD diners). */
  statutoryDiners: number;
  /** Per tender: Σ amount, Σ change given, and how many payments are offline wallet payments still to check. */
  byTender: { tenderId: string; amount: string; change: string; toCheck: number }[];
  /** Package sessions (a receipt with a package line): their count and the Σ of their billed heads (the larger of the cashier's and the server's count). */
  packageSessions: number;
  heads: number;
}

const idList = (ids: readonly string[]): SQL => sql.join(ids.map((i) => sql`${i}`), sql`, `);

/** T-558: Σ amount tendered per receipt (decimal text), for the receipts that took any payment; a short payment is a receipt whose sum is below its total. */
export async function receiptPaidSums(tx: Tx, orgId: string, receiptIds: string[]): Promise<Map<string, string>> {
  if (receiptIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select p.receipt_id as receipt_id, sum(p.amount)::text as paid
      from pos_sales_receipt_payments p
     where p.org_id = ${orgId} and p.receipt_id in (${idList(receiptIds)})
     group by p.receipt_id`)) as unknown as { receipt_id: string; paid: string }[];
  return new Map(rows.map((r) => [r.receipt_id, r.paid]));
}

export async function receiptFigures(tx: Tx, orgId: string, receiptIds: string[]): Promise<ReceiptFigures> {
  const discountByKind = { senior: '0', pwd: '0', preset: '0', custom: '0' };
  if (receiptIds.length === 0) return { packageGross: '0', otherGross: '0', discountByKind, statutoryDiners: 0, byTender: [], packageSessions: 0, heads: 0 };
  const ids = idList(receiptIds);
  const lines = (await tx.execute(sql`
    select coalesce(sum(l.gross) filter (where l.kind = 'package'), 0)::text as pkg, coalesce(sum(l.gross) filter (where l.kind <> 'package'), 0)::text as other
      from pos_sales_receipt_lines l
     where l.org_id = ${orgId} and l.receipt_id in (${ids})`)) as unknown as { pkg: string; other: string }[];
  const disc = (await tx.execute(sql`
    select d.kind as kind, sum(d.vat_removed + d.discount_amount)::text as total
      from pos_sales_receipt_line_discounts d
      join pos_sales_receipt_lines l on l.id = d.receipt_line_id
     where d.org_id = ${orgId} and l.receipt_id in (${ids})
     group by d.kind`)) as unknown as { kind: 'senior' | 'pwd' | 'preset' | 'custom'; total: string }[];
  const diners = (await tx.execute(sql`
    select count(distinct d.statutory_record_id)::int as n
      from pos_sales_receipt_line_discounts d
      join pos_sales_receipt_lines l on l.id = d.receipt_line_id
     where d.org_id = ${orgId} and l.receipt_id in (${ids})`)) as unknown as { n: number }[];
  const pays = (await tx.execute(sql`
    select p.tender_id as tender_id, sum(p.amount)::text as amount, sum(p.change_given)::text as change, (count(*) filter (where p.to_check))::int as to_check
      from pos_sales_receipt_payments p
     where p.org_id = ${orgId} and p.receipt_id in (${ids})
     group by p.tender_id`)) as unknown as { tender_id: string; amount: string; change: string; to_check: number }[];
  const sessions = (await tx.execute(sql`
    select count(*)::int as n, coalesce(sum(greatest(s.heads_cashier, coalesce(s.heads_server, 0))), 0)::int as heads
      from pos_sales_receipts r
      join table_sessions s on s.id = r.table_session_id
     where r.org_id = ${orgId} and r.id in (${ids})
       and exists (select 1 from pos_sales_receipt_lines l where l.receipt_id = r.id and l.kind = 'package')`)) as unknown as { n: number; heads: number }[];
  for (const d of disc) discountByKind[d.kind] = d.total;
  return {
    packageGross: lines[0]?.pkg ?? '0',
    otherGross: lines[0]?.other ?? '0',
    discountByKind,
    statutoryDiners: Number(diners[0]?.n ?? 0),
    byTender: pays.map((p) => ({ tenderId: p.tender_id, amount: p.amount, change: p.change, toCheck: Number(p.to_check) })),
    packageSessions: Number(sessions[0]?.n ?? 0),
    heads: Number(sessions[0]?.heads ?? 0),
  };
}
