# Handoff — 2026-09-17

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED FROM YESTERDAY: *"make the app as close as possible to
> deployment."*** When two pieces of work compete, the one that unblocks a deploy wins.
>
> ✅ **DEPLOYED AND VERIFIED TODAY.** Eight commits, five of them shipped to production, CI green on
> all of them, and the full integration suite passed in CI (**11m56s** — a real run, not a doc-only
> skip). ⛔ **This document makes no PRESENT-TENSE claim about which commit production is running,
> on purpose** (DEF-360). **Ask `/api/health` and compare all forty characters against
> `git rev-parse origin/main`.**
>
> ⚠️ **The distinction is DEF-360's whole point, and the shas in §1 are the safe kind.** *"Shipped in
> `d841aa0`"* is a past-tense statement about an event and can never go stale. *"Production is on X"*
> rots on a schedule nobody controls — it was falsified once by the act of saving the document that
> asserted it. **Cite commits freely; never assert the live state.**
>
> ⭐⭐ **IAN CHANGED HOW THIS WORKS TODAY, AND IT IS THE MOST IMPORTANT THING IN THIS FILE.**
> *"1 session agent must always be a tester, 1 must be builder 1 must be auditor to audit the work
> with /code-review skill always"* — and, minutes later, *"use chrome to drive tests"*.
> **`~/.claude/skills/orchestrator/SKILL.md` and `worker-briefing.md` are rewritten for it.** Three
> fixed roles, one per session, never blended. **It paid for itself within the hour — see §4.**

## Where things stand

**Production is healthy and CURRENT.** Ask the endpoint; do not read a sha out of this file.

⛔ **THREE COMMITS ARE UNPUSHED** and they are documentation only — the T-321 spec, its amendment,
and the roadmap correction. They are safe to push; nothing in them touches code. ⚠️ **But do not
push the working tree** — see §3.

## 1. What shipped

| Commit | What |
|---|---|
| `d841aa0` | **T-318 slice C** — the 21 everyday capabilities flipped off the automatic `staff` cell; 22 integration files repaired |
| `27c53e2` | DEF-365 given a ceiling **and its own diagnosis retracted**; Ian's cash ruling recorded; T-320 reserved |
| `90c82d0` | **T-318 slice D** — the screen; **bible 3.19, rows 210–212** |
| `3601126` | **T-319** — a remittance before anything is verified is refused (closes DEF-358) |
| `5bb5595` | **DEF-368** — the sign-in screen tells a locked-out operator that PIN sign-in works, and it does not |
| `305def0` `06769e8` `278be4b` | T-321 specced and amended; roadmap rows for T-318 and T-319 — ⚠️ **unpushed** |

⭐ **T-318 IS COMPLETE — all four slices — AND IT IS THE THING IAN ASKED FOR.** His report was
*"still cant turn off record sale submit sales day on dishwasher role and server and panda role"*.
A Dishwasher and a Server at one store now differ, proven by a test that exists and passes.

## ⛔⛔ 2. THE NUMBER THAT IS THE LESSON OF THE DAY: 19 → 20 → 22

The risk census for slice C said **19** integration files would break. A widened census said **20**.
**Running the suite said 22.** Three blind spots, each a different shape, and **none of them was in
the gated-capability list, which was correct all along:**

1. the staff-actor regex accepted `'staff'` only as a **last** argument, so a three-parameter
   fixture helper (`mkPerson('Branch cook', 'staff', [br.id])`) hid a whole file;
2. direct-call-only reading could not see a test reaching a gated function through an intermediate;
3. ⛔ **the capability is DATA, not a literal** — `PURPOSE_CAPABILITY[purpose]` in one module,
   `capabilityFor(kind)` in another. **No call-site pattern can ever see either.**

⛔⛔ **AND THE SPEC HELD THE EVIDENCE AND DREW THE OPPOSITE CONCLUSION.** It named `files/index.ts`,
correctly said its comment *"No access changes — both are granted to staff"* had gone false, and then
wrote *"so nothing breaks"* — **true of the production code, false of the test estate, and the two
were never separated. The reassuring clause is what made it invisible.**

⭐ **Bible §13 row 212 is the ruling: a static census only NOMINATES candidates; running them is what
settles it.** Committing on the estimate would have made `main` red and blocked every deploy.

## ⛔ 3. THE WORKING TREE IS NOT CLEAN — AND THE TESTS IN IT ARE RED ON PURPOSE

**T-321's tests exist and the implementation does not.** This is the new working model operating
exactly as intended: the tester wrote the red, the builder was released and **never started**.

**Uncommitted:**
```
 M apps/erp/src/lib/terminal/lane.fingerprint-seam.test.ts      ← INVERTED, see below
 M docs/tasks/321-scan-namespace-collision.md                   ← a numbering fix, safe
?? apps/erp/src/lib/terminal/lane.test.ts
?? packages/db/tests/integration/attendance-credentials-scan-collision.test.ts
?? packages/domain/tests/integration/attendance-credentials-fingerprint-collision.test.ts
```

⛔ **DO NOT COMMIT THE FOUR TEST FILES TO `main`.** They are red, a red `main` blocks every deploy,
and that is the one outcome this project cannot afford. **Finish T-321 first, then commit the whole
slice.** ⚠️ Confirmed with all three lanes at stand-down: **no source file was touched by anyone**,
no migration was started, `meta/_journal.json` is untouched.

⭐ **A BACKUP EXISTS OUTSIDE THE REPOSITORY AND HERE IS THE PATH** — last time a handoff said a
backup existed without saying where, which would have made it unfindable by the exact session it was
written for:

```
C:\Users\ianla\AppData\Local\Temp\claude\C--Windows-System32\
  0eb91988-4b46-4db0-8ddf-70b23a9c825d\scratchpad\t321-red\
    seam-inversion.patch    — git diff of the one modified file
    untracked\              — the three new test files, verbatim
```

⛔ **PREFER THE WORKING TREE; the backup is insurance only.** ⚠️ That directory is session-scoped and
may be cleaned up. **If the tree still carries these files, it is the authority.** If both are gone,
the work is reconstructible from this section plus the spec's own Tests list — which is why the
failure text and the three misreadings are written out here rather than summarised.

**The verified red — measured by the orchestrator, not quoted from a lane:**

| | |
|---|---|
| unit, `apps/erp/src/lib/terminal/` | **2 failed / 2 passed** — `expected { credentialId: 'c-card', …(3) } to be null` |
| integration, orchestrator's own DB | **3 failed / 2 passed** — the DB accepts the collision; the constant does not exist; `enrolFingerprint` resolves instead of rejecting |

⭐ **`lane.fingerprint-seam.test.ts` WAS GREEN WHILE DEMONSTRATING THE DEFECT.** It asserted that
array order decides who a colliding scan resolves to. **A test that documents broken behaviour and is
green is not a red control** (RULES §3.2). It is inverted **in place**, not deleted, so the shape of
what was wrong stays visible beside what replaced it.

### ⚠️⚠️ THREE THINGS ABOUT THOSE TESTS A STRANGER WILL MISREAD — read before touching them

1. ⛔ **THE `vi.mock('node:crypto')` IN `attendance-credentials-fingerprint-collision.test.ts`
   RETURNS THE SAME FIXED 16 BYTES FOR EVERY CALL.** It models `enrolFingerprint` minting **once**,
   which is what Contract 4 implies. ⛔ **If the builder implements retry-until-unique instead**
   (the `mintUniqueToken` pattern DEF-362's older disposition describes), **the mock defeats the
   retry completely** — every attempt gets the identical value, so it will loop to the retry bound
   and throw whatever *that* throws, or hang if there is no bound. **That is not a bug in the new
   code. Check this mock before debugging the source.**
2. **The two PASSING integration tests are not proof yet.** Two-orgs-may-share and
   revoked-does-not-collide pass today **because nothing blocks any collision at all**, not because
   org-scoping or revocation-exclusion works. They become real proof only once Contract 1 exists.
3. **The constant test is currently red for ABSENCE, not drift.** Neither the constant nor the index
   exists. It becomes a drift-catcher once both do. ⭐ It scans the schema module's exports for a
   value equal to the literal rather than importing a guessed property name, **so it cannot pass by
   coincidence.**

## 4. ⭐⭐ THE NEW THREE-ROLE MODEL, AND THE PROOF IT WORKS

**Ian's instruction, today, standing.** `~/.claude/skills/orchestrator/SKILL.md` §2 now defines:

| Role | Owns | Never touches | Model |
|---|---|---|---|
| **TESTER** | test paths; writes the red, **drives the real screen in Chrome** | source | Sonnet |
| **BUILDER** | source paths | ⛔ **a test file — not one line** | Sonnet |
| **AUDITOR** | nothing, read-only; **`/code-review` on every slice** | any file | **Opus** |

⛔ **The auditor's review does NOT replace the orchestrator's own diff read.** *"The auditor said it
was clean"* is now in the skill's red-flag list beside *"the worker said the gates are green"*.
⛔ **`/code-review` read-only — never `--fix`, never `--comment`.**

### ⭐⭐ It caught a real regression before a line of code existed

The **auditor** found that `enrolCard`'s catch is
`String(error).includes('attendance_credentials_card_live_unique')` (`credentials.ts:161`) — **a
literal match on an index name T-321 deletes.** Reword the message, leave the condition, and after
the migration that `if` never fires: execution falls through to `throw error` and **`enrolCard`
starts leaking a raw Postgres violation on every card collision.**

⛔ **That is the DEF-362 shape, re-created on the one path in this codebase that currently does it
right — inside the very task bundled to close DEF-362.** The fix would have re-opened the defect it
was written to close.

⭐ **And the harder half:** the auditor then checked whether it would be **silent**, found
`attendance-credentials.test.ts:169-173` asserts `.rejects.toBeInstanceOf(CredentialError)`, and
qualified it honestly — *"IF the builder runs it."* That is now spec test 8, and the tester must run
and **name** it. **None of this would exist if the auditor role had been folded into the builder.**

### The tester's four corrections of the orchestrator, all right

The `uuidv7` prefix collision *(the first eight hex characters are the top 32 bits of a millisecond
timestamp and advance once every 65 seconds — five values minted together share one prefix)*; the
migration-journal index asserted from `max(created_at)` without opening the journal; the two red
files no census could find; and **both T-321 citations, one of which named the wrong FILE** —
`resolveCredentialAt` is `packages/db/src/repo/attendance-credentials.ts:90-108`, not the domain
file. ⛔ **The orchestrator took a bare filename out of a message and guessed the path. Bible §13 row
208, twice in one day, in the week that row was written.**

## 5. Pick up here — ordered by what unblocks a deploy

1. **Push the three unpushed doc commits.** Safe; no code.
2. ⛔⛔ **FINISH T-321.** The spec is written and amended; the red is verified; **migration `0153` is
   allocated and unwritten.** Read `docs/tasks/321-scan-namespace-collision.md` in full and
   `docs/discovery/36-def-363-scan-namespace.md` behind it. **Closes DEF-363 AND DEF-362 together —
   they cannot be separated, because the constraint alone makes DEF-362 worse.**
   ⭐ **Severity is higher than DEF-363's row records:** `resolveScan`'s own comment says *"This
   decides what to SHOW, and nothing else"* — **false.** `clock/page.tsx:245-246` sends the guessed
   credential kind into the punch, and the server's correctly kind-scoped lookup trusts it. **The
   misattribution reaches the punch, and attendance feeds payroll.**

   > ### ⭐ The auditor's six checks for T-321 — verbatim, so tomorrow's auditor starts from them
   >
   > Written by `webapps-4e` **before any implementation existed**, from reading the spec alone.
   > **Do not rebuild this list; use it.**
   >
   > 1. **Did the builder touch ANY tester file** — `git diff --name-only` against
   >    `lane.fingerprint-seam.test.ts`, `lane.test.ts`/sibling, `packages/db/tests/integration/**`,
   >    `packages/domain/tests/integration/**`. ⛔ **One moved line under the builder's hand is the
   >    finding, ahead of everything else.**
   > 2. **Did the index count actually go DOWN** — count indexes in the migration SQL itself, never
   >    take it from the commit message. Two old partial-unique indexes dropped, one new one added,
   >    **net −1**.
   > 3. **Does `resolveScan` REFUSE** (return `null`) on more than one match — no ranking, no
   >    *"cards win"*, no first-match fallback of any kind.
   > 4. **Does the migration REFUSE on pre-existing colliding rows and NAME the offending
   >    organisations / staff codes**, rather than letting index creation fail with a bare constraint
   >    error.
   > 5. **Does the new constraint name exist as a SINGLE exported constant** in
   >    `packages/db/schema/attendance-credentials.ts`, imported by BOTH `enrolCard`'s and
   >    `enrolFingerprint`'s catches — not hand-typed two or three times.
   > 6. **Was `packages/domain/tests/integration/attendance-credentials.test.ts:169-173` actually run
   >    and named** in the tester's RED report, and does `enrolCard` still raise `CredentialError`
   >    (not a raw error) for that exact case **after** the rename (spec test 8).
3. **DEF-357** — cap the handover at what is owed plus a declared overage. ⭐ **T-319 unblocked it:**
   it was rejected twice because `owed` is zero while nothing is verified; with the refusal in place
   `owed > 0` is guaranteed whenever a remittance proceeds.
4. **T-320** — access that does not come from a position. Two findings, one subject.
5. **DEF-367** — `setPositionDefault` reports `affected` for a person whose access did not change,
   and slice D's new disclosure now contradicts it on the same screen after the same click.
6. **DEF-366**, **DEF-368** — both cheap, both in whichever pass next touches those files.

## 6. Do not decide these alone — they are Ian's

- ⛔ **The clock app's identity** — one-way, and it blocks the largest remaining arc (T-314 slice B).
- **A tablet and the fingerprint reader model.**
- **The live balance on the cashier float account** — any non-zero figure stops T-316. SSH is
  blocked for agents.
- **Do cashiers enter the day's cash before or after handing it over?**
- **T-315's backfill** — migration, reviewed script, or leave it manual.

✅ **ANSWERED TODAY, do not re-ask:** the cash handover before verification → **REFUSE** (T-319,
shipped). ⚠️ **He was warned it would change how cashiers close and THAT WARNING WAS FALSE** — the
screen already gated it; he was told so plainly. The record says what he was told at the time.

## 7. Traps that have actually bitten

- ⛔ **The shell eats a backslash and executes backticks.** Write tool → plain file → a script that
  READS the file. **Bit the orchestrator again today** writing a regex into a heredoc.
- ⛔⛔ **A pipe count cannot tell a structural pipe from an escaped one.** A validator rejected a
  correct bible row containing a literal `||` from the `authorize` expression. Count only pipes not
  preceded by a backslash.
- ⛔ **Take a table's expected shape from its HEADER, never a neighbouring row.** The register's five
  sections do not share a shape — A–D carry an `App` column that E does not.
- ⛔ **`verified` does NOT mean fixed.** Only `fixed` closes a row. **⛔ in the Sev column means
  "correctness and money", not "blocking"** — a category, not an urgency.
- ⛔ **`npm run build` dirties `apps/erp/next-env.d.ts`.** Generated — restore, never commit.
- ⛔ **A bible row insertion shifts every line below it** — run `npm run toc`.
- ⛔ **The full integration suite OOMs locally** (DEF-245). CI is where it runs; say *"passed in
  CI"*. ⚠️ **And running the unit suite and an integration sweep in parallel got both killed for low
  memory today.** One at a time.
- ⛔ **SSH to the droplet is blocked for agents.**
- ⚠️ **`DROP DATABASE` took 38,477ms under concurrent lane load and 57–75ms on a quiet machine**
  (DEF-365). Both figures are real; the condition is the difference.
- ⛔⛔ **NEITHER SIGN-IN ROUTE WORKS ON THIS DEV MACHINE** — the public Firebase config is blank, and
  the screen's own notice claiming *"PIN sign-in is unaffected"* is **false** (DEF-368).
  ⛔⛔ **AND THE SENTENCE THAT USED TO SIT HERE — *"But the CLOCK TERMINAL CAN be driven"* — WAS ALSO
  FALSE, MEASURED 2026-09-17 (DEF-369).** It was right that
  `apps/erp/src/lib/terminal/firebase.ts` reads `process.env` directly with `'emulator'` fallbacks,
  right that it honours `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST`, and right that it never calls
  `publicEnv()` — **and the conclusion was still wrong, because nobody checked whether the fallback
  fires.** It does not: the fallbacks are `??`, `.env.local` holds those values as the **empty
  string** rather than unset, and `getAuth()` throws `auth/invalid-api-key` before the emulator is
  ever connected. `/clock` died on the error boundary exactly like `/sign-in`.
  ⭐ **WHAT ACTUALLY WORKS, and it unblocks BOTH routes — no code change:** start the dev server with
  every `NEXT_PUBLIC_FIREBASE_*` identity value set to a non-empty placeholder plus
  `NEXT_PUBLIC_FIREBASE_EMULATOR_HOST=localhost:8182`, against the emulator suite
  (auth **9198**, firestore **8182**). Verified by loading both screens: `/clock` renders *"Pair this
  terminal"* and `/sign-in` renders both forms, consoles clean. **So DEF-368 is an environment
  condition on this machine, not a second code defect — and §9.4 is reachable today.**

## 8. Numbers to allocate from

Next task **T-322** · next defect **DEF-369** · next migration **`0154`**
⚠️ **Reserved, do not re-issue:** `0149`/`0150` (T-314 F/G), `0151` (T-316), **`0153` (T-321,
UNWRITTEN — it is the next migration to be authored)**.
⛔ **`0152` is APPLIED IN PRODUCTION and may never be edited.** Its `when` is `1799206307084`; any
new `when` must exceed it and be **re-derived from `packages/db/migrations/README.md` at build
time**, never copied from a message (DEF-039).

## 9. Live agent sessions

⛔ **ASK A SESSION ITS MODEL; NEVER READ IT OUT OF THIS TABLE** (DEF-361).

| Session | Role today | Lane DB | State at wrap-up |
|---|---|---|---|
| `system32-85` | orchestrator | `shareat_test_orch` | this session |
| `webapps-65` | **TESTER** | `shareat_test_lanea` | idle. Wrote T-321's red; corrected the orchestrator four times |
| `webapps-4e` | **AUDITOR** | `shareat_test_laneb` | idle. Read-only all day; found the `enrolCard` regression. ⚠️ **Ran on Sonnet — the `/model opus` switch was requested and never made** |
| `webapps-f7` | **BUILDER** | `shareat_test_lanec` | idle. DEF-363 research; **never started building** |

⚠️ **`webapps-f7` went unreachable for several hours mid-morning** in a `waiting` state and its
entire lane was reassigned. It recovered and lost nothing. **If a lane goes silent, reassign rather
than wait.**

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." When two pieces of work compete,
the one that unblocks a deploy wins.

⭐⭐ THE SKILL CHANGED YESTERDAY AND IT IS NOT OPTIONAL. Three sessions, three FIXED roles, one
each: a TESTER who writes the red and drives the real screen in Chrome, a BUILDER who makes it
green and never edits a test file, an AUDITOR who runs /code-review on every slice READ-ONLY.
Read SKILL.md §2 before briefing anybody.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, docs/tasks/321-scan-namespace-collision.md,
docs/discovery/36-def-363-scan-namespace.md, PROJECT_BIBLE.md rows 204-212, DEFECTS-REGISTER.md
section E (DEF-363 through DEF-368 are the newest).

⛔ THE WORKING TREE IS NOT CLEAN AND THE TESTS IN IT ARE RED ON PURPOSE. T-321 has four test files
and no implementation — the builder never started. Handoff section 3 names every file, the exact
failure text, and THREE ways a stranger will misread those tests. Read it before running them. Do
not commit them to main until the slice is finished; a red main blocks every deploy.

⛔ THREE COMMITS ARE UNPUSHED. Documentation only. Safe to push.

⛔ PRODUCTION: ask /api/health and compare all forty characters against origin/main. No sha appears
in the handoff on purpose (DEF-360) — a present-tense production claim rots on a schedule nobody
controls.

⛔ BEFORE TRUSTING ANY PIPELINE: gh workflow list --all. CI sat disabled_manually for nine hours
once and nothing reported it (DEF-336). Deploy is workflow_run-gated on CI. A billing refusal fails
in ~6 seconds because no job runs; a real deploy takes ~3 minutes.

⛔ NEITHER SIGN-IN ROUTE WORKS LOCALLY (DEF-368) — and the screen's own notice saying PIN sign-in is
fine is FALSE. The CLOCK TERMINAL can still be driven in Chrome against the Firebase emulator
(auth 9198, firestore 8182); it never calls publicEnv(). Confirm sign-in BEFORE dispatching a
tester to click a screen.

⛔ EDITING DOCS: the shell EXECUTES backticks and EATS backslashes. Write tool → plain file → a
script that READS the file. Then: node scripts/backtick-parity.mjs

⛔ THE LANE RUNNER: node ~/.claude/skills/orchestrator/tools/it.mjs <lane_db> <files...>
Never npm run test:integration. The full suite OOMs locally (DEF-245); say "passed in CI". And do
not run the unit suite and an integration sweep at once — both got killed for low memory.

⭐ ASK EACH LANE A QUESTION, NOT JUST FOR A CHANGE, AND TELL IT TO CHECK YOU. Bible rows 207/208.
Yesterday that discipline caught the orchestrator four times, including a cited file path that did
not contain the function it named. Every one was found because the briefing said verify, not accept.

⛔ AND THE DAY'S HARDEST LESSON: a static census only NOMINATES candidates; RUNNING them settles it.
Three passes of careful reading said 19 files, then 20. The real number was 22. Bible row 212.

Next task T-322 · next defect DEF-369 · migration 0153 is ALLOCATED TO T-321 AND UNWRITTEN;
0149/0150 → T-314 F/G, 0151 → T-316. 0152 is APPLIED IN PRODUCTION — never edit it.

-----------------------------------------------------------------------------------------------
