/**
 * T-528 R2 - the bill the Payment screen shows and prices: the table's lines (server lines plus the pending ones, T-527 `projectOrders`) with their ACTIVE
 * discounts (the server's, plus the outbox's `discount.added`, minus its `discount.removed`, plus `discount.applied_to_all`), as the input of the one
 * pricing function (`priceBill`) and as the receipt's lines. Pure: no React, no clock. Prices are never guessed: a line with no price stops the bill.
 */
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import type { PriceLineInput, PricedSession } from '@shareat/domain/pos/price';
import type { PosEvent } from '@/lib/pos-device';
import type { ReceiptLine } from '@/lib/pos-print/types';
import { asStoreMenu, type MenuLike } from '../_orders/menu-filter';
import type { ProjectedSession, SessionBody } from '../_orders/project';
import { freeUnits, type BillDiscount, type BillLine } from './logic';

export interface PresetLike {
  id: string;
  name: string;
  valueType: string;
  value: string;
}
export interface BillDiscountRow extends BillDiscount {
  id: string;
  valueType: 'percent' | 'fixed';
  value: string;
  presetId: string | null;
  /** The discount is in the outbox, not on the server yet. */
  pending: boolean;
  /** A pending "apply to all" discount has no id the device can name until the server has it, so it cannot be removed meanwhile. */
  removable: boolean;
  label: string;
}
export interface BillLineRow extends BillLine {
  discounts: BillDiscountRow[];
  pending: boolean;
  /** A head-count change is still in the outbox and the server will re-make this line: a discount cannot be put on it until that has sent. */
  discountsBlocked?: true;
}
export interface ProjectedBill {
  lines: BillLineRow[];
  /** A sentence when the bill cannot be priced yet (a price or a preset this tablet does not hold). Pay stays off. */
  problem: string | null;
  /** Sentences the panel shows beside the bill (a pending head-count change that removed discounts). */
  notices: string[];
  /** Pending bundle lines with extra heads whose server line id (`extraHeadsId`) the caller has not supplied yet: compute them (async) and call again. */
  needsExtraFor: string[];
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function discountLabel(d: { kind: string; valueType: string; value: string; presetId: string | null }, presets: readonly PresetLike[]): string {
  if (d.kind === 'senior') return 'Senior';
  if (d.kind === 'pwd') return 'PWD';
  if (d.kind === 'preset') return presets.find((p) => p.id === d.presetId)?.name ?? 'Discount';
  return d.valueType === 'percent' ? `Custom ${d.value}%` : `Custom ₱${d.value}`;
}

export const HEADS_CHANGED_NOTICE = 'The head count changed, so the discounts on the package line were removed. Add them again if they still apply.';

const sameLines = (e: PosEvent, ids: Set<string>): string | null => {
  const p = e.payload as Payload;
  const id = str(p.lineId);
  return id && ids.has(id) ? id : null;
};

export function projectBill(i: { extraIds?: Readonly<Record<string, string>>; sessionId: string; view: ProjectedSession | undefined; body: SessionBody | undefined; pending: readonly PosEvent[]; menu: MenuLike | null; presets: readonly PresetLike[] }): ProjectedBill {
  const items = i.menu ? asStoreMenu(i.menu).items : [];
  const live = (i.view?.lines ?? []).filter((l) => !l.cancelled);
  // The menu item behind each line the server does not hold yet, from the event that adds it.
  const pendingMenu = new Map<string, { menuItemId: string | null; variantId: string | null }>();
  for (const e of i.pending) {
    const p = e.payload as Payload;
    if ((e.kind === 'stand.opened' || e.kind === 'lines.added') && Array.isArray(p.lines)) {
      for (const raw of p.lines as Payload[]) {
        const id = str(raw.lineId);
        if (id) pendingMenu.set(id, { menuItemId: str(raw.menuItemId), variantId: str(raw.variantId) });
      }
    }
  }
  let problem: string | null = null;
  const needsExtraFor: string[] = [];
  const extras: BillLineRow[] = [];
  const lines: BillLineRow[] = live.map((l) => {
    const server = i.body?.lines.find((s) => s.id === l.id);
    const from = pendingMenu.get(l.id);
    const item = !server && from ? items.find((x) => x.id === from.menuItemId) : undefined;
    const variant = item?.variants.find((v) => v.id === from?.variantId) ?? item?.variants.find((v) => v.isDefault) ?? item?.variants[0];
    const offer = variant?.channels.store;
    const pendingBundle = offer !== undefined && offer.orderable && offer.bundleHeads !== null && offer.bundleHeads > 1 ? offer.bundleHeads : null;
    const kind: 'package' | 'item' = server ? (server.kind === 'package' ? 'package' : 'item') : l.extraHeads || item?.itemType === 'package' ? 'package' : 'item';
    if (l.unitPrice === null && problem === null) problem = `The price of ${l.name} is not on this tablet yet. Connect once to refresh it.`;
    // A bundle sold to more heads than it covers: the server adds a flat "(extra head)" line under its own derived id (order.ts); the bill must hold the same line.
    if (pendingBundle !== null && l.qty > pendingBundle) {
      const extraAmount = offer?.orderable ? offer.extraHeadAmount : null;
      const extraId = i.extraIds?.[l.id];
      if (!extraId) needsExtraFor.push(l.id);
      else if (extraAmount === null && problem === null) problem = `${l.name} has no price for extra heads on this tablet yet.`;
      else extras.push({ lineId: extraId, name: `${l.name.replace(/ - .*$/, '')} (extra head)`, kind: 'package', qty: l.qty - pendingBundle, bundleHeads: null, unitPrice: extraAmount ?? '0.00', pending: true, discounts: [] });
    }
    return {
      lineId: l.id,
      name: l.name,
      kind,
      qty: pendingBundle ? 1 : l.qty, // a bundle is one flat line covering N heads
      bundleHeads: server ? server.bundleHeads : pendingBundle,
      unitPrice: l.unitPrice ?? '0.00',
      pending: l.pending,
      discounts: (server?.discounts ?? []).map((d) => ({
        id: d.id, kind: d.kind, valueType: d.valueType, value: d.value, qty: d.qty, dinerNo: d.dinerNo, presetId: d.presetId, pending: false, removable: true,
        label: discountLabel({ kind: d.kind, valueType: d.valueType, value: d.value, presetId: d.presetId }, i.presets),
      })),
    };
  });

  lines.push(...extras);
  if (needsExtraFor.length > 0 && problem === null) problem = 'Working out the extra heads…';

  // A head-count change still in the outbox: mirror the server's followHeads (order.ts) so the device total EQUALS the server's (the ids of the re-made lines
  // differ, which only costs a mismatch audit row). Unserved: the per-head package line is re-made at the new heads and its discounts are removed with the old one;
  // a bundle keeps its line and gets one extra-heads line for the new heads. Served: the line stays and only the added heads are a new line.
  const notices: string[] = [];
  const blocked = new Set<string>();
  const headsEvents = i.pending.filter((e) => e.kind === 'heads.set' && str((e.payload as Payload).sessionId) === i.sessionId);
  const opened = i.pending.find((e) => e.kind === 'stand.opened' && str((e.payload as Payload).sessionId) === i.sessionId);
  const billedNow = Math.max(i.view?.headsCashier ?? 0, i.view?.headsServer ?? 0);
  const billedBefore = i.body ? Math.max(i.body.session.headsCashier, i.body.session.headsServer ?? 0) : num((opened?.payload as Payload | undefined)?.headsCashier);
  if (headsEvents.length > 0 && (billedBefore === null || billedBefore !== billedNow)) {
    const packages = lines.filter((l) => l.kind === 'package');
    const served = packages.some((l) => live.find((x) => x.id === l.lineId)?.kitchenStatus === 'served');
    const bundle = packages.find((l) => l.bundleHeads !== null && l.bundleHeads > 1);
    const synthetic = `pending-extra-heads-${i.sessionId}`;
    let dropped = false;
    if (!bundle) {
      if (!served) {
        for (const l of packages) {
          if (l.discounts.length > 0) dropped = true;
          l.discounts = [];
          blocked.add(l.lineId);
        }
      } else for (const l of packages) if (l.lineId === synthetic) blocked.add(l.lineId); // projectOrders already added the difference as its own line
    } else {
      const bundleHeads = bundle.bundleHeads!;
      const existingExtras = packages.filter((l) => l !== bundle && l.bundleHeads === null);
      // The extra-head price: the table's own extra-head line, else the bundle's store offer.
      const serverItemId = i.body?.lines.find((s) => s.id === bundle.lineId)?.menuItemId ?? pendingMenu.get(bundle.lineId)?.menuItemId;
      const offered = items.find((x) => x.id === serverItemId)?.variants.map((v) => v.channels.store).find((o) => o.orderable && o.bundleHeads === bundleHeads);
      const extraUnit = existingExtras[0]?.unitPrice ?? (offered && offered.orderable ? offered.extraHeadAmount : null);
      const covered = packages.reduce((a, l) => a + (l.bundleHeads ?? l.qty), 0);
      let qty: number;
      if (!served) {
        for (const l of existingExtras) {
          if (l.discounts.length > 0) dropped = true;
          lines.splice(lines.indexOf(l), 1);
        }
        qty = billedNow - bundleHeads;
      } else qty = billedNow - covered;
      if (qty > 0) {
        if (extraUnit === null && problem === null) problem = `${bundle.name} has no price for extra heads on this tablet yet.`;
        else {
          lines.push({ lineId: synthetic, name: `${bundle.name.replace(/ \(up to \d+\)$/, '')} (extra head)`, kind: 'package', qty, bundleHeads: null, unitPrice: extraUnit ?? '0.00', pending: true, discounts: [], discountsBlocked: true });
          blocked.add(synthetic);
        }
      }
    }
    if (dropped) notices.push(HEADS_CHANGED_NOTICE);
    for (const l of lines) if (blocked.has(l.lineId)) l.discountsBlocked = true;
  }
  const ids = new Set(lines.map((l) => l.lineId));
  const find = (lineId: string) => lines.find((l) => l.lineId === lineId);
  for (const e of i.pending) {
    const p = e.payload as Payload;
    if (e.kind === 'discount.added') {
      const lineId = sameLines(e, ids);
      if (lineId && blocked.has(lineId)) {
        if (!notices.includes(HEADS_CHANGED_NOTICE)) notices.push(HEADS_CHANGED_NOTICE); // the server drops it with the line it was on
        continue;
      }
      const id = str(p.discountId);
      const kind = str(p.kind) as BillDiscountRow['kind'] | null;
      const qty = num(p.qty);
      if (!lineId || !id || !kind || qty === null || lines.some((l) => l.discounts.some((d) => d.id === id))) continue; // the server already holds it: shown once
      const preset = kind === 'preset' ? i.presets.find((x) => x.id === str(p.presetId)) : undefined;
      if (kind === 'preset' && !preset && problem === null) problem = 'A discount on this table is not on this tablet yet. Connect once to refresh it.';
      const valueType = (kind === 'preset' ? preset?.valueType : str(p.valueType)) === 'fixed' ? 'fixed' : 'percent';
      // priceSession reads no value for a senior/PWD discount: it uses the statutory rate from the rules.
      const value = kind === 'preset' ? (preset?.value ?? '0') : kind === 'custom' ? (str(p.value) ?? '0') : '0';
      const row = { id, kind, valueType, value, qty, dinerNo: num(p.dinerNo), presetId: str(p.presetId), pending: true, removable: true } as const;
      find(lineId)!.discounts.push({ ...row, label: discountLabel(row, i.presets) });
    } else if (e.kind === 'discount.removed') {
      const id = str(p.discountId);
      for (const l of lines) l.discounts = l.discounts.filter((d) => d.id !== id);
    } else if (e.kind === 'discount.applied_to_all' && str(p.sessionId) === i.sessionId) {
      const preset = i.presets.find((x) => x.id === str(p.presetId));
      const applyId = str(p.applyId);
      if (!preset || !applyId) {
        if (problem === null) problem = 'A discount on this table is not on this tablet yet. Connect once to refresh it.';
        continue;
      }
      for (const l of lines) {
        if (blocked.has(l.lineId)) continue; // the re-made line is not on the server yet; leaving it out can only make the device total higher than the server's
        const free = freeUnits(l);
        if (free <= 0 || toCentavos(money(l.unitPrice)) === 0n) continue; // the server skips these too
        const row = { id: `apply-${applyId}-${l.lineId}`, kind: 'preset', valueType: preset.valueType === 'fixed' ? 'fixed' : 'percent', value: preset.value, qty: free, dinerNo: null, presetId: preset.id, pending: true, removable: false } as const;
        l.discounts.push({ ...row, label: discountLabel(row, i.presets) });
      }
    }
  }
  return { lines, problem, needsExtraFor, notices };
}

export function toPriceLines(bill: readonly BillLineRow[]): PriceLineInput[] {
  return bill.map((l) => ({
    lineId: l.lineId,
    qty: l.qty,
    unitPrice: l.unitPrice,
    bundleHeads: l.bundleHeads,
    discounts: l.discounts.map((d) => ({ discountId: d.id, kind: d.kind, valueType: d.valueType, value: d.value, qty: d.qty })),
  }));
}

/** The diners who hold a senior/PWD discount on this bill, in diner order. */
export function statutoryDiners(bill: readonly BillLineRow[]): { dinerNo: number; kind: 'senior' | 'pwd' }[] {
  const seen = new Map<number, 'senior' | 'pwd'>();
  for (const l of bill) for (const d of l.discounts) if ((d.kind === 'senior' || d.kind === 'pwd') && d.dinerNo !== null && !seen.has(d.dinerNo)) seen.set(d.dinerNo, d.kind);
  return [...seen].sort((a, b) => a[0] - b[0]).map(([dinerNo, kind]) => ({ dinerNo, kind }));
}

/** The receipt's itemized lines from the priced bill: a discount prints its VAT-removed share plus its percent, as one negative amount (row 439). */
export function receiptLinesOf(bill: readonly BillLineRow[], priced: PricedSession): ReceiptLine[] {
  return bill.map((l) => {
    const pl = priced.lines.find((x) => x.lineId === l.lineId)!;
    return {
      name: l.name,
      qty: l.qty,
      unitPrice: l.unitPrice as ReceiptLine['unitPrice'],
      gross: pl.gross,
      discounts: l.discounts.map((d) => {
        const pd = pl.discounts.find((x) => x.discountId === d.id)!;
        return { label: d.label, qty: d.qty, amount: fromCentavos(toCentavos(pd.vatRemoved) + toCentavos(pd.discountAmount)) };
      }),
      net: pl.net,
    };
  });
}
