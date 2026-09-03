# T-168 — Usage, wastage, adjustment: the busiest door in the domain

> **Status:** ✅ **BUILT, SCREENED AND SMOKETESTED 2026-09-03 — DEF-135 closed for this task.**
> `stock_usage_records` + `stock_usage_lines`, migration `0067`, `consume.ts`, `usage.ts` (engine,
> 20 integration tests) — and now `usage-records.ts` (the authorize-and-orchestrate document
> layer), `repo/stock-usage.ts`, and the `/inventory/usage` + `/inventory/usage/[id]` screens.
> ⭐ **The loop closes here** — received, layered, consumed, costed — **and now it has a door**.
> §12. §7's two questions were built as recommended (unchanged since 08-29).
> **Depends on:** T-160, T-161, T-162, T-164 (which owns the postings this task triggers).
> **v1 read at source** — `general-inventory.actions.ts` (the single busiest file, 8 transaction
> sites), `meat-usage.actions.ts`, `reserved-usage-categories.ts`. `docs/discovery/14` §B, §I.

## 1. Goal

Anyone on the floor can record what was consumed or spoiled, a manager posts it, and the stock and
the books move together — with the one mislabel that silently destroys stock made impossible.

## 2. ⭐ v1 keeps two of these and v2 keeps one

v1 has **two parallel implementations**: `general-inventory.actions.ts` for items and
`meat-usage.actions.ts` for meat products, each with its own draft/post/void lifecycle, its own
race guard, and its own copy of the same rules. The split exists because `meatProducts` and
`inventoryProducts` were separate collections — a duality **v1 itself was already retiring**
(`types/item.ts:3`, *"Single source of truth for all item types… Replaces the split"*).

⭐ **T-145 already finished that migration: one `items` table, `kind` including `meat_slab` and
`meat_sliced`. So there is one usage path here, not two** — and the meat-specific rules become
rules about a `kind`, not a second module.

⚠️ **One consequence, and it is a fix rather than a port:** v1 blocks POS mapping for meat because
`meatUsageRecords` carries no `locationId`. In v2 every movement carries one (T-161), so **the
exclusion is not inherited** (T-177, phase plan §6.3).

## 3. What v1 gets right

| Capability | Keep |
|---|---|
| **Draft → post → void.** Posting is the only step that moves stock | ✅ A floor worker records; a manager (or a PIN'd local user) posts |
| ⭐ **A usage record labelled `transfer` is REJECTED outright** | ✅ **The usage flow writes only an OUT leg — a mislabelled transfer destroys stock instead of moving it.** Shared client+server guard; the server one is the control |
| ⭐ **Usage may only draw from an `operating` location** | ✅ A storage room cannot be a usage source (T-160 invariant 3) |
| **Equipment exemption from the threshold gate** | ✅ Kitchenware is not a consumable: no threshold required, no replenishment fired |
| **Manual adjustment (+/−) with a typed reason** | ✅ For when neither a delivery nor a usage explains a discrepancy. `can_adjust_inventory` |
| **Opening / initial inventory set, edit, reset** | ⚠️ **Narrowed** — see §7 |
| **Wastage charged to a staff member, atomically** | ✅ Same transaction as the stock movement. No orphan charge, no orphan wastage |
| ⭐ **Balance read inside the transaction** | ✅ T-161 §3 — the two named drift bugs |
| ⛔ Hard low-stock-threshold requirement before posting | **Ask Ian.** §7 |

## 4. Scope

**Create:** `packages/db/schema/stock-usage.ts` ·
`packages/db/migrations/<next>_t168_stock_usage.sql` ·
`packages/domain/src/stock/usage.ts` · `packages/domain/src/stock/reserved-categories.ts` ·
`packages/db/src/repo/stock-usage.ts` ·
`apps/erp/src/app/inventory/usage/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/stock-usage.test.ts` ·
`packages/domain/tests/unit/reserved-categories.test.ts`

**Modify:** barrels · `classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` ·
`_journal.json` · `docs/ROADMAP.html`

## 5. Contract

```
stock_usage_records
  id, org_id, store_id, location_id -> stock_locations
  kind        'usage' | 'wastage' | 'adjustment' | 'opening'  NOT NULL
  status      'draft' | 'posted' | 'void' NOT NULL default 'draft'
  used_on     date NOT NULL
  department_id  uuid NULL -> departments        -- attribution, usage only
  reason_code    text NULL                       -- WASTAGE_REASONS; required for kind='wastage'
  adjustment_reason text NULL                    -- free text; required for kind='adjustment'
  charge_person_id  uuid NULL -> persons         -- wastage only
  posted_at, posted_by, voided_at, voided_by, void_reason
  created_by, created_at
  check (kind <> 'wastage'    or reason_code is not null)
  check (kind <> 'adjustment' or adjustment_reason is not null)
  check (charge_person_id is null or kind = 'wastage')

stock_usage_lines
  id, record_id -> stock_usage_records (cascade)
  line_no, item_id, quantity numeric(14,3) NOT NULL   -- SIGNED only for kind='adjustment'
  movement_id uuid NULL -> stock_movements
  unique (record_id, line_no)
```

```ts
saveDraft / addLine / removeLine / deleteDraft
postUsageRecord(id): Promise<PostResult>     // the only step that moves stock
voidUsageRecord(id, reason): Promise<void>
```

## 6. Invariants

1. **A draft moves nothing.** No movement, no layer, no entry until `postUsageRecord`.
2. ⭐ **A usage or wastage record whose category, reason or note resolves to a reserved
   `transfer` synonym is REFUSED, server-side.** The synonym list is shared with the client, and
   the client copy is a convenience — the server one is the control.
3. **A `usage`/`wastage` line must have `quantity > 0`.** Only `adjustment` accepts a signed
   quantity, and only with `can_adjust_inventory`.
4. **The source location must be `operating`.** ⚠️ And where a store has any active operating
   locations, `location_id` is **required** — v1 closed a real drift hole here where the store
   balance moved and the per-location balance did not.
5. **Posting calls T-164** — `postConsumption` for `usage`, `postWastage` for `wastage`,
   `postCountVariance`-equivalent for `adjustment` — and does not compute cost or choose accounts
   itself. One implementation of the posting rules, not a second copy.
6. **Wastage with a `charge_person_id` posts the salary-advance charge in the same transaction**,
   or the whole post fails (T-164 invariant 9).
7. **Void reverses stock, layers and entry in one transaction, and voids a linked staff charge
   FIRST** — so a failure never leaves a reversed stock movement standing beside an un-reversed pay
   deduction. ⭐ The ordering is v1's and it is deliberate.
8. **Equipment-kind items need no low-stock threshold** and fire no replenishment.
9. **A void is terminal.** A voided record is never re-posted; a correction is a new record
   (invariant 5).
10. **Period lock applies to post and to void.**
11. **A frozen location (T-169) refuses a post**, with an admin-only bypass that is itself audited.

## 7. ⚠️ Two questions for Ian, raised rather than decided

### 7.1 The threshold forcing function

v1 **refuses to post usage for a meat item until someone has configured its low-stock threshold** —
a forcing function that makes every trackable item get a reorder point. `docs/discovery/14` §B
flags it: *"is this a rule Ian wants preserved, or was it a workaround for a different problem?"*

**Recommendation: do not port it.** It couples a *reporting* setting to an *operational* action,
and the failure mode is a kitchen unable to record what it used at 11pm because a setting was never
filled in. **The need it serves is real** — items without thresholds never appear in low-stock —
and T-175 serves it better: a **finding** listing items with no threshold, which nags a manager
instead of blocking a cook. ⭐ **Built as recommended; say so plainly, and it is one line to
restore if Ian disagrees.**

### 7.2 Opening / initial inventory

v1 lets a manager set, edit and reset an opening balance per item at any time. **v2 narrows this
to the cutover**: `opening_counts` + T-134 own the 2027-01-01 opening, and row 106 says v2 always
starts from zero. ⭐ **What survives is a NEW STORE's opening balance** — a store joining after
cutover genuinely needs one, `kind='opening'`, admin-only, posting against `3900` per T-134's rule.
⛔ **Edit and reset do not survive**: an opening balance that can be re-typed after postings exist
is a plug, and `balanceadjustment.plug` is in `POSTING-PATTERNS.md` specifically so nobody ports it
forward.

## 8. Tests

1. A draft moves nothing: on-hand, layers and entries are all unchanged until post.
2. Posting 5 kg of usage writes one movement, consumes FIFO layers, and posts `Dr 5110 / Cr 1310`
   at the FIFO cost — cost asserted, not just the presence of an entry.
3. ⭐ A record with category `transfer` is refused — asserted for **every** synonym in the reserved
   list, as a table-driven test.
4. Posting from a `storage` location is refused; from an `operating` one, accepted.
5. In a store with operating locations, a record with no `location_id` is refused.
6. Wastage with `reason_code = 'spoilage'` posts `5300`, never `5110`.
7. Wastage with a charge posts both legs; forcing the charge to fail rolls back the stock movement.
8. Void reverses stock and entry, and voids the staff charge **first** — asserted by ordering, with
   a forced failure after the charge void leaving no reversed stock.
9. An adjustment of −3 by a user without `can_adjust_inventory` is refused.
10. A post into a closed period is refused.
11. A post into a frozen location is refused; an admin bypass succeeds and writes an audit row.
12. Re-posting a voided record is refused.
13. Live route on 9008: draft on one screen, post on another, and see on-hand and the P&L move.

## 9. ⚠️ Built 2026-08-29 — and the loop closes

**Landed:** `packages/db/schema/stock-usage.ts` · migration `0067` · `packages/domain/src/stock/consume.ts`
· `usage.ts` · both registries · `packages/domain/tests/integration/stock-usage.test.ts` (19 cases).

### 9.1 ⭐ Phase 3's exit gate passes on a real loop

The last test asserts, on stock that was **actually received and actually used**:

```
Σ (1310 + 1320 + 1330 + 1340)  ==  Σ (open layer remaining × unit cost)
```

⭐ That is bible §10's Phase 3 gate — *"inventory control account = sum of on-hand valuations"* —
and it is the invariant that has been **unenforceable since the project began**, because no
inventory subledger existed to reconcile against. It now holds across receive → consume.

⚠️ It is not yet the *continuous* check §15.13 wants; that is the `inventoryControlDoesNotMatchValuation`
detector, which belongs with T-165's switch. This proves the arithmetic; that will prove it never
drifts.

### 9.2 ⭐ `consume.ts` — and waiting for a caller was right

T-162 deferred this wrapper because *"its real shape depends on its first caller."* It does. What
the usage post needed — take a quantity, return **cost lines and a movement id**, inside a
transaction the caller owns — is not the signature that would have been guessed, and the ordering
matters more than the signature:

```
1. LOCK the open layers   FOR UPDATE   ⭐ before planning, not after
2. plan                   pure
3. write the OUT movement
4. apply each layer line  subledger + decrement
```

⚠️ **The lock comes first.** Planning against unlocked layers and then writing is precisely v1's
shape — two posters read the same remaining quantities and both commit. The lock is what makes the
plan still true when it is applied.

### 9.3 One module where v1 has two

v1 runs `general-inventory.actions.ts` for items and `meat-usage.actions.ts` for meat — two
lifecycles, two race guards, two copies of one rule set, **8 transaction sites** in the busiest
file in the domain. That split existed only because `meatProducts` and `inventoryProducts` were
separate collections, **a duality v1 was already retiring itself**. T-145 finished it, so the
meat-specific rules are now rules about a `kind`.

### 9.4 The three refusals worth reading

| Refusal | Why it is not negotiable |
|---|---|
| ⭐ A reason of **`transfer`** | v1's named footgun. The usage flow writes only an OUT leg, so a movement labelled a transfer **destroys stock instead of moving it** — it leaves one room and arrives nowhere. Refused in the domain (synonym list) *and* by a CHECK, so no path reaches the table. ⚠️ The message says WHY, or the next person just picks another word for it |
| ⭐ A **staff charge** while Phase 5 is unbuilt | ⛔ Refused, never silently dropped. **A charge that vanishes is worse than one that fails**: the stock still moved, and somebody believes they are being recovered from |
| A **storage room** as a usage source | Consumption in a stockroom means the count was never taken. ⚠️ An `adjustment` is exempt — a miscount lives exactly where the stock is |

### 9.5 §7's two open questions, built as recommended

- **§7.1 the threshold forcing function — NOT ported.** It couples a *reporting* setting to an
  *operational* action, and the failure mode is a kitchen unable to record what it used at 11pm
  because a setting was never filled in. T-175's `itemHasNoThreshold` finding serves the real need
  — it nags a manager instead of blocking a cook.
- **§7.2 opening balances — narrowed.** `kind = 'opening'` exists for a store joining after
  cutover. ⛔ v1's edit and reset do not survive: an opening balance that can be re-typed after
  postings exist is a plug, and `balanceadjustment.plug` is in `POSTING-PATTERNS.md` precisely so
  nobody ports one forward.

### 9.6 Void ordering, kept from v1

A linked staff charge is voided **FIRST**. v1's reason is a real failure: a crash between the two
must never leave a reversed stock movement standing beside an **un-reversed pay deduction** —
somebody still being charged for meat that is back on the shelf.

⚠️ And a void gives stock back to **the exact layers it came from**, never to the oldest open one,
which would be a silent re-costing (T-162 invariant 7). Asserted per layer.

### 9.7 Not built

| Piece | Why |
|---|---|
| The `/inventory/usage` route | ⛔ Port 9008 held all day — `docs/PENDING-VERIFICATION.md` |
| The adjustment posting path | `kind='adjustment'` is storable and location-exempt; its signed posting is T-164's `postCountVariance`, and its document is T-169's count session |
| The staff-charge leg | Phase 5, and §11.4 is what happens until then |

## 10. Out of scope

⛔ **The posting rules themselves.** T-164 owns account choice, cost and the period lock.
⛔ **A second meat-specific module.** §2 — one path, `kind` is a column.
⛔ **Order/channel wastage.** T-178. Different system, same word (phase plan §6.1).
⛔ **Low-stock listing and auto-order.** T-175.
⛔ **Production conversion.** T-176 — an input *and* an output, which is a different shape.

## 11. Done when

- [x] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
      **Done 2026-08-29** (`0067_t168_stock_usage.sql`) — no migration in this session; the screen
      needed none.
- [x] `classification.ts` **PURGE**; `rls/registry.ts` NULLIF-guarded. **Done 2026-08-29.**
- [x] §7.1 and §7.2 built as recommended, and **both raised in the task report's `FOR IAN` block**
      — a decision taken by a spec is still a decision Ian gets to see (§3.5). Built 2026-08-29;
      **restated again in this session's `FOR IAN` block**, since a decision that only reaches Ian
      once is one re-read away from being forgotten.
- [x] `typecheck` clean. [x] `npm test` (unit) green — 942 passed, 1 skipped, 56 files, including
      this session's new `cogs-category.test.ts`.
      [x] **Integration — scoped, not the shared command.** ⛔ Per this lane's own constraints,
      `npm run test:integration` was never run (it truncates the SHARED `shareat_test` another lane
      may be using). Ran ONLY this task's files against the private `shareat_test_t168`:
      `usage-records.test.ts` (this session, 30 cases) + `stock-usage.test.ts` (the engine,
      unchanged, now 20 cases after DEF-141) — **50/50 green**, real Postgres, twice (before and
      after DEF-141's fix landed).
      [x] `npm run build` — run by the coordinator 2026-09-03 with the dev server stopped, after
      all four lanes and the review fixes (DEF-144 included): clean.
- [x] `CAPABILITY-MATRIX.md`: `post_usage`, `void_usage_record` — **already declared 2026-08-29**,
      each with its ✗ test via the shared `authorize.test.ts` generator, and re-exercised directly
      in `usage-records.test.ts` (staff ✗ on both, staff ✅ on the draft). `can_adjust_inventory`
      maps to the existing `adjust_inventory` (manager+, staff ✗) — **not exercised**, because this
      pass does not build `kind='adjustment'`'s draft/post path, so there is no caller to test yet.
      `can_charge_staff` = the existing `charge_staff_for_discrepancy` — same story, no caller
      (Phase 5). `bypass_count_freeze` is **deliberately not declared** — no caller, per the brief.
- [x] `docs/ROADMAP.html` updated — by the coordinator 2026-09-03: T-168's line names the
      zero-caller gap, DEF-141, and the unbuilt adjustment/opening kinds.

## 12. Built 2026-09-03 — the document and the screen (DEF-135)

DEF-135 named this task's gap exactly: *"T-168 (`postUsageRecord`/`voidUsageRecord`) is fully
built, fully tested — but grepped across all of `apps/`, none has a single non-test caller."* This
session closes that gap. §9's engine is untouched except by the coordinator's own fix (§12.4); this
section is entirely new work built on top of it.

### 12.1 What shipped

- **`packages/domain/src/stock/usage-records.ts`** (overwrote the barrel stub) — the
  authorize-and-orchestrate document layer §9.2's own header says T-167/T-169 already carry twice:
  an engine with no `Actor` and no `authorize()` call, and a document layer above it that turns "a
  person, acting" into the engine's plain inputs. Exports: `saveUsageDraft`, `addUsageLine`,
  `removeUsageLine`, `deleteUsageDraft`, `postUsage`, `voidUsage`, `cogsCategoryForItemKind` — all
  new names, none colliding with the barrel (`postUsageRecord`/`voidUsageRecord`/`saveDraft`/
  `dispatch` stayed taken, as flagged).
- **`packages/db/src/repo/stock-usage.ts`** (overwrote the barrel stub) — `insertUsageRecord`,
  `insertUsageLines`, `getUsageRecord`, `listUsageRecords`, `listUsageLines`, `deleteUsageLine`,
  `deleteUsageDraft`, `setUsageLineMovement`, `markUsagePosted`, `markUsageVoid`,
  `listOperatingLocations`, `listDepartments` — the last two are reads against `stock_locations`/
  `departments` kept in THIS file rather than T-160's `repo/stock-locations.ts`, per the brief's
  explicit steer to avoid editing a file another lane owns mid-flight.
- **`apps/erp/src/app/inventory/usage/`** — `page.tsx` (register + "New record" form, dynamic item
  rows, kind toggles the wastage-reason field), `NewUsageForm.tsx` (client), `actions.ts`
  (`saveUsageDraftAction`/`postUsageAction`/`deleteUsageDraftAction`/`voidUsageAction`), `lib.ts`
  (reads, `withOrgPrincipal`); `[id]/page.tsx` — lines with current on-hand in the record's own
  room beside each, Post/Delete-draft/Void, the post confirmation showing FIFO cost and the journal
  id(s) in the `?ok=` banner.
- **`packages/domain/tests/unit/cogs-category.test.ts`** — 6 cases for `cogsCategoryForItemKind`.
- **`packages/domain/tests/integration/usage-records.test.ts`** — 30 cases covering spec §8 tests
  1, 2, 3 (table-driven over every `RESERVED_USAGE_CATEGORIES` entry), 4, 6, 11's refusal half, 12,
  the authorize boundary (staff ✗ on post/void, staff ✅ on draft), void-restores-exact-layers, and
  the domain-owned validation (`WASTAGE_REASONS` membership, quantity > 0, non-empty lines) the
  engine itself does not check (see §12.3).

### 12.2 The COGS-category derivation — a real gap ported as parity, not silently

Items carry no COGS-category column (`packages/db/schema/items.ts` has `kind` only — T-149 spent
that column budget on three independent sellability flags, not a costing taxonomy).
`cogsCategoryForItemKind(kind)` bridges the two: `meat_slab`/`meat_sliced` → `meat`, `retail` →
`retail`, `supply` → `packaging`, `raw_material`/`prepped` (the latter not yet a real `ItemKind` —
T-176's future conversion output) and anything else → the `food` catch-all. ⭐ **v1 does the same
thing** — `meat-usage.actions.ts` never varied its account by item either — so this is parity, not
a regression, and COA-ALIGNMENT §4.1 already marks `5100` "drive to zero" for exactly the items a
coarser mapping cannot place more precisely. A real per-item COGS-category column is future work,
not assumed here.

### 12.3 What `usage.ts` does NOT validate, and why that had to live here

Building `postUsage` found that `postUsageRecord`'s own reserved-category check
(`isReservedUsageCategory(input.reason)`) never verifies the reason is a real `WastageReason` at
all — any string that is not on the reserved-synonym list passes through untouched. Nothing was
wrong with the engine (it takes typed input and trusts its caller, same as every other tx-level
function in this codebase), but nothing above it enforced `WASTAGE_REASONS` membership either,
until `saveUsageDraft` did. This is now checked at DRAFT time, in the order that matches the
engine's own (`isReservedUsageCategory` first, then `isWastageReason`) so the reserved-category
message — "a usage writes only an OUT leg…" — still fires for every synonym even though none of
them are valid `WastageReason`s to begin with (test §8.3's table-driven case exercises exactly
this).

### 12.4 ✅ DEF-141 — void reversed stock and layers but left the entry standing, found here, fixed by the coordinator

Building `voidUsage` and reading `usage.ts`'s `voidUsageRecord` line by line (bible §3.4a: report a
spec defect, never patch around it) found that void reversed `stock_movements` and `stock_layers`
via `reverseConsumption` but **never touched the journal entry `postUsage` wrote** — no
`stock_usage_line`, and no `stock_movements` row, carries a link back to the (possibly grouped)
entry a post creates, so nothing above the engine could safely find it either. Reported rather than
patched, since `usage.ts` is out of this lane's scope. **The coordinator fixed it in the engine
itself, logged as DEF-141**, same session: `voidUsageRecord` now finds the posted entries by
`(source_type = kind, source_id LIKE '<recordId>:%')` via `journalRepo.findPostedEntriesBySource`
and reverses each through `reverseEntry`, returning `reversalEntryIds`; `VoidUsageInput` gained an
optional `reason` that lands on the reversal entries' memo. `voidUsage` here was updated to pass
the caller's void reason through and surface `reversalEntryIds`; `usage-records.test.ts`'s own void
test now asserts `5100` and `1310` return to their exact pre-post balances, not just that the
layers and quantity come back. **Smoketested live** (§12.5) with the reversal entry's id shown on
screen.

### 12.5 Smoketested live on 9008 — SMK, Kitchen B only

Store **Smoketest Commissary (SMK)**, room **Kitchen B** (operating), item `PORK-SMOKE`. Stockroom
A was never touched. Flow, scripted headless Chromium:

1. **Dev Cashier** (staff) drafts a 3 kg usage of `PORK-SMOKE` from Kitchen B → saved, nothing
   moved.
2. Cashier clicks **Post** → refused on screen: *"Only a manager or admin can post — a floor
   worker can draft, but posting is what moves stock and the books."*
3. **Dev Manager** signs in, opens the same record, clicks **Post** → succeeds: `Dr 5100 ₱300.00 /
   Cr 1310 ₱300.00` (3 kg × the FIFO-oldest ₱100 layer; `raw_material` → `food` → `5100`, never
   `5110`), one `usage` movement of `-3`, one `stock_layer_consumptions` row. On-hand banner and
   `/inventory?store=SMK` both show the new total.
4. Manager drafts a 1 kg **wastage**, reason `spoilage`, from Kitchen B → posts → `Dr 5300 ₱100.00
   / Cr 1310 ₱100.00` — never `5100`/`5110`.
5. Manager **voids** the wastage with a reason (*"smoketest — recorded in error"*) → on screen:
   *"Voided. Stock and the FIFO layers are restored, and the entry is reversed — journal
   \<id\>."* DB confirms: the original entry flipped `posted → reversed`; a new entry posts `Dr
   1310 ₱100.00 / Cr 5300 ₱100.00`; a `wastage_void` movement of `+1` restores the layer.
6. Kitchen B's on-hand: 8 kg (original) + 20 kg (topped up live through the real `/inventory/
   deliveries` screen another lane shipped today, since the item's only pre-existing FIFO layer had
   already been fully depleted by unrelated smoketests — see §12.6) − 3 kg (usage) − 1 kg (wastage,
   posted) + 1 kg (wastage, voided) = **25 kg**, exactly as the ledger predicts.

Twelve screenshots captured (register, draft form filled, draft saved, cashier refusal, manager
pre/post, on-hand before/after, wastage draft/posted/voided, on-hand final).

### 12.6 A pre-existing data-drift found while smoketesting, not caused here

The task doc's own smoketest plan assumed `PORK-SMOKE` held 8 kg of real, layer-backed value in
Kitchen B. On the day, `stock_movements` still showed 8 kg physically in the room, but the item's
FIFO layer at the STORE level (layers are per-store, not per-room — T-162 invariant 6) had already
been fully consumed to `0.000` by other lanes' same-day smoketests (DEF-136/DEF-140's own commissary
pork dispatches). This is exactly the class of drift `inventoryControlDoesNotMatchValuation` exists
to catch, and it is not this task's to fix — it was worked around, not patched, by receiving a
fresh 20 kg delivery into Kitchen B **through the real `/inventory/deliveries` screen** (another
lane's T-166 build, live the same day), never by SQL. Recorded here because a future session
reading this task's smoketest and finding different numbers should not conclude the screen is
broken — the store's layer history has simply moved on again.

### 12.7 Same-day review fixes (coordinator) — DEF-144, and two smaller ones

The Opus review of the four DEF-135 lanes found that `postUsageRecord` and `voidUsageRecord`
looped `consume()` / `reverseConsumption()` with `if (!result.ok) return result` — right for the
first line, wrong for every later one, where the earlier line's movement and layer consumptions
were already written and `postUsage` → `actions.ts` → `withOrgPrincipal` would COMMIT the
half-post. **DEF-144**: both loops now throw once anything has been written, so the transaction
unwinds; a refusal on the first line is still returned with nothing to unwind. Pinned by
`stock-usage.test.ts` *"a refusal on line 2 UNWINDS line 1"*. Also: a dead `sourceId` field in the
posting group's common input was removed, and `voidUsage` passes the user's void reason through
to the reversal entries' memo (DEF-141's `VoidUsageInput.reason`). The `cogsCategoryForItemKind`
parity choice (§12.2) is now a row in `docs/CAPABILITY-GAPS.md` so the `5100` balance is a known
debt, not a surprise in the first P&L.

### 12.8 Not built in this pass, named rather than hidden

| Piece | Why |
|---|---|
| `kind='adjustment'` draft/post | T-168 §7.2/§9.7's own scoping — its posting is T-164's `postCountVariance`, and its document is T-169's count session (a different, concurrently-built lane) |
| `kind='opening'` | Admin-only, new-store-joining-after-cutover case (§7.2) — no caller in this pass |
| `chargePersonId` / staff charges | Phase 5. The engine already refuses a charge outright (§9.4); nothing here tries to route around that |
| The admin freeze-bypass (`bypass_count_freeze`) | Not declared, per this lane's brief — no caller |
| `addUsageLine`/`removeUsageLine` UI wiring | Built to the domain contract (§5) and unit-tested, but the "New record" form creates every starting line in one dynamic-row submission (matching `NewOrderForm`'s own shape) — no screen currently calls them one line at a time. A deliberate scope choice, not an oversight |
| Persistent redisplay of FIFO cost / entry ids on a re-visited posted record | Shown once, in the post confirmation `?ok=` banner — `stock_usage_records` carries no column for either, and parsing them back out of `journal_entries.source_id` was considered and deliberately deferred as scope the brief did not ask for |
