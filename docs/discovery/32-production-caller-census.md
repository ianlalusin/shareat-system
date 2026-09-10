# 32 — The production-caller census: exported functions that only tests call

> **Read-only pass. No source, no tests, no registers, no git, no build, no dev server. This
> document is the only file written.** Commissioned by the orchestrator (`system32-85`) 2026-09-10,
> out of the closing paragraph of [`31-def-249-attendance-config-consequence.md`](./31-def-249-attendance-config-consequence.md):
> *"a guard counting CALLERS sees thirteen and is satisfied. It has to count PRODUCTION callers —
> callers outside `tests/`."*
>
> DEF-249 is the fourth instance of this shape (DEF-226, DEF-227, DEF-249, and a fifth refused
> before it shipped on 2026-09-10). Four is a pattern. This is the number.
>
> ⛔ **The control comes first and it is §1, before any total** — because this project has twice
> shipped a sweep that scanned nothing and reported success (DEF-245, DEF-238), and *a census that
> reports zero and a census that is broken look identical.*

---

## 0. The answer

| | |
|---|---|
| Files scanned | **798** TypeScript/TSX (198 of them test files) |
| Top-level exported functions found | **1,657** |
| ⭐ **Exported functions with test callers and ZERO production callers** | **59** |
| ⭐ **Exported functions with no reference anywhere at all** | **52** (10 of which are framework entry points and are *not* dead — §4.0) |
| Of the 59, hand-verified individually | **16** |
| ⛔ Genuine DEF-249s found — a function with no caller **and a claim that it has one** | **3** |

⭐ **The headline is not the 59. It is this: "zero production callers" is not the defect.** Most of
the 59 are domain capabilities built ahead of their screens, which is how this project is sequenced
on purpose. `elevateManager` (`packages/auth/src/roles.ts:596`) has zero production callers and is
**correct** — its own doc comment says so in as many words and explains what a future caller must do.

**The defect is "zero production callers PLUS a comment asserting a caller exists."** That is exactly
what DEF-249 was: `schema/attendance-config.ts:117` claiming *"every store is created fresh and
`seedAttendanceConfig` inserts"*. Three more of those are in §5, and one of them means **no clock
terminal in this system can ever report itself as paired.**

⛔ **Consequence for the guard (§6): a mechanical "zero production callers" check would fire 111
times, be ~90% wrong, and be suppressed within a day.** The thing that actually distinguishes a hole
from a plan is a natural-language claim, and that is not mechanically checkable. What *is* buildable
is a ratchet over a declared-intent ledger. Said plainly because a guard that passes vacuously is
worse than no guard.

---

## 1. ⛔ THE CONTROL — run first, and it FAILED TWICE before it passed

Bible §13 row 181, and DEF-230's own lesson: *"a sweep that matches nothing exits 0 and looks
exactly like a clean tree, so the control is the finding."*

**Design.** Before believing any number, the scanner must classify a **known positive** and a set of
**known negatives** correctly:

- Known positive — `seedAttendanceConfig` **must** appear as test-only. Proven by doc 31 and
  independently re-verified by the orchestrator at `df1f988`.
- Known negatives — `adjudicateDay`, `previewPayRun`, `recordPunch`, `sweepStore`, `supersedeConfig`,
  `derivePeriods`, `getLiveConfig`, `postEntry`, `authorize` **must not**. Each has a production call
  site established in doc 31 or trivially known (`authorize` is called everywhere).

### Run 1 — ⛔ the known positive FAILED

`seedAttendanceConfig` came back **production-reachable**, on exactly one hit:
`packages/db/schema/attendance-config.ts:117`.

⭐ **That line is a comment — and it is the very comment DEF-249 exists to say is untrue.** The
scanner was counting prose as a call site. Left unfixed, this flaw biases the census in the dangerous
direction: it *hides* test-only functions by crediting them with imaginary callers, so the census
would have reported a comfortingly small number.

Fix: a character-level stripper that blanks line comments, block comments and string literals while
preserving line/column positions — keeping `${...}` inside template literals, because that is real
code.

### Run 2 — ⛔ the known NEGATIVES failed

`adjudicateDay`, `previewPayRun`, `recordPunch` and `sweepStore` all came back **test-only**, which is
provably false — doc 31 pins their callers at `ingestor.ts:334`, `payroll/lib.ts:27` and the
scheduler.

⭐ **Cause, and it is a good one: the fix for run 1 broke run 2.** Stripping string literals blanked
the quotes in `from '...'`, so the import-detector's exit condition (`/from\s*['"]/`) never matched,
`inImport` latched true at the first import, and **every remaining line of every file was
misclassified as an import** — i.e. silently discarded. A near-total scan failure that produced a
plausible-looking list rather than an error.

Fix: detect imports and re-exports from the **raw** text, match symbols against the **stripped** text.

### Run 3 — ✅ PASSES

| Symbol | prod (other file) | prod (same file) | test refs | verdict | expected |
|---|---:|---:|---:|---|---|
| `seedAttendanceConfig` | 0 | 0 | 23 | **TEST-ONLY** | ✅ positive fires |
| `getLiveConfig` | 0 | **1** | 2 | production-reachable | ✅ (via `supersedeConfig`, `config.ts:74` — same file, exactly as doc 31 found) |
| `adjudicateDay` | 2 | 1 | 18 | production-reachable | ✅ |
| `previewPayRun` | 1 | 1 | 24 | production-reachable | ✅ |
| `recordPunch` | 1 | 0 | 11 | production-reachable | ✅ (`ingestor.ts:334`) |
| `sweepStore` | 1 | 0 | 6 | production-reachable | ✅ (`scheduler/index.ts:349`) |
| `supersedeConfig` | 1 | 0 | 30 | production-reachable | ✅ |
| `derivePeriods` | 2 | 1 | 17 | production-reachable | ✅ |
| `postEntry` | 46 | 0 | 82 | production-reachable | ✅ |
| `authorize` | 263 | 0 | 30 | production-reachable | ✅ |

⭐ **The `getLiveConfig` row is the sharpest single control result**: the scanner independently
reproduced doc 31's finding that its only production caller is in its own file. That is a
non-trivial, previously-established fact recovered by a different method.

⚠️ **Two failed runs, both of which produced a complete, plausible, wrong list rather than an error.**
Neither would have been caught by looking at the output. That is the argument for the control, and it
is why §0's numbers should be read as "controlled", not merely "computed".

---

## 2. Method, and what counts as a production caller

Script: `census.mjs`, run from a scratchpad directory outside the repo. It reads; it writes nothing.

**Scanned:** `packages/**`, `apps/**`, `scripts/**`, `tests/**`, `firebase/**`, `spike/**`.
**Excluded:** `node_modules`, `.next`, `dist`, `build`, `coverage`, `.d.ts`.

**A file is a TEST file** if its path contains `/tests/` or `/__tests__/`, or it matches
`*.test.ts(x)` / `*.spec.ts(x)`. **Everything else is production**, and that deliberately includes:

- ⭐ `scripts/**` — a script is a production caller. The nightly jobs live there.
- ⭐ `packages/domain/src/scheduler/**` — a scheduler-only caller **is** a production caller.
- `apps/erp/**`, every package `src/`, `packages/db/schema/**`, `firebase/**`.

`spike/**` is counted as neither and reported separately; nothing in the 59 depends on it.

**A reference counts as a call site** unless it is: the declaration line itself; a line inside an
`import` statement (single- or multi-line); or a re-export (`export * from`, `export { … } from`,
including the multi-line form). Everything else counts — **including a bare reference with no
parentheses**, which is essential: a Next.js server action reaches a form as `action={fooAction}`,
never as `fooAction(`. A parenthesis-only matcher would have invented dozens of orphans.

### The false-positive classes the brief named, and how each is handled

| Class | Handling | Verified |
|---|---|---|
| **Barrel re-exports** | `export { x } from './y'` is classified `reexport`, never a call | ✅ `endShift` shows `packages/auth/src/index.ts:30` as a re-export and stays test-only |
| **Repo namespace objects** (`schedulerRepo.x`) | matcher is `\bNAME\b`, so `attendanceConfigRepo.findLive(` matches `findLive` | ✅ `sweepStore`, `postEntry`, `authorize` all resolve through namespace call sites |
| **Dynamic dispatch / registries** | a function used as a value (`{ job: runSweep }`) is a bare reference and counts | ✅ by construction; none of the 59 is string-dispatched |
| **Script / scheduler callers** | classified production, not test | ✅ `sweepStore` is production-reachable **solely** via the scheduler |
| **Framework entry points** | `GET`, `proxy`, `page.tsx` default exports have no in-repo caller by design | ⚠️ handled in triage, §4.0 — **not** counted as dead |
| **Comments and doc prose** | stripped before matching | ⛔ this is what run 1 failed on; see §1 |

### ⚠️ Known limits of the method — stated because they bound the number

1. **Name-based, not resolver-based.** Two different exported functions sharing a name are merged;
   the scanner records the collision but does not disambiguate. A shared name can therefore make a
   test-only function *look* reachable. This biases toward **under**-reporting, i.e. 59 is a floor.
2. **JSX text is not stripped.** Prose rendered inside a `<p>` that happens to contain an exported
   function's exact name would count as a reference. Same direction: under-reports.
3. **A function used only inside its own file** counts as production-reachable (`prodSelf`). That is
   right for reachability and wrong for "should this be exported"; a separate question, not asked.
4. **No type-checker, no build.** This is textual analysis, which is why §1's control matters and why
   the 16 hand-verifications in §3 and §5 exist.

---

## 3. The count and the list

### 3.1 Fifty-nine exported functions whose only call sites are tests

Sorted by test-reference count. `refs` = test references, `files` = distinct test files.

| refs | files | Function | Declared at |
|---:|---:|---|---|
| 25 | 12 | `seedCanonicalPositions` | `packages/domain/src/people/index.ts:256` |
| 23 | 10 | `seedAttendanceConfig` | `packages/domain/src/attendance/config.ts:114` ← **DEF-249** |
| 22 | 2 | `depreciateAsset` | `packages/domain/src/fixed-assets/depreciate.ts:86` |
| 12 | 4 | `activateTerminal` | `packages/domain/src/attendance/terminals.ts:115` ← **§5.1** |
| 11 | 3 | `setItemPricing` | `packages/domain/src/items/index.ts:529` |
| 10 | 1 | `linkInvoiceToReceipt` | `packages/domain/src/stock/invoice-link.ts:131` |
| 10 | 2 | `convertSpecimen` | `packages/etl/src/convert.ts:586` |
| 9 | 2 | `allocate` | `packages/core/src/money.ts:112` |
| 9 | 4 | `setTillFloat` | `packages/domain/src/money-accounts/index.ts:272` |
| 9 | 1 | `runAnalyze` | `packages/etl/src/run.ts:206` |
| 8 | 1 | `periodDue` | `packages/domain/src/fixed-assets/schedule.ts:89` |
| 7 | 1 | `tilesTheMonth` | `packages/domain/src/payroll/periods.ts:95` |
| 7 | 1 | `singleRoomViolation` | `packages/domain/src/stock-locations/rules.ts:115` |
| 6 | 2 | `setCostBasisItem` | `packages/domain/src/items/index.ts:576` |
| 6 | 1 | `periodForDate` | `packages/domain/src/payroll/periods.ts:118` |
| 6 | 1 | `realSourceTypesForSpecName` | `packages/etl/src/leg-mapping.ts:593` |
| 5 | 1 | `isStartDecisionMaterial` | `packages/domain/src/attendance/adjustments.ts:201` |
| 5 | 2 | `payReimbursement` | `packages/domain/src/expenses/reimbursement.ts:34` |
| 5 | 2 | `declareSupplierItem` | `packages/domain/src/items/index.ts:233` |
| 5 | 1 | `assertUsageSource` | `packages/domain/src/stock-locations/rules.ts:61` |
| 5 | 1 | `sampleCandidates` | `packages/etl/src/capture.ts:238` |
| 5 | 1 | `runCapture` | `packages/etl/src/capture.ts:274` |
| 4 | 1 | `elevateManager` | `packages/auth/src/roles.ts:596` ← **correct, §4.4** |
| 4 | 2 | `readFileUrl` | `packages/domain/src/files/index.ts:157` |
| 4 | 2 | `depreciationDrift` | `packages/domain/src/fixed-assets/depreciate.ts:277` |
| 4 | 1 | `listRoster` | `packages/domain/src/people/index.ts:251` |
| 4 | 2 | `undoWriteOff` | `packages/domain/src/prepaid/index.ts:449` |
| 4 | 1 | `runLoad` | `packages/etl/src/run.ts:217` |
| 3 | 1 | `rateFor` | `packages/db/src/repo/customers.ts:309` |
| 3 | 1 | `undepositedFunds` | `packages/db/src/repo/money-accounts.ts:323` |
| 3 | 1 | `tablesWithScope` | `packages/db/src/rls/registry.ts:848` |
| 3 | 1 | `listOrderMessages` | `packages/domain/src/commissary/messages.ts:56` |
| 3 | 1 | `sweepOrphanedFiles` | `packages/domain/src/files/index.ts:200` |
| 3 | 1 | `expectedAccumulated` | `packages/domain/src/fixed-assets/schedule.ts:106` |
| 3 | 2 | `undeclareSupplierItem` | `packages/domain/src/items/index.ts:264` |
| 3 | 2 | `previewDrawingClose` | `packages/domain/src/owners/index.ts:548` |
| 3 | 2 | `reverseOwnerEntry` | `packages/domain/src/owners/index.ts:698` |
| 3 | 1 | `isConvertibleUnit` | `packages/domain/src/production/unit-conversion.ts:71` |
| 3 | 1 | `returnableQuantity` | `packages/domain/src/stock/supplier-returns.ts:328` |
| 3 | 2 | `addUsageLine` | `packages/domain/src/stock/usage-records.ts:207` |
| 3 | 2 | `removeUsageLine` | `packages/domain/src/stock/usage-records.ts:224` |
| 3 | 2 | `confirmTradeOrder` | `packages/domain/src/trade/index.ts:285` |
| 3 | 1 | `customerReturnableQuantity` | `packages/domain/src/trade/returns.ts:104` |
| 3 | 1 | `__setPhase5AvailableForTests` | `packages/domain/src/wastage/orders.ts:75` |
| 2 | 1 | `endShift` | `packages/auth/src/sessions.ts:236` |
| 2 | 1 | `formatBusinessDateTime` | `packages/core/src/datetime.ts:110` |
| 2 | 1 | `upsertCategoryLife` | `packages/db/src/repo/fixed-assets.ts:168` |
| 2 | 1 | `listAdjustments` | `packages/domain/src/attendance/adjustments.ts:139` |
| 2 | 1 | `summarizeConversions` | `packages/etl/src/report.ts:83` |
| 1 | 1 | `listWriteOffsForCharge` | `packages/db/src/repo/ar.ts:628` |
| 1 | 1 | `upsertPolicy` | `packages/db/src/repo/fixed-assets.ts:122` |
| 1 | 1 | `recentRuns` | `packages/db/src/repo/scheduler.ts:114` |
| 1 | 1 | `reconcileSupplier` | `packages/domain/src/ap/index.ts:207` |
| 1 | 1 | `adjudicateRange` | `packages/domain/src/attendance/adjudicate.ts:232` ← **§5.2** |
| 1 | 1 | `findPostedSettlementForChannelDay` | `packages/domain/src/channel-settlements/index.ts:647` |
| 1 | 1 | `capitalizeFromExpense` | `packages/domain/src/fixed-assets/capitalize.ts:141` |
| 1 | 1 | `deactivateItem` | `packages/domain/src/items/index.ts:101` |
| 1 | 1 | `pendingItemRequests` | `packages/domain/src/items/index.ts:449` |
| 1 | 1 | `createRecipe` | `packages/domain/src/production/index.ts:109` |

By area: **`packages/domain` 41 · `packages/db` 7 · `packages/etl` 7 · `packages/core` 2 ·
`packages/auth` 2 · `apps/erp` 0.**

⭐ **`apps/erp` contributes zero, and that is informative rather than reassuring**: the app layer has
no test-only exports because it has comparatively few tests. The hole is entirely in the packages —
which is where the business rules live.

⚠️ **Test weight is not evidence of importance, and can be evidence of the opposite.** The top three
are 25, 23 and 22 test references — and one of them is DEF-249, one is `depreciateAsset` (a
superseded single-asset path the screen and the scheduler both bypass, §4.3), and one is
`seedCanonicalPositions`. Seventy assertions defending three functions nothing calls.

### 3.2 Fifty-two exported functions with no reference anywhere

Full list in the census output; the ones that matter are triaged in §4.0 and §5.3. Distribution:
**`packages/db` 32 · `packages/domain` 8 · `apps/erp` 6 · `packages/core` 3 · `packages/etl` 3.**

⭐ The `packages/db` concentration is expected and mostly benign: a repo module exports a query
surface, and not every query has found its screen yet. `apps/erp`'s six are the interesting ones.

---

## 4. Triage — the rule, and the buckets

⭐ **The rule, and it is the reason this was worth an Opus terminal:**

> **"No production caller" is a fact. "No production caller **and** something claims otherwise" is a
> defect.** The first is a schedule; the second is a lie the next reader will believe.

Applied, the 59 fall into five buckets.

### 4.0 Not dead at all — framework entry points (10 of the 52)

`GET` (nine route handlers: `api/health/route.ts:32` and eight `reports/*/export/route.ts`) and
`proxy` (`apps/erp/src/proxy.ts:21`). Next.js invokes these by file convention. **Any guard that
does not exempt them starts life with ten false positives**, which is how guards get switched off.
Recorded here so the next person does not have to rediscover it.

### 4.1 ⛔ Bucket A — a claim without a caller. **3 found. These are the defects.** → §5

`activateTerminal`, `adjudicateRange`, `depreciateAsset`.

### 4.2 Bucket B — a real capability with no reachable surface (≈24)

Domain functions implementing something a user would want, where a screen for that area **exists**
and does not offer it. Verified by reading the sibling `actions.ts` imports for four of them:
`items` imports only `createItem` / `setStoreSellability`; `inventory/production` only
`createProductionDraft`; `money-accounts` only `createMoneyAccount`; `trade` imports nothing matching.

Examples: `setItemPricing`, `setCostBasisItem`, `declareSupplierItem`, `undeclareSupplierItem`,
`deactivateItem`, `pendingItemRequests`, `createRecipe`, `confirmTradeOrder`, `setTillFloat`,
`payReimbursement`, `linkInvoiceToReceipt`, `addUsageLine`, `removeUsageLine`, `undoWriteOff`,
`previewDrawingClose`, `reverseOwnerEntry`, `capitalizeFromExpense`, `reconcileSupplier`,
`sweepOrphanedFiles`, `listRoster`, `seedCanonicalPositions`, `readFileUrl`, `listAdjustments`,
`listOrderMessages`.

⚠️ **This bucket is NOT a defect list.** This project builds the domain rule first and the screen
after, on purpose, and `docs/CAPABILITY-GAPS.md` already exists for capabilities nobody owns. What
this census adds is that the gap is **countable**: roughly 24 built-and-unreachable capabilities,
each already tested, each one screen away. That is a phase-planning input, not a bug queue.
⛔ I did **not** hand-verify all 24 — four screens were read. The bucket size is an estimate from
names plus those four; treat ±3 as within the error of this pass.

### 4.3 Bucket C — pure helpers and predicates tested directly (≈21)

`tilesTheMonth`, `periodForDate`, `periodDue`, `expectedAccumulated`, `isConvertibleUnit`,
`returnableQuantity`, `customerReturnableQuantity`, `singleRoomViolation`, `assertUsageSource`,
`isStartDecisionMaterial`, `depreciationDrift`, `allocate`, `formatBusinessDateTime`, `rateFor`,
`undepositedFunds`, `tablesWithScope`, `upsertPolicy`, `upsertCategoryLife`, `recentRuns`,
`listWriteOffsForCharge`, `__setPhase5AvailableForTests`.

Mostly benign and some are actively good practice — `tilesTheMonth` (`periods.ts:95`) exists
**specifically** to make an invariant checkable, and its own doc says so; `__setPhase5AvailableForTests`
is honestly named. Two are worth a second look:

- ⚠️ **`allocate` (`packages/core/src/money.ts:112`)** — the remainder-distributing money split, a
  primitive, zero production callers. Production uses `allocateFifo`
  (`packages/domain/src/remittance/allocate.ts`), a different function for a different job. So the
  canonical "split money N ways without losing a centavo" helper is unused. Not a bug — but the next
  person who needs to split money should be pointed at it rather than writing a third one.
- ⚠️ **`depreciateAsset`** is in Bucket A instead (§5.3) because of the claim attached to it.

### 4.4 ⭐ Bucket D — declared not-yet-wired, and **this is the model**

**`elevateManager` (`packages/auth/src/roles.ts:596`)** — zero production callers, and its own doc
comment says, verbatim:

> *"Tagged now, while this function has zero production callers, so it cannot become a second silent
> gap the day a console action finally calls it."*

The author knew, wrote it down, named the future caller ("a super-admin console action"), and stated
what that caller must do first (`authorize` for `manage_users`). **A reader cannot be misled by
this.** Contrast it with `schema/attendance-config.ts:117`, which asserted the opposite of the truth
and cost this project two lanes and two documents to unpick.

⛔ **This is the shape any fix should standardise on**, and it is the only thing in this census a
mechanical guard can actually key off (§6).

### 4.5 Bucket E — an entire package nothing consumes

⭐ **`grep -rn "@shareat/etl'" packages apps scripts` (excluding tests) returns NOTHING.** All seven
of the `packages/etl` entries — `convertSpecimen`, `runAnalyze`, `runLoad`, `runCapture`,
`sampleCandidates`, `summarizeConversions`, `realSourceTypesForSpecName` — plus three of the 52
zero-reference exports, are unreached because **no production code imports the package at all.**

⚠️ **Not a trap to fall into: `scripts/capture.ts` exists and looks like the caller, and is not.** It
imports `packages/etl-firestore/src/plan` — a *different* package. `packages/etl` has no `bin` entry
and no consumer. It may be a parked or superseded package; that is a question for whoever owns
Phase 1, not a defect I can assert. **Reported, not diagnosed.**

---

## 5. ⛔ The three real findings — a claim with no caller

### 5.1 ⭐ No clock terminal can ever report itself as paired

**`activateTerminal` (`packages/domain/src/attendance/terminals.ts:115`) has zero production
callers** — 12 test references across 4 files, and nothing else.

It is the **only** caller of `clockTerminalsRepo.markActivated`
(`packages/db/src/repo/clock-terminals.ts:44`, verified: exactly two references, the definition and
`terminals.ts:121`), which is the **only** writer of `activated_at`. And `isReady`
(`terminals.ts:171`) is `activatedAt !== null && revokedAt === null`.

⛔ **So `activated_at` is never set, and therefore:**

- `apps/erp/src/app/attendance/terminals/page.tsx:36-37` shows every terminal as
  *"Provisioned — not yet paired. Cannot punch."* — permanently, for every terminal, forever.
- `terminalStatus` (`packages/domain/src/sync/health.ts:198-201`) classifies every terminal as
  **`never_paired`** — permanently. Its own doc comment (`health.ts:190-196`) says *"A terminal that
  was never paired is a provisioning job somebody has not finished"*, so lane health will report a
  standing provisioning backlog that no amount of provisioning can clear.

⚠️ **And the screen's sentence is FALSE in the safe direction, which is its own small finding.** The
ingestor does **not** gate on activation — `ingestor.ts:261-275` checks `!terminal`, `revokedAt` and
`storeId` mismatch, and never reads `activatedAt` (verified: `grep -n "activatedAt" ingestor.ts`
returns nothing). So a terminal that the UI says *"Cannot punch"* **can punch perfectly well**. The
status display is wrong, not the clock.

⛔ **The claim.** `apps/erp/src/app/attendance/terminals/page.tsx:41-45` — T-203's own header —
states it closed DEF-133 by giving `provisionTerminal` / `activateTerminal` / `revokeTerminal` /
`mintTerminalToken` the callers they lacked. Its `actions.ts:22` imports **three of the four**;
`activateTerminal` is not imported and not called. **DEF-133's fix left one of its own four functions
exactly as it found it, and wrote a comment saying otherwise.**

⚠️ **What I could NOT establish:** whether `activateTerminal` was *meant* to be called by the device
itself over an API route (its doc at `:108-114` says *"No `authorize()`: the caller is the device
itself"*, which implies a route, not a screen). I found no such route. Whether one was planned, cut,
or forgotten is not answerable from the code. **Not diagnosed — reported.**

### 5.2 `adjudicateRange` claims two callers and has neither

**`packages/domain/src/attendance/adjudicate.ts:232`**, one test reference, zero production callers.
Its own doc comment at `:231` reads:

> *"Recompute every person-day in a store over a range. **Used by the review screen and the sweep.**"*

Neither is true. `apps/erp/src/app/attendance/actions.ts` does not call it, and the sweep
(`sweepStore`, `packages/domain/src/attendance/sweep.ts:110`) settles statuses directly via
`markNeedsReview` and never recomputes. ⚠️ A second comment in the same file (`adjudicate.ts:135`)
reasons at length about `adjudicateRange`'s behaviour *"including `adjudicateRange`, the sweep"* — so
the false belief is load-bearing in the file's own explanation of a DEF-115 fix.

### 5.3 `depreciateAsset` is named as a caller's dependency and is bypassed by both real paths

**`packages/domain/src/fixed-assets/depreciate.ts:86`**, 22 test references across 2 files, zero
production callers — the third-heaviest tested function in the census.

`apps/erp/src/app/fixed-assets/actions.ts:8` states: *"No business rule is re-implemented here —
`createAsset` / **`depreciateAsset`** / `runDepreciation` / `disposeAsset` own every invariant."*
Its actual import at `:16-21` is `createAsset`, `disposeAsset`, `runDepreciation` — **not**
`depreciateAsset`. The scheduler uses a third function again, `runDepreciationAsSystem`
(`scheduler/index.ts:34,247`).

⚠️ **Stated carefully: this is the mildest of the three.** Depreciation itself works — two live paths
run it. `depreciateAsset` looks like a superseded single-asset variant, and `runDepreciation` does not
call it internally either (or the census would have scored it `prodSelf`). The defect is that 22
assertions defend a function no path uses, while a comment tells the next reader it is load-bearing.

---

## 6. ⚠️ What a guard would have to do — and honestly, whether it can

**Asked directly, so answered directly: a mechanical guard cannot catch what DEF-249 actually was.**

### 6.1 What is NOT mechanically checkable

DEF-249's defect was `schema/attendance-config.ts:117` **asserting in English** that
`seedAttendanceConfig` is called at store creation. §5's three findings are the same: a doc comment
naming a caller that does not exist. **Detecting that requires understanding a natural-language claim
about the code**, and no lint rule does that. Anything claiming to is a guard that will pass
vacuously — which this project has already shipped twice (DEF-245's `--reporter=basic` that died
loading and still exited 0; DEF-240's install-loop-with-a-hand-written-list).

### 6.2 What a naive guard would do, and why it must not be built

A rule of *"every exported function needs a caller outside `tests/`"* fires **111 times on day one**
(59 + 52). Of those:

- 10 are framework entry points and simply wrong (§4.0);
- ~45 are legitimately ahead of their screens (§4.2, §4.3);
- 1 — `elevateManager` — is **correct and documented as such** and would be flagged anyway;
- 3 are the real findings.

⛔ **A guard that is 97% false positives gets an `eslint-disable` on the same afternoon**, and then
the fourth DEF-249 ships under a suppression comment. That outcome is strictly worse than no guard,
because it converts an open question into a silenced one.

### 6.3 What IS buildable — a ratchet over declared intent

Three parts, in order of value:

1. ⭐ **A ratchet, not a rule.** Freeze today's census as a checked-in baseline of names. The build
   fails only when a **new** export joins the zero-production-caller set. That is precisely the case
   the orchestrator caught by hand on 2026-09-10 (a recorder with no callers), and it is cheap: no
   judgement, no suppression pressure, and the 111 existing entries are burned down deliberately
   rather than urgently. ⚠️ The baseline file is the half that rots — DEF-240's exact lesson, *"a fix
   that globs the machinery but leaves the neighbouring human instruction hand-maintained has moved
   the defect"* — so the baseline must be **regenerated by the guard itself**, never hand-edited.
2. **A declared-intent marker.** `elevateManager` (§4.4) already shows the shape. Require a new
   zero-caller export to carry an explicit marker — a `@notYetWired` tag naming the intended caller
   and the task — to clear the ratchet. This turns an invisible gap into a greppable one, which is
   the entire difference between `elevateManager` and `seedAttendanceConfig`.
3. **Exemptions that must be declared, not inferred**: route-handler names (`GET`/`POST`/…), `proxy`,
   `page.tsx` / `layout.tsx` default exports, and any name in a package's `exports` map.

⛔ **Three things the guard MUST get right or it will report the wrong answer**, all three learned the
hard way in §1:

- **Strip comments and strings before matching**, or prose counts as a caller and the census shrinks.
- **Detect imports from raw text**, or the stripper silently voids the whole scan.
- **`scripts/` and the scheduler are PRODUCTION.** A guard that counts only `apps/` would flag
  `sweepStore`, whose sole caller is the scheduler — and flagging a correct function is how a guard
  loses its authority.

### 6.4 The cheaper thing that catches more

⭐ **The census itself, re-run and diffed, is worth more than a build-time rule** — it is one command,
it needs no suppression mechanism, and it produced three findings in an afternoon. Running it at each
phase boundary (or inside `/daily-review`, which already appends to the register) would have caught
DEF-226, DEF-227 and DEF-249 before any of them cost a lane. **Recommendation: schedule the pass,
ratchet the count, and do not build the lint rule.**

---

## 7. ⛔ What this census did NOT establish

Stated deliberately, as last time, because it stops a stronger claim than the evidence supports.

1. **This is textual analysis, not a type-resolved call graph.** No `tsc` program, no import
   resolution. Two exported functions sharing a name are merged (§2 limit 1), which can make a
   test-only function look reachable. **59 is a floor, not an exact count.**
2. **I hand-verified 16 of the 59, not all of them.** Verified individually: `seedAttendanceConfig`,
   `getLiveConfig`, `activateTerminal`, `adjudicateRange`, `depreciateAsset`, `elevateManager`,
   `endShift`, `signOutAction`, `voidPaymentAction`, `editPostedProductionAction`, `applyCreditAction`,
   `withPrincipal`, `allocate`, `deactivateItem`, `createRecipe`, `confirmTradeOrder`. The remaining
   43 rest on the controlled scanner alone.
3. **Bucket B's size (~24) is an estimate**, from names plus four screens actually read. Not a
   verified figure.
4. **I did not establish WHY any of these lack callers.** Whether `packages/etl` is parked, whether
   `activateTerminal` was meant to have an API route, whether `depreciateAsset` was deliberately
   superseded — none of that is in the code. Reported, not diagnosed.
5. **`packages/db/src/client.ts` is a peer lane's live file** (`closeSystemDb`, `client.ts:148`,
   appears in the zero-reference list). I read it only through the scanner and did not touch it; its
   contents may have changed since. Same caveat as doc 31 carried for `scheduler/index.ts`.
6. **No test was run, no gate executed, nothing built.** This lane was told not to, and did not.
7. **Production was not queried and is irrelevant here** — this census is a property of the source
   tree, not of any database. Noted so nobody looks for a data column that does not apply.

---

## 8. New findings, `reported` — for the orchestrator to file

| # | Finding | Where |
|---|---|---|
| 1 | ⭐ **`activateTerminal` has zero production callers, so `activated_at` is never written and NO terminal can ever report as paired.** Every terminal shows *"Provisioned — not yet paired. Cannot punch."* forever and lane health reports `never_paired` forever — while the ingestor never gates on activation, so those terminals **can** punch. A permanent, universal status lie. T-203's own header claims it gave this function a caller | `packages/domain/src/attendance/terminals.ts:115`; `packages/db/src/repo/clock-terminals.ts:44`; `apps/erp/src/app/attendance/terminals/page.tsx:36,41-45`; `packages/domain/src/sync/health.ts:198-201` |
| 2 | **`adjudicateRange`'s doc comment names two callers — "the review screen and the sweep" — and has neither.** The false belief is reused in the same file's DEF-115 reasoning at `:135` | `packages/domain/src/attendance/adjudicate.ts:231-232, 135` |
| 3 | **`depreciateAsset` is named in the fixed-assets actions header as one of the four domain functions it adapts, and is not imported or called** by that file or the scheduler; both use different functions. 22 test assertions defend it | `apps/erp/src/app/fixed-assets/actions.ts:8,16-21`; `packages/domain/src/fixed-assets/depreciate.ts:86` |
| 4 | ⭐ **There is no sign-out anywhere in the ERP.** `signOutAction` exists and is correct — it calls `signOut` and ends the server session — and **no screen references it**. `grep -rn "signOut\|Sign out" apps/erp/src` returns only its own definition, its import, and one unrelated comment. A user cannot log out | `apps/erp/src/app/sign-in/actions.ts:107,112` |
| 5 | **Three more server actions are wired to nothing**: `voidPaymentAction` (`ap/actions.ts:273`), `editPostedProductionAction` (`inventory/production/actions.ts:107`), `applyCreditAction` (`trade/returns/actions.ts:57`). Each is a complete, gated action with no form that invokes it | as listed |
| 6 | **Nothing in production imports `@shareat/etl`.** The whole package's public surface is consumed only by its own tests. Possibly parked, possibly superseded by `packages/etl-firestore` — ⚠️ note the near-miss that `scripts/capture.ts` imports the *other* package | `packages/etl/package.json`; `packages/etl/src/{capture,run,convert,report,leg-mapping}.ts` |
| 7 | **`withPrincipal` (`packages/db/src/rls/principal.ts:72`) has no references at all — and its own comment at `:86` says so**, recording that "the same five lines were re-implemented" elsewhere; `apps/erp/src/app/expenses/lib.ts:143` confirms the canonical helper is bypassed. Self-documented dead code, already known, never removed | `packages/db/src/rls/principal.ts:72,86` |
| 8 | ⭐ **`allocate` (`packages/core/src/money.ts:112`), the canonical remainder-safe money split, has no production caller.** Not a bug; worth knowing before someone writes a third one | `packages/core/src/money.ts:112` |

---

## FOR IAN

**The question was: how many functions in this system are tested but never actually used by the
running app? The answer is 59, plus another 52 that nothing references at all.**

Most of that is not a problem, and I want to be clear about it before the number alarms anyone. This
project deliberately builds the business rule first and the screen for it later, so a rule with no
screen yet is a plan, not a bug. Roughly 24 of the 59 are exactly that — real capabilities, already
tested, each one screen away from being usable. That is a useful thing to have counted for planning.

**Three are genuine defects, and they share DEF-249's exact fingerprint: a comment claiming the
function is wired up when it is not.** The worst one: no clock terminal in the system can ever
register itself as "paired". The admin screen will always say every terminal is *"not yet paired —
cannot punch"*, and the health monitor will always report a provisioning backlog, no matter how much
provisioning anyone does. ⚠️ The reassuring half: the terminals **can** actually punch — the punch
path never checks the pairing flag — so this is a wrong display, not broken time-keeping. But a
monitor that permanently cries wolf is a monitor people stop reading.

**Separately, and I did not go looking for it: there is no way to sign out of the ERP.** The
sign-out code exists and is correct; no button anywhere calls it. Three other buttons' worth of
functionality is orphaned the same way (voiding an AP payment, editing a posted production record,
applying a credit on a trade return).

**On the guard you asked about — I'd recommend not building it, and here is the honest reason.** A
build-time rule saying "every function needs a real caller" would fire 111 times on the first run and
be wrong about roughly 108 of them, including one function that is *correct* and says so in its own
comment. A check that noisy gets switched off within a day, and then the next one of these ships
underneath the suppression — worse than having no check. What I'd do instead is cheap: run this
census at each phase boundary and only fail when the number **grows**. That is one command, it needs
no judgement, and it would have caught all three of the previous cases before they cost a lane a day.

⚠️ **Limits, so nobody over-reads this:** the census is text analysis, not a compiler-grade call
graph, so 59 is a floor rather than an exact figure; I hand-checked 16 of them individually and the
rest rest on the tool. And the tool was wrong twice before it was right — both times producing a
complete, plausible, wrong answer rather than an error, which is why the control section is first in
the document rather than last.
