/**
 * T-375 S1, R12 - the ONE place POS v1's wire field names are written.
 *
 * POS v1's `/api/external/sales` response uses names that mean something other than what they say
 * (docs/GLOSSARY.md: the package-only figure is not "sales dined in"; the POS residual field is a
 * residual). `tests/unit/glossary-trap-names.test.ts` bans those names from v2 source, and this
 * directory is on its `ALLOWED_PREFIXES` with the ETL's reason: these ARE the field names on the wire.
 * Every other file reads a feed through the v2-named keys below and never spells a POS name.
 * The POS residual field is deliberately absent: it is never read (R4, R12).
 *
 * Verified at source against `POS/src/app/api/external/sales/route.ts` and `.../sold-items/route.ts`.
 */

/** Paths under `POS_API_URL`, per feed kind. */
export const POS_V1_FEED_PATHS = {
  sales: '/api/external/sales',
  sold_items: '/api/external/sold-items',
} as const;

export const POS_V1_PAYMENT_METHODS_PATH = '/api/external/payment-methods';
export const POS_V1_STORES_PATH = '/api/external/stores';

/** `GET /api/external/sales` - v2 name on the left, POS's wire name on the right. */
export const POS_V1_SALES_FIELDS = {
  found: 'found',
  /** P: the paid total (gross after discounts and charges). */
  paidTotal: 'totalSales',
  /** N: the receipt count. */
  receiptCount: 'totalSessions',
  /** K: the package-only figure (NOT "sales that were dined in"). */
  packageOnly: 'dineInSales',
  /** Payment method name to amount. */
  methods: 'paymentsByMethod',
  /** D */
  discounts: 'discountsTotal',
  /** C */
  charges: 'chargesTotal',
} as const;

/** `GET /api/external/sold-items`. */
export const POS_V1_SOLD_ITEMS_FIELDS = {
  found: 'found',
  receiptCount: 'receiptCount',
  items: 'items',
  itemKey: 'posItemId',
  itemName: 'name',
  physicalQty: 'physicalQty',
  billableQty: 'billableQty',
  freeQty: 'freeQty',
  voidedQty: 'voidedQty',
  grossAmount: 'grossAmount',
} as const;
