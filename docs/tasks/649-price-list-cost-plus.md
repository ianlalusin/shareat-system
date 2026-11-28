# T-649: Price list rates can follow delivery cost (fixed / cost + peso / cost + %), and one list can be the default

**Owner:** builder (Sonnet). **Auditor:** Sonnet (money + schema). **Spec:** BOSS (Opus), 28 Nov 2026. **MIGRATION 0289** (reserved on the coord board). No new capability.

**Ian, 28 Nov 2026:** "its attached per item say item a is fixed 100, item b is cost + 7%, item c is cost + P50, item d is cost + 10% (all these under 1 price set up like wholesale) then the new price set up example retail has different price set up for same items. so the app checks who order, say customer a, what pricelist is set up for this, say null then default OR customer a uses wholesale pricelist then it will look for items wholesale pricelist and uses it."

## Facts (origin/main, 28 Nov)
- `price_lists` / `price_list_items` (packages/db/schema/customers.ts:50-120). A rate is `rate numeric(14,2) NOT NULL` + optional `unit`; one row per (list, item); "Set a rate" replaces (apps/erp/src/app/customers/price-lists/[id]/page.tsx:96).
- Customers carry `price_list_id` (nullable). Trade order form: internal customers get `branchPrices` (item pricing rules), external customers get `quotes[customerId]` from their list (apps/erp/src/app/trade/orders/lib.ts:88-120, NewOrderForm.tsx:61-65). The rate is CAPTURED on the order line at creation (schema/trade.ts:273), never a live join.
- The three-mode arithmetic already exists and is exact: `computeBranchPrice(rule, basis)` (packages/domain/src/items/branch-price.ts, modes fixed | fixed_markup | percent_markup). The basis comes from `itemsRepo.costBasisFor(tx, orgId, itemId)` (latest landed delivery cost, or a linked cost-basis item's), used by `branchPriceFor` (packages/domain/src/items/index.ts:1628).

## Rule
1. **Schema (migration 0289, hand-authored per ADR-012 §5):**
   - `price_list_items`: add `pricing_mode text NOT NULL DEFAULT 'fixed'` CHECK in ('fixed','fixed_markup','percent_markup'); add `markup_amount numeric(14,2)`, `markup_percent numeric(8,4)`; make `rate` nullable. CHECK shape: fixed ⇒ rate NOT NULL and both markups NULL; fixed_markup ⇒ markup_amount NOT NULL (≥ 0), rate and markup_percent NULL; percent_markup ⇒ markup_percent NOT NULL (≥ 0), rate and markup_amount NULL. Existing rows are all fixed with a rate, so the CHECK passes with no backfill (pre-check counts violators and refuses, naming them).
   - `price_lists`: add `is_default boolean NOT NULL DEFAULT false` + partial unique index one default per org among non-retired lists (`WHERE is_default AND retired_at IS NULL`).
   - Drizzle schema mirrors; classification + RLS registry unchanged (no new table).
2. **Domain:**
   - The set-rate function takes `{ mode, rate?, markupAmount?, markupPercent?, unit? }` and validates the shape (same messages style as item pricing; field rules in packages/domain/src/field-rules).
   - `setDefaultPriceList(actor, {priceListId | null})`: clears the old default and sets the new one in one transaction; retired lists cannot be default. Same capability as editing price lists.
   - **One resolver** `quoteForCustomer(tx, orgId, customerId, itemId)` → `{ rate: string; basis: 'fixed' | 'cost_plus'; listId } | null`:
     list = customer's price_list_id ?? the org's default list ?? none. No list or item not on the list ⇒ null (today's behaviour: the person types the rate). fixed ⇒ the rate. markup modes ⇒ `computeBranchPrice` over `costBasisFor`; no landed cost yet ⇒ null plus a reason "no delivery cost yet" for the screen. Internal customers keep `branchPrices` unchanged.
   - The trade order page loader uses the resolver for external customers (replace the direct `listPriceListItems` quote map). Mind the existing ⚠️ about query count (lib.ts:120): compute markup quotes only for items on the relevant lists, batch costBasisFor if a batched read exists, else note `shortcut:`.
3. **ERP — price list page:**
   - "Set a rate" modal: a **"Price"** select first — "Fixed price", "Delivery cost + an amount", "Delivery cost + a percent" (same words as the item pricing screen, ItemPricingFields.tsx:49) — then only the field that mode needs (Rate / Amount / Percent), plus Unit. Show the current delivery cost and the resulting price as a read-only preview when the item has one ("Delivery cost ₱120.00 → ₱128.40"), "No delivery yet: this item has no price until its first delivery" otherwise.
   - The rates table shows the rule and today's price: "Cost + 7% · ₱128.40", "Cost + ₱50 · ₱170.00", "₱100.00".
   - Price lists index: a "Default" badge on the default list and a "Make default" action (confirm) / "Stop being default".
   - Customer page: when the customer has no list, say "Uses the default list: Wholesale" (or "No price list: rates are typed per order" when no default).
4. Order lines still capture the computed number at creation (unchanged rule). Later cost changes never move old orders.

## Tests (each with a mutant that goes red)
1. Migration: shape CHECK refuses a fixed row with a markup, a percent row with a rate, etc.; one default per org (second default refused); existing rows survive.
2. Resolver: customer with list → item's rule; customer without list → default list; no default → null; item not on list → null; percent 7% on cost 120 → 128.40 exact; amount 50 → 170.00; no landed cost → null with reason. Mutant: skip the default fallback → red.
3. Order page uses the resolver for external customers (source/integration test).
4. Retired list cannot be made default; making B default unsets A.
5. Census guards (t412 for the new confirm, touch-target census:write, field-rules live checks).

census:write; tsc -p apps/erp + new package test files; full suite on a fresh gate DB (migration); impeccable for the modal and the rates table.
