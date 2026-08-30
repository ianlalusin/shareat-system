# T-176 — Production: slab → slice, recipe → batch, and the payroll lock

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> **Depends on:** T-161, T-162, T-164, T-168. ⚠️ **Phase 5 for slicer pay** — this task builds the
> lock, not the payroll (§7).
> ⭐ **v1 RE-READ AT SOURCE 2026-08-29, at Ian's instruction** — the first draft cited
> `docs/discovery/14` §M rather than the code. §10 records what the source added that the
> discovery summary did not, including a live v1 defect now logged as **DEF-093**.
> **v1 read at source** — `production.actions.ts` (1,100 lines), `production-validate.ts` (247),
> `production-recipe.actions.ts`, `meat-convert.ts`, `recipe-units.ts`, `slicer-payment.ts`.
> `docs/discovery/14` §M.

## 1. Goal

A slicing run or a prep batch posts as **one** stock transaction — inputs out, outputs in, cost
carried across — so that a kilo of slab becoming three sliced products is a conversion the books
can see, not a disappearance followed by an appearance.

## 2. ⚠️ Two systems share the word "recipe" and they are unrelated

| | |
|---|---|
| **Production recipe** | A repeatable prep conversion — ingredient lines with unit conversion, scaled to a target quantity, that posts **both** the ingredient consumption and the output stock-in in one action. **This task.** |
| **Cookbook** | Photo/video recipe content for staff training and presentation. Cross-store master with per-branch variants. **Phase 7**, named explicitly in the phase plan |

`docs/discovery/14` §M: *"do not conflate with the cookbook capability below; these are two entirely
separate systems with the same underlying 'recipe' word."*

## 3. The posting — cost moves, it is not created

A conversion is **not** a purchase and **not** a sale. Total value in equals total value out:

| Account | Dr | Cr |
|---|---:|---:|
| `1330` Inventory — prepped / commissary goods | 31,000.00 | |
| `1310` Inventory — raw materials | | 30,000.00 |
| `6xxx` processing labour *(only if a labour cost is attached)* | | 1,000.00 |

⭐ **The output's FIFO layer unit cost is `total input cost ÷ output quantity`** — which is exactly
the ₱310/kg in T-133's worked case, and the mechanism by which processing work reaches the branch
that receives the goods. ⚠️ **This is where the transfer price stops being typed by Ian and starts
being computed**, which T-133 §4 named as Phase 3's job: *"when valuation lands, the transfer value
should come from cost, not from a price list."*

### The yield gap

⭐ **`reseco` / thaw loss is real and is not an error.** 100 kg of slab yields 97 kg of cuts. v1
records the difference as a **memo-only** leg. In v2 it is a cost that must land somewhere:
**`Dr 5300` Wastage and spoilage** for the value of the gap, which is what it is — a yield loss.
⛔ **It does not silently inflate the output's unit cost**, because that would hide a worsening
yield inside a rising cost per kilo, and yield is the number a butchery operation manages.

## 4. What v1 gets right

| Capability | Keep |
|---|---|
| Draft → post → void as **one** ledger transaction: slab OUT, N products IN | ✅ |
| ⭐ **Hard vs soft validation tiers** | ✅ **HARD blocks** (non-positive qty, missing product, mixed units, outputs exceeding input) — *"things that corrupt stock."* **SOFT warns and is stamped on the record** (trimmings pooled across cuts, a mis-categorised primal) — *"real business practice here,"* verified against live data with zero blocking violations. ⭐ **The two-tier design itself is the pattern to keep** |
| ⭐ **Unit conversion refuses to guess** | ✅ g↔kg and ml↔ltr **only**. Every other pairing returns null and the caller **must** block: *"guessing one here would deduct the wrong quantity forever"* |
| ⛔ Two copies of that conversion table | **One.** `production-recipe.actions.ts` duplicates `recipe-units.ts` with the same table, and v1's own comment flags one as dead code walking |
| **Edit a POSTED record in place** | ✅ Reverse the old legs, apply the new ones, atomically, with a revision counter so history stays readable. ⚠️ **Convert records are excluded** — void and re-create instead |
| ⭐ **Void tolerant of a missing ledger leg** | ✅ *"Proceed and report, never invent or get stuck"* — the reversal is computed from the **record's** own fields, which are always correct, and the gap is surfaced rather than fabricated |
| ⭐ **Slab→slice "convert" within one lineage** | ✅ A pure count move, same parent slab only, **zero GL impact** — the re-cut constraint is the whole point; do not relax it |
| ⭐ **Meat re-categorisation BLOCKED while sliced children point at the slab** | ✅ Lipa's `Beef Forequarter/regular`: 3 orphaned children, 7 corrupted records. **Block, never warn** |
| **Slab-unit-must-match-child-unit** | ✅ A gram child under a kilo slab makes in-equals-out meaningless |
| ⭐ **A live slicer payment freezes the records it covers** | ✅ §7 |

## 5. Scope

**Create:** `packages/db/schema/production.ts` ·
`packages/db/migrations/<next>_t176_production.sql` ·
`packages/domain/src/production/index.ts` · `packages/domain/src/production/validate.ts` (pure) ·
`packages/domain/src/production/unit-conversion.ts` (pure — **the single copy**) ·
`packages/db/src/repo/production.ts` ·
`apps/erp/src/app/inventory/production/page.tsx` + `[id]/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/production.test.ts` ·
`packages/domain/tests/unit/production-validate.test.ts`

**Modify:** `packages/db/schema/items.ts` (`parent_slab_item_id`) · barrels · `classification.ts` ·
`rls/registry.ts` · `docs/POSTING-PATTERNS.md` · `tests/worked-examples/fixtures.ts` ·
`CAPABILITY-MATRIX.md` · `_journal.json` · `docs/ROADMAP.html`

## 6. Contract

```
items  -- new column
  parent_slab_item_id uuid NULL -> items    -- a sliced product's source slab
  check (parent_slab_item_id is null or kind = 'meat_sliced')

production_recipes / production_recipe_lines
  recipe: id, org_id, name, output_item_id, output_quantity, status
  line:   recipe_id, item_id, quantity, unit          -- unit converted at cook time

production_records
  id, org_id, store_id, location_id
  kind       'slice' | 'cook' | 'convert' NOT NULL
  recipe_id  uuid NULL -> production_recipes
  status     'draft' | 'posted' | 'void' NOT NULL default 'draft'
  revision   integer NOT NULL default 1        -- edit-in-place counter
  produced_on date NOT NULL
  soft_warnings jsonb NOT NULL default '[]'
  labour_cost numeric(14,2) NOT NULL default 0
  journal_entry_id uuid NULL
  posted_at, posted_by, voided_at, voided_by, void_reason
production_record_lines
  id, record_id (cascade), direction 'in' | 'out' NOT NULL
  item_id, quantity, unit, movement_id
```

## 7. ⭐ The slicer-payment lock, and where it lives

> *"Editing or voiding this record now would leave its labour cost expensed against output that no
> longer exists."*

v1 blocks a post, edit or void of a production record that a **live** (non-voided) slicer payment
was computed from — because the payment's total is **frozen** at generate time while the records
stay editable.

`docs/discovery/14` §M calls this out precisely: *"this is the payroll-inventory coupling point;
ERPv2 must decide where this lock lives structurally, not bolt it on later."*

⭐ **The decision, made here: the lock lives on the PRODUCTION record, as a derived query, and
Phase 5 does not need to know it exists.** A production record is editable when **no live payment
covers its date for its slicer** — a query over Phase 5's payment table, checked inside the editing
transaction. ⛔ **Not a `is_locked` column on the record** (DEF-075) and ⛔ **not a call Phase 5
makes into inventory** (which would put the rule in the module that does not own the record).

⚠️ **Until Phase 5 exists the query returns "no live payment" and every record is editable.** The
predicate is written now, with its Phase 5 table stubbed, so the coupling point is designed rather
than discovered — which is exactly what the discovery note asked for.

## 8. Invariants

1. **A production record posts as ONE journal entry and one set of movements** — all inputs out and
   all outputs in, or none.
2. **Total output value = total input value + labour − yield-loss value.** The identity is checked
   at post; a mismatch is a HARD block.
3. ⭐ **HARD blocks:** non-positive quantity · unknown item · mixed units that cannot be converted ·
   **output quantity exceeding input quantity**. **SOFT warnings** are stamped on the record and
   allowed through, never promoted to blocks without a decision.
4. ⭐ **Unit conversion covers g↔kg and ml↔ltr only.** Everything else returns null and the caller
   **blocks**. ⛔ **One implementation** — a second copy is a defect (§4).
5. **A `convert` (re-cut) is constrained to the same `parent_slab_item_id`**, posts **no journal
   entry**, and is a pure count move.
6. ⭐ **An item's `kind` may not change from `meat_slab` while any item names it as
   `parent_slab_item_id`.** A database-level refusal, not a warning.
7. **A sliced child's `base_unit` must equal its parent slab's.**
8. **Editing a posted record reverses the old legs and applies the new ones in one transaction**,
   increments `revision`, and leaves the old legs visible and marked reversed. ⛔ **`convert`
   records are excluded** — void and re-create.
9. ⭐ **Void proceeds when an expected ledger leg is missing**, reconstructing the reversal from the
   record's own fields and **reporting the gap** — never fabricating a leg, never leaving the record
   permanently stuck.
10. **Post, edit and void are refused while a live slicer payment covers the record** (§7).
11. **Balance reads are inside the transaction** — the −20 kg drift (T-161 §3).
12. **Period lock applies to post, edit and void.**
13. **A frozen location refuses a post** (T-169).
14. ⭐ **At least one output.** A run with no outputs writes the whole input off as loss, which is
    a wastage record, not a production run (§10.3).
15. ⭐ **The input product may not also be an output.** A run cannot consume and produce the same
    product (§10.3).
16. **An unresolvable product id is a HARD reject** — source or output. *Cutting from a slab that
    does not exist* (§10.3).
17. ⚠️ **`PRODUCTION_QTY_EPS` = 0.01 base units, and it is a SCALE tolerance, not a float
    defence.** It survives where T-161's `1e-6` did not, and the spec says which kind it is so the
    next reader does not delete it by analogy (§10.2).
18. ⭐ **The yield gap produces NO second stock movement.** The OUT movement is the whole input;
    the gap is a cost (`5300`), never a second quantity leg (§10.1).
19. **The yield gap is clamped at zero** — within tolerance the outputs can round a hair above the
    input, and a negative loss would post a stock-IN leg (§10.1).

## 9. Tests

1. 100 kg slab at ₱300 in, 97 kg of three sliced products out, ₱1,000 labour: one entry,
   `Dr 1330 30,903 / Dr 5300 97 / Cr 1310 30,000 / Cr 6xxx 1,000`, outputs layered at ₱318.59/kg,
   and the value identity holds to the centavo.
2. Output exceeding input is a HARD block.
3. A pooled-trimmings case raises a SOFT warning, **posts**, and the warning is on the record.
4. A pcs↔pack conversion is refused with a readable error; g↔kg converts.
5. ⭐ **One conversion implementation** — asserted by a test that imports the module and greps the
   package for a second table, in the spirit of the existing mirror tests.
6. A `convert` between two children of one slab posts **no journal entry**; between children of
   different slabs it is refused.
7. Changing a slab's `kind` while a child points at it is refused **by the database**.
8. A sliced child with a different base unit from its slab is refused.
9. Editing a posted record reverses and re-applies, `revision` becomes 2, the old legs remain
   visible, and the trial balance ties throughout. Editing a `convert` is refused.
10. ⭐ Void with a deliberately deleted ledger leg **still reverses the stock correctly** from the
    record's fields and reports the gap.
11. ⭐ Concurrency: two posts against the same slab. One commits, one is refused. *This is the
    −20 kg drift.*
12. With a stubbed live slicer payment covering the date, post/edit/void are all refused; with it
    voided, all three succeed.
13. Post into a closed period, and into a frozen location: both refused.
14. Live route on 9008: cook a recipe and slice a slab, and read the resulting layers.
15. ⭐ A run with **zero outputs** is refused, and the error says to record a wastage instead.
16. ⭐ An output naming the **same product as the input** is refused.
17. An output whose product id does not resolve is refused; so is a source that does not.
18. ⭐ **The scale tolerance holds both ways:** cutting 10.005 from 10.000 on hand is ALLOWED;
    cutting 10.02 is refused. And outputs totalling 0.005 above the input are allowed, with the
    yield gap clamped to zero rather than going negative.
19. ⭐ **A lineage mismatch WARNS and posts** — trimmings pooling across primals is real practice,
    verified in v1 against live data with zero blocking violations. A test that made this an error
    would be a test of the wrong rule.

## 10. ⭐ Read at source 2026-08-29 — what the discovery summary did not carry

`docs/discovery/14` §M is accurate but summarised. Reading `production-validate.ts`,
`meat-convert.ts` and `recipe-units.ts` line by line produced **six rules this spec did not have**
and one defect in v1.

### 10.1 The identity, and where the loss actually goes

```
sourceQuantity  =  Σ outputs[].totalWeight  +  variance
```

⭐ **`variance` (reseco / thaw loss) is booked as a LEDGER-ONLY memo leg**, and v1 states exactly
why: *"the balance already lost the full `sourceQuantity` via the OUT leg, so the memo must never
touch a balance again."* ⚠️ In v2 that leg is a **cost** — `Dr 5300` for the value of the gap (§3) —
but the quantity half of the rule stands: **the OUT movement is the whole input, and the yield gap
must not produce a second stock movement.**

⭐ **`variance` is clamped at zero**, and the reason is a real edge: *"within EPS the outputs can
round a hair above the input, and a negative 'loss' would post a stock-IN memo leg."*

### 10.2 ⚠️ `PRODUCTION_QTY_EPS = 0.01` kg — and it is NOT the tolerance T-161 deleted

Used in exactly two places: stock sufficiency (`sourceQty > available + EPS`) and
output-exceeds-input (`total > sourceQty + EPS`).

⛔ **Do not delete this one.** T-161 §8 removed v1's `1e-6` quantity tolerance because it was a
FLOAT defence and cannot fire at `numeric(14,3)`. **This is a different animal: a 10-gram SCALE
tolerance.** Two weighings of the same meat legitimately differ by grams, and refusing a cut
because the scale read 10.005 against 10.000 would stop the kitchen for physics.

⭐ **Carry it as a named constant with its reason** (§16.6), and state which kind of tolerance it
is — the distinction between "float noise" and "measurement noise" is exactly what makes one
deletable and the other not.

### 10.3 Four HARD rules the first draft missed

| Rule | v1's own reason |
|---|---|
| **At least one output** | *"A run with no outputs would write off the whole slab as loss"* |
| **Input ≠ output product** | *"A run cannot consume and produce the same product"* |
| **Unresolvable product id** | *"Cutting from a slab that does not exist"* — for the source AND any output |
| **Non-numeric quantity** | Distinct from non-positive, and rejected separately |

### 10.4 And three SOFT ones — warn, stamp, never block

An **inactive** source or output product · a source whose category is not `slab` (or not `sliced`
for a convert) · an output with **no source slab set**, or one whose slab differs from the input's.

⭐ **The last is the important one and it is deliberately soft**: *"trimmings legitimately pool
across cuts."* Trimmings from several beef primals land in ONE "Beef Trimmings" product, so a
lineage mismatch is normal business, verified against live data on 2026-08-05 with zero blocking
violations. **Blocking it would stop the kitchen; naming it lets the operator confirm and lets us
report on it.**

### 10.5 `validateConvertLineage` in full — five checks, not one

Both ids present · **not the same product** · source has a slab · target has a slab · **the two
slabs are the same**. ⚠️ The two "has a slab" checks are separate from the "same slab" check
because a null slab on either side would otherwise compare equal to a null on the other and pass.

### 10.6 ⛔ DEF-093 — v1's cook path never converts units at all

`recipe-units.ts` exists to stop a 1000× error and says so: *"if a recipe says '500 g' and the item
is tracked in kg, an unconverted post deducts 500 KILOS… silently passing the number through is the
one outcome that must be impossible."*

⛔ **Its own caller does exactly that.** `production-recipe.actions.ts` calls its private copy as
`resolveUnitConversion(line.unit, line.unit)` — **an identity call**, which can never convert and
never fails. `recipe-units.ts:11-16` names the shape, says *"do not replicate that call shape"*,
and flags repointing production at it as a follow-up that was never done.

⭐ **This spec already closes it structurally** (§4, §8 invariant 4): ONE conversion module, a test
asserting no second copy exists, and a hard block rather than a pass-through when a pairing is not
convertible. **Logged as DEF-093 anyway** — v1 is live, and the register is where a finding
survives (§13 row 164).

⚠️ Also note what `recipe-units.ts` refuses and why: `pcs↔pack`, `pcs↔box`, `kg↔ltr` all return
null, *"those need a per-item factor (unitsPerPack, density) that lives on the product, not a
global table — guessing one here would deduct the wrong quantity forever."* And a **blank unit on
either side is not an implicit match** — *"treating blank as 'same' would let a unitless recipe
line deduct against any item at all."*

## 11. Out of scope

⛔ **Slicer per-piece payroll itself** — generation, gross-drift refusal, overlap/duplicate guards.
**Phase 5**, and `CAPABILITY-GAPS.md` already assigns it there. ⚠️ Its guards are real and must not
be an afterthought bolted onto hourly payroll; this task builds only the lock's inventory half.
⛔ **The cookbook.** Phase 7. §2.
⛔ **Multi-level BOM / nested recipes.** v1 has one level. Deliberately skipped.
⛔ **Yield-variance analytics.** The data is captured; reporting is Phase 6.

## 12. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts`: recipes **KEEP** (configuration), records **PURGE** (operational).
      `rls/registry.ts` NULLIF-guarded.
- [ ] `docs/POSTING-PATTERNS.md` gains `production.conversion`, pinned by `fixtures.ts`.
      ⚠️ `npm run toc`.
- [ ] ⭐ §7's decision recorded in the task report's `FOR IAN` block — *the payroll-inventory
    coupling point now has a stated home; Phase 5 inherits a predicate, not a design problem.*
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `CAPABILITY-MATRIX.md`: `post_production`, `edit_posted_production`, `void_production` — each
      with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.
