# 27 — The coverage-claims sweep: does our prose describe the code?

> Read-only audit, 2026-09-05 (ianla-25). **Commissioned by Ian** after five defects filed in one
> day shared a shape: *prose asserting a guarantee with nothing executable behind it.* The framing
> is `ianla-15`'s — **"claims of coverage that name no test."**
>
> ⭐ **The headline is not what we expected.** The project is markedly *better* at this than five
> defects in a day suggested. The real rot is a different, narrower class we had not named:
> **the expired deferral.**

## The five that prompted it

| Defect | The claim | What was actually true |
|---|---|---|
| DEF-172 | A defect row named `reimbursablePayableOf` for a site | The site is in a private helper `storePositions`; the named function has no such code |
| DEF-175 | A schema comment gave `value`'s basis as the transfer rate | It is written at cost — the opposite |
| DEF-176 | The phase-6 plan said a detector was delivered by T-213 | T-213 shipped eight detectors, not that one |
| DEF-180 | An ADR decided store-scope materialisation | Never written into the function it described |
| DEF-182 | A comment said an authority chain was *"enforced by the CALLER via `authorize()`"* | `authorize()` cannot express that chain |

## Method — four passes, each mechanical, each falsifiable

Only claims a machine can check were in scope. A comment asserting a *semantic* property (a unit, a
basis — DEF-175's class) is not mechanically checkable and is **explicitly out of scope**; §5 says
what would be needed.

| # | Pass | Corpus | Result |
|---|---|---|---|
| 1 | Every DB object named in a comment (`*_trg`, `*_check`, `*_key`, `*_idx`, `*_fk`, `*_policy`) must exist | 39 names across `packages/`, `apps/` | ✅ **38/39 present.** The one miss, `set_cash_policy`, is a false positive — a function name caught by the `_policy` suffix |
| 2 | Every symbol promised in a phase plan must exist in code | 123 backticked identifiers in `docs/plans/*.md` | 30 absent, **28 of them legitimate** — v1 Firestore field names the plans quote while *describing* v1 (`avgBasket`, `dashPresets`, `oilDays`, `sssNumber`…). 2 real, both in pass 4 |
| 3 | Tasks marked `t-done` on the roadmap vs. unchecked `- [ ]` boxes in their own docs | 82 done tasks | 43 tasks carry ~220 unchecked boxes. ⚠️ **Weak signal, deliberately not pursued as such** — agents do not tick boxes, and T-218's own three unchecked lines were work another session performed. Unchecked ≠ undone |
| 4 | Unchecked boxes that name a **checkable symbol**, verified against code | 79 claims | **11 absent → 7 real** after removing 4 hits on `shareat_test_b`, a database name |

⭐ **Pass 3 → pass 4 is the method's whole point.** "43 tasks have unchecked boxes" is noise that
would waste a reader's day. "7 named things do not exist" is a list you can act on.

## What the seven turned out to be

| Symbol | Task | Verdict |
|---|---|---|
| `stockLedgerDoesNotMatchBalance` | T-161 | ✅ **Honest.** Declined in writing with a reason that still holds — it compares the ledger to a cache, and §2 refuses to build a cache before a measured need. *"Registering a detector that cannot fail is T-134's own vacuous-pass lesson."* |
| `receipt.provisional`, `production.conversion` | T-163, T-176 | ⚠️ `POSTING-PATTERNS.md` entries, declared not-built with a stated reason (pinning a shape before the documents exist makes the doc wrong rather than late) |
| `grniNotAtRest` | T-163 | ⛔ **Expired deferral** |
| `commissaryDiscrepancyOpen` | T-174 | ⛔ **Expired deferral** |
| `autoOrderFailed` | T-175 | ⛔ **Expired deferral** |
| `commissaryUnitMismatch` | T-173 | ⛔ **Silently dropped, and it is live exposure** — DEF-184 |

## ⭐ The real finding: the expired deferral

Every one of these was deferred **honestly**, in writing, with a stated blocker. The task docs are
not the problem — they are unusually candid, and several contain self-corrections. The problem is
that **a deferral records its blocker and nothing ever re-checks it.**

| Detector | Stated blocker | Status of that blocker today |
|---|---|---|
| `grniNotAtRest` | *"there is no receipt document yet to age"* | ⛔ **Expired** — T-166 shipped delivery documents |
| `commissaryDiscrepancyOpen` | *"no caller yet, so their ✗ cannot be tested"* | ⛔ **Expired** — `apps/erp/src/app/commissary/discrepancies` exists |
| `autoOrderFailed` | the low-stock UI was unbuilt | ⛔ **Expired** — `apps/erp/src/app/inventory/low-stock` exists |
| `receivingDisputeOverdue` (DEF-176) | *(none — attributed to a task that never built it)* | Built 2026-09-05 by T-218 |

> ⭐ **A deferral is a promise with a precondition, and nothing in this project watches preconditions.**
> The task that removes the blocker has no idea it unblocked anything: T-166 did not know it owed
> T-163 a detector. So the deferral is correct on the day it is written and quietly false forever
> after — and because the reasoning reads so well, a later reader agrees with it and moves on.
>
> This is the same disease as the five that prompted the sweep, one level up: not a claim about what
> the code does, but a claim about **why it is acceptable that the code does not**.

⚠️ **The 15-day-dispute case is the proof it costs something.** v1's comment argued no receiving
backstop was needed because *"disputes get resolved."* True when written; **44% false by the time
anyone looked** (4 of 9 past 15 days). Same structure, and the only reason it surfaced is that
someone re-counted.

## What is NOT wrong, and deserves saying

⭐ **Three of the four passes came back clean, and the cleanliness is load-bearing evidence.**

1. **Named database objects are honest** — 38/39. When this codebase says *"enforced by
   `stock_movements_check_not_frozen_trg`"*, that trigger exists.
2. **Plans quoting v1 are not making v2 promises.** 28 of 30 "missing" symbols were v1 field names
   in descriptive passages. A naive sweep reports 30 defects; 28 would be wrong.
3. **`docs/PENDING-VERIFICATION.md` worked exactly as intended.** Written 2026-08-29 by the session
   that could not get port 9008, it names its own unbuilt screens, **corrects an earlier
   overstatement by that same session** (*"I described the screens for five finished tasks as
   blocked. That was wrong"*), and was closed by DEF-135 on 2026-09-03 — which found **four engine
   bugs** in the process. The handoff mechanism is not broken.

⛔ **So the correct conclusion is not "the project over-claims."** It is that a specific, narrow
mechanism — the conditional deferral — has no owner, while everything around it does.

## Recommendations

1. ⭐ **File the four expired deferrals.** DEF-184 (below) for the live one; the other three are a
   single small task — three detectors whose blockers are gone, all in `findings.ts`, all now
   cheap. ⚠️ Not started here: this was a read-only pass.
2. ⭐ **Make a deferral machine-checkable.** The cheapest version that would have caught all four: a
   task doc's deferral names its blocker as a **symbol or path**, and a unit test asserts *"if this
   path now exists, the deferral is stale."* That is the same grep-guard shape as T-218's
   `findings-single-clock.test.ts`, pointed at prose instead of SQL.
3. ⚠️ **Do not build a "coverage lint" over comments.** Pass 1's 38/39 says the comment-level claims
   are already sound, and DEF-175's class (a comment naming the wrong *basis*) is not detectable by
   pattern — only by reading the code that writes the value. A lint here would be noise with a
   false sense of coverage, which is the very failure being audited.
4. **Leave the ~220 unchecked boxes alone.** Pass 3 shows they carry no signal. ⚠️ Ticking them
   retroactively would be worse than leaving them — it would manufacture exactly the unearned
   assurance this document is about.

## Method notes for whoever repeats this

- Run the symbol checks from **inside the repo**: Git Bash `/tmp` and Node's `C:\tmp` are different
  directories, and a script that writes one and reads the other fails confusingly.
- `grep -rniF "$pat" ... | wc -l` inside a `for` loop returned 0 for every pattern here while the
  same grep run directly returned hits. Use the harness's own search rather than shell loops.
- ⛔ Filter v1 names out **before** reporting, not after. The first pass of §2 looked like 30
  defects and was 2.
