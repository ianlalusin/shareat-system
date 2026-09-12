# Handoff — 2026-09-12 (evening wrap-up, FIVE sessions)

> ⛔⛔ **PRODUCTION HAS ONE ORGANISATION, NOT ZERO — AND THE NIGHTLY ORPHAN SWEEP IS ARMED AND
> CANNOT RUN.** Measured on the host 2026-09-12 15:57 UTC, after Ian installed and armed the
> units by hand. `/var/log/shareat/orphan-file-sweep.log` reads
> **`npm error Missing script: "orphan-file-sweep"`** — the deployed build predates `55fc4bd`,
> the commit that added that script. And `/var/log/shareat/budget-reissue.log` reads
> **`budget-reissue: ok — created 0 · 1 orgs`**, naming **SHAREAT OPC**. **Filed as DEF-326.**
>
> ⛔ **NINE FILES IN `docs/` ASSERT ZERO ORGANISATIONS AND EVERY ONE IS NOW SUSPECT**, including
> `docs/ops/README.md`, this file, `docs/ROADMAP.html`, and **`docs/tasks/294-*.md`, whose
> "do not build" assessment rests on it.** ⚠️ **Re-derive them; do not patch the number.** T-294's
> conclusion may survive — the risky loop still cannot execute because the sweep cannot start —
> but it has to be re-argued on the real figure.
>
> ⚠️ **Deploys auto-fire on green CI (`deploy.yml` triggers on `workflow_run` of CI on `main`), and
> `ci.yml:80` runs the integration suite — so DEF-325 may be blocking every deploy. ⛔ But that
> cannot explain a script missing since this morning, because DEF-325 only appeared tonight.**
> Read `gh run list --workflow=CI --branch=main` and `gh run list --workflow=Deploy` before
> adopting either hypothesis.
>
> ✅ **What does NOT change:** DEF-311's storage-bucket finding was settled by a measured
> `stored_files` count of **zero rows**, not by an organisation count. That was a measurement and
> it stands. ⚠️ **What does change:** `rolbypassrls` was live in production *while an organisation
> existed*. It failed closed and was never a leak, but *"no second set of books to reach into"* is
> no longer the reassurance it was.
>
> ⛔ **THE INTEGRATION SUITE IS RED BY ONE TEST, AND IT IS NOT A REGRESSION.**
> **1 failed / 2834 passed across 122 files, 1828s.** The single failure is
> `packages/domain/tests/integration/position-defaults.test.ts:537` (T-289 case 13) —
> `Test timed out in 30000ms`. **That file passes 19/19 in 20.56s run alone**, verified on the
> same database minutes later. It creates a scratch database and runs all 146 migrations from
> zero, which legitimately exceeds a 30s budget while 121 other files work the same Postgres
> instance. **Filed as DEF-325; fixing it is item 1.** ⭐ **Zero `Hook timed out` in the whole
> run** — T-285's fix held, and DEF-313 did not recur once.
>
> ⚠️ **AND READ THIS BEFORE TRUSTING ANY GATE IN THIS FILE:** that run was launched as
> `node it.mjs …; echo "EXIT=$?"`, so **the harness reported exit 0 — the echo's status, not
> vitest's.** The failure was found by reading the log, not the exit code. **Never end a
> background gate command with `echo`;** it launders a non-zero exit into a zero one.
>
> Written for a **COLD start**. It assumes you have never seen this project.
> Read `docs/RULES.md` first, then this file. `PROJECT_BIBLE.md` wins any disagreement.
>
> ⚠️ **This was a five-session day on one working tree.** Every collision was on a *number*,
> never on a file. If you are one of several sessions, read §"Working a shared tree" before
> touching anything.

## Where things stand

**Fourteen tasks built, two assessments that correctly concluded *don't build it*, and one spec
written and held.** Sixteen commits from the orchestrator plus five from the two Fable sessions.
Nothing is half-built; every session reported final state and released.

⭐ **Ian's own three bug reports were all real and all bigger than they looked.**

| He said | It was |
|---|---|
| *"invoice not saving when an image is uploaded"* | **Every upload over 1 MB died, silently** — no error, no console message. DEF-317 / T-282, then T-296 |
| *"shareat lipa needs more than 1 storage room, i can not edit the store"* | The field had existed since migration `0062` with **no writer in any layer**. DEF-316 / T-284 |
| *"i can access many restricted pages and actions for staff"* | Pages yes, **actions no — he corrected this himself**. Exposure, not escalation. T-288 / bible row 199 |

## Gates at `HEAD`

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test` (unit) | **109 files · 1464 passed · 1 skipped · 0 failed** (exit code checked, not inferred from `tail`) |
| `npm run build` | **exit 0**, port 9008 enumerated free by process list first |
| `npm run toc` + `toc-freshness` | regenerated after bible rows 199 and 200; **4/4** |
| Integration — full suite | ⛔ **1 failed / 2834 passed across 122 files, 1828s** on `shareat_test_orch` via `it.mjs`. The one failure is DEF-325, a from-zero migration test exceeding `testTimeout` under suite load; it passes 19/19 in 20.56s alone. ⭐ **Zero `Hook timed out` across the entire run** — T-285 held |
| Smoketests in the browser | T-288 (manager + staff, nav **and** typed-URL refusal), T-290 (28 assertions), T-296 (four checks incl. the no-JS path) |

⛔ **Never run `npm run test:integration`** — it hits the shared database. Give every lane its own
with `~/.claude/skills/orchestrator/tools/make-test-dbs.mjs` and run via `it.mjs <dbname>`.

## ⛔ What needs Ian — five things, all small, none blocking

| # | What | Why only he can |
|---|---|---|
| 1 | **Arm two timers on the droplet.** Commands in `docs/ops/README.md`. ⚠️ **Expect THREE units to fail nightly, not one** — these jobs treat "no organisations" as failure by design and production has none. Correct, not broken | Production host |
| 2 | **`ssh root@159.223.46.224 'grep APP_TIMEZONE /srv/shareat-shared/.env.local'`** ⛔ **Before T-292 deploys.** That check now THROWS at env load, so a value that disagrees with `Asia/Manila` stops the app booting. Absent key is safe (defaults); present-and-different is an outage. **DEF-288's shape** | Production host |
| 3 | **Caddy `request_body max_size`** on the same host — a second body limit that reproduces DEF-317 in production with an identical silent symptom. Untested | Production host |
| 4 | **Photograph a real receipt and check the small print is readable** after compression. T-296's synthetic fixture cannot settle it: 28px text at 4000px becomes 14px at 2000px, and real receipt text is usually larger | Human judgement |
| 5 | **Two business questions from T-288** — see `docs/tasks/288-*.md`, addressed to him | Business decision |

### The two T-288 questions, stated plainly

⛔ **`/statutory-discounts` is readable by every signed-in person, and it holds customers' names
and government ID numbers.** `statutory_discount_records` carries `holder_name` and `id_number`,
read off a physical senior-citizen or PWD card. It is the only place T-288's map leaves *customer*
personal data open to a cashier on the shared counter tablet — the exact population the task was
written for. ⚠️ **It is a question, not a defect:** a cashier *records* SC/PWD discounts and holds
`record_statutory_discount`, so they must touch that data. **But recording one discount is not
browsing the store's whole register.** Recommendation in the task doc: gate the register on
`view_financial_reports`, leave the recording flow alone.

⚠️ **And a quieter one: `view_financial_reports` was chosen as the gate for `/owners`, `/loans`,
`/liabilities`, `/money-accounts`, `/money-transfers` and `/prepaid` because it is the capability
that happens to separate staff from manager** — not because anyone decided a manager should see
owner drawings. It works, it is defensible, **nobody ruled on it.** A business question wearing a
technical answer.

⚠️ **A third, smaller:** two rows in `stored_files` still exceed 1 MB — both from the DEF-317
smoketest, hours before T-296 existed. *"No stored photo exceeds 1 MB"* is true **going forward**.
Cleaning history is a separate decision and is not assumed.

## Decisions Ian made today, and where each lives

| Decision | Recorded in |
|---|---|
| DEF-302 → **(b)** make the stock-period refusal honest | register DEF-302 · T-281 · `d83e295` |
| T-276/DEF-305 → **(c)** backfill a gap and report the run `partial` | `docs/tasks/276-*.md` header |
| **Arm both unarmed timers now**, accepting nightly failures | `docs/ops/README.md` §2026-09-12 |
| DEF-314 → **build the override screen; it was always meant to exist** | register DEF-314 — ⚠️ **needs a task number; not yet specced** |
| *"do both hide the menu and gate the reads"* | **bible row 199** |
| Position access defaults: additive, materialised grant rows | **bible row 198** |
| *"only admin can add or retire a position"* | `docs/tasks/297-*.md` (spec, NOT built) |
| *"Fix 6, 4, 3 now; spec 1, 2, 5"* — the six-item sequencing | T-282/283/284 built; T-286/287/288 spec'd |
| Compression: **dimensions not quality**, 1280px floor that refuses | T-296 · `cb24455` |
| *"1 expound in laymans term"* — twice, unprompted | **bible row 200** |

⚠️ **Two of his instructions were deliberately NOT recorded as project rules** — *"use most 5
sonnet agents to do discovery"* and *"use opus and sonnet agents to write codes"*. They are
session process preferences, not standing rules. Noted here so the omission is visible.

## ⭐ The pattern of the day — six things built, tested, green, and unreachable

**DEF-299** a nightly job with nothing to run it · **DEF-260** `activateTerminal`, no production
caller · **DEF-314** a capability ratified in two bible rows with no caller anywhere ·
**DEF-316** `stores.stock_model`, no writer since it was created · **DEF-320** four declared
upload purposes nothing passes · **DEF-321** the census that detects this, itself unwired.

⛔ **Six in one day is not six coincidences, and every one was found by a person reading — never
by a gate.** T-293 assessed whether one guard could catch them: **it cannot.** They are four
different shapes (function / DB column / map member / optional property) with different
false-positive classes. **Shape A is now guarded (T-295's ratchet). B, C and D are three separate
unbudgeted builds and must not be bundled.**

## ⭐ Three register rows were corrected by the lanes sent to build them

- **DEF-309's own remedy was defective in exactly the way DEF-309 is about** — a whole-file check
  a ninth job would have passed on its siblings' calls. Caught before a line was written.
- **DEF-315 overstated two of four items.** `APP_TIMEZONE` is read by **nothing**; the documented
  consequence is false against the code. `FIREBASE_PROJECT_ID` never coexists with its twin in one
  process, so no in-repo check closes that risk.
- **DEF-307's piece 1 was already done** hours earlier by T-277 and never ticked off.

⛔ **A row's REMEDY is as perishable as its DIAGNOSIS. Re-derive both before acting on either.**
Four dispositions have now turned out wrong: DEF-279, DEF-301, DEF-309, DEF-307.

## Working a shared tree — what five sessions taught, the hard way

1. ⛔ **"Same file" is not the collision question. "What does that file import, and who brings
   it" is the other half.** Three sessions agreed a landing order that would have broken the
   build, because one file imported new code from *both* tasks. Only one session checked.
   **Split on the FILE boundary, not the task boundary** — land the shared file last, after both
   halves of its dependencies are on main.
2. ⛔ **A green unit run is not evidence typecheck is green.** Vitest does not typecheck. Both
   were true simultaneously today, tests green and `tsc` red on a test importing a missing module.
3. ⛔ **A gate reading is true for minutes, not for a message.** Four stale-photograph incidents,
   a different session each time.
4. ⛔ **Reviewing a diff by filtering for your own identifier cannot detect a collision on that
   identifier, by construction** — the collision *is* both parties using the same string. A
   session lost an uncommitted register row this way while reviewing carefully. DEF-264 repeating.
5. ⛔ **Numbers must be allocated centrally.** Three collisions today, all on numbers, none on
   files. Every session declared its file scope and honoured it.
6. ⚠️ **Separate lane databases are not a separate server.** Six databases on one Postgres
   instance share buffers, WAL and CPU. DEF-313's timeouts and two `CONNECT_TIMEOUT` page stalls
   both came from that.
7. ⚠️ **"Needs a browser" and "needs the dev server" are different requirements.** A session was
   queued behind a port for canvas tests that never touched the app.

## Traps that have actually bitten — live in this area right now

- ⛔ **Editing `docs/DEFECTS-REGISTER.md` by string surgery breaks it three different ways.** Shell
  backticks get interpreted; a missing newline merges two rows; an anchor on a distant landmark
  lands in the wrong table. **Ten rows spent part of today inside the "Open questions" table.**
  Put the row text in a plain FILE and insert with a checked script anchored on the table's own
  last row.
- ⛔ **A bible row shifts every TOC line below it.** `npm run toc`, then re-run the unit suite.
- ⛔ **A seed fixture's name can lie.** `Dev Cashier` / PIN `333333` held **`manager`** for seven
  days while the sign-in page advertised it as a cashier. It briefly made correct access filtering
  look broken. DEF-323 — instance fixed, class open.
- ⛔ **A duplicate-key error in an integration test is not self-evidently a real defect** — check
  whether a `beforeEach` truncate above it timed out first.
- ⚠️ **In PowerShell, `VAR=1 cmd` does not set the variable.** Use `$env:VAR=1` as its own statement.
- ⚠️ **Re-derive a smoketest recipe before trusting it.** Two sessions were bitten in two days.

## Live agent sessions at wrap-up

| Session | Model | Lane DB | State |
|---|---|---|---|
| `system32-85` | Opus 5 | `shareat_test_orch` | orchestrator — this session |
| `webapps-4e` | Sonnet 5 | `shareat_test_lanea` | **released.** T-281, T-285, T-293, T-295 |
| `webapps-65` | Sonnet 5 | `shareat_test_laneb` | **released.** T-279, T-280, T-292, T-294 |
| `webapps-f7` | Fable | `shareat_test_lanef7` | **released.** T-282/283/284, T-286/287/288, T-296 |
| `webapps-f2` | Fable | `shareat_test_lanec` | **released.** T-289/290/291, DEF-324, T-297 spec |

⭐ **All lane databases survive and are re-attachable by name.** Nothing is dropped at wrap-up.

## Numbers to allocate from

- Next task: **T-298** · Next defect: **DEF-325**
- Next migration: **`0147`** (0146 shipped with T-289) · `when` must exceed **`1798687907084`**
- ⚠️ **T-276 moves to `0147`**; it was earmarked for 0146 before T-289 took it

## Pick up here

1. ⛔ **DEF-325 — the one red test.** Give that from-zero migration test its own timeout, measured under load, and do NOT weaken the test or raise the project default.
2. **Ian's five items above.** Two are one-line SSH commands; one is photographing a receipt.
2. **DEF-314's screen — Ian ruled it gets built and it has no task number yet.** It writes an
   audit row with a typed reason, so it needs real design: who sees the control, how the reason is
   chosen, what the person is told before using it. ⛔ Not a drive-by inside another task.
3. **T-297** — positions admin-only on the staff screen. Spec written and approved-shaped, not
   built. Gate chosen is `manage_stores`; ⚠️ bible row 196 means that reaches an elevated manager
   in an org with no administrator, which is intended — stop and ask if Ian wants it excluded.
4. **T-276/DEF-305** — the fiscal-period top-up job. Ian ruled **(c)**. Needs migration `0147`.
5. **DEF-322** — three sessions added three sub-24px controls today. The fix is a default-correct
   component, ⚠️ **but count how many of the 151 accepted FAILs it would fix first** — if most,
   this is the baseline-shrinking task under another name.
6. **DEF-323's class** — the sign-in page's hand-written role labels can disagree with the
   database silently. Derive them or delete them.

## The paste-ready prompt

```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD — assume you know nothing about this project.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 193-200,
docs/DEFECTS-REGISTER.md section E (DEF-302 through DEF-324 are the live ones).

Sixteen tasks shipped 2026-09-12 across five sessions — do not reopen them. Ian has FIVE small
items waiting, three of them one-line commands on the production host, one of them photographing
a receipt. Put them to him in plain language: ⛔ bible row 200 is his own standing instruction
that a decision is put in HIS language, not the repo's — an accurate explanation he cannot act on
is a failed explanation.

⛔ SIX things were found built, tested, green and UNREACHABLE in one day (DEF-299, 260, 314, 316,
320, 321). Every one was found by a person reading, never by a gate. T-293 assessed whether one
guard could catch them: it cannot — four shapes, and only shape A is now guarded by T-295's
ratchet. Do not bundle the other three.

⛔ FOUR register dispositions have turned out wrong (DEF-279, 301, 309, 307). A row's REMEDY is as
perishable as its DIAGNOSIS. Re-derive both before acting on either.

⛔ If you run more than one worker: numbers are allocated centrally (three collisions today, none
on files), and "same file" is not the collision question — "what does that file import, and who
brings it" is. Read §"Working a shared tree".

Next task T-298, next defect DEF-325, next migration 0147 (`when` > 1798687907084).

⭐ Ask each lane a QUESTION in its briefing, not only for a change. Three register rows were
corrected today by the very lanes sent to build them, every time by checking the premise instead
of building to it — and the orchestrator's own instruction was disproved by measurement twice.
```
