# apps/pos-shell

T-532 S2. The Android shell (`net.shareat.erppos`, "SharEat POS") that opens `https://erp2.shareat.net/pos`. No web build: the ERP serves the screens; the APK is rebuilt only when native code changes. The printer bridge (`window.ShareatPrinter`) lives in the ERP (`apps/erp/src/lib/pos-print/native.ts`).

- `android/app/src/main/java/net/shareat/erppos/ThermalPrinterPlugin.java` was copied from the old Firebase POS app's plugin (package renamed); that app was deleted in T-588, tag `archive/apps-pos-final`.
- Emulator/TEST build: `npm run sync:emulator -w @shareat/pos-shell`, then `./gradlew assembleEmulator` in `android/`. Points at `http://10.0.2.2:9008/pos`. A release build refuses a config with that URL.
- CI: `.github/workflows/pos-shell-build.yml` builds the APK. Nobody builds it on a droplet.
