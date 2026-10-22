# T-455 — isolated POS emulator APK and local runtime
Status: harness built and exercised 21 October; DEF-722 corrected locally in T-456 with Android order persistence
verified 22 October. Paid-sale acceptance still requires terminal/server setup and its own runtime checks.
Ian explicitly requested emulator checks for builds. Report: docs/reviews/t455-pos-emulator-runtime.md.
Use fixed demo-shareat-pos2 project and explicit emulator profile. Default builds retain existing behavior.
Never launch the current live-config APK for tests. Emulator SDKs connect before any request; no fallback to live.
Auth9099, Firestore8080 and Storage9199 are local only. Android reaches host through10.0.2.2;
desktop helper callers use127.0.0.1. API calls target local POS9009, never app.shareat.net/pos2.shareat.net.
Separate Android build type/package .emulator with local-only cleartext configuration; release transport stays strict.
No service-account keys, cloud projects, production credentials or live payment calls in this workflow.
Demo rules/seed are synthetic runtime fixtures; they do not prove production Firestore authorization parity.
Scope: apps/pos/config/emulator-profile.{mjs,d.mts}; apps/pos/src/lib/emulator-profile.test.ts;
apps/pos/src/firebase/config.ts; apps/pos/src/lib/firebase/client.ts; apps/pos/src/lib/api-base.ts;
apps/pos/next.config.mjs; apps/pos/capacitor.config.ts; apps/pos/android/app/build.gradle;
apps/pos/android/app/src/emulator/**; apps/pos/scripts/{build-emulator.mjs,seed-emulator.mjs};
apps/pos/emulator/**; apps/pos/package.json; apps/pos/README.md; this task; T-454/discovery;
docs/reviews/t455-pos-emulator-runtime.md. Supporting tests and defect log for actual findings only.
Supporting scope: apps/pos/V1-COPY.md, required by the copy-integrity guard to record the emulator changes
and previously omitted T-426/T-427/T-453 hand edits; no source-copy baseline or assertion is relaxed.
Acceptance: profile rejects external hosts; demo project is fixed; all SDKs explicitly use emulator;
non-emulator/release native configuration unchanged; separate test app; Android launch/sign-in with synthetic data;
save/reopen and offline/reconnect checks reported from actual emulator results, never inferred from builds.
Build-cap must restore all moved source byte-identically. Physical printer/device and full soak remain separate gates.

22 October T-458 checkpoint: Android saved own cash P760 as EMU-01-000001 offline, survived force-stop/reopen,
then synced exactly one receipt/payment/number mapping to demo services. All 34 build-moved files restored byte-identically.
Overall payment UI is NOT green: subsequent uncached print-settings read falsely reports Payment failed (DEF-728).
Follow-up-marker crash window reported DEF-729; physical device/printer/provider/24h soak remain outstanding.

T-459 new own order cash100 opens EMU-01-000002 correctly offline, survives restart, then one receipt/payment on
reconnect. Native Settings: unsent0, old000001 quarantined1 (DEF-730); earlier REST count did not prove old ledger acknowledgement.
