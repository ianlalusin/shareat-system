# T-632: "What this store sells": one screen per store, every company menu item switched on or off

**Owner:** builder (Sonnet), laptop. Auditor: Sonnet (money: prices). **Spec:** BOSS (Opus), 24 Nov 2026.
**No migration expected.** If one turns out to be needed, STOP and ask BOSS.

**Ian, 24 Nov 2026:**
- He sets up Lipa's menu on screen, not with the v1 copy tool.
- "the central shall only be packages, flavors, refill, products (like v1); table number, stations, is individual to stores".
- He wants it "like the payment methods": a central list, each store switches items on.

## Today (facts)

- The catalogue is already org-wide: `menu_items` / `menu_item_variants` (packages, a-la-carte, refills), option groups and values (flavours), `menu_package_refills`, `menu_categories` (packages/db/schema/menu.ts).
- A store sells a variant only when it has a `menu_offers` row. That is a price per store, channel and daypart, effective-dated and withdrawable; no row means not offered.
- Flavours follow the same pattern per store in `menu_option_offers`.
- A refill is offered by a zero-price offer (amount NULL).
- The POS menu drops an offered item that has no kitchen route (`project.ts:64`).
- Screens:
  - /menu (catalogue)
  - /menu/items/[id] (variants, flavours, refills)
  - /menu/prices (set, withdraw or schedule a price per store; `setMenuOffer` / `withdrawMenuOffer` / `setOptionOffer` in packages/domain/src/menu/pricing.ts, capability `set_menu_price` at the store)
- **The gap:** "switch this item on at this store" is a side effect of typing a price on /menu/prices. No single view shows a store everything it sells and doesn't sell.

## Rule

- **New screen:** "What <store> sells", reachable from /menu and from /menu/prices with a store picker (the store in the URL, e.g. /menu/stores/[storeId]). Same capability as /menu/prices. Read access follows the existing menu read rule.
- Grouped by category, every ACTIVE company item appears with:
  - an **on/off switch** for this store
  - its **price for each of the store's dayparts** (lunch, dinner, or all-day), editable inline or in a small dialog
  - a **kitchen station** warning chip when it is on but has no route ("Not on the tablet: no kitchen station", linking to /kitchen). Do not build route editing here.
- **Switching ON** a package or product asks for its price per daypart, prefilled from the price it had at this store most recently, or else from the same item at another store as a suggestion (never saved without the user confirming). It saves through `setMenuOffer`. A refill switches on with no price (the existing zero-price offer).
- **Switching OFF** withdraws through `withdrawMenuOffer`, for every daypart and channel row of that variant at this store. It says plainly that past sales are kept.
- **Variants** (e.g. Glass / Pitcher) show as sub-rows with their own switch and price.
- **Flavours:** under a package that has flavour groups, an expandable list of the option values with on/off and the price difference, through `setOptionOffer`.
- **Write paths:** use ONLY the existing domain functions (authorize first, audit, effective dating, append-only). Add a domain function only if a bulk switch-off needs one transaction; then authorize first and audit.
- **Top of the page:** counts ("42 on · 18 off · 3 on with no kitchen station") and a filter (all / on / off / needs a station). Phone (390px): rows become cards; no sideways scroll; tap targets 44px.
- **Online channel prices** (pricing_mode / markup) are NOT edited here. Show a quiet "Online prices: Menu > Prices" link.

## Not in this task

- Central kitchen stations, dayparts, discounts or charges (Ian: per store).
- Table numbers: that is T-633.
- Route editing.
- Category hiding per store.
- Online channel prices.

## Tests (each with a mutant that goes red)

1. Switching on writes offers for each daypart through `setMenuOffer`; switching off withdraws every row of that variant at the store (mutant: withdraw one daypart only → red).
2. A cashier or store user without `set_menu_price` is refused (authorize first).
3. The page lists an off item as off, an on item with its daypart prices, and the "no kitchen station" chip for an on item without a route (mutant: chip missing → red).
4. Flavour value on/off through `setOptionOffer`.
5. The POS snapshot for the store includes an item switched on here, and excludes one switched off (existing loadStoreMenu path).

Run `npm run census:write` (t450 table inventory, touch targets, row links, action-link sweep, domain-actions-have-callers). Typecheck apps/erp, and package tests via a temp tsconfig. Invoke the `impeccable` skill. Check the page in a browser if RAM allows.


## As built (builder, 24 Nov 2026) - NOT YET VERIFIED BY A RUN

Free RAM stayed at about 2.3 GB for over 15 minutes (limits: 3 GB tsc, 2.5 GB vitest), so **no typecheck, test, census or browser check has been run**. Resume with test DB `t632_test` (already created and migrated) and a temp `.env.local` copied from the main tree.

- `packages/db/src/repo/menu.ts`: `lastStorePrices` (the newest fixed store price per variant and daypart, for the prefill).
- `packages/domain/src/menu/store-menu.ts`: `switchVariantOn` / `switchVariantOff` / `switchOptionValue` (authorize first, then the existing writers in one transaction, so each row audits as before and no new audit action exists) and `loadStoreSells` (the read model: on/off, form slots, prefill, no-station flag, flavours).
- `apps/erp/src/app/menu/stores/[storeId]/{page.tsx,actions.ts,README.md}`; links from /menu and /menu/prices; crumbs added to `nav-crumbs.ts`.
- Rules chosen: a store with active menu hours asks one price per hour (blank = not sold then); creating or removing an hour-based price needs `pair_menu_dayparts` (T-510 R8), so for a plain admin the switch buttons are hidden at such a store and the page says so; a price change is open to anyone with `set_menu_price`. An item is "on" if any live offer on any channel; the no-station chip needs a live STORE-channel offer.
- Tests: `packages/domain/tests/integration/t632-store-menu.test.ts` (9 tests, spec tests 1-5).
