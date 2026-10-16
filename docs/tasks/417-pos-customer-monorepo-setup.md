# T-417: POS v2 and Customer v2 as empty-shell apps in this repo (phase S, PC-2)

**Status:** spec written 2026-10-16, not started
**Model:** Sonnet tester first (slice T), then Sonnet builder (B1-B5), bible row 184. No money path.
**Migration:** none. No schema, no `packages/**` source change.
**Authority:** `docs/plans/pos-customer-v2-phase-plan.md` §4, §6 (PC-2) · ADR-015 Amendment 2026-10-15 §A1 ·
bible rows 338 (apps here, own tsconfig, one Capacitor APK each, ports 9009/9010) and 339 (no Turborepo; path filters).
**Depends on:** PC-1 (ADR amendment, done). Ian adds the keystore secrets (below); nothing here waits on them.

## Goal, in plain words
Make `apps/pos` and `apps/customer` real, empty apps inside this repo, so PC-3 can copy POS v1 into a home that
already typechecks, builds a web page, builds an Android app (APK) in CI, and cannot leak into the ERP. The ERP's
CI must stay exactly as green and no slower. Nothing here sells anything; it is plumbing.

## Facts verified at `9c1704b`
- `apps/pos`, `apps/customer` hold only `README.md` (and say ports 9003/9004, which are v1's). Root `package.json`
  workspaces: `packages/*`, `apps/erp`. Root `tsconfig.json` includes `apps/**/*.ts(x)`; its `paths` map `@/*` to
  `apps/erp/src/*`. Root `typecheck` already needs a 4 GB heap (DEF-631).
- `.github/workflows/ci.yml`: job `changes` (output `docs_only`) -> job `verify` (typecheck, unit, integration,
  build), both on `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`. `deploy.yml` builds and ships ERP only.
- `tests/unit/app-boundaries.test.ts` already forbids app->app imports (by `@shareat/<app>` name and by relative
  path) for every folder under `apps/`; its scanner skips only `node_modules`, `.next`, `dist`.
- `vitest.config.mts` maps `@` to `apps/erp/src` at ROOT for every project (comment at the alias says a per-app
  split is needed the day pos/customer get `@/` tests). Not changed here; see Out of scope.
- `tests/unit/scheduler-job-hosting.test.ts` explains every `docs/ops/*.service`; `NAMED_NON_JOB_SERVICE = ['erp']`.
  `docs/ops/provision.sh` copies every `shareat-*.service` but enables only `shareat-erp.service`.
- **v1's real app id is `net.shareat.pos`** (`POS/capacitor.config.ts`, `POS/android/app/build.gradle:7`), not
  `culinaryflow` as ADR-015 A1.3 and plan §4 say. v2 must differ from BOTH. v1's APK workflow:
  `POS/.github/workflows/build-apk.yml` (Java 17, `BUILD_TARGET=capacitor` static export to `out/`, `cap sync`,
  `assembleRelease -PversionCode=<run>`, keystore from `ANDROID_KEYSTORE_BASE64` + 3 more secrets).

## Rulings (planner)
1. **App ids (Ian, 16 Oct):** POS v2 `net.shareat.pos2`, Customer v2 `net.shareat.order` (from his web addresses pos2.shareat.net and order.shareat.net).
2. **Versions:** both shells use exactly `apps/erp`'s ranges for `next`, `react`, `react-dom` (one hoisted copy).
   Capacitor `^6` (same major as v1, Java 17) so PC-3 copies cleanly. `@capacitor/core` in `dependencies`;
   `@capacitor/cli`, `@capacitor/android` in `devDependencies`.
3. **Two build modes per app, like v1:** default = server build (`next build`, served by `next start`);
   `BUILD_TARGET=capacitor` = static export to `out/` for the APK. The shell has **one page and no API routes**
   (an export build refuses dynamic route handlers; PC-3 owns that split).
4. **App CI jobs run on `ubuntu-latest`, never `vars.CI_RUNNER`.** The self-hosted runner is one machine (6 GB);
   an APK job queued there would delay or starve ERP `verify`. Hosted runners also ship the Android SDK.
5. **Missing keystore = skip, not fail.** No release secrets: the web build and typecheck still run, the APK step
   prints a plain notice and the job is green. Some but not all four secrets set: fail (a half-set key is a mistake).
6. **The ERP `verify` job is not edited**, not even reordered. Root `npm run build` stays ERP-only (deploy uses it).

## Slices (tester paths and builder paths are disjoint)

**T - tester, first. All red for the right reason before B1 starts.** Paths: `tests/unit/app-workspaces.test.ts`
(new) · `tests/unit/app-boundaries.test.ts` (extend) · `tests/unit/fixtures/app-boundaries/**` (new) ·
`tests/unit/ci-affected-apps.test.ts` (new) · `tests/unit/ci-app-jobs.test.ts` (new) ·
`tests/unit/apk-signing-gate.test.ts` (new) · `tests/unit/pos-service-unit.test.ts` (new) ·
`tests/unit/scheduler-job-hosting.test.ts` (add `'pos'` to `NAMED_NON_JOB_SERVICE`, with a comment like `erp`'s).
Scripts are tested by spawning `node <script>` (no TS import of `.mjs`; root `allowJs` is false).

**B1 - empty-shell apps that build.** `apps/pos/{package.json, next.config.mjs, next-env.d.ts, capacitor.config.ts,
.gitignore, README.md, src/app/layout.tsx, src/app/page.tsx}` and the same set under `apps/customer/`. Root
`package.json` (`workspaces` + `dev:pos`, `dev:customer` scripts only), `package-lock.json` (via `npm install`).
Names `@shareat/pos`, `@shareat/customer`. Scripts: `dev` = `next dev -p 9009` / `-p 9010`; `start` = `next start
-p 9009 -H 127.0.0.1` / `9010`; `build` = `next build`; `build:cap` = `BUILD_TARGET=capacitor next build` (use
`cross-env` only if already in the lockfile; else a 5-line `scripts/build-cap.mjs` inside the app). Page text:
"Shareat POS v2" / "Shareat Customer v2". `.gitignore`: `out/`, `.next/`, `android/app/build/`,
`android/app/src/main/assets/public/`, `android/.gradle/`, `*.jks`. READMEs: correct ports, point to this spec.
Read `node_modules/next/dist/docs/` for `output: 'export'` before writing `next.config.mjs` (Next 16 differs).

**B2 - per-app tsconfig + root exclude.** `apps/pos/tsconfig.json`, `apps/customer/tsconfig.json`: extend
`../../tsconfig.json`, define their OWN full `paths` (`@/*` -> `./src/*`, plus only the `@shareat/*` packages they
use, none today), `include` their own files only. Root `tsconfig.json`: add `apps/pos` and `apps/customer` to
`exclude` - nothing else in that file changes.

**B3 - path-filtered CI.** `scripts/ci-affected-apps.mjs` (new; Node built-ins only, because `changes` runs without
`npm ci`): reads changed paths on stdin, or the literal `UNKNOWN`, prints `pos=true|false` and `customer=true|false`.
App X is affected by `apps/X/**`, `packages/**`, root `package.json`, `package-lock.json`, `tsconfig.json`,
`.github/workflows/ci.yml`, `.github/workflows/app-build.yml`, `scripts/ci-affected-apps.mjs`,
`scripts/apk-signing-gate.mjs`. `UNKNOWN` -> both true (fails open, like `docs_only`). `.github/workflows/ci.yml`:
in `changes`, add outputs `pos`, `customer` and ONE new step AFTER `Determine docs-only` that repeats its
BEFORE/AFTER logic and pipes into the script; the existing step's text is untouched. New jobs `app-pos`,
`app-customer`: `needs: changes`, `if: needs.changes.outputs.<app> == 'true'`, `uses: ./.github/workflows/app-build.yml`
with `app: pos|customer`, `secrets: inherit`.

**B4 - APK job.** `.github/workflows/app-build.yml` (new, `on: workflow_call`, input `app`), `runs-on: ubuntu-latest`:
checkout, setup-node 22 (npm cache), `npm ci`, `npx tsc -p apps/<app>/tsconfig.json --noEmit`,
`npm run build -w @shareat/<app>`, `npm run build:cap -w @shareat/<app>`, then `node scripts/apk-signing-gate.mjs`
(new; reads the 4 env vars `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEY_PASSWORD`; none set -> writes `signing=skip` to `$GITHUB_OUTPUT`, prints
`::notice::Release APK skipped: the ANDROID_KEYSTORE secrets are not set yet. Ian adds them in GitHub Settings >
Secrets. Web build and typecheck above still ran.`, exits 0; all four -> `signing=release`; 1-3 set -> `::error::`
naming the missing ones, exit 1; never echoes a value). Only when `signing == 'release'`: setup-java 17, decode the
keystore to `apps/<app>/android/app/release.jks`, `npx cap sync android`, `./gradlew assembleRelease
-PversionCode=${{ github.run_number }} -PversionName=0.1.${{ github.run_number }}`, upload
`<app>-v2-<run>.apk` as an artifact. Android projects: `apps/pos/android/**`, `apps/customer/android/**`, made
once by `npx cap add android` (no SDK needed) and committed; `android/app/build.gradle` gets the app id from
Ruling 1 and a `release` signing config reading `RELEASE_STORE_PASSWORD`, `RELEASE_KEY_ALIAS`,
`RELEASE_KEY_PASSWORD` from the environment (v1's pattern). The lane never handles a real key.

**B5 - POS server service unit.** `docs/ops/shareat-pos.service` (new) + a short section in `docs/ops/README.md`.
What it is (plan §4 "Deploy"): from P0, POS v2's server-side routes (PayMongo webhook, PIN checks, crons) run as a
**second long-running web process on our droplet 159.223.46.224**, beside `shareat-erp.service`. Copy that unit's
shape: `Type=simple`, `WorkingDirectory=/srv/shareat/apps/pos`, `ExecStart=/usr/bin/npm run start` (so
`127.0.0.1:9009`), `User=shareat`, `Group=shareat`, `Restart=always`, `RestartSec=5`, `Environment=NODE_ENV=production`,
`MemoryMax=768M` (risk R6: the POS process must never starve the ERP on a 4 GB box), logs to
`/var/log/shareat/pos.log`, header saying NEVER build here. **This lane writes the file only.** Shipping a POS
build in `deploy.yml`, installing and enabling the unit, the Caddy route and the memory check are a later task
plus Ian's/ops steps on the droplet. The lane never connects to any droplet.

## Acceptance (each case names the mutant it kills)
1. `npm run typecheck` passes; `npx tsc --listFilesOnly -p tsconfig.json | grep -cE "apps/(pos|customer)/"` = 0.
   Kills: root `exclude` entry dropped (also fails app-workspaces test).
2. `npx tsc -p apps/pos/tsconfig.json --noEmit` and the customer one pass. Kills: app tsconfig missing or not extending root.
3. app-workspaces test: each of `apps/pos`, `apps/customer` is a workspace, has its own tsconfig, and every `paths`
   target resolves inside its own app or `packages/`. Kills: `@/*` -> `../erp/src/*`.
4. app-boundaries fixtures: pos importing `../../erp/src/x`, pos importing `@shareat/erp/...`, erp importing
   `@shareat/customer` are each reported. Kills: the detector returning `[]` (today the real tree has no imports, so
   the existing test would pass vacuously).
5. app-boundaries fixture: a cross-app import inside `apps/pos/out/` or `apps/pos/android/` is NOT reported, and those
   dirs are skipped. Kills: built bundles scanned (slow, false alarms after a local `build:cap`).
6. Ports: pos `dev`/`start` use 9009, customer 9010, and no two `apps/*/package.json` share a port. Kills: 9003 kept.
7. App ids: `capacitor.config.ts` appId equals `build.gradle` `applicationId` per app; neither is `net.shareat.pos` nor
   contains `culinaryflow`; the two differ. Kills: v1's id reused (would install over v1, wiping unsent sales).
8. ci-affected-apps: `UNKNOWN` -> both true; `docs/x.md` only -> both false; `apps/erp/src/a.ts` only -> both false;
   `apps/pos/src/a.tsx` -> pos only; `packages/core/src/a.ts` or `package-lock.json` -> both. Kills: fail-closed default.
9. ci-app-jobs test: `app-pos`/`app-customer` exist, `if:` reads their own output, `app-build.yml` has
   `runs-on: ubuntu-latest` and no `vars.CI_RUNNER`, and no `run:` line contains `secrets.`. Kills: app job on the self-hosted runner.
10. apk-signing-gate: no vars -> exit 0, `signing=skip`, notice text present; 4 vars -> `signing=release`; 2 vars ->
    exit 1, names the 2 missing, output contains no value. Kills: missing secret failing main; partial key passing.
11. pos-service-unit test: port 9009 via `apps/pos/package.json` `start`, `User=shareat`, `MemoryMax=` present, no
    `build`/`npm ci`/`npm install` anywhere in `ExecStart*`, no `After=postgresql`. Kills: a build on the droplet; root user.
12. scheduler-job-hosting passes with `'pos'` listed. Kills: an unexplained unit in `docs/ops/`.
13. `git diff 9c1704b -- .github/workflows/deploy.yml` is empty, and the `verify:` block of `ci.yml` is byte-identical
    (`git show 9c1704b:.github/workflows/ci.yml` vs HEAD, `verify:` to EOF of that job). Kills: any ERP job edit.
14. `npm ls react react-dom next --all` shows one version each, deduped; no existing package changes version in
    `package-lock.json`. Kills: a second React (breaks hooks) or a silent Next bump in the ERP.
15. `npm run build` (ERP, dev server stopped) passes. `npm run build -w @shareat/pos` and `build:cap` pass;
    `apps/pos/out/index.html` exists. Same for customer.
16. Smoke: `npm run dev:pos` serves "Shareat POS v2" on 9009; `dev:customer` serves "Shareat Customer v2" on 9010.
17. Live CI on the PR: `app-pos` and `app-customer` green with the skip notice (no secrets yet); `verify` has the same
    step list and its duration is within 60 s of the median of the last 3 green `main` runs. Full suite green.

## Risks to the existing ERP CI
- **Runner contention:** an app job on `vars.CI_RUNNER` would queue behind or ahead of `verify`. Ruling 4 + case 9.
- **`changes` slower:** the new step is one `git diff` + one Node call, under 2 s; `verify` waits on `changes`.
- **Install time:** Capacitor adds a few packages to every `npm ci` (ERP's ~11 s). Same Next/React ranges keep it
  small; case 14 and 17 check.
- **Deploy artifact:** `npm ci --omit=dev` in `deploy.yml` now also installs `@capacitor/core` (tiny). Report the
  change in `node_modules` size if measured; anything over +20 MB stops the lane.
- **vitest:** the unit project's glob includes `apps/**/*.test.ts` with `@` -> ERP. Shells carry no tests (B1-B2).

## Must NOT change
`deploy.yml` · the `verify` job · root `build`/`dev`/`start`/`typecheck` scripts · `vitest.config.mts` ·
any `packages/**` source · `apps/erp/**` · root tsconfig beyond two `exclude` entries · `docs/ops/provision.sh` ·
the bible and ADR-015 (the `culinaryflow` correction goes to the planner, RULES #14) · the droplets.

## Out of scope
Copying POS v1 (PC-3) · server routes and the export-vs-server split (PC-3) · shipping a POS build in `deploy.yml`
and enabling the unit (later task + ops) · vitest per-app projects (first app test, PC-3) · Customer content (P3) ·
integration sharding (PC-9) · Ian's global port table (his CLAUDE.md).

## Ian's step (plain words)
Make ONE new signing key for the v2 apps and add it to GitHub (repo Settings > Secrets > Actions) as four secrets:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. Keep a backup
copy offline: if this key is lost, installed tablets can never take an update in place. Until then CI stays green and
says the APK was skipped.

## Open questions
1. ~~App ids~~ answered by Ian 16 Oct: `net.shareat.pos2` / `net.shareat.order`; web addresses pos2.shareat.net / order.shareat.net.
2. While the key is missing, also build a test-only (debug) APK for one tablet trial? Recommended: no; it cannot
   update in place, and it risks reaching a store.
