# src/lib contract

## Overview

Shared POS wire types, API routing, tax/bill calculations and small display/selection helpers, with specialized child services.

## Interface

- [types.ts](./types.ts) — `UserRole`, `StatutoryDiner`, `User`, `Session`, `UserDocument`, `Product`, `ProductRequestStatus`, `ProductRequestKind`, `ProductRequest`, `ProductPhotoStatus`, `ProductPhotoRequest`, `OptionGroupValue`, `OptionGroup`, `InventoryItem`.
- [api-base.ts](./api-base.ts) — `API_BASE`, `POS2_API_BASE`, `apiUrl`, `installApiBaseFetch`.
- [appVersion.ts](./appVersion.ts) — `APP_VERSION`.
- [loyaltyRewardScope.ts](./loyaltyRewardScope.ts) — `RewardStoreScope`, `isRewardOfferedAtStore`, `isRewardAllowedAtStore`.
- [money.ts](./money.ts) — `roundMoney`, `round2`.
- [payment-label.ts](./payment-label.ts) — `paymentLabel`.
- [phone.ts](./phone.ts) — `normalizePhone`.
- [refill-selection.ts](./refill-selection.ts) — `FlavorCarrying`, `SelectionResult`, `pruneFlavorless`, `applyRefillTap`, `picksFlavorFor`.
- [refill-visibility.ts](./refill-visibility.ts) — `RefillLike`, `globalInactiveIds`, `partitionVisibleRefills`, `stalePackageIds`.
- [sessionLabel.ts](./sessionLabel.ts) — `sessionTableLabel`, `sessionDialogLabel`.
- [tax.ts](./tax.ts) — `TaxAndTotals`, `LoyaltyDiscountInput`, `TaxAndTotalsCentavos`, `calculateBillTotalsCentavos`, `calculateBillTotals`.
- [uom.ts](./uom.ts) — `UOM_OPTIONS`, `Uom`, `normalizeUom`, `allowsDecimalQty`, `formatKitchenQty`.
- [utils.ts](./utils.ts) — `cn`.
- [analytics](./analytics/README.md) — Receipt/KDS contribution math and adapters for client and server-first analytics deltas.
- [billing](./billing/README.md) — Additional-griller charge lookup, adjustment construction and bundle headcount rules.
- [cash](./cash/README.md) — Cash method identification, handover calculations and durable submission-attempt handling.
- [cashier](./cashier/README.md) — Cashier behavior-tip text, milestone classification and next-tip selection.
- [chat](./chat/README.md) — Module-level tracker for the last local profile whose chat presence this tab logged.
- [collections](./collections/README.md) — Fetch/subscription adapters for global discounts and charges with date/store applicability.
- [export](./export/README.md) — Browser XLSX export helper.
- [firebase](./firebase/README.md) — Primary client Firebase SDK handles, media upload helpers and undefined-value sanitization.
- [images](./images/README.md) — Shared client image loading, resizing and ImageData generation for QR decoding and proof uploads.
- [kitchen](./kitchen/README.md) — Pure billing/served-quantity helpers, server-clock correction and SLA thresholds.
- [logs](./logs/README.md) — Maps activity-log actions, amounts and metadata to readable timeline text.
- [loyalty](./loyalty/README.md) — Customer-query classification, card QR parsing, phone masking and session-link helpers.
- [money](./money/README.md) — Centavo conversion, exact rational bill stages, display formatting and refund-share allocation.
- [notifications](./notifications/README.md) — Kitchen alert adapter for native notifications/haptics and browser audio/notifications.
- [offline](./offline/README.md) — Local-first write helpers, device identity, offline tender rules, ownership fields and deferred-effect replay.
- [outbox](./outbox/README.md) — Durable sale ledger, deferred effects, reconciliation, offline-period state and unsent-sales/update controls.
- [payments](./payments/README.md) — Boundary index for paymongo, proof.
- [pos2](./pos2/README.md) — Authenticated POS2 client transport and interpretation of uncertain void outcomes.
- [printing](./printing/README.md) — Receipt/PIN/kitchen/X-slip formatting and browser, Bluetooth and WebUSB print transports.
- [products](./products/README.md) — Shared product-family, variant label, sellable-SKU and image-fallback helpers.
- [qr](./qr/README.md) — QR image decoding, EMVCo TLV/CRC parsing, deterministic initials and online-wallet QR selection.
- [receipts](./receipts/README.md) — Validated receipt-print settings, live/cache-first settings reads and post-payment destination choice.
- [reservations](./reservations/README.md) — Reservation event/status presentation and one-shot seating handoff to cashier.
- [server-profiles](./server-profiles/README.md) — Local actor identity bridge, profile HTTP operations and account-level gate bypass predicate.
- [session-timeline](./session-timeline/README.md) — Collects local actor names and resolves staff UIDs for readable timeline attribution.
- [statutory](./statutory/README.md) — Senior/PWD identity capture, diner shares, exact totals and receipt/payment integration.
- [storefront](./storefront/README.md) — Delivery/pricing sanitization and online-order availability calculations.
- [terminal](./terminal/README.md) — Terminal claim/release ports, monotonic receipt numbering and the shared tablet IndexedDB opener.
- [ui](./ui/README.md) — Removes orphaned Radix overlay portals and stuck interaction locks.
- [utils](./utils/README.md) — Timestamp conversion, local date formatting, menu-schedule applicability and session labels.
- [weather](./weather/README.md) — Weather icon metadata, night-hour classification and calendar-specific icon variants.

## Invariants

- Money compatibility exports forward to the centavo implementation.
- Refill selection and visibility helpers are pure state transformations.
- The native API shim routes POS2 calls separately from the legacy API base.

## Side Effects

- The API-base installer replaces browser fetch once for APK-relative API requests.
- Most sibling display/math helpers are pure; child modules own Firebase, IndexedDB and printing operations.

## Verification

- From the repository root: `npm test -w @shareat/pos` (the package script uses `vitest.config.mts`, Node environment, `src/**/*.test.ts`).
- Root unit tests exclude POS; they do not establish this package's test coverage. This documentation pass did not run the suite.

## Inspection scope

Inspected 13 direct source files (35075 UTF-8 bytes), at most 300 lines per file. Long-file tails are outside this bounded contract inventory; consult source before changing a workflow.
