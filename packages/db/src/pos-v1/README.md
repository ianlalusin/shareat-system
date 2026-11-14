# POS v1 wire vocabulary

## Overview

The boundary translation for legacy POS endpoint paths and misleading wire field names, plus test payload builders.

## Interface

- [wire.ts](./wire.ts): includes `POS_V1_FEED_PATHS`, `POS_V1_PAYMENT_METHODS_PATH`, `POS_V1_STORES_PATH`, `POS_V1_SALES_FIELDS`, `POS_V1_SOLD_ITEMS_FIELDS`.
- [fixtures.ts](./fixtures.ts): includes `PosV1SalesFigures`, `posV1SalesBody`, `PosV1SoldItemInput`, `posV1SoldItemsBody`.

## Invariants

- Spell POS wire names here and consume the v2-named key map elsewhere. The legacy residual field is deliberately absent from the sales map.
- fixtures.ts builds test payloads; it is not a network client or a production feed reader.

## Side Effects

- Constants and payload builders perform no network or database I/O.

## Verification

- From the repository root: `npm run typecheck` and `npm test`.
- Database paths: `npm run test:integration` against real PostgreSQL, using the root Vitest integration configuration.
