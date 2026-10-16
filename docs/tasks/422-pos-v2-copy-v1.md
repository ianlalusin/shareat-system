# T-422: POS v2 — copy POS v1's floor screens into `apps/pos` (P0, PC-3)

**Status:** DONE 2026-10-16 (POS v2 lane; merged to main)
**Model:** Sonnet tester first (slice T), then Sonnet builder (B1-B5), Sonnet auditor last (bible rows 184, 307).
**Migration:** none. No `packages/**` change. No server code.
**Authority:** `docs/plans/pos-customer-v2-phase-plan.md` §6 PC-3 · ADR-015 + Amendment 2026-10-15 (A1, A4.1, A4.2) ·
bible rows 269, 272, 307, 338, 348 (live v1 = build #238, commit `e26d0c1`) · T-417 (the shell this fills).
**Depends on:** T-417 (merged into this branch's base `f18494f`).
**Inputs:** `docs/discovery/39-pos-v1-study.md`; page/route inventory of v1 at `e26d0c1` (lane notes, summarised below).

## Goal, in plain words
Put a working copy of today's POS (the screens cashiers, kitchen and servers use) inside this repo as `apps/pos`,
so every later P0 fix (money, receipts, void, offline, SC/PWD) is made to code we own. The copy still talks to
v1's Firebase project `shareat-hub-v2` and to v1's server `https://app.shareat.net` for its few online-only calls.
It builds a web page and an Android APK in CI. **It does not go to any store** in this task.

## Facts verified at POS `e26d0c1` (read-only git)
- `C:\Users\ianla\webapps\POS` HEAD is `e26d0c1` but its working tree is dirty (birthday-song files, receipts page).
  **Copy from the commit, never the working tree.**
- 49 pages, 62 API routes, 86 test files (all `*.test.ts`, node env), ~107k LOC under `src/`.
- The APK is a static export (`BUILD_TARGET=capacitor`, `scripts/build-capacitor.mjs` stashes `src/app/api` and
  `src/middleware.ts`). Every server call is a plain `fetch("/api/...")`; `src/lib/api-base.ts:26`
  `installApiBaseFetch()` (called from `app/providers.tsx:19`) prefixes them with `NEXT_PUBLIC_API_BASE`
  (default `https://app.shareat.net`). v1's server CORS allows origin `https://localhost` (`src/middleware.ts:19-23`),
  which a Capacitor APK has whatever its app id.
- Firebase client config is hard-coded in `src/firebase/config.ts` (project `shareat-hub-v2`); Firestore persistent
  multi-tab cache.
- Native: `android/app/src/main/java/net/shareat/pos/ThermalPrinterPlugin.java` (1,100 lines, Bluetooth ESC/POS),
  `MainActivity.java` registers it, `res/xml/file_paths.xml`, custom `AndroidManifest.xml` (Bluetooth, camera,
  location ≤ SDK 30, storage ≤ SDK 28/32, FileProvider). npm plugins: `@capacitor/app`, `haptics`,
  `local-notifications` (^6).
- Role gating is `RoleGuard allow={[...]}` per page; nav is `src/components/layout/main-nav.tsx:14-23`.
- The live `/receipts` void (`src/app/receipts/page.tsx:497-538`) is the UNSAFE plain `updateDoc` (DEF-651).
  `src/components/receipts/page.tsx` is an unimported fork (the only importer of `VoidReceiptModal`,
  `ReRingLinkModal`). `EditReceiptDialog` is used by `/receipts` (:25, :847). `PaymentConvertModal` is used only by
  `components/dashboard/DashboardPageClient.tsx:10`.
- No "sold out" control exists on any floor screen; the only one is `manager/inventory` (`isActive`, A/M only).
- v1 `tsconfig.json`: `strict` on, **no** `noUncheckedIndexedAccess`, `allowJs` on. Root (inherited) has
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `allowJs: false`.
- Dependency clash: ERP uses `firebase ^11`, v1 uses `firebase ^10`; root vitest is ^4, v1's ^2.

## Rulings (planner)
1. **Kept routes (floor) — exactly these:** `/` · `/login` · `/signup` · `/forgot-password` · `/pending` ·
   `/support` · `/change-password` · `/account` · `/settings` (device: printers) · `/cashier` · `/cashier/handover` ·
   `/cashier/receipts` (redirect) · `/cashier/sessions` (redirect) · `/kitchen` · `/kitchen/history` · `/server` ·
   `/refill` (redirect) · `/receipts` · `/receipt` · `/pins` · `/print/session-pin` · `/reservations` ·
   `/reservations/details` · **`/online-orders`** (v1's `/admin/online-orders`, moved: the online-order queue is a
   floor operation, row 307; nav link and the kitchen/nav badge links follow).
2. **Dropped routes:** everything under `/admin/**` (except the queue moved above) and `/manager/**` (row 307:
   master data in the ERP; repair tools — backfill, reconcile, data-management — not carried) · `/dashboard`,
   `/sales-report`, `/weather-calendar`, `/admin/data-analysis`, `/admin/daily-session-timeline` (row 307: reports
   live in the ERP) · `/admin/tools/printer-test` (admin tool; `/settings` keeps device printer set-up and tests).
   **Nothing is lost in P0:** v2 shares v1's Firestore, so managers keep every dropped screen on v1's web app
   (app.shareat.net) until the ERP takes it over.
3. **No server code.** `src/app/api/**` and `src/middleware.ts` are not copied; the APK and web build call
   v1's server through `NEXT_PUBLIC_API_BASE` (default `https://app.shareat.net`), same contract as the pinned commit.
   Crons, `/api/external/*` (the ERP feed) and webhooks stay on v1. The POS server service (T-417 B5) stays unused.
4. **The copy is the import closure.** Start from the kept routes' `page.tsx`/`layout.tsx`, `src/app/layout.tsx`,
   `providers.tsx`, `globals.css`, `not-found`/`error`/`icon` files if present; follow every static and dynamic
   `import`/`import()` that resolves into `src/`. Copy that closure plus `*.test.ts` files whose subject file is in
   the closure (and anything those tests import). Nothing else from `src/`. Repo litter (`out/`, `ds-bundle/`,
   `git status`, `shareatv5`, `*.bak`, `firestore-debug.log`) is never copied. `firestore.rules`, indexes, storage
   rules, `.firebaserc`, `apphosting.yaml`, v1's `scripts/*` and `.github/` are v1's and are not copied.
5. **The copy is reproducible.** `apps/pos/scripts/copy-from-v1.mjs` (committed; Node built-ins only) takes
   `--repo <path> --commit <sha>`, reads ONLY via `git -C <repo> show|ls-tree <sha>:...` (never checkout, never the
   working tree), computes the closure (rule 4), writes under `apps/pos/`, and writes `apps/pos/V1-COPY.md`: the
   commit, the date, the file count, and every file the builder then edited by hand (rule 6) with one line why.
   Reason: plan risk R2 — later v1 fixes (e.g. the DEF-651 safe-void fix now going into v1) are re-ported by
   re-running it and diffing.
6. **Hand edits after the copy, and only these:**
   - a. **Unsafe paid-receipt void removed** (ADR-015 A4.1): `handleVoidReceipt`, `handleVoidClick` and the void
     `ReasonModal` wiring in `receipts/page.tsx` are deleted; the Void button is replaced by a disabled button
     labelled "Void — coming in the safe flow" with a `title` naming T-423. Voiding an UNPAID session
     (`void-session-dialog`, `offlineVoid`) is a different operation and stays.
   - b. **In-place paid-receipt edit removed** (A4.2): `EditReceiptDialog` and its button/state in
     `receipts/page.tsx`. (`PaymentConvertModal` falls away with `/dashboard`.)
   - c. **Receipt-template dialog removed from `/receipts`** (`components/manager/store-settings/receipt-settings`;
     store settings are ERP master data, row 307). Printing still reads the stored template.
   - d. `/admin/online-orders` → `/online-orders` (move file; update `main-nav.tsx` and any `href`/`router.push`
     to the old path). Nav entries for dropped routes (Dashboard, Admin) removed; the post-login home for
     admin/manager, if it was `/dashboard` or `/admin`, becomes `/cashier`.
   - e. App identity: page `<title>`/manifest name "Shareat POS v2"; `public/manifest.webmanifest` `start_url`
     unchanged. Firebase config, collection names, API paths: **unchanged**.
   - f. Type-only fixes the monorepo forces (rule 8), each listed in `V1-COPY.md`.
   Every other byte matches v1. Refund (`RefundReceiptDialog`, DEF-001/588) is copied unchanged: PC-4 fixes it.
7. **Dependencies:** `apps/pos/package.json` lists exactly the npm packages the copied closure imports, at v1's
   ranges, except `next`/`react`/`react-dom` (keep T-417's monorepo ranges) and `@capacitor/*` (^6, T-417's
   `^6.2.1` for core/cli/android; v1's ranges for app/haptics/local-notifications). Never added: `firebase-admin`,
   `genkit`, `@genkit-ai/*`, `@anthropic-ai/sdk`, `firebase-tools`, `genkit-cli`, `eslint-config-next`.
   **No package already in `package-lock.json` changes version** for the ERP or any package; clashing ranges
   (firebase 10 vs 11) nest under `apps/pos/node_modules`. Dev tooling (tailwind 3, postcss, autoprefixer,
   tailwindcss-animate) uses the root's versions where the root has them.
8. **TypeScript:** `apps/pos/tsconfig.json` keeps extending the root and overrides ONLY
   `noUncheckedIndexedAccess: false` and `noImplicitOverride: false` (v1 was written without them; turning them on
   is ~hundreds of edits to code PC-4/5/6 will rewrite). A comment says so and names the follow-up. `strict` stays
   on; `ignoreBuildErrors` stays `false`. If v1 code needs `allowJs`, say so in the report instead of enabling it.
9. **Tests:** copied v1 tests run under the monorepo's vitest 4 via `apps/pos/vitest.config.mts` (alias `@` ->
   `apps/pos/src`, `server-only` mock if a copied test needs it, node env, include `src/**/*.test.ts`). The root
   `unit` project gets ONE exclude entry, `apps/pos/**`, so the ERP alias never resolves POS files. Root `npm test`
   is otherwise unchanged; `app-build.yml` gains a POS unit step (B5). A copied test that cannot pass for a reason
   outside the copy (it tested server code we did not copy) is not copied, and is listed in `V1-COPY.md`.
10. **Native:** `ThermalPrinterPlugin.java` copied into `apps/pos/android/app/src/main/java/net/shareat/pos2/`
    with only its `package` line changed; `MainActivity.java` registers it as v1's does; v1's manifest permissions,
    FileProvider and `res/xml/file_paths.xml` merged into T-417's Android project; the three Capacitor plugins
    synced (`npx cap sync android` regenerates `capacitor.settings.gradle`/`capacitor.build.gradle`). App id stays
    `net.shareat.pos2`; T-417's release signing config is untouched.
11. **Smoke never writes production.** The copy points at live `shareat-hub-v2`. No agent signs in, starts a
    session, or presses any button that writes. Smoke = the login page renders on 9009 with no console errors, the
    static export contains every kept route, and the APK job is green or cleanly skipped. A test Firebase project
    for the soak is a later decision (Open question 1).

## Slices (tester and builder paths are disjoint)

**T — tester, first; all red for the right reason before B1.** New files only:
`tests/unit/pos-v2-copy.test.ts` (guards below, reading the tree, never importing app code) and
`tests/unit/pos-v2-copy-script.test.ts` (spawns `node apps/pos/scripts/copy-from-v1.mjs --dry-run` against a tiny
fixture git repo built in a temp dir by the test itself: closure follows static + dynamic imports, skips an
unreferenced file, never reads the working tree — a dirty fixture file must not appear in the output).

**B1 — copy script + the copy.** `apps/pos/scripts/copy-from-v1.mjs`, `apps/pos/V1-COPY.md`, `apps/pos/src/**`,
`apps/pos/public/**` (only files the closure references: logo, icons, manifest, `sw.js`, `sounds/kitchen-alert.mp3`),
`apps/pos/tailwind.config.ts`, `apps/pos/postcss.config.mjs`, `apps/pos/components.json`. Run against
`C:\Users\ianla\webapps\POS` at `e26d0c1`. Never run git that writes in POS.

**B2 — package, configs, tests.** `apps/pos/package.json` (rule 7), `package-lock.json` (via `npm install` at
root), `apps/pos/tsconfig.json` (rule 8), `apps/pos/next.config.mjs` (keep T-417's two modes; add v1's
`images.remotePatterns` for firebasestorage in server mode and `/sw.js` headers in server mode),
`apps/pos/scripts/build-cap.mjs` (set `NEXT_PUBLIC_API_BASE` default `https://app.shareat.net`, keep
`NEXT_DISABLE_TURBOPACK=1` only if the build needs it), `apps/pos/vitest.config.mts`, root `vitest.config.mts`
(one exclude entry, rule 9), `apps/pos/package.json` script `test` = `vitest run --config vitest.config.mts`.
Read `node_modules/next/dist/docs/` on `output: 'export'` before touching `next.config.mjs`.

**B3 — the hand edits of rule 6** in the copied files, each logged in `V1-COPY.md`.

**B4 — native.** `apps/pos/android/**` per rule 10. No keystore, no signing change.

**B5 — CI.** `.github/workflows/app-build.yml`: one step "Unit tests" (`npm test -w @shareat/${{ inputs.app }}
--if-present`) after Typecheck; `NEXT_PUBLIC_API_BASE: https://app.shareat.net` env on both build steps. Nothing else
in CI changes. `apps/pos/README.md`: what this is, how to re-run the copy, the "no writes in smoke" rule.

## Acceptance (each case names the mutant it kills)
1. Route set: the app's routes equal rule 1's list exactly (test walks `apps/pos/src/app/**/page.tsx`). Kills: an
   admin/manager/report page copied; a floor page forgotten.
2. No `apps/pos/src/app/api`, no `apps/pos/src/middleware.ts`; no file under `apps/pos/src` imports `firebase-admin`,
   `genkit`, `@anthropic-ai/sdk`, `server-only`, or `@/lib/server/`. Kills: server code shipped in the APK.
3. Closure guard: every non-test `.ts/.tsx` under `apps/pos/src` is reachable from the kept routes (the test's own
   small import walker). Kills: "copied all of `src/`" (dead admin code).
4. Unsafe void gone: no file in `apps/pos/src` contains `handleVoidReceipt`, imports `EditReceiptDialog`,
   `PaymentConvertModal`, `VoidReceiptModal`, `ReRingLinkModal`, or the `components/receipts/page` fork; and no
   `updateDoc(` call in `apps/pos/src/app/receipts/**` sets `status` to `"voided"`. Kills: the DEF-651 path ported.
5. Unpaid-session void still present: `void-session-dialog` is reachable from `/cashier`. Kills: over-deletion.
6. Nav: `main-nav.tsx` links only to kept routes; `/online-orders` present; no `/admin`, `/dashboard`, `/manager`
   href anywhere in `apps/pos/src`. Kills: dead links to dropped pages.
7. Copy script (fixture repo): follows static + dynamic imports, omits an unreferenced file, ignores a dirty
   working-tree change, refuses to run without `--commit`. Kills: copying the dirty tree (the birthday-song WIP).
8. `V1-COPY.md` names commit `e26d0c1` and lists every hand-edited file; the test diffs the list against files whose
   content differs from `git show e26d0c1:` (skipped with a notice when `C:\Users\ianla\webapps\POS` is absent, i.e. CI).
   Kills: an unlogged hand edit.
9. Deps: `apps/pos/package.json` has none of rule 7's forbidden packages; `npm ls react react-dom next` one version
   each; `git diff f18494f -- package-lock.json` changes no version of a package that existed before. Kills: firebase
   11 forced onto v1 code, or the ERP's firebase dropped to 10.
10. Native: `ThermalPrinterPlugin.java` exists under `net/shareat/pos2/` with `package net.shareat.pos2;`;
    `MainActivity` registers it; manifest has `BLUETOOTH_CONNECT` and the FileProvider; `capacitor.config.ts` appId
    = `build.gradle` applicationId = `net.shareat.pos2` (T-417 case 7 still green). Kills: printer plugin missing (no
    receipts print) or v1's package name kept.
11. `npx tsc -p apps/pos/tsconfig.json --noEmit` passes; root `npm run typecheck` passes and lists 0 `apps/pos` files.
12. `npm test -w @shareat/pos` passes (copied v1 tests); root `npx vitest run --project unit` passes and runs 0 files
    under `apps/pos`. Kills: POS tests resolving `@` to the ERP.
13. `npm run build -w @shareat/pos` and `npm run build:cap -w @shareat/pos` pass (dev server stopped);
    `apps/pos/out/` has an `index.html` for every kept route; `grep -r "app.shareat.net" apps/pos/out` finds the
    API base. Root `npm run build` (ERP) passes.
14. T-417's tests (app-workspaces, app-boundaries, ci-app-jobs, apk-signing-gate, pos-service-unit) still pass;
    `deploy.yml` and the `verify` job are byte-identical to `f18494f`.
15. Smoke (rule 11): `npm run dev:pos` serves the login page on 9009, no console errors other than the expected
    CORS refusal of `/api` calls from `http://localhost:9009` (v1's server allows only `https://localhost`);
    screenshot attached. No sign-in, no write.
16. CI on the orchestrator's PR: `app-pos` green (APK skipped notice until Ian adds the keystore secrets).

## Must NOT change
`apps/erp/**` · `packages/**` · `deploy.yml` · the ERP `verify` job · root `tsconfig.json` · root scripts ·
`docs/ops/**` · anything in `C:\Users\ianla\webapps\POS` (read-only; read via `git show` only) · the bible / ADRs
(planner only) · any droplet · live Firestore (no writes, ever).

## Out of scope (later tasks, numbers reserved 423-429)
T-423 money and receipts (PC-4: centavos, `(store, terminal, seq)` numbering, transactional void, refund numbers
and method, wrong-tender correction) · offline (PC-5) · SC/PWD (PC-6) · redesigned payment/table screens (PC-7
mock-ups first) · a sold-out toggle on the POS (row 307; v1 has none on the floor — new capability, its own spec) ·
tightening `noUncheckedIndexedAccess` · moving server calls off app.shareat.net · a test Firebase project.

## Open questions (for Ian, plain words)
1. **Testing without touching real sales.** The copy uses the live database. Before the December soak test we need
   a separate test copy of Firebase (or the soak runs on the real one with test stores). Recommended: a separate
   test Firebase project; it costs little and nothing real can break. Not needed for this task.
2. **The daily sales printout.** v1's sales report page (with its printed report) is a report, so it moves to the
   ERP (row 307). If cashiers print it at closing, the X/Z slip in PC-8 replaces it. Recommended: confirm with Lipa
   staff; no change to this task.
