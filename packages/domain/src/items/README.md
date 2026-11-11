# Items
## Overview
The item master (T-145): one org-wide identity per purchasable thing with one canonical unit. Owns item create/rename/status, item requests and merging, supplier-item declarations, invoice-line validation, per-store sellability, and branch price rules. Pure helpers cover item codes (`CHWN-001` shape) and branch pricing.

## Interface
- `index.ts`: `normaliseItemName`, `openItemRequestSentence`, `createItem`, `updateItem`, `changeItemBaseUnit`, `setItemPurchaseUnit`, `renameItem`, `setItemStatus`, `lineTotalFromParts`, `validateInvoiceLines`, `declareSupplierItem`, `undeclareSupplierItem`, `requestItem`, `approveItemRequest`, `suggestItemCode`, `rejectItemRequest`, `mergeItems`, `setItemVariantOf`, `dismissDuplicatePair`, `undoDuplicateDismissal`, `pendingItemRequests`, `setStoreSellability`, `clearStoreSellability`, `setItemPricing`, `setCostBasisItem`, `branchPriceFor`; types `CreateItemInput`, `InvoiceLineDraft`, `RequestItemInput`, `RequestItemResult`, `ItemCodeSuggestion`. Re-exports `ITEM_CODE_RE`, `formatItemCode`, `itemCodeStem`, `parseItemCode`, `allocateItemCode`, `requireItemCodeStem`, `computeBranchPrice`, `BranchPriceRule`, `BranchPrice`.
- `code.ts` (pure): `ITEM_CODE_RE`, `STOP_WORDS`, `abbr`, `itemCodeStem`, `formatItemCode`, `parseItemCode`.
- `code-allocation.ts`: `requireItemCodeStem`, `allocateItemCode`, `validateItemCodeOverride`.
- `branch-price.ts` (pure): `computeBranchPrice`, `BranchPriceRule`, `BranchPrice`.
- `not-active.ts`: `notActiveItemSentence`.

## Invariants
- No cost is stored on the item; cost is derived from invoice history (`itemsRepo.priceHistory`).
- Names are written trimmed with inner whitespace collapsed (`normaliseItemName`).
- Item codes: 4-char stem + dash + 3 digits (001-999). Numbers come from the stem's high-water mark (`item_code_counters`) under a row lock; never derived from `max()` of current codes, so codes are never reused. Only a super-admin may type a code override.
- `code.ts` imports nothing so the browser and server share one stem function.
- `computeBranchPrice` is exact scaled-bigint arithmetic (no floats); every output rounds once, half-up; margin is `null` when basis is zero.
- A retired or merged item is described by one sentence (`notActiveItemSentence`) on every refusal path.
- Item mutations authorize first (`manage_items`, `approve_item`) and append `audit_log` rows.

## Side Effects
- Writes items, item requests, supplier-item declarations, pricing and sellability rows and `audit_log`; allocation touches `item_code_counters`.
- Opens its own transaction when `tx` is `null`; otherwise joins the caller's.
- `code.ts`, `branch-price.ts`, `not-active.ts`: None (pure functions).

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
