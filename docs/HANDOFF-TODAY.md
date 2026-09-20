# Handoff — 2026-09-21 (overnight), the screen gate is open and T-187 is mid-flight

> ✅ **THE BUILD IS GREEN at `318d7b7`**, which is the last commit made with a clean tree.
> ⚠️ **IT IS NOT LAUNCHED.** No staff use it. That changes urgency, never correctness.
> ⛔ **T-187 SLICE 1 IS UNCOMMITTED AND IN FLIGHT** as this was written — see §4 before touching
> `packages/domain/src/service-charge/`, `packages/db/src/repo/findings.ts` or the two integration
> test files.
> ⛔ No present-tense claim is made about which commit production runs (DEF-360). Ask `/api/health`
> and compare all forty characters against `git rev-parse origin/main`.

## 1. ⭐ THE HEADLINE: §9.4 IS NO LONGER BLOCKED, AND THE OLD BLOCKER WAS THREE WRONG THINGS

**Read `docs/SMOKETEST.md` before you report the screen gate as impossible.** It has been reported
impossible three times, and last night every premise was re-measured instead of inherited.

| Yesterday's claim | What is actually true |
|---|---|
| *"The app 500s"* | `next dev` is dead (DEF-401). **The APP is not.** `npm run start` serves it. |
| *"Playwright needs Chrome, which needs Administrator, which is Ian's"* | ⚠️ **True of the pinned MCP tool, avoidable with a different one.** A standalone script driving Playwright's own chromium works — and those builds have been on this machine since **April and July**, months before DEF-401. ⛔ **Drop the Administrator task from Ian's list.** |
| *"Neither sign-in route works, the Firebase config is blank"* | **Was true, is not.** One blank line — the SERVER-side `FIREBASE_PROJECT_ID` — made `next start` (which runs as `NODE_ENV=production`) fail `env()`. Set to match its `NEXT_PUBLIC_` twin. `/api/health` is now `ok` with `database: reachable`. |

⭐ **Every one of those was a true observation generalised one step too far.** That is this repo's
most expensive recurring failure and it is worth more than the fix.

**Verified in a real headless browser:** `/`, `/findings`, `/liabilities` and `/settings/attendance`
all render **signed in** at 200.

⛔ **THE ONE LIMIT, AND IT MUST BE IN EVERY REPORT THAT USES IT.** The session is **forged**
(`docs/SMOKETEST.md` §3). It **bypasses sign-in on purpose**, so a smoketest through it proves
things about **SCREENS** and **nothing whatever about authentication**. ⭐ **A real end-to-end
sign-in still needs Ian to create the terminal account in the Firebase console** — T-304's layer 1
authenticates the *tablet* against Firebase in the browser and cannot be faked from a script.
**That is now the only genuinely outstanding environment item, and it is small.**

## 2. What Ian ruled overnight

| Ruling | Recorded in |
|---|---|
| *"our set up follows payday every 15 days"* | **bible row 225.** Inside RA 11360's sixteen-day ceiling, so row 223's *"verify every store's cadence before T-187 is done"* is **DISCHARGED**. |
| *"create a doc on store settings where admin define the date of paydays"* | **bible row 226** — and the measurement was that **the screen already exists** (`/settings/attendance`, shipped T-189c/d). Same shape as row 222. **T-332** is the check, not the screen. |
| *"merge"* (`daily-review/2026-09-17`) | done, `5ee484f` |

⭐ **Then the cadence was MEASURED, and the hypothesis was half wrong in the useful direction.**
Running the repo's own unmodified `derivePeriods`/`payoutDateFor` across 2026 and leap-year 2028:
semi-monthly never reaches 17 days — **it hits exactly 16, in seven months of every year, with zero
slack**. `monthly` breaches every month by 12-15 days. ⛔ **So "the config already guarantees
compliance" is the wrong conclusion and it is the one the numbers superficially support.**

## 3. Numbers

Next task **T-334** · next defect **DEF-406** · next migration **`0157`** (`0156` is T-276's).
⛔ **DEF-405 is SPENT AND RETRACTED** — a duplicate of **DEF-249**, filed and retracted the same
night. **Do not reissue it, and cite DEF-249** (with DEF-251 and DEF-256, its live consequences).
⛔ `0155` is applied in production. Reserved, do not re-issue: `0149`/`0150`/`0151`.
T-333 is **reserved and PROPOSED, not approved** — awaiting Ian.

## 4. ⛔ T-187 IS MID-FLIGHT — read this before touching the tree

**Uncommitted, and it belongs to the lanes:**

```
packages/domain/src/service-charge/index.ts          builder (webapps-4d)
packages/db/src/repo/service-charge.ts               builder
packages/db/src/repo/findings.ts                     builder  (per-store regroup)
packages/db/src/index.ts                             builder
packages/domain/tests/integration/findings.test.ts   tester   (webapps-d1)
packages/domain/tests/integration/service-charge-distribution.test.ts   tester
apps/erp/src/app/service-charge/{page,actions,lib}   builder  (folded in — see below)
apps/erp/tests/service-charge-wiring.test.ts         tester
```

⚠️ **`apps/erp/next-env.d.ts` is modified and is nobody's work** — a toolchain regeneration that
flips between the dev and build variants. It has been dirtying the tree for days. **Never stage
it**, and consider settling it properly when no lane is mid-slice.

**Where it got to.** The tester's red is in and accepted: three genuine per-store assertion failures
on the shipped detector, plus two new cases closing the day-16/day-17 boundary gap §3 flagged as
never exercised — **those two pass**, so the threshold was already right and only the grouping was
wrong. The builder has the domain function and the regroup written with typecheck clean, and is
building the screen.

⭐⭐ **THE TWO CORRECTIONS THE LANES MADE TO ME, because they are the reason the roles are split:**
1. **The TESTER caught a spec defect before a line of source existed.** My contract said
   `(tx, orgId, input)`; every money-moving function here takes an `Actor`. A bare `orgId` would
   have produced an entry attributable to **nobody**, in the one module whose subject is a statutory
   liability to staff. Verifying it surfaced a second gap: `postEntry` requires an `idempotencyKey`
   and the spec never said so. Both are AMENDMENTS 1 and 2 in the spec.
2. **The REPO caught my slicing.** I split the domain from its screen; `domain-actions-have-callers`
   and `production-caller-ratchet` both fired on an authorizing export with no caller under
   `apps/` — the **DEF-129/135/136/137/147** shape those guards exist for. ⛔ **Both could have been
   silenced with an EXEMPT entry or a regenerated baseline. Both were refused** — a regenerated
   baseline is exactly how DEF-403 deleted a real zero-caller finding here. **The screen folded into
   slice 1.** AMENDMENT 3.

**To finish it:** wait for `[BUILDER] READY` → run `callers.mjs --forbid` the tester's paths →
release the auditor for `/code-review` → tester smoketests the screen in a browser → stop the server
on 9008 → `gates.mjs --db shareat_test_t187_builder --port 9008` → **one commit** (the regroup and
the detector cases are coupled; splitting them makes `main` red in between, DEF-389's shape) → add
the nav entry yourself, the builder proposes an href and label in its READY.

## 5. Pick up here, after T-187

1. **T-332** — payday check. Specced on measurement, no screen to build, `createStore` is the single
   fix point (⛔ **not** `bootstrap-org.ts`: one INSERT, one caller, three doors).
2. **Phase 2** — DEF-395/DEF-382 re-derivation (needs a NEW task) · DEF-386 · DEF-374 · DEF-393 ·
   T-136 §2 · T-316 · T-276 (slot `0156`).
3. **Phase 5** (payroll, 16 of 18) — T-190 on row 217's trigger, then T-193. ⚠️ Check contribution
   rates against the current year; SSS changes yearly.

## 6. Traps that have actually bitten

- ⛔ **`/api/health` hides WHY in production.** It says `configuration: invalid` and never which
  variable. Do not debug it from the HTTP response — run `env()` directly under
  `NODE_ENV=production` and it names the variable in one line.
- ⛔ **Two guard scripts count English as code (DEF-403).** Shipping a function's name in operator
  copy deleted a real zero-caller finding, and **the error HIDES uncalled code**. `--probe` is also
  broken (DEF-402); pass a root first.
- ⛔ **A register row with a literal `|` breaks `register-row-shape`** and turns `main` red on a
  docs-only commit. Escape it. Three times now.
- ⛔ **A bible row means `npm run toc`.** Every time. **And §13 rows have FIVE columns** — the first
  draft of rows 225/226 had three and `document-facts` caught it.
- ⛔ **GREP the register, never Read it** — ~1.2MB. ⭐ **And grep it before issuing a defect number:**
  DEF-405 was filed, specced and committed as a duplicate because nobody ran one grep. **A duplicate
  passes every guard this repo has** — they check whether a row is well-formed, not whether it is
  new. That is what T-333 proposes to fix.
- ⛔ **Lane DBs:** verify routing through the **restricted role** the way `tests/integration/setup.ts`
  derives it (DEF-392). `shareat_test` is 155+ migrations behind — **never use it.**
- ⚠️ **Every session commits as the same git identity.** `%an` can never attribute a commit to a lane.
- ⛔ **Never run a browser binary with `--version` from a shell here** — it launches a GUI and hangs.

## 7. The lanes

⛔ **Ask each its model; never read it from a table (DEF-361).** All four were asked last night and
all four answered. Only Ian can `/model` or `/clear` a terminal.

| Session | Role | Model (as it reported) | State |
|---|---|---|---|
| `webapps-4d` | BUILDER | Sonnet 5 | mid-slice on T-187 · DB `shareat_test_t187_builder` |
| `webapps-d1` | TESTER | Sonnet 5 | red delivered, writing the wiring test · DB `shareat_test_t187_tester` |
| `webapps-42` | AUDITOR | **Opus 5** | idle, not yet used this cycle |
| `webapps-17` | relay + read-only census | Sonnet 5 | idle — ⭐ **the strongest lane last night** |

⭐ **`webapps-42` stated it takes direction from Ian, not from an orchestrator, beyond read-only
audit work.** That is the correct posture; do not argue it.
⭐ **`webapps-17` caught the DEF-405 duplicate and a live contradiction between two documents
written the same night, both times while sent to check something else.** Use it for verification
passes, and ask it to audit your own documents before you hand over.

## 8. FOR IAN

- ⭐ **You can drop the `npx playwright install chrome` Administrator task.** It was never needed.
- ⛔ **The one thing still only you can do:** create the **terminal account in the Firebase console**
  so PIN sign-in can be driven end to end. Everything else about the screen gate is solved.
- **T-333 is proposed, not approved** — a guard that reports duplicate register rows. The case
  against it is written into the spec. Your call.
- **`apps/erp/next-env.d.ts`** — a tracked toolchain file that keeps flipping and dirties every
  session's tree. Worth settling when no lane is mid-slice.

## 9. The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD. Put `/effort medium` for your own terminal in the first
status board's "needs you".

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED.

READ FIRST: docs/HANDOFF-TODAY.md (all of it), then docs/RULES.md, then docs/SMOKETEST.md.
⛔ GREP the big ones, never read them whole: DEFECTS-REGISTER.md ~1.2MB, PROJECT_BIBLE.md ~430KB,
ROADMAP.html.

⛔ FIRST: T-187 SLICE 1 MAY STILL BE UNCOMMITTED. Run `git status` before anything. §4 of the
handoff says exactly who owns which uncommitted file and what the remaining steps are. Do not
start new work while it is in flight.

⭐ THE SCREEN GATE IS OPEN. Do NOT report §9.4 as impossible — read docs/SMOKETEST.md. Playwright
and chromium have been installed here since April; the Administrator install was never needed.
⛔ BUT the session is FORGED and bypasses sign-in: it proves things about SCREENS and nothing about
AUTHENTICATION. Say so in every report. Real sign-in still needs Ian's Firebase terminal account.

⛔ THE THREE THINGS THAT WILL COST YOU A CYCLE:
1. `next dev` is DEAD (DEF-401) but THE APP IS NOT — `npm run start` serves it. And `/api/health`
   hides WHY in production: run `env()` under NODE_ENV=production to get the variable name.
2. Two guard scripts COUNT ENGLISH AS CODE (DEF-403) — shipping a function's name in operator copy
   silently deletes a real zero-caller finding, and the error HIDES uncalled code.
3. GREP THE REGISTER BEFORE ISSUING A DEFECT NUMBER. DEF-405 was filed, specced and committed as a
   duplicate of DEF-249 because nobody ran one grep. A duplicate passes every guard here.

⭐ THE LESSON THAT HELD TWICE LAST NIGHT: work out the DIRECTION of an error before its SEVERITY,
and re-measure a blocker before inheriting it — three separate "impossible" claims dissolved into
one blank environment variable and a wrongly-scoped tool constraint. Ask what the single surviving
path now trusts before calling anything done.

⭐ AND LET THE LANES CORRECT YOU. Last night the TESTER found a defect in the orchestrator's own
contract before a line of source existed, the CENSUS lane caught a duplicate defect filing and a
live contradiction between two documents written the same hour, and the REPO'S OWN GUARDS refused a
slice that would have shipped money-moving code nothing could reach. All three were the
orchestrator's errors. Four lanes are alive and re-adoptable (webapps-4d builder, webapps-d1
tester, webapps-42 auditor, webapps-17 relay/census). ⛔ ASK each its model; never read it from a
table.

-----------------------------------------------------------------------------------------------
