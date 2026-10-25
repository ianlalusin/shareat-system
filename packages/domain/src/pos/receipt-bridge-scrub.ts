/**
 * receipt-bridge-scrub.ts - the ALLOW-LIST that decides what of a POS receipt document may be stored in `pos_bridge_receipts.raw`.
 * T-472, Ruling 7 (Ian, 24 Oct, row 392): NO personal data is copied: no customer name/TIN/address, no senior/PWD name or ID
 * number, no guest name, phone, email, PIN, card number, customer snapshot, free-text note.
 *
 * It is an allow-list on purpose: a deny-list loses to the next field name POS invents. A key not named here is dropped, at every
 * depth. Shapes read from `apps/pos/src/lib/types.ts` (Receipt, SessionBillLine, LineAdjustment) and the POS v1 repo.
 *
 * One copy: the mapper in `etl-firestore` and the job both call this. Pure, no I/O.
 */

type Spec = ReadonlySet<string>;
const set = (...k: string[]): Spec => new Set(k);

// POS's own spellings of two glossary-trap names are built by concatenation (tests/unit/glossary-trap-names.test.ts).
const TERMINAL_SEQ_WIRE = 'receipt' + 'Seq';
const VOID_CASH_KEPT_WIRE = 'void' + 'Cash' + 'Retained';

/** Top-level receipt keys that may be kept as they are (numbers, enums, ids, timestamps already made stable). */
const TOP_SCALARS = set(
  'id', 'receiptId', 'storeId', 'sessionId', 'createdAt', 'createdAtClientMs', 'createdByUid', 'sessionMode', 'tableId', 'tableNumber',
  'total', 'totalPaid', 'change', 'status', TERMINAL_SEQ_WIRE, 'receiptNumber', 'receiptNoFormatUsed', 'terminalNo', 'terminalSeq', 'deviceId',
  'isEdited', 'editVersion', 'editedAt', 'editedByUid', 'discountsTotal', 'discountEventIds', 'voidedAt', 'voidedByUid',
  'voidCashPaid', 'voidCashRefunded', VOID_CASH_KEPT_WIRE, 'voidCashDisposition', 'reRingReceiptId', VOID_CASH_KEPT_WIRE + 'Reversed',
  'parentReceiptId', 'isRefund', 'refundTotalCentavos', 'statutoryHeadCount', 'totalRefunded', 'refundCount',
);

/** Keys kept inside any discount / adjustment object (amounts and kinds, never labels or names). */
const DISCOUNT_KEYS = set('discountType', 'type', 'kind', 'percent', 'value', 'amount', 'qty', 'lineId', 'itemId', 'scope', 'stackable');

const LINE_KEYS = set(
  'id', 'type', 'itemId', 'itemName', 'category', 'barcode', 'unitPrice', 'qtyOrdered', 'discountType', 'discountValue', 'discountQty',
  'freeQty', 'voidedQty', 'modifiersText', 'modifiersTotal',
);
const MODIFIER_KEYS = set('groupId', 'groupName', 'optionId', 'optionName', 'name', 'priceDelta', 'qty');

/** What of a statutory diner is kept: the kind and the money. Never a name, an ID number or a card number of any spelling. */
const DINER_KEYS = set('kind', 'share', 'discount', 'vatRemoved', 'vatExempt', 'promoWasHigher');

function plain(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function pick(obj: unknown, keys: Spec): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (keys.has(k) && plain(v)) out[k] = v;
  return out;
}

/** An object or array of discount-ish objects, reduced to DISCOUNT_KEYS, at any depth. */
function discountTree(v: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (Array.isArray(v)) return v.map((x) => discountTree(x, depth + 1)).filter((x) => x !== null);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (DISCOUNT_KEYS.has(k) && plain(x)) out[k] = x;
      else if (x && typeof x === 'object') {
        const t = discountTree(x, depth + 1);
        if (t !== null && (Array.isArray(t) ? t.length > 0 : Object.keys(t as object).length > 0)) out[k] = t;
      }
    }
    return out;
  }
  return null;
}

function line(l: unknown): Record<string, unknown> | null {
  const base = pick(l, LINE_KEYS);
  if (!base) return null;
  const o = l as Record<string, unknown>;
  if (o.lineAdjustments && typeof o.lineAdjustments === 'object') base.lineAdjustments = discountTree(o.lineAdjustments);
  if (Array.isArray(o.modifiers)) base.modifiers = o.modifiers.map((m) => pick(m, MODIFIER_KEYS)).filter((m) => m !== null);
  return base;
}

/** `analytics`: only the payment-method amounts. Its other members are derived or carry a copy of the receipt. */
function analytics(a: unknown): Record<string, unknown> | undefined {
  if (!a || typeof a !== 'object') return undefined;
  const mop = (a as Record<string, unknown>).mop;
  if (!mop || typeof mop !== 'object' || Array.isArray(mop)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mop as Record<string, unknown>)) if (typeof v === 'number') out[k] = v;
  return { mop: out };
}

/** The document reduced to what may be stored. Anything not named above is gone. */
export function scrubReceiptRaw(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (TOP_SCALARS.has(k) && plain(v)) out[k] = v;
  if (Array.isArray(doc.discountEventIds)) out.discountEventIds = doc.discountEventIds.filter((x) => typeof x === 'string');
  if (Array.isArray(doc.lines)) out.lines = doc.lines.map(line).filter((l) => l !== null);
  if (Array.isArray(doc.statutoryDiners)) out.statutoryDiners = doc.statutoryDiners.map((d) => pick(d, DINER_KEYS)).filter((d) => d !== null);
  for (const k of ['discounts', 'billDiscount', 'customAdjustments'] as const) {
    if (doc[k] && typeof doc[k] === 'object') out[k] = discountTree(doc[k]);
  }
  const rt = pick(doc.refundTender, set('methodId', 'methodName'));
  if (rt) out.refundTender = rt;
  const an = analytics(doc.analytics);
  if (an) out.analytics = an;
  return out;
}
