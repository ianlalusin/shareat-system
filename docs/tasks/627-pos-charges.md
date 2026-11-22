# T-627: store charges on the POS v2 bill (leftover, extra griller, ...)

**Owner:** builder (Sonnet), laptop. Auditor: Sonnet (money). **Spec:** BOSS (Opus), 22 Nov 2026.
**Ian, 22 Nov 2026:** build charges before go-live ("B"); "we charge for left over so im thinking of a list of charges
available for a specific store"; who may add or remove: "Anyone, like v1". No service charge (Ian 29 Aug: "for now no we
dont charge"); service charge is NOT in this task. **MIGRATION 0275** (BOSS reserves it on the board).

## v1, read as requirements

GOAL: a branch adds extra money to a bill for things outside the menu (leftover food, an additional griller) without
code changes. v1 (`POS/src/lib/tax.ts:110-221`, `bill-adjustments.tsx:313-360`): per-store + global charge list (name,
fixed/percent, bill or item scope), any cashier adds or removes, a free-text custom charge, all added AFTER VAT and
outside the VAT base, one "CHARGES" line on the receipt, a single day total to v1 ERP with no account.
**Not copied:** global charges (each store owns its list; the ERP "Copy from another store" covers sharing), percent
charges (none in use; every live charge is a peso amount), the analytics sign bug, the single unnamed receipt line.

## Rule (v2)

- **Store charge list** `pos_charge_presets` (org, store, name 1-40 unique among active per store, `amount` pesos > 0,
  `per_unit` bool (true = cashier enters a quantity, e.g. leftover per 100 g or per tray; false = once per bill),
  status active/retired). Edited on `/admin/pos-tablets` beside Discounts (same pattern as T-622: list, Add, Change value,
  Retire), capability `manage_store_settings` at the store, audit `pos.charge_preset_set` / `_retired`. Add the charge
  list to "Copy from another store" (`apps/erp/src/app/copy-from-store`, T-611 pattern) if it is a small addition there.
- **On the bill:** any signed-in POS person adds a charge from the list (quantity when `per_unit`), or a **custom charge**
  (name + peso amount, typed). Anyone removes one. Every add/remove is an event (`charge.added` / `charge.removed`,
  offline-capable like `lines.added`) with actor and time; no PIN (Ian's choice).
- **Math:** charges are added after discounts and VAT, outside the VAT base, never discounted, never part of the senior/PWD
  base (as v1; one pure function computes the bill on device and server). `pos_sales_receipts` gains `charge_total`;
  append-only `pos_sales_receipt_charges` rows (preset id or null, name snapshot, unit amount, qty, amount). Total =
  existing total + charge_total. The server recomputes and the existing variance rules apply.
- **Receipt / X / Z:** each charge printed by name with its amount; X/Z show "Charges" total.
- **Day close:** receipt charges sum into `sales_days.other_charges` (existing routing posts other_charges to 4500, no new
  posting pattern); `serviceCharge` stays zero. Remove the hard-coded zero at `day-close.ts:668` for other charges and make
  the reconciliation identity hold (collected = sales + other charges). v1 bridge: `chargesTotal` = the day's charges
  (`v1-bridge-payload.ts:98`).
- **Snapshot:** the store's active charge list rides in the snapshot (offline use).
- **Refunds:** a refund of a receipt with charges refunds charges only if the cashier ticks them (default not refunded);
  keep it simple and consistent with T-534 S4's refund rules. If this is bigger than a small addition, stop and ask BOSS.
- **Accountant note (not a blocker):** whether VAT applies to charges; v1 treats them as outside VAT. Record the question in
  the task doc; Ian asks the accountant.

## Tests (each with a mutant that goes red)

1. Pure bill math: charges after VAT, never discounted, not in the senior/PWD base, per-unit × qty, exact centavos.
2. Inbox integration: charge.added / removed offline replay; receipt rows + `charge_total`; server recompute matches device.
3. Day close: a day with charges reconciles; `sales_days.other_charges` = sum; posts to 4500 (existing pattern test).
4. ERP: preset add/change/retire with authorize-first and audit; cashier refused for presets.
5. Receipt/X/Z text includes charge names and totals.
- Migration 0275 is hand-authored (ADR-012 §5): classification + RLS registry + journal (`when` = previous + 86400000);
  the full CI suite runs on it. `npm run census:write`; typecheck apps/erp and package tests via a temp tsconfig.
