/**
 * T-375 S1, R12 - test payload builders for POS v1's two feeds, written from v2-named inputs so a test never
 * spells a POS wire name. Tests only; nothing in `src/` outside this directory imports it.
 */
import { POS_V1_SALES_FIELDS as S, POS_V1_SOLD_ITEMS_FIELDS as I } from './wire';

export interface PosV1SalesFigures {
  readonly found?: boolean;
  readonly paidTotal?: number;
  readonly receiptCount?: number;
  readonly packageOnly?: number;
  readonly methods?: Readonly<Record<string, number>>;
  readonly discounts?: number;
  readonly charges?: number;
  /** Extra raw keys, e.g. to prove an unknown field is ignored. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** The `/sales` response object. `found: false` yields POS's short "no data" shape. */
export function posV1SalesBody(f: PosV1SalesFigures = {}): Record<string, unknown> {
  if (f.found === false) return { [S.found]: false, message: 'No analytics data for this date.', ...f.extra };
  return {
    [S.found]: true,
    [S.paidTotal]: f.paidTotal ?? 0,
    [S.receiptCount]: f.receiptCount ?? 0,
    [S.packageOnly]: f.packageOnly ?? 0,
    [S.methods]: { ...(f.methods ?? {}) },
    [S.discounts]: f.discounts ?? 0,
    [S.charges]: f.charges ?? 0,
    ...f.extra,
  };
}

export interface PosV1SoldItemInput {
  readonly key: string;
  readonly name?: string;
  readonly physicalQty: number;
  readonly billableQty?: number;
  readonly freeQty?: number;
  readonly voidedQty?: number;
  readonly grossAmount?: number;
}

/** The `/sold-items` response object. */
export function posV1SoldItemsBody(
  items: readonly PosV1SoldItemInput[],
  o: { readonly found?: boolean; readonly receiptCount?: number } = {},
): Record<string, unknown> {
  return {
    [I.found]: o.found ?? items.length > 0,
    [I.receiptCount]: o.receiptCount ?? (items.length > 0 ? 1 : 0),
    [I.items]: items.map((it) => ({
      [I.itemKey]: it.key,
      [I.itemName]: it.name ?? it.key,
      [I.physicalQty]: it.physicalQty,
      [I.billableQty]: it.billableQty ?? it.physicalQty,
      [I.freeQty]: it.freeQty ?? 0,
      [I.voidedQty]: it.voidedQty ?? 0,
      [I.grossAmount]: it.grossAmount ?? 0,
    })),
  };
}
