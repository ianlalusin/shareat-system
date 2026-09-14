# Handoff — 2026-09-14 (second wrap-up of the day)

> ⭐⭐ **THE DAY'S FINDING IS THAT SIX DOCUMENTS OF RECORD WERE STALE OR SELF-CONTRADICTING, THREE
> HAD ALREADY MISLED A READER, AND THE INSTRUCTION TO KEEP THEM CURRENT ALREADY EXISTED AT FULL
> STRENGTH.** The session opened by repairing one such defect (DEF-348) and filed **seven more of
> the same family** — in the register itself, in the bible, in the ops doc, and one the orchestrator
> reported to Ian as fact.
>
> ⛔ **`.claude/skills/wrap-up/SKILL.md` already orders this**, with Ian's name and date on it:
> *"every wrap-up, no exceptions"*, *"Not 'if it changed'"*, and line 139 even names the staleness
> it exists to stop. **It lost 3–0 today.** So the answer being built is **not a reminder** — it is
> *delete the moving fact, derive it, or let a build fail on it*. That is **T-317**.
>
> ⚠️ **This is the SECOND wrap-up on 2026-09-14.** The earlier one (`71671a9`) covered the morning;
> this covers everything after `2f07363`. Written for a **COLD start** — read `docs/RULES.md` first.

## Where things stand

**Production is live on `1a3405e`** and self-reporting it: `/api/health` returns `configuration:
valid`, `database: reachable`, and a `revision.sha` verified against the deploy by all forty
characters. **T-302 shipped and deployed**, so migration `0148` has run — ⛔ **every PIN that
existed before it is revoked and re-issuing them is Ian's, not done yet.**

Three tasks shipped (T-311, T-312, T-313 plus T-302), three specs are approved and unbuilt (T-314,
T-316, T-317-remainder), one number is reserved with its analysis written (T-315). **Nine defects
filed, three closed, one corrected as false-in-its-own-row.**

## Gates at `30e1383`

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test` (unit) | **exit 0** — 117 files, **1655 passed**, 1 skipped |
| `npm run build` | **exit 0**, dev server stopped and 9008 confirmed free by process enumeration first |
| Integration — **scoped**, orchestrator's own DB | **6 files / 127 passed** on `shareat_test_orch` — the affected auth/domain surfaces |
| Integration — **FULL SUITE** | ✅ **passed in CI** on `1a3405e`, run `34823958663`, **11m38s**. ⛔ Never run locally — it OOMs (DEF-245) |
| Document guards | **28/28** across `task-status-banner`, `register-row-shape`, `deferral-staleness`, `toc-freshness` |
| Backtick parity | ✅ zero odd rows across the four documents of record **and** `ROADMAP.html` |
| CI / Deploy | ✅ both `active`, both fired automatically on push |

⚠️ **Say "passed in CI", never bare "green"** for the full suite. The scoped run is the orchestrator's
own independent re-run, which is what proves a result is not an artefact of one lane's harness.

## What happened this session

**Four tasks shipped.** **T-311** — `deploy.yml` claimed eleven GitHub Secrets and read seven; the
corrected comment ships with a test asserting claimed-versus-read **both ways**, verified by
breaking the real file in both directions. **T-312** — fourteen shipped tasks stopped claiming they
were never started, plus the guard. **T-313** — the register's own row shape guarded and
**thirty-three malformed rows repaired**. **T-302** — one PIN per person across every branch, with
migration `0148`.

⭐ **Every correction today came from a lane checking a premise rather than a conclusion**, which is
now **bible §13 row 207**:
- **T-312 was filed as nineteen files and is fourteen.** Five of DEF-348's own nineteen lead with a
  *correct* status and match only because they quote the banner they replaced. ⛔ And that row's
  headline claim was **false against a row three columns away** — it said DEF-122's subject *"is
  still stale today"* while DEF-122's State column had read `fixed` since 2 September.
- **DEF-353's own row was wrong about its own composition** — mis-attributing five rows and missing
  a whole failure shape (a *missing* cell, not a stray one).
- ⛔ **The orchestrator told Ian four scheduled jobs had never run. They are all armed.** The claim
  came from `docs/ops/README.md` asserting it in the present tense while **the same file, 230 lines
  below, records Ian arming the last of them** (DEF-354). A lane reported it faithfully *because the
  file says so* and hedged; the orchestrator dropped the hedge.
- **DEF-193 had been false since T-229** — `createCategory` and its form exist, so a category *can*
  be created at runtime. Two lanes costed Ian's staff-food allowance as *"small, but it is code"* on
  that row; the honest answer is **zero code, two screens.**
- **`judgeDraw`'s premise** (*a float pot's balance is complete*) is true of `1115` and **false of
  the takings drawer** — so T-316's migration alone would have refused the exact case Ian asked
  for. **No grep finds that; the coupling is semantic.**

**Decisions Ian made, and where each is recorded:**

| Decision | Recorded in |
|---|---|
| Push the twelve commits, accepting the PIN revocation | done — production on `1a3405e`; `docs/tasks/302-*.md` status line |
| Till floor: **PREVENT**, not alarm-only | `docs/tasks/316-till-floor-on-the-cashier-account.md` |
| Both instruments: a cashier revolving fund **and** a collective staff-food allowance | `docs/tasks/316-*.md` §goal; bible row 128's correction |
| Staff food is **OPEX**, category taken from v1's data | `docs/CAPABILITY-GAPS.md` (T-267→T-266 citation fixed); DEF-193's closure |
| **Build the fingerprint**, *"import everything needed"* | `docs/tasks/314-fingerprint-capture-import.md` |
| Backfill the roadmap for untracked tasks | done — `ff31f07`, 29 rows from shipping commits |
| Build the document guards | `docs/tasks/317-document-facts-guards.md` |
| Timers: *"leave for now"* | this handoff, and DEF-354's corrected state |
| Reimbursement screen: *"later, no use case for now"* | `docs/CAPABILITY-GAPS.md` 2026-09-11 entry stands |

⚠️ **One unrecorded item, deliberately:** the **AP-ceremony tension** — whether a floor-funded
purchase (a broom, ice) must go through the same verified-invoice cycle as a supplier bill. Stated
in `docs/tasks/316-*.md` §8.2, **undesigned**, needs Ian.

## Pick up here

1. ⭐ **T-317 guards 2–6.** Guard 1 shipped (`de28bd2`) with DEF-193's own case as its red control,
   and three guards' private copies of the same three questions were consolidated into
   `tests/unit/lib/document-facts.ts`, proven behaviour-preserving by re-running each guard's
   destructive control through the moved code. **Design work for guards 2 and 3 is already done and
   is in the spec's margins:** guard 2 has exactly **two** matches across the seven real files, both
   in `ROADMAP.html` and both legitimately exempt — and one, `'1 day away'`, sits inside the
   `<script>` block DEF-350 added, so **a script-block exemption is needed beyond quote-stripping**
   because a single-quoted JS literal is not caught by it. Guard 3 has two unresolved candidates in
   undated sections (`"unarmed"` at ~:515, `"is enabled"` at ~:540) that may be past-tense narrative
   and a durable install-versus-enable fact rather than stale claims — **read both in full context
   before deciding.**
2. **DEF-359 — repair the six malformed `PROJECT_BIBLE.md` §13 rows.** ⛔ **Planner only** (§14).
   Row 146 has **eleven** pipes, rows 160/167/206 have seven, and rows **204/205 have five** — a
   cell *missing*, which must be **reconstructed by reading the row**, not guessed. ⚠️ The counts are
   the orchestrator's measurement and were **not** independently re-derived by a lane.
3. **T-316** — blocked on two things that are Ian's, both in its §5 and §3.4. Do not start it
   without them.
4. **T-315's spec** — the measurement is written; only the backfill decision is missing.
5. **T-314 slice A** — the only fingerprint slice needing no hardware: ~162 lines of portable logic
   plus ~216 lines of v1's own tests. ⚠️ It legitimately ships with **no production caller** until
   slice E; that is stated so a reviewer does not read it as the DEF-129 shape.

## Do not decide these alone — they are Ian's

- ⛔⛔ **RE-ISSUE LIPA'S PINs.** Production has been running `0148` since 08:55Z. Every pre-existing
  PIN is revoked; the screens correctly say *"No sign-in PIN issued yet"* with the issue form
  beneath. **A rollback does not restore them.** Admin email-and-password sign-in is unaffected.
- ⛔ **The live `1115` balance** — `select store_id, gl_account_code, float_target from money_accounts
  where float_target is not null;`. **The orchestrator cannot run it** (`DATABASE_URL` → `shareat_dev`,
  SSH blocked for agents). **Any non-zero balance stops T-316**: moving live money between accounts
  is a posting with a date, not a schema change.
- **Do cashiers enter the day's cash before or after handing it over?** T-316 needs a *declaration*,
  not a verification — but if nobody enters a figure, the declared amount is zero and the rule
  refuses real money.
- **Fingerprint:** the dongle model (the `.so` names point at ZK9500/SLK20R-class), permission to
  re-vendor the ZKTeco jars, and ⛔ **the app ID** — reusing `com.shareat.erp` would **replace v1's
  live clock app** or fail on a signature mismatch, during a parallel run where v1 must keep
  working. `com.shareat.erp2` is proposed; it is one-way.
- **T-315's backfill** — grant scope to every open employment by migration, run a reviewed script,
  or leave the tick manual. A migration changes who can do what in production with nobody reviewing.
- **DEF-358** — refuse remitting before any day is verified, or admit a variance row with a null day?
  The first is an operational change to a cashier's evening.
- **Roadmap coverage** — now backfilled to T-101, so the *"authoritative from T-119"* question is
  moot; T-317 guard 5 will keep it that way.

## Traps that have actually bitten — live right now

- ⛔ **The shell eats a backslash in `node -e`, four times today.** A regex like the unescaped-pipe
  counter becomes an unterminated literal. **The rule is already written down and it works: Write
  tool → plain file → a script that READS the file.** Stop reaching for `-e`.
- ⛔ **A row describing a pipe defect will contain one.** Happened **twice**: DEF-353's first draft
  and DEF-359's. Both were refused by the insert script at the wrong bar count. **Describe a regex
  in words inside a table cell; never quote it.**
- ⛔⛔ **Take a table's expected shape from its HEADER, never from a neighbouring row.** DEF-359 was
  found because an insert script compared a correct row against a malformed neighbour and refused
  the correct one. **The header is the schema; an adjacent row is only a sample, and a sample can be
  the defect.**
- ⚠️ **A guard cannot see what the roadmap does not list.** T-311's and T-312's own banners went
  stale within hours and T-312's guard was blind to both, because its done-set is parsed from
  `ROADMAP.html` and neither had a row (DEF-352). **The roadmap pass is the fix, not the guard.**
- ⛔ **`npm run build` dirties `apps/erp/next-env.d.ts`.** Generated — restore it, never commit it.
- ⛔ **The full integration suite OOMs locally** (DEF-245). Scoped runs are healthy; CI is where the
  full suite runs.
- ⛔ **SSH to the droplet is blocked for agents.** Ian runs host-side commands — suggest `! <command>`.
- ⚠️ **`docs/ops/README.md` no longer records which timers are armed, on purpose** (DEF-354). The
  arming state lives in its dated sections and on the host: `is-enabled` **and** `is-active` per
  unit, never `list-timers` (DEF-332).

## Numbers to allocate from

Next task **T-318** · next defect **DEF-360** · next migration **`0152`**
⚠️ **Reserved, do not re-issue:** `0149` and `0150` (T-314 slices F and G), `0151` (T-316).
Each `when` must exceed **1798860707084** (`0148`) and follow ADR-012 §5's grid — ⛔ **re-derive it
from `packages/db/migrations/README.md` at build time, never from a message.** DEF-039's failure mode
is a migration silently skipped for a `when` that sorts wrong.

## Live agent sessions at wrap-up

| Session | Model | Lane DB | State |
|---|---|---|---|
| `system32-85` | Opus 5 | `shareat_test_orch` | orchestrator — this session |
| `webapps-65` | Sonnet 5 | `shareat_test_lanea` | **idle.** T-311, the fingerprint measurement, the roadmap-backfill history, v1's staff-food data |
| `webapps-4e` | Sonnet 5 | `shareat_test_laneb` | **idle.** T-312, T-313, T-317 guard 1 + the extraction |
| `webapps-f7` | **Opus 5** | `shareat_test_lanef7` | **idle.** T-302, and the specs for T-314 and T-316. ⚠️ Never switched to Sonnet |

## The paste-ready prompt

<!-- Copy everything between the two rows of dashes. -->

-----------------------------------------------------------------------------------------------

You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 204-207,
and docs/DEFECTS-REGISTER.md section E (DEF-346 through DEF-359 are today's).

⭐ Row 207 is new and it is the one that changes how you read: GREP FINDS IDENTIFIERS, NOT
PREMISES. When a change merges or moves two things, the coupling that bites is a premise stated
in a comment — true of the old arrangement, false of the new. And a conclusion can be right while
its stated reason is wrong; the reason is what the next person builds on. Three instances on
2026-09-14, and the first would have shipped a silent break of the exact case its task existed
to serve.

⛔⛔ IAN'S FIRST: re-issue Lipa's PINs. Production has run migration 0148 since 08:55Z and every
pre-existing PIN is revoked. Ask him before doing anything else — it is the only outstanding
item with real staff behind it.

⛔ FIRST, BEFORE TRUSTING ANY PIPELINE: gh workflow list --all. Both were active and fired
automatically today, but CI sat disabled_manually for nine hours on 2026-09-13 and nothing
reported it (DEF-336). Deploy is workflow_run-gated on CI.

Production is healthy on 1a3405e and publishes its own commit at /api/health. Verify by comparing
all forty characters, never by seeing the field appear.

⭐ PICK UP T-317 GUARDS 2-6 (docs/tasks/317-document-facts-guards.md). Guard 1 shipped; the design
work for 2 and 3 is already in the spec, including that guard 2 needs a script-block exemption
because '1 day away' lives inside the countdown script DEF-350 added. THEN DEF-359: six
PROJECT_BIBLE.md §13 rows are malformed and repair is planner-only.

⛔ EDITING DOCS: the shell EXECUTES backticks and EATS backslashes — it bit four times on
2026-09-14. Write tool → plain file → a script that READS the file. Then: node
scripts/backtick-parity.mjs

⛔ A table's expected shape comes from its HEADER, never a neighbouring row. That is how DEF-359
was found, and it is why an insert script refused a correct row.

⛔ THE LANE RUNNER: node ~/.claude/skills/orchestrator/tools/it.mjs <lane_db> <files...>
Never npm run test:integration — it hits the shared DB. The full suite OOMs locally (DEF-245);
say "passed in CI", never bare "green".

ASK EACH LANE A QUESTION, NOT JUST FOR A CHANGE. On 2026-09-14 that produced every correction
that mattered, including two to numbers the orchestrator had reported to Ian as measured. Not one
came from building.

Next task T-318 · next defect DEF-360 · next migration 0152 (0149/0150 → T-314 F/G, 0151 → T-316).

-----------------------------------------------------------------------------------------------
