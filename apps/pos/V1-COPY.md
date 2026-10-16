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
