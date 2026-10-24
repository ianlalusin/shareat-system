/**
 * pos-receipt-map.ts - a POS receipt document -> plain copy rows (T-472 slice 1).
 * docs/tasks/472-pos-nightly-receipt-bridge.md Rulings 3 (hash), 5 (money) and 7 (no personal data).
 *
 * PURE: no I/O, no Firestore call. The input is what `PosReceiptReader` yields (Firestore value
 * types already made stable by `toStableJson`); the output is {header, lines[], tenders[]} plus a
 * `docHash`, ready for a repo to insert in a later slice.
 *
 * - Money goes through `moneyFromLegacyFloat`; a value that was not a whole centavo keeps its
 *   rounded value and sets `moneyFlag` on that row. A receipt is never dropped for it.
 * - No personal field is copied: customer name / TIN / address and statutory diner name / ID
 *   number are stripped from every column AND from `raw`.
 * - `docHash` covers a FIXED list of copied fields only. Housekeeping fields (`analyticsApplied*`,
 *   `reRingLinkedAt`, the `editedAt` stamps and edit audit text) are neither copied nor hashed, so
 *   they can never mint a version.
 */
import { hash as nodeHash } from 'node:crypto';

import { toBusinessDate } from '@shareat/core/datetime';
import { moneyFromLegacyFloat, type Money } from '@shareat/core/money';
import { normalizePosV1Alias } from '@shareat/domain';

import { toStableJson } from './reader';

export interface PosReceiptInput {
  readonly id: string;
  readonly data: Record<string, unknown>;
}

export interface PosReceiptHeaderRow {
  readonly firestoreDocId: string;
  readonly posStoreId: string | null;
  readonly kind: 'sale' | 'refund';
  readonly status: string | null;
  readonly createdAtClientMs: number | null;
  /** ISO instant of the server `createdAt`, when present. */
  readonly serverCreatedAt: string | null;
  /** Manila calendar day (YYYY-MM-DD): client time first, server time as the fallback. */
  readonly posCalendarDate: string | null;
  readonly sessionMode: string | null;
  readonly receiptNumber: string | null;
  readonly terminalNo: number | null;
  readonly terminalSeq: number | null;
  readonly deviceId: string | null;
  readonly parentReceiptId: string | null;
  readonly total: Money | null;
  readonly totalPaid: Money | null;
  readonly change: Money | null;
  readonly discountsTotal: Money | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly voidCashPaid: Money | null;
  readonly voidCashRefunded: Money | null;
  readonly voidCashRetained: Money | null;
  /** True when any header money value was not a whole centavo in the source. */
  readonly moneyFlag: boolean;
  /** The document minus personal fields. Never hashed. */
  readonly raw: Record<string, unknown>;
}

export interface PosReceiptLineRow {
  readonly lineNo: number;
  readonly lineId: string | null;
  readonly lineType: string | null;
  readonly itemId: string | null;
  readonly itemName: string | null;
  readonly category: string | null;
  readonly unitPrice: Money | null;
  readonly qtyOrdered: number | null;
  readonly discountType: string | null;
  readonly discountFixed: Money | null;
  readonly discountPercent: number | null;
  readonly discountQty: number | null;
  readonly freeQty: number | null;
  readonly voidedQty: number | null;
  readonly modifiersTotal: Money | null;
  readonly moneyFlag: boolean;
}

export interface PosReceiptTenderRow {
  /** The method name as POS wrote it (the key of `analytics.mop`). */
  readonly methodName: string;
  /** `normalizePosV1Alias(methodName)`. */
  readonly alias: string;
  readonly amount: Money;
  readonly moneyFlag: boolean;
}

export interface MappedPosReceipt {
  readonly header: PosReceiptHeaderRow;
  readonly lines: readonly PosReceiptLineRow[];
  readonly tenders: readonly PosReceiptTenderRow[];
  /** sha256 hex over the copied fields only (see file header). */
  readonly docHash: string;
}

const PERSONAL_TOP = new Set(['customerName', 'customerTin', 'customerAddress']);
const PERSONAL_DINER = new Set(['name', 'idNo']);

/** Drops personal keys anywhere in the tree; diner `name`/`idNo` are dropped inside `statutoryDiners`. */
function stripPersonal(value: unknown, inDiners = false): unknown {
  if (Array.isArray(value)) return value.map((v) => stripPersonal(v, inDiners));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PERSONAL_TOP.has(k)) continue;
      if (inDiners && PERSONAL_DINER.has(k)) continue;
      out[k] = stripPersonal(v, inDiners || k === 'statutoryDiners');
    }
    return out;
  }
  return value;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A money field: the exact Money string, plus whether the source needed rounding. */
function mny(v: unknown): { value: Money | null; flag: boolean } {
  const n = num(v);
  if (n === null) return { value: null, flag: false };
  const r = moneyFromLegacyFloat(n);
  return { value: r.value, flag: r.rounded };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function calendarDate(clientMs: number | null, serverIso: string | null): string | null {
  if (clientMs !== null) return toBusinessDate(new Date(clientMs));
  if (serverIso !== null) {
    const d = new Date(serverIso);
    if (!Number.isNaN(d.getTime())) return toBusinessDate(d);
  }
  return null;
}

export function mapPosReceipt(input: PosReceiptInput): MappedPosReceipt {
  const d = toStableJson(input.data) as Record<string, unknown>;

  const total = mny(d.total);
  const totalPaid = mny(d.totalPaid);
  const change = mny(d.change);
  const discountsTotal = mny(d.discountsTotal);
  const voidPaid = mny(d.voidCashPaid);
  const voidRefunded = mny(d.voidCashRefunded);
  const voidRetained = mny(d.voidCashRetained);

  const clientMs = num(d.createdAtClientMs);
  const serverIso = typeof d.createdAt === 'string' ? d.createdAt : null;
  const isRefund = d.isRefund === true || input.id.startsWith('rf-') || (total.value !== null && total.value.startsWith('-'));

  const header: PosReceiptHeaderRow = {
    firestoreDocId: input.id,
    posStoreId: str(d.storeId),
    kind: isRefund ? 'refund' : 'sale',
    status: str(d.status),
    createdAtClientMs: clientMs,
    serverCreatedAt: serverIso,
    posCalendarDate: calendarDate(clientMs, serverIso),
    sessionMode: str(d.sessionMode),
    receiptNumber: str(d.receiptNumber),
    terminalNo: num(d.terminalNo),
    terminalSeq: num(d.terminalSeq),
    deviceId: str(d.deviceId),
    parentReceiptId: str(d.parentReceiptId),
    total: total.value,
    totalPaid: totalPaid.value,
    change: change.value,
    discountsTotal: discountsTotal.value,
    voidedAt: typeof d.voidedAt === 'string' ? d.voidedAt : null,
    voidReason: str(d.voidReason),
    voidCashPaid: voidPaid.value,
    voidCashRefunded: voidRefunded.value,
    voidCashRetained: voidRetained.value,
    moneyFlag: [total, totalPaid, change, discountsTotal, voidPaid, voidRefunded, voidRetained].some((m) => m.flag),
    raw: stripPersonal(d) as Record<string, unknown>,
  };

  const rawLines = Array.isArray(d.lines) ? (d.lines as Record<string, unknown>[]) : [];
  const lines: PosReceiptLineRow[] = rawLines.map((l, i) => {
    const unit = mny(l.unitPrice);
    const mods = mny(l.modifiersTotal);
    const fixed = l.discountType === 'fixed' ? mny(l.discountValue) : { value: null, flag: false };
    return {
      lineNo: i + 1,
      lineId: str(l.id),
      lineType: str(l.type),
      itemId: str(l.itemId),
      itemName: str(l.itemName),
      category: str(l.category),
      unitPrice: unit.value,
      qtyOrdered: num(l.qtyOrdered),
      discountType: str(l.discountType),
      discountFixed: fixed.value,
      discountPercent: l.discountType === 'percent' ? num(l.discountValue) : null,
      discountQty: num(l.discountQty),
      freeQty: num(l.freeQty),
      voidedQty: num(l.voidedQty),
      modifiersTotal: mods.value,
      moneyFlag: unit.flag || mods.flag || fixed.flag,
    };
  });

  const analytics = d.analytics && typeof d.analytics === 'object' ? (d.analytics as Record<string, unknown>) : {};
  const mop = analytics.mop && typeof analytics.mop === 'object' ? (analytics.mop as Record<string, unknown>) : {};
  const tenders: PosReceiptTenderRow[] = [];
  for (const name of Object.keys(mop).sort()) {
    const m = mny(mop[name]);
    if (m.value === null) continue;
    tenders.push({ methodName: name, alias: normalizePosV1Alias(name), amount: m.value, moneyFlag: m.flag });
  }

  const { raw: _raw, ...hashedHeader } = header;
  const docHash = nodeHash('sha256', canonical({ header: hashedHeader, lines, tenders }), 'hex');

  return { header, lines, tenders, docHash };
}
