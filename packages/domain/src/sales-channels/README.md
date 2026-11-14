# Sales Channels
## Overview
Sales-channel administration (T-230, closes DEF-207): create, update, activate/deactivate and list a store's sales channels, plus the wastage-mode policy. Before this module `sales_channels` had no production writer, leaving new stores permanently not-ready.

## Interface
- `index.ts`: `createSalesChannel`, `updateSalesChannel`, `setSalesChannelActive`, `listSalesChannelsForAdmin`, `receivableAccountOptions`, types `SalesChannelWastageMode` (`'tracked' | 'instant'`), `SalesChannelAdminRow`, `CreateSalesChannelInput`, `UpdateSalesChannelInput`.

## Invariants
- Gate is `manage_store_settings` (store-scoped, a manager holds it); it deliberately does not live in `stores/service.ts`, whose gate is admin-only `manage_stores`.
- It does NOT write `destination_money_account_id` (owned by `channel-settlements`' `setChannelPayoutDestination`; a second writer would drift) or `tax_treatment` (only one supported value).
- Every mutation authorizes first.

## Side Effects
- Writes `sales_channels` rows via the repo in the caller's `Tx`; no ledger posting.

## Verification
- Run: `npm test` (from the repo root C:\Users\ianla\webapps\shareat-system; vitest unit project)
