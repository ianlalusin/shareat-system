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

## Test fixtures

- `src/lib/__fixtures__/tax-v1.ts` (T-423 slice T): the v1 tax module at commit e26d0c1, byte-identical (taken with git show from the v1 repo); read only by `src/lib/tax.golden.test.ts` as the golden reference for the new bill math. Do not edit it and do not import it from app code.
- `src/lib/__fixtures__/v1-analytics/delta-core.ts` (T-424 slice T): v1's `src/lib/analytics/delta-core.ts` at e26d0c1, byte-identical. Read only by T-424 tests (`src/server/__tests__/*`). Do not edit it and do not import it from app code.
- `src/lib/__fixtures__/v1-analytics/applyAnalyticsDeltaServer.ts` (T-424 slice T): v1's `src/lib/server/analytics/applyAnalyticsDeltaServer.ts` at e26d0c1; only three import lines differ (`server-only` removed, `firebase-admin/firestore` -> `./admin-shim`, `@/lib/analytics/delta-core` -> `./delta-core`). Same rules.
- `src/lib/__fixtures__/v1-analytics/applyPaymentConversionServer.ts` (T-424 slice T): v1's `src/lib/server/analytics/applyPaymentConversionServer.ts` at e26d0c1; same three import edits. Same rules.
- `src/lib/__fixtures__/v1-analytics/admin-shim.ts` (T-424 slice T): NOT v1 code; a `FieldValue` shim that returns the in-memory fake's sentinels so the vendored files run against the fake.
- The lib/analytics daily module (copied in T-422) is already byte-identical to v1 and is what the vendored delta code imports; it needs no entry.
