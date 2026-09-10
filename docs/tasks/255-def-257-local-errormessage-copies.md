# T-255 — DEF-257: the 42 hand-copied `errorMessage` fallbacks

> **Status: BUILT — lane C (`webapps-66`, Opus 5), 2026-09-10. Spec round 1 approved by the
> orchestrator; the 42-file widening in §1a approved separately before implementation. §10 records
> what shipped.**

## 0. What this is, in one sentence

42 files under `apps/erp/src` each carry their own private copy of the sanitising fallback that
T-252 fixed once in `apps/erp/src/lib/constraint-messages.ts`; delete all 42 copies of **the
fallback** and route each file's last line into the one shared implementation — while leaving in
place the screen-specific translation each file does *above* that line, which the shared module
has no mechanism for and would regress if deleted.

See `docs/DEFECTS-REGISTER.md` DEF-257 and DEF-246, and **PROJECT_BIBLE.md §13 row 189**.

---

## 1. ⛔ Re-measurement — three of the briefed counts are wrong

Every number below was measured against the tree at the time of writing, not read from a register
row. Method is given so it can be re-run.

| Claim | Briefed | Measured | Verdict |
|---|---|---|---|
| Files defining a local `errorMessage`/`errorMessageOf` | 39 | **38** | ⛔ **Off by one.** The 39th match is `apps/erp/src/lib/constraint-messages.ts:107` — the shared implementation itself. It is the thing being converged *on*, not a copy of it. The spec's own title (`~38`) was right; DEF-257's body (`39`) counts the original as a duplicate of itself. |
| Files referencing the shared module | 10 (register) / 13 (orchestrator, "stale, T-252 moved it") | **10 importers**, 13 string-matches under `src`, 15 including tests | ⚠️ **Both numbers are right about different things, and nothing moved.** 10 files `import` from the module (9 import `errorMessage`; `lib/pre-session-message.ts` imports only `CONSTRAINT_MESSAGES`). The other 3 of the 13 are *comments* mentioning the filename — `inventory/counts/actions.ts:43`, `inventory/locations/actions.ts:33`, `settings/attendance/lib.ts:27`. The register's 10 is the correct importer count and is **not stale**. |
| "2 more duplicate the `CONSTRAINT_MESSAGES` loop with a screen-specific map" | unverified by orchestrator | **True, but they are not "2 more"** | ⚠️ `remittance/actions.ts` and `till/actions.ts` do each keep a private `CONSTRAINT_MESSAGES` + loop — **and both also define a local `errorMessage`, so they are already inside the 38.** The briefed phrasing ("39 … 2 more") implies 41 distinct files. The true population is **38**. |

**Method (re-runnable):**

```bash
# the 38
grep -rl "function errorMessage\|function errorMessageOf" apps/erp/src --include=*.ts \
  | grep -v "lib/constraint-messages.ts" | wc -l
# the 10 importers
grep -rln "from '.*lib/constraint-messages'" apps/erp/src --include=*.ts | wc -l
# the 2 private maps
grep -rn "^const CONSTRAINT_MESSAGES" apps/erp/src --include=*.ts
```

**Corrected census: 38 local copies, 10 shared-module importers, 0 files outside `apps/erp/src`**
(`apps/pos`, `apps/customer`, `apps/website` and every package are clean — checked).

## 1a. ⛔ …and then the census above turned out to be MY spelling error

Everything in §1 counts files that **declare `function errorMessage`**. Writing §6's guard
shape-first — matching the regex literal rather than the function name — found **four more**, which
inline the identical two lines in a `catch` block and never name them:

| File | Line | Shape |
|---|---|---|
| `app/attendance/[dayId]/actions.ts` | 61 | `back(dayId, { error: raw.replace(…) })` |
| `app/payroll/lib.ts` | 31 | `return { preview: null, error: raw.replace(…) }` |
| `app/payroll/separations/lib.ts` | 31 | same |
| `app/payroll/thirteenth-month/lib.ts` | 23 | same |

**This is DEF-243's "count the shape, not the spelling" landing on the person who had just used it
to correct someone else's string-match.** A name census cannot see a copy that was never given a
name; a guard asserting *zero occurrences of the shape* can. Reconciled: 38 named copies − 5 that
strip nothing (`expenses`, `fixed-assets`, `sales-days`, `admin/stores`, `statutory-discounts`) = 33
with a strip, + 4 inline = **37 files carrying the strip, 46 occurrences**, + the 5 that leak by
returning the message untouched = **42 files in scope**.

⭐ **The location is a finding in its own right, and it is E2's second paragraph.**
`payroll/lib.ts`, `payroll/separations/lib.ts` and `payroll/thirteenth-month/lib.ts` sit in the
**same three directories** as `payroll/actions.ts`, `payroll/separations/actions.ts` and
`payroll/thirteenth-month/actions.ts` — three of the nine files that already import the shared
module. The domain best covered by the shared implementation is the domain hiding the copies. That
is structurally identical to DEF-246's own drift proof (`store_attendance_config_payout_lag_check`
unmapped while 19 siblings on the same table were covered), and two independent instances of *the
map went stale inside its own best-covered domain* is a pattern, not a coincidence.

⚠️ Widening the file list beyond §3 was declared to the orchestrator under RULES §3.3 and approved
before any of the four was touched. The reason it is not optional: §6's guard asserts **zero**, so
four survivors would force a four-entry exception list — and a hand-maintained exception list is the
artefact this task exists to delete.

---

## 2. ⭐ The finding that reframes the task: these are not 38 copies of a constraint map

Grouping the 38 bodies by content hash (`awk` the function, `md5sum` it) gives **two populations**,
not one:

| Population | Files | What the body is |
|---|---|---|
| **A — pure fallback, nothing else** | **17** | Two shapes only: `raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '')` (15 files) and `return err instanceof Error ? err.message : String(err)` (2 files — `expenses`, `fixed-assets`). Byte-identical within each shape. |
| **B — fallback plus screen-specific branches** | **21** | A chain of `if (/…/.test(raw)) return '…'` **above** the same fallback. |

**⛔ And the branches in population B are overwhelmingly NOT constraint messages.** Counted across
all 21 files, the branch chains are:

| Branch kind | Roughly | Example |
|---|---|---|
| **Authorization / role translation** — `may not '<capability>'`, `no store scope`, `outranks you`, `requires super_admin`, `only active admin`, `authorize:` | ~45 branches, in 17 of the 21 files | `'Only a manager or admin can post — a floor worker can draft, but posting is what moves stock and the books.'` |
| **Domain-sentence pass-through** — the domain already threw English; the branch returns it verbatim or strips the prefix | ~20 branches | `staff/actions.ts`: 7 consecutive `return raw` branches |
| **True constraint-name branches** — the only thing `CONSTRAINT_MESSAGES` could ever hold | **29 branches / 27 distinct constraint names**, in 10 files | `items_org_name_key` → *'An item with that name already exists — names are one per organisation, ignoring case.'* |

`constraint-messages.ts` maps **constraint names to sentences**. It has no mechanism whatsoever for
`may not 'record_stock_movement'`. So the briefed either/or — *"migrate each screen-specific
sentence into `CONSTRAINT_MESSAGES`, or deliberately drop it"* — has no correct answer for ~65 of
the ~94 branches: they cannot go into a constraint map, and dropping them regresses a real
sentence on a real screen.

### ⭐ The judgement call, stated plainly

**What DEF-257 is actually about is the 38 copies of the FALLBACK, not the 21 screens' translation
tables.** Row 189's harm is *raw Postgres driver text reaching the person moving money*; the
duplicated thing that causes it is the last line of each function. A screen's own list of
role-refusal sentences is not a copy of anything — it is local content that exists in exactly one
place, and it is the reason those screens read well today.

So T-255 does this:

- **Population A (17 files):** delete the local function outright, import the shared one. The name
  matches, so **zero call-site edits**.
- **Population B (21 files):** delete the local **fallback line** and delegate it —
  `return sharedErrorMessage(err);` — keeping the branches above it. The local function keeps its
  name, so again **zero call-site edits**.

After this, `raw.replace(/^…:\s*/, '')` exists **once** in the repo, the sanitised fallback reaches
all 46 screens, and not one sentence a person reads today changes (§5 proves that).

⛔ **I am explicitly declining to migrate the 27 constraint sentences into `CONSTRAINT_MESSAGES` in
this task**, and the reason is row 189's own logic — see §4. That is the third option the briefing
did not list, and I believe it is the right one. If the orchestrator disagrees, this is the
decision to overturn, and §4 is the argument to overturn.

---

## 3. Scope — files this task modifies (once `APPROVED`)

**Modify — population A, 17 files** (delete local `errorMessage`, add one import):
`ap`, `attendance/lane`, `budgets`, `cash-requests`, `channel-settlements`, `customers`, `cutover`,
`expenses`, `expenses/recurring`, `findings`, `fixed-assets`, `liabilities`, `loans`,
`money-accounts`, `money-transfers`, `owners`, `prepaid` — each `…/actions.ts` under
`apps/erp/src/app/`.

**Modify — population B, 21 files** (delete the fallback line only, add one aliased import):
`admin/stores`, `admin/users`, `attendance/terminals`, `commissary/catalogue`,
`commissary/orders/lib.ts`, `inventory/counts`, `inventory/deliveries`, `inventory/locations`,
`inventory/pos-map`, `inventory/pos-usage`, `inventory/production`, `inventory/usage`, `items`,
`remittance`, `sales-days`, `staff`, `staff/[employmentId]/credentials`, `statutory-discounts`,
`till`, `trade/orders`, `wastage`.

**Modify — the 4 inline copies (§1a)**, which declare no function at all: `attendance/[dayId]/actions.ts`,
`payroll/lib.ts`, `payroll/separations/lib.ts`, `payroll/thirteenth-month/lib.ts` — the strip
expression becomes `errorMessage(err)` and the now-unused `const raw = …` line above it goes.

**Create:** `apps/erp/tests/local-errormessage-convergence.test.ts` (§6).

**Not touched:** `apps/erp/src/lib/constraint-messages.ts` (no change needed — it already does
everything required; **no new export, so DEF-226/227/249's shape cannot recur here**),
`apps/erp/src/lib/pre-session-message.ts`, the 10 existing importers, every `index.ts`/barrel
(**none is involved — no export is added or moved, so the barrel rule is not triggered; if that
turns out wrong mid-implementation I stop and ask**), `PROJECT_BIBLE.md`, any migration,
`packages/**`.

**Awaiting a decision before I touch it:** `docs/DEFECTS-REGISTER.md` section E — §7 proposes four
rows. Two other lanes are live on this tree, so I would rather hand the rows over than write into a
shared file uninvited.

---

## 4. ⛔ Why the 27 constraint sentences stay where they are

Three independent reasons, any one of which is sufficient:

1. **Row 189 forbids assuming they execute.** The briefing's own warning: lane C proved the mapped
   constraints are each guarded by a TypeScript check that fires first, under genuine concurrency.
   Migrating 27 more sentences into the shared map on the assumption they fire is the same bet row
   189 already rejected, at 27× the size. The counter is what is supposed to decide this, and the
   counter has not run on these screens (§7, finding E3).

2. **Adding to `CONSTRAINT_MESSAGES` has a side effect nobody has weighed.**
   `apps/erp/src/lib/pre-session-message.ts:137` builds
   `WRITTEN_FOR_A_PERSON = new Set(Object.values(CONSTRAINT_MESSAGES))`, and
   `isUnfitForAStranger` uses that set to decide **what may appear in the URL of the
   unauthenticated `/setup` page**. Every sentence migrated into the shared map silently widens an
   allowlist on an unauthenticated surface. None of the 27 looks dangerous — but 27 sentences
   joining a security allowlist as a side effect of a refactor is not something to do in passing,
   and `pre-session-message.test.ts:125` already asserts on that set's size.

3. **Migration forces a wording decision this task should not make alone** — because two of the 27
   are already contradictory (§7, finding E2).

**What happens to them instead:** nothing. They stay in the file that owns the screen, unchanged,
byte for byte. They are not duplicates — 25 of the 27 constraint names appear in exactly one file.

---

## 5. Regression proof — what changes for a person, and what does not

The convergence changes the fallback regex on most files. Three differences exist between the local
fallbacks and the shared `errorMessage`. **All three are provably inert or provably an improvement:**

| # | Difference | Files affected | Evidence it is safe |
|---|---|---|---|
| 1 | Local `/^[a-z][A-Za-z0-9_]*:\s*/` → shared `/^[a-zA-Z]…/` (also strips an **upper**-case-initial prefix) | 26 | `err.message` never contains the error class name, so `AuthorizationError: ` can never appear in it. A grep for a thrown message literally beginning `Uppercase:` across `packages/domain/src`, `packages/auth/src` and `apps/erp/src` returns **zero hits**. `authorize:` — the prefix that actually reaches users — is lower-case and is stripped identically by both. **Inert.** |
| 2 | Local `/^[a-zA-Z][A-Za-z0-9_.]*:\s*/` (dot allowed) → shared, no dot | 5 (`inventory/*`) | A grep for a thrown message beginning `word.word:` returns **zero hits**. No dotted prefix exists in the codebase. **Inert.** |
| 3 | `admin/stores` and `statutory-discounts` end in bare `return raw` — **no stripping and no sanitising at all**; `expenses` and `fixed-assets` likewise return the message untouched | 4 | These four are the *worst* leaks in the set: an unmapped constraint on any of them renders full driver text today. Converging them is the entire point of row 189. ⚠️ Note `statutory-discounts:24` states the pass-through is deliberate (*"everything else surfaces verbatim rather than being swallowed"*) — that intent predates row 189 and row 189 overrules it. Named here so the change is not mistaken for an oversight. |

**Nothing else changes.** Every branch above every fallback is untouched, so every sentence a person
reads on a matched branch is byte-identical after this task.

---

## 6. Tests — written and failing before a single deletion

**New file `apps/erp/tests/local-errormessage-convergence.test.ts`.** It is a *source* test, not a
behaviour test, because 37 of the 38 local functions are module-private and cannot be imported
(only `commissary/orders/lib.ts` exports one — which is itself the reason they drifted unnoticed).

1. **The census guard — the test that makes this task stay done.** Read every `.ts` under
   `apps/erp/src/app`, assert **no file contains `raw.replace(/^[` **except**
   `apps/erp/src/lib/constraint-messages.ts`. Fails today with 36 hits; passes only when the last
   copy is gone; fails again the day someone hand-writes a 39th. *This is the guard DEF-246 said
   the map needed and never got — it is cheap here because the assertion is "zero", not "one line
   per constraint".*
2. **Import census.** Assert all 38 files import from `lib/constraint-messages`. Fails today (0/38).
3. **No shadowing.** Assert no file both imports `errorMessage` unaliased *and* declares a local
   `function errorMessage` — the one mechanical way this refactor can produce a file that compiles
   in the wrong direction.
4. **Behaviour lock on the acceptance surface.** For each of `cash-requests`, `loans`, `ap`,
   `money-transfers`: assert the shared `errorMessage` returns the sanitised sentence — not driver
   text — for that screen's own real CHECK violation string
   (`new row for relation "cash_requests" violates check constraint "cash_requests_amount_positive_check"`,
   and the three siblings). This is the DEF-246 acceptance criterion, asserted per screen.
5. **Regression lock on population B.** For each of the 21, feed the *domain* sentences its branches
   match (e.g. `authorize: role 'staff' may not 'post_usage'`) through the shared `errorMessage` and
   assert the output equals what the local fallback produces today — the §5 table, executed.

**Confirming they fail for the right reason:** test 1 must fail reporting **36 offending files**,
test 2 reporting **38 missing imports**. A failure count of 0, or a failure naming
`constraint-messages.ts` itself, means the matcher is wrong, not the code.

**Run via:** `npx vitest run apps/erp/tests/local-errormessage-convergence.test.ts` (unit — no
database). No integration test is needed: this task adds no query and no schema change. ⚠️ I do not
run `npm run build`, `npm run test:integration`, `git`, or a dev server — those are the
orchestrator's.

---

## 7. ⛔ Findings — these outrank the refactor

### E1 ⛔ — a sub-centavo amount defeats every `> 0` guard and reaches the CHECK constraint

Row 189: *a counted hit means there is no server-side validation on that field.* I went looking for
that on the acceptance surface and found something sharper.

All four constraints DEF-246 names **do** have a TypeScript guard —
`createCashRequest` (`packages/domain/src/cash-requests/index.ts:52`), `disburseLoan`
(`loans/index.ts:91`), `recordPayment` (`ap/index.ts:702`), and the distinct-accounts check
(`money-transfers/index.ts:103`). Each is `if (Number(input.amount) <= 0) throw …`.

⛔ **But the column is `numeric(14, 2)` and the guard is a float comparison, so the two disagree in a
band that a form can reach.** The action passes the form string straight through
(`amount: str(formData, 'amount')` — `cash-requests/actions.ts:48`). Enter **`0.004`**:
`Number('0.004') > 0` passes the guard, Postgres rounds it to `0.00` on insert, and
`cash_requests_amount_positive_check` refuses it. Today that lands on the user as
`new row for relation "cash_requests" violates check constraint "cash_requests_amount_positive_check"`
— the exact string DEF-246 quotes and `constraint-messages.test.ts:21` uses as its fixture.

**Two consequences, and the second is the valuable one:**
- The path is real, so T-255's convergence is not theoretical on these four screens — it fixes a
  reachable leak. Good.
- **The missing guard is the finding.** Every `> 0` guard in the money domain checks the *typed*
  value while the database checks the *stored* value. The guard should reject an amount that rounds
  to zero at the column's scale, not merely one that is `<= 0`. I have not swept how many money
  paths share this shape; on the four I read, it is all four.

### E2 ⚠️ — DEF-257's predicted drift has already happened, in the money domain

Two constraints already have **two different live sentences**:

| Constraint | `admin/stores/actions.ts` | `remittance/actions.ts` |
|---|---|---|
| `stores_pooling_requires_ceiling_check` | *"A store that pools cash must name the ceiling that bounds it. Either set the cadence to daily, or give an unremitted ceiling."* | *"Pooling cash needs a ceiling. Set the most that may sit un-remitted, or choose Daily."* |
| `stores_unremitted_ceiling_positive_check` | *"An unremitted ceiling must be a positive amount."* | *"A ceiling of zero would mean remitting before selling anything. Leave it blank for Daily, or enter an amount above zero."* |

Same constraint, same `stores` table, two screens, two wordings — one of which explains the
consequence and one of which does not. This is DEF-257's thesis caught in the act, and it is the
concrete answer to *"does a local copy really drift?"* — yes, and it already has.

### E3 ⚠️ — row 189's counter is blind on every screen row 189 was written for

`recordIfUnmappedConstraint` is called from **8 files** — payroll ×3, settings ×5 — at 19 call
sites. **Zero money screens. Zero of DEF-246's four named examples.** Row 189's plan is *"instrument
it and let measured hit counts decide which constraints earn a sentence"*; as wired, the count will
measure payroll and settings and report near-silence from the screens where DEF-246 says the whole
exposure lives. Whatever the counter reports next month will understate the money screens to zero.

**I recommend this as the immediate follow-up task, not as scope creep into T-255** — it is a
different change shape (each call site needs `orgId`/`storeId`/`actorPersonId` in scope, ~100 catch
blocks, `await` inside `catch`), and mixing it into a 38-file mechanical sweep would make both
unreviewable. But T-255 shipping without it should not be mistaken for row 189 being served.

### E4 ⚠️ — reported, not acted on: this touches row 189's reasoning (bible rule 14)

Row 189 records: *"The exposure is entirely in the unmapped set, **which is exactly where there is
frequently no TS guard either**."* On the four unmapped constraints DEF-246 itself chose as
motivating examples, **all four have a TypeScript guard** (E1). The guards are imperfect — E1 is the
gap — but "no TS guard" is not what is there.

This does not overturn row 189: sanitise-first is still right, the fallback is still the floor, and
E1 shows the constraint is still reachable. It narrows one clause of the rationale. **Per rule 14 I
have not touched `PROJECT_BIBLE.md` and will not.** Reporting and stopping on this point; T-255 does
not depend on the clause either way.

---

## 8. Order of work, once approved

1. Write `local-errormessage-convergence.test.ts`; run it; confirm it fails reporting 36 and 38.
2. Population A, 17 files — delete function, add `import { errorMessage } from '@/lib/constraint-messages';`.
   Re-run: census drops to 21.
3. Population B, 21 files — add `import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';`,
   replace the terminal `return raw.replace(…)` with `return sharedErrorMessage(err);`. Re-run: census 0.
4. The **8** inner `raw.replace(…)` pass-through branches inside `inventory/deliveries` (2),
   `inventory/usage` (3), `inventory/production` (2) and `inventory/locations` (1, which stripped
   its own `deactivateLocation` prefix by name) — the same sanitising logic one nesting level in.
   Leaving them re-buys exactly what step 3 deleted, and would force §6's zero-assertion into an
   exception list. *(The spec said 9 in round 1; the true split is 8 inner + 4 terminal across those
   four files.)*
   **Then prune what convergence made redundant:** each of those 8 branches becomes
   `if (…) return sharedErrorMessage(err);` directly above a fallback that says the same thing, so
   the branch is dead. Delete it and put the intent in a comment above the fallback. ⚠️ Order-safety
   checked by hand for all 8 first — for each, no *later* branch's regex can match the message that
   used to land in it, so nothing changes hands.
5. Typecheck; run the erp unit suite; self-review the diff file by file.
6. Report `[C] STATUS: VERIFIED` with real command output, or `FAILED` with it.

⚠️ **Import style:** the 38 get `@/lib/constraint-messages` (the alias exists —
`apps/erp/tsconfig.json`) rather than counting `../` across six directory depths, which is a real
error source at this file count. The 10 existing importers use relative paths; I am **not**
churning them to match.

## 9. Done-when

Census test green at zero · all 38 import the shared module · every §6.5 regression case green ·
typecheck clean · erp unit suite green · the four acceptance screens each proved to return the
sanitised sentence for their own CHECK violation · findings E1–E4 reported · **no barrel touched,
no new export shipped, no bible edit**. ⚠️ `npm run build` and the integration suite are the
orchestrator's gates, not mine — I report which of the done-when I could not run myself.

---

## 10. What shipped

**42 files converged, 46 occurrences of the strip removed, 8 dead branches pruned.**

| Population | Files | Change |
|---|---|---|
| A — pure fallback | 17 | Local function and its doc comment deleted; `import { errorMessage } from '@/lib/constraint-messages';`. The name matches, so **no call site changed**. |
| B — fallback + screen branches | 21 | `import { errorMessage as sharedErrorMessage }`; every strip inside the function (terminal and inner) became `sharedErrorMessage(err)`; a terminal bare `return raw` / `return err instanceof Error ? …` became the same. Every branch above it untouched. |
| Inline, no function (§1a) | 4 | The strip expression became `errorMessage(err)`; the orphaned `const raw = …` removed. |

**Pruned:** 8 branches that convergence reduced to a duplicate of the fallback —
`inventory/production` 2, `inventory/usage` 3, `inventory/deliveries` 2, `inventory/locations` 1 —
each replaced by a comment above the fallback recording what used to be listed there.

**Gates run by this lane**

| Gate | Result |
|---|---|
| `npx vitest run --project unit apps/erp/tests/local-errormessage-convergence.test.ts` — **before** implementation | ⛔ RED for the right reason: test 1 named **37** files carrying the strip, test 2 named **38** declaring a local helper. 13 other assertions green. |
| The same file, after | ✅ 15/15 |
| `… constraint-messages.test.ts` + `pre-session-message.test.ts` | ✅ 84/84 — T-252's regression set and the `/setup` allowlist both intact |
| `npx tsc --noEmit` | ✅ exit 0 |
| `npx vitest run --project unit apps/erp` | ⚠️ 200 passed, **1 failed — `sign-out-control.test.ts`**, which reads `src/components/shell/Sidebar.tsx`. Outside this task's file list, untouched by it, and belongs to the concurrent T-257/DEF-259 sign-out work. Reported, not worked around. |

**Not run by this lane** (the orchestrator's gates): `npm run build`, the integration suite,
smoketest on 9008, commit.

⚠️ **Line endings:** three of the 42 (`attendance/lane/actions.ts`, `inventory/usage/actions.ts`,
`statutory-discounts/actions.ts`) use CRLF while the rest use LF. Each was rewritten with the
ending it already had, so none shows up as a whole-file diff. Worth a `.gitattributes` line
one day; not this task's business.

**Findings E1–E4 (§7) were drafted here and handed to the orchestrator as text — this lane wrote
nothing into `docs/DEFECTS-REGISTER.md`, and nothing into `PROJECT_BIBLE.md`.**
