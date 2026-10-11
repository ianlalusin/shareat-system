/**
 * Server-only helpers for the cutover screens. T-134.
 *
 * ⭐ Everything here is DERIVED on every read. There is no "wizard state" beyond the recorded
 * completions — the progress you see is the ledger's own answer, asked again.
 */
import { cutoverRepo, itemsRepo } from '@shareat/db';
import { countedStockValue, cutoverProgress, openingGaps, openingTieOut, addQuantity, quantity, type CutoverProgress, type OpeningGaps, type TieOut } from '@shareat/domain';
import type { OpeningDraft } from '@shareat/db';
import { withOrgPrincipal } from '../expenses/lib';

export { peso } from '../../lib/format';
export { listStores, withOrgPrincipal } from '../expenses/lib';
export type { StoreOption } from '../expenses/lib';

/** The conversion date the double-counting guard measures "pre-cutover" against. */
export const CONVERSION_DATE = '2027-01-01';

export async function loadProgress(orgId: string, storeIds: string[]): Promise<CutoverProgress> {
  return withOrgPrincipal(orgId, (tx) => cutoverProgress(tx, orgId, storeIds));
}

export async function loadGaps(orgId: string): Promise<OpeningGaps> {
  return withOrgPrincipal(orgId, (tx) => openingGaps(tx, orgId, CONVERSION_DATE));
}

export interface CountRow {
  itemId: string;
  name: string;
  baseUnit: string;
  quantity: string | null;
  unitCost: string | null;
}

/**
 * Every active item at this store, with its count if one exists.
 *
 * ⭐ Items WITHOUT a count come back with `quantity: null` — and that is the whole point of the
 * screen. An item silently absent and an item counted as zero must not look the same, so the
 * blank is rendered as a blank and a zero is rendered as a zero.
 */
export async function loadCountSheet(orgId: string, storeId: string): Promise<CountRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const items = await itemsRepo.listItems(tx, orgId);
    const byItem = await cutoverRepo.countTotalsByItem(tx, orgId, storeId);
    return items.map((i) => {
      const c = byItem.get(i.id);
      return { itemId: i.id, name: i.name, baseUnit: i.baseUnit, quantity: c?.quantity ?? null, unitCost: c?.unitCost ?? null };
    });
  });
}

export async function countedValueFor(orgId: string, storeId: string): Promise<string> {
  return withOrgPrincipal(orgId, (tx) => countedStockValue(tx, orgId, storeId));
}

export const PHASE_TITLE: Record<string, string> = {
  A: 'Phase A — in the old system, during December',
  B: 'Phase B — the physical work, 31 December',
  C: 'Phase C — the switch, 1 January',
};

const KIND_LABEL: Record<string, string> = {
  verified: 'Checked automatically',
  attested: 'Stated by a person',
  performed: 'Run by the wizard',
};

/**
 * ⚠️ What the step actually is HERE, which is not always what it was declared.
 *
 * A1 and A2 are declared `verified`, and this database cannot verify them — the check is over v1
 * data v2 never holds. Rendering "Checked automatically · not machine-verifiable" side by side, as
 * the first cut did, is a contradiction a reader has to untangle. It says the true thing instead.
 */
export function kindLabel(kind: string, cannotVerifyHere?: string): string {
  if (kind === 'verified' && cannotVerifyHere) return 'Stated by a person';
  return KIND_LABEL[kind] ?? kind;
}

export async function loadOpeningDrafts(orgId: string): Promise<OpeningDraft[]> {
  return withOrgPrincipal(orgId, (tx) => cutoverRepo.openingDrafts(tx, orgId));
}

export interface PostableAccount {
  code: string;
  name: string;
  requiresParty: boolean;
}

/**
 * The accounts an opening figure can be entered against.
 *
 * ⛔ `3900` is excluded at the source, not just hidden: it is the other half of every figure, and
 * offering it in a dropdown is offering somebody a way to plug the difference to zero.
 */
export async function loadPostableAccounts(orgId: string): Promise<PostableAccount[]> {
  return withOrgPrincipal(orgId, (tx) => cutoverRepo.postableOpeningAccounts(tx, orgId));
}

// ---- T-390 S5: rooms, per-room count lines, the print sheet, the party picker, the tie-out panel ----------------------------

export interface RoomOption {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

/** The store's active rooms, default first. */
export async function loadRooms(orgId: string, storeId: string): Promise<RoomOption[]> {
  return withOrgPrincipal(orgId, (tx) => cutoverRepo.activeRoomsOf(tx, orgId, storeId));
}

export interface RoomCountRow {
  itemId: string;
  name: string;
  baseUnit: string;
  quantity: string | null;
  unitCost: string | null;
  costSource: string | null;
}

/** One room's lines: every active item, with THIS ROOM's count (never the store total). DEF-630. */
export async function loadRoomCountSheet(orgId: string, storeId: string, roomId: string): Promise<RoomCountRow[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const items = await itemsRepo.listItems(tx, orgId);
    const byItem = await cutoverRepo.countsForRoom(tx, orgId, storeId, roomId);
    return items.map((i) => {
      const c = byItem.get(i.id);
      return {
        itemId: i.id,
        name: i.name,
        baseUnit: i.baseUnit,
        quantity: c?.quantity ?? null,
        unitCost: c?.unitCost ?? null,
        costSource: c?.costSource ?? null,
      };
    });
  });
}

export interface MergedLine {
  itemId: string;
  name: string;
  baseUnit: string;
  total: string;
  parts: { room: string; quantity: string }[];
}

/** Items counted in more than one room, summed: shown read-only. Edits are per room (DEF-630). */
export async function loadMergedLines(orgId: string, storeId: string): Promise<MergedLine[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await cutoverRepo.countsForStore(tx, orgId, storeId);
    const items = await itemsRepo.listItems(tx, orgId);
    const unit = new Map(items.map((i) => [i.id, i.baseUnit]));
    const by = new Map<string, MergedLine>();
    for (const r of rows) {
      const cur = by.get(r.itemId) ?? { itemId: r.itemId, name: r.itemName, baseUnit: unit.get(r.itemId) ?? '', total: '0.000', parts: [] };
      cur.parts.push({ room: r.locationName, quantity: r.quantity });
      cur.total = addQuantity(quantity(cur.total), quantity(r.quantity)).toString();
      by.set(r.itemId, cur);
    }
    return [...by.values()].filter((l) => l.parts.length > 1);
  });
}

export interface SheetItem {
  code: string;
  name: string;
  baseUnit: string;
  purchaseHint: string | null;
}

/** Items with any stock movement in this room in the last 90 days. ⛔ No quantity is read: the sheet is a blind count. */
export async function loadSheetItems(orgId: string, storeId: string, roomId: string): Promise<SheetItem[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const rows = await cutoverRepo.itemsMovedInRoom(tx, orgId, storeId, roomId);
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      baseUnit: r.baseUnit,
      purchaseHint: r.purchaseUnit ? `1 ${r.purchaseUnit} = ${Number(r.purchaseFactor)} ${r.baseUnit}` : null,
    }));
  });
}

export interface PartyOption {
  type: 'supplier' | 'customer';
  id: string;
  name: string;
}

/** The R12 party picker: suppliers and customers, by name. */
export async function loadPartyOptions(orgId: string): Promise<PartyOption[]> {
  return withOrgPrincipal(orgId, (tx) => cutoverRepo.partyOptions(tx, orgId));
}

export async function loadPendingShells(orgId: string): Promise<{ id: string; storeId: string; name: string }[]> {
  return withOrgPrincipal(orgId, (tx) => cutoverRepo.pendingAssetShells(tx, orgId));
}

export async function loadTieOut(orgId: string): Promise<TieOut> {
  return withOrgPrincipal(orgId, (tx) => openingTieOut(tx, orgId));
}
