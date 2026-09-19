# T-329 — clean up what other sessions left behind, and say plainly that the app itself was already tidy

**Status:** SPEC — drafted by the orchestrator (`system32-df`), 2026-09-20, at Ian's request
("cleanup works left by other sessions so the app is more tidy… make this a side task").
**Closes:** nothing. This is hygiene, not a defect fix.
**Migration slot:** ⛔ **NONE.** A cleanup task that needs a migration is not a cleanup task.
**Runs:** ⛔ **AFTER T-327 commits.** Not alongside it — see *Why this waits*.

---

## ⭐ The headline finding, and it is the opposite of what was asked for

**The application is already clean. The mess is in the environment around it.**

Measured 2026-09-20 before writing a line of this spec:

| Measure | Result |
|---|---|
| Tracked `.png`/`.jpg`/`.gif`/`.log`/`.tmp`/`.bak`/`.orig` files in the repo | **0** |
| Uncommitted files that are not a live lane's or deliberately reserved | **0** |
| Git stashes | **0** |
| Dead (zero-caller) exports in the last 30 commits | **0** |

⛔ **So "tidy the app" has almost no work in it, and saying so is the honest answer rather than
finding something to delete in order to look busy.** What there *is* to clean is real, but it is
databases, a tools directory and five unnecessary `export` keywords — not application code.

⚠️ **This matters beyond this task.** A cleanup task that goes looking for justification is how a
capability someone uses gets removed. Bible §1.2 is explicit: removing a redundant *implementation*
is Claude's call; removing a *capability someone uses* is Ian's. Tiers C, D and E below are named
precisely so they are NOT swept up by a lane with momentum.

---

## Why this waits for T-327

Tier B touches `packages/domain/src/shared/money-positivity-census.ts`. **T-327's spec freezes that
module's existing behaviour** ("T-325 shipped that census three commits ago and its existing
behaviour is frozen"). Un-exporting an internal is not a behaviour change, but editing a frozen file
while a lane is mid-slice against it is the collision this structure exists to prevent.
⛔ **Nothing in this task starts until T-327 is committed.**

---

## Tier A — 20 stale lane databases, ~450 MB. ⭐ ORCHESTRATOR ONLY, and safe.

**Measured:** 22 databases matching `shareat_test%` besides the shared `shareat_test`, totalling
**491 MB**.

```sql
select count(*), pg_size_pretty(sum(pg_database_size(datname)))
  from pg_database where datname like 'shareat_test%' and datname <> 'shareat_test';
```

**⛔ KEEP — do not drop these three:**

| Database | Why |
|---|---|
| `shareat_test` | the shared one. Not a lane DB. |
| `shareat_test_t327_builder` | ⛔ **LIVE.** T-327's builder lane. |
| `shareat_test_t327_tester` | ⛔ **LIVE.** T-327's tester lane, deliberately held at `0154`. |

**✅ DROP — 20, all from completed or abandoned work:**
`def219` · `lanea` · `lanea2` · `laneb` · `lanec` · `lanef7` · `migrole` · `orch` · `orch2` ·
`orch3` · `qa` · `t216b` · `t229` · `t240` · `t324_builder` · `t324_tester` · `t325_builder` ·
`t325_tester` · `t326_builder` · `t326_tester`

⭐ **Safe because they are reproducible, not because they are unimportant.**
`~/.claude/skills/orchestrator/tools/make-test-dbs.mjs` recreates and migrates any of them in about
two seconds. Nothing in the repository reads them; each one exists only so two lanes could not
truncate each other's fixtures.

⛔ **The one thing that would make this unsafe:** dropping a database a live lane is mid-run against.
**Re-derive the keep-list at execution time from the lanes actually running then** — do not trust the
list above, which is true on 2026-09-20 and has a shelf life measured in hours (bible row 208, and
the reason a line number is a claim with a shelf life).

---

## Tier B — 5 needlessly-exported internals. ✅ Safe, no behaviour change.

`node callers.mjs --range HEAD~30..HEAD` reports, all in
`packages/domain/src/shared/money-positivity-census.ts` (T-325):

| Symbol | Status |
|---|---|
| `stripComments` | `internal` — used only inside its own file |
| `CensusSite` (interface) | `internal` |
| `extractComparison` | `internal` |
| `normaliseComparison` | `internal` |
| `censusKey` | `internal` |

⭐ **`scanMoneyPositivitySites` in the same file is REACHED** (`scripts/money-positivity-census.ts`)
and stays exported. Only these five lose the keyword.

**The change is deleting the word `export`, five times. Nothing is renamed, moved or deleted.**
⚠️ If removing `export` breaks a test, that means something imports it and `callers.mjs` was wrong
about the symbol — **that is BLOCKED, not a licence to re-export it and move on.**

---

## ⛔ Tier C — NOT A LANE'S TO DELETE. Ian's call.

`~/.claude/skills/orchestrator/tools/` holds **79 `.png` files** and **17 `smoke-*.mjs`** scripts,
**5.4 MB**, left by sessions going back to T-232.

⛔ **These are outside the repository** — they are in the global skill directory, shared with every
other project on this machine. **They are also evidence:** the screenshots are what past §9.4 screen
passes actually produced, and several are the only surviving proof that a screen once rendered.

⚠️ **Recommendation, which is not the same as permission:** keep the `smoke-*.mjs` (they are worked
examples of driving this app, and the next screen test will crib from one), and ask Ian whether the
79 screenshots should be deleted, archived, or left. **Deleting another session's evidence to save
5 MB is a bad trade** unless Ian says otherwise.

---

## ⛔ Tier D — DO NOT DELETE. It is not stale.

The branch `daily-review/2026-09-17` looks abandoned and **is not**:

```
git log --oneline main..daily-review/2026-09-17
  e0d637c daily review 2026-09-17: review docs + register
```

**One commit, unmerged.** It is the same date as the two deliberately-uncommitted files
(`docs/reviews/NEXT-PROMPT.md`, `docs/reviews/2026-09-17.md`) and is almost certainly the same
session's work. ⛔ **Deleting the branch loses that commit.** It is bound up with Ian's open decision
about the uncommitted `NEXT-PROMPT.md` edit (handoff §6 item 5) and is **his to resolve, not a
cleanup lane's.**

---

## ⛔ Tier E — 29 files in `scripts/`. ASK, NEVER DELETE.

`scripts/` holds 29 entries, some of which are plainly one-offs from finished tasks.
⛔ **Not enumerated here and not scoped into this task**, deliberately. Bible §1.2: *if a feature
looks pointless, ASK — never delete.* Several of these are invoked by **systemd units on the
production host**, which the repository cannot see: DEF-326 shipped a timer whose entry point was
missing from the deployed artifact, and nothing in-repo caught it. **A script with no in-repo caller
is not evidence that nothing calls it.**

⭐ **If anyone wants this tier done properly it is its own task**, and its first step is reading
`docs/ops/` and the installed unit files on `159.223.46.224` — not grepping for callers.

---

## Scope — by role, if this is run as a lane

**BUILDER — source only:**
- `packages/domain/src/shared/money-positivity-census.ts` — Tier B, five `export` keywords.

**TESTER — tests only:** ⛔ **None required.** Tier B is covered by the existing suite: if the five
symbols really are internal, every current test stays green untouched, and that is the assertion.
⚠️ **Do not write a test that asserts a symbol is not exported.** It would pass trivially, it tests
the language rather than the code, and it is the "assertion that cannot fail" shape this repo has
shipped three times.

**ORCHESTRATOR — Tier A**, because databases are shared state and no lane owns them.

**AUDITOR — read-only**, `/code-review` on the Tier B diff as for any slice. ⭐ Small is not an
exemption; "we'll skip the audit on this one, it's small" is a listed red flag.

---

## Invariants

1. ⛔ **Nothing in `docs/reviews/` is touched.** Both files there belong to an exited session and are
   Ian's to resolve.
2. ⛔ **No capability is removed.** Tier B removes a keyword, not a function.
3. ⛔ **No live lane's database is dropped**, and the keep-list is re-derived at execution time.
4. **Every existing test stays green, untouched.** If one must change, this task is wrong.

## Done when

Tier A executed and the reclaimed size stated · Tier B committed with the gates green
(typecheck · unit · integration · build) · Tiers C, D and E reported to Ian **as decisions, not as
work done** · and the headline finding said plainly in the report: **the app was already tidy.**

## Out of scope

⛔ Tier E. ⛔ Anything in `docs/reviews/`. ⛔ The `daily-review/2026-09-17` branch.
⛔ Deleting any `scripts/` entry. ⛔ T-328 and every open defect — this task fixes no defect.
