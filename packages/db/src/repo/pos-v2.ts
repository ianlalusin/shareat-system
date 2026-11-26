/**
 * T-523 - the only place SQL is written for the POS v2 tables (migration 0238; schema in `packages/db/schema/pos-v2.ts`).
 * docs/tasks/523-pos-v2-schema.md. T-524 (docs/tasks/524-pos-v2-domain.md) adds the write helpers: the domain decides every rule,
 * these only write.
 *
 * Every function takes the caller's transaction first and filters by org AND store; RLS is the backstop. The domain bumps
 * `pos_stores.state_version` (`bumpStateVersion`) once per call that changes anything a screen shows.
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  posDayCloseTenders,
  posDayCloses,
  posChargePresets,
  posDiscountPresets,
  posEvents,
  posPaymentConversions,
  posRefundLines,
  posRefundPayments,
  posRefunds,
  posReservationDeposits,
  posReservations,
  posSalesReceiptCharges,
  posSalesReceiptLineDiscounts,
  posSalesReceiptLines,
  posSalesReceiptPayments,
  posSalesReceipts,
  posStands,
  posStores,
  posTenderCorrections,
  posTerminals,
  tableSessionCharges,
  tableSessionLineDiscounts,
  tableSessionLines,
  tableSessions,
  type PosChargePresetRow,
  type PosDayCloseRow,
  type PosDiscountPresetRow,
  type PosEventRow,
  type PosPaymentConversionRow,
  type PosRefundLineRow,
  type PosRefundPaymentRow,
  type PosRefundRow,
  type PosReservationDepositRow,
  type PosReservationRow,
  type PosSalesReceiptChargeRow,
  type PosSalesReceiptRow,
  type PosStandRow,
  type PosStoreRow,
  type PosTenderCorrectionRow,
  type PosTerminalRow,
  type TableSessionChargeRow,
  type TableSessionLineDiscountRow,
  type TableSessionLineRow,
  type TableSessionRow,
} from '../../schema/pos-v2';
import { employments } from '../../schema/employment';
import { menuOptionValues } from '../../schema/menu';
import { persons } from '../../schema/persons';
import { posTabletPairings } from '../../schema/pos-tablet-pairings';
import { tenders } from '../../schema/pos-v1';
import { statutoryDiscountRecords } from '../../schema/statutory-discounts';
import type { Money } from '@shareat/core/money';
import type { Tx } from '../client';

export type {
  PosChargePresetRow,
  PosDayCloseRow,
  PosDiscountPresetRow,
  PosEventRow,
  PosPaymentConversionRow,
  PosRefundLineRow,
  PosRefundPaymentRow,
  PosRefundRow,
  PosReservationDepositRow,
  PosReservationRow,
  PosSalesReceiptChargeRow,
  PosSalesReceiptRow,
  PosStandRow,
  PosStoreRow,
  PosTenderCorrectionRow,
  PosTerminalRow,
  TableSessionChargeRow,
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

/** T-563: the store's one live pairing (the tablet that is paired now), or undefined. */
export async function getLivePairingOfStore(tx: Tx, orgId: string, storeId: string): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: posTabletPairings.id })
    .from(posTabletPairings)
    .where(and(eq(posTabletPairings.orgId, orgId), eq(posTabletPairings.storeId, storeId), isNull(posTabletPairings.revokedAt)));
  return row;
}

/** T-563: a pairing of this store, LIVE OR REVOKED (the pairing an event was made on may have been replaced since), or undefined. */
export async function getPairingOfStore(tx: Tx, orgId: string, storeId: string, pairingId: string): Promise<{ id: string; revokedAt: Date | null } | undefined> {
  const [row] = await tx
    .select({ id: posTabletPairings.id, revokedAt: posTabletPairings.revokedAt })
    .from(posTabletPairings)
    .where(and(eq(posTabletPairings.id, pairingId), eq(posTabletPairings.orgId, orgId), eq(posTabletPairings.storeId, storeId)));
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
  /** Sorted, distinct chosen option value ids ([] = none, null = a legacy parent's line) - T-557. */
  optionValueIds: string[] | null;
  kitchenStationId: string | null;
  /** T-565: the daypart window version the offer was judged by; null for an all-day offer. */
  daypartVersionId: string | null;
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
      optionValueIds: r.optionValueIds,
      kitchenStationId: r.kitchenStationId,
      daypartVersionId: r.daypartVersionId,
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

/** The payments a receipt recorded: what a replay of the sale is compared with (T-556). */
export async function listReceiptPayments(tx: Tx, orgId: string, receiptId: string): Promise<{ tenderId: string; amount: string; referenceNo: string | null; toCheck: boolean }[]> {
  return tx
    .select({ tenderId: posSalesReceiptPayments.tenderId, amount: posSalesReceiptPayments.amount, referenceNo: posSalesReceiptPayments.referenceNo, toCheck: posSalesReceiptPayments.toCheck })
    .from(posSalesReceiptPayments)
    .where(and(eq(posSalesReceiptPayments.orgId, orgId), eq(posSalesReceiptPayments.receiptId, receiptId)));
}

/**
 * The senior/PWD card holders a POS sale wrote to the statutory register under its printed number. `dinerNo` is known only for a diner whose
 * discount left a receipt row (a discount that rounds to nothing leaves none), else null (T-556).
 */
export async function listReceiptStatutory(
  tx: Tx, orgId: string, storeId: string, receiptId: string, invoiceNumber: string,
): Promise<{ kind: 'senior' | 'pwd'; idNumber: string; holderName: string; dinerNo: number | null }[]> {
  const records = await tx
    .select({ id: statutoryDiscountRecords.id, kind: statutoryDiscountRecords.kind, idNumber: statutoryDiscountRecords.idNumber, holderName: statutoryDiscountRecords.holderName })
    .from(statutoryDiscountRecords)
    .where(and(eq(statutoryDiscountRecords.orgId, orgId), eq(statutoryDiscountRecords.storeId, storeId), eq(statutoryDiscountRecords.invoiceNumber, invoiceNumber), eq(statutoryDiscountRecords.source, 'pos')));
  const diners = await tx
    .selectDistinct({ recordId: posSalesReceiptLineDiscounts.statutoryRecordId, dinerNo: posSalesReceiptLineDiscounts.dinerNo })
    .from(posSalesReceiptLineDiscounts)
    .innerJoin(posSalesReceiptLines, eq(posSalesReceiptLines.id, posSalesReceiptLineDiscounts.receiptLineId))
    .where(and(eq(posSalesReceiptLines.orgId, orgId), eq(posSalesReceiptLines.receiptId, receiptId)));
  const dinerOf = new Map(diners.map((d) => [d.recordId, d.dinerNo]));
  return records.map((r) => ({ kind: r.kind, idNumber: r.idNumber, holderName: r.holderName, dinerNo: dinerOf.get(r.id) ?? null }));
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
  /** T-627: the store charges on the bill, outside `total` (the amount due is total + chargeTotal). Absent = 0. */
  chargeTotal?: Money;
  /** T-628: the part of the amount due paid from a held reservation deposit. Absent = 0. */
  depositApplied?: Money;
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
  optionValueIds: string[] | null;
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
    ...(r.chargeTotal !== undefined ? { chargeTotal: r.chargeTotal } : {}),
    ...(r.depositApplied !== undefined ? { depositApplied: r.depositApplied } : {}),
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
      optionValueIds: r.optionValueIds,
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

/** One receipt of the Receipts list: the receipt, its till number, the table it was for and what it was paid by. */
export interface ReceiptListRow {
  receiptId: string;
  sessionId: string;
  terminalId: string;
  /** Set once the receipt is in a Z (T-534 S3: a wrong payment method can no longer be corrected here). */
  dayCloseId: string | null;
  subtotal: string;
  discountTotal: string;
  terminalNo: number;
  terminalSeq: number;
  issuedAtDevice: Date;
  total: string;
  /** T-627: the store charges on the bill (the amount due is total + chargeTotal). */
  chargeTotal: string;
  offline: boolean;
  mode: 'dine_in' | 'take_out';
  /** The stand number, or null for take-out. */
  standNumber: number | null;
  /** The tender names joined with ' + ' ('Cash + GCash'), or null for a receipt with no payment row. */
  tenders: string | null;
}

/**
 * T-601 S2: the sales receipts of the open Z window (issued at or after `since`; all of them before the first Z), newest first, with what the Receipts screen shows - the
 * till number, the table and the tenders - in ONE query. Money stays text. `terminalId`'s till row, the session's stand and the payments are
 * joined without multiplying a receipt (payments fold into one `string_agg`).
 */
export async function listReceiptsSinceForList(tx: Tx, orgId: string, storeId: string, since: Date | undefined, match?: { terminalNo: number; terminalSeq: number }): Promise<ReceiptListRow[]> {
  const rows = await tx
    .select({
      receiptId: posSalesReceipts.id,
      sessionId: posSalesReceipts.tableSessionId,
      terminalId: posSalesReceipts.terminalId,
      dayCloseId: posSalesReceipts.dayCloseId,
      subtotal: posSalesReceipts.subtotal,
      discountTotal: posSalesReceipts.discountTotal,
      terminalNo: posTerminals.terminalNo,
      terminalSeq: posSalesReceipts.terminalSeq,
      issuedAtDevice: posSalesReceipts.issuedAtDevice,
      total: posSalesReceipts.total,
      chargeTotal: posSalesReceipts.chargeTotal,
      offline: posSalesReceipts.offline,
      mode: tableSessions.mode,
      standNumber: posStands.number,
      tenders: sql<string | null>`string_agg(distinct ${tenders.name}, ' + ' order by ${tenders.name})`,
    })
    .from(posSalesReceipts)
    .innerJoin(posTerminals, eq(posTerminals.id, posSalesReceipts.terminalId))
    .innerJoin(tableSessions, eq(tableSessions.id, posSalesReceipts.tableSessionId))
    .leftJoin(posStands, eq(posStands.id, tableSessions.standId))
    .leftJoin(posSalesReceiptPayments, eq(posSalesReceiptPayments.receiptId, posSalesReceipts.id))
    .leftJoin(tenders, eq(tenders.id, posSalesReceiptPayments.tenderId))
    .where(
      and(
        eq(posSalesReceipts.orgId, orgId),
        eq(posSalesReceipts.storeId, storeId),
        since ? gte(posSalesReceipts.issuedAtDevice, since) : undefined,
        // T-613 D4: one printed number (till + sequence on that till).
        match ? and(eq(posTerminals.terminalNo, match.terminalNo), eq(posSalesReceipts.terminalSeq, match.terminalSeq)) : undefined,
      ),
    )
    .groupBy(
      posSalesReceipts.id,
      posSalesReceipts.tableSessionId,
      posSalesReceipts.terminalId,
      posSalesReceipts.dayCloseId,
      posSalesReceipts.subtotal,
      posSalesReceipts.discountTotal,
      posTerminals.terminalNo,
      posSalesReceipts.terminalSeq,
      posSalesReceipts.issuedAtDevice,
      posSalesReceipts.total,
      posSalesReceipts.chargeTotal,
      posSalesReceipts.offline,
      tableSessions.mode,
      posStands.number,
    )
    .orderBy(desc(posSalesReceipts.issuedAtDevice), desc(posSalesReceipts.id));
  return rows as ReceiptListRow[];
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

/** T-529: the open dine-in tables holding a live package line (the refill picker), one row per package line, by stand number. T-643: `seatFlavours` = the names of the line's chosen options, in menu order. */
export async function listRefillableTables(tx: Tx, orgId: string, storeId: string) {
  return tx
    .select({
      sessionId: tableSessions.id,
      standNumber: posStands.number,
      headsCashier: tableSessions.headsCashier,
      headsServer: tableSessions.headsServer,
      packageVariantId: tableSessionLines.menuItemVariantId,
      seatFlavours: sql<string[]>`coalesce((select array_agg(${menuOptionValues.name} order by ${menuOptionValues.sortOrder}, ${menuOptionValues.name}) from ${menuOptionValues} where ${menuOptionValues.orgId} = ${tableSessionLines.orgId} and ${menuOptionValues.id} = any(${tableSessionLines.optionValueIds})), '{}'::text[])`,
    })
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

/** The highest receipt number printed on this terminal; 0 before the first sale. T-602: keyed on the terminal id (no join), so UNIQUE (terminal_id, receipt_seq) answers with one backward index step. */
export async function maxTerminalSeq(tx: Tx, orgId: string, terminalId: string): Promise<number> {
  const [row] = await tx
    .select({ m: sql<string>`coalesce(max(${posSalesReceipts.terminalSeq}), 0)::text` })
    .from(posSalesReceipts)
    .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.terminalId, terminalId)));
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

// ---------------------------------------------------------------------------------------------------------------------
// T-627 store charges (migration 0275): the store's list, the charges on an open table, the frozen copy on a receipt.
// ---------------------------------------------------------------------------------------------------------------------
export async function listActiveChargePresets(tx: Tx, orgId: string, storeId: string): Promise<PosChargePresetRow[]> {
  return tx
    .select()
    .from(posChargePresets)
    .where(and(eq(posChargePresets.orgId, orgId), eq(posChargePresets.storeId, storeId), eq(posChargePresets.status, 'active')))
    .orderBy(asc(posChargePresets.name), asc(posChargePresets.id));
}

export async function getChargePreset(tx: Tx, orgId: string, storeId: string, presetId: string): Promise<PosChargePresetRow | undefined> {
  const [row] = await tx
    .select()
    .from(posChargePresets)
    .where(and(eq(posChargePresets.id, presetId), eq(posChargePresets.orgId, orgId), eq(posChargePresets.storeId, storeId)));
  return row;
}

export interface NewSessionCharge {
  id: string;
  orgId: string;
  storeId: string;
  sessionId: string;
  presetId: string | null;
  name: string;
  unitAmount: Money;
  qty: number;
  addedBy: string;
  addedAtDevice: Date;
}
export async function insertSessionCharge(tx: Tx, r: NewSessionCharge): Promise<void> {
  await tx.insert(tableSessionCharges).values({ id: r.id, orgId: r.orgId, storeId: r.storeId, sessionId: r.sessionId, presetId: r.presetId, name: r.name, unitAmount: r.unitAmount, qty: r.qty, addedBy: r.addedBy, addedAtDevice: r.addedAtDevice });
}

export async function getSessionCharge(tx: Tx, orgId: string, storeId: string, chargeId: string): Promise<TableSessionChargeRow | undefined> {
  const [row] = await tx
    .select()
    .from(tableSessionCharges)
    .where(and(eq(tableSessionCharges.id, chargeId), eq(tableSessionCharges.orgId, orgId), eq(tableSessionCharges.storeId, storeId)));
  return row;
}

/** Every charge (active and removed) of a table, in creation order: device time, then id. */
export async function listSessionCharges(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<TableSessionChargeRow[]> {
  return tx
    .select()
    .from(tableSessionCharges)
    .where(and(eq(tableSessionCharges.sessionId, sessionId), eq(tableSessionCharges.orgId, orgId), eq(tableSessionCharges.storeId, storeId)))
    .orderBy(asc(tableSessionCharges.addedAtDevice), asc(tableSessionCharges.id));
}

export async function removeSessionCharges(tx: Tx, orgId: string, storeId: string, chargeIds: string[], by: string, at: Date): Promise<void> {
  if (chargeIds.length === 0) return;
  await tx
    .update(tableSessionCharges)
    .set({ status: 'removed', removedBy: by, removedAtDevice: at })
    .where(and(inArray(tableSessionCharges.id, chargeIds), eq(tableSessionCharges.orgId, orgId), eq(tableSessionCharges.storeId, storeId)));
}

export interface NewReceiptCharge {
  orgId: string;
  receiptId: string;
  chargeNo: number;
  sessionChargeId: string | null;
  presetId: string | null;
  name: string;
  unitAmount: Money;
  qty: number;
  amount: Money;
}
export async function insertReceiptCharges(tx: Tx, rows: NewReceiptCharge[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(posSalesReceiptCharges).values(rows);
}

/** The frozen charges of the given receipts, in receipt then charge order. */
export async function listReceiptCharges(tx: Tx, orgId: string, receiptIds: readonly string[]): Promise<PosSalesReceiptChargeRow[]> {
  if (receiptIds.length === 0) return [];
  return tx
    .select()
    .from(posSalesReceiptCharges)
    .where(and(inArray(posSalesReceiptCharges.receiptId, [...receiptIds]), eq(posSalesReceiptCharges.orgId, orgId)))
    .orderBy(asc(posSalesReceiptCharges.receiptId), asc(posSalesReceiptCharges.chargeNo));
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
export async function hasPinSessionOnPairing(
  tx: Tx,
  orgId: string,
  personId: string,
  storeId: string,
  pairingId: string,
  from: Date,
  to: Date,
  /** T-563 (carry-over from a REPLACED tablet): a session revoked at or after this moment still vouches, because the PIN was entered while the tablet was valid. */
  revokedAtOrAfter?: Date,
): Promise<boolean> {
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
       and (s.ended_reason is null or s.ended_reason <> 'revoked'${revokedAtOrAfter ? sql` or s.ended_at >= ${revokedAtOrAfter.toISOString()}::timestamptz` : sql``})
     limit 1
  `)) as unknown as { ok: number }[];
  return rows.length > 0;
}

/** R4 clause 1: the person, if they belong to this organisation (RLS hides another organisation's people too). */
export async function getPersonOfOrg(tx: Tx, orgId: string, personId: string): Promise<{ id: string; displayName: string; isActive: boolean } | undefined> {
  const [row] = await tx
    .select({ id: persons.id, displayName: persons.displayName, isActive: sql<boolean>`${persons.accountStatus} = 'active'` })
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
    .where(and(eq(employments.orgId, orgId), eq(employments.storeId, storeId), isNull(employments.endedOn), eq(persons.accountStatus, 'active')))
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
  /** Per tender: Σ amount, Σ change given, and how many payments are offline wallet payments still to check (T-623: not yet checked by a manager and not moved by a correction). */
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
    select p.tender_id as tender_id, sum(p.amount)::text as amount, sum(p.change_given)::text as change, (count(*) filter (where p.to_check and p.checked_at is null and not exists (select 1 from pos_tender_corrections c where c.payment_id = p.id)))::int as to_check
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

// ---------------------------------------------------------------------------------------------------------------------
// T-569 - the data download: every column of a purged POS v2 table, as text, for one store and a date range.
// ---------------------------------------------------------------------------------------------------------------------
export const POS_EXPORT_TABLES = [
  'receipts',
  'receipt-lines',
  'receipt-line-discounts',
  'payments',
  'day-closes',
  'day-close-tenders',
  'table-sessions',
  'device-events',
] as const;
export type PosExportTable = (typeof POS_EXPORT_TABLES)[number];

export interface PosExportResult {
  /** The database column names, in table order. */
  columns: string[];
  rows: Record<string, string | null>[];
}

/** A cell as text, in SQL, so no number or date ever passes through JavaScript: `numeric` prints as Postgres prints it (`1234.50`). A timestamp prints as ISO with its offset. */
function exportCell(col: AnyPgColumn): SQL<string | null> {
  return col.columnType === 'PgTimestamp' ? sql<string | null>`to_jsonb(${col}) #>> '{}'` : sql<string | null>`${col}::text`;
}

/** Bible row 353: a senior/PWD holder's ID number and name are never written out, whatever depth they sit at in a device payload. */
const REDACTED_KEYS: ReadonlySet<string> = new Set(['idNumber', 'holderName']);

/**
 * jsonb text, compacted (jsonb prints a space after `:` and `,`) with the value of every `idNumber` / `holderName` key, at any depth, replaced by
 * "[redacted]". A small reader over the text: a number or any other value is copied through as written, never parsed.
 */
function compactRedactedJson(text: string): string {
  let i = 0;
  const skip = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i++;
  };
  const str = (): string => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    return text.slice(start, ++i);
  };
  const value = (): string => {
    skip();
    const ch = text[i];
    if (ch === '"') return str();
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      const parts: string[] = [];
      i++;
      skip();
      if (text[i] === close) {
        i++;
        return ch + close;
      }
      for (;;) {
        skip();
        if (ch === '{') {
          const key = str();
          skip();
          i++; // the colon
          const v = value();
          parts.push(`${key}:${REDACTED_KEYS.has(JSON.parse(key) as string) ? '"[redacted]"' : v}`);
        } else parts.push(value());
        skip();
        if (text[i++] === close) break;
      }
      return ch + parts.join(',') + close;
    }
    const start = i;
    while (i < text.length && !',]} \n\t\r'.includes(text[i]!)) i++;
    return text.slice(start, i);
  };
  return value();
}

const manilaDate = (instant: AnyPgColumn): SQL<string> => sql<string>`(${instant} at time zone 'Asia/Manila')::date`;
/** The business date of a server instant when the business day starts at `hour` Manila time: the Manila date of (t - hour), the same rule as `startHourDate` in the POS domain. */
const businessDateOfInstant = (instant: AnyPgColumn, hour: number): SQL<string> =>
  sql<string>`((${instant} - ${hour} * interval '1 hour') at time zone 'Asia/Manila')::date`;

/**
 * One table's rows for one store and a date range (`from` and `to` are business dates, both included). Scoped by org AND store; the child tables are
 * reached only through the chosen parents.
 *
 * The business date of a receipt is its day close's `business_date` once it is closed (so the files agree with the Z readings), else the business date of
 * the SERVER's `received_at` under the day-start hour `startHour` (the Z's own rule: an unclosed receipt at 01:00 belongs to the previous day); a session
 * is included when EITHER the same rule on its server `opened_at` OR its receipt's date is in range (a backup repeats a row rather than lose it; BOSS 12 Nov). A device clock is never used. A device event is dated by the Manila calendar
 * date of `received_at` (a raw log, not a business record).
 */
export async function exportRowsForStore(
  tx: Tx,
  orgId: string,
  storeId: string,
  from: string,
  to: string,
  table: PosExportTable,
  startHour: number,
): Promise<PosExportResult> {
  const receiptDate = sql<string>`coalesce((select ${posDayCloses.businessDate} from ${posDayCloses} where ${posDayCloses.id} = ${posSalesReceipts.dayCloseId}), ${businessDateOfInstant(posSalesReceipts.receivedAt, startHour)})`;
  const openedDate = businessDateOfInstant(tableSessions.openedAt, startHour);
  const inRange = (d: SQL<string>): SQL => sql`${d} >= ${from}::date and ${d} <= ${to}::date`;
  // A backup repeats a row rather than lose one: a session is in if EITHER its opening business date OR any of its receipts' business dates is in range.
  const sessionIncluded = sql`(${inRange(openedDate)} or exists (select 1 from ${posSalesReceipts} where ${posSalesReceipts.tableSessionId} = ${tableSessions.id} and ${inRange(receiptDate)}))`;

  const receiptIds = () =>
    tx
      .select({ id: posSalesReceipts.id })
      .from(posSalesReceipts)
      .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId), inRange(receiptDate)));
  const lineIds = () =>
    tx.select({ id: posSalesReceiptLines.id }).from(posSalesReceiptLines).where(and(eq(posSalesReceiptLines.orgId, orgId), inArray(posSalesReceiptLines.receiptId, receiptIds())));
  const closeIds = () =>
    tx
      .select({ id: posDayCloses.id })
      .from(posDayCloses)
      .where(and(eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId), inRange(sql<string>`${posDayCloses.businessDate}`)));

  let t: PgTable;
  let where: SQL | undefined;
  let order: SQL[];
  switch (table) {
    case 'receipts':
      t = posSalesReceipts;
      where = and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId), inRange(receiptDate));
      order = [receiptDate, sql`${posSalesReceipts.id}`];
      break;
    case 'receipt-lines':
      t = posSalesReceiptLines;
      where = and(eq(posSalesReceiptLines.orgId, orgId), inArray(posSalesReceiptLines.receiptId, receiptIds()));
      order = [sql`${posSalesReceiptLines.receiptId}`, sql`${posSalesReceiptLines.lineNo}`];
      break;
    case 'receipt-line-discounts':
      t = posSalesReceiptLineDiscounts;
      where = and(eq(posSalesReceiptLineDiscounts.orgId, orgId), inArray(posSalesReceiptLineDiscounts.receiptLineId, lineIds()));
      order = [sql`${posSalesReceiptLineDiscounts.receiptLineId}`, sql`${posSalesReceiptLineDiscounts.id}`];
      break;
    case 'payments':
      t = posSalesReceiptPayments;
      where = and(eq(posSalesReceiptPayments.orgId, orgId), inArray(posSalesReceiptPayments.receiptId, receiptIds()));
      order = [sql`${posSalesReceiptPayments.receiptId}`, sql`${posSalesReceiptPayments.id}`];
      break;
    case 'day-closes':
      t = posDayCloses;
      where = and(eq(posDayCloses.orgId, orgId), eq(posDayCloses.storeId, storeId), inRange(sql<string>`${posDayCloses.businessDate}`));
      order = [sql`${posDayCloses.businessDate}`, sql`${posDayCloses.id}`];
      break;
    case 'day-close-tenders':
      t = posDayCloseTenders;
      where = and(eq(posDayCloseTenders.orgId, orgId), inArray(posDayCloseTenders.dayCloseId, closeIds()));
      order = [sql`${posDayCloseTenders.dayCloseId}`, sql`${posDayCloseTenders.id}`];
      break;
    case 'table-sessions':
      t = tableSessions;
      where = and(eq(tableSessions.orgId, orgId), eq(tableSessions.storeId, storeId), sessionIncluded);
      order = [openedDate, sql`${tableSessions.id}`];
      break;
    case 'device-events':
      t = posEvents;
      where = and(eq(posEvents.orgId, orgId), eq(posEvents.storeId, storeId), inRange(manilaDate(posEvents.receivedAt)));
      order = [manilaDate(posEvents.receivedAt), sql`${posEvents.id}`];
      break;
  }

  const cols = getTableColumns(t) as Record<string, AnyPgColumn>;
  const keys = Object.keys(cols);
  const shape = Object.fromEntries(keys.map((k) => [k, exportCell(cols[k]!)]));
  const found = await tx
    .select(shape)
    .from(t)
    .where(where)
    .orderBy(...order);
  const columns = keys.map((k) => cols[k]!.name);
  const rows = (found as Record<string, string | null>[]).map((r) =>
    Object.fromEntries(keys.map((k) => [cols[k]!.name, cols[k]!.columnType === 'PgJsonb' && r[k] !== null ? compactRedactedJson(r[k]!) : r[k]!])),
  );
  return { columns, rows };
}

// ---------------------------------------------------------------------------------------------------------------------
// T-534 S1 (migration 0265) - the post-sale documents: Convert, a wrong-payment-method correction, a refund. Plain inserts and reads; the domain (S2-S4) decides every
// rule, takes the row lock on the parent receipt, and writes a refund + its lines + its payments in ONE top-level transaction (the append guard refuses a child
// under an earlier transaction's refund). Nothing calls these until S2-S4, so each is in the production-caller baseline until then.
// ---------------------------------------------------------------------------------------------------------------------
export interface NewPaymentConversion {
  orgId: string;
  storeId: string;
  terminalId: string;
  fromTenderId: string;
  toTenderId: string;
  amount: Money;
  note: string | null;
  recordedBy: string;
  requestId: string;
}
export interface NewTenderCorrection {
  orgId: string;
  storeId: string;
  receiptId: string;
  paymentId: string;
  /** The paid row's own tender (the composite FK proves it). */
  fromTenderId: string;
  toTenderId: string;
  amount: Money;
  referenceNo: string | null;
  reason: string;
  approvedBy: string;
  recordedBy: string;
  requestId: string;
}
export interface NewRefund {
  orgId: string;
  storeId: string;
  terminalId: string;
  parentReceiptId: string;
  refundSeq: number;
  total: Money;
  /** T-627: the part of `total` that gives store charges back. Absent = 0. */
  chargesAmount?: Money;
  reason: string;
  approvedBy: string;
  recordedBy: string;
  requestId: string;
}
export interface NewRefundLine {
  orgId: string;
  refundId: string;
  /** The refund's parent receipt. */
  receiptId: string;
  receiptLineId: string;
  qty: number;
  amount: Money;
}
export interface NewRefundPayment {
  orgId: string;
  refundId: string;
  /** The refund's parent receipt. */
  receiptId: string;
  paymentId: string;
  /** The original payment's own tender (the composite FK proves it). */
  tenderId: string;
  amount: Money;
  referenceNo: string | null;
}

/** Undefined when the (org, request id) already has a row: a retried or racing POST wrote it first (the caller reads it back). */
export async function insertPaymentConversion(tx: Tx, r: NewPaymentConversion): Promise<PosPaymentConversionRow | undefined> {
  const [row] = await tx.insert(posPaymentConversions).values(r).onConflictDoNothing({ target: [posPaymentConversions.orgId, posPaymentConversions.requestId] }).returning();
  return row;
}
export async function insertTenderCorrection(tx: Tx, r: NewTenderCorrection): Promise<PosTenderCorrectionRow> {
  const [row] = await tx.insert(posTenderCorrections).values(r).returning();
  return row!;
}
export async function insertRefund(tx: Tx, r: NewRefund): Promise<PosRefundRow> {
  const [row] = await tx.insert(posRefunds).values(r).returning();
  return row!;
}
export async function insertRefundLines(tx: Tx, rows: NewRefundLine[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(posRefundLines).values(rows);
}
export async function insertRefundPayments(tx: Tx, rows: NewRefundPayment[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(posRefundPayments).values(rows);
}

/** The store's conversions not yet in a Z (voided ones included: the caller filters), oldest first. */
export async function listOpenPaymentConversions(tx: Tx, orgId: string, storeId: string): Promise<PosPaymentConversionRow[]> {
  return tx
    .select()
    .from(posPaymentConversions)
    .where(and(eq(posPaymentConversions.orgId, orgId), eq(posPaymentConversions.storeId, storeId), isNull(posPaymentConversions.dayCloseId)))
    .orderBy(asc(posPaymentConversions.recordedAt), asc(posPaymentConversions.id));
}
/** A retried POST: the row an earlier call with this request id wrote, if any (unique per org). */
export async function getPaymentConversionByRequestId(tx: Tx, orgId: string, requestId: string): Promise<PosPaymentConversionRow | undefined> {
  const [row] = await tx.select().from(posPaymentConversions).where(and(eq(posPaymentConversions.orgId, orgId), eq(posPaymentConversions.requestId, requestId)));
  return row;
}
/** One conversion of the store, or undefined. */
export async function getPaymentConversion(tx: Tx, orgId: string, storeId: string, id: string): Promise<PosPaymentConversionRow | undefined> {
  const [row] = await tx.select().from(posPaymentConversions).where(and(eq(posPaymentConversions.orgId, orgId), eq(posPaymentConversions.storeId, storeId), eq(posPaymentConversions.id, id)));
  return row;
}
/** The conversions frozen to one Z (voided ones included: the caller filters), oldest first. */
export async function listPaymentConversionsOfClose(tx: Tx, orgId: string, storeId: string, dayCloseId: string): Promise<PosPaymentConversionRow[]> {
  return tx
    .select()
    .from(posPaymentConversions)
    .where(and(eq(posPaymentConversions.orgId, orgId), eq(posPaymentConversions.storeId, storeId), eq(posPaymentConversions.dayCloseId, dayCloseId)))
    .orderBy(asc(posPaymentConversions.recordedAt), asc(posPaymentConversions.id));
}
/** Freezes conversions to the Z (the one column the guard lets the Z write, NULL -> value once). Returns how many were taken; the caller compares with what it read. */
export async function closePaymentConversions(tx: Tx, orgId: string, storeId: string, dayCloseId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(posPaymentConversions)
    .set({ dayCloseId })
    .where(and(eq(posPaymentConversions.orgId, orgId), eq(posPaymentConversions.storeId, storeId), inArray(posPaymentConversions.id, ids), isNull(posPaymentConversions.dayCloseId)))
    .returning({ id: posPaymentConversions.id });
  return rows.length;
}
/** Voids one open conversion (the void triple, once, before the Z). Returns 0 when it was already voided or already in a Z. */
export async function voidPaymentConversion(tx: Tx, orgId: string, storeId: string, id: string, v: { by: string; at: Date; reason: string }): Promise<number> {
  const rows = await tx
    .update(posPaymentConversions)
    .set({ voidedBy: v.by, voidedAt: v.at, voidReason: v.reason })
    .where(and(eq(posPaymentConversions.orgId, orgId), eq(posPaymentConversions.storeId, storeId), eq(posPaymentConversions.id, id), isNull(posPaymentConversions.dayCloseId), isNull(posPaymentConversions.voidedAt)))
    .returning({ id: posPaymentConversions.id });
  return rows.length;
}
export async function getTenderCorrectionByRequestId(tx: Tx, orgId: string, requestId: string): Promise<PosTenderCorrectionRow | undefined> {
  const [row] = await tx.select().from(posTenderCorrections).where(and(eq(posTenderCorrections.orgId, orgId), eq(posTenderCorrections.requestId, requestId)));
  return row;
}
export async function getRefundByRequestId(tx: Tx, orgId: string, requestId: string): Promise<PosRefundRow | undefined> {
  const [row] = await tx.select().from(posRefunds).where(and(eq(posRefunds.orgId, orgId), eq(posRefunds.requestId, requestId)));
  return row;
}
/** The lines and the money-back rows of one refund, for a slip or a retried POST's reply. */
export async function listRefundLines(tx: Tx, orgId: string, refundId: string): Promise<PosRefundLineRow[]> {
  return tx.select().from(posRefundLines).where(and(eq(posRefundLines.orgId, orgId), eq(posRefundLines.refundId, refundId))).orderBy(asc(posRefundLines.id));
}
export async function listRefundPayments(tx: Tx, orgId: string, refundId: string): Promise<PosRefundPaymentRow[]> {
  return tx.select().from(posRefundPayments).where(and(eq(posRefundPayments.orgId, orgId), eq(posRefundPayments.refundId, refundId))).orderBy(asc(posRefundPayments.id));
}

// ---------------------------------------------------------------------------------------------------------------------
// T-534 S3 - wrong payment method (tender corrections)
// ---------------------------------------------------------------------------------------------------------------------
/** One receipt of the store, locked FOR UPDATE: two corrections of one receipt take turns. Undefined for another store's receipt or one that does not exist. */
export async function getReceiptForUpdate(tx: Tx, orgId: string, storeId: string, receiptId: string): Promise<PosSalesReceiptRow | undefined> {
  const [row] = await tx
    .select()
    .from(posSalesReceipts)
    .where(and(eq(posSalesReceipts.orgId, orgId), eq(posSalesReceipts.storeId, storeId), eq(posSalesReceipts.id, receiptId)))
    .for('update');
  return row;
}

/** The paid rows of some receipts, with their ids and the change given (what a correction moves from). */
export async function listPaymentRowsOfReceipts(
  tx: Tx, orgId: string, receiptIds: readonly string[],
): Promise<{ id: string; receiptId: string; tenderId: string; amount: string; changeGiven: string; referenceNo: string | null }[]> {
  if (receiptIds.length === 0) return [];
  return tx
    .select({
      id: posSalesReceiptPayments.id, receiptId: posSalesReceiptPayments.receiptId, tenderId: posSalesReceiptPayments.tenderId,
      amount: posSalesReceiptPayments.amount, changeGiven: posSalesReceiptPayments.changeGiven, referenceNo: posSalesReceiptPayments.referenceNo,
    })
    .from(posSalesReceiptPayments)
    .where(and(eq(posSalesReceiptPayments.orgId, orgId), inArray(posSalesReceiptPayments.receiptId, [...receiptIds])))
    .orderBy(asc(posSalesReceiptPayments.id));
}

/** T-623: one wallet payment of a store with what the manager's check needs (its receipt's number parts, tender, reference and who checked it). Undefined when the payment is not at this org/store. */
export interface PaymentCheckRow {
  paymentId: string;
  terminalNo: number;
  terminalSeq: number;
  issuedAtDevice: Date;
  tenderName: string;
  amount: string;
  referenceNo: string | null;
  toCheck: boolean;
  checkedAt: Date | null;
  /** A wrong-payment-method correction moved (some of) it: the manager already said it never arrived, so there is nothing to check. */
  corrected: boolean;
  /** The first name (display name when the parts are empty) of the person who checked it. */
  checkedByName: string | null;
}
// T-623 (BOSS ruling): pos_tender_corrections is append-only (no status or reversal column), so any row for the payment is a live correction.
const hasCorrection = sql<boolean>`exists (select 1 from pos_tender_corrections c where c.payment_id = ${posSalesReceiptPayments.id})`;
const paymentCheckFields = {
  paymentId: posSalesReceiptPayments.id,
  terminalNo: posTerminals.terminalNo,
  terminalSeq: posSalesReceipts.terminalSeq,
  issuedAtDevice: posSalesReceipts.issuedAtDevice,
  tenderName: tenders.name,
  amount: posSalesReceiptPayments.amount,
  referenceNo: posSalesReceiptPayments.referenceNo,
  toCheck: posSalesReceiptPayments.toCheck,
  checkedAt: posSalesReceiptPayments.checkedAt,
  corrected: hasCorrection,
  checkedByName: sql<string | null>`coalesce(${persons.firstName}, ${persons.displayName})`,
};
const paymentCheckFrom = (tx: Tx) =>
  tx
    .select(paymentCheckFields)
    .from(posSalesReceiptPayments)
    .innerJoin(posSalesReceipts, eq(posSalesReceipts.id, posSalesReceiptPayments.receiptId))
    .innerJoin(posTerminals, eq(posTerminals.id, posSalesReceipts.terminalId))
    .innerJoin(tenders, eq(tenders.id, posSalesReceiptPayments.tenderId))
    .leftJoin(persons, eq(persons.id, posSalesReceiptPayments.checkedBy));

export async function getPaymentForCheck(tx: Tx, orgId: string, storeId: string, paymentId: string): Promise<PaymentCheckRow | undefined> {
  const [row] = await paymentCheckFrom(tx).where(and(eq(posSalesReceiptPayments.orgId, orgId), eq(posSalesReceipts.storeId, storeId), eq(posSalesReceiptPayments.id, paymentId)));
  return row;
}

/** T-623: the payments still "to check" (to_check, not yet checked, no correction moved them) of receipts issued since `since`, newest first. */
export async function listPaymentsToCheck(tx: Tx, orgId: string, storeId: string, since?: Date): Promise<PaymentCheckRow[]> {
  return paymentCheckFrom(tx)
    .where(
      and(
        eq(posSalesReceiptPayments.orgId, orgId),
        eq(posSalesReceipts.storeId, storeId),
        eq(posSalesReceiptPayments.toCheck, true),
        isNull(posSalesReceiptPayments.checkedAt),
        sql`not ${hasCorrection}`,
        since ? gte(posSalesReceipts.issuedAtDevice, since) : undefined,
      ),
    )
    .orderBy(desc(posSalesReceipts.issuedAtDevice), desc(posSalesReceiptPayments.id));
}

/**
 * T-623: the manager saw the money arrive. Sets checked_by / checked_at on one payment of THIS org and store that is "to check" and not yet checked (the trigger lets them go NULL -> a value once).
 * Returns whether it wrote: false = no such payment here, not "to check", or already checked (a racing second check waits on the row, re-reads the condition and writes nothing).
 */
export async function markPaymentChecked(tx: Tx, input: { orgId: string; storeId: string; paymentId: string; checkedBy: string; at: Date }): Promise<boolean> {
  const rows = await tx
    .update(posSalesReceiptPayments)
    .set({ checkedBy: input.checkedBy, checkedAt: input.at })
    .where(
      and(
        eq(posSalesReceiptPayments.orgId, input.orgId),
        eq(posSalesReceiptPayments.id, input.paymentId),
        eq(posSalesReceiptPayments.toCheck, true),
        isNull(posSalesReceiptPayments.checkedAt),
        sql`not ${hasCorrection}`,
        inArray(posSalesReceiptPayments.receiptId, tx.select({ id: posSalesReceipts.id }).from(posSalesReceipts).where(and(eq(posSalesReceipts.orgId, input.orgId), eq(posSalesReceipts.storeId, input.storeId)))),
      ),
    )
    .returning({ id: posSalesReceiptPayments.id });
  return rows.length > 0;
}

/** Every correction of some receipts (open or in a Z), oldest first. */
export async function listTenderCorrectionsOfReceipts(tx: Tx, orgId: string, receiptIds: readonly string[]): Promise<PosTenderCorrectionRow[]> {
  if (receiptIds.length === 0) return [];
  return tx
    .select()
    .from(posTenderCorrections)
    .where(and(eq(posTenderCorrections.orgId, orgId), inArray(posTenderCorrections.receiptId, [...receiptIds])))
    .orderBy(asc(posTenderCorrections.recordedAt), asc(posTenderCorrections.id));
}

/** Freezes the open corrections of the receipts a Z takes (the one column the guard lets the Z write, NULL -> value once). Returns how many it took. */
export async function closeTenderCorrectionsOfReceipts(tx: Tx, orgId: string, storeId: string, dayCloseId: string, receiptIds: readonly string[]): Promise<number> {
  if (receiptIds.length === 0) return 0;
  const rows = await tx
    .update(posTenderCorrections)
    .set({ dayCloseId })
    .where(and(eq(posTenderCorrections.orgId, orgId), eq(posTenderCorrections.storeId, storeId), inArray(posTenderCorrections.receiptId, [...receiptIds]), isNull(posTenderCorrections.dayCloseId)))
    .returning({ id: posTenderCorrections.id });
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// T-534 S4 - refunds
// ---------------------------------------------------------------------------------------------------------------------
export type PosSalesReceiptLineRow = typeof posSalesReceiptLines.$inferSelect;

/** The lines of some receipts, in receipt line order: what a refund's quantity and money caps are read from. */
export async function listReceiptLines(tx: Tx, orgId: string, receiptIds: readonly string[]): Promise<PosSalesReceiptLineRow[]> {
  if (receiptIds.length === 0) return [];
  return tx
    .select()
    .from(posSalesReceiptLines)
    .where(and(eq(posSalesReceiptLines.orgId, orgId), inArray(posSalesReceiptLines.receiptId, [...receiptIds])))
    .orderBy(asc(posSalesReceiptLines.receiptId), asc(posSalesReceiptLines.lineNo));
}

/** The next refund number of a store (max + 1, from 1). Only correct under the store's per-store Z lock, which every refund takes first; the unique (store_id, refund_seq) is the backstop. */
export async function nextRefundSeq(tx: Tx, orgId: string, storeId: string): Promise<number> {
  const rows = (await tx.execute(sql`select coalesce(max(refund_seq), 0)::int + 1 as seq from pos_refunds where org_id = ${orgId} and store_id = ${storeId}`)) as unknown as { seq: number }[];
  return Number(rows[0]!.seq);
}

/** Every refund of some receipts (open or in a Z), oldest first. */
export async function listRefundsOfReceipts(tx: Tx, orgId: string, receiptIds: readonly string[]): Promise<PosRefundRow[]> {
  if (receiptIds.length === 0) return [];
  return tx
    .select()
    .from(posRefunds)
    .where(and(eq(posRefunds.orgId, orgId), inArray(posRefunds.parentReceiptId, [...receiptIds])))
    .orderBy(asc(posRefunds.recordedAt), asc(posRefunds.id));
}
/** The refund lines of some receipts (every refund of them): the "already refunded" read of the quantity cap. */
export async function listRefundLinesOfReceipts(tx: Tx, orgId: string, receiptIds: readonly string[]): Promise<PosRefundLineRow[]> {
  if (receiptIds.length === 0) return [];
  return tx.select().from(posRefundLines).where(and(eq(posRefundLines.orgId, orgId), inArray(posRefundLines.receiptId, [...receiptIds]))).orderBy(asc(posRefundLines.id));
}
/** The money-back rows of some receipts (every refund of them): the "already refunded" read of the per-payment cap. */
export async function listRefundPaymentsOfReceipts(tx: Tx, orgId: string, receiptIds: readonly string[]): Promise<PosRefundPaymentRow[]> {
  if (receiptIds.length === 0) return [];
  return tx.select().from(posRefundPayments).where(and(eq(posRefundPayments.orgId, orgId), inArray(posRefundPayments.receiptId, [...receiptIds]))).orderBy(asc(posRefundPayments.id));
}
/** The money-back rows of some refunds (the Z's per-method read). */
export async function listRefundPaymentsOfRefunds(tx: Tx, orgId: string, refundIds: readonly string[]): Promise<PosRefundPaymentRow[]> {
  if (refundIds.length === 0) return [];
  return tx.select().from(posRefundPayments).where(and(eq(posRefundPayments.orgId, orgId), inArray(posRefundPayments.refundId, [...refundIds]))).orderBy(asc(posRefundPayments.id));
}

/** The store's refunds not yet in a Z, oldest first (the open window's refunds, whichever day their receipt was sold). */
export async function listOpenRefunds(tx: Tx, orgId: string, storeId: string): Promise<PosRefundRow[]> {
  return tx
    .select()
    .from(posRefunds)
    .where(and(eq(posRefunds.orgId, orgId), eq(posRefunds.storeId, storeId), isNull(posRefunds.dayCloseId)))
    .orderBy(asc(posRefunds.recordedAt), asc(posRefunds.id));
}
/** The refunds frozen to one Z, oldest first. */
export async function listRefundsOfClose(tx: Tx, orgId: string, storeId: string, dayCloseId: string): Promise<PosRefundRow[]> {
  return tx
    .select()
    .from(posRefunds)
    .where(and(eq(posRefunds.orgId, orgId), eq(posRefunds.storeId, storeId), eq(posRefunds.dayCloseId, dayCloseId)))
    .orderBy(asc(posRefunds.recordedAt), asc(posRefunds.id));
}
/** Freezes refunds to the Z (the one column the guard lets the Z write, NULL -> value once). Returns how many were taken; the caller compares with what it read. */
export async function closeRefunds(tx: Tx, orgId: string, storeId: string, dayCloseId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(posRefunds)
    .set({ dayCloseId })
    .where(and(eq(posRefunds.orgId, orgId), eq(posRefunds.storeId, storeId), inArray(posRefunds.id, [...ids]), isNull(posRefunds.dayCloseId)))
    .returning({ id: posRefunds.id });
  return rows.length;
}

/** The till number of a terminal (the middle of a printed receipt number), or undefined. */
export async function getTerminalNoById(tx: Tx, orgId: string, terminalId: string): Promise<number | undefined> {
  const [row] = await tx.select({ n: posTerminals.terminalNo }).from(posTerminals).where(and(eq(posTerminals.orgId, orgId), eq(posTerminals.id, terminalId)));
  return row?.n;
}

// ---------------------------------------------------------------------------------------------------------------------
// T-628 - table reservations and the money held for them (migration 0276). The domain decides every rule; these only write and read.
// ---------------------------------------------------------------------------------------------------------------------
export interface NewReservation {
  id: string;
  orgId: string;
  storeId: string;
  customerName: string;
  phone: string | null;
  partySize: number;
  reservedFor: Date;
  standId: string | null;
  note: string | null;
  createdBy: string;
  createdAtDevice: Date;
}
export async function insertReservation(tx: Tx, r: NewReservation): Promise<void> {
  await tx.insert(posReservations).values(r);
}
/** One reservation of the store; `forUpdate` locks it (the money actions take turns on it). Undefined for another store's or a missing one. */
export async function getReservation(tx: Tx, orgId: string, storeId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<PosReservationRow | undefined> {
  const q = tx.select().from(posReservations).where(and(eq(posReservations.orgId, orgId), eq(posReservations.storeId, storeId), eq(posReservations.id, id)));
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row;
}
export async function getReservationBySession(tx: Tx, orgId: string, storeId: string, sessionId: string): Promise<PosReservationRow | undefined> {
  const [row] = await tx
    .select()
    .from(posReservations)
    .where(and(eq(posReservations.orgId, orgId), eq(posReservations.storeId, storeId), eq(posReservations.sessionId, sessionId)));
  return row;
}
/** The columns the guard lets move. Returns how many rows changed (0 = the guard's WHERE did not match). */
export async function updateReservation(
  tx: Tx, orgId: string, storeId: string, id: string, set: { status?: PosReservationRow['status']; standId?: string | null; sessionId?: string | null; updatedAt: Date; closedAt?: Date | null },
): Promise<number> {
  const rows = await tx
    .update(posReservations)
    .set(set)
    .where(and(eq(posReservations.orgId, orgId), eq(posReservations.storeId, storeId), eq(posReservations.id, id)))
    .returning({ id: posReservations.id });
  return rows.length;
}

export interface ReservationWithHeld {
  reservation: PosReservationRow;
  /** taken - voided - applied - refunded - kept, in decimal text. */
  held: string;
}
const HELD = sql<string>`coalesce(sum(case when ${posReservationDeposits.kind} = 'taken' then ${posReservationDeposits.amount} else -${posReservationDeposits.amount} end), 0)::text`;
/**
 * The store's reservations that still matter: every booked or seated one, every cancelled / no-show one not yet closed (a manager must settle its money), and any closed one
 * whose time is on or after `since`. Soonest first. With the money still held on each.
 */
export async function listReservationsWithHeld(tx: Tx, orgId: string, storeId: string, since: Date): Promise<ReservationWithHeld[]> {
  const rows = await tx
    .select({ reservation: posReservations, held: HELD })
    .from(posReservations)
    .leftJoin(posReservationDeposits, and(eq(posReservationDeposits.reservationId, posReservations.id), eq(posReservationDeposits.orgId, orgId)))
    .where(
      and(
        eq(posReservations.orgId, orgId),
        eq(posReservations.storeId, storeId),
        sql`(${posReservations.status} <> 'closed' or ${posReservations.reservedFor} >= ${since.toISOString()}::timestamptz)`,
      ),
    )
    .groupBy(posReservations.id)
    .orderBy(asc(posReservations.reservedFor), asc(posReservations.id));
  return rows;
}

export interface NewDeposit {
  id: string;
  orgId: string;
  storeId: string;
  reservationId: string;
  kind: PosReservationDepositRow['kind'];
  amount: Money;
  tenderId: string | null;
  referenceNo: string | null;
  terminalId: string | null;
  receiptId: string | null;
  voidsDepositId: string | null;
  reason: string | null;
  recordedBy: string;
  approvedBy: string | null;
  occurredAtDevice: Date;
}
export async function insertDeposit(tx: Tx, r: NewDeposit): Promise<void> {
  await tx.insert(posReservationDeposits).values(r);
}
export async function getDeposit(tx: Tx, orgId: string, storeId: string, id: string): Promise<PosReservationDepositRow | undefined> {
  const [row] = await tx.select().from(posReservationDeposits).where(and(eq(posReservationDeposits.orgId, orgId), eq(posReservationDeposits.storeId, storeId), eq(posReservationDeposits.id, id)));
  return row;
}
/** Every event of one reservation, oldest first. */
export async function listDepositsOfReservation(tx: Tx, orgId: string, storeId: string, reservationId: string): Promise<PosReservationDepositRow[]> {
  return tx
    .select()
    .from(posReservationDeposits)
    .where(and(eq(posReservationDeposits.orgId, orgId), eq(posReservationDeposits.storeId, storeId), eq(posReservationDeposits.reservationId, reservationId)))
    .orderBy(asc(posReservationDeposits.recordedAt), asc(posReservationDeposits.id));
}
/** What is held for one reservation now (decimal text); '0' when it has no events. */
export async function heldOfReservation(tx: Tx, orgId: string, storeId: string, reservationId: string): Promise<string> {
  const [row] = await tx
    .select({ held: HELD })
    .from(posReservationDeposits)
    .where(and(eq(posReservationDeposits.orgId, orgId), eq(posReservationDeposits.storeId, storeId), eq(posReservationDeposits.reservationId, reservationId)));
  return row?.held ?? '0';
}
/** The cash-moving events (taken / voided / refunded / kept) of one till not yet in a Z, oldest first. Applied ones belong to their receipt's Z, never here. */
export async function listOpenDeposits(tx: Tx, orgId: string, storeId: string, terminalId: string, before?: Date): Promise<PosReservationDepositRow[]> {
  return tx
    .select()
    .from(posReservationDeposits)
    .where(
      and(
        eq(posReservationDeposits.orgId, orgId),
        eq(posReservationDeposits.storeId, storeId),
        eq(posReservationDeposits.terminalId, terminalId),
        isNull(posReservationDeposits.dayCloseId),
        ne(posReservationDeposits.kind, 'applied'),
        ...(before ? [sql`${posReservationDeposits.recordedAt} < ${before.toISOString()}::timestamptz`] : []),
      ),
    )
    .orderBy(asc(posReservationDeposits.recordedAt), asc(posReservationDeposits.id));
}
/** The applied-deposit event of a receipt (at most one), or undefined. */
export async function getAppliedDepositOfReceipt(tx: Tx, orgId: string, storeId: string, receiptId: string): Promise<PosReservationDepositRow | undefined> {
  const [row] = await tx
    .select()
    .from(posReservationDeposits)
    .where(and(eq(posReservationDeposits.orgId, orgId), eq(posReservationDeposits.storeId, storeId), eq(posReservationDeposits.receiptId, receiptId), eq(posReservationDeposits.kind, 'applied')));
  return row;
}
/** The events frozen to one Z, oldest first. */
export async function listDepositsOfClose(tx: Tx, orgId: string, storeId: string, dayCloseId: string): Promise<PosReservationDepositRow[]> {
  return tx
    .select()
    .from(posReservationDeposits)
    .where(and(eq(posReservationDeposits.orgId, orgId), eq(posReservationDeposits.storeId, storeId), eq(posReservationDeposits.dayCloseId, dayCloseId)))
    .orderBy(asc(posReservationDeposits.recordedAt), asc(posReservationDeposits.id));
}
/** Freezes deposit events to the Z (NULL -> value once). Returns how many were taken; the caller compares with what it read. */
export async function closeDeposits(tx: Tx, orgId: string, storeId: string, dayCloseId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(posReservationDeposits)
    .set({ dayCloseId })
    .where(and(eq(posReservationDeposits.orgId, orgId), eq(posReservationDeposits.storeId, storeId), inArray(posReservationDeposits.id, [...ids]), isNull(posReservationDeposits.dayCloseId)))
    .returning({ id: posReservationDeposits.id });
  return rows.length;
}
