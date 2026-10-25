import { createHash } from 'node:crypto';
import type {
  BridgeChangeField,
  BridgeDayCrossCheck,
  BridgeSourceLine,
  BridgeSourceReceipt,
  BridgeSourceTender,
  PosReceiptBridgePort,
} from '../../../src/pos/receipt-bridge-port';

/** T-472 S2 - test helpers: Manila clock helpers, a receipt builder, and a FAKE PORT (no Firebase, no network). */

export const NOW = '2027-01-12T22:30:00.000Z';
export const YESTERDAY = '2027-01-12';
export const DEC_NOW = '2026-12-30T22:30:00.000Z';

export const manilaMs = (date: string, hour: number): number => Date.parse(`${date}T00:00:00Z`) + (hour - 8) * 3_600_000;
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface R {
  id: string;
  date?: string;
  hour?: number;
  total?: string;
  discounts?: string;
  kind?: 'sale' | 'refund';
  status?: string;
  /** Changes the hash (a real change to a copied field). */
  v?: number;
  hash?: string;
  lines?: Partial<BridgeSourceLine>[];
  tenders?: Partial<BridgeSourceTender>[];
  moneyFlag?: boolean;
  raw?: Record<string, unknown>;
  receiptNumber?: string | null;
  noClientTime?: boolean;
  voidedAt?: string | null;
}

export function receipt(o: R): BridgeSourceReceipt {
  const date = o.date ?? YESTERDAY;
  const total = o.total ?? '100.00';
  const lines: BridgeSourceLine[] = (o.lines ?? [{}]).map((l, i) => ({
    lineNo: i + 1,
    itemId: `item-${i + 1}`,
    itemName: `Item ${i + 1}`,
    unitPrice: total as never,
    qtyOrdered: 1,
    voidedQty: 0,
    freeQty: 0,
    discountType: null,
    discountFixed: null,
    discountPercent: null,
    discountQty: 0,
    modifiersTotal: null,
    moneyFlag: false,
    ...l,
  }));
  const tenders: BridgeSourceTender[] = (o.tenders ?? [{}]).map((t) => ({
    methodName: 'Cash',
    alias: 'cash',
    amount: total as never,
    moneyFlag: false,
    ...t,
  }));
  return {
    id: o.id,
    docHash: o.hash ?? sha(`${o.id}|${o.v ?? 1}|${total}|${o.status ?? 'final'}`),
    header: {
      firestoreDocId: o.id,
      kind: o.kind ?? (total.startsWith('-') ? 'refund' : 'sale'),
      status: o.status ?? 'final',
      createdAtClientMs: o.noClientTime ? null : manilaMs(date, o.hour ?? 12),
      posCalendarDate: date,
      receiptNumber: o.receiptNumber === undefined ? `RN-${o.id}` : o.receiptNumber,
      terminalNo: 1,
      parentReceiptId: o.kind === 'refund' ? 'parent-1' : null,
      total: total as never,
      discountsTotal: (o.discounts ?? '0.00') as never,
      voidedAt: o.voidedAt ?? null,
      moneyFlag: o.moneyFlag ?? false,
      raw: o.raw ?? { status: o.status ?? 'final', total },
    },
    lines,
    tenders,
  };
}

export class FakePort implements PosReceiptBridgePort {
  readonly days = new Map<string, BridgeSourceReceipt[]>();
  readonly missing = new Map<string, BridgeSourceReceipt[]>();
  readonly changed: Record<BridgeChangeField, BridgeSourceReceipt[]> = { voidedAt: [], editedAt: [], createdAt: [] };
  readonly calls: string[] = [];
  readonly sinceSeen: Date[] = [];
  crossCheckOverride?: (posStoreId: string, date: string, defaults: BridgeDayCrossCheck) => BridgeDayCrossCheck;
  failListDay?: Error;

  put(posStoreId: string, date: string, ...rs: BridgeSourceReceipt[]): this {
    const k = `${posStoreId}|${date}`;
    this.days.set(k, [...(this.days.get(k) ?? []), ...rs]);
    return this;
  }
  putMissing(posStoreId: string, date: string, ...rs: BridgeSourceReceipt[]): this {
    const k = `${posStoreId}|${date}`;
    this.missing.set(k, [...(this.missing.get(k) ?? []), ...rs]);
    return this;
  }
  clear(posStoreId: string, date: string): void {
    this.days.delete(`${posStoreId}|${date}`);
  }
  datesCalled(posStoreId: string, what: string): string[] {
    return this.calls.filter((c) => c.startsWith(`${what}|${posStoreId}|`)).map((c) => c.split('|')[2]!);
  }
  async *listDay(posStoreId: string, date: string) {
    this.calls.push(`listDay|${posStoreId}|${date}`);
    if (this.failListDay) throw this.failListDay;
    for (const r of this.days.get(`${posStoreId}|${date}`) ?? []) yield r;
  }
  async *listMissingClientTime(posStoreId: string, date: string) {
    this.calls.push(`listMissing|${posStoreId}|${date}`);
    for (const r of this.missing.get(`${posStoreId}|${date}`) ?? []) yield r;
  }
  async crossCheckDay(posStoreId: string, date: string): Promise<BridgeDayCrossCheck> {
    this.calls.push(`cross|${posStoreId}|${date}`);
    const d = this.days.get(`${posStoreId}|${date}`) ?? [];
    const m = this.missing.get(`${posStoreId}|${date}`) ?? [];
    const base: BridgeDayCrossCheck = {
      byClientMs: d.length,
      byServerCreatedAt: d.length + m.length,
      missingClientMs: m.length,
      missingClientMsIds: m.map((r) => r.id),
    };
    return this.crossCheckOverride ? this.crossCheckOverride(posStoreId, date, base) : base;
  }
  async *listChangedSince(posStoreId: string, field: BridgeChangeField, since: Date) {
    this.calls.push(`changed|${posStoreId}|${field}`);
    this.sinceSeen.push(since);
    for (const r of this.changed[field]) yield r;
  }
}
