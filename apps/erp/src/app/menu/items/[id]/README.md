# [id]

## Overview

Menu item at `/menu/items/[id]`. Menu catalogue, store prices, item requests and POS depletion-source controls.

Parent blueprint: [up one directory](../README.md).

## Interface

- Page route `/menu/items/[id]`; dynamic route segments are supplied through App Router params.
- [actions.ts](./actions.ts) — `editItemAction`, `addVariantAction`, `setDepletionRuleAction`, `createOptionGroupAction`, `editOptionGroupAction`, `addOptionValueAction`, `editOptionValueAction`, `linkOptionGroupAction`, `unlinkOptionGroupAction`, `setPackageRefillsAction`.
- [page.tsx](./page.tsx) — `MenuItemPage`.
- [typed-forms.ts](./typed-forms.ts) — `MENU_ITEM`, `MENU_OPTION_GROUP`, `MENU_OPTION_VALUE`.

## Invariants

- Acting identity comes from `requireActor` / `requireSession`; callers do not obtain an Actor from submitted form fields.
- Page reads go through `requirePageAccess`; menu visibility is not the access boundary.
- Call sites using `withOrgPrincipal` or `runReport` retain their resolved organization principal; preserve that transaction context when changing those queries.
- Server-action exports are request adapters; domain/auth functions retain their own business and capability checks.
- The route exports `dynamic = 'force-dynamic'`; its request data is not a static build snapshot.

## Side Effects

- Submitted forms invoke `editItemAction`, `setDepletionRuleAction`, `addVariantAction`, `setPackageRefillsAction`; these adapters perform the authorized workflow and return feedback/navigation.
- Invokes `addMenuVariant`, `addOptionValue`, `createOptionGroup`, `linkOptionGroup`, `setDepletionRule`, `setPackageRefills`, `unlinkOptionGroup`, `addOptionValueAction`, `addVariantAction`, `createOptionGroupAction`, `linkOptionGroupAction`, `setDepletionRuleAction`, `setPackageRefillsAction`, `unlinkOptionGroupAction`; persistence or external operations belong to those called services.
- Loads screen/report data through `listActiveRecipes`, `listActiveStockItems`, `loadItemPage`.
- Action/navigation helpers redirect responses and, where used, carry safe flash feedback or retained form values.

## Verification

Commands available from the repository root: `npm run typecheck`; `npm run test` (ERP/shared unit project); `npm run test:integration` (database suite, real PostgreSQL). Select affected tests when changing implementation, and coordinate shared test-database access. These commands were not run for this documentation-only change.

Coverage: 3 local production/configuration files scanned; 29,322 bytes, at most 300 lines per implementation file. This contract lists the inspected boundary; large files may contain additional declarations beyond that window.
