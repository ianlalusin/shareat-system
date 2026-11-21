# T-532: the POS tablet app (Android shell) and Bluetooth printing

**Owner:** builder (Sonnet), one slice at a time. **Spec:** BOSS (Opus), 19 Nov 2026.
**Go-live gate:** row 466. Lipa goes live only after the soak AND a printing check (`docs/runbooks/pos-lipa-switch.md` §B; result goes in `pos-go-no-go.md` row 2).
**Design:** `docs/plans/pos-v2-design.md` A8 (:126), R1 (:384), T-532 row (:322).
**No migration, no new capability, no ledger change.**

## What exists (main 618262c)

- **`apps/erp/src/lib/pos-print/`.** The formatters already produce plain `string[]` lines for 58 and 80 mm. They cover the receipt, kitchen ticket, refill slip, X and Z.
  - `adapter.ts` calls `window.ShareatPrinter.print(lines, {copies})` when it exists. Otherwise it falls back to the browser print view.
  - Nothing defines `window.ShareatPrinter`.
  - Callers: `Orders.tsx:217/222`, PaymentPanel, `_kitchen/outage-print.ts`, `_till/slips`.
- **`apps/pos/android/`** (the retired v1-copy app, `net.shareat.pos2`, rows 430/471, T-588). It contains a working in-tree Capacitor 6 plugin, `ThermalPrinterPlugin.java`, with:
  - `listBluetoothPrinters`, `connectBluetoothPrinter({address})`, `disconnectBluetoothPrinter`;
  - `printReceipt({text, widthMm, cut, beep, encoding, font})`;
  - SPP with retries.
  - It is the same plugin v1 uses at Lipa today, so it is proven on that printer.
- **CI:** `.github/workflows/app-build.yml`, a signed release APK built from `apps/pos`. Secret names: ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD (set 22 Oct). `scripts/apk-signing-gate.mjs`.
- **v1's flow** (`POS/src/lib/printing/printHub.ts`): per print job it connects, prints and then always disconnects, so GrabFood's app can use the printer too. The printer must first be paired in Android Bluetooth settings; the app lists bonded devices only.

## BOSS rulings (defaults; Ian can overrule)

1. **A new folder, `apps/pos-shell`, with a new app id `net.shareat.erppos`, name "SharEat POS".**
   - It never installs over v1 (`net.shareat.pos`, the roll-back app) or the retiring `net.shareat.pos2`.
   - `apps/pos` is not edited (row 471). The Java plugin is **copied**, not shared.
2. **Remote-URL shell.** `server.url = https://erp2.shareat.net/pos`, with `allowNavigation` limited to `erp2.shareat.net`.
   - The ERP deploys as usual; the APK is rebuilt only when native code changes.
3. **The bridge lives in the ERP, not the shell.** A new `apps/erp/src/lib/pos-print/native.ts` defines `window.ShareatPrinter` when `window.Capacitor?.Plugins?.ThermalPrinter` exists.
   - No `@capacitor/*` package is added to apps/erp.
   - `adapter.ts` keeps its contract (failure is a result, never a throw).
4. **Per job:** connect to the saved address → `printReceipt` for each copy (JS loop, `cut` after each copy, beep on the first only) → disconnect in `finally`.
   - Width and font come from the till settings already passed to callers (T-546).
   - `₱` is not in CP437. The bridge replaces it with `P` before sending; the browser path keeps `₱`.
   - This is unit-tested.
5. **Who picks the printer:** any signed-in POS user, on a new `/pos/printer` screen. It's a device setting, not money.
   - The address is saved in the device store `meta` (`apps/erp/src/lib/pos-device/meta`).
   - The screen shows only when the plugin is present. In a browser it says "Printing from this browser uses the print dialog."
6. **Offline cold start** (opening the app with no internet) is S4. It is required before go-live, not before the printing check.
   - R1's bundled fallback is **out** unless S4 fails on a real tablet.

## Slices

**S1: bridge and printer screen (ERP only; testable in a browser with a fake plugin)**
- `native.ts`: install the bridge on `/pos` load, from `_shell/PosShell.tsx`, once.
- `/pos/printer` page:
  - list bonded printers, choose one, save it;
  - "Print test slip" (store name, time, 3 columns at the chosen width);
  - show the last error in plain words. "Printer not connected." becomes "Can't reach the printer. Is it on and paired in Android Bluetooth settings?"
- PosShell's header Printer item (`printerMode()`, PosShell.tsx:71) links to `/pos/printer`.
- Route/capability: same gate as the other `/pos` pages (check `ROUTE_CAPABILITY`; do not add a capability).
- **Tests** (unit, a fake `window.Capacitor.Plugins.ThermalPrinter`):
  - 2 copies give 2 `printReceipt` calls and 1 disconnect, also when the 2nd throws (result 'failed', disconnect still called);
  - no saved address gives 'failed' with no connect call;
  - `₱` becomes `P` in the native path only;
  - `printerMode()` is 'plugin' once installed.
  - **Mutant:** move the disconnect out of `finally` and the throw case goes red.

**S2: the shell app**
- `apps/pos-shell/`: `package.json` (Capacitor 6 core, android and cli at the versions `apps/pos` uses), `capacitor.config.ts` as in rulings 1 and 2, `android/` generated with `cap add android`.
- Then copy in `ThermalPrinterPlugin.java` (package renamed) and register it in `MainActivity`. Leave out BirthdaySongPlugin.
- Manifest permissions as `apps/pos` (BLUETOOTH*, INTERNET), minus CAMERA unless needed.
- `build.gradle`: the versionCode/Name overrides, the release signing config and the release guard as `apps/pos`.
- Add a debug/emulator flavour whose server URL is `http://10.0.2.2:9008/pos`, with cleartext for 10.0.2.2 only.
- `webDir` holds a single `index.html` ("Connecting to SharEat POS…"), used only if the URL fails.
- **Check:** `npx cap sync android` and `gradlew assembleDebug` succeed locally. **One Gradle build at a time; check memory before it (90% cap).**

**S3: CI**
- Add a job (or parameterise `app-build.yml`) that builds `apps/pos-shell` release with the same secrets and signing gate.
- It runs on changes under `apps/pos-shell/**` and on manual dispatch.
- Artifact `pos-shell-<run>.apk`.
- The existing `app-pos` job is untouched.

**S4: offline cold start (service worker)**
- `apps/erp/public/sw.js`, scoped to `/pos`. Pre-cache the `/pos` app shell and its static chunks, network-first for HTML, cache-first for `/_next/static`.
- Never cache `/api/*`. The outbox and snapshot (IndexedDB, T-530a) already cover the data.
- Register from PosShell. Ship a manifest only if needed.
- Port the approach of `apps/pos/public/sw.js` (79 lines) and `docs/tasks/314-fingerprint-capture-import.md:216-346`; do not import from it.
- **Test:** Playwright or a manual run on the emulator. Load `/pos` online, kill the app, switch airplane mode on, reopen: the Orders screen appears from cache and a sale queues in the outbox. Record it in the PR.
- If the WebView refuses to serve the remote origin from the service worker, stop and report. Do not build R1.

**S5: real-tablet printing check (owner and BOSS, not the builder)**
- Install the release APK beside v1 at Lipa. Pair the printer in Android settings, choose it on `/pos/printer`, then run `pos-lipa-switch.md` §B: receipt, reprint, X, Z, outage kitchen ticket.
- Photos go into `pos-go-no-go.md`.

## Done when

S1 to S3 are merged with green CI and a signed `pos-shell` APK artifact exists. The emulator run is recorded in the PR (the app opens erp2/pos in debug flavour against local 9008, and the test slip goes to the fake plugin). S4 is merged before go-live. S5 passes at Lipa.

## Out (with reasons)

- Logo or QR printing: v1 can do it, but nobody asked, and the receipt is text.
- Print darkness settings: the printer is already tuned by v1.
- USB printers: Lipa uses Bluetooth.
- Auto-update of the APK: the URL shell takes ERP updates without one.
- Retiring `apps/pos`: that's T-588.
- R1 bundled fallback: only if S4 fails.
