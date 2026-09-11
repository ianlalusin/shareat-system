# T-268 — DEF-289: the ETL pipeline runs on the system connection, because nothing else can reach it

**Status:** `spec approved` — lane B (Sonnet). Opened 2026-09-12 by orchestrator `system32-85`.
Reserves task number 268.

> ⛔ **Read §1 before you change a single line.** The ETL tables are deny-all by design. There is
> exactly one correct fix and one very tempting wrong one, and the wrong one hands every tenant a
> path to captured production PII.

---

## Goal

Every transaction on the ETL path uses `systemTransaction()` instead of the bare `transaction()`
door, so the capture/analyze/load pipeline keeps working when `DATABASE_URL` is tightened to a role
that does not bypass RLS. 19 currently-red integration tests go green under
`INTEGRATION_RESTRICTED_ROLE=1`.

---

## 1. ⛔ Why `systemTransaction()` is the ONLY fix here — not merely the natural one

The ETL tables carry **RLS enabled + FORCE ROW LEVEL SECURITY with ZERO policies**. That is not an
oversight; it is the design, and it is documented in the migration itself
(`packages/db/migrations/0011_row_level_security.sql:142-160`):

> *"a table with RLS enabled and no policy is invisible to every non-owner role … The ETL tables
> hold captured production PII and no tenant has any business reading them."*

**A table with no policy can never be satisfied by any principal.** `withOrgPrincipal(orgId)` does
not help, a "better" org id does not help, and there is no value of `app_current_org()` that makes a
row visible. The owner connection is the only thing that can see these tables at all.

### ⛔ The wrong fix, named so you can recognise the temptation

If a test still fails, you may find yourself reasoning: *"the app role can't read `etl_runs`, so
`etl_runs` needs a policy."* **Never add, weaken, or create a policy on `audit_log`, `etl_runs`,
`etl_source_documents`, `etl_quarantine` or `etl_reconciliation`.** Those tables hold captured
production PII from the live business. A policy that makes the app role work is a policy that makes
**every tenant** able to read it. If you believe a policy is required, that is a **BLOCKED** report
to `system32-85`, not a migration.

---

## 2. Scope — the only paths you may modify

```
packages/etl/src/run.ts                         (6 call sites)
packages/db/src/repo/etl.ts                     (2 call sites — see §3, the handoff missed these)
packages/etl/tests/integration/etl-run.test.ts
packages/etl-firestore/tests/integration/capture.test.ts   (VERIFICATION-ONLY — see §2a)
```

### §2a — ⛔ SPEC CORRECTION, 2026-09-12: the capture path in the first draft was WRONG

⭐ **Lane B checked the paths instead of assuming them, and found the file does not exist.** The
first draft said `packages/etl/tests/integration/capture.test.ts`. There is no such file. It also
disambiguated three same-named candidates by RUNNING all of them rather than reasoning about names —
that is the standard, and it is why this was caught before a single edit.

| Candidate | Verdict |
|---|---|
| `packages/etl/tests/capture.test.ts` | a **unit** test of `capture.ts`'s sampling job; 22/22 green under the flag — **not it** |
| `packages/etl/tests/integration/capture.test.ts` | **does not exist** |
| `packages/etl-firestore/tests/integration/capture.test.ts` | 3 failed, all `new row violates row-level security policy for table "etl_runs"` — **this is the file** |

**Ruling: it is IN SCOPE as VERIFICATION-ONLY.** It must go green, and you may not edit it. Lane B's
read is accepted — it is a downstream consumer of `runCaptureMode` with no bypassing reads of its
own, so it should go green on your production change alone. ⛔ If it turns out to need an edit, that
is a `[B] QUESTION`, not a silent widening.

### ⚠️ AND A FOURTH FILE NEITHER OF US LISTED

`packages/etl/tests/integration/replay.test.ts` sits in the same directory and is in **neither** the
handoff's red list nor this spec's. It is an integration test of the ETL package you are changing.
**Add it as a MUST-STAY-GREEN regression check** — run it both ways before and after. It is not
expected to be red; if it is red before your edit, report that as a finding, because it would mean
the handoff's census missed a file.

⚠️ Also corrected throughout: the table is `etl_reconciliation` (**singular**) — migration
`0011:164` and `schema/etl.ts`. The first draft said `etl_reconciliations`.

---

## 3. Contract — eight call sites, and the handoff's list has six

Yesterday's handoff names `packages/etl/src/run.ts:122,148,246,260,303,339`. That list is
**correct but incomplete**, found while sizing this spec:

| # | Site | Writes/reads | Note |
|---|---|---|---|
| 1 | `run.ts:122` | `landDocument` → `etl_source_documents` | deny-all |
| 2 | `run.ts:148` | `writeReconciliation` → `etl_reconciliation` | deny-all |
| 3 | `run.ts:246` | `findCurrentDocuments` → `etl_source_documents` | deny-all |
| 4 | `run.ts:260` | `postEntry` **+** `resolveQuarantineForDocument` | ⭐ **mixed — see §4** |
| 5 | `run.ts:303` | `quarantineDocument` → `etl_quarantine` | deny-all |
| 6 | `run.ts:339` | `writeReconciliation` → `etl_reconciliation` | deny-all |
| **7** | **`packages/db/src/repo/etl.ts:98`** | **`startRun` → `etl_runs`** | ⛔ **opens its OWN transaction** |
| **8** | **`packages/db/src/repo/etl.ts:140`** | **`finishRun` → `etl_runs`** | ⛔ **opens its OWN transaction** |

⭐ **Sites 7 and 8 are why this matters more than the count suggests.** `startRun` is the *first*
statement of every ETL run and `finishRun` is the error-path guarantee that a failed run is still
recorded. Fix only the six in `run.ts` and every ETL run still dies at its first line, with the six
fixes untested behind it. These two deliberately open their own transaction rather than joining the
caller's — documented at `repo/etl.ts:7` and `:128` — precisely so `finishRun` survives a caller
whose transaction has already rolled back. **Keep that property**: they must still open their own,
now via `systemTransaction()`.

---

## 4. ⭐ Site 4 is a design decision, and the spec makes it — you implement it

`run.ts:260` opens ONE transaction that does two things with different security shapes:

- `postEntry(...)` writes `journal_entries` / `journal_lines` — **org-scoped tables with real RLS
  policies**, and the call already passes `orgId!` explicitly.
- `resolveQuarantineForDocument(...)` writes `etl_quarantine` — **deny-all**.

So one transaction cannot satisfy both a principal and no principal.

**Decision (orchestrator, 2026-09-12): wrap the whole thing in `systemTransaction()`.** The
reasoning, so you can challenge it rather than guess at it:

1. **Splitting it is the worse bug.** The alternative is `withOrgPrincipal(orgId)` for the post and
   `systemTransaction()` for the quarantine resolution — two transactions, no longer atomic. If the
   quarantine resolution commits and the post then fails, a document is marked resolved that never
   posted. That is a silent data defect; the thing it replaces is not.
2. **The ledger write is already explicitly scoped at the application layer** — `orgId` is passed
   into every entry, not inferred. Bible §15.11 asks that no layer be the *only* one for a risk;
   here the app layer scopes and the loader is not a request path.
3. **It is not a behaviour change today.** `transaction()` already connects as the owner, so RLS is
   already not applied to this write. This change makes it *survive* the role switch; it does not
   remove a protection that is operating.
4. **The ETL loader is an operator-run migration tool** (ADR-005, books-first cutover), invoked from
   a script with a `postedBy`, not reachable from any user request path.

⚠️ **If you disagree, say so as `[B] QUESTION` before building.** This is the one judgement call in
the task and it is recorded in the bible; a reasoned objection from the person reading the code
closely is worth more than my having decided it from outside.

---

## 5. Invariants

1. ⛔ **Never add or weaken an RLS policy.** §1. This is the one that matters.
2. ⛔ **The two-kinds rule (handoff §4).** Every red is (a) a test that forgot its organisation →
   fix the test, wrapping **at the layer production wraps, no deeper**; (b) *production* reads or
   writes with no principal → **report it, do not patch the test**; (c) the test runs without a
   principal **on purpose** to prove the app layer scopes on its own → re-arm the bypass explicitly,
   never wrap it; (d) the test asserts **which layer refuses** → never edit the expected error to
   match what you observed. **If you cannot tell which, ASK.**
   ⛔ If a test only goes green when you wrap something *deeper* than production does, you have
   found a (b).
3. ⚠️ **`startRun`/`finishRun` must keep opening their own transaction**, not join the caller's
   (§3). A test that passes because `finishRun` joined a caller has deleted the property it tested.
4. ⛔ **Landed source documents are immutable** (DEF-041). Nothing in this task may make
   `etl_source_documents` writable beyond the existing `landDocument` insert.
5. Money is integer centavos, never floats (bible §2.5 / §6). `convert.ts` has been bitten here
   before (DEF-046) — do not introduce a `money()` call on a raw float.
6. ⚠️ **Watch for the silent read/write.** A `SELECT` returning zero rows and an `UPDATE … WHERE`
   matching nothing both succeed silently under a restricted role. If a count-based assertion fails
   with no error text anywhere, **look for a swallowing `catch` in the production path before
   assuming a fixture gap** (handoff §4).

---

## 6. Tests — the 19 that must go green

Run **only** against your own lane database:

```
node C:/Users/ianla/.claude/skills/orchestrator/tools/it.mjs shareat_test_laneb <test files>
```
…with the restricted role ON. ⚠️ **PowerShell: `$env:INTEGRATION_RESTRICTED_ROLE=1` first**, or the
suite passes and you will conclude nothing is broken.

| File | Expected |
|---|---|
| `packages/etl/tests/integration/etl-run.test.ts` | **16 red** → green (lane B measured 16 failed / 5 passed of 21) |
| `packages/etl-firestore/tests/integration/capture.test.ts` | **3 red** → green (measured 3 failed of 3) |
| `packages/etl/tests/integration/replay.test.ts` | ⚠️ **must stay green** — regression check, not expected red |

Also run both files **without** the flag and confirm they are still green — the default role must
not regress.

⛔ **A red that is not in this table is a regression. Find it; do not absorb it.**

---

## 7. Out of scope — describe the change you need and `system32-85` makes it

- ⛔ `tests/unit/system-transaction-callers.test.ts` — the guard, orchestrator-owned.
  ⚠️ **SPEC CORRECTION, 2026-09-12:** the first draft of this spec told you your change would
  *"trip nothing at all"* because the guard scanned only `apps` and `packages/domain/src`. **That is
  no longer true** — DEF-295 was fixed a few hours after this spec was written and the guard now
  scans all ten source roots. Your change WILL go red, naming exactly two offenders:
  `packages/etl/src/run.ts` and `packages/db/src/repo/etl.ts`. **That red is EXPECTED.** Report it
  verbatim in your READY; the orchestrator adds both to the closed caller list at integration.
  ⭐ Read it as confirmation the guard can finally see your package — until today it could not,
  and six new callers to a "closed" list would have landed in silence.
- ⛔ `packages/db/src/client.ts` — the doc comment naming the closed caller list. Orchestrator's.
- ⛔ `packages/db/src/index.ts` — the barrel. Orchestrator's.
- ⛔ Any migration, and **no migration slot is allocated to this lane**. ⛔ Any RLS policy.
- ⛔ `packages/domain/**`, `apps/erp/**`, `scripts/bootstrap-org.ts` — that is lane A (T-267).
- ⛔ `PROJECT_BIBLE.md`, `docs/DEFECTS-REGISTER.md`, `docs/ROADMAP.html`, `docs/HANDOFF-TODAY.md`.
- ⛔ Any `git` command that writes. ⛔ `npm run build`. ⛔ `npm run dev`. ⛔ `npm run test:integration`.

## 8. Done when

- [ ] All **eight** call sites use `systemTransaction()`; `startRun`/`finishRun` still open their own.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test` (unit) — green EXCEPT `system-transaction-callers`, whose 2 expected
      offenders you report verbatim. Anything else red is a regression.
- [ ] `etl-run` and `capture` pass with `INTEGRATION_RESTRICTED_ROLE=1` on `shareat_test_laneb`.
- [ ] Both files still pass **without** the flag.
- [ ] No policy added, weakened, or created on any table. State this explicitly in your READY.
- [ ] §4's decision either implemented as written, or challenged as `[B] QUESTION` before building.
- [ ] READY carries the real output of every gate — numbers and exit codes, not adjectives.
