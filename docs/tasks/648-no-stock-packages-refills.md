# T-648: One click sets every package and refill to "Uses no stock"

**Owner:** builder (Sonnet). **Auditor:** Sonnet (authorization + data). **Spec:** BOSS (Opus), 28 Nov 2026. **No migration. No new capability. No new dependency.**

**Ian, 28 Nov 2026:** "yes add one-click No stock for packages and refills". Why: package and refill usage cannot be measured per sale, so it is hand-entered on the usage screen. Their stock rule must be "Uses no stock" so a sale depletes nothing and the hand-entered usage is the only count (no double count).

## Facts (origin/main, 28 Nov)
- `menu_items.item_type` in ('a_la_carte','package','refill') (packages/db/schema/menu.ts:44).
- Rules are per VARIANT, org-wide, effective-dated, append-only: `setDepletionRule(actor, {variantId, mode, ...}, tx?)` in packages/domain/src/menu/pricing.ts:37. It authorizes `set_menu_depletion`, refuses backdating, checks the history slot (`requireHistorySlot`), then inserts.
- Per-item form today: apps/erp/src/app/menu/items/[id]/page.tsx:169 (`setDepletionRuleAction`, actions.ts:89). Labels: `MODE_LABEL` page.tsx:46 ("Uses no stock").

## Rule
1. **Domain** (packages/domain/src/menu/pricing.ts, next to setDepletionRule): `setNoStockForPackagesAndRefills(actor, tx?)` → `{ changed: number; skipped: { variantId: string; itemName: string; reason: 'scheduled_change' }[] }`.
   - ONE transaction (`inTx`). `authorize(trx, actor, 'set_menu_depletion', {})` first.
   - Targets: variants of menu items with item_type package or refill, item active, variant active, whose rule IN FORCE now is missing or not `no_stock`. Variants already `no_stock` are left alone (no duplicate row). Read through menuRepo (add one repo read if none fits; SQL only in packages/db/src/repo).
   - For each target call `setDepletionRule(actor, { variantId, mode: 'no_stock' }, trx)` so validation, history slot and audit stay in one place. If a variant has a SCHEDULED future rule and the history-slot check refuses, do not fail the batch: skip it and report it in `skipped` (catch only that refusal; any other error rolls the whole batch back).
   - Effective now (no effectiveFrom).
   - Export from the domain index like setDepletionRule.
2. **Count read** for the button: `countPackageRefillVariantsNeedingNoStock(tx, orgId)` (or return the list from the same repo read) — same target definition as rule 1.
3. **ERP** — on the /menu overview page (apps/erp/src/app/menu/page.tsx), shown only when the person holds `set_menu_depletion` AND the count > 0:
   - A small panel/line: "**{n} package and refill variants still use stock.** Their usage is entered by hand, so a sale should use no stock." + a button **"Set all to Uses no stock"**.
   - The button opens the house confirm (`ConfirmDestructive tier="confirm"`, `showLabel`/quiet as fits the page) with consequence: "Sets {n} package and refill variants to Uses no stock, from now. A sale of them takes nothing from stock; only the usage you enter counts. You can change any item back on its page."
   - Server action in apps/erp/src/app/menu/actions.ts (or the page's existing actions file): requireActor, call the domain function, flash "Set {changed} variants to Uses no stock." plus, when skipped is non-empty, "{k} skipped because a change is already scheduled: {names}." revalidate /menu.
   - When count is 0 the panel is not rendered (no empty banner).
4. Wording: plain, no jargon ("stock rule" may stay since the item page uses it).

## Tests (each with a mutant that goes red)
1. Domain integration (scratch DB, house fixtures): a package variant (direct rule), a refill variant (no rule), an a-la-carte variant (direct rule), an inactive package, a package already no_stock → after the call: package + refill now no_stock, a-la-carte unchanged, inactive untouched, already-no_stock has no new row; `changed` = 2. Mutant: drop the item_type filter → a-la-carte changes → red.
2. A person without `set_menu_depletion` is refused and nothing is written.
3. A variant with a scheduled future rule is skipped and reported; the others still change.
4. Page-level unit/source test: the panel is gated on the capability and on count > 0; the action calls `setNoStockForPackagesAndRefills`.
5. Census guards stay green: t412 destructive census (+1 Tier C row for the new confirm, update by hand and say so), touch-target / action-link-sweep (`npm run census:write`), domain-actions-have-callers.

census:write; `npx tsc -p apps/erp --noEmit` + a temp tsconfig for new package test files; impeccable for the panel placement on /menu.
