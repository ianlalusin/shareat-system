# Menu
## Overview
Domain layer of the ERP menu and catalog master (docs/tasks/401-erp-menu-catalog-master.md): categories, items, variants, option groups, depletion rules, store price offers, and item requests, plus the pure store-menu projection and price resolver. It posts nothing to the ledger; it is master data with an audit trail.

## Interface
- `catalog.ts`: `createMenuCategory`, `editMenuCategory`, `retireMenuCategory`, `createMenuItem`, `editMenuItem`, `retireMenuItem`, `addMenuVariant`, `editMenuVariant`, `retireMenuVariant`, `CreateMenuCategoryInput`, `EditMenuCategoryInput`, `CreateMenuItemInput`, `EditMenuItemInput`, `EditMenuVariantInput`
- `options.ts`: `createOptionGroup`, `editOptionGroup`, `addOptionValue`, `editOptionValue`, `linkOptionGroup`, `unlinkOptionGroup`, `setPackageRefills`, `CreateOptionGroupInput`, `EditOptionGroupInput`, `LinkOptionGroupInput`
- `pricing.ts`: `setDepletionRule`, `cancelScheduledDepletionRule`, `setMenuOffer`, `withdrawMenuOffer`, `cancelScheduledOffer`, `setOptionOffer`, `cancelScheduledOptionOffer`, `SetDepletionRuleInput`, `SetMenuOfferInput`
- `requests.ts`: `requestMenuItem`, `withdrawMenuItemRequest`, `approveMenuItemRequest`, `markMenuItemRequestDuplicate`, `rejectMenuItemRequest`, `PossibleDuplicate`
- `resolve-price.ts` (pure): `resolveOfferPrice`, `OfferPriceInput`, `ResolvableOffer`, `NotOfferedReason`, `ResolvedOfferPrice`
- `project.ts` (pure, not re-exported by `index.ts`): `projectStoreMenu`, `MenuSnapshot`, `StoreOffersAt`, `StoreMenuV1`, `ProjectedCategory`, `ProjectedItem`, `ProjectedVariant`, `ProjectedOptionGroup`, `ProjectedStoreMenu`, `MenuNotOfferedReason`, `ChannelOffer`, `ChannelDelta`
- `shared.ts` (not re-exported): `inTx`, `audit`, `requireName`, `parseMenuAmount`, `parseMarkupPercent`, `parseMenuQuantity`, `requireNotBackdated`, `requireScheduled`, `changedFields`, `requireHistorySlot`, `requireUsableRuleTarget`
- `index.ts` re-exports catalog, options, pricing, requests, resolve-price.

## Invariants
- Every writer has the shape `(actor, input, tx?)`: `authorize()` first, then the write and exactly one `audit_log` row in the same transaction (`inTx` + `audit`).
- Gates: `add_menu_item` (super admin only) for `createMenuItem`/`addMenuVariant`/resolving item requests; `manage_menu` for the rest of catalog and options; `set_menu_depletion` (org) for rules; `set_menu_price` (store-scoped) for offers and option offers; `request_menu_item` (store-scoped) to ask.
- Depletion rules, offers and option offers are append-only, effective-dated history: never updated, never back-dated; a change is a new row. A scheduled row may be cancelled until it takes effect; one in effect never goes.
- Money arrives as text, at most two decimals; more is refused, never rounded (I13b). An offer amount is never negative; an option delta may be.
- An item is created WITH its default variant and is never reactivated without an active one. Database triggers are the backstop for retire/item_type rules; the domain turns the common ones into sentences.
- `resolveOfferPrice` is pure: exact decimal arithmetic, rounded once, half-up on the absolute value to the centavo. A rule never clamps: a negative result is "not offered" with a reason, never 0.00. An online rule resolves at read against the store row in force at the same instant.
- `projectStoreMenu` is pure and carrier-neutral (no DB, clock, Firestore or network); the instant is passed in as `at`. Every price comes from `resolveOfferPrice`.
- Only a super admin resolves an item request; approval creates the item through `createMenuItem` in the same transaction; a requester withdraws only their own open request.

## Side Effects
- DB writes through `menuRepo` and `auditLogRepo` (one audit row per write); `inTx` opens a `transaction` when no `tx` is passed.
- `authorize()` in every writer.
- `resolve-price.ts` and `project.ts` are pure (no DB, clock or env). No ledger posting.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
