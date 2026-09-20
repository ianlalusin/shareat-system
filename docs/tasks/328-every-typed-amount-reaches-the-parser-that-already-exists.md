# T-328 — every typed amount reaches the parser that already exists, and the enumeration that finds them states its own denominator

**Status:** SPEC — drafted by the orchestrator (`system32-4f`) 2026-09-19; **AMENDED and APPROVED by
the orchestrator (`system32-df`) 2026-09-20** after an independent Opus review returned CHANGES.
⭐ **Eight corrections are folded in below and each is marked `[A-2026-09-20]`.** The review found a
**live, money-carrying 5th spelling** — predicted by this spec's own §Population and now named in it.
**Closes:** DEF-382 (T-327 halves it; this finishes it).
**Migration slot:** **none.** T-327 holds `0155`.
**Depends on:** T-327 landing first. ⛔ **Do not start the conversion before the backstop exists** —
the backstop is what makes this task's inevitable miss survivable.

> ⛔ **ANCHORS — GREP THESE, NEVER A LINE NUMBER** (bible row 204).
>
> | Anchor | File |
> |---|---|
> | `export function parseMoneyInput(` | `packages/domain/src/shared/money-input.ts` |
> | `export function money(` | `packages/core/src/money.ts` — the real choke point; **do not touch** |
> | `const deliveryFee = Number(input.deliveryFee` | `packages/domain/src/trade/index.ts` |
> | `function money(fd: FormData, key: string)` | `apps/erp/src/app/channel-settlements/actions.ts` — **a function named `money` that validates nothing** |
> | `MANUAL_COST_PATTERN` | `packages/domain/src/commissary/catalogue.ts` — the second validator (DEF-383) |
> | ⭐ `export function normaliseRate(` | `packages/domain/src/commissary/orders.ts` — **the THIRD REAL validator `[A-2026-09-20]`**. The spec's first draft named `channel-settlements`'s fake `money()` as DEF-383's third; that is wrong — the fake validates nothing and is a *shadow*, not a validator. DEF-383 counts `parseMoneyInput` · `MANUAL_COST_PATTERN` · `normaliseRate` |
> | ⭐ `function amount(fd: FormData, key: string)` | `apps/erp/src/app/sales-days/actions.ts` — **the SECOND shadow `[A-2026-09-20]`**, same trap as `money(fd,key)`, feeding 12 money fields |
> | ⭐ `for (const [key, value] of formData.entries())` | `apps/erp/src/app/sales-days/actions.ts` · `apps/erp/src/app/till/actions.ts` — **the 5th spelling `[A-2026-09-20]`** |

---

## The population, and why the number in the handoff is not it

`money()` already rejects `NaN`, `±Infinity` and every malformed string (T-327 §P4).

⛔⛔ **CORRECTED `[A-2026-09-20]` — the boundary is `parseMoneyInput`, NOT `money()`.** The first
draft said "sites that reach a `numeric` column without passing through `money()`". That is a sound
*storage-safety* line and the WRONG *invariant* line. `money()` throws a raw `TypeError`/`RangeError`;
only `parseMoneyInput` produces the cashier-readable sentence **Invariant 3 demands**. So an app-layer
site that calls `money()` directly is SAFE but still VIOLATES this task — and three exist today:
`apps/erp/src/app/remittance/actions.ts`, `fixed-assets/lib.ts`, `loans/lib.ts`, each importing
`money` from `@shareat/core/money` in the app layer. **That is DEF-379's finding, reinstated.**

**The population is: every site that reaches a `numeric` column without passing through
`parseMoneyInput` (app layer) or `money()` (domain layer).**

⛔ **The handoff calls this "the 14 money sites T-326 did not convert". Do not carry that figure.**
Measured by the orchestrator, 2026-09-19:

⛔ **EVERY COMMAND BELOW TAKES `--exclude-dir=node_modules --exclude-dir=.next` `[A-2026-09-20]`.**
As first written they were **not reproducible**: with a dev build present on disk they return
138 / 141 / 142 / 20 / 51 / 21 instead of the figures in this table. A census command that reads
build artefacts measures the artefacts. ⭐ **This also makes Test 3 deterministic** — without it the
executable enumeration's denominator depends on whether anyone has run `next build` lately.

| Measure | Value | Command |
|---|---|---|
| app files defining a local `function str(` | **56** | `grep -rl "function str(" apps/` |
| ⚠️ **repo-wide**, which is a different question | **57** | same, repo root — the extra is `packages/etl/src/audit/groups.ts` |
| files calling `str(formData,` / `str(fd,` | 35 / 30 | — |
| union of those two spellings | **56** — matches the app-scoped definition count | `grep -rlE "str\((fd\|formData)\b" apps/` |
| ⛔ **3rd spelling:** `Number(` directly on a form value | **10 sites, 6 files** | `grep -rnE "Number\((str\(\|fd\.get\|formData\.get)" apps/` |
| ⛔ **4th spelling:** template-literal field names | **17 sites, 4 files** | ``grep -rnoE "str\((fd\|formData), \`[^\`]+\`" apps/`` |
| app files importing `parseMoneyInput` **after T-326** | ⛔ **2, not 1 `[A-2026-09-20]`** — `remittance/actions.ts` **and** `apps/erp/tests/money-input-resolves.test.ts`. Re-measured; the draft's `1` was the only figure of seven that did not reproduce. Read it as **1 non-test app file** | `grep -rl parseMoneyInput apps/ --exclude-dir=node_modules --exclude-dir=.next` |

⭐ **The last row is the correction.** T-326's diff converted **one** app site
(`apps/erp/src/app/remittance/actions.ts`), not six. **Whatever the real number is, this task
measures it.**

## ⭐⭐ The 5th spelling — FOUND, LIVE, AND CARRYING MONEY `[A-2026-09-20]`

**The draft predicted a 5th spelling as "the expectation, not a surprise". It was right. Here it is,
verified at source by the orchestrator, not relayed.** It is two shapes, and neither is reachable by
any of the four greps above.

**(a) A local helper wrapping `str` under a different name.**
`apps/erp/src/app/sales-days/actions.ts` — `function amount(fd: FormData, key: string)` returns
`raw === '' ? '0' : raw`. **It validates nothing**, and it feeds **12 money fields** into
`createSalesDay`. Grepping for `str(fd,` misses every one of its call sites, because they say
`amount(fd, …)`.
⚠️ **Its own comment is a stale contract** — *"The domain and the schema both reject a genuinely bad
figure, so this only has to normalise an empty box."* That sentence is exactly the class handoff
2026-09-20 §7.4 names: **a stale contract is how the next person reasons wrongly with complete
confidence.**

**(b) `formData.entries()` loops keyed by a prefix — the worse of the two.**

| Site | Loop key | Reaches |
|---|---|---|
| `sales-days/actions.ts` | `tender_*` | `tenders[].amount` |
| `sales-days/actions.ts` | `channel_*` | `channels[].amount` |
| `till/actions.ts` | `count:*` | `counts[].counted` (till counts) |

⛔⛔ **The tender loop admits `'abc'` TODAY. Verified by reading it, and it is DEF-382's exact
mechanism at a site no listed grep reaches:**

```ts
if (!amount || Number(amount) <= 0) continue;   // Number('abc') is NaN; NaN <= 0 is FALSE
```

**`NaN <= 0` is false, so the `continue` does not fire and `'abc'` is PUSHED as a tender amount.**
The guard reads like a filter and is one — for `0` and negatives. It is blind in precisely the
direction this task exists to close. ⭐ **The till loop is worse still: it tests only for non-empty.**

⛔ **A 6th spelling remains the expectation.** Shapes searched and found EMPTY in `apps/`, recorded
so the next census need not redo them: `parseFloat`/`parseInt` (0) · `valueAsNumber` (0) ·
`z.coerce` (0) · `Object.fromEntries` over form data (0) · unary `+value` on a form value (0) ·
JSON request bodies (0 money). ⚠️ `ap/actions.ts`'s `s()` wrapper is real but carries no money —
**out-column, not silence.**

## ⛔⛔ The 6th spelling — the PLURAL helper family, and the REAL corruption path `[A-2026-09-20]`

**Found by the auditor, verified at source by the orchestrator. The 5th spelling was not the last
one, and the prediction that a 6th existed was correct within hours.**

### 6(a) — `strs(fd, key)` and `list(fd, key)`: `str`'s plural, validating nothing

**Measured: 10 files, 35 call sites** (`apps/`, artefacts excluded). `function strs(fd: FormData,
key: string): string[]` in 9 files, plus `function list(fd, key)` in `inventory/counts/actions.ts`.

⛔⛔ **IT IS INVISIBLE TO ALL FIVE EARLIER SPELLINGS FOR ONE CHARACTER'S REASON: `strs(` does not
match `str\(`, because after `str` comes `s`, not `(`.**

⭐⭐ **AND THIS IS THE PART THAT MATTERS MORE THAN THE COUNT.** The files holding these call sites
**are already inside the 56-file denominator** — `trade/orders/actions.ts` and
`inventory/deliveries/actions.ts` each define a local `function str(` of their own, so grep 1 finds
them. **They look covered.** A reviewer asking *"is `deliveries/actions.ts` in the enumeration?"*
gets **yes** and moves on, while the `strs(...)` money lines inside it were never enumerated.

> ⛔ **A file present in the denominator with unenumerated sites inside it is worse than a file
> absent from it — because absence is visible and this is not.** This is what Test 3 must assert
> against, and **re-running the shape-greps cannot do it.**

### 6(b) — ⛔ `unitCost` reaches a `numeric` column unvalidated, end to end. **THE REAL CORRUPTION PATH.**

```
apps/erp/src/app/inventory/deliveries/actions.ts   strs(fd, 'unitCost') → unitCosts[i] ?? '0'
packages/domain/src/deliveries/documents.ts:117-124 the guard loop validates TWO of three fields
   orderedQuantity   → isPositiveQuantity(...)                              ✅
   conversionFactor  → Number.isFinite(Number(...)) && Number(...) > 0      ✅
   unitCost          → NOTHING                                              ❌
packages/domain/src/deliveries/documents.ts:163, :277  unitCost passed straight through
→ delivery_lines.unit_cost (numeric; 0155 line 180 carries its finite check)
```

⛔ **Unlike the `rate` path, NOTHING intercepts this one** — there is no `parseMoneyInput` upstream
of it. `abc` in a delivery line's unit cost reaches Postgres and returns
`invalid input syntax for type numeric` **to the operator**. Invariant 3 violated; Invariant 4
violated in the letter — the database is what refuses it, from a path this enumeration should have
carried.

⭐ **The method finding, sharper than T-327's own version:** line `:121` already uses
`Number.isFinite(Number(...))` — *the exact remedy* — **three lines above** the field with no guard
at all. **Someone thought hard about finiteness in that very loop and `unitCost` still walked.**

### 6(c) — a third plural helper is NOT ruled out

The family was searched by the two names actually found (`strs`, `list`). ⚠️ **A third plural under
a third name is precisely the shape this tree has now produced twice.** Not searched: `packages/`
for any of it. ⛔ **State this as unsearched, not as clean.**

⛔⛔ **AND THE ALIAS SET IS NOW HAND-MAINTAINED IN A TEST, WHICH IS THE SAME DEFECT ONE LEVEL UP
`[A-2026-09-20]`.** Test 3 recognises `str` · `strs` · `list` · `money` · `amount` from a literal
list. It is correct today — proved by the tester chasing a 34-vs-35 discrepancy to `list(fd,key)`
rather than rounding it off. ⚠️ **But bible §13 row 206 is about exactly this shape: if a TENTH name
appears, the sweep reports green over 34 of 36 and nothing says so.** A hand-copied list of names is
what `parseMoneyInput` itself exists to have deleted four of.

⭐ **PROPOSED REMEDY, from the TESTER, 2026-09-20 — logged for GROUP 4, deliberately not built
mid-cycle.** Derive the alias set instead of listing it, by **shape rather than spelling, applied one
level up**: a first pass greps `apps/` for declarations matching
`function\s+(\w+)\(fd:\s*FormData,\s*key:\s*string\)`, collecting whatever identifiers exist; a
second pass treats call sites of *those discovered names* as candidates, with the same
call-vs-declaration disambiguation used now. **A tenth alias is then picked up automatically
whatever it is called.** Cheap — one extra regex pass, no new dependency.
⚠️ **And the tester named its own residual assumption rather than selling it as complete:** it trusts
that every such helper is declared with that exact parameter shape, so an eleventh helper with a
differently-typed signature still needs a human to notice. ⭐ **That caveat is the reason it is worth
adopting — a remedy that states what it still trusts is the one that does not become the next
three-artefacts-say-it-is-handled case.**

---

⛔ **The 4th spelling was invisible to the first three and carries money** —
`allocateAmount_${chargeId}`, `lineAmount_${i}`, `line${i}_unitPrice` in `ap/`, `customers/`,
`expenses/`. ⚠️ **A 5th spelling is the expectation, not a surprise:** this repo has now re-derived
a census figure and changed it **five times in two days**, and
`local-errormessage-convergence.test.ts` records the same lesson in its own header from an earlier
census that missed four files. **Derive from SHAPE, state the denominator, and say what the method
cannot see.**

---

## Contract

### 1. The enumeration is produced FIRST, and the lane STOPS

⛔ **Same rule as T-326 §3, same reason: a sweep that begins before its boundary is agreed is how a
task becomes unbounded.** The lane produces the list → the orchestrator approves it → then it
converts. **No conversion before approval.**

⛔ **An EXPLICIT OUT-COLUMN.** Every site the method reached and excluded, with its reason. *A site
excluded for "not money" must be visible, not absent — otherwise a list of 6 is indistinguishable
from a list of 20 with 14 omissions, which is the exact failure the enumeration prevents.*
⭐ **Measured starting point, from the reviewer and re-checked:** all 10 third-spelling sites are
minutes, counts and month-terms — **zero money**. They belong in the out-column, not in the silence.

### 2. Each in-scope site parses through the existing parser

`parseMoneyInput` in the app layer, `money()` in the domain. The operator gets the sentence
`parseMoneyInput` already produces.

⛔ **Do NOT copy the parser, and do NOT write a fourth validator.** DEF-383 records that this tree
already holds **three** (`parseMoneyInput`, `MANUAL_COST_PATTERN`, and `channel-settlements`'s
`money(fd, key)` which validates nothing). **Adding one is a spec defect — report it.**

⛔ **CORRECTED `[A-2026-09-20]` — the inventory above was wrong and the fix matters.** DEF-383's
three REAL validators are `parseMoneyInput` · `MANUAL_COST_PATTERN` · **`normaliseRate`**
(`packages/domain/src/commissary/orders.ts`, exported, live). The draft substituted
`channel-settlements`'s `money(fd,key)` for `normaliseRate` — but that function **validates
nothing**, so it is a *shadow* (§3), never a validator. ⚠️ **Counting a fake as one of the three is
how `normaliseRate` stayed invisible**: the slot was already full.

### 3. The misleading `money()` shadow is renamed

`apps/erp/src/app/channel-settlements/actions.ts` defines `function money(fd: FormData, key: string)`
that returns `str(fd, key) || '0'` — **a function named `money` that performs no money validation**,
shadowing one that does, feeding 9 live fields into `recordChannelSettlement`. It is converted like
any other site **and renamed**, because the name is the trap.

⭐⭐ **BOTH SHADOWS ARE RENAMED, NOT ONE `[A-2026-09-20]`.** `apps/erp/src/app/sales-days/actions.ts`
defines `function amount(fd: FormData, key: string)` — the identical trap, returning
`raw === '' ? '0' : raw`, validating nothing, feeding 12 live money fields. It is **invisible to all
four listed greps at its call sites** precisely because it is named something else. Convert and
rename it on the same terms. ⛔ **And delete its stale comment rather than preserving it** — the
claim that "the domain and the schema both reject a genuinely bad figure" is what stopped anyone
looking.

---

### 4. The `trade` reconciliation guard — CORRECTED TWICE, and the second correction is mine `[A-2026-09-20]`

⛔⛔ **READ THIS BEFORE WRITING THE TEST. The first version of this section was wrong, and two lanes
found it independently from opposite directions on the same day.**

**What is true:** `Math.abs(Number(input.totalAmount) - total) > EPSILON` IS blind to `NaN`
(`Math.abs(NaN) > EPSILON` is `false`) — T-327 §P5 measured that and it stands.

⛔ **What is FALSE, and what I asserted on 2026-09-20 before proving it:** that a bad value can
REACH that guard. **It cannot, and I proved it by execution rather than by reading:**

```
(Number('5') * Number('abc')).toFixed(2)   === "NaN"     ← trade/index.ts line ~239's own expression
parseMoneyInput("NaN", 'line 1 total')     THROWS        ← "… is not a valid amount."
```

`parseMoneyInput` sits at line ~239 and `lines.push({ rate: … })` at ~251. **The parser throws
first**, so the loop never reaches the push, and `rate` never lands in a `numeric` column. The same
interception protects the guard: every operand reaching it has already been parsed, and **two finite
numbers cannot subtract to a non-finite one.**

⭐⭐ **THEREFORE THE GUARD'S BLINDNESS IS UNREACHABLE THROUGH `createTradeOrder`'S PUBLIC INPUT —
today AND after this task.** A test driving it through the public path observes the PARSER's
sentence and never the guard's, whatever its name claims. That is the DEF-115 shape exactly, and
this spec would have shipped it.

**4a. The reads are parsed.** `deliveryFee`, `otherFees`, `totalAmount`. Unchanged, still required.

**4b. The reconciliation becomes a PURE, EXPORTED, DIRECTLY-CALLABLE function** —
`packages/domain/src/trade/` — taking the two figures and returning whether they reconcile,
refusing a non-finite operand explicitly. The guard calls it; a unit test hands it a fabricated
`NaN` **without going through `createTradeOrder` at all.**
⭐ **Why extract rather than drop it:** bible §15.11 — *no layer may be the only one for a given
risk.* `parseMoneyInput` is currently the only thing standing between a typed rate and this
arithmetic. A second layer is right; a second layer **nothing can test** is decoration. Extracting
is also this repo's own established move — `parseMoneyInput` itself exists because T-255 extracted
it out of four hand-copied guards.
⛔ **It is NOT a fourth validator (§2).** It parses nothing and produces no money sentence; it
compares two already-parsed figures.

⭐ **Scope:** `packages/domain/src/trade/index.ts` — the `deliveryFee`/`otherFees`/`totalAmount`
reads, the `EPSILON` guard, and the new pure module it delegates to.

### 4c. The `rate`/`quantity` message defect — TWO entry paths, and the fix is NOT a better label

⚠️ **A MESSAGE defect, not a corruption one.** No `NaN` reaches a column here; §4's proof stands.

⛔ **BOTH guards above the parser are NaN-blind, so there are two entry paths, not one:**

```
:231   if (Number(rate) < 0)             →  NaN < 0   is false  → passes
:232   if (Number(draft.quantity) <= 0)  →  NaN <= 0  is false  → passes
```

**A mistyped QUANTITY produces the identical "line N's total" error as a mistyped RATE.**

⭐⭐ **THEREFORE THE FIX IS NOT A BETTER LABEL ON THE PARSER CALL.** `parseMoneyInput` sits
*downstream of the point where the two inputs became one number* — naming `rate` in its message
would be **wrong half the time**. ⛔ **The remedy is guards that fail BEFORE the multiply**, each
validating its own field and naming its own box. That is this task's whole thesis applied one
level earlier, and `rate` and `quantity` are therefore **IN-scope enumerated sites**, not a
message tweak.

⛔ **And it quotes a token the operator never typed.** `parseMoneyInput` interpolates its `raw`
argument, which here is the **computed product**, not the input:

```
createTradeOrder: line 1's total — "NaN" is not a valid amount. Use at most two decimal places.
```

They never typed `NaN` and the word means nothing to them. **This satisfies Invariant 3's letter
and fails its purpose** — the sentence's shape, quoting a machine artefact, about the wrong field.

### 4d. ⭐⭐ The comment at `trade/index.ts:235-237` — three artefacts now call this site safe

```
// DEF-272: always exactly 2dp already (toFixed above), so this never actually throws on
// precision — routed through the shared parser anyway so every money value in the set goes
// through the one entry point, not because this particular site was independently exploitable.
```

**Clause 1 is scoped to precision and is TRUE.** ⛔ **Clause 2 is unscoped and is now FALSE.** That
`parseMoneyInput` call is the **sole interception point** between a non-numeric rate-or-quantity and
two `numeric` columns. The comment tells the next reader it is there for *uniformity* rather than
*safety* — **an invitation to delete it as dead defensive code**, and deleting it opens exactly the
path §4 proves is closed.

⛔⛔ **READ THIS BEFORE TOUCHING THE BLOCK — it is the method finding assembling itself in real
time, around this line, today.** There are now **THREE** artefacts concluding this site is safe:
the author's comment, the orchestrator's triage, and the auditor's retraction. **All three are
correct. All three are correct *only while line 238 stands*.** This task has just manufactured two
fresh, well-reasoned pieces of evidence that the site needs no attention — and attached them to a
comment saying the guard is unnecessary. **The next reader finds the question settled three times
over.**

⭐ **So the comment is REWRITTEN, not deleted.** It must record *what the call stands between*.
A bare `parseMoneyInput` with no comment invites the same deletion, only more quietly.

## Invariants

1. **A valid amount is unaffected**; `0` stays legitimate (bible §12 landmine 8).
2. **No new money validator** (DEF-383).
3. **Every converted site refuses `abc` with the cashier-readable sentence** — not merely refuses.
4. **T-327's constraints never fire from an enumerated path.** ⭐ **If one does, the conversion at
   that site is wrong** — the app must reject it before the database has to.

   ⛔⛔ **AND THIS INVARIANT — NOT "is it money?" — IS THE ENUMERATION'S CRITERION `[A-2026-09-20]`.**
   The first OUT column was filtered on *"is it currency?"*. **Invariant 4 asks a different question:
   does the value reach a column carrying `0155`'s finite check?** Those are different sets, and
   T-327 guarded all **160** columns *deliberately without asking which are money* — its own migration
   header says so. ⭐ **So a row excluded as "a proportion, not currency" or "quantity, not money" was
   excluded on a predicate this invariant does not use.** 25 quantity columns carry the check;
   `order_wastage_allocations.percent` carries it (migration line 226-227, verified live).

   ⛔ **THE "not currency" / "not money" REASON IS RETIRED FROM THE OUT COLUMN.** It is true of every
   row it was written on and it establishes nothing. **The OUT reason must now answer: does this reach
   a `0155`-constrained column, and if so, what validates it BEFORE the write — named, and read rather
   than grepped?**

   ⛔ **THE CRITERION'S EDGE IS `0155`'S EDGE, AND `0155` COVERS `numeric` ONLY — RECORDED, NOT
   MOVED `[A-2026-09-20]`.** An `integer` column shares the property that made `unitCost` a finding:
   the database validates first and the operator gets a raw type error, not the sentence.
   ⭐ **But the severity genuinely differs, and this is why they stay OUT on substance rather than on
   the criterion's letter:** Postgres `numeric` **accepts** `'NaN'` — that is DEF-382's entire
   mechanism — while `integer` **rejects** it outright. **An integer column cannot be poisoned, only
   refused.** No corruption is reachable; only message quality, which is **Invariant 3, not
   Invariant 4.** ⚠️ **If that edge ever moves it belongs in T-330 with GROUP 4, not here** — and it
   is written down so a closed DEF-382 cannot dissolve it.

   ⚠️ **The task's title is the narrower artefact and does not govern.** It was written before any of
   this was measured. A `NaN` quantity poisons a `numeric` column exactly as a `NaN` amount does.

## Tests

⛔ **Of each: what value would have to be wrong for this to go red, and does the code under test
supply it?**

1. **Per converted site:** `abc` in, `parseMoneyInput`'s sentence out. ⛔ **Asserting refusal alone
   is not enough** — after T-327 refusal comes free from the constraint and proves nothing about
   this task.
2. **The `trade` path specifically — and it needs Contract §4 to be capable of failing
   `[A-2026-09-20]`.** T-327 §P5 measured that `Math.abs(Number(input.totalAmount) - total) > EPSILON`
   passes silently on `NaN`. ⛔ **Write this as TWO tests, because one of them is the one that can
   lie:** (a) trade's inputs are refused by the parser with the sentence — reachable by parsing
   alone; (b) **the guard itself refuses a non-finite mismatch when handed one directly**, bypassing
   the parser. ⚠️ **(b) is the real assertion.** Without Contract §4, (b) is unfailable and (a)
   silently stands in for it — the test would assert the parser's sentence while claiming to prove
   the guard.
3. **The enumeration is executable, not prose.** The shape-greps that produced the denominator run
   as a check, so a further spelling appearing later is visible. ⛔ **No count in a test name**
   (handoff §3(d)); denominators derived at runtime.
   ⛔⛔ **AND IT ASSERTS THE DENOMINATOR AGAINST THE OUT-COLUMN, NOT MERELY RE-RUNS THE GREPS
   `[A-2026-09-20]`.** Re-running the four greps proves nothing about a 6th spelling: **they return
   zero hits for the 5th**, which is live and money-carrying. A check that could not see the last
   one is not evidence against the next one. **The assertion is: every site in the enumeration is
   either converted or carries a written out-reason — and the two sets together account for the
   whole measured population.** ⭐ Run the greps with `--exclude-dir=node_modules --exclude-dir=.next`
   or the denominator moves whenever someone builds.

## Out of scope

- ⛔ **Closing DEF-383** — unwinding three validators into one is its own task. This task must not
  *add* one; merging the existing three is not licensed here.
- ⛔ Migration work. T-327 holds `0155`.
- ⛔ `money()` and `parseMoneyInput`'s own logic.
- ⛔ DEF-374, DEF-380, DEF-373, T-320.

## Done when

Every §9 gate: typecheck · unit · integration on the lane DB · `npm run build` with 9008 free ·
the auditor's `/code-review` returned and triaged · `callers.mjs` clean · committed with a message
saying *why* · **DEF-382 closed and the roadmap made true — by the orchestrator, not a lane.**

✅✅ **§9.4 — REPORTED UNMET AND IAN ACCEPTED IT, 2026-09-20 `[A-2026-09-20]`.** Reported in those
words under bible row 203, which makes it his call and not an orchestrator's. His ruling:
*"fine to proceed without it for now, fix the browser setting later. Not a blocker."*

⛔ **THIS IS AN ACCEPTANCE, NOT A WAIVER, AND THE DIFFERENCE IS THE WHOLE POINT.** He said *"for
now"* and *"fix … later"*. **The screen test is still owed on this work** — it is deferred with his
knowledge, not discharged. ⚠️ A later session must not read this as *"§9.4 does not apply to T-328"*.

⭐ **WHAT WAS MEASURED AND REPORTED TO HIM, so the acceptance is informed rather than nominal:**
three blockers stack — Chrome is **not installed on this machine at all** (all three install paths
empty, verified 2026-09-20); the dev server cannot render any page (DEF-387); and the only renderer
that works runs as `NODE_ENV=production`, which is the one mode emulator sign-in is refused in by
design (DEF-388). ⛔ **The guard in DEF-388 must NOT be loosened to close this** — it exists so a
production build cannot accept unsigned tokens.
⭐ **The cheapest route back, still untried:** Edge IS installed and Playwright's bundled Chromium
IS cached, so the gap is *"pinned to the one absent browser"*, not *"no browser available"*. The
config is in Ian's own `~/.claude.json` and repointing it is untested.
