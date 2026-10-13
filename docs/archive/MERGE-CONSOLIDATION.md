# Merge consolidation — getting every agent's work onto one clean `main`

> **Reviewed 2026-08-29 by `ianla-e7`, read-only.** No tests were run and no branch was modified:
> three worktrees are live and `shareat_test` is shared, so running the integration suite during a
> review would have truncated another agent's fixtures mid-run (bible §3.4).
>
> Findings come from git topology, trial merges in a throwaway worktree, and reading each branch's
> diff. **Every conclusion below is checkable** — the command that produced it is named.

## 1. ⭐ The headline: no agent has broken another agent's code

Trial-merged each branch onto `main` (`git merge --no-commit --no-ff`, then aborted):

| Branch | Ahead | Behind | Trial merge | Conflicts |
|---|--:|--:|---|---|
| **`inventory`** | 6 | 0 | ✅ **CLEAN** | none |
| **`attendance`** | 19 | 9 | ⚠️ conflicts | `DEFECTS-REGISTER.md`, `_journal.json` |
| **`lane/t137-discount-logbook`** | 4 | 9 | ⚠️ conflicts | `DEFECTS-REGISTER.md`, `_journal.json`, `CAPABILITY-GAPS.md`, `capability-matrix.test.ts` |
| `phase-3-inventory-plan-and-fifo-core` | 1 | 4 | — | superseded, see §6 |

⭐ **Every conflict is in a shared append-only registry or a pinned count. Not one is in source
code.** Three agents built five schema modules, six migrations and ~40 files in parallel and did not
collide once on logic. The discipline that made that work — migration bands, both registries, pinned
guards — held.

⚠️ **The conflicts are mechanical but NOT trivial**, because two of them hide duplicate identifiers
that a text merge would resolve *silently and wrongly* (§2).

## 2. ⛔ BLOCKER — three branches claim the same defect IDs

`git diff main...<branch> -- docs/DEFECTS-REGISTER.md`, extracting added rows:

| ID | `main` (already merged) | `attendance` | `lane/t137` |
|---|---|---|---|
| **DEF-084** | T-135 shipped with no screen | — | ⛔ T-137's central claim was false |
| **DEF-085** | `plus.openingBudget` is dead | ⛔ Phase 0 gate never satisfied | ⛔ bible has two §5.3 |
| **DEF-086** | — | ⛔ `undertimeGraceMinutes` forgives nothing | ⛔ `runCapture` empty `missing` |
| DEF-087 | — | ✅ two stores on a bad config | — |
| DEF-088 | — | ✅ v1 pays for shifts nobody worked | — |

⛔ **A git merge will not detect this.** The rows are appended in different places in the table, so
both sides apply cleanly and the register ends up with **DEF-085 three times**. That is exactly
DEF-083 — the duplicate this project already had once — arriving three ways at once.

### ⭐ The cheapest allocation, chosen by counting code references

`git grep -l DEF-0XX <branch> -- ':!docs/DEFECTS-REGISTER.md'`:

- `attendance` **DEF-086/087/088** are cited in **source files** — `compute-day.ts`,
  `adjudicate.ts`, `capture-attendance-golden.ts`, the golden test.
- `attendance` **DEF-085** is cited in **docs only** (3 files).
- `lane/t137` **DEF-084** is cited in 2 source files; its **085 and 086 are cited nowhere**.

**So renumber the cheap ones and leave the expensive ones alone:**

| Agent | Change | Cost |
|---|---|---|
| **`attendance`** | `DEF-085` → **`DEF-089`**. Keep 086, 087, 088 | 3 doc references, **no code** |
| **`lane/t137`** | `DEF-084` → **`090`**, `085` → **`091`**, `086` → **`092`** | 2 source files (084 only) + `CAPABILITY-GAPS.md` |
| `main` | nothing | — |

⚠️ **Renumber on the branch, before merging.** Doing it after means editing a register that two
other merges are also touching.

## 3. ⛔ BLOCKER — two different tasks are both called T-153

- `main`: `docs/tasks/153-standing-till-float.md` (the till float — merged, cited by DEF-085)
- `attendance`: `docs/tasks/153-firestore-two-lane-spike.md` (the Phase 0 offline spike)

Different filenames, so **git merges both without complaint** and the project silently has two T-153s.

⭐ **Fix: `attendance` renumbers its spike to T-159.** That slot is free and adjacent — `main` stops
at 153, `attendance` uses 154–158, `inventory` starts at 160. Referenced in
`phase-4-attendance.md`, the doc itself, and `spike/firestore-two-lane/README.md`.

## 4. ⚠️ The pinned counts must land on the merged totals, not either side's

| Guard | `main` | branch | **After merge** |
|---|--:|--:|--:|
| Capability count (`capability-matrix.test.ts`) | 49 | `lane/t137` adds 2 (`record_statutory_discount`, `void_statutory_discount`) | **51** |
| Chart of accounts | 101 | untouched by all three | 101 |
| `CAPABILITY-GAPS.md` gap count | 35 | `lane/t137` adds rows | recount on merge |

⚠️ **A conflict resolution that takes "theirs" gives 50 and a green test that is wrong** — the count
would match the matrix doc while the code has 51. Resolve to the union, then re-run the guard.

## 5. ⛔ A finding on one branch invalidates text on `main`

`lane/t137`'s **DEF-084** is not just a branch-local note:

> *"T-137's central factual claim was false, and it reached the bible. The spec said the SC/PWD ID
> number is 'captured today'… **Verified at source: no SC/PWD identity is captured anywhere.**"*

It names **bible rows 131 and 132**, and the `sales_days.seniorDiscount` schema comment — all of
which are **on `main` right now**, all carrying the false claim.

⛔ **Merging `lane/t137` without correcting them leaves the bible asserting something its own
register says is false.** Per RULES rule 14 only the Opus planner amends the bible, so this is a
task for whoever holds that role — not a merge-time edit.

## 6. Branches that can simply be deleted

| Branch | Reason |
|---|---|
| `chore/local-env-pg18-port-5435` | Fully merged into `main` (`merge-base --is-ancestor` ✅) |
| `daily-review/2026-08-26` | Fully merged ✅ |
| `daily-review/2026-08-28` | Fully merged ✅ |
| `phase-3-inventory-plan-and-fifo-core` | ⭐ **Content-redundant.** Its one commit `b781b03` has the same content as `inventory`'s `48a32c1`; `inventory` additionally holds the FIFO core *and* T-160 applied. Diffing the two tips shows `inventory` ahead on every file and phase-3 unique on none |

## 7. ✅ What each branch is, and what I would NOT change

### `inventory` — merge first, nothing to fix

T-160 stock rooms applied (migration `0062`), the Phase 3 plan, ADR-011, 20 task specs, and the FIFO
core. Registered in both registries. Already merged `main` twice, so it is **0 behind** and trial-
merges clean.

⭐ Its `stock_model` column on `stores` sits beside T-152's `remittance_cadence` and uses the same
reasoning verbatim — *"NOT NULL with a default, so 'unset' cannot exist… the default is the STRICTER
of the two."* Consistent by conviction rather than by accident.

### `attendance` — the largest, and the strongest evidence

19 commits: positions/employments, the 05:00–05:00 shift day, effective-dated config, punches,
adjudication in integer minutes, adjustments, plus a golden master. Migrations deliberately banded
at **0070–0075** to stay clear of `main`, with a journal guard added for non-contiguous idx.

⭐ **DEF-088 is the most valuable finding in this review**, and it is about real money: *"v1 PAYS FOR
SHIFTS NOBODY WORKED — 40.4 excess hours in one month across two stores,"* measured over 550 real
sessions. `lipa-0319` present **1.6 minutes, paid 5 hours**. Not a code smell — a quantified payroll
leak, with the mechanism named (late-arrival crediting × hour-flooring, neither wrong alone).

⭐ **DEF-085 is a project-level finding Ian should read directly**: Phase 0 is marked complete
against an exit gate requiring an offline spike *"and the spike was never built"* — searched five
ways. They then built it (`spike/firestore-two-lane/`) and report the contract holds.

**Two things to confirm rather than fix:**

1. `tests/golden/fixtures/attendance-sessions.json` — **717 KB of real production timing data,
   committed**. ⭐ I checked it: **de-identified** — opaque ids (`lipa-0319`), no names, no staff
   identifiers, only timestamps/config/expected. So this is a **size** question, not a privacy one,
   and the corpus is what makes DEF-088 provable. My view: keep it.
2. `spike/firestore-two-lane/` carries its own `package.json`/`package-lock.json`. ✅ **No build
   risk** — root workspaces are `["packages/*","apps/erp"]`, which does not match `spike/`, and the
   package declares itself *"DISPOSABLE… deliberately NOT a workspace member."*

⚠️ It is **9 behind `main`** and has not merged since. It should merge `main` itself and resolve its
own two conflicts — the agent that wrote those DEF rows knows which is which.

### `lane/t137-discount-logbook` — sound, and it corrected its own spec first

Four commits: re-assessed T-137 and found the spec's premise false (§5), rewrote the spec, then
built `statutory_discount_records` with two capabilities and an ERP screen. Both registries updated.

⭐ **Starting by disproving its own spec is the behaviour this project asks for**, and it is why
DEF-084 exists at all.

## 8. Recommended order, and why

```
1. inventory      → clean, 0 behind, zero risk. Merge as-is.
2. attendance     → after renumbering DEF-085→089 and task 153→159.
3. lane/t137      → after renumbering DEF-084/085/086→090/091/092 and setting the count to 51.
```

**Why `attendance` before `lane/t137`:** attendance keeps 086–088, so its code references stay
valid and only docs change. If `lane/t137` merged first it would claim 086 and force attendance to
renumber three source files instead of three doc lines.

## 9. ⛔ Do not merge while the agents are still committing

At review time: `inventory` last committed **3 minutes** before, `attendance` **18 minutes** before.
Both worktrees are live.

⚠️ **A merge of a branch that is still moving is stale the moment it lands**, and the renumbering
above has to happen *on the branch* anyway. **Each agent should: renumber → merge `main` into their
branch → resolve their own registry conflicts → report green gates → stop.** Then this repo merges
three quiet branches in the order above, which is a mechanical job rather than a judgement one.

## 10. What still has no owner after all three merge

Not blockers — but the consolidated `main` will carry them, and none belongs to a branch in flight:

- **DEF-082** — nothing ever debits `2160`; the service-charge distribution is designed and unbuilt.
- **DEF-084** (main's) — T-135's watchdog: **seven of its ten findings still have no screen**, and
  four of those are `hard`, so they block a period close from a page that does not exist.
- **The shift record** — `CAPABILITY-GAPS`, 2026-08-29. T-153's *"opening and closing it is 20k"* and
  T-143's per-shift attribution both need it. ⭐ **`attendance` may already have solved this**: it
  builds `attendance_punches` and `attendance_days`. Worth one pass to check whether the cash-count
  shift and the attendance shift are the same object before either is built twice.
