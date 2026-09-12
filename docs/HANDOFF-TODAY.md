# Handoff — 2026-09-12 (wrap-up)

> ⚠️ **The integration suite went RED on its wrap-up run and it is NOT a regression** — all nine
> failures were one file’s `beforeEach` truncate timing out at 10s under load, and that file passes
> 9/9 alone (`DEF-313`). Read the Gates table before concluding anything from a red run.
>
> Written for a **COLD start**. It assumes you have never seen this project.
> Read `docs/RULES.md` first, then this file. `PROJECT_BIBLE.md` wins any disagreement.

## Where things stand

**Five tasks shipped today and production changed twice.** T-272 (the orphaned-file sweep, now a
nightly per-organisation job that records every run), T-274 (a fiscal year can be closed), and three
guard repairs — T-275, T-277, T-278. Nothing is half-built; both lanes stopped at task boundaries
with a clean tree.

⭐ **Production stopped bypassing its own tenancy fences.** It had connected as `doadmin` with
`rolbypassrls = t` for the life of the system, so every row-level-security policy this repo has
written and tested was bypassed on every production query. It now connects as `shareat_app_prod`
(NOSUPERUSER, NOBYPASSRLS, owns no table). ⛔ **Read `docs/ops/README.md`'s top section before
running a migration on that box** — the app role cannot run one, deliberately.

⭐ **And production was writing accounting documents into v1's bucket** (DEF-311). Corrected the same
day, with `stored_files` measured at **zero rows** first, so nothing had ever been written there.

⚠️ **Only one task is unfinished and it is unfinished on purpose:** T-276's spec is written and
**HELD, not approved** — it needs a ruling from Ian and would be a third timer to arm.

---

## Gates at `3b51450` — the last commit that changed CODE. Everything after it is documentation.

| Gate | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run test` (unit) | **99 files · 1368 passed · 1 skipped · 0 failed** (exit 0) |
| `npm run build` | **exit 0** — dev server stopped and port 9008 **verified free by process enumeration** first, not by intent |
| Smoketest on 9008 | `/sign-in` **200**, `/setup` **307**, `/` **307** — recipe **re-derived**, not trusted |
| Integration — **full suite** | ⚠️ **120 files · 2794 passed · 9 FAILED**, 1962s, orchestrator’s own DB — **all nine failures in ONE file** (`reports.test.ts`), all from a single `beforeEach` TRUNCATE hitting vitest’s 10s hook timeout |
| Integration — **that file, re-run alone** | ⭐ **9 passed · exit 0 · 55.34s.** No content regression. Filed as **DEF-313** |

⛔ **Never run `npm run test:integration`** — it hits the shared database and truncates a peer's
fixtures. Give every lane its own DB with
`~/.claude/skills/orchestrator/tools/make-test-dbs.mjs`, and run with `it.mjs <dbname>`. The full
suite above was run that way, on the orchestrator's own database.

---

## What happened this session

### The five tasks

| Task | Sha | What |
|---|---|---|
| T-272 + DEF-303 | `55fc4bd` | Orphan sweep nightly per org, migration `0144`; `budget_reissue` finally has units |
| T-274 | `8381413` | `closeYear` — ADR-006's year-close entry, plus the first ever write of `locked` |
| T-275 / DEF-304 | `e00549a` | The job-caller guard stops reading one hardcoded file |
| T-277 / DEF-308+307 | `c74eba5` | The storage-driver trap names its own cure; a guard catches the next one |
| T-278 / DEF-310 | `3b51450` | The auth door's guard sees ten source roots instead of three |

### ⛔ The findings worth more than the tasks

1. **DEF-308 — every gate was green and the new nightly job would have failed on all 17
   organisations.** `resolveStorageDriver` refuses the in-memory fallback when a bucket is
   configured, and the only thing installing the real driver is the Next.js boot hook, which a
   standalone script never runs. No earlier job touches storage. ⭐ **Found by running the script
   once**, at the orchestrator's insistence, after the lane had correctly reported it unverified.
2. **T-274's closing lines were built from RAW totals, not NET.** `debitTotal`/`creditTotal` are two
   independent sums, so any account with activity on both sides in a year (a refund, a reversal)
   produced a two-sided line the database rejects outright. Ten tests passed because every fixture
   was one-sided. ⭐ **The lane had already SEEN that failure** in a forced double-count test and read
   it as good news — the unpredicted part of a forced failure is evidence about the normal path.
3. **DEF-310 — the AUTH door's guard scanned 3 of 10 source roots**, while its own comment claimed
   it was "deliberately the SAME shape" as its twin, which had been widened that same morning.
   Someone fixed one guard and did not ask whether its stated twin had the same hole. ⭐ **Found by
   asking a lane whether any OTHER guard was blind**, after three had been found in one week.
4. **DEF-311 — production wrote to v1's bucket.** The repo documented the correct bucket in TWO
   places, one of them warning by name against the exact value deployed. ⛔ **Nothing compares the
   deployed configuration against the documented one**, and `npm run storage-smoke` cannot: it
   proves the bucket is REACHABLE, and v1's is reachable too.

### ⭐ The pattern, and it is now five deep

**DEF-295, DEF-296, DEF-304, DEF-309, DEF-310** — every one a guard whose **SCOPE was narrower than
its CLAIM**, passing happily while blind. DEF-311 is the same shape in configuration rather than in
a test. ⛔ **A positive control on the SIZE of a scanned set cannot catch this. Only a planted
violation can** — and the state people skip is the one that matters: *old guard + plant = GREEN*,
which is the only evidence the old guard was blind rather than that the new regex matches something.

### Decisions Ian made today, and where each is recorded

| Decision | Recorded in |
|---|---|
| Tighten production's `DATABASE_URL` to a non-bypassing role | `docs/ops/README.md` §2026-09-12 |
| `shareat-hub-v2` is v2's storage, sole; `…firebasestorage.app` is v1's | `docs/DEFECTS-REGISTER.md` DEF-311 |
| Close DEF-310 | register, DEF-310 |
| Scoping the orphan sweep per-org removes it from row 194's cross-org list | `PROJECT_BIBLE.md` §13 **row 197** |

### Corrections the orchestrator made to its own work — on the record

- **Committed bible row 197 without re-running the unit suite**, shipping a stale line-range TOC.
  `toc-freshness.test.ts` caught it on the next run. ⚠️ **A bible row means `npm run toc`, and then
  the suite again.**
- **Filed DEF-305 worse than it is.** A 60-day advance warning (`fiscalPeriodRunwayLow`,
  `repo/findings.ts:253`) already exists; nothing ACTS on it, so the gap is real, but it is not the
  silent outage the row first described. Amended the same day.
- **Predicted zero reporting queries filter on `source_type`; there are four.** The lane checked the
  premise instead of building to it and T-274 shrank.
- **Inferred a shared BUCKET from a shared PROJECT** in DEF-311's first filing. Wrong, and Ian said
  so. The narrower observation — three environments printing three different bucket names — was the
  part that held.

---

## Pick up here

**1. Ian has three decisions pending (below). Two of them gate real work.**

**2. T-276 — DEF-305, fiscal-period coverage.** The spec is written
(`docs/tasks/276-def-305-fiscal-period-coverage.md`) and **HELD**. It needs Ian's backfill ruling.
⛔ Do not build it on momentum; that is what the hold is for.

**3. DEF-302 — the period override is unreachable on three stock-moving flows.** Three dispositions,
recommendation **(b)** on the table. Ian's call because it is an inventory decision, not a ledger one.

**4. DEF-309 — a job that never calls `runJobForOrg` would run and leave no `scheduler_runs` row**,
and both job guards would pass it. ⚠️ Sequence it AFTER T-275 (done), and note the transitive case:
every real job calls through a private per-org helper, so a naive check is a false positive.

**5. DEF-312, DEF-306, DEF-307's second half** — all small, all deliberately deferred, each with its
trigger written into its own row.

---

## Do not decide these alone — they are Ian's

| Question | Recommendation on the table |
|---|---|
| **DEF-302** — the override unreachable on three flows | **(b) Make the refusal honest** — teach the stock trigger to recognise the override GUC and refuse anyway, with a message saying it does not extend to stock movements. Changes no behaviour, costs almost nothing |
| **T-276 / DEF-305** — a gap left by an outage of the seeding job itself | Three options in the spec: never backfill · silently backfill · **backfill and report the run as partial** (the lane's recommendation) |
| **The timers to ARM on the droplet** | **TWO** exist and are unarmed as of today — orphan sweep and budget reissue (DEF-194). T-276 would make it three. Arming is Ian's step either way |

---

## Traps that have actually bitten — live in this area right now

- ⛔ **A guard that proves a caller EXISTS is not a guard that proves the caller WORKS.** DEF-308:
  every gate green, job dead on arrival in production. **Run the thing once.**
- ⛔ **The state people skip in a plant proof is the only one that proves anything:** *old guard +
  plant = GREEN*. States 2–4 only prove your replacement works.
- ⛔ **A fix that turns a silent blind spot into a noisy wrong answer is worse than the blind spot** —
  T-275's widen would have failed two correctly-wired functions until the filter learned `orgId`.
- ⛔ **`debitTotal` and `creditTotal` are INDEPENDENT sums per account, not mutually exclusive.**
  Anything that swaps them onto one line breaks `journal_lines_exactly_one_side_check`.
- ⛔ **A bible row shifts every TOC line below it.** `npm run toc`, then re-run the unit suite.
- ⚠️ **Migrations on the production box now need the admin string explicitly** — the app role cannot
  run one. `docs/ops/README.md` carries the command.
- ⚠️ **In PowerShell, `VAR=1 cmd` does not set the variable.** Use `$env:VAR=1` as its own statement.
- ⚠️ **Re-derive a smoketest recipe before trusting it.** Yesterday's went stale in one day.

---

## Live agent sessions at wrap-up

| Session | Lane | Model | Lane DB | State |
|---|---|---|---|---|
| `webapps-4e` | A | Sonnet 5 | `shareat_test_lanea` | **SAFE TO CLEAR** — told so in its own terminal. Shipped T-272, T-275, T-277, T-278 |
| `webapps-65` | B | Sonnet 5 | `shareat_test_laneb` | **SAFE TO CLEAR** — told so in its own terminal. Shipped T-274, specced T-276 |
| `system32-85` | orchestrator | Opus 5 | `shareat_test_orch` | this session — clear it |

⭐ **Lane databases survive and are re-attachable by name.** Nothing is dropped at wrap-up.

---

## Numbers to allocate from

- Next task: **T-279** · Next defect: **DEF-313**
- Next migration: **`0145`**, `when` must exceed **`1798515107084`**

---

## The paste-ready prompt

```
You are the orchestrator for shareat-system (C:\Users\ianla\webapps\shareat-system). Run the
global /orchestrator skill. You are starting COLD — assume you know nothing about this project.

Read in this order: docs/RULES.md, docs/HANDOFF-TODAY.md, PROJECT_BIBLE.md §13 rows 193-197,
docs/DEFECTS-REGISTER.md section E (DEF-302 through DEF-312 are the live ones).

Five tasks shipped 2026-09-12 — T-272, T-274, T-275, T-277, T-278. Do not reopen them.
Production now connects as a NON-BYPASSING database role and writes to the correct storage
bucket; ⛔ read docs/ops/README.md's top section before running any migration on that host.

⛔ Ian has THREE decisions pending and two of them gate work: DEF-302 (three dispositions,
recommendation (b) on the table), T-276/DEF-305 (spec written and HELD — needs his backfill
ruling), and arming TWO unarmed timers on the droplet. Put them to him in plain language,
one at a time, and do not build T-276 on momentum.

No worker sessions are alive — spin up fresh lanes and brief them. Lane DBs shareat_test_lanea
and shareat_test_laneb still exist and are re-attachable by name.

Migration slot 0145 is free; `when` must exceed 1798515107084. Next task T-279, next defect
DEF-313.

⭐ Ask each lane a QUESTION in its briefing, not only for a change. EIGHT defects were filed on
2026-09-12 and not one came from a test — three came from lanes answering a briefing question,
two from running something once, one from a lane checking its own guard before writing it.
```
