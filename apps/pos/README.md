# @shareat/pos — Shareat POS v2

A working copy of POS v1's floor screens (cashier, kitchen, server, receipts, pins, reservations, online orders),
made in T-422 (`docs/tasks/422-pos-v2-copy-v1.md`). Port **9009**. App id `net.shareat.pos2`.

It still talks to v1's Firebase project (`shareat-hub-v2`, **live production**) and, for its few online-only calls,
to v1's server at `https://app.shareat.net` (`NEXT_PUBLIC_API_BASE`). It has no server code of its own.

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

The copy points at live Firestore. Do not sign in, start a session or press any button that writes while testing.
Smoke = the login page renders on 9009, the static export has every kept route, the APK job is green or skipped.
