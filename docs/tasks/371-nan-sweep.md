# T-371: NaN sweep, by the column and not by the spelling (DEF-382, DEF-395)

**Status:** **IN PROGRESS 2026-10-03, on branch `wip/2026-10-03b` (not on `main`, per ✎R9): S0 + S1 + S3 done and audited; S2 28/31 groups (till-fiscal, statutory-discounts, ledger failed on an expired API token — re-run); S4 next. Ian opted in to running S3/S2 as a multi-agent Workflow ("use a workflow for T-371", 2026-10-03). Census as measured (approved): 160 columns / 65 tables; 159 Drizzle writers + 9 raw; 315 relational comparisons scanned (74 EXEMPT); 16 forgeries → 0 after S3.** — empty-box ruling "field decides" 2026-09-30 — APPROVED 2026-09-30 (orchestrator, after independent Opus review). Spec by the Opus planner, 2026-09-30.
The review asked for 14 changes; all are applied (marked ✎R1 to ✎R14). This is the last task of Ian's money-defect
push (*"close all open money defects in v2"*), batch F of `docs/plans/money-defects-2026-09-30.md`.

**Order (✎R12).** T-371 starts only after T-364 to T-370 **and T-372** have landed. Every other money lane stays
frozen from the start of S3 until the S2 flip is committed. S0 re-runs the census at that HEAD.

**Model.** Sonnet for every agent. The S0 TESTER goes first and S1 is one BUILDER. S3 and S2 run as a `Workflow`
with one BUILDER per module, S3 first (✎R9).

**Migration.** None. The database half shipped as `0155` (T-327: a finite CHECK on all 160 numeric table columns). If
a migration turns out to be needed, it takes the next free index at build; 0172 to 0174 are taken.

**Where the numbers come from.** Measured at HEAD `594f600` on the working tree, which includes T-364's three
uncommitted files. The census comes from three read-only AST scripts that use the TypeScript compiler API over the
source, not grep. S0 re-implements them as a committed test library and widens them per this review, so every figure
below is reproduced by code rather than carried forward. ⚠️ The planner's scan was repo-only and spelling-based in
two places. The review (✎R1, ✎R5, ✎R6) measured misses in both, so the figures below are floors until S0 re-derives
them with the checker.

## Goal
A non-finite or malformed figure must not reach a comparison or a write, on any path, under any helper name. The proof
of that must fail when a new path appears. Three things deliver it.

- **One chokepoint.** Only `@shareat/core/money` can make a value that may be written to a constrained numeric
  column. That value is a branded `Decimal<'p,s'>`. `Money` is `Decimal<'14,2'>` and `Quantity` is
  `Decimal<'14,3'>` (✎R4).
- **The compiler finds the callers.** Every writer types its constrained fields with the brand. An unparsed string
  then cannot reach a writer under any spelling: `str`, `strs`, `amount`, a template literal, `fd.get`, `...input`,
  `JSON.parse`, or a jsonb payload.
- **No float or NaN comparisons.** Domain comparisons on figures go through core `compare*` on branded values
  (RULES §6), found by the type checker (✎R6).

## Why T-327 and T-328 missed sites, and what changes here
T-327 was correct, and it stays the backstop. It has no call-site census because it never asks which columns hold
money.

T-328 enumerated the **spellings** by which a form value is read, and every census since has missed one more:
- the 5th spelling: a helper under another name;
- the 6th: `strs` and `list`;
- the `amount(fd,k)` and `money(fd,k)` shadows;
- DEF-395: spelling #1 again, `overdraftLimit`;
- the attendance cluster, behind `.values(input as never)`, with no per-field code to match;
- `threshold`, which has no domain function in its path at all.

The auditor's own instrument then missed two attendance fields to abbreviated SQL names. An enumeration keyed on how
a value is *read* is never complete.

**This task keys on the column.** The chain is: the constrained column → every write that targets it, anywhere in the
tree → the brand that write demands → the compiler. The brand is minted in one function. The guard test re-derives
the columns, the writers and the comparisons with the type checker on every run. There is no list of spellings to go
stale.

## Census (derived now; S0 reproduces it and widens it)

### A. Columns
- **160** numeric columns in `pgTable`s, across 65 tables. All 160 carry a `*_finite_check`.
- There are 110 distinct TS keys.
- Shapes, as (precision,scale): 107 × (14,2) · 27 × (14,3) · 9 × (4,2) · 7 × (14,4) · 4 × (8,4) · 3 × (14,6) ·
  one each of (5,2), (6,3) and (6,2).
- A shape is read from Drizzle's TS key, not the SQL name, so abbreviated names cannot hide.
- ✎R14: `schema/*.ts` contains **170** `numeric(` occurrences. The 10 or more beyond the 160 include the SQL casts in
  `views.ts` (`::numeric(14,2) as debit_total` at `:113-118`). The reviewer also counts 119 (14,2) occurrences against
  107 columns. S0 step 0 must reconcile both numbers.

### B. Writers
All found by the planner's scan, which covered `packages/db/src/repo` only:
- **155 write sites in `repo/`**:
  - 151 are Drizzle `.insert(T)`/`.update(T)` calls, in 147 functions across 41 repo files;
  - **4 are raw SQL**, all in `repo/items.ts`: `:135` `insert into supplier_invoice_lines`, `:648`
    `update supplier_invoice_lines`, `:652` `update price_list_items` and `:945` `insert into item_pricing`.
- 48 of the sites are spread-shaped: `.values(input…)`, `{...x}` or `as never`.
- 2 app actions call a repo writer directly: `fixed-assets/actions.ts` → `updateTerms`, and
  `inventory/low-stock/actions.ts` → `setThreshold`.
- ✎R1 **A floor.** Writers exist outside `repo/`, for example `packages/domain/src/production/index.ts:779`:
  `tx.update(stockLayersTable).set({ remainingQuantity: sql\`… - ${input.quantity}::numeric\` })`.
  S0 scans `packages/**`, `apps/**` and `scripts/**`.
- ✎R2 SQL-typed values that target a constrained column include `repo/stock-layers.ts:102`, `:198` and
  `production/index.ts:779`.

### D. Domain comparisons (local-spelling scan; ✎R6 replaces it with the checker in S0)
- 236 coercions, 170 `.toFixed(` calls and 152 relational comparisons with a coerced operand.
- **150 of those comparisons are unguarded:**
  - 33 are rooted in a function parameter (reachable by NaN);
  - 37 are already parsed (NaN-safe, but still float comparisons). The site DEF-382 cites, `cash-requests/index.ts:55`,
    is one of these;
  - 80 are derived.
- **36 of them compare a value named for a constrained column**, which matches DEF-382's "about 36".
- The scan cannot follow a helper across functions (`toNum`) or see a raw string comparison (`'abc' > '0'`). The checker
  leg (✎R6) can.

### F. Domain input fields named for a constrained column
- 165 are typed `string`, 38 are `Money`, and 28 are other types.
- `attendance` shows 0 because its input is `changes: Partial<…>`. That is why the chokepoint is the writer (B) and
  not F.

### E. App form reads of a constrained key
- 120 reads of 73 keys, across 25 route directories.
- None is parsed at the read site, and only 5 app files import `parseMoneyInput`. This is a floor.

### Per module
| Module | Writer sites (repo files it owns) | NaN-blind cmps (param / parsed / derived) | on a column key | `string` input fields | App dirs |
|---|---|---|---|---|---|
| ar | 8 (ar) | 23 (2/1/20) | 13 | 5 | — |
| ap | 7 (ap) | 16 (7/3/6) | 3 | 8 | ap 6 |
| loans | 2 | 14 (2/4/8) | 0 | 4 | loans 4 |
| remittance | 4 | 11 (7/0/4) | 0 | 3 | remittance 2 |
| owners | 3 | 9 (1/2/6) | 1 | 11 | owners 6 |
| prepaid | 3 | 9 (0/5/4) | 0 | 2 | prepaid 2 |
| trade | 15 (trade) | 9 (2/3/4) | 4 | 19 | trade 7 |
| cash-requests | 2 | 7 (0/4/3) | 1 | 3 | cash-requests 5 |
| liabilities | 0 | 7 (4/0/3) | 3 | 2 | liabilities 2 |
| items | 4 raw SQL (items) | 6 (2/0/4) | 4 | 8 | — |
| cutover | 2 (cutover, etl) | 5 (0/2/3) | 0 | 5 | cutover 3 |
| money-transfers | 2 | 5 (0/4/1) | 0 | 2 | money-transfers 2 |
| expenses | 5 | 4 (0/2/2) | 0 | 2 | expenses 5 |
| service-charge | 0 | 3 (0/2/1) | 0 | 1 | service-charge 1 |
| wastage | 5 (order-wastage) | 3 (0/1/2) | 2 | 3 | wastage 3 |
| attendance | 2 (attendance-config) | 2 (0/0/2) | 0 | 0 ⚠ | settings 11 |
| channel-settlements | 3 | 2 (1/1/0) | 1 | 14 | channel-settlements 9 |
| customers | 3 | 2 (0/1/1) | 0 | 1 | customers 5 |
| money-accounts | 5 | 2 (1/0/1) | 1 | 1 | money-accounts 1 |
| pos | 4 (pos-mapping) | 2 (2/0/0) | 1 | 1 | — |
| recurring-expenses | 3 | 2 (0/1/1) | 0 | 2 | — |
| payroll | 8 (payroll, separations, thirteenth-month) | 1 (1/0/0) | 1 | 3 | payroll 2 |
| sales-days | 7 | 1 (0/1/0) | 0 | 14 | sales-days 12 |
| stock | 19 (stock-layers, stock-ledger, stock-transfers, stock-usage, count-sessions, customer-returns, supplier-returns) | 0 | 0 | 7 | inventory (rest) 13 |
| commissary | 8 (commissary-catalogue, low-stock, trade-discrepancies) | 0 | 0 | 11 | commissary 12 |
| production | 9 | 0 | 0 | 9 | — |
| fixed-assets | 7 | 0 | 0 | 5 | fixed-assets 3 |
| stores | 5 | 0 | 0 | 2 | admin 1 |
| budgets | 3 | 0 | 0 | 1 | budgets 1 |
| deliveries | 3 | 0 | 0 | 7 | — |
| statutory-discounts | 2 | 0 | 0 | 2 | statutory-discounts 2 |
| ledger | 1 (journal) | 0 | 0 | 4 | — |
| till | 1 (till-shifts) | 0 | 0 | 1 | — |
| shared (S1) | 0 | 5 (1/0/4) | 1 | 2 | — |
| **Total (repo-only, local spelling)** | **155** | **150 (33/37/80)** | **36** | **165** | **120** |

### Brand forgeries
- 6 `as Money` casts outside `packages/core` (tests excluded). One forges a brand onto user input:
  `production/index.ts:739`, `(input.labourCost ?? record.labourCost) as Money`.
- ✎R5 There are also **7 or more `as Quantity` forgeries** that a spelling scan for `as Money` misses:
  - `production/validate.ts:27` and `:72`;
  - `stock/consume.ts:163`;
  - `stock/transfers.ts:62`;
  - `trade/index.ts:623`;
  - `trade/returns.ts:608`.

### Parsers
- **The human-facing (humane) parsers:** `parseMoneyInput`, and `parseQuantityInput`, which sits on
  `commissary/orders.ts::parseQuantity`. `parseWholeNumberInput` is integer-only and out of scope.
- **The DEF-383 validators:** `normaliseRate`, and `MANUAL_COST_PATTERN` with `parseFourDecimalCost`.
- ✎R4 **Quantity is a second brand.** `packages/domain/src/stock/quantity.ts:35` defines
  `Quantity = string & { __brand: 'Quantity' }`, with its own mint (`quantity()` and `fromThousandths`), used in
  about 82 files.

### Repo-file ownership
A repo file belongs to the domain module of the same name. Failing that, it belongs to the module that calls its
writers most. The assignments in the table are mechanical; ties were broken by name.

## Rulings (planner, amended by the review)
- **R1: the chokepoint is the writer's input type, not the domain input type.**
  - A writer is any write, anywhere, that targets a constrained column (✎R1).
  - B is keyed on the column; F is keyed on a name and misses `attendance`.
  - Domain entry functions may keep taking `string` and parse at entry. The compiler forces the parse either way.
- **R2: the brand is minted in exactly one place, `decimal()` in `@shareat/core/money`.**
  - `money(v)` is `decimal(v, '14,2')`.
  - ✎R4 `quantity()` and `fromThousandths` are `decimal(…, '14,3')`. `Quantity = Decimal<'14,3'>` moves to core, and
    `stock/quantity.ts` re-exports it so the ~82 importers do not churn.
  - Every other parser (`parseMoneyInput`, `parseQuantityInput`/`parseQuantity`, `normaliseRate`,
    `parseFourDecimalCost`) keeps its accepted set and its sentences byte-identical. Its **return value** then passes
    through `decimal()` with the column's shape.
  - This adds no validator. It is one mint underneath the existing ones, and DEF-383 stays open for merging them.
- **R3: the brand carries precision and scale as a string literal**, for example `'14,3'`.
  - The guard compares it to the column's `getTableConfig` precision and scale.
  - So a (14,4) value cannot land in a (14,2) column and be silently rounded (DEF-272's class).
  - A (4,2) hours value above 99.99 now gets a sentence instead of a raw overflow.
- **R4: database values that are re-written are re-minted (`money(row.x)`), never cast.** `0155` keeps NaN out of
  stored data, so the re-mint never refuses; it closes the hole in the type system.
- **R5: authorise first (T-364).** Every new parse runs **after** `authorize()` (DEF-496, DEF-497).
- **R6 (✎R13): a blank figure follows its column, never a guessed zero.**
  - A **NOT NULL column with no default**: refuse the blank, with a sentence.
  - A column **with a default**: omit it on insert, so the database default applies; leave it unchanged on update.
  - A **nullable** column: store null.
  - **`'0'` is never invented.**
  - Why:
    - `money_accounts.overdraft_limit` is NOT NULL DEFAULT `'20000.00'`. Treating a blank as zero would silently set
      a ₱0 overdraft limit.
    - The server never sees the form's `required` attribute, so the column is the only rule it can apply.
    - v1 zeroes blanks at about 138 `|| 0` sites, and v2's `statutory-discounts/actions.ts:70` `|| '0'` does the same
      to a required box.
  - Q1 asks Ian to confirm.

## Contract

### C1: core (`packages/core/src/money.ts`)
- `type Decimal<S extends string = string> = string & { readonly __decimal: S }`.
- `type Money = Decimal<'14,2'>` and `type Quantity = Decimal<'14,3'>` (✎R4). Every existing user keeps compiling.
- `decimal<S extends \`${number},${number}\`>(value: string | number | bigint, shape: S): Decimal<S>`:
  - **The accepted set equals `money()`'s today (✎R11)**, generalised to `scale` places and to `precision - scale`
    integer digits.
  - That set includes surrounding whitespace (trimmed), `"0.00"`, `"-0"` and `"-0.00"`, which normalise to `"0.00"`.
  - It keeps `money()`'s **number path**: finite numbers only, exact to `scale` places.
  - A leading `+` is **refused**, because `money()` refuses it today. The positive-control test pins this, so any
    change is visible.
  - It throws `TypeError` for a malformed value and `RangeError` for an out-of-range one, the same split as `money()`.
  - It never accepts `NaN`, `Infinity`, exponents or `''`.
- `compareDecimal(a, b)` works in scaled bigint. `compare` stays. `money()` and `quantity()` delegate to `decimal()`.
- `fromCentavos` and `fromThousandths` return the brand. `moneyFromLegacyFloat` is unchanged.

### C2: db (`packages/db/src/repo/numeric-input.ts`, new, exported)
- `SafeInsert<T>` is `T['$inferInsert']` with every `PgNumeric` column mapped to `Decimal`. `SafeUpdate<T>` is its
  `Partial`.
- **Every writer** types its argument with these (or `Pick`s of them). This covers repo writers and any writer
  elsewhere (✎R1).
- There is no `as never`, `as any` or `as unknown` inside the argument of a write that targets a constrained table.
- ✎R3 **No argument property may be typed `any` or `unknown`.** A value from `JSON.parse`, `req.json()`, a jsonb
  payload (etl, production, pos-mapping, scheduler) or the ingestor's `raw_event` is minted through `decimal()` before
  it reaches the writer.
- ✎R2 A `drizzleSql` expression assigned to a constrained column must interpolate only values branded with **that
  column's** `'p,s'`, besides column references and literals. Example: `${input.quantity}` in `remainingQuantity - …`
  must be `Decimal<'14,3'>`.

### C3: domain (`packages/domain/src/shared/money-input.ts`)
- `parseDecimalInput(raw, shape, rawLabel, humanLabel)` is the humane wrapper over `decimal()`. Its sentence names
  the field, the decimal places allowed and the maximum.
- `parseMoneyInput` is `parseDecimalInput(raw, '14,2', …)`, with its sentences unchanged. DEF-408 is out of scope.
- `parseQuantityInput` returns `Quantity`.
- A blank is handled per R6 by `parseDecimalInput`'s `blank: 'refuse' | 'omit' | 'null'` option. The caller passes
  the option the column dictates.

### C4: the comparison rule
Every site the G2 checker reports for a module ends in one of two states:
- **(a)** rewritten to `compare`, `compareDecimal`, `compareQuantity` or `isZero` on branded values; or
- **(b)** entered in the guard's `EXEMPT` map, with a reason from a closed list that names the operand's source:
  - `not-a-column-value` (minutes, counts, month terms, indices);
  - `display-only`.

## Invariants (every slice)
- **RULES §6:** code uses integer centavos or scaled bigint, and the database enforces the rules. `0155` is
  unchanged.
- **No value accepted today is refused tomorrow**, except in two named cases, each stated in the commit that makes it:
  - a string with more places than its column's scale, which is now refused instead of silently rounded
    (`parseMoneyInput` already does this for (14,2), DEF-272);
  - ✎R13 a **blank** in a NOT NULL, no-default column, which is now refused instead of becoming `'0'` (R6).
- **Refusals are presentable** (T-343): a `userMessage` that names the field in human words. Nothing is written.
- **Parse after `authorize()`** (R5).
- **Bible row 214:** S1 rewrites the blind-spot (2) paragraph in `money-positivity-guard.test.ts` ("strictly quieter …
  never stored malformed").
- **Counts and denominators:** no test name carries a count, and every denominator is derived at runtime.
- **Tooling:** pure `fs` plus the TypeScript compiler API. The tests never shell out to grep or git.
- ✎R9 **`main` stays green at every commit.** There is no red window, no branch and no worktree.

## Slices

### S0: TESTER. The census as code, red first (sequential)

**TESTER owns:**
- `tests/unit/lib/numeric-write-census.ts`;
- `tests/unit/t371-numeric-write-guard.test.ts`;
- `tests/unit/t371-decimal.test.ts`;
- `packages/domain/tests/integration/t371-<module>-nan.test.ts`, one per module;
- `apps/erp/tests/integration/t371-direct-repo-writes.test.ts`.

**Step 0: re-derive the census at the ✎R12 HEAD and reconcile it.**
- Re-derive every census figure.
- ✎R14 Reconcile the 170 `numeric(` occurrences against the 160 columns. Name every occurrence that is not a
  `pgTable` column: view SQL casts, or helper or non-`pgTable` definitions. The reviewer also counts 119 (14,2)
  against 107; that must be reconciled too.
- Widen B to `packages/**`, `apps/**` and `scripts/**` (✎R1).
- Replace D with the checker (✎R6).
- Report every total that differs from this spec to the orchestrator, and stop until the orchestrator approves.

**The four guard legs.** Each module is an `it.each` case, so the Workflow reads a per-module done signal.

- **G1, writes (type checker).**
  - Population: every constrained column (from `getTableConfig`, at runtime) × every write that targets it, anywhere
    in `packages/**`, `apps/**` or `scripts/**` (✎R1).
  - For each pair, the argument property for that column must carry a `__decimal` literal equal to the column's
    `'p,s'`.
  - Fail on:
    - any cast in the argument;
    - any property typed `any` or `unknown` (✎R3);
    - an SQL-typed value that interpolates anything other than a same-shape brand, a column reference or a literal
      (✎R2). An `EXEMPT` reason alone does not pass an SQL value.
  - Raw-SQL writers must be listed in `RAW_SQL_WRITERS` by function name, so a new one fails closed. Their parameter's
    numeric fields must be branded.
- **G2, comparisons (type checker, ✎R6).**
  - Flag every relational operand that has type `number` and whose value derives from a call on a `string`-typed
    argument, followed across functions (helpers such as `toNum`).
  - Also flag any relational comparison whose two operands are both `string` (for example `'abc' > '0'`).
  - The flagged set, keyed by file, enclosing function and normalised expression text (never line numbers), must
    **equal** the `EXEMPT` set. There is no ceiling that could hide a swap.
  - A new module directory fails closed.
- **G3, forgery (type checker, ✎R5).** No type assertion outside `packages/core/src` may target a type that resolves
  to a `__decimal` brand. That covers `as Money`, `as Quantity`, `as Decimal<…>`, `as unknown as …` and any alias,
  whatever its spelling.
- **G4, schema.** Every `PgNumeric` column in a `pgTable` has a finite check. This extends T-327's test.
  - ✎R7 **G4 is green today (160 of 160).** It is shown red only by its mutant.

**✎R8 Floors and sentinels.** Each leg fails if its population is 0, so an empty scan cannot pass. Named sentinels
must be present in their population:
- G1: the `renameMoneyAccount` writer;
- G2: a site in `cash-requests/index.ts`;
- the raw-SQL list: `repo/items.ts` `insert into item_pricing`;
- the SQL-value check (✎R2): `production/index.ts` `remainingQuantity`.

**`t371-decimal.test.ts`** (red until S1).
- For each of the nine shapes, derived at runtime, it **accepts**:
  - `0`, the maximum, the negative maximum, and exactly `scale` places;
  - ✎R11 `"0.00"`, `"-0"` and `"-0.00"` (all of which normalise to `"0.00"`), surrounding whitespace, and
    `money(number)` for an exact finite number.
- It **refuses**:
  - the maximum plus one step, and `scale + 1` places;
  - `NaN`, `Infinity`, `-Infinity`, `abc`, `''` and `' '`;
  - `1e3`;
  - a leading `+`. That pins today's `money()` behaviour, and the leading `+` assertion carries a comment saying so.
- **Equivalence:** `money()` gives the same answers as before on every input in `tests/unit/money.test.ts`, and
  `quantity()` the same on `stock/quantity`'s tests.

**Per-module NaN tests** (integration, real Postgres, lane DB).
- Coverage: each domain entry that owns a flagged site, plus the register-named sites:
  - `overdraftLimit`, `acknowledgedAmount`, `totalCost`, `threshold`;
  - `deliveryFee` and `otherFees`, and `trade/returns` `recordCollection`;
  - the 11 attendance fields;
  - `labourCost`, `grossAmount`, `discountAmount`, `quantityPerSale`, `ownershipPercentage`, `interestRate` and
    `unremittedCeiling`.
- Feed each one `'abc'` and `'NaN'`, and assert:
  - the exact `userMessage`;
  - **zero rows changed**;
  - a later valid call succeeds, so no partial state was left.
- ✎R13 Blank cases, one per column kind:
  - `statutory-discounts` gross amount (NOT NULL, no default) is refused;
  - `overdraftLimit` left blank on insert stores `20000.00`, and on update stays unchanged;
  - a nullable column stores null.
- One positive control per file: a valid amount on the module's main entry writes and reads back byte-identical.

**Red shown.** Every G leg except G4 (✎R7), and every per-module test, is red at HEAD **for the stated reason**. The
failure names the site, not an import error, and is pasted into the hand-off.

### S1: BUILDER, foundation (one agent, sequential)
**Owns:**
- `packages/core/src/money.ts`;
- `packages/db/src/repo/numeric-input.ts`;
- ✎R10 the barrels: `packages/db/src/index.ts` and `packages/domain/src/index.ts`. S1 is their only owner; any later
  export an agent needs is returned as `BLOCKED`;
- `packages/domain/src/shared/**`;
- `packages/domain/src/stock/quantity.ts`, which re-bases on core per ✎R4;
- within other files, only these symbols: `commissary/orders.ts::parseQuantity`,
  `commissary/catalogue.ts::parseFourDecimalCost`, and `normaliseRate`'s return.

**Work:**
- Implement C1, C2 and C3.
- Clear the `shared` sites.
- Rewrite the blind-spot (2) paragraph.

**Done when:** `t371-decimal` is green, G4 is still green, the `shared` cases are green, and typecheck is clean.
Widening the brand compiles, because both brands are still string subtypes.

### S3 first (✎R9): Workflow phase 1, one BUILDER per module (parallel; domain and app files; writers untouched)
Every domain entry parses at its entry, after `authorize()`, into brands. It passes those brands into writers that
are **still typed `string`**. A brand is a `string`, so **the tree compiles and `main` stays green after every agent**.

**Ownership (✎R10):**
- `packages/domain/src/<module>/**`.
- `apps/erp/src/app/<dir>/**`, following the table, with these assignments:
  - `settings/attendance` → attendance;
  - `inventory/production` → production;
  - `inventory/low-stock` → commissary;
  - the rest of `inventory` → stock;
  - `admin` → stores.
- **`apps/erp/src/lib/**` form helpers (`str`, `int` and the like) belong to one named agent: the S4 BUILDER.** No
  module agent edits them.
- **Tests:** about 80 test files call repo writers directly with plain strings. **They belong to one TESTER agent,
  which runs alongside S3 and before S2.** It re-mints fixtures through `money()`/`decimal()`/`quantity()` and does
  not cast. Module BUILDERs never edit a test.

**Each agent:**
- re-mints database values that it re-writes (R4);
- applies R6 to blanks;
- clears its G2 sites under C4, and its G3 forgeries (including `production/index.ts:739` and the ✎R5 `as Quantity`
  list);
- mints the ✎R3 `any`/`unknown` payloads.

**The two direct repo writes** (`fixed-assets` `updateTerms` and `inventory/low-stock` `setThreshold`): the app
parses with `parseDecimalInput`.

**Stop rule:** an agent that needs a file outside its set makes no edit there. It returns
`BLOCKED: <file> — <why>`, and the orchestrator assigns the file.

**Done when:** the module's G2 and G3 cases and its `t371-<module>-nan` test are green, and typecheck is clean.
Each agent's commit is green on its own.

### S2 second (✎R9): Workflow phase 2, the flip (one BUILDER per repo-owning module; writer files only)
- Each agent owns the writer files in its row (✎R1: that includes writers outside `repo/`, assigned to the module
  whose directory holds them).
- It types every writer with `SafeInsert`/`SafeUpdate`, or with a branded interface for raw SQL, and removes the
  casts.
- **Done when:** the module's G1 case is green.
- The orchestrator runs `tsc` over the joined result. **Whatever errors remain are exactly the misses** that S3 did
  not reach, and they go to S4.
- The flip is committed only once `tsc` is clean, so `main` never goes red.

### S4: BUILDER, leftovers (one agent, sequential)
- Owns `apps/erp/src/lib/**` (✎R10).
- Fixes whatever `tsc` or the guard still names after S2, and handles every `BLOCKED` return.
- If the fix set grows beyond the leftovers, S4 reports it rather than absorbing it.

**Workflow mechanics.**
- Everything runs on `main`, in the ✎R12 freeze window.
- Agents never run `npm run build` or the full gates. The orchestrator runs them once after S4, with the tree frozen.
- The auditor reads the joined diff, exactly as it would for a lane.

## Tests: one mutant per leg (the TESTER runs each on a scratch copy and pastes the red)
| Leg | Mutant | Must go red |
|---|---|---|
| G1 | revert `renameMoneyAccount`'s `overdraftLimit` to `string` | G1 `money-accounts`, naming the column |
| G1 | re-add `.values(input as never)` in `insertConfig` | G1 `attendance` |
| G1 | a new raw `insert into …` writer not listed in `RAW_SQL_WRITERS` | G1 fails closed |
| G1 | brand a (14,4) value into a (14,2) column | G1 scale mismatch |
| G1 ✎R1 | a new `tx.update(<constrained>)` in `packages/domain` | G1, found outside `repo/` |
| G1 ✎R2 | interpolate a plain `string` into `remainingQuantity`'s SQL | G1 SQL value |
| G1 ✎R3 | pass a `JSON.parse` field (`any`) to a writer | G1 `any`/`unknown` |
| G2 | add `if (Number(input.amount) < 0)` to `loans` | G2 `loans`, a new site |
| G2 ✎R6 | add `const toNum = (s: string) => Number(s)` and compare `toNum(input.x) > 0` | G2, followed across the function |
| G2 | move an `EXEMPT` entry to another site | G2 set inequality, both directions |
| G3 ✎R5 | add `x as Quantity` in `trade`, and a type alias forgery | G3 (both) |
| G4 | a numeric column without a finite check (scratch schema) | G4 |
| ✎R8 | empty the scan root | every leg fails its floor |
| C1 | make `decimal()` accept `'NaN'` | `t371-decimal` and every `t371-*-nan` test |
| per module | delete one entry parse | that module's NaN test |

The broad positive control is that every existing suite stays green.

## Out of scope
- Merging DEF-383's validators beyond R2's rule that they return through the mint. DEF-408's sentence wording.
- DEF-381 (`NUMBER_CMP`) and T-325's census. Both stay; G2 is a separate population.
- Integer columns, including DEF-395's fourth shape: `int(fd,'maxShiftHours',16)` substitutes a default. The
  orchestrator splits that into its own row.
- DEF-394. DEF-420 belongs to T-367; its `ap/index.ts:398` site should be gone by S0, and S0 reports it if not.
- `.toFixed()` on display paths. Writes are governed by G1.

## Done when
- S0, S1, S3, S2 and S4 are green, and every red leg and mutant was shown red first. G4 is shown red by its mutant
  only.
- G1 to G4 are green, with populations derived at runtime, floors and sentinels present, and every `EXEMPT` entry
  carrying a reason.
- The final G2 figures are reported: sites converted, sites exempted, and a total equal to S0's.
- `main` was green at every T-371 commit.
- Gates:
  - typecheck;
  - the unit suite;
  - the full integration suite on the lane DB;
  - `npm run build` with 9008 free;
  - the auditor's `/code-review`, triaged;
  - `callers.mjs` clean.
- **§9.4 smoke on 9008.** Type `abc` into three boxes and screenshot each sentence: the money-accounts overdraft, an
  attendance multiplier, and the low-stock threshold. Also clear a required box and screenshot its refusal.
- The orchestrator, not a lane, closes DEF-382 and the constrained part of DEF-395 with their commit hashes, and makes
  the roadmap true.

## Questions for Ian
- **Q1: when someone leaves a number box empty, what should be saved?**
  - Today, many boxes quietly save **zero**. v1 did this everywhere, and v2 still does it on some forms.
  - **Example.** A manager edits a money account and clears the overdraft-limit box by accident.
    - "Empty means zero" would save a **₱0 limit**, and every withdrawal from that account would start being refused.
    - The account's normal limit is ₱20,000.
  - **Recommended: let each field's own rule decide, and never guess zero.**
    - A figure that must always exist (a discount's gross amount) is **refused** with a sentence.
    - A figure with a standard value (the ₱20,000 overdraft limit) **keeps the standard, or keeps what was there
      before**.
    - A figure that may be missing is **saved as missing**, not as zero.
  - **Alternative:** keep "empty means zero" everywhere, as v1 did.
  - **The recommendation is the default that ships unless you rule otherwise.**
