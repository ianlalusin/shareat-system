# V1-COPY: where this code came from

- Source: POS v1 (`shareat-hub-v2` app), commit `e26d0c1` (e26d0c1aab93dedcdfedd19a82f95c42defe135f).
- Copied: 2026-10-16, 311 files (import closure of the kept routes, T-422 Ruling 4).
- Re-run: `node apps/pos/scripts/copy-from-v1.mjs --repo <POS repo> --commit <sha>` (reads git objects only, never the working tree).
- Tests not copied because they import code outside the closure (1):
  - src/lib/qr/emvco.test.ts (imports uncopied src/lib/qr/__fixtures__/qrph.ts)

<!-- HAND-EDITS: kept by copy-from-v1.mjs when it is re-run; edit below this line -->

Everything else under `src/` and `public/` is byte-identical to v1 (line endings aside). Edits made by hand after the
copy (T-422 Ruling 6). Re-running the copy script brings the originals back; re-apply these.

## Edited files

- `src/app/receipts/page.tsx` (6a, 6b, 6c): removed the unsafe paid-receipt void (`handleVoidReceipt`, `handleVoidClick`, the void `ReasonModal`, DEF-651), the in-place paid-receipt edit (`EditReceiptDialog`, `handleSaveCorrection`, its button, ADR-015 A4.2) and the receipt-template dialog + button; the Void button is now disabled, labelled "Void — coming in the safe flow", title names T-423. Refund is untouched.
- `src/components/layout/main-nav.tsx` (6d): dropped the Dashboard and Admin links; `/admin/online-orders` is now `/online-orders` (link, badge and open-count checks).
- The online-orders page (6d) moved from v1 admin/online-orders to src/app/online-orders/page.tsx; content unchanged, so it is not edited and not listed as changed.
- `src/components/auth/first-login-guard.tsx` (6d): post-login home for admin/manager/unknown role was `/dashboard`, now `/cashier`.
- `src/components/guards/RoleGuard.tsx` (6d): same home change (`/dashboard` -> `/cashier`).
- `src/app/change-password/page.tsx` (6d): same home change.
- `src/components/layout/header.tsx` (6d): logo links to `/cashier` instead of `/dashboard`.
- `src/components/layout/store-switcher.tsx` (6d): removed the admin "Create Store" item, which pushed to the dropped `/admin/stores` (store master data is ERP, row 307).
- `src/app/layout.tsx` (6e): application name, title and title template are "Shareat POS v2".
- `public/manifest.webmanifest` (6e): `name` and `short_name` are "Shareat POS v2"; `start_url` unchanged.

## Files deleted after the copy (orphaned by the edits above; Acceptance 3)

- `src/components/receipts/EditReceiptDialog.tsx`, `src/components/manager/store-settings/receipt-settings.tsx`,
  `src/components/shared/ReasonModal.tsx`, `src/components/cashier/payment-section.tsx` (only EditReceiptDialog used it),
  `src/components/ui/slider.tsx` (only receipt-settings used it; `@radix-ui/react-slider` dropped with it).

## Type-only fixes forced by the monorepo (6f)

- None needed: `tsc -p apps/pos/tsconfig.json` is clean with the two Ruling 8 overrides only.

## Tests

- The 33 copied v1 test files pass under vitest 4 (`npm test -w @shareat/pos`). One v1 test was not copied (see the list above).

## Added edits (audit fix, 6d)

- `src/components/dashboard/WeatherLogFloatingButton.tsx` (6d): removed the "View calendar" button that pushed to the dropped `/weather-calendar`; the weather logger itself is unchanged.
- `src/components/shared/WeatherLoggerModal.tsx` (6d): removed the "See monthly logs" button that pushed to `/weather-calendar`; the weather logger itself is unchanged.

## T-423 edits (money in centavos, one receipt series per tablet, unpaid-void fixes)

- `src/lib/money.ts` (T-423 S1): now only re-exports `roundMoney` / `round2` from `lib/money/centavos.ts`; the float rounder is gone (DEF-003).
- `src/lib/tax.ts` (T-423 S1): rewritten on exact fractions; same `calculateBillTotals` signature and keys, new `calculateBillTotalsCentavos`; the private `round()` is deleted. Golden-tested against the v1 original.
- `src/lib/types.ts` (T-423 S2): `Receipt` gains the additive optional fields `terminalNo`, `terminalSeq`, `deviceId`.
- `src/lib/offline/offlinePaymentSummary.ts` (T-423 S1): cents/pesos conversions go through `lib/money/centavos.ts`.
- `src/lib/cash/handover.ts` (T-423 S1): cents/pesos conversions go through `lib/money/centavos.ts`.
- `src/lib/offline/replayDeferredEffects.ts` (T-423 S3): optional `isSessionVoided` dep; a queued void reverses loyalty only if the session really is voided.
- `src/components/cashier/firestore.ts` (T-423 S1-S3): `completePaymentFromUnits` takes the receipt number from the terminal series (`reserveNext()` outside the transaction), writes `receiptNumbers/{number}` and the three additive receipt fields, checks the terminal doc, uses the shared tender/change summary and centavo maths, no longer touches `counters/receipts`; `voidSession` re-reads tickets and table inside the transaction and queues the loyalty reversal before commit; `formatReceiptNumber` and `roundMoney` use are gone.
- `src/components/cashier/offlinePayment.ts` (T-423 S2): numbers the sale from the same `reserveNext()` series (no `OL` numbers, no localStorage counter), writes the `receiptNumbers` doc in the batch, centavo maths.
- `src/components/cashier/payment-modal.tsx` (T-423 S1): the private cents converters move onto `lib/money/centavos.ts`; sums are taken in centavos.
- `src/components/cashier/void-session-dialog.tsx` (T-423 S3): the online loyalty refund drops the queued copy only when every refund call succeeded.
- `src/components/shared/PaymentQueueSyncProvider.tsx` (T-423 S3): passes the `isSessionVoided` check (reads the session doc) to the replay.
- `src/app/settings/page.tsx` (T-423 S2): adds the `Terminal` section (`components/settings/TerminalSection.tsx`, new file).

- `src/lib/offline/browserDevice.ts` and `src/lib/offline/browserDevice.test.ts` (T-423 audit): removed the dead `deviceReceiptTag` (4-char tag for the old OL numbers) and its test block.
- `src/lib/offline/replayDeferredEffects.ts` (T-423 audit): a queued void is never dropped within 10 minutes of its enqueue; after that only if the server read still says not voided.
- `src/components/shared/PaymentQueueSyncProvider.tsx` (T-423 audit): the voided check reads the session with `getDocFromServer`.

Files deleted (T-423 S2): `src/lib/offline/offlineReceiptNumber.ts` and `src/lib/offline/offlineReceiptNumber.test.ts` (the localStorage daily counter, DEF-587).

## T-424 edits (manager-PIN approvals through the POS v2 server)

- `src/middleware.ts` (T-424 S4): v1's middleware is replaced by the APK-origin CORS gate for `/api/:path*` (only `https://localhost` is allowed). Server build only: `scripts/build-cap.mjs` stashes it, and `src/app/api`, during the static export.
- `src/lib/api-base.ts` (T-424 S4): a fetch of `/api/pos2/...` goes to `NEXT_PUBLIC_POS2_API_BASE` (default `https://pos2.shareat.net`); every other `/api/...` keeps `NEXT_PUBLIC_API_BASE`.
- `src/lib/analytics/applyReceiptDeltaServerFirst.ts` (T-424 S10): sale and void deltas go to `/api/pos2/analytics/apply-delta` only when built with `NEXT_PUBLIC_POS2_ANALYTICS=1`; otherwise v1's endpoint as before.
- `src/components/receipts/RefundReceiptDialog.tsx` (T-424 S9): the refund calls `POST /api/pos2/refunds` (manager PIN pad, cash-only tender picker, paid-share amounts) instead of writing the refund from the tablet; `createRefundReceipt` in `components/cashier/firestore.ts` is DELETED (audit): it wrote a refund from the tablet with no PIN.
- `src/components/cashier/void-session-dialog.tsx` (T-424 S9): the online void calls `POST /api/pos2/session-voids` (a manager or admin voids without a PIN; anyone else types a store manager's PIN); the loyalty reversal is still queued before the void and taken back out if the server refuses. The offline void is unchanged.
- `src/app/receipts/page.tsx` (T-424 S9): the disabled "Void - coming in the safe flow" button is replaced by "Refund" and a "Mark wrong tender" button (`components/receipts/TenderCorrectionDialog.tsx`, new file).
- `src/components/settings/TerminalSection.tsx` (T-424 S5): shows this tablet's device id with a Copy button, so an administrator can register the tablet for approvals.

- `src/components/cashier/firestore.ts` (T-424 audit): the dead client writers `createRefundReceipt` and `voidSession` are deleted (no caller; they wrote without a PIN). `src/components/cashier/void-session.test.ts` loses its `voidSession` cases; the replay-check cases stay.

**Known drift (T-424):** a refund made through the POS v2 server does NOT do what v1's `apply-delta 'refund'` also did: it skips the `catalogCache/popularItems` decrement and the `dailySessions` refund row. The CUSTOMER app's "Popular" group may therefore overcount refunded dishes. The ERP day feed (`analytics` day docs) is unaffected.

New in T-424, not from v1: `src/server/**` and `src/app/api/pos2/**` (the POS v2 server), `src/lib/pos2/client.ts`, `src/lib/money/refundShare.ts`, `src/components/pos2/PinPad.tsx`, `scripts/pos2-audit.mjs`.

Ported from v1 into `src/server/pos2/` (the vendored fixtures below are the parity reference): `analytics/delta-core.ts` (v1 `src/lib/analytics/delta-core.ts`, byte-identical apart from the header), `analytics/apply-delta-core.ts` (v1 `src/lib/server/analytics/applyAnalyticsDeltaServer.ts`, FieldValue taken from `db`), `payment-conversion.ts` (v1 `applyPaymentConversionServer.ts` `writeByMethodDeltaServer`), `apply-delta.ts` (v1 `src/app/api/analytics/apply-delta/route.ts`, ops payment / refund / void only), `identity.ts` (v1 `lib/server/staff-access.ts`, without its platform-admin bypass). NOT ported: v1's popular-items counter and daily session timeline rows (the test Firebase project has no customer app or timeline reader).

## Test fixtures

- `src/lib/__fixtures__/tax-v1.ts` (T-423 slice T): the v1 tax module at commit e26d0c1, byte-identical (taken with git show from the v1 repo); read only by `src/lib/tax.golden.test.ts` as the golden reference for the new bill math. Do not edit it and do not import it from app code.
- `src/lib/__fixtures__/v1-analytics/delta-core.ts` (T-424 slice T): v1's `src/lib/analytics/delta-core.ts` at e26d0c1, byte-identical. Read only by T-424 tests (`src/server/__tests__/*`). Do not edit it and do not import it from app code.
- `src/lib/__fixtures__/v1-analytics/applyAnalyticsDeltaServer.ts` (T-424 slice T): v1's `src/lib/server/analytics/applyAnalyticsDeltaServer.ts` at e26d0c1; only three import lines differ (`server-only` removed, `firebase-admin/firestore` -> `./admin-shim`, `@/lib/analytics/delta-core` -> `./delta-core`). Same rules.
- `src/lib/__fixtures__/v1-analytics/applyPaymentConversionServer.ts` (T-424 slice T): v1's `src/lib/server/analytics/applyPaymentConversionServer.ts` at e26d0c1; same three import edits. Same rules.
- `src/lib/__fixtures__/v1-analytics/admin-shim.ts` (T-424 slice T): NOT v1 code; a `FieldValue` shim that returns the in-memory fake's sentinels so the vendored files run against the fake.
- The lib/analytics daily module (copied in T-422) is already byte-identical to v1 and is what the vendored delta code imports; it needs no entry.

## T-425 edits (offline selling: sale ledger, server-proven sync, reachability, offline rules, X-slip)

- `src/components/cashier/offlinePayment.ts` (T-425 S1/S4): ledger-first. The complete write list is built as plain data (`ops`), the receipt number is reserved and the event stored in ONE IndexedDB transaction (`reserveOfflineEvent`), then the Firestore batch is built FROM those ops (`applyOpsToBatch`); payment doc ids are fixed `<sessionId>-p<index>`; refuses a table opened on another tablet and any tender that needs the internet / lacks a reference BEFORE a number is reserved; the receipt gains the additive `tendersToCheck`; the deferred effects item goes to the IndexedDB effects store (`addToQueue` is gone).
- `src/components/cashier/offlineVoid.ts` (T-425 S1/S4): manager or admin only, owner-checked, ledger-first (a `void` event reserves a number); the session update carries the additive `voidedOffline: true`.
- `src/components/cashier/firestore.ts` (T-425 S1/S3): the online sale reserves its number through the ledger (`reserveOnlineEvent`), then `markAcknowledged` / `markSkipped`; `navigator.onLine` reads (backup print, bill-line edits) ask the connectivity store; the unused `addToQueue`/`getQueue` imports are gone.
- `src/components/cashier/payment-modal.tsx` (T-425 S4): offline, card / QR Ph / other methods are listed disabled with "Needs the internet" and an e-wallet needs a reference.
- `src/components/cashier/void-session-dialog.tsx` (T-425 S2/S4): the loyalty-reversal queue is the IndexedDB effects store; offline, a non-manager/admin sees the refusal sentence and cannot confirm.
- `src/components/receipts/RefundReceiptDialog.tsx` (T-425 S4): offline shows "Refunds need the internet." and cannot submit.
- `src/lib/offline/payment-queue.ts` (T-425 S2): now only the item types and pure helpers (no storage); the queue is `src/lib/outbox/effects-store.ts`. `src/hooks/use-payment-queue-sync.ts` and `src/components/shared/PaymentQueueSyncProvider.tsx` drain it, and only for receipts whose ledger row is acknowledged.
- `src/lib/terminal/counter.ts` (T-425 S1): opens through the shared opener `src/lib/terminal/db.ts` (version 2); no hard-coded version 1.
- `src/hooks/use-online-status.ts` (T-425 S3): a thin wrapper over `src/hooks/useConnectivity.ts` (a probe of `/api/pos2/health`, not `navigator.onLine`). `src/components/shared/OfflineBanner.tsx` uses it. `src/lib/pos2/client.ts` reports a network error to the store. The proof-photo capture module keeps its own browser online check (a listed exception in the offline guards: it is a flush guard, not a sale or a connectivity decision).
- `src/app/layout.tsx` (T-425 S5): mounts `OutboxSync` (reconcile), `XSlipScheduler` and `UnsentBanner`. `src/app/settings/page.tsx`: adds the `OutboxSection` (unsent count and update gate, Print X-slip, manager lists).
- `src/components/cashier/void-session.test.ts` (T-425): dropped the unused `getQueue` import and helper (the localStorage queue reader is gone). `src/components/cashier/receipt-number.test.ts` (T-425): the offline cases seed the session owner and give the tablet the device id DEV-A (an offline sale is now refused for a table the tablet did not open).
- `scripts/pos2-audit.mjs` (T-425): also lists sessions voided offline.

New in T-425, not from v1: `src/lib/terminal/db.ts`, `src/lib/outbox/**`, `src/lib/offline/offlineRules.ts`, `src/lib/printing/xSlipFormatter.ts`, `src/lib/money/format.ts`, `src/lib/appVersion.ts`, `src/hooks/useConnectivity.ts`, `src/hooks/useOutboxStatus.ts`, `src/app/api/pos2/health/route.ts`, `src/components/shared/{OutboxSync,UnsentBanner,XSlipScheduler}.tsx`, `src/components/settings/OutboxSection.tsx`, `scripts/pos2-soak-verify.mjs`.

## Later hardening edits (recorded during T-455 integrity check)

- `src/app/receipt/page.tsx` (T-426): pass recorded per-diner statutory data to the receipt view.
- `src/components/cashier/CashHandoverClient.tsx` (T-427): computed cash sales plus the separate audited manual adjustment and conversion totals.
- `src/components/cashier/bill-adjustments.tsx` (T-426): prevent duplicate bill-level statutory discount application.
- `src/components/cashier/bill-totals.tsx` (T-426): use per-diner statutory calculation and qualifying share breakdown.
- `src/components/cashier/session-detail-view.tsx` (T-426): mount statutory capture and carry qualifying records through billing.
- `src/components/cashier/session-list-view.tsx` (T-427): expose Convert and its connectivity restriction.
- `src/components/receipt/receipt-view.tsx` (T-426/T-453): per-diner statutory display, exact staged item amounts, modifiers and current adjustments.
- `src/lib/logs/describe-log.ts` (T-426): readable statutory change descriptions without government identifiers.
- `src/lib/printing/receiptFormatter.ts` (T-426/T-453): statutory summary and exact staged item amounts; exclude free/void quantities and include modifiers.

## T-455 edits (explicit local demo emulator profile)

- `src/firebase/config.ts`: select fixed demo configuration only for the explicit emulator profile; normal configuration retained.
- `src/lib/firebase/client.ts`: connect Auth, Firestore and Storage to local emulators before requests; reject mismatched project configuration.
- `src/lib/api-base.ts`: explicit emulator profile overrides both API destinations to the local POS server.

## T-456 edits (DEF-722 offline first dish)

- `src/components/shared/AddonsPOSModal.tsx`: offline adds stage a fresh bill-line document with the existing payload, then use its id for kitchen tickets and optimistic display; no unavailable read is treated as absence. Repeated offline adds retain separate rows, while online grouping is unchanged.
New helper: `src/lib/offline/addon-line.ts`; no read before staging the fresh document in the caller's existing batch.

T-457 updates the v2-only `src/lib/terminal/claim.ts`: bounded ascending range probes replace the rejected descending-key scan; numbering format, release gap and claim transaction retained. No v1 source was changed.

