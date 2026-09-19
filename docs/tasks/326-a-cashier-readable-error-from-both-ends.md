# T-326 — a cashier-readable error, from both ends: the parser becomes reachable, and the database stops speaking SQL to the operator

**Status:** SPEC — drafted by the orchestrator (`system32-4f`), 2026-09-19. Not yet approved.
**Closes:** DEF-379 and DEF-378.
**Migration slot:** none.

> ⛔ **ANCHORS — GREP THESE, NEVER A LINE NUMBER.** A line number is a claim with a shelf life
> measured in commits (bible row 204). T-325 needed its anchor table twice in one day.
>
> | Anchor | File |
> |---|---|
> | `export function parseMoneyInput(` | `packages/domain/src/shared/money-input.ts` |
> | `"./money-lines"` | `packages/domain/package.json` — the precedent to mirror |
> | `'@shareat/domain/money-lines'` | `vitest.config.mts` — the alias precedent |
> | `export function errorMessage(` | `apps/erp/src/lib/constraint-messages.ts` |
> | `export function parseConstraintName(` | same file |
> | `function money(fd: FormData, key: string)` | `apps/erp/src/app/channel-settlements/actions.ts` |

## Why this exists — one goal, and neither half delivers it alone

**A cashier types an amount. Two things can go wrong, and today both produce something they cannot
act on.**

**DEF-379 — the readable parser is unreachable from the layer where people type.**
`parseMoneyInput(raw, label)` exists precisely to turn a bad money string into a sentence a cashier
can act on. `packages/domain/package.json`'s `exports` map has exactly three entries — grep
`"./money-lines"` to see the shape — and `money-input.ts` is not among them and is not re-exported
from the barrel. **So `apps/erp` cannot import it at all.** ⭐ **~14 domain modules use it** — `ap`, `ar`,
`cash-requests`, `cutover/opening`, `expenses/reimbursement`, `loans`, `money-transfers`, `owners`,
`prepaid`, `recurring-expenses`, `remittance`, `sales-days/create`, `trade`, `wastage/orders` —
and the layer that needs it most is locked out. *(Revision 1 said "eight", understating its own case
by nearly half; corrected by the auditor.)* The app's only options are `money()`, which throws a raw
`TypeError: Invalid money string:`, or `Number()`, which is DEF-272.

**DEF-378 — when the database refuses, the operator reads SQL.**
Grep `export function errorMessage(`. Its final fall-through is
`raw.replace(/^[a-zA-Z][A-Za-z0-9_]*:\s*/, '')` — a strip of a `Word: ` prefix that raw Postgres
text does not carry. A **mapped** constraint gets a hand-authored sentence; an **unmapped**
constraint degrades to a generic one; **everything else renders verbatim**, SQL grammar and all.
`invalid input syntax for type numeric`, `undefined_column`, `undefined_table` all reach the screen.

⭐ **They are one task because fixing either alone leaves the goal unmet:** export the parser and the
app still has no presentable failure when the database refuses; sanitise the database and the app
still cannot produce a good error when the *input* is bad.

## ⛔ The trap this task must not fall into — read before designing anything

**Sanitising everything is a REGRESSION THIS PROJECT ALREADY MADE AND REVERTED.** Read the comment
above `export function errorMessage(` — DEF-301 / T-270 record that collapsing hand-authored,
precise error sentences into a content-free generic one was worse than the problem, and it was
deliberately reverted. Domain code throws `Error('createCashRequest: the amount …')` **on purpose**,
and those must keep reaching the screen.

⛔ **So the fix is NOT "sanitise the fall-through".** It is: **tell a database error from an
application error, and treat them differently.**

⭐ **The discriminator is the error OBJECT, not its text.** Classify on the presence of a `code`,
never by pattern-matching English prose Postgres is free to reword in any release — that reasoning
is already written into this file for `parseConstraintName`; follow it.

> ### ⛔⛔ AMENDMENT 1 — "SQLSTATE-SHAPED" IS THE WRONG TEST, AND THIS PROJECT ALREADY LEAKED ON IT
>
> **Revision 1 of this spec said to classify on a SQLSTATE-shaped (five-character) `code`. That is
> the narrower test which was already tried here and already leaked.** Corrected by the orchestrator
> before the lanes started, from evidence in the repo rather than from review.
>
> ⭐ **THE EXISTING IMPLEMENTATION IS `isUnfitForAStranger` — grep it in
> `apps/erp/src/lib/pre-session-message.ts`.** Read its comment in full before designing anything.
> It states the rule and the reason:
>
> > *"⛔ **ANY string `code` marks an infrastructure error — not a five-character one.** The
> > five-character version was a real leak … `node_modules/postgres/src/errors.js` builds every
> > connection error as `Object.assign(new Error('write ' + code + ' ' + host + ':' + port),
> > { code, errno, address })` — single line, **no SQLSTATE** — so `ECONNREFUSED` and its siblings
> > sailed through and **put the database host and port in the URL**."*
>
> ⛔ **So the test is `typeof err.code === 'string'`**, which catches SQLSTATE, `ECONNREFUSED`,
> `ENOTFOUND` and Node's own `ENOENT` alike — **and a domain `Error` has none at all.**
> ⚠️ **A five-character check would leak the database host and port to the operator.** That is worse
> than the SQL grammar DEF-378 is about.
>
> ⛔⛔ **AND DO NOT WRITE A THIRD DISCRIMINATOR.** `pre-session-message.ts` already has this logic
> and `constraint-messages.ts` is the second place that needs it. A third copy is a third source of
> truth about what counts as a leaky error, and they will drift — the same argument `RULES.md` §6
> makes about re-implementing database constraints in TypeScript.
> ⭐ **Decide and state which of these it is, in the spec-review QUESTION, before writing code:**
> reuse `isUnfitForAStranger` directly, extract the shared predicate to one place both import, or
> keep them separate with a comment in each naming the other and saying why. **Any of the three is
> defensible; choosing silently is not.**
>
> ⚠️ **AND THE CODE-CHECK ALONE LEAVES A HOLE THAT FILE ALSO DOCUMENTS:** `env()` throws a plain
> `Error` with **no** `code` whose text names every unset environment variable. A pure
> has-a-`code` test passes it straight through. `pre-session-message.ts` closes that with a
> "written for a person" heuristic (a one-line sentence versus a multi-line dump). **Whether
> `errorMessage` needs the same protection is a real question this task must answer, not skip** —
> its 56 callers include screens a stranger can reach.

## Scope — disjoint by role

**BUILDER — source only, never a `.test.ts`:**
- `packages/domain/package.json`, `vitest.config.mts`, **`apps/erp/tsconfig.json`** — the three
  export entries (§1).
- `apps/erp/src/lib/constraint-messages.ts` — the resolution change (§2).
- **a NEW shared-predicate module under `apps/erp/src/lib/`** importing neither of the two files that
  consume it (§2b). Name it plainly; `error-shape.ts` is fine.
- `apps/erp/src/lib/pre-session-message.ts` — **only** to import the extracted predicates instead of
  defining them. ⛔ **No behaviour change there.** It is on the sign-in and setup paths; its existing
  tests must stay green untouched, and if one needs changing that is BLOCKED, not an edit.
- the sweep sites, **after** the enumeration is approved.

**TESTER — tests only:**
- ⛔ **`apps/erp/tests/` — NOT `apps/erp/src/`.** Every existing erp test lives there, including the
  sanitiser's own `constraint-messages.test.ts`. A `.test.ts` under `src/` would be the first, and
  would sit inside the Next build tree for no gain. *(The `apps/**/*.test.ts` glob is recursive, so
  `src/` would be collected — this is about where tests belong here, not about collection.)*
- ⛔ **`packages/domain/src/shared/money-input.test.ts` already exists — extend, do not rewrite.**

**⛔ Neither lane touches** `packages/core/src/money.ts`, `parseMoneyInput`'s own logic, or
`packages/domain/src/shared/money-positivity-*` (T-325, just shipped).

## Contract

### 1. `./money-input` becomes a real export — in THREE places, not two

⛔ **Revision 1 named two files and was wrong.** Found by the tester, verified: `./money-lines`
lives in **three**, and missing the third breaks `typecheck` after the other two are correct.

| File | What to add | Why it is not optional |
|---|---|---|
| `packages/domain/package.json` | the `exports` entry | the runtime/publish surface |
| `vitest.config.mts` | the alias | hand-written map, **no wildcard** |
| **`apps/erp/tsconfig.json`** | the `paths` entry | ⛔ **its own `paths` OVERRIDES the root's `@shareat/domain/*` wildcard rather than merging with it, and carries no wildcard of its own** — grep `"@shareat/domain/money-lines"` there and note the three exact entries |

⛔ **In `vitest.config.mts` the subpath entry goes BEFORE the bare `'@shareat/domain'`** — exact-match
aliases applied in order, with an in-file comment saying so.

⭐ **WHY THE tsconfig FAILURE IS TOTAL RATHER THAN ORDER-DEPENDENT, and it is worth knowing:**
`apps/erp/tsconfig.json` extends the root, and **TypeScript's `paths` in an extending config REPLACES
the inherited `paths` wholesale — it does not merge.** So the root's `@shareat/domain/*` wildcard is
not "overridden by precedence", it is **simply not present for anything under `apps/erp`**. That is
why the fix must be a fourth **exact-match** entry there and why no reordering helps. Neither that
map nor vitest's has a wildcard to fall through to, so an entry being merely *present* is not enough
— it must match `@shareat/domain/money-input` exactly.

> ### ⛔ A STATED NON-CHANGE — `apps/erp/next.config.js` NEEDS NOTHING, and here is why it looks like it does
>
> Anyone enumerating the resolution surface will find **three** `@shareat/domain` occurrences there
> and reasonably suspect a fourth place needing an entry — **a nastier one, because a missing webpack
> alias survives typecheck and unit and only dies on the real screen**, which is the one gate this
> task may have to report UNMET.
>
> ⭐ **It is a false positive, verified twice (auditor, then orchestrator):** two of the three are
> **comment prose**; the only real entry is `'@shareat/domain'` inside `transpilePackages`, which
> names the package as a whole. **There is no `webpack()` hook and no `resolve.alias` anywhere in
> that file.** Subpath resolution therefore goes through the package's own `exports` map — which §1
> is already adding `./money-input` to — and `transpilePackages` covers the subpath because it
> covers the package.
>
> ⛔ **So do not add an alias there.** It would duplicate the exports map as a second source of truth
> about where `money-input` lives. ⚠️ **Recorded as a non-change precisely so the next person doing
> this enumeration does not "helpfully" add one** — the trap is that counting textual occurrences of
> a package name counts comments, and comments are not entries.
⛔ **Nothing else joins the exports map.** Widening it further is a public-surface change and needs
its own task.
⭐ **Prove it from the consumer side**: a test in `apps/erp` that imports `parseMoneyInput` through
the package name and fails if the entry is missing. An export nobody imports across the boundary is
the DEF-129 shape — this one must be exercised from where it was unreachable.

### 2. `errorMessage` — THE RESOLUTION ORDER IS UNCHANGED; THE `code` CHECK GATES THE FALL-THROUGH ONLY

> ⛔⛔ **REVISION 1 OF THIS SECTION WOULD HAVE RE-CREATED THE T-270 REVERT — inside the task that
> cites it.** Found by the auditor, measured not reasoned. Revision 1 nested the mapped/unmapped
> lookups *inside* a "database error" branch and ended with *"everything else → never the raw
> text"*. Two consequences, both fatal:
>
> **(a) It destroys the five DEF-279 hand-authored sentences.**
> `packages/db/migrations/0142_t270_def279_constraint_using.sql` holds 5
> `RAISE EXCEPTION … USING CONSTRAINT` sites. `docs/discovery/33-def-279-live-trigger-bodies.md`
> records that **no RAISE in that population carries `ERRCODE`**, so PostgreSQL defaults them to
> SQLSTATE **P0001** — meaning **all five carry a string `code` and land in the database branch.**
> All five are unmapped (0 hits in `CONSTRAINT_MESSAGES`, 0 in `LOCALLY_MAPPED_CONSTRAINT_NAMES`):
> `journal_entries_balance_check`, `journal_lines_balance_check`,
> `stock_movements_no_negative_on_hand_trg`, `stock_layer_consumptions_ties_trg`,
> `order_wastage_allocations_sum_100_trg`. Their prose carries **no** `constraint "…"`, e.g.
> *"stock would go negative: item % at location % would be % after this movement"*.
> **Today they survive only because the fall-through returns raw text.** The "never the raw text"
> clause — the one added for safety — is what kills them.
>
> **(b) It makes the mapped lookup conditional on `code`.** Every existing test builds
> `new Error(raw)` with no `code` (grep `constraint-messages.test.ts` and
> `local-errormessage-convergence.test.ts`). Under the nested reading all 26 mapped sentences stop
> resolving and the suite goes red for a reason that looks like a test bug.

**The order below is TODAY'S order plus one carve-out. Steps 1–3 run regardless of `code`.**

1. **Mapped constraint** → its hand-authored sentence. **Unchanged.**
2. **A HUMAN-WRITTEN `RAISE EXCEPTION` → PRESERVED VERBATIM. The signal is `code === 'P0001'`.**

> ### ⛔⛔ AMENDMENT 3 — REVISION 2's CARVE-OUT PROTECTED 5 SENTENCES AND DESTROYED ~90
>
> **Revision 2 keyed this carve-out on a RESOLVED `constraintName`.** Raised by `/code-review`,
> verified by the auditor, and it is the worst error in this spec's history.
>
> Measured across `packages/db/migrations/*.sql`: **95 `RAISE EXCEPTION` occurrences, only 5 carry
> `USING CONSTRAINT`** (retrofitted by `0142` for DEF-279), and exactly **1** carries an explicit
> ERRCODE — which is `USING ERRCODE = 'raise_exception'`, i.e. **P0001 anyway**, so it changes
> nothing. Every other raise defaults to **P0001**, populates **no** `constraint_name`, and carries
> **no** `constraint "…"` in its prose.
>
> So under revision 2 they missed step 1 (unmapped), **missed step 2 (nothing to resolve)**, missed
> step 3 (no prose), and step 4 saw a string `code` and returned the generic fallback.
>
> ⭐ **THE VERIFIED CASUALTY — one, traced end to end by the tester and safe to cite:**
> `journal_entries_check_period_open()`, last defined in migration **`0143`** with nothing later
> touching it, raising *"cannot post journal entry into period % (status = %)"* and carrying no
> `USING CONSTRAINT` anywhere near it. Genuinely unprotected under revision 2's key.
>
> ⚠️ **AND A CORRECTION TO THIS SPEC'S OWN FIRST DRAFT OF THIS LIST, which is itself the lesson.**
> It led with *"journal entry % is unbalanced: debits % <> credits %"*. **That one is NOT a
> casualty — it is one of the five PROTECTED sentences.** `0142` redefines
> `journal_entries_trigger_check_balance` via `CREATE OR REPLACE` with the same message text **plus**
> `USING CONSTRAINT`, superseding `0003`'s bare version; migrations apply in order, so `0142`'s is
> what is live. ⛔ **Counting raises across migration FILES counts superseded definitions.** The
> auditor flagged that supersession caveat and the orchestrator then wrote the example list without
> applying it; the tester checked the example before using it and caught it.
>
> ⛔ **So the other candidates below are from `/code-review`'s list and are NOT individually verified
> against supersession** — cite them as a class, never as named live sites, until someone runs a live
> catalog query: *"account % is not postable"* · *"supplier invoice % is %, an expense cannot be
> recorded until it is verified"* · *"cannot move stock into a closed period"* · *"cash request % is
> not approved; it cannot be released"* · *"remittance % is already settled"*.
>
> **That is the T-270 regression at ~90× the scale revision 1 would have caused** — and it arrived
> inside the carve-out written to prevent it, protecting exactly the subset a previous task happened
> to retrofit.
>
> ⭐ **THE RULING — classify on the SQLSTATE itself:** `code === 'P0001'` is **application-authored**.
> P0001 is the code PostgreSQL assigns a `RAISE EXCEPTION` a human wrote without an explicit ERRCODE;
> a real constraint violation is **23xxx** and never P0001. This is principled rather than
> enumerative, and it **subsumes** the five DEF-279 sentences — they are P0001 too — so the old test
> keeps passing and proves the new rule contains the old one rather than replacing it.
>
> ⚠️ **The live count is lower than 95** — `CREATE OR REPLACE FUNCTION` supersedes, so the journal
> pair appears in both `0003` and `0142` while only `0142`'s is live. **The ratio and the defect are
> unaffected**, but any register row quoting a number needs a live catalog query first, which nobody
> has run. Do not quote 95 as live sites.
>
> ⛔ **The test must cover the ~90 case, not only the 5:** an error with `code: 'P0001'`, **no
> `constraint_name` at all**, and hand-authored prose. Keep the existing five-with-constraint-name
> test alongside it.
3. **Resolvable-but-unmapped constraint with `constraint "…"` in its prose** → the existing generic
   constraint message. **Unchanged.**
4. **Fall-through — THE ONLY STEP THIS TASK CHANGES:**
   - error carries **no** `code` → **unchanged behaviour**, the `Word: ` prefix strip. This is the
     DEF-301 path.
     ⚠️ **Except a codeless multi-line dump** — see §2a.
   - error carries **any string `code`** → **a presentable sentence**, never the raw text.

⛔ **`typeof err.code === 'string'`, NOT a five-character SQLSTATE match** (Amendment 1). SQLSTATE,
`ECONNREFUSED`, `ENOTFOUND` and Node's `ENOENT` are all `code`s; a domain `Error` has none.
⛔ **The raw text is never discarded — it goes to the server log.** Losing the diagnostic is the
other way to fail this task.

### 2a. The codeless dump — IN SCOPE, by REUSE, never by a new heuristic

`env()` throws a plain `Error` with **no** `code` whose text names every unset environment variable,
and it is reachable from any screen through `transaction()` → `packages/db/src/client.ts`. A pure
has-a-`code` test passes it straight through, and `errorMessage`'s callers include
`back({ error: errorMessage(err) })`, which puts the text **in a URL query parameter**.

⭐ **The protection already exists and is one line** — grep `looksLikeADump` in
`pre-session-message.ts`: `message.trim().includes('\n')`. ⛔ **Reuse it. Do not write a second
heuristic** — that is the third source of truth this task is already trying to prevent. It folds
into §2b's extraction.

### 2b. ONE shared predicate module — ruled, not delegated

⛔ **Revision 1 offered three options. Option 1 (import `isUnfitForAStranger` into
`constraint-messages.ts`) IS A BOOT CRASH, not a matter of taste.** `pre-session-message.ts` imports
`CONSTRAINT_MESSAGES` from `./constraint-messages` and evaluates
`new Set(Object.values(CONSTRAINT_MESSAGES))` **at module scope**. The reverse import completes a
cycle that enters `pre-session-message` while `CONSTRAINT_MESSAGES` is still in TDZ →
`ReferenceError: Cannot access 'CONSTRAINT_MESSAGES' before initialization`, **at import time, on
every screen importing either file.** Both the builder and the auditor found the cycle
independently; the auditor supplied the mechanism.

⭐ **RULING: extract the shared predicates into a NEW module that imports neither** — the
has-a-string-`code` test and `looksLikeADump` — and have both `constraint-messages.ts` and
`pre-session-message.ts` import it. ⚠️ **Moving `looksLikeADump` changes a file on the sign-in and
setup paths.** Its existing tests must stay green untouched; if any needs changing, that is
**BLOCKED**, not an edit.

### 3. The sweep is ENUMERATED before it is performed
⛔ **The lane produces the list FIRST and stops.** I approve the list, then it changes them.
A sweep that starts before its boundary is agreed is how a task becomes unbounded.

The list is: **every app-layer site where a human-typed string that is a MONEY AMOUNT reaches
`money()`, the domain, or the database without going through `parseMoneyInput`.**

> ⛔ **"did a human type this string" WAS THE FILTER IN REVISION 1 AND IT DOES NOT SURVIVE TWO
> READERS.** The auditor applied it literally and got **10** sites; I meant **1**. The nine extra are
> all human-typed and none is money — `approvedOtMinutes`, `chosenAnchorMinute`,
> `effectiveOutMinute`, `lineCount`, `anchorDay` ×2, `usefulLifeMonths`, `termPeriods`,
> `coverageMonths` ×2. **Two readers, two answers, on the spec's own worked example.**
>
> ⭐ **So the enumeration carries an EXPLICIT OUT-COLUMN**: every site the method touched and
> excluded, with the reason. A site excluded for "not money" must be *visible*, not silently absent
> — otherwise a list of 1 is indistinguishable from a list of 10 with 9 omissions, which is exactly
> the failure the enumeration exists to prevent.

> ### ⛔⛔ THE POPULATION IS 56 FILES, NOT 35 — AND THE 35 WAS A SPELLING, NOT A SHAPE
>
> **The orchestrator first bounded this as "the 35 `actions.ts` files that use `str(formData`".
> That is exactly right for that spelling and it is not the population.** Found by the auditor,
> re-derived independently:
>
> | Measure | Count |
> |---|---|
> | files calling `str(formData, '` | 35 |
> | files calling `str(fd, '` | 27 |
> | **union — the real population** | **56** |
> | ⛔ **invisible to the stated pattern** | **21** |
> | *cross-check:* files defining their own local `function str(` | **56** ← exact match |
>
> ⛔ **AND SEVEN OF THE 21 CARRY HUMAN-TYPED MONEY**, measured:
> `commissary/catalogue` `manualCost` · `commissary/orders/[id]` `rate` ·
> `inventory/production` `labourCost` · `inventory/returns` `amount` ·
> `trade/orders` `deliveryFee` **and** `otherFees` · `trade/returns` `amount` · `wastage` `amount`.
> **Every one is a person typing a peso value, and the stated bound could not see any of them.**
> The other 14 look like ids and reasons — but they must be excluded **through the out-column**, not
> by never appearing.
>
> ⚠️ **THIS REPO ALREADY LEARNED THIS EXACT LESSON AND WROTE IT DOWN.** Grep
> `local-errormessage-convergence.test.ts` for its own census note: *"The first census of this defect
> counted files declaring `function errorMessage`, found 38, and MISSED FOUR… A spelling-based guard
> would have shipped that hole."* **The bound reproduced it one spelling over.**
>
> ⭐ **So derive the enumeration from a SHAPE:** `str\((fd|formData)\b` at minimum, better still
> "the local `str()` helper's call sites, whatever its parameter is named". **State the union figure
> as the denominator**, so the out-column can be checked against a real total rather than a
> pattern's total.

⭐ **Measured starting points, verified 2026-09-19 — treat as a floor, not the answer:**
- **2 files define a local `money()` that shadows `@shareat/core`'s — but only ONE is a parse path.**
  ⭐ `apps/erp/src/app/channel-settlements/actions.ts` — grep
  `function money(fd: FormData, key: string)` — returns `str(fd, key) || '0'`, **a function named
  `money` that validates nothing**, and it feeds **9 live fields** into `recordChannelSettlement`
  unvalidated (`loanAmount`, `grossAmount`, `netDeposited`, `commission`, `marketing`,
  `platformFee`, `vatOnFees`, `withholdingTax`, `penalty`). **`"abc"` passes straight through.**
  ⚠️ The second, `SettlementForm.tsx`'s `money(v: string)`, is a **display formatter** — number to
  currency string for rendering — and never reaches the domain or the database. **Out of scope**;
  revision 1 implied otherwise. *(Note the two have different signatures, so a single grep finds
  only one of them.)*
- **82** `money(` call sites under `apps/` — **most are on already-computed values and are NOT in
  scope.** Do not convert them.
- ⭐ **A site I pointed at wrongly, and the builder found the better one:**
  `apps/erp/src/app/ap/actions.ts`'s invoice-lines loop pushes `quantity` and `unitPrice` as raw
  `str(formData, …)` strings into `lines` with no parsing at all, and derives
  `lineTotal: (Number(quantity) * Number(unitPrice)).toFixed(2)` — **so a non-numeric entry produces
  the literal string `"NaN"`, which reaches the domain and the database.** That is three unvalidated
  fields at one site, not the "1 `Number(` on a form value" revision 1 described.

⛔ **Do NOT copy the parser into the app.** A second money parser is a second source of truth about
what a valid amount is, and the two will drift. That option was considered and rejected by the lane
that filed DEF-379.

## Invariants

1. **A hand-authored application error still reaches the screen intact** (DEF-301 / T-270), **and so
   do the five DEF-279 database RAISE sentences** (§2 step 2). The regression tests for these are
   the highest-value tests in the task.
2. **Nothing a machine wrote reaches the screen.** Not SQL grammar (`invalid input syntax`,
   `undefined_column`, type names, quoted identifiers); **not a host or a port** from a connection
   error; not a multi-line configuration dump.
   ⭐ **The host/port half is why the five-character test was wrong** — assert its absence
   explicitly, not by implication.

   ⛔⛔ **AND THIS INVARIANT IS KNOWINGLY FALSE IN TWO PLACES. Stated, because an invariant with an
   undocumented exception is worse than a narrower invariant honestly drawn.**

   **(a) Two domain sites re-wrap errors and DROP the `code`** — grep `err instanceof Error ?
   err.message : String(err)` in `packages/domain/src/remittance/index.ts` and
   `packages/domain/src/expenses/categories.ts`. A driver error surfacing through either arrives at
   `errorMessage` **codeless** and takes the unchanged application branch, rendering raw Postgres
   text. Pre-existing, **bounded at exactly 2** (the shape was grepped across `packages/domain/src`
   and `apps/erp/src`), not introduced here, and not fixed here because changing domain error
   propagation is a different task's risk. **Filed.**

   **(b) The P0001 class is preserved BY DESIGN, and not all of it was written for an operator.**
   `code === 'P0001'` means *a human wrote this `RAISE`* — it does **not** mean *a human wrote this
   for a cashier*. At least two live raises are plainly developer-facing and now render verbatim:
   the `attendance_punches is append-only … supersedes_punch_id … bible 4.2 rule 9` message and the
   `stock_movements is append-only` one. **So an operator can read a table name, a column name and
   an internal doc citation.**
   ⚠️ **Sanitising them is not the answer** — that is the T-270 regression this task spent two
   rounds escaping. The real gap is that **nothing in the system distinguishes a database message
   written for a cashier from one written for a developer**, and roughly a hundred of them exist.
   **Filed for triage.**
3. **The raw text survives in the server log** for every sanitised error.
4. **`parseMoneyInput` is importable from `apps/erp` by package name**, proven by a test from there.
5. **`errorMessage`'s signature does not change**, so its existing call sites keep compiling.
   ⚠️ **Revision 1 said "the 56 existing call sites" and that figure was wrong in kind, not just in
   value.** Measured: **52 production files** call it, containing **~200+ call sites**; 56 was
   files-containing-the-string, which included the definition, a comment-only mention and test files.
   ⛔ **And a raw count of the name measures nothing regardless — `errorMessage` has 24 separate
   definitions in this tree**, of which 23 are local wrappers that delegate to the shared one.
   State the unit when quoting this invariant back.

## Tests

- **T1 — Invariant 1.** An application `Error('createCashRequest: the amount must be positive')`
  renders as today, prefix stripped, text intact. ⛔ Assert the exact string.
- **T2 — Invariant 2, per class.** Fabricate errors carrying SQLSTATE codes — at minimum
  `22P02` (invalid text representation), `42703` (undefined column), `42P01` (undefined table),
  `22003` (numeric out of range) — and assert none of the output contains SQL grammar.
- **T2b — ⭐ THE CASE THAT WOULD HAVE CAUGHT MY ORIGINAL ERROR.** A connection error exactly as the
  driver builds it:
  `Object.assign(new Error('write ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' })`.
  **Assert the output contains neither the host nor the port.** ⛔ Under revision 1's five-character
  SQLSTATE test this sailed through and put the database address on screen. Without this test the
  amendment is a comment.
- **T2c — the DEF-279 carve-out (§2 step 2), and it protects five live sentences.** An error whose
  constraint field resolves but whose prose carries **no** `constraint "…"` — e.g. message
  *"stock would go negative: item X at location Y would be -3 after this movement"* with
  `code: 'P0001'` and the constraint name set. **Assert the sentence is returned verbatim.**
  ⛔ Without this, T-270 is reverted a second time by the task that cites it.
- **T2d — the codeless dump (§2a).** A plain `Error` with **no** `code` whose message is multi-line
  → the generic sentence, and the raw reaches the log. ⭐ Both the tester and the auditor reached
  this independently from `env()`'s banner; it is settled contract now, not a guess.
- **T3 — unknown code.** A made-up **non-SQLSTATE** string code lands on the safe generic sentence,
  **not** the raw text. The space of `code` values is far larger than SQLSTATE.
- **T4 — mapped and unmapped constraints unchanged, WITH AND WITHOUT a `code`.** ⛔ Every existing
  test builds `new Error(raw)` with no `code`; if resolution is accidentally nested inside a
  database branch, all 26 mapped sentences stop resolving. Assert both shapes.
- **T5 — Invariant 3.** The raw text reaches the logger.
- **T6 — Invariant 4.** Import `parseMoneyInput` from `@shareat/domain/money-input` inside `apps/erp`
  and use it. ⚠️ **Confirm the test is COLLECTED** — check the test count rises. T-325 lost a
  verification to a file sitting outside every include glob, and it looked exactly like a pass.
- **T7 — a bad money string from the app layer** now produces the cashier-readable sentence rather
  than `TypeError: Invalid money string:`.

⛔ **For each test ask: what value would have to be wrong for this to go red, and does the code under
test supply it?** T-325 shipped three tests that could not fail before that question caught them.

## §9.4 — and this task DOES have a screen

⭐ **Unlike T-325, this changes what an operator reads.** That is the point of it, so the screen test
is not optional and "the unit tests pass" does not substitute.

⚠️ **Sign-in on this machine is a known constraint, measured:** all five `NEXT_PUBLIC_FIREBASE_*` in
`.env.local` are empty and DEF-371 records that `/sign-in` has no emulator path of its own. T-323
shipped the emulator route; reaching a signed-in screen needs Ian. ⛔ **A token or a password is
off-limits to an agent and "it is a throwaway emulator credential" is not an exemption.**
⛔ **If the screen cannot be reached, §9.4 is reported UNMET in those words** and goes to Ian under
bible row 203. It is not skipped quietly and it is not called done.

## Out of scope

- ⛔ DEF-374, DEF-380, DEF-373, T-320. Separate work.
- ⛔ DEF-381's census blind spots. Filed today, not this task.
- ⛔ Widening the exports map beyond `./money-input`.
- ⛔ Changing `parseMoneyInput`'s own behaviour or `money()`'s.

## Done when

Every §9 gate: typecheck · unit · integration on the lane DB · build with 9008 free · the auditor's
`/code-review` returned and triaged · `callers.mjs` clean · **§9.4 on the real screen, or reported
UNMET to Ian in those words** · committed with a message saying *why* · **DEF-378 and DEF-379 marked
closed and the roadmap made true — by the orchestrator, not a lane.**

⚠️ **One for the orchestrator:** file the `money()` shadowing in `channel-settlements` as its own
register row — a function named `money` that performs no money validation, shadowing one that does,
is a naming collision that actively misleads, and it is separate from DEF-379's export gap.
