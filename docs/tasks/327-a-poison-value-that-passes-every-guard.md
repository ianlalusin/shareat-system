# T-327 — the database refuses a non-finite amount, on every numeric column, so the census that follows is allowed to be wrong

**Status:** ⭐ **APPROVED 2026-09-19 by the orchestrator (`system32-df`)** — drafted by
`system32-4f`, revised after an independent Opus review, then **corrected twice at protocol step 0
by the lanes themselves, before a line of code or a line of test existed:**
• the **BUILDER** (`webapps-4d`) found that **172 was wrong** — it counted 12 view columns that
  cannot carry a CHECK constraint. **The target is 160.** See P2, re-measured against a live database.
• the **AUDITOR** (`webapps-42`) found that **test 3 could pass green while proving nothing**, and
  then that the orchestrator's own fix for that opened a second hole. See Tests 3a and 3b.
⛔ **Both were found by reading the spec cold, by sessions that had not written it.** That is the
argument for briefing all three roles at the START of a cycle rather than the auditor at the end.
**Closes:** nothing on its own. **Halves DEF-382** — T-328 closes it.
**Migration slot:** **`0155`, allocated to the BUILDER lane only.** No other lane adds a migration
this cycle.
**Split from:** the original T-327 draft, on the reviewer's seam (finding 3). T-328 is the other half.

> ⛔ **ANCHORS — GREP THESE, NEVER A LINE NUMBER** (bible row 204).
>
> | Anchor | File |
> |---|---|
> | `export function money(` | `packages/core/src/money.ts` — already correct; **do not touch** |
> | `check('ap_payments_amount_positive_check'` | `packages/db/schema/ap-payments.ts` — the Drizzle `check()` precedent to mirror |
> | `export const CONSTRAINT_MESSAGES` | `apps/erp/src/lib/constraint-messages.ts` — exact-name keyed today |
> | `const deliveryFee = Number(input.deliveryFee` | `packages/domain/src/trade/index.ts` — the measured live poison path |

---

## Why this task exists BEFORE the census, not after

**Every census in this repo has been wrong.** T-326's was wrong twice in one task (35 → 56 files,
then a third spelling inside that). The handoff's own figure for this work ("14 sites") did not
survive contact. **This task is the layer that makes the next miss non-fatal**, and it needs no
census at all: it guards *every* numeric column without asking which ones are money.

Bible §15.11 — *no layer may be the only one for a given risk*. T-328 is the other layer.

---

## What is measured — all of it EXECUTED by the orchestrator, 2026-09-19

⛔ **Commands quoted so a lane re-runs rather than trusts** (bible row 208).

### P1 — `NaN` is stored by a real money column, past a real `> 0` CHECK. **EXECUTED.**

⚠️ **The first version of this probe tested a BARE `numeric`, which is not the shape any real column
has. Re-run against `numeric(14,2)` with the CHECK, it still holds:**

```sql
BEGIN; CREATE TEMP TABLE t (a numeric(14,2) CHECK (a > 0));
INSERT INTO t VALUES ('NaN');  -- SUCCEEDS
SELECT a::text FROM t;         -- NaN
ROLLBACK;
```

| Fact | Result |
|---|---|
| `'NaN'` into `numeric(14,2)` with `CHECK (a > 0)` | **stored** |
| `'NaN'::numeric > 0` / `> 999999999` | `true` / `true` |
| `'NaN'::numeric = 'NaN'::numeric` | **`true`** — so `CHECK (col = col)` does **NOT** reject it |
| `NaN + 100` · `NaN * 0` | `NaN` · **`NaN`** |

⭐ **The last row is the severity.** One poisoned row turns every `sum()` over that column into
`NaN` permanently. Multiplying by zero does not clear it.

### P2 — the shape of the schema, exactly. **EXECUTED.**

⚠⚠ **CORRECTED 2026-09-19 by the orchestrator (`system32-df`) after the BUILDER lane reported the
defect at protocol step 0, before writing a line. The number in the first version of this spec was
172 and it was WRONG — it counted VIEW columns as though they were table columns.**

| Measure | Value |
|---|---|
| `numeric` columns in `public` on **base tables** (`relkind='r'`) — ⭐ **THE TARGET** | **160**, across **65** tables |
| `numeric` columns in `public` on **views** (`relkind='v'`) — ⛔ **NOT TARGETABLE** | **12** |
| total, which is where the old **172** came from | 160 + 12 |
| of the 160, **bare** (no precision) | **0** — all 160 carry a precision |
| columns currently holding a `NaN` | **0** |

**The measurement, re-run rather than trusted** (bible row 208):

```sql
select cl.relkind, count(*) from pg_attribute a
  join pg_class cl on cl.oid = a.attrelid
  join pg_namespace n on n.oid = cl.relnamespace
 where n.nspname = 'public' and a.atttypid = 'numeric'::regtype
   and a.attnum > 0 and not a.attisdropped
 group by 1;                       -- r: 160   v: 12
```

⛔⛔ **WHY THE OLD RECONCILIATION LOOKED RIGHT AND WAS NOT — THERE ARE TWO DIFFERENT SETS OF TWELVE,
AND THE SPEC MATCHED THE WRONG ONE.** The first version said: *172 column declarations, and the other
12 are `::numeric(14,2)` casts inside view SQL*. Both halves of that sentence are true statements
about the tree and the conclusion drawn from them is false, because the 12 it names are not the 12
that make up the difference. Measured, three distinct populations:

| Population | Count | How to see it |
|---|---|---|
| real `pgTable` numeric columns | **160** | `ls packages/db/schema/*.ts \| grep -v views.ts \| xargs grep -c "numeric('"` |
| `pgView` column DESCRIPTORS in `views.ts` | **12** | `grep -c "numeric('" packages/db/schema/views.ts` (and `grep -c "pgTable(" views.ts` → **0**) |
| raw `::numeric(14,2)` CASTS inside view SQL bodies | **12** | `grep -c "::numeric(" packages/db/schema/views.ts` — a bare `numeric(` grep only |

⭐ **The two twelves are a coincidence, and it is the coincidence that hid the error.** `grep -c
"numeric('" packages/db/schema/*.ts` → 172 is a real number; it is 160 table columns **plus** the 12
view descriptors. The cast population is a third set that the grep never matched at all.
⛔ **This is the fourth time in three days a census in this repo was bound by a SPELLING rather than a
SHAPE, and the third time the resulting number was wrong.** The lesson stands unchanged and the
remedy is the same one T-327 exists to provide: the count is not what makes this task safe.

⛔ **POSTGRES CANNOT PUT A CHECK CONSTRAINT ON A VIEW.** `ALTER TABLE v_trial_balance ADD CONSTRAINT
…` is not a thing; the four views are `v_account_balance`, `v_trial_balance`, `v_income_statement`
and `v_balance_sheet`, all `pgView`. Had the migration been written against 172, it would have failed
on the 13th statement — or, worse, the schema-coverage test would have demanded a constraint on a
relation that can never carry one and stayed red whatever the builder shipped.
⭐ **And the 12 view columns need no guard, which is a structural argument rather than a hopeful one:**
each is a `sum()`/`CASE` over base-table columns that the 160 constraints now guarantee finite, cast
`::numeric(14,2)`, and P3 establishes that such a cast REFUSES a non-finite value rather than
admitting one. A sum of finite values is finite. **A view is a projection, not a storage location —
there is no write path to it that the 160 do not already stand in front of.**

### P3 — ⛔ `Infinity` is NOT reachable in this schema, and the reviewer's finding 1 is dismissed on this evidence. **EXECUTED.**

The reviewer's most severe finding was that `Infinity` rides the same path and escapes a NaN-only
guard. **The Postgres fact is correct; it does not reach this schema:**

```
INSERT 'Infinity' INTO numeric(14,2) → ERROR: numeric field overflow
  DETAIL: A field with precision 14, scale 2 cannot hold an infinite value.
INSERT 'Infinity' INTO numeric (bare) → stored
```

**Every one of the 160 target columns carries a precision (P2), so every one already refuses `Infinity`.**
⭐ **The remedy is adopted anyway and the rationale is replaced:** the finite-range form below costs
nothing over a NaN-only form, covers both values in one expression, and is correct on the day
somebody adds the first bare `numeric` column. **The schema test (§3) is what actually catches that
day** — not this constraint, which would not yet exist on the new column.

### P4 — `money()` already rejects all of it. **READ.**

`packages/core/src/money.ts`: the string branch tests `/^-?\d+(\.\d{1,2})?$/` (rejects `"NaN"`); the
number branch throws on `!Number.isFinite(value)` (rejects `NaN` and `±Infinity`).
⭐ **So the defect is never "validation is missing" — it is "paths that do not reach it."** T-328.

### P5 — the live path, and it defeats its own cross-check. **READ.**

`packages/domain/src/trade/index.ts` — **three** columns, not two:

```ts
total += Number(lineTotal);                       // NaN propagates
const deliveryFee = Number(input.deliveryFee ?? 0);
if (deliveryFee < 0 || otherFees < 0) { ... }     // NaN < 0 is false → accepted
const totalAmount = total.toFixed(2);             // "NaN"
if (input.totalAmount != null &&
    Math.abs(Number(input.totalAmount) - total) > EPSILON) { ... }   // Math.abs(NaN) > EPSILON is FALSE
```

⛔ **The reconciliation guard on the last line — the one whose whole job is catching a total that
disagrees with its lines — passes a `NaN` silently.** `deliveryFee`, `otherFees` and `totalAmount`
all reach `numeric` columns, and `trade_orders_total_positive_check` is a `> 0` that P1 proves `NaN`
passes.

---

## Scope — disjoint by role

**BUILDER — source and the migration, never a `.test.ts`:**
- **Migration `0155`**, hand-authored per **ADR-012 §5** (`npm run db:generate` is retired and fails
  closed). `when` must track `idx` in `migrations/meta/_journal.json`.
- **`packages/db/schema/*.ts`** — the matching Drizzle `check()` entries. ⛔ **A constraint that
  exists only in the migration leaves the ORM's picture wrong**; mirror `ap-payments.ts`'s
  `check('<name>', sql\`…\`)` form. *(Reviewer finding 4, accepted.)*
- **`apps/erp/src/lib/constraint-messages.ts`** — see §2. ⛔ **Not 160 map entries.**

**TESTER — tests only:** the three tests in §Tests. ⛔ **May not edit a source file.**

**AUDITOR — read-only:** `/code-review` on the slice. Never `--fix`.

**⛔ Nobody touches** `packages/core/src/money.ts`, `parseMoneyInput`, or any call site — **call
sites are T-328** and this task must not pre-empt the census.
⭐ **Permitted, against the original draft's blanket ban:** an **additive sibling** to
`packages/domain/src/shared/money-positivity-*` / `scripts/money-positivity-census.ts` if the schema
test is better hosted there. ⛔ **Additive only** — T-325 shipped that census three commits ago and
its existing behaviour is frozen. *(Reviewer finding 9, accepted.)*

---

## Contract

### 1. Every `numeric` column refuses a non-finite value

Migration `0155` adds, to **all 160 base-table columns** (⛔ **not** the 12 view columns — P2):

```sql
ALTER TABLE <t> ADD CONSTRAINT <t>_<col>_finite_check
  CHECK (<col> > '-Infinity'::numeric AND <col> < 'Infinity'::numeric);
```

**Verified behaviour of that expression** (executed): `NaN` → **rejected**; `0` → accepted;
`-5.25` → accepted; `99999999999.99` → accepted; `NULL` → accepted (a CHECK passes on `NULL`).

⛔ **Not `CHECK (col <> 'NaN')`** — correct, but silent on a future bare column.
⛔ **Not `CHECK (col = col)`** — P1 row 3 proves it accepts `NaN`.

⭐ **All 160, not a money subset.** *(Reviewer finding 2, accepted.)* No column in this schema has a
legitimate non-finite value; guarding every one deletes the money/not-money judgement call, deletes
the out-column argument, and removes the only thing about this task a census could get wrong.
⚠️ **If any column legitimately needs `NaN`, that is a BLOCKED finding — report it, do not skip it.**

### 2. The cashier reads a sentence, not a constraint violation

⛔ **T-326 shipped the sanitiser that makes a constraint violation readable, and `CONSTRAINT_MESSAGES`
is keyed by EXACT constraint name.** Left alone, this task hands cashiers
`new row violates check constraint "trade_orders_total_amount_finite_check"`.

**Required: ONE rule, not 160 entries** — every constraint here ends `_finite_check`, so a single
suffix rule resolves all of them to one sentence. Wording is the lane's to draft; it must name what
the person should do, in the register's house style (*"That is not a valid amount. Enter a figure
like 1234.50."*).
⚠️ **If the sanitiser supports only exact keys today, adding suffix support is IN SCOPE** — it is
the difference between one rule and 160 copies that will drift.

---

## Invariants

1. **Every existing money test stays green, untouched.** `0` remains legitimate (bible §12
   landmine 8); negatives remain legitimate where a column allows them.
2. **`NULL` is unaffected** in nullable columns.
3. **No new money validator enters the tree** (DEF-383 — the tree already holds three).
4. **No value that fails `money()` can be stored in any numeric column**, through any path,
   enumerated or not. ⭐ **This is the whole point of the task.**

## Tests

⛔ **Of each: what value would have to be wrong for this to go red, and does the code under test
supply it?** *(Three of the original draft's five failed that question; the reviewer caught them.)*

1. **The constraint refuses a raw `NaN`.** Insert `'NaN'` directly into a guarded column; expect
   rejection. ⭐ **Red before `0155`, green after** — the migration is the only thing that can change
   it.
2. **⛔ SCHEMA COVERAGE, NOT VALUE SCANNING — the anti-rot test.** Query `pg_constraint` /
   `information_schema` and assert **every** `numeric` column in `public` **ON A BASE TABLE**
   carries a `_finite_check`. ⛔⛔ **THE QUERY MUST FILTER TO `relkind = 'r'` — CORRECTED 2026-09-19,
   see P2.** `information_schema.columns` includes VIEW columns, and there are 12 of them here that
   **can never carry a CHECK constraint, because Postgres cannot put one on a view.** An unfiltered
   query enumerates them, demands a constraint on each, and stays **red no matter what the builder
   ships** — a test that cannot go green is as useless as one that cannot go red, and this one would
   have looked like a builder failure for as long as anyone believed the 172.
   ⛔ **The column list is derived at runtime; no count appears in the test name or
   as a literal** (handoff §3(d)). ⭐ **That rule is what makes this correction cheap:** a test that
   had hard-coded 172 would now be wrong in a second place, and the number moved on the day the spec
   was first read by someone who had to build against it. ⭐ **This is what fails when migration `0156` adds an unguarded
   column** — the original draft's value-scan could not, because a freshly migrated database is
   empty and scanning nothing passes. *(Reviewer findings 5 and 6, accepted — `money-positivity-census.ts`
   warns about this exact trap in its own header.)*
3. **The operator sentence.** Drive the real path with `deliveryFee: 'abc'` and assert the message
   the cashier sees is §2's sentence. ⛔ **Asserting "it was refused" is not enough** — refusal comes
   free from `0155` and would leave §2 unproven. *(Reviewer finding 6, accepted.)*
   ⚠ **STRENGTHENED 2026-09-19 by the orchestrator, on the AUDITOR lane's reading of this spec cold,
   before any code existed. Two additions, and the second closes a hole the first one opened:**
   **(3a) TWO DIFFERENT CONSTRAINT NAMES, ON DIFFERENT TABLES, both asserting the sentence.** As
   written, test 3 drives ONE path and therefore trips ONE constraint name — so a single **exact-name**
   entry in `CONSTRAINT_MESSAGES` passes it green, sentence and all, while §2's actual requirement
   (ONE SUFFIX RULE covering all 160) is never implemented and never tested, and the other 159
   constraints still hand a cashier a raw violation. ⛔ **A green test 3 over an exact-name entry is
   WORSE than a missing test 3: it reports §2 proven when §2 is not implemented.** The constraint
   NAME may be derived at runtime from the schema — preferred.
   **(3b) ⛔ THE EXPECTED SENTENCE IS A HAND-WRITTEN LITERAL IN THE TEST BODY. It may NEVER come from
   the code under test** — not by importing `CONSTRAINT_MESSAGES`, not by calling the sanitiser, not
   through any helper that consults that map. If the expectation is built from the same map that
   produces the actual value, **the code under test supplies both sides of the comparison and test 3
   cannot fail**: it would pass on the suffix rule, on exact entries, on a fallback string, and on a
   completely empty map. ⭐ **The literal is validated by CHANGING IT AND WATCHING IT GO RED, once,
   actually executed** — not by agreeing with the map.
   ⛔ **Also forbidden, because it is where this drifts to:** asserting merely that the message does
   **not** contain `check constraint`. That passes on an empty string and on any fallback.

⛔ **Deliberately NOT a test:** "a `NaN` makes `sum()` return `NaN`". After `0155` no `NaN` can exist
in a real column, so it could only be written against a TEMP table — asserting a property of
Postgres that no change to this repo could break. **It stays a measured fact in P1 and nothing more.**

## Out of scope

- ⛔ **Every call site.** That is T-328 and it must not start here.
- ⛔ DEF-383, DEF-374, DEF-380, DEF-373, T-320.
- ⛔ Data repair — P2 measured zero poisoned rows.
- ⛔ A `CREATE DOMAIN`. The reviewer and I agree: Drizzle 0.38 has no domain type, ~119
  `numeric(14,2)` columns would need `customType`, and `ALTER COLUMN TYPE` rewrites every table.
  **Per-column CHECK plus test 2 as the anti-rot mechanism; a domain is its own task if ever.**

## Done when

Every §9 gate: typecheck · unit · integration on the lane DB · `npm run build` with 9008 free ·
the auditor's `/code-review` returned and triaged · `callers.mjs` clean · committed with a message
saying *why* · **the roadmap and DEF-382's row made true by the orchestrator, not a lane** —
DEF-382 is **halved, not closed**, until T-328 lands.

⛔ **§9.4 — the machine, not the code.** Verified by the orchestrator this session: dev server
starts, `/api/health` 200, **every page route 500s** —
`PostCssTransformedAsset::process → creating new process → 0xc0000142`. A `--webpack` run was tried
once and is worse (`instrumentation.ts` fails to resolve; even `/api/health` 500s). **If the screen
cannot be reached, §9.4 is reported UNMET in those words** to Ian under bible row 203 — never
skipped quietly, never called done.
⭐ **Execute the path instead when the screen is unreachable** — test 3 is that, and it closes the
invariant a screen test would have covered.

⛔ **For the orchestrator, not a lane:** production has **not** been scanned for an existing `NaN`.
Expected zero — nobody uses it yet — but expected is not measured, and it is one query.
