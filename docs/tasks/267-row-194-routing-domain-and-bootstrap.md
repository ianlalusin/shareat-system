# T-267 — Route the admitted cross-organisation reads through `systemTransaction()`

**Status:** `spec approved` — lane A (`webapps-4e`, Sonnet). Opened 2026-09-12 by orchestrator
`system32-85`. Reserves task number 267.

> ⛔ **This task adds callers to a closed list. It does not widen the list itself.** Two guard
> files react to this change and **both are orchestrator-owned** — see §Out of scope. The red they
> produce is *expected* and is reported, never fixed by the lane.

---

## Goal

Four production call sites that must read or write across every organisation stop using the bare
`transaction()` door and use `systemTransaction()` instead, so that they keep working when
`DATABASE_URL` is tightened to a role that does not bypass RLS. Seven currently-red integration
tests go green under `INTEGRATION_RESTRICTED_ROLE=1`.

## Why these four, and on whose authority

| # | Call site | Why it cannot scope to one organisation | Authority |
|---|---|---|---|
| 1 | `packages/domain/src/scheduler/index.ts` — the `orgIdsForStoreIds` read | It is the step that *discovers* which org a till event belongs to. The org is the OUTPUT of the read, so it cannot be the principal of it | bible §13 row 194, subsystem 1 |
| 2 | `packages/domain/src/files/index.ts` — `sweepOrphanedFiles`, both halves | A cron that sweeps unreferenced uploads across every organisation. No single org's principal expresses "all orgs" | bible §13 row 194, subsystem 2 · **DEF-287** |
| 3 | `apps/erp/src/app/sign-in/lib.ts` — `resolveVerifiedSignIn`'s `anyOrganizationExists` | *"Has this system been set up at all?"* is a **bootstrap** question asked before any org exists | **Ian, 2026-09-12** (see below) |
| 4 | `apps/erp/src/app/setup/lib.ts` — `systemIsAlreadySetUp` | Identical bootstrap question, asked by the first-run page | **Ian, 2026-09-12** |

### ⭐ Ian's ruling, 2026-09-12 — the "fifth question" is answered, and it was three sites

Yesterday's handoff reserved one call site (`sign-in/lib.ts`) for Ian and said ⛔ *do not admit it
yourself*. Sizing it for this spec found the **same bootstrap question asked in three places**, all
on a bare `transaction()`:

- `apps/erp/src/app/sign-in/lib.ts:135` — a stranger is sent to `/setup` instead of *"ask an
  administrator"*.
- `apps/erp/src/app/setup/lib.ts:28` — the first-run page's own gate; renders the setup form on a
  live system.
- `scripts/bootstrap-org.ts:158` — ⚠️ **contradicts itself today**: its guard read is bare while
  its `bootstrapOrganization` write at line 212 already goes through `systemTransaction()`. Under
  a restricted role the guard would say *"not set up"* and the write would then refuse.

In all three the database's own `WITH CHECK` still refuses a second organisation. **A wrong
sentence, never wrong data** — this was always an availability/UX defect, never a leak.

**Ian's decision:** *route all three through the bootstrap door* — `systemTransaction()`, the same
door `setup/actions.ts` and `bootstrap-org.ts`'s write already use. The list stays **closed and
build-enforced**; it does not become a general escape hatch.

⚠️ Site 3 (`scripts/bootstrap-org.ts:158`) is **NOT in this lane's scope** — see §Out of scope.

---

## Scope — the only paths you may modify

```
packages/domain/src/scheduler/index.ts        (ONE call site — see Contract)
packages/domain/src/files/index.ts            (TWO call sites — see Contract)
apps/erp/src/app/sign-in/lib.ts               (ONE call site)
apps/erp/src/app/setup/lib.ts                 (ONE call site)
packages/domain/tests/integration/firestore-relay.test.ts
packages/domain/tests/integration/files.test.ts
packages/domain/tests/integration/organizations.test.ts
tests/integration/email-sign-in.test.ts
```

You may modify a test file **only** to correct a test that is wrong. ⛔ If a test is red because
*production* is wrong, that is a finding — report it, do not edit the test (§Invariants, rule 1).

## Contract — the exact edits

**1. `packages/domain/src/scheduler/index.ts`** — in the till-event relay, around line 507:

```ts
// before
orgByStore = storeIds.length
  ? await transaction((tx) => storesRepo.orgIdsForStoreIds(tx, storeIds))
  : new Map<string, string>();
// after: systemTransaction, same shape
```

This file **already** calls `systemTransaction` at lines 131/159/183/218 and is **already** a
named caller, so this adds no new entry to any list.

**2. `packages/domain/src/files/index.ts`** — inside `sweepOrphanedFiles` **only**:

- line ~204 `const orphans = await transaction((tx) => filesRepo.listOrphans(...))`
- line ~211 `await transaction((tx) => filesRepo.deleteFile(tx, o.id))`

⛔ **Lines 83 (`runUpload`) and 180 must keep using `transaction()`.** They are actor-scoped
request paths, not the cross-org sweep. The file will import **both** `transaction` and
`systemTransaction` when you are done. Touching 83 or 180 is out of scope and is a different
question.

**3. `apps/erp/src/app/sign-in/lib.ts:135`** and **4. `apps/erp/src/app/setup/lib.ts:28`** — the
`anyOrganizationExists` read only, `transaction` → `systemTransaction`.

⭐ Both files carry a long doc comment that says this read is *"left on a bare `transaction()`,
unchanged and deliberately so"* and that fixing it *"is a fifth caller-list decision and Ian's to
make"*. **Ian has now made it.** Update those comments to record the ruling and its date — do not
leave a comment asserting the opposite of what the code now does.

---

## Invariants

1. ⛔ **The two-kinds rule (handoff §4, and it found five production defects yesterday).** Every
   red test is one of:
   **(a)** the test forgot its organisation → fix the test, wrapping **at the layer production
   wraps, no deeper**;
   **(b)** *production* reads or writes org-scoped data with no principal → ⛔ **report it, do not
   patch the test**;
   **(c)** the test runs without a principal **on purpose**, to prove the app layer scopes on its
   own → re-arm the bypass explicitly, never wrap it;
   **(d)** the test asserts **which layer refuses** → ⛔ never edit the expected error to match
   what you observed.
   **If you cannot tell which, ASK.** A wrong call in direction (b) is the worst outcome available
   here: it makes the suite green while hiding the defect the exercise exists to find.
2. ⛔ **Never add or loosen an RLS policy to make something work.** Not on any table, for any
   reason. If a path seems to need one, that is a BLOCKED report.
3. ⛔ **`systemTransaction()` is not a general escape hatch.** Exactly the four sites above. If you
   find a fifth that looks like it needs the same treatment, report it — do not add it.
4. ⚠️ **Watch for the silent write in `sweepOrphanedFiles` (this is DEF-287's own shape).** The
   loop wraps `driver.remove` + `deleteFile` in a `try/catch` that folds failures into a `failed[]`
   array. Under a restricted role an `UPDATE`/`DELETE … WHERE` that matches **zero rows throws
   nothing** — the sweep would count a row as `removed` while it is still there, and report
   success. ⭐ **Before you call this site fixed, confirm the delete actually deleted** (assert on
   rows affected, or re-read). If it does not, you have found a second defect — report it.
5. Money stays integer centavos; no floats (bible §2.5). Not expected to arise here.

## Tests — the seven that must go green

Run **only** against your own lane database, never the shared one:

```
node C:/Users/ianla/.claude/skills/orchestrator/tools/it.mjs shareat_test_lanea <files>
```
…with `INTEGRATION_RESTRICTED_ROLE=1` set. ⚠️ **In PowerShell set `$env:INTEGRATION_RESTRICTED_ROLE=1`
first, or the suite passes and you will conclude nothing is broken.**

| File | Red tests | Cause on record |
|---|---|---|
| `packages/domain/tests/integration/firestore-relay.test.ts` | 2 | scheduler:508 |
| `packages/domain/tests/integration/files.test.ts` | 1 | DEF-287 |
| `packages/domain/tests/integration/organizations.test.ts` | 1 | the bootstrap read |
| `tests/integration/email-sign-in.test.ts` | 3 | the bootstrap read |

Also run each file **without** the flag and confirm it is still green — the default role must not
regress.

⛔ **A red that is not in this table is a regression. Find it; do not absorb it.**

## Out of scope — describe the change you need and the orchestrator makes it

- ⛔ `tests/unit/system-transaction-callers.test.ts` — **the guard.** Your change adds three new
  callers to roots it scans, so it WILL go red with exactly these offenders:
  `packages/domain/src/files/index.ts`, `apps/erp/src/app/sign-in/lib.ts`,
  `apps/erp/src/app/setup/lib.ts`. **This red is expected.** Report it verbatim in your READY.
- ⚠️ `tests/unit/no-direct-transaction-in-erp.test.ts` — **orchestrator-owned, and my warning about
  it in the first draft of this spec was WRONG.** I predicted it would go red on a stale exemption.
  It does not: its staleness assertion only checks that each `PRE_AUTH_PATHS` entry *matches a real
  tracked file*, not that the file still reaches a raw handle — and `systemTransaction(` does not
  match its `transaction(` pattern (the preceding `m` fails the boundary class). Lane A measured
  **1 failed unit file, not 2, and was right.**
  ⭐ The consequence is still real and still mine: converting these two files leaves
  `setup/lib.ts` and `sign-in/lib.ts` as **dead exemptions** — entries claiming a raw-handle
  allowance for files that no longer use one. The guard's own comment warns that exactly this
  *"makes the rule look narrower than it is, and the next person widens it by adding a neighbour"*,
  yet its check cannot detect it. That is DEF-295's shape in a second guard and is filed separately.
  **Do not edit this file; the orchestrator removes the two entries at integration.**
- ⛔ `packages/db/src/client.ts` — the doc comment naming the closed list. Orchestrator's.
- ⛔ `scripts/bootstrap-org.ts` — site 3 of Ian's ruling, held back deliberately: `scripts/` is
  unscanned by the guard (**DEF-295**) and the orchestrator is fixing the scan in the same cycle.
- ⛔ `packages/etl/**` — that is lane B (**DEF-289**). Its tables carry FORCE RLS with **zero
  policies**; do not go near them.
- ⛔ Any migration. **No migration slot is allocated to this lane.**
- ⛔ `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md`.
- ⛔ `files/index.ts` lines 83 and 180.
- ⛔ Any `git` command that writes. ⛔ `npm run build`. ⛔ `npm run dev`. ⛔ `npm run test:integration`.

---

## ⛔ SPEC CORRECTION 1 — 2026-09-12, orchestrator. The red table in §6 was WRONG.

⭐ **Lane A reported this as `[A] QUESTION` before building, which is exactly right** (bible
§3.4a — a spec is a hypothesis, and an implementer who silently patches around a defect destroys
the evidence it was wrong). The numbers below replace §6's table.

**Where my numbers came from, and why they were wrong:** I copied them from
`docs/HANDOFF-TODAY.md` §3 without measuring. That table was already internally inconsistent — its
§0 says *"8 files / 31 tests"* while §3's own rows sum to 26, and §7 records a closing census that
returned a third number again (9/37) and was never reconciled. **A number carried forward from a
document is not a measurement.**

| File | Spec said | **Actual, measured on a clean DB before any edit** |
|---|---|---|
| `firestore-relay.test.ts` | 2 | **2** ✓ |
| `files.test.ts` | 1 | **1** ✓ |
| `organizations.test.ts` | 1 | **0** — no test in that file exercises the bootstrap read at all |
| `email-sign-in.test.ts` | 3 | **2** (cases 3 and 4) |
| **total** | 7 | **5** |

### ⚠️ How the orchestrator got a *third* answer, recorded so nobody repeats it

Verifying lane A's report, I measured `firestore-relay` at **0 red** on two separate databases and
briefly believed the lane was wrong. **It was not — my measurement was contaminated.** Lane A had
already applied the `scheduler/index.ts` fix to the **shared working tree** between my briefing and
my run, so I was measuring a tree that already contained the change I was trying to establish a
baseline for.

⛔ **In a shared tree, the orchestrator cannot take a baseline after a lane has started.** The
lane's own pre-change measurement is the only trustworthy one, and it must be captured BEFORE the
first edit. Two further traps found in the same ten minutes:

- `git status` reported the tree **clean** for `scheduler/index.ts` while `git hash-object` on the
  same file already differed from `git rev-parse HEAD:<path>`. Run `git update-index --refresh`
  before trusting `git status` as evidence about another session's work.
- Reading the same line twice with `sed` and with `grep` gave two different answers seconds apart,
  because the file was being written between them. **One authoritative command, not two that agree
  by luck.**

### ⭐ What this changes about the WORK, not just the count

`organizations.test.ts` has **no** failing test, and `setup/lib.ts` (call site 4) therefore has
**nothing proving its fix**. This project has shipped five tasks marked done with zero callers
(DEF-129/135/136/137/147, 2026-09-02/03); a change with no test that ever failed is that same
shape.

**Added to this lane's contract:**

1. `organizations.test.ts` leaves the red table. It stays a **must-remain-green** regression check.
2. ⛔ **Write a test that fails for the right reason for `systemIsAlreadySetUp`** (`setup/lib.ts`).
   The fix may already be applied by the time you read this — in that case prove the test is real by
   temporarily restoring the bare `transaction()`, watching it go red, then restoring your fix.
   A test that has only ever passed proves nothing (bible §3.2 / §9).
3. `apps/erp/tests/setup-failure-redirect.test.ts` (which lane A spotted referencing
   `systemIsAlreadySetUp`) is **admitted to scope** if it is the right home for that test. If it is
   not, add a new integration test file and say which you chose and why.
4. The corrected done-when count is **5 pre-existing reds green, plus at least 1 new test** that
   demonstrably failed before the fix.


## Done when

- [ ] All four call sites use `systemTransaction()`; no other call site changed.
- [ ] The doc comments in `sign-in/lib.ts` and `setup/lib.ts` record Ian's 2026-09-12 ruling
      instead of asserting the read is deliberately left bare.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test` (unit) — green **except** the two guard files named in §Out of scope, whose
      failures you report verbatim with their exact offender lists.
- [ ] The 7 integration tests above pass with `INTEGRATION_RESTRICTED_ROLE=1` on your lane DB.
- [ ] The same 4 files still pass **without** the flag.
- [ ] Invariant 4 answered explicitly: does the orphan sweep's delete actually delete?
- [ ] READY report carries the real output of every gate — numbers and exit codes, not adjectives.
