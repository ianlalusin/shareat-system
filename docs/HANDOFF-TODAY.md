# Handoff — 2026-09-06

## Where things stand

Phase 6's detector work is finished; Phase 7 has started. **T-220** closed the last gaps the coverage
sweep found, **T-221** closed a real cross-org RLS hole, **T-223** gave the low-stock auto-order its
first caller, and **T-222** (store creation) is **specced with zero code**. Everything is committed
and pushed — `main` is `8a4e50f`, `origin/main` matches, tree clean.

⚠️ **DEF-186 is closed but its follow-up is not**: the durable answer — a detector for *below
threshold with no draft line* — is deliberately a separate task. See Pick up here #1.

⭐ **The day's through-line was not a feature: it was prose that claims something the code does not
do.** Nine defects of that shape were filed or closed. The lasting artefacts are a read-only audit of
the whole repo for it (`docs/discovery/27-coverage-claims-sweep.md`), a guard that stops one variety
recurring, and **DEF-188 — where the auditor committed the exact failure being audited, shipped it,
pushed it, and had it caught by the other session.**

## Gates at `8a4e50f`

| Gate | Result |
|---|---|
| **typecheck** | exit 0 |
| **unit** | **1019 passed · 1 skipped · 1 failed** — `tests/golden/attendance-adjudication.test.ts`, DEF-170's 3 residual divergences (`lipa-0013`, `lipa-0359`, `banay-0012`). ⚠️ **Known red, tracked, not a regression** |
| **integration** | ✅ **2369/2369 · 94/94 files · exit 0**, lane `shareat_test_lane25`. ⭐ Confirmed by a full run **after** DEF-178's fix — the previous run was 2368/1, and that single failure was the flake `0289cf7` removed. Nothing outstanding |
| **build** | exit 0, dev server confirmed stopped **by process enumeration** first. 2 pre-existing `storage-firebase` warnings |
| **smoketest** | `/admin/users` **9/9** (T-221) · `/inventory/usage` renders with T-223's wiring, **no errors**. ⚠️ That proves the page loads, **not** that the auto-order fires — proven by integration tests, and after DEF-188 a page load is not called evidence of behaviour |

⚠️ **Carry this caveat verbatim (ianla-e2):** *T-221's cross-org refusal is proven on the two-org lane
fixture, **not** on dev data — `shareat_dev` has only one org. The dev server proved the legitimate
path still works, which is the half that could have broken.*

## What happened this session

### ⛔ DEF-188 — read this one first; it is the most useful thing here

`commissaryUnitMismatch` shipped in `ba33acb`, **fired on real dev data, and every finding it
produced was false.** It asked *"has this LINE got a `trade_order_receipt` movement?"* and reported
two Lipa lines as never received. Both had their stock: `confirmReceipt` writes
`source_id = orderLineIdByLineId[lineId] ?? orderId`, and `shareat_dev` carries **both shapes at
once** across seven orders.

- ⚠️ **Its tests agreed with the bug** — every fixture keyed the movement by line id, the one shape
  the predicate handled.
- ⛔ **At `hard` severity** a false positive did not merely add noise: it blocked period-close
  readiness for a store whose books were fine.
- **Second defect in the same detector**: the detail claimed the amount was *"sitting in 1340
  Inventory in transit"* while reporting ₱1,400 at the **transfer rate**, against a `1340` balance of
  **₱180**. DEF-175's wrong-basis mistake, in a detector written *after* DEF-175 was filed.

> ⭐ **Firing on real data proved the query RUNS. It proved nothing about the query being RIGHT.**
> A detector is the one place where a green run and a correct answer look identical. This was about
> to be the handoff's headline evidence that the detector worked.

**Caught by `ianla-e2` checking the arithmetic behind a number in already-reviewed, already-tested,
already-pushed work.** Nothing in the author's own process would have found it.

⚠️ **The second attempt mattered as much as the first.** The obvious repair — also accept an
order-keyed movement — has a **live** blind spot: multi-line orders exist today, so one order-level
movement would suppress the finding for every line of that order. That trades a false positive for a
silent miss at `hard` severity, on exactly the case the detector exists for. Also caught before it
shipped. It now **compares quantities per order** under either shape, and **reports no peso figure at
all** — a quantity short and the affected orders are what a manager acts on. Fixed in `b388d72`;
verified **0 findings** on dev, `signed_for == into_ledger` on all three received orders.

### T-220 — two detectors built, two REFUSED, and a guard (`ba33acb` + `b388d72`)

Closes DEF-184, DEF-185. Files DEF-186, DEF-188. **The refusals matter more than the builds:**

- ✅ `commissaryUnitMismatch` (see DEF-188) · ✅ `grniNotAtRest` — T-163's deferral, buildable since
  T-166 shipped delivery documents. ⚠️ **The database corrected the design mid-build**: `2120` is
  deliberately *not* party-requiring, so a first draft grouping by supplier was refused by
  `journal_lines_check_party_requirement`. It is a pooled **per-store** balance aged by a FIFO walk.
  ⚠️ It did **not** fire on dev data — proven by tests, not observation.
- ⛔ **`commissaryDiscrepancyOpen` REFUSED** — T-218's `receivingDisputeOverdue` covers the lapse; the
  all-open variant fires on every ordinary short receipt.
- ⛔ **`autoOrderFailed` REFUSED** — it would watch a path that never runs. **DEF-186.**

**DEF-185's guard** — `tests/unit/deferral-staleness.test.ts`. A deferral names its blocker as
`<!-- STALE-IF-EXISTS: path -->`; the test fails when the path exists. It went red on its first real
run and showed T-174/T-175 still describing routes as unbuilt that later tasks had built. ⚠️ Adopted
by example — 3 markers, one a live sentinel; the other ~40 deferrals deliberately unmarked.

### T-223 — the low-stock auto-order finally has a caller (`dde8508`), closes DEF-186

`replenishAfterUsage` had **zero production callers** since T-175 — built, tested, invoked by
nothing, so the auto-order had **never run once**.

⭐ **DEF-186 framed the choice as "an ERP action or a scheduler job." Neither described the real
constraint.** The function's header rules out `postUsageRecord` for taking a `tx` it does not own —
but so does `postUsage`. The transaction begins and ends one layer higher, in **`postUsageAction`**,
and that is the only layer that can run anything after the commit. ⛔ Not a scheduler job: a nightly
sweep replenishes against yesterday's usage and adds a cron whose absence is invisible.

- `PostOutcome` carries `storeId`/`itemIds` — already loaded, returned rather than re-fetched, so the
  action does not issue a second query and race a concurrent void.
- `customerId` is optional on `AutoOrderInput`, resolved from the store inside the open transaction.
- ⛔ **The failure is reported, not swallowed — that was the defect.** A clause on the success
  message; never an error banner over a post that committed.

### DEF-178 fixed (`0289cf7`) — after it reddened a real gate

Filed yesterday as *reported, not fixed*. It failed a full integration run **during a push**
(`expected 29 to be 30`) while passing 21/21 alone. Two clocks: the fixture stamped `last_seen_at`
from Postgres, the assertion floored a value from a JavaScript `Date`. `laneHealth` already accepted
`now`, so the fixture now stamps from JS and injects the same instant.

⭐ **The probe was worth more than the fix.** Verifying the repaired test still guards took three
attempts, and the first two proved nothing: `floor`→`ceil` still passes (at exactly 30.0 they agree),
and a 3% divisor error still passes (30.86 floors to 30). Only a change large enough to move the
integer fails it. **The assertion tolerates just under an hour of arithmetic error** — an outage
alarm, not a precision check. ⚠️ I nearly reported "still guards" after the first probe, which would
have been DEF-188's failure one day later.

### T-221 — the database refuses a cross-org role (`40eecda`), closes DEF-183

Migration `0129`. `person_roles`'s RLS checked the row's own `org_id`, never the person's. ⭐ **A
`WITH CHECK`-only fix would have passed invariants 1–3 and left a second hole**: `UPDATE … SET
person_id = <other org's person>` was also allowed. ⚠️ **Sibling trap**: `person_store_scope` and
`person_grants` derive org *through the person* and are safe; `person_roles` carried its own
`org_id` and only looked safe. **A person-keyed access table must use the `via_person` form.**

### T-222 — store creation, SPEC ONLY (`2ff09b5`)

⛔ **Zero code.** No `createStore`, no `manage_stores` capability, no `/admin/stores` route.
⚠️ `createStore` must fan `person_store_scope` to existing admins or a new branch is invisible to its
creator and presents as a permissions bug.

### The coverage sweep (`e588ce1`) — headline is a negative

Four mechanical passes; **three came back clean.** 38/39 named DB objects exist; 28 of 30 "missing"
plan symbols are v1 names the plans legitimately quote. **The project does not over-claim.** The real
class is the **expired deferral**. ⚠️ **The sweep's own recommendation was half wrong** — it assumed
all four deferrals wanted building; two did not.

### Defects filed or closed today

| # | What | State |
|---|---|---|
| DEF-183 | `person_roles` RLS checked the row's org, not the person's — a role could cross tenants | **fixed** (T-221) |
| DEF-184 | A unit mismatch skipped a stock balance and told nobody | **fixed** (T-220) |
| DEF-185 | ⭐ **The expired deferral** — a deferral records its blocker and nothing re-checks it | **fixed** (guard) |
| DEF-186 | `replenishAfterUsage` had zero production callers — the auto-order never ran | **fixed** (T-223). ⚠️ Detector follow-up deliberately unbuilt |
| DEF-187 | The RLS registry justified a column with an "e.g." that is unreachable | `reported` |
| **DEF-188** | ⛔ **A detector fired on real data and every finding was FALSE** — its own tests agreed with it | **fixed** |
| DEF-178 | A terminal-silence assertion mixed a Postgres clock with a JavaScript one | **fixed** — after it reddened a gate mid-push |
| DEF-179 | ⭐ The row documenting that JS `.` does not match a carriage return **contained literal carriage returns** | **fixed** |

⚠️ **DEF-170's 3 residual golden-master divergences remain the only red in the suite, and are still
unowned.**

### Decisions Ian made today

| Decision | Recorded in |
|---|---|
| A person belongs to exactly **one org** | `PROJECT_BIBLE.md` §13 **row 175**, enforced by migration `0129` |
| `createStore` = atomic auto half + derived checklist | ✅ **`PROJECT_BIBLE.md` §13 row 176** (Ian, 2026-09-06), plus `docs/tasks/222` Contract §2 |
| ⭐ **Wrap-up now requires `npm run toc` after any bible row** | `.claude/skills/wrap-up/SKILL.md`, `7a1deff`. Stated **twice** on purpose: §2 for *forgetting to run it*, §3 as a pre-staging check for *running it after staging*, which commits a stale TOC anyway. ⭐ **Exercised for real the same day, adding row 176: one inserted row shifted 29 TOC line-ranges.** Not ceremony — staging first would have committed a table that misdirects every reader of every section below §13. ⚠️ `npm run toc -- --check` is the CI form, and `tests/unit/toc-freshness.test.ts` is what fails the build |

## Pick up here

1. ⚠️ **A `lowStockOrderNotProposed` detector — DEF-186's durable half, deliberately NOT built.**
   T-223 wired the auto-order and reports a failure on screen, but a screen message dies with the
   request. *An item below its threshold with no draft order line* is derivable and persisted, so it
   survives a lost log line and makes a **repeated** failure visible. ⛔ Left out of T-223 on purpose:
   shipping a detector in the same commit as the path it watches gives independent evidence of
   neither. Needs its own both-direction tests.
2. **T-222 — build store creation.** Spec at `docs/tasks/222-*.md`, zero code.
3. **T-214 — the manager responsiveness scorecard**, last Phase 6 slice.
4. **DEF-170's 3 residual golden-master items** — the only red left in the suite, still unowned.

## Do not decide these alone — they are Ian's

- **T-221's composite FK** — `(person_id, org_id) → persons(id, org_id)` would enforce the one-org
  invariant for `postgres`, the ETL and every script, which RLS does not. Recommended as its own task.
- **Service-charge distribution (T-187)** — unchanged: do not enable service charge in POS first.

## Traps that have actually bitten — ⭐ today's are about the MACHINE and about VERIFICATION

1. ⭐ **A green run is not a right answer.** DEF-188. Where the code under test *is* a query, running
   it proves execution and nothing else. **Check the arithmetic against ground truth, by hand, once.**
   ⚠️ **And the same applies to a probe that proves a test still works** — two of three probes on the
   DEF-178 fix passed against deliberately broken code before one finally bit. A probe that cannot
   fail proves nothing, exactly like a guard that scans nothing.
2. ⛔ **We share the machine, not just the tree.** Budget ≈ **one heavy process**; a dev server counts.
   Separate lane DBs fix fixture collisions and do **nothing** for RAM.
3. ⛔ **Killing a background task does NOT kill the process.** `npm run …` spawns the real thing;
   reaping the shell orphans it. Nine orphaned vitest workers accumulated, and their RAM killed the
   *next* run. **Verify by enumeration:**
   `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*shareat-system*' }`
4. ⛔ **Never pipe a test run into `grep`** — it buffers, the log stays 0 bytes, a healthy run looks
   hung. Raw to a file, filter after. ⚠️ The **default reporter prints nothing to a redirected log**;
   use `--reporter=dot`. `--reporter=basic` does not exist in vitest 4.
5. ⛔ **`pgrep -f` in Git Bash cannot see Windows command lines.** Every false "it died" call today came
   from a check that could only confirm what the caller already believed.
6. ⛔ **CRLF, three ways.** JS `.` does not match `\r`, so `/--.*$/` matches nothing and a grep-shaped
   guard silently passes (DEF-179). Python `newline=''` breaks searches for `|\n`. Git Bash `/tmp` is
   **not** Node's `C:\tmp`.
7. ⚠️ **Backticks inside a `sql\`\`` template literal terminate the string** — bit five times today.
   And **`git commit -m` with backticks is command substitution**: use `-F`, then grep the message
   back out of `git log -1`.
8. ⚠️ **`git add <path>` is file-granular.** `DEFECTS-REGISTER.md` / `ROADMAP.html` were swept into
   the other session's commits four times. Not harmful — credit it in the message.

## Test databases — ⚠️ migration `0129` is NOT everywhere

Applied to `shareat_dev`, `shareat_test_e2`, `shareat_test_lane25`. **NOT applied** to
`shareat_test`, `shareat_test_lane15`, `_a`, `_b`, `_202`, `_203`, `_204` — the next session on any of
those gets a confusing red. Run `npm run db:migrate` against it first.

## The paste-ready prompt

```
Read C:\Users\ianla\webapps\shareat-system\docs\HANDOFF-TODAY.md, then docs/RULES.md
if you haven't this session. main is 0289cf7, pushed, tree clean; gates green apart
from DEF-170's known-red golden master.

Read DEF-188 in the handoff first — a detector fired on real data and was 100%
wrong, and its own tests agreed with it. That is the day's lesson and it is one
paragraph.

Then pick up DEF-186's follow-up: T-223 wired the auto-order, but the durable
half — a lowStockOrderNotProposed detector, below threshold with no draft line —
is deliberately unbuilt. After that, T-222 (store creation, specced, zero code)
or T-214.

⚠️ ListAgents first, and read the handoff's Traps section before running anything
heavy: shared tree AND shared machine, one heavy process at a time, verified by
enumeration rather than intention. If you use a test DB other than lane25 or
shareat_test_e2, migrate it first — 0129 is not everywhere.
```
