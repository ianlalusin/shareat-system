# T-339: small defects batch 1 (DEF-412, 165, 337, 148, 236)

**Status:** APPROVED 2026-09-24 (orchestrator) for slices 1–4. Slice 5 DEFERRED until T-276's 0157 is on main.
Specced 2026-09-24 by the Opus planner.
**Closes:** DEF-412, DEF-165, DEF-337, DEF-148, DEF-236.
**Dropped at triage (re-verified against code 2026-09-24):** DEF-217 (fixed by 0136, row says so;
`packages/db/schema/scheduler.ts:155` lists all ten jobs incl. `budget_reissue`) · DEF-181 (fixed
by DEF-192/T-227: `apps/erp/src/components/nav.tsx:189` links `/settings`; `app/settings/page.tsx:68-88`
links all five children; row never stamped FIXED) · DEF-220 (fixed by T-253 `793bd39`:
`commissary/catalogue/default-store.ts`, tests `apps/erp/tests/commissary-catalogue-default.test.ts`
+ `packages/db/tests/integration/commissary-default-store.test.ts`; row never stamped FIXED).
⚠️ The orchestrator stamps the two stale rows (181, 220) FIXED; no builder does.
**Migration slot:** `0158` (slice 5 only). ⛔ **Blocked until T-276's `0157` is committed** (§5.0).
**Model:** Sonnet for every slice.

Every slice: TESTER (test files only) and BUILDER (source only), disjoint paths. The tester writes first
and records red; the red message must be the one named. Gates: RULES §2 definition of done, including the
**full** integration suite before push — slice 1 is what makes it green again.

---

## Slice 1 — DEF-412: findings fixture models a store no supported path creates (TESTER ONLY)

**Verified open:** `HANDOFF-TODAY.md:4` — 3 failed / 3025, all `findings.test.ts`. The fixture
(`packages/domain/tests/integration/findings.test.ts:52-69`) inserts `stores` by raw SQL and seeds no
`store_attendance_config`; every supported path now seeds one (`packages/domain/src/stores/service.ts:129`,
T-336), so `attendanceConfigMissing` (`packages/db/src/repo/findings.ts:~1996`) rightly fires.

**Fix (test only):** in `fixture()`, after the store insert,
`asOrg(orgId, tx => seedAttendanceConfig(tx, { orgId, storeId, effectiveFrom: '2026-01-01' }))` — precedent
`:1235`; `seedAttendanceConfig` is idempotent (`attendance/config.ts:114-121`), so `openDayOn`'s own call
returns the same row.
**Tester paths:** `packages/domain/tests/integration/findings.test.ts`. **Builder:** none.

**Tests:**
- Red = today, captured BEFORE editing: `:120`, `:772`, `:816` fail, each received containing
  `kind: 'attendanceConfigMissing'`. Record raw output.
- Green: all three pass with no change to their assertions. ⛔ Do not edit expected counts.
- **Negative half (new test, same describe):** in the clean fixture's org, insert a SECOND store by raw SQL
  with no config; assert `findings` is exactly one entry, `kind === 'attendanceConfigMissing'` for that
  store's id, and `payoutIntervalTooLong` absent — the clean case's `[]` is not vacuous for this detector.
- DEF-412's `payoutIntervalTooLong` question: with no config `liveCadenceConfigs` (`findings.ts:1945-1955`)
  returns nothing, so it cannot have fired; after the fix the store is on schema-default semi_monthly, which
  T-332 B1 (`t332-payday-compliance.test.ts:142-150`) proves silent. The green `[]` is the proof — report it.

**Invariants:** ⛔ no change to any detector or `listFindings` (DEF-412 disposition; RULES §6.3). The
fixture now matches `stores/service.ts`, the one supported store creator.
**Done when:** `findings.test.ts` fully green on a fresh lane DB; full integration suite 0 failed; raw
before/after in the report.

---

## Slice 2 — DEF-165: `scaleQuantity` is 1000× too small

**Verified open:** `packages/domain/src/production/index.ts:222-232` still divides by an extra `1000n`.
`scaleRecipeToTarget` (`:200`) is exported through the domain barrel (`src/index.ts:89`), zero callers.

**Fix:** replace the body's last three lines with the half-up form proven in
`packages/domain/src/pos/plan.ts:139-147`: `const rounded = (v * n + d / 2n) / d; return fromThousandths(rounded);`.
Correct the wrong comment ("still one factor of 1000 too large"). In `plan.ts:128-137` change the comment's
claim that the production function is broken to "fixed by T-339 (DEF-165)" (comment only).
**Tester:** `packages/domain/tests/unit/t339-scale-recipe-to-target.test.ts` (new; import
`scaleRecipeToTarget` from `../../src/production`, as `t328-trade-reconciliation-guard.test.ts` imports).
**Builder:** `packages/domain/src/production/index.ts`, `packages/domain/src/pos/plan.ts` (comment).

**Tests:**
- Red: line `0.500 kg`, base `kg`, output `1.000`, target `2.000` ⇒ `lines[0].quantity === '1.000'`.
  Red must read `expected '0.001' to be '1.000'`.
- Conversion: line `500.000 g`, base `kg`, output `4.000`, target `10.000` ⇒ `'1.250'` (today `'0.001'`).
- Rounding both sides of half: `0.001 × 1.000 / 2.000` ⇒ `'0.001'` (0.0005 up); `0.001 × 1.000 / 3.000`
  ⇒ `'0.000'` (0.00033 down).
- **Negative halves (pass before and after):** target `'0.000'` ⇒ `ok:false`, reason `/greater than zero/`;
  a `pcs` line with base `kg` ⇒ `ok:false`, reason `/cannot be converted/`.

**Invariants:** exact bigint, no floats (RULES §1 rule 6). Half-up exactly once, same rule as `plan.ts`.
**Done when:** new file red→green; typecheck + unit clean.

---

## Slice 3 — DEF-337: `provision-terminal` refuses without `SYSTEM_DATABASE_URL`

**Verified open:** `scripts/provision-terminal.ts:80-90` checks only `DATABASE_URL`, then calls
`systemTransaction`; `packages/db/src/client.ts:96-98` falls back to `DATABASE_URL`; `client.ts:161-164` still
says unset means "not production, not local dev" — false since the 2026-09-12 role swap
(`docs/ops/README.md:22-28`).

**Fix:** in `main()`, right after the `DATABASE_URL` check and before any `systemTransaction`: if
`process.env.SYSTEM_DATABASE_URL` is undefined or whitespace-only (same rule as `blankAsAbsent`,
`packages/core/src/env.ts:26-30`), throw
`provision-terminal: SYSTEM_DATABASE_URL is not set (or blank). Without it the store lookup runs under the RLS-enforcing role and every store looks missing. Locally, set it to the same value as DATABASE_URL. Nothing was written.`
The existing `.catch` sets exit 1. Rewrite `client.ts:161-164` to the post-swap truth: production sets it; an
unset value silently falls back to the enforcing role.
**Tester:** `tests/unit/t339-provision-terminal-system-url-guard.test.ts` (new; spawn precedent
`packages/db/tests/db-generate-retired.test.ts:36-37`: `spawnSync(process.execPath, [tsxCli, <abs script>, '--store=NOPE', '--uid=x'])`).
**Builder:** `scripts/provision-terminal.ts`, `packages/db/src/client.ts` (comment only).

**Tests** (each spawn sets `DATABASE_URL=postgres://u:p@127.0.0.1:1/none` — unreachable, so a missing guard
fails on connection instead):
- Red, three cases: `SYSTEM_DATABASE_URL=''`, `'   '`, absent (with `cwd` = an `mkdtemp` dir so no
  `.env.local` supplies it). Each: exit 1, stderr `/SYSTEM_DATABASE_URL is not set/`, stderr NOT
  `/no store with code/`. Today's red is a connection/env error that never names the variable.
- **Negative half:** `SYSTEM_DATABASE_URL=postgres://u:p@127.0.0.1:1/none` ⇒ stderr does NOT match
  `/SYSTEM_DATABASE_URL is not set/` (guard not unconditional). Assert only the absence; the connection error
  varies by machine.

**Invariants:** ⛔ refuse, never warn. ⛔ Do not set a principal instead (DEF-337 disposition; bible §13
row 201). `system-transaction-callers` test stays green; no new callers.
**Done when:** four cases red→green; unit suite clean.

---

## Slice 4 — DEF-148: `/sales-days/new` can submit another store's channel ids

**Verified open:** `apps/erp/src/app/sales-days/new/page.tsx` is a server component, no client code; the
`<select name="storeId">` (`:62-72`) is inside the POST form while the channel rows come from `?store=` (`:26-28`).

**Fix (no JS; the register's refused "render all stores" option stays refused):** move the store choice into
a `FilterRow` GET form (`apps/erp/src/components/FilterRow.tsx`) above the POST form:
`<select name="store" defaultValue={storeId}>`, `submitLabel="Switch store"`, rendered only when
`stores.length > 1`. Inside the POST form replace the select with
`<input type="hidden" name="storeId" value={storeId} />` plus a read-only line with that store's name and code.
No store ⇒ "This organisation has no stores yet." and no POST form.
**Tester:** `apps/erp/tests/t339-sales-day-new-store-picker.test.ts` (new; source-structure test in the
idiom of `service-charge-wiring.test.ts`). **Builder:** `apps/erp/src/app/sales-days/new/page.tsx`.

**Tests:**
- Red: slice the text from `<form action={createSalesDayAction}` to its `</form>`; assert no `<select`
  with `name="storeId"` inside. Red reads: found `name="storeId"` on a `<select` inside the POST form.
- **Negative halves:** the POST slice DOES contain `type="hidden"`, `name="storeId"`, `value={storeId}`
  (deleting it makes the action throw "Choose a store.", `sales-days/actions.ts:82`); outside the slice the
  page contains `<FilterRow` and a `name="store"` select; `listChannels(orgId, storeId)` and the hidden
  `value={storeId}` use the same identifier.
- Server guard intact: `packages/domain/tests/integration/sales-days.test.ts:469`
  (`/is not configured for store/`) stays green — RULES §1 rule 7: the UI fix does not replace the gate.
- **S1 (tester, http://localhost:9008, `docs/SMOKETEST.md` §3):** org with ≥2 stores having different active
  channels. `/sales-days/new?store=<A>` → pick B → "Switch store": URL `?store=<B>`, channel rows and the
  read-only store line are B's. Fill balancing amounts, save: a draft for B, no "not configured for store"
  refusal. Screenshots both themes.

**Done when:** red→green; S1 passes with screenshots; build green with the server stopped.

---

## Slice 5 — DEF-236: `attendance_credentials` refuses a blank revoke reason (DEFERRED)

### 5.0 ⛔ Sequencing precondition
Journal head is `0156`; `0157` is allocated to T-276 but **not written** (`HANDOFF-TODAY.md:17`). If `0158`
is applied anywhere before `0157` exists, drizzle later skips `0157` there silently — its `when` would be
older than the last applied (DEF-039; ADR-012 §2.2). **The builder does not start until `0157` is on `main`**,
or the orchestrator re-slots one of the two.

**Verified open:** `packages/db/schema/attendance-credentials.ts:164-168` and migration `0100:48-50` require
only `revoke_reason IS NOT NULL`; sibling `person_credentials_revoke_check` (0138) adds the non-blank clause.
Today the trim lives only in the service (`packages/domain/src/attendance/credentials.ts:287-288`); bible
§15.11 forbids the service being the only defence.

**Fix:** hand-authored migration (ADR-012 §5) `0158_t339_def236_attendance_revoke_reason_nonblank.sql`, header
in 0138's style (cite the NULL-blind trap):
1. `UPDATE attendance_credentials SET revoke_reason = 'Revoked with a blank reason before one was required — DEF-236.' WHERE revoked_at IS NOT NULL AND btrim(revoke_reason) = ''`
   (idempotent; not a `NOT VALID` case, same reasoning as 0138; fires `attendance_credentials_mirror_enqueue`
   for any backfilled row — expected).
2. `DROP CONSTRAINT attendance_credentials_revoke_check`, re-`ADD` **same name**:
   `(revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL AND btrim(revoke_reason) <> '')`
   — all three columns stay bound.
3. Journal `{ idx: 158, version: "7", when: <0157.when + 86_400_000>, tag, breakpoints: true }` — must equal
   `1799724707084` if `0157` is on the grid.
Mirror the clause in the schema builder (bible §8).
**Tester:** `packages/db/tests/integration/t339-attendance-revoke-reason-check.test.ts`,
`packages/db/tests/integration/t339-attendance-revoke-reason-migration.test.ts` (new).
**Builder:** the migration file, `packages/db/migrations/meta/_journal.json`,
`packages/db/schema/attendance-credentials.ts`.

**Tests** (raw SQL, fixtures from `attendance-credentials-scan-collision.test.ts:60-100`):
- Red: revoke with `''` and with `'   '` ⇒ reject `/attendance_credentials_revoke_check/` (today both resolve).
- **Negative halves:** `'Lost badge'` accepted; `revoke_reason = NULL` with `revoked_at` set still rejected
  (NULL-blind trap); revoked with `revoked_by = NULL` still rejected; never-revoked all-NULL row inserts.
- Migration (model: `attendance-credentials-scan-collision-migration.test.ts`, `TARGET_TAG_PREFIX '0158_'`):
  scratch DB migrated to just before 0158, seed revoked rows with `'  '` and `'Lost'`, apply the real folder:
  first carries the DEF-236 sentence, second untouched, constraint present (`pg_constraint`). Red before the
  file exists: "no migration tagged 0158".
- `packages/db/tests/migration-journal.test.ts` stays green.

**Invariants:** never edit an applied migration (RULES §1 rule 9); constraint name unchanged; the DB
enforces, the service trim stays as second layer (bible §15.11).
**Done when:** red→green, journal tests green, proven on a scratch DB (ADR-012 §5.8), full integration green.

---

## Out of scope
- `clock_terminals` (0087) has the same blank-reason gap → logged as **DEF-415**; not fixed here.
- `scaleRecipeToTarget` with `recipeOutputQuantity = 0` returns zeros silently (`d === 0n`) → log; not here.
- Any change to detectors, `listFindings`, or `createSalesDay`'s refusal.
- DEF-181's proposed "every route linked" guard (covered by `nav-route-reachability`).
- Bible amendments (RULES §1 rule 14).

## Done when (task)
Slices 1–4 red→green with raw output; full integration 0 failed; S1 on 9008; build green with the server
stopped. One commit per slice (or per coherent pair), each with the why, ending
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Register rows 412, 165, 337, 148 (and 236 when
slice 5 lands) get FIXED stamps from the orchestrator.
