# Handoff — 2026-09-06

## Where things stand

Phase 6's detector work is finished; Phase 7 has started. **T-220** closed the last gaps the coverage
sweep found, **T-221** closed a real cross-org RLS hole, **T-222** (store creation) is **specced with
zero code**. Everything is committed and pushed — `main` is `b388d72`, `origin/main` matches, tree
clean.

⭐ **The day's through-line was not a feature: it was prose that claims something the code does not
do.** Nine defects of that shape were filed or closed. The lasting artefacts are a read-only audit of
the whole repo for it (`docs/discovery/27-coverage-claims-sweep.md`), a guard that stops one variety
recurring, and **DEF-188 — where the auditor committed the exact failure being audited, shipped it,
pushed it, and had it caught by the other session.**

## Gates at `b388d72`

| Gate | Result |
|---|---|
| **typecheck** | exit 0 |
| **unit** | **1019 passed · 1 skipped · 1 failed** — `tests/golden/attendance-adjudication.test.ts`, DEF-170's 3 residual divergences (`lipa-0013`, `lipa-0359`, `banay-0012`). ⚠️ **Known red, tracked, not a regression** |
| **integration** | **2366/2366 · 94/94 files · exit 0**, lane `shareat_test_lane25` |
| **build** | exit 0, dev server confirmed stopped **by process enumeration** first. 2 pre-existing `storage-firebase` warnings |
| **smoketest** | `/admin/users` **9/9** (T-221). ⚠️ `/findings` was smoketested *before* DEF-188 and its finding was **false** — see below |

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

### Decisions Ian made today

| Decision | Recorded in |
|---|---|
| A person belongs to exactly **one org** | `PROJECT_BIBLE.md` §13 **row 175**, enforced by migration `0129` |
| `createStore` = atomic auto half + derived checklist | `docs/tasks/222` Contract §2, `2ff09b5` body. ⚠️ **May deserve its own §13 row — Ian's call**; it is a shape future tasks will copy |
| ⭐ **Wrap-up now requires `npm run toc` after any bible row** | `.claude/skills/wrap-up/SKILL.md`, `7a1deff`. Stated **twice** on purpose: §2 for *forgetting to run it*, §3 as a pre-staging check for *running it after staging*, which commits a stale TOC anyway |

## Pick up here

1. ⛔ **DEF-186 — wire `replenishAfterUsage`, or decide not to.** Built, tested, called by nothing, so
   the low-stock auto-order has **never run**. ⚠️ **Do NOT call it from `postUsageRecord`** — it takes
   a `tx` it does not own, and sharing the transaction would roll back a cook's usage record because
   ordering failed. Seam is an ERP action or a scheduler job: **Ian's call.**
2. **T-222 — build store creation.** Spec at `docs/tasks/222-*.md`.
3. **T-214 — the manager responsiveness scorecard**, last Phase 6 slice.

## Do not decide these alone — they are Ian's

- **DEF-186's seam** (above).
- **Whether the `createStore` shape decision earns a `PROJECT_BIBLE.md` §13 row.** ⚠️ If yes, run
  `npm run toc` and stage what it rewrites.
- **T-221's composite FK** — `(person_id, org_id) → persons(id, org_id)` would enforce the one-org
  invariant for `postgres`, the ETL and every script, which RLS does not. Recommended as its own task.
- **DEF-170's 3 residual golden-master items** — still unowned, still the only red.
- **Service-charge distribution (T-187)** — unchanged: do not enable service charge in POS first.

## Traps that have actually bitten — ⭐ today's are about the MACHINE and about VERIFICATION

1. ⭐ **A green run is not a right answer.** DEF-188. Where the code under test *is* a query, running
   it proves execution and nothing else. **Check the arithmetic against ground truth, by hand, once.**
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
if you haven't this session. main is b388d72, pushed, tree clean; gates green apart
from DEF-170's known-red golden master.

Read DEF-188 in the handoff first — a detector fired on real data and was 100%
wrong, and its own tests agreed with it. That is the day's lesson and it is one
paragraph.

Then pick up DEF-186: replenishAfterUsage is built, tested, and called by nothing,
so the low-stock auto-order has never run. Do NOT wire it into postUsageRecord
(wrong transaction boundary) — the seam is Ian's call. After that, T-222 (store
creation, specced, zero code) or T-214.

⚠️ ListAgents first, and read the handoff's Traps section before running anything
heavy: shared tree AND shared machine, one heavy process at a time, verified by
enumeration rather than intention. If you use a test DB other than lane25 or
shareat_test_e2, migrate it first — 0129 is not everywhere.
```
