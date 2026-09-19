# Handoff — 2026-09-20 (early hours), written after T-327 shipped

> ⭐⭐ **THE GOAL, IN IAN'S WORDS, UNCHANGED: *"make the app as close as possible to deployment."***
> ⚠️ **AND IT IS NOT LAUNCHED.** Production deploys exist; no staff use it yet. That changes urgency,
> never correctness. ⛔ **This document makes no PRESENT-TENSE claim about which commit production
> runs** (DEF-360). Ask `/api/health` and compare all forty characters against
> `git rev-parse origin/main`.

## Where things stand

**T-327 is committed: `1b308c8`, 51 files.** The tree is clean apart from three files that are
deliberately not yours (§5). **Nothing is in flight.** Three lanes are alive and FROZEN by
instruction — they will not write until told (§4).

```
GATES: PASS typecheck=0/17s unit=0/56s integration=0/1973s build=0/64s
  typecheck 0 errors · unit 132 files/1839 passed · integration 134 files/2932 passed · build exit 0
CALLERS: OK — 0 new exports across the entire task
```

⚠️ **Integration is the FULL suite (134 files), not just T-327's four.** And it takes **33 minutes** —
budget for that before promising anyone a gate result.

| Commit | What |
|---|---|
| `0443c2f` | **DEF-387** — the dev renderer, and the production path nobody had tried |
| `02cb9e2` | T-327 spec corrected before it was built: 172 was 160 |
| `b45467d` | T-327: the constraint name's own suffix would have been truncated away |
| `5649adb` | **DEF-389** — `main` went red on a docs-only commit, in a repo whose tests assert on docs |
| `bac3292` | **DEF-370** filed twelve citations late, and **DEF-388** |
| `1f0cd9b` | **DEF-390** and **DEF-391** |
| `1b308c8` | ⭐ **T-327 — the database refuses a non-finite amount on all 160 numeric columns** |
| `4d864f2` | DEF-382 → `half-fixed`, roadmap, and the deploy blocker it leaves open |
| `e6308f1` | T-329 Tier C — Ian ruled on the screenshots |

---

## ⛔⛔ 1. THE ONE THING IAN MUST DO BEFORE T-327 REACHES PRODUCTION

**Scan production for an existing `NaN`. It is one query and it is now a DEPLOY BLOCKER.**

⭐ **Proven, not theorised.** The tester's own lane database failed to migrate:

```
Migration FAILED: check constraint "pay_rates_amount_finite_check"
of relation "pay_rates" is violated by some row
```

`0155` validates against existing rows and **refuses to apply to any database already holding a
non-finite value.** If production holds one, the deploy runs the migration, it fails, and — per
**DEF-327**'s precedent *on this project* — the deploy aborts under `set -e` **before the symlink
swap**, so the host keeps serving the old release and nothing says so.
⚠️ It fails atomically and rolls back clean; there is no partial state. **But the deploy stops
silently**, and that shape has already cost this project a day once.

Expected zero — nobody uses the system yet — **but expected is not measured.**

---

## ⛔ 2. PICK UP HERE

- **T-328** — `docs/tasks/328-every-typed-amount-reaches-the-parser-that-already-exists.md`.
  The census and the conversion. **T-327 shipped precisely so this census is allowed to be wrong.**
- **T-329 Tiers B and D/E** — `docs/tasks/329-cleanup-what-other-sessions-left-behind.md`.
  ⭐ **Tier A and Tier C are DONE** (§6). **Tier B is five `export` keywords** in
  `packages/domain/src/shared/money-positivity-census.ts` — trivial, and it now unblocks because
  T-327 has committed and that file is no longer frozen.
  ⚠️ **Weigh it against the gates:** a 33-minute integration run to remove five keywords is a poor
  trade on its own. **Bundle it with T-328's first slice** rather than spending a cycle on it.
- **Then:** DEF-386 · DEF-374 · T-320 (+DEF-367) · DEF-373.

---

## ⭐⭐ 3. THE METHOD FINDING — read this before the defect list

**Three times in one task, a CORRECT fix carried the defect one slot over. All three fixes were
still the right call.**

| The fix | What it opened |
|---|---|
| Strengthening test 3 with runtime derivation | Opened the door to deriving the expected SENTENCE — the unfailable-assertion class the amendment existed to close |
| Consolidating two drifted mapped-ness checks into one `mappedMessage` | Widened what a name-only match controls: a misnamed future constraint went from mis-messaged to mis-messaged **and invisible to the refusal register** |
| Swapping the test's population to `pg_catalog` | Closed a privilege-visibility hole, opened a `relkind` one, same direction |

⭐ **The auditor's formulation, kept verbatim because it is the transferable part:**

> *A fix concentrates risk onto whatever the single new path now trusts — a derivation, a name
> suffix, a relkind filter — and the thing it trusts is what nobody re-reads, because the visible
> reasoning about the fix reads as evidence the thinking is done.*

⭐ **And its companion, from the privilege-filter finding:** the file's header reasons explicitly and
well about which catalog to trust for the COVERAGE half — and reached for `information_schema` for
the other half. **Careful reasoning on one side is exactly what stops anyone re-reading the other.**
Four readers passed over that query; the visible argument in the header is plausibly why.

⛔ **The lesson is NOT "fix less."** It is: after consolidating, ask what the single surviving path
now trusts, and check *that*.

---

## ⛔ 4. THE THREE LANES — alive, FROZEN, and worth re-adopting

| Session | Role | Model | State |
|---|---|---|---|
| `webapps-d1` | TESTER | Sonnet 5 | FROZEN by instruction. Wrote all 4 T-327 test files. |
| `webapps-4d` | BUILDER | Sonnet 5 | FROZEN by instruction. Wrote `0155` + 44 schema files + the resolver. |
| `webapps-42` | AUDITOR | Opus 5 | FROZEN by instruction. Four audit rounds. |

⭐ **These three worked extremely well and should be re-adopted rather than replaced.** Tell each it
is unfrozen and re-brief from the spec on disk; the briefing format is self-contained by design.
⛔ **ASK EACH ITS MODEL, NEVER READ IT FROM THIS TABLE** (DEF-361). A `/model` switch by Ian is
invisible to this file — `webapps-4d` was Opus when this session started and Ian switched it.

### ⛔ THE ORCHESTRATOR'S OWN FAILURES TONIGHT — all three were mine, all were caught by others

1. ⛔⛔ **THREE GATE RUNS DISCARDED, each reading files being rewritten underneath them.** Every time
   I started a run on a tree I had not frozen and then treated the output as evidence. Caught twice
   by the auditor comparing mtimes, once by the builder reporting a transient failure rather than a
   result. ⭐ **THE FIX IS A STEP, NOT MORE CARE: freeze → both lanes confirm → verify no file mtime
   is newer than the freeze → then run.** Do this from the first gate run, not the fourth.
2. ⛔ **A BASELINE STAGED AFTER THE EDITS IT WAS MEANT TO DETECT.** I reported "the diff against the
   index is empty" as verification. It proved nothing. ⭐ **The rule is the ORDER: stage before
   dispatching a lane, never after receiving its report** — and say in the briefing *when* the
   baseline was taken so the auditor can check the ordering rather than take your word.
   ⚠️ And do not apply the rule mechanically: re-staging at the wrong moment **destroys** a good
   baseline. The auditor stopped me doing exactly that.
3. ⛔ **I RELAYED A NUMBER I HAD MEASURED MYSELF AND GOT WRONG.** `/code-review` estimated "~100
   tables"; I wrote it into the builder's instructions as fact, and it reached the migration header.
   **It is 65 — and I had measured 65 in the first query of the task.** Bible row 208 applies to the
   orchestrator: *a figure you have not read is a guess*, and it does not stop being one because it
   passed through three sessions on the way down.

### ⚠️ CALIBRATION ON `/code-review` — it earns its place AND needs checking

⭐ **Three checks it ran that no lane could:** live predicate semantics against the database
(`'NaN' < 'Infinity'` = **false**, executed rather than reasoned); confirming the
`pg_get_constraintdef` deparse is byte-identical to the test's template; and ⭐ **deriving the 160
columns by replaying `CREATE TABLE`/`ADD COLUMN`/`RENAME`/`DROP` across all 155 migrations** — the
only derivation of the four that does not read the schema files, and therefore the only one that
would see a column added in raw SQL.

⛔ **But its round-number summaries are estimates wearing the same typeface as its measurements.**
"50 schema files" (it is 44). "~100 tables" (it is 65). **Neither orchestrator nor auditor relays
another of its figures unmeasured.**
⛔⛔ **AND ITS SILENCE ON A FILE READS EXACTLY LIKE APPROVAL.** It produced **no verdict of any kind**
on `t327b-…test.ts` in either round that file changed, and none on the coverage test in round one.
⭐ **ALWAYS DEMAND A COVERAGE STATEMENT** — which files the recipe reached and which it did not.
That single habit produced two of this cycle's most useful facts.

---

## 5. Numbers and shared state

Next task **T-330** · next defect **DEF-392** · next migration **`0156`**.
⛔ **`0155` IS APPLIED AND COMMITTED — never edit it.** Reserved, do not re-issue: `0149`/`0150`/`0151`.
⚠️ **Three files are deliberately not yours:** `apps/erp/next-env.d.ts` (Next-generated; flips between
`./.next/dev/types/…` and `./.next/types/…` depending on whether `dev` or `build` ran last —
typecheck passes as-is), plus `docs/reviews/NEXT-PROMPT.md` (modified) and `docs/reviews/2026-09-17.md`
(untracked), an exited session's since 2026-09-17. **Never stage them.**
⚠️ **Lane databases: only 3 remain** — `shareat_test` (shared), `shareat_test_t327_builder`,
`shareat_test_t327_tester`. T-328 needs its own: `shareat_test_t328_{tester,builder}`.

---

## 6. ✅ Done tonight beyond T-327

- **T-329 Tier A** — 20 stale lane databases dropped. **554 MB → 101 MB, 453 MB reclaimed**,
  23 databases → 3. Keep-list re-derived live (zero active connections) rather than trusted from the
  spec written hours earlier.
- **T-329 Tier C** — Ian ruled *"delete the screenshots, keep the smoke scripts"*. 79 PNGs removed,
  5 MB reclaimed; 17 `smoke-*.mjs` and all six core tools kept.
- **DEF-389 fixed** — `main` had been red since the previous evening. A docs-only commit skipped the
  gates on the reasoning that docs need none, **in a repo whose unit suite asserts on the docs.**
  Bible row 216 had also shipped with four columns where §13 declares five, so Ian's own ruling was
  rendering shifted. ⛔ **"Docs-only" is NOT a gate exemption here.**
  ⚠️ **The `Reversible?` cell on row 216 was written by the orchestrator, not by Ian** — the row
  shipped without one, so there was nothing to restore. **Ian should confirm the characterisation.**

---

## ⛔ 7. KNOWN SHARP EDGES — diagnosis pre-written, deliberately not fixed

⭐ **Each was measured to zero instances and left alone on purpose. The diagnosis is worth more than
a fourth round on a hypothetical.**

1. **`t327-schema-coverage-finite-check.test.ts` uses `relkind = 'r'`**, which is narrower than the
   `table_type = 'BASE TABLE'` it replaced: `information_schema` reports a PARTITIONED table as
   `BASE TABLE`, but `pg_class` calls it `'p'`. **Fix: `cl.relkind in ('r','p')`.**
   ⛔ Measured: **zero** partitioned tables — no `PARTITION BY`/`PARTITION OF` in any of the 155
   migrations, none in the Drizzle schema. Fails OPEN, but requires someone to add the repo's first
   partitioned table.
2. **The same file's expected predicate substitutes an UNQUOTED identifier.**
   `pg_get_constraintdef` quotes an identifier only when it must, so a future numeric column named
   `"end"` or `"order"` renders quoted and produces a **red against a correct constraint.** Fails
   CLOSED — caught immediately, but points at the wrong thing and costs someone twenty minutes.
3. **`gates.mjs` counts the word `Error` in build output**, so a green build reports
   `build … 1 error line(s)` whenever it prints a source excerpt containing `throw new Error(...)`.
   **Harmless and will recur.** Worth a register row so the next person does not re-diagnose it.
4. **`pre-session-message.ts:138`** builds its `/setup` allowlist from `Object.values(CONSTRAINT_MESSAGES)`
   alone, so the suffix sentence is not in it. ⛔ **Fails closed and NOT reachable today** — traced:
   `/setup` writes no numeric column. ⚠️ **But the module's stated contract — *"a mapped constraint
   sentence survives the allowlist"* — is now FALSE for 160 constraints and nothing tests it.**
   *A stale contract sentence is how the next person reasons wrongly with complete confidence.*
5. **Two hand-copied `provoke` helpers** sit in the test tree (test 3 and t327b) and **drifted within
   a single round.** Currently byte-identical again. ⭐ They should be one shared helper — but that
   is a real design decision (where it lives, its signature, whether test 1 joins) and deserves its
   own review. ⛔ **Do NOT consolidate them using the same "hand-copied patterns drift" argument that
   justified `mappedMessage`: the reasoning does not transfer from source to CONTROLS.** A control
   has to restate the contract independently or it is a tautology. The contract's shape appearing in
   the migration SQL, the Drizzle `check()` entries and the test template is **correct**, not
   redundant.

---

## ⛔ 8. §9.4 IS UNMET AND WAS NOT MEETABLE — three blockers, stacked

**Reported in those words under bible row 203, not skipped quietly.** No screen test exists for
T-327; `t327b` and the operator test are the entire behavioural proof.

1. **DEF-387** — `npm run dev` cannot render any page. Turbopack cannot spawn its PostCSS worker
   (`0xc0000142`, `STATUS_DLL_INIT_FAILED`). A full reboot did not fix it. ⛔ Do NOT retry
   `--webpack`; it is worse. ⭐ **But `npm run build` + `npm run start` SERVES PAGES** — `/sign-in`
   returns 200 with real HTML. That path was available throughout the three days §9.4 was reported
   unmet and nobody had tried it.
2. **DEF-388** — the only renderer that works runs as `NODE_ENV=production`, and T-323's emulator
   sign-in gate is deliberately `NODE_ENV !== 'production'`. **The working mode is the one mode
   sign-in is refused in.** ⛔ Do NOT "fix" this by loosening that guard — it exists so a production
   build cannot accept unsigned tokens.
   ⭐ **DEF-371 is FIXED and the previous handoff did not know it** — Ian signed in against the
   emulator on 2026-09-18. A stale blocker is worse than an open one: it stops people trying the
   thing that now works.
3. ⛔ **No browser automation exists on this machine.** The Claude extension is unreachable
   (machine-wide, not per-session), and Playwright is pinned to **Chrome, which is not installed at
   all** — all four standard paths empty. ⚠️ **Edge IS installed and Playwright's bundled Chromium
   IS cached (three versions).** So the gap is *"pinned to the one browser that is absent"*, **not**
   *"no browser available"* — repointing is **untested**, and the config lives in Ian's
   `~/.claude.json`. **That is a smaller ask than installing software and it has not been tried.**

⭐ **CHEAPEST UNTRIED ROUTE TO A SCREEN, for whoever wants §9.4 back:** the **clock terminal needs a
pairing token, not a login** (DEF-371's disposition). Seed `mirror/{storeId}/roster`,
`mirror/{storeId}/config/current`, `biometricMirror/{storeId}/credentials` and it is drivable with no
sign-in at all. ⚠️ It exercises `resolveScan` and the Firestore inbox write, **not** the Postgres
ingestor — and that limit belongs in any report that leans on it.

---

## 9. ⛔ FOR IAN — open decisions nobody else can make

1. ⛔⛔ **Run the production `NaN` scan before T-327 deploys.** §1. One query. Deploy blocker.
2. **Confirm the `Reversible?` text on bible row 216** — the orchestrator wrote it because the row
   shipped without one. Your Decision and Rationale cells are untouched.
3. **DEF-390: should the tester's RED be COMMITTED before the builder is released?** The auditor
   argues yes — it turns bible §3.2's *"watched them fail for the right reason"* from a claim into an
   artifact, and makes the forbidden-path check meaningful instead of unconditional. ⚠️ **The cost:
   `main` goes red between the red commit and the green one, and CI deploys from `main` on green.**
   DEF-389 is a day-old reminder of what a red `main` costs. A short-lived branch, or a CI rule
   tolerating red on a commit explicitly marked RED, resolves it. **This is a decision about your
   deploy pipeline.**
4. **Should `write_off` exist at all?** v1 has no such path — a shortage was always charged — and
   bible row 216 names two outcomes, neither of which forgives a loss. ⛔ Not deleted, deliberately.
5. **Who may accept an overage?** Charging a shortage is gated behind a manager permission; accepting
   an overage is a different act and may warrant a different gate.
6. **Is verification meant to happen before handover?** Only a verified day is settleable, so cash
   handed in ahead of verification becomes a surplus by construction.
7. **`docs/reviews/NEXT-PROMPT.md`'s uncommitted edit reinstates a remedy its own committed version
   struck out as FALSE.** Correct it or discard it. Untouched since 2026-09-17. ⚠️ Related: the
   branch `daily-review/2026-09-17` holds **one unmerged commit** and is NOT stale — deleting it
   loses that commit.
8. **T-329 Tier E — 29 files in `scripts/`.** Deliberately untouched. ⛔ Several are invoked by
   **systemd units on the production host**, which the repository cannot see (DEF-326). **A script
   with no in-repo caller is not evidence that nothing calls it.** If you want this done it is its
   own task, and it starts by reading the installed units on `159.223.46.224`.
9. ⚠️ **`docs/RULES.md` §5 still says the bible holds "107 logged decisions".** It holds **216**.
   Nobody's task; a count in a place nobody maintains.

---

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the global
/orchestrator skill. You are starting COLD.

⭐ IAN'S GOAL: "make the app as close as possible to deployment." ⚠️ IT IS NOT LAUNCHED. Production
deploys exist; no staff use it yet. That changes urgency, never correctness.

⛔⛔ FIRST, AND IT IS FOR IAN, NOT YOU: production has never been scanned for an existing NaN, and
T-327 made that a DEPLOY BLOCKER rather than a nicety. Migration 0155 validates against existing
rows and REFUSES to apply to any database holding a non-finite value — proven when a lane database
failed to migrate over 13 poisoned rows. If production holds one, the deploy aborts before the
symlink swap (DEF-327's precedent) and the host silently keeps serving the old release. Raise it
with Ian before anything else.

⭐⭐ THREE LANES ARE ALIVE AND FROZEN, AND THEY ARE GOOD — RE-ADOPT THEM, DO NOT REPLACE THEM:
webapps-d1 (TESTER), webapps-4d (BUILDER), webapps-42 (AUDITOR). Tell each it is unfrozen and
re-brief from the spec on disk. ⛔ ASK EACH ITS MODEL, never read it from a table (DEF-361) — Ian
switches models and the handoff cannot see it.

⛔⛔ THE ORCHESTRATOR IS THE LEAST-POLICED SESSION AND IT CAUSED EVERY COLLISION AGAIN. Three gate
runs were discarded for reading files being rewritten underneath them, every one because a run was
started on a tree that had not been frozen. THE FIX IS A STEP, NOT MORE CARE: freeze → both lanes
confirm → verify no file mtime is newer than the freeze → then run. Do it from the FIRST gate run.
And stage a baseline BEFORE dispatching a lane, never after receiving its report — a baseline taken
after the edits cannot detect them, and saying "the diff is empty" over one is theatre.
⚠️ Integration takes 33 MINUTES. Budget for it.

⛔ A FIGURE YOU HAVE NOT READ IS A GUESS, AND THAT APPLIES TO YOU. The orchestrator relayed
"~100 tables" from /code-review into a migration header as fact; it is 65, and it had measured 65
itself hours earlier. /code-review's mechanical verification is excellent and its round-number
summaries are estimates in the same typeface. ALWAYS DEMAND A COVERAGE STATEMENT from it — which
files its recipe reached and which it did not. Its silence on a file reads exactly like approval,
and it produced no verdict at all on one test file across two rounds.

⭐⭐ THE METHOD FINDING, worth more than any defect below: three times in T-327 a CORRECT fix carried
the defect one slot over. A fix concentrates risk onto whatever the single new path now trusts — a
derivation, a name suffix, a relkind filter — and that is what nobody re-reads, because the visible
reasoning about the fix reads as evidence the thinking is done. After consolidating, ask what the
surviving path now trusts, and check THAT.

NEXT UP: T-328 (docs/tasks/328-*.md) — the census and conversion that T-327 shipped to make
survivable. Bundle T-329 Tier B (five export keywords) into its first slice rather than spending a
33-minute gate cycle on it alone. Then DEF-386 · DEF-374 · T-320 (+DEF-367) · DEF-373.

⛔ §9.4 IS UNMET AND WAS NOT MEETABLE — say so in those words rather than skipping it (bible row
203). Three blockers stack: the dev renderer cannot serve a page (DEF-387), the only mode that can
refuses emulator sign-in by design (DEF-388), and there is NO browser automation on this machine —
Chrome is not installed at all, though Edge and Playwright's bundled Chromium ARE present, so the
gap is "pinned to the one absent browser", not "no browser". Repointing is untested and the config
is Ian's. ⭐ The cheapest untried route to a screen is the CLOCK TERMINAL, which needs a pairing
token rather than a login.

Read: docs/RULES.md, docs/HANDOFF-TODAY.md (§3 and §7 especially), PROJECT_BIBLE.md row 216,
DEFECTS-REGISTER.md section E. ⛔ GREP the big ones — the register is ~1MB and the bible ~418KB.

Next task T-330 · next defect DEF-392 · next migration 0156. Lane DBs: only 3 remain; T-328 needs
its own shareat_test_t328_{tester,builder}.

-----------------------------------------------------------------------------------------------
