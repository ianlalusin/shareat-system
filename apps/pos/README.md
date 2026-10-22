# @shareat/pos — Shareat POS v2

A working copy of POS v1's floor screens (cashier, kitchen, server, receipts, pins, reservations, online orders),
made in T-422 (`docs/tasks/422-pos-v2-copy-v1.md`). Port **9009**. App id `net.shareat.pos2`.

It still talks to v1's Firebase project (`shareat-hub-v2`, **live production**) and, for its few online-only calls,
to v1's server at `https://app.shareat.net` (`NEXT_PUBLIC_API_BASE`). T-424 added its own `/api/pos2/*`
server routes for protected money actions; see `docs/ops/pos2-runbook.md`. These are not yet the complete
shared-PostgreSQL migration.

## Current direction — 21 October

P1 starts now: APK device storage and a durable outbox, authenticated APIs and the same PostgreSQL backend
as ERP. Keep existing IndexedDB pending persistence evidence; SQLite is not adopted. See T-462 and the POS
phase plan for enrollment, shared sign-in, reference snapshots and subsequent receipt/table ownership moves.

## Isolated emulator checks — T-463

Use only synthetic data in local project **demo-shareat-pos2**:

1. From `apps/pos/emulator`, run `firebase emulators:start --only auth,firestore,storage --project demo-shareat-pos2 --config firebase.json`.
2. From the repo root, run `node apps/pos/scripts/seed-emulator.mjs --confirm` after the services are ready.
3. With Android SDK/JDK available and the POS dev server stopped, run `npm run build:emulator -w @shareat/pos`.
4. Install `apps/pos/android/app/build/outputs/apk/emulator/app-emulator.apk` on the Android emulator.

The separate app id is `net.shareat.pos2.emulator` (SharEat POS TEST). Android reaches host services through
`10.0.2.2`; the profile permits only local hosts and directs API calls to local port 9009. Online-only server
actions require a separately configured local POS server. Do not infer approval/payment coverage from login.
No separate cloud Firebase project is needed for these checks. Emulator results must be recorded; real tablet,
printer, payment, visual and offline-soak gates still apply before release.

- `npm run dev:pos` (repo root): dev server on 9009.
- `npm test -w @shareat/pos`: the copied v1 unit tests (own vitest config; the root `unit` project skips this folder).
- `npm run build -w @shareat/pos`: server build. `npm run build:cap -w @shareat/pos`: static export to `out/` for the APK.
  Stop the dev server before building.
- Android: `npx cap sync android` (from this folder, after `build:cap`) registers the Capacitor plugins. The Bluetooth
  printer plugin is `android/app/src/main/java/net/shareat/pos2/ThermalPrinterPlugin.java`.

## Re-running the copy

`node apps/pos/scripts/copy-from-v1.mjs --repo <path to POS v1> --commit <sha>` (add `--dry-run` to list files).
It reads git objects only, never v1's working tree. `V1-COPY.md` records the commit and every hand edit; after a
re-run, re-apply those edits and diff.

## Smoke rule: never write production

The normal copy points at live Firestore. Do not sign in, start a session or press any button that writes there.
Runtime writes are allowed only in the explicit local demo profile above. Never substitute a TEST store in the live
project. A successful build alone is not a completed runtime smoke check.
