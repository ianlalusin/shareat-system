# T-390: Opening stock from the count into FIFO opening layers per room, plus opening subledger tie-out gates

**Status:** SPEC APPROVED WITH CHANGES 2026-10-10 (review applied; S2 gated on t390-q2). Written at `main` `a6a9665`
by the Opus planner; the money review's 13 findings are applied in §4 R5a, R8, R13, R15-R17, §5, §7, §8 and §11.
**Model:** Sonnet lanes, **tester first** in every slice, then builder (bible row 184). An amendment is written in plan
mode (Opus).
**Lane:** L1 Cutover, wave 1 (`docs/plans/remaining-build-plan.md` §3.1-§3.3). Size **M 3.5 + S 1.5 ≈ 5.5 lane-days**.
**Migration:** **yes, one** — `0NNN (allocated at merge)`, hand-authored per ADR-012 §5. No new table.
**Defect:** DEF-623 (🔴): `opening_counts` records the count, but nothing turns it into `source='opening'` layers,
`kind='opening'` movements or a `1310` line; `postOpeningBalances` never reads it. Plan items C1 + C2.
**Ian:** Q8 (open on the Open Questions page) is built to its recommendation, **(a) count per room + (c) last v1
delivery price**, and both halves are made DATA, so a different answer changes no code (§4 R2, R3).
⛔ **Conflict named:** bible §16.11 (`PROJECT_BIBLE.md:2149`) says the 2027-01-01 opening layer is **weighted
average**; Q8 (c) is a last price. **The bible wins until Ian rules** on `t390-q2-opening-cost-basis` (Open Questions
page). The basis is a price-file setting (R2, §5.5 `--basis`), so either ruling is data, but **S2 does not start until
that question is answered** (S1, S3's asset half, S4 may proceed).

---

## 1. Goal

On 1 January every counted item sits **in the room it was counted in**, as a FIFO `opening` layer at its counted
cost, and **the same value is the `1310`/`1320`/`1330` opening line against `3900`**, so stock and books agree from the
first sale. The opening is not accepted (C5 refuses) while **any of the named registers disagrees with its control
account** (stock, fixed assets, prepaids; valid parties on loans, advances `1230`, AR/AP and money accounts; the
inter-store pair; `3900` per store), or while **nobody has attested that the party balances agree with v1's aged
lists**. Every refusal is one plain sentence naming the register, the store, and the difference. Accounts with no
v2 register are listed as **"not checked here"**, never shown green (R15). Count day has **printable count sheets**
per store per room.

## 2. Source

| What | Where |
|---|---|
| The gap | DEF-623; plan §1.1 C1, C2; T-168 §7.2 and §9.5 (`kind='opening'` narrowed, no caller); T-169 inv. 10 |
| The wizard this extends | T-134 (`docs/tasks/134-cutover-wizard.md`): steps A1-C5, the four gates, "derived, never a static list", the double-counting guard, "opening-count variance posts against 3900" |
| Posting pattern | `docs/POSTING-PATTERNS.md` `opening_balance.load` (lines 1351-1373): one entry dated **2027-01-01**, balance-sheet only, every figure against `3900`; `receipt` lines for the inventory account by item kind (`INVENTORY_ACCOUNT_BY_ITEM_KIND`, `packages/domain/src/stock/receipt-posting.ts:63`) |
| Rulings that bind | Bible row 106 (zero starting point), **row 109** (inventory at COUNTED value; assets at **net book value** with remaining life; opening equity clears to 3300), row 110 (FIFO), §16.11 (perpetual; layers per item per STORE, movements per LOCATION; "the 2027-01-01 opening layer is weighted average … the basis changes exactly once"), §16.1 inv. 4, 6, 7, 10; ADR-007 (pilot then purge; `fixed_assets` keep_shell; `prepaid_items` purged and re-entered, Ian Q1 2026-09-25; `loans`/`liabilities` kept, balance re-entered) |
| Code read | `packages/domain/src/cutover/{index,opening,steps}.ts`, `packages/db/schema/cutover.ts`, `packages/db/src/repo/cutover.ts`, `packages/db/schema/stock-{layers,ledger,usage}.ts`, `packages/domain/src/deliveries/receive.ts` (the movement + layer + entry shape this copies), `packages/domain/src/stock/layers.ts` (`lineCost`), `packages/db/src/repo/stock-layers.ts` (`createLayer`, `valuation`), migrations 0063 (append-only, period, no-negative triggers), 0064 (layer subledger tie), 0068 (frozen room), 0180 (Manila-day period), `packages/db/src/repo/{fixed-assets,loans,prepaid}.ts`, `packages/db/src/cutover/classification.ts`, `apps/erp/src/app/cutover/**` |
| v1 (requirements only, §1.2d) | `ERP-rebuild/src/app/inventory/stocks/page.tsx:78` "Set Initial" = a one-time base stock per item, then a separate "Rooms" allocation; v1 keeps a per-room ledger (`itemStockLedger`, `inventoryBalances` by `locationId`, `delivery.actions.ts:607-625`); delivery lines carry `unitCost` per delivered unit (`delivery.actions.ts:93-97`, `stores/{id}/deliveries`). **v1 holds no inventory value** (quantity only) and **has no printable count sheet** |

**v1's goal, written down (§1.2d step 2):** know what is on each shelf on day one, once, so later stock movements
start from a true number. v1 reached it in two clicks per item and lost the value. **v2's bar:** the same one-time
number, per room, **valued**, tied to the books in the same transaction, and impossible to re-type afterwards (T-168
§7.2: an opening that can be edited after postings exist is a plug).

## 3. Research brief: what we are NOT doing

| Pattern seen | Verdict | Why |
|---|---|---|
| ERPNext opening Stock Reconciliation (qty + valuation rate per warehouse, difference to an asset/liability account) | **Adopted in shape** | It is the industry standard and it is what T-134 already chose (`3900`, never `5400`). Our "warehouse" is the room |
| Odoo inventory adjustment at opening with an automatic balancing line | **Not adopted** | An automatic balancing line is a plug. T-134 inv. 6: a `3900` residual halts |
| One opening layer per item per store (literal reading of §16.11) | **Adopted in substance, not in rows** | `stock_layers_movement_key` allows ONE layer per movement, and movements are per room. So each counted room gets its own layer, **all with the same unit cost and the same `received_at`**. The "single average cost per item per store" is enforced as a rule (§4 R3, §6 I3), not as a single row. ⚠️ **Not identical at the centavo:** a consumption that spans two room layers writes two `stock_layer_consumptions` lines, each rounded (`layers.ts`, cost per LINE), so it can cost up to ₱0.005 more or less per extra line than one store layer would. Accepted: bounded, sub-centavo per line, and the alternative (one store layer tied to the default room's movement) breaks the one-layer-per-movement quantity meaning |
| Typing the inventory opening as a figure (`addOpeningFigure('1310', …)`) | **Refused** | A typed figure is a second copy of a number the count already holds. The figure is GENERATED from the counts; typing `1310`/`1320`/`1330` is refused |
| Writing stock at "value the count" time (C3) | **Refused** | Stock movements are append-only and have no draft state. Writing them before C5 means a count correction needs reversal rows, and stock would exist before the books open. Stock is written **inside C5's transaction**, from the counts, next to the post |
| A variance against v1's book quantity | **Not built** | v1 holds no inventory value and v2 holds none after the purge. There is no prior figure to differ from, so the count IS the opening. T-134's "variance against 3900" therefore reduces to the whole count value against `3900` |
| Showing the expected quantity on the count sheet | **Refused (blind count)** | Standard count practice: a printed expected figure anchors the counter. The sheet lists what to count, never how many |
| Tie AR/AP/loans/advances to v1's audited trial balance by machine in this task | **Not by machine; by a named attestation (R16)** | Those registers derive from party lines, so inside v2 they can only be checked for **valid parties**. A machine v1 comparison needs T-392 (not built by 6 Nov). So C5 also requires an **attested** step "Opening party balances agree with v1's aged lists" (R16), and the panel says plainly that the green party rows mean "valid parties", not "matches v1" |
| A generic "register framework" | **Not built** | Seven registers, seven named queries. A framework for seven fixed cases is cleverness with no second user |

## 4. Rulings

- **R1 · Count per room (Q8 a).** `opening_counts` gains `location_id` (NOT NULL, a room of the same store). Key becomes
  `(store_id, location_id, item_id)`. **If Ian answers Q8 (b) "per store"**: counts go into the store's default room
  (the import's blank room column means the default room). No code changes. `recordOpeningCount`'s `locationId` is
  **optional**: absent means the store's default room, refused in words if the store has none. That also keeps
  `apps/erp/src/app/cutover/actions.ts:57` (which passes no room) typecheck-green from S1 until S5 adds the selector
  (review finding 8).
- **R2 · The cost source is an input, recorded per row.** `opening_counts` gains `cost_source` (free text, not blank)
  and `cost_evidence` (free text, nullable). `unit_cost` and `cost_source` are null together or set together (CHECK).
  The import reads one or more **price files**, each labelled with its source (`v1_last_delivery`,
  `supplier_catalogue`, `commissary_transfer`, …); the first file that prices an item wins. A typed cost on the
  screen is `cost_source = 'typed'`. **Changing Q8's cost answer = supplying a different price file.** No enum, no
  migration.
- **R3 · One cost per item per store.** Typing or importing a cost for an item in one room sets it on **every room's
  row for that item in that store**, in the same statement. The stock generator re-checks and refuses on a
  disagreement, naming the item, the store and both rooms.
- **R4 · Cost is per BASE unit, quantity is in BASE units.** The count sheet prints the base unit and, as a hint, the
  purchase unit with its factor ("1 box = 50 pcs"). The price-list script converts v1's delivered-unit cost to the v2
  base unit (v1 line unit = v2 base unit → as is; = v2 purchase unit → ÷ `conversion_factor`; anything else →
  **reported by name and skipped, never guessed**). The divided cost is rounded **half-up to 4 dp** inside
  `buildV1PriceList` (₱125 ÷ 48 = 2.604166… → `2.6042`), because `parseFourDecimalCost` refuses more than 4 dp at
  import (review finding 10). Test 20a.
- **R5 · The inventory figure is generated, one draft per store.** `valueOpeningStock(store)` writes one
  `opening_balance` draft: `Dr 1310`/`1320`/`1330` (only non-zero accounts, account by item kind via
  `INVENTORY_ACCOUNT_BY_ITEM_KIND`) / `Cr 3900`. Each account line = Σ over items of **round2(Σ rooms qty × unit
  cost)**: one rounding per item per store, the "single opening layer" of §16.11. Idempotency key
  `opening-stock:{org}:{store}`. Pressing it again deletes the draft and writes it fresh (it is a draft; T-134
  correction 3). An item kind with no inventory account refuses, by item name.
- **R5a · Post each draft ONCE (review finding 1, verified).** `cutoverRepo.openingDrafts` returns one row **per
  non-3900 line** (`repo/cutover.ts:254-277`), and `postOpeningBalances` calls `postDraftEntry` per row
  (`opening.ts:224`). The inventory draft has up to three such lines, so today the second call hits `recordGone` and
  C5 fails for any store holding two item kinds. Fix: `postOpeningBalances` posts the **distinct** entry ids (the
  screen list keeps its per-line rows); `posted` counts entries, not lines. The one-draft-per-store shape stays.
  Test 10a + mutant M27.
- **R6 · Typing an inventory, 1590, 2120 or 1340 figure is refused.** `addOpeningFigure` refuses `1310`, `1320`,
  `1330` ("Inventory opens from the count: enter the count, then press Value the count"), `1590` ("Assets open at net
  book value (bible row 109), so accumulated depreciation opens at zero"), and `2120`/`1340` per R15.
- **R7 · Stock is written at C5, in the posting transaction.** `postOpeningBalances`, after its existing residual and
  drift checks and the new tie-out (R9), for every `opening_counts` row with quantity > 0: one movement
  (`kind='opening'`, `source_type='opening_count'`, `source_id` = the count row id, `moved_at` = conversion date
  `T00:00:00Z`, `journal_entry_id` = that store's inventory draft) and one layer (`source='opening'`, same
  `source_id`, `received_at` = same instant, `unit_cost` = the row's cost, `movement_id` = that movement). Then every
  draft posts. All or none.
- **R8 · Nothing opening-related works before the purge or after the post.** `addOpeningFigure`,
  `valueOpeningStock`, `valueOpeningAsset` and `postOpeningBalances` refuse unless a `C2` row with completion
  `performed` exists ("The purge (C2) has not run. It deletes every journal entry, so a figure entered now would be
  lost."). ⛔ **Today NOTHING writes that row** (review finding 2, verified: `applyPurge` in
  `packages/db/src/cutover/purge.ts:315` and `scripts/cutover-purge.ts` record no step; `attestStep` would write
  `attested`). So **S2's builder** makes `applyPurge` take `performedBy: string` (a person id; `ApplyPurgeOptions`)
  and insert, inside the purge transaction after its post-conditions, one `cutover_steps` row per organization:
  `step_code 'C2'`, `completion 'performed'`, note = "Purged N rows from M tables as of {asOf}". `cutover_steps` is
  KEEP, so the purge does not delete it. `scripts/cutover-purge.ts` gains a required `--by <personId>` for `--apply`
  (refused if the person does not exist); `--rehearse` rolls the row back with everything else. `attestStep` refuses
  `C2` ("The purge records this itself when it runs."). R8 accepts **only** `performed`. Tests run **the real
  `applyPurge`** to get there (test 9a), never a hand-inserted row. `recordOpeningCount`, `addOpeningFigure`, `removeOpeningFigure`, `valueOpeningStock`, `valueOpeningAsset`
  refuse once a **posted** `opening_balance` entry exists ("The books were opened on {date}. A correction is now a
  reversal or an ordinary stock document."). `recordOpeningCount` is allowed before C2 (the count is 31 Dec; the purge
  is 1 Jan; `opening_counts` is KEEP).
- **R9 · The tie-out is a query, decided by the database, shown in C4, enforced in C5.** §5.3 lists the registers.
  C4's verified check becomes "3900 nets to zero **and every register ties**"; C5 refuses with the first five
  sentences and a count of the rest. A recorded row cannot make it pass (T-134 inv. 1).
- **R10 · Fixed assets open at net book value (row 109).** `valueOpeningAsset(assetId, bookValue,
  remainingLifeMonths, salvageValue?)` calls the existing `fixedAssetsRepo.valuateShell` with `acquiredOn` =
  conversion date, `cost` = book value, `usefulLifeMonths` = remaining life. It is the missing domain caller of
  `valuateShell` (T-347 §159 named the gap). An asset not found on the walk-round is **disposed in the ordinary
  screen before the purge** (the purge then drops it, T-347); a shell still pending after the purge blocks C5 by name.
- **R11 · Prepaids.** Opening prepaid items are created on the ordinary `/prepaid` screen with coverage starting on the
  conversion date and `total_cost` = the unamortised balance at 31 Dec. A remainder below the ₱5,000 capitalisation
  threshold (bible row 141) is expensed in v1 before close, not carried; `createPrepaidItem` already refuses it.
- **R12 · Party on the opening form.** The figure form gains a party picker for party-requiring accounts (customer,
  supplier, loan, employee, money account), filtered to the chosen store. Today the action passes no party at all, so
  no AR/AP/loan/advance opening can be entered from the screen.
- **R13 · One opening per org, concurrency-safe, writers included.** `postOpeningBalances` takes the EXCLUSIVE
  `pg_advisory_xact_lock(390001, hashtext(org_id))` before reading anything. **Every other opening writer**
  (`recordOpeningCount`, `addOpeningFigure`, `removeOpeningFigure`, `valueOpeningStock`, `valueOpeningAsset`,
  `importOpeningCounts` via `recordOpeningCount`) takes the SHARED `pg_advisory_xact_lock_shared(390001,
  hashtext(org_id))` **before its R8 check**, so writers run side by side but none can commit between C5's checks and
  its post (review finding 3). Both helpers live in `repo/cutover.ts` (namespace 390001 is new). A second post then
  finds a posted opening and is refused by R8. Tests 14, 14a.
- **R14 · Dates.** Every opening figure, the inventory drafts and the movements carry the conversion date
  `2027-01-01` (POSTING-PATTERNS). The constant moves from `apps/erp/src/app/cutover/lib.ts` to
  `packages/domain/src/cutover/` as `CONVERSION_DATE`; the app re-exports it. The tie-out lists any opening draft dated
  otherwise. **DEF-585 does not bite**: the opening is dated in Jan 2027, and production has periods 2026-10..2027-09.
  A missing or closed period refuses through the existing `closedStockPeriodSentence`, before the first write.
- **R15 · Accounts with no register (review finding 5).** Decided per account, and the Goal is narrowed to match:
  | Account | Ruling | Why |
  |---|---|---|
  | `1250`/`2150` inter-store | **Checked: register T9** | Bible §16.1 inv. 6: per store pair, `1250` at A for B = `2150` at B for A (party `store`). Cheap, and the classic missing-transfer failure |
  | `3900` | **Checked per store: T10** | A store's imbalance can hide inside a zero org total. Each store's `3900` (inventory, figures, and that store's `3900 → 3300` reconcile) must be zero |
  | `2120` GRNI | **Refused at entry** | A v2-only account; A1 clears the delivery backlog in v1, so nothing is received-not-invoiced on 31 Dec |
  | `1340` in transit | **Refused at entry** | Goods in transit on 31 Dec are counted in the receiving store's room on count day |
  | `1220`, `1240`, `2130`, `2140`, `2300`, `22xx` and any other balance-sheet account | **Allowed, listed "not checked here"** | Real 31 Dec balances can exist; v2 has no register to compare with. The panel lists each with its figure under "Not checked here (agree it with v1's trial balance at the rehearsal)" and never shows it green |
- **R16 · The party totals are attested before C5 (review finding 6).** New step `C3P`, phase C, `attested`,
  org-wide: "Opening party balances agree with v1's aged lists" (AR per customer, AP per supplier, loans, advances).
  New gate `C3P → C5`; `postOpeningBalances` refuses without the row ("Nobody has confirmed the customer, supplier,
  loan and advance balances against v1's lists (step C3P)."). It is upgraded to `verified` by T-392's comparator
  later; this task does not wait for it.
- **R17 · Inventory value has one implementation.** `cutoverRepo.countedValue` (a float total,
  `repo/cutover.ts:186`) is removed; every caller (the count screen's total) uses `planOpeningStock` (review finding
  11).

## 5. Contract

### 5.1 Migration `0NNN (allocated at merge)` — `0NNN_t390_opening_counts_per_room.sql`

1. Precheck in the header comment (run on production before apply, result recorded in the PR):
   `select count(*) from opening_counts;` expected **0**. Not 0 is not a failure: step 3 handles it.
2. `ALTER TABLE opening_counts ADD COLUMN location_id uuid REFERENCES stock_locations(id) ON DELETE RESTRICT;`
   `ADD COLUMN cost_source text; ADD COLUMN cost_evidence text;`
3. Backfill existing rows to the store's `is_default` active room; a store with counts and **no default room, or more
   than one**, makes the migration `RAISE` with the store id and the count of default rooms (loud, never a guessed
   room). Then `SET NOT NULL` on `location_id`.
4. `DROP INDEX opening_counts_store_item_key;` `CREATE UNIQUE INDEX opening_counts_store_location_item_key ON
   opening_counts (store_id, location_id, item_id);` `CREATE INDEX opening_counts_location_idx ON (location_id);`
5. Backfill `cost_source = 'typed'` where `unit_cost is not null`. Then CHECKs:
   `opening_counts_cost_source_pair_check`: `(unit_cost is null) = (cost_source is null)`;
   `opening_counts_cost_source_not_blank_check`: `cost_source is null or length(trim(cost_source)) > 0`.
6. Trigger `opening_counts_room_in_store` (BEFORE INSERT OR UPDATE OF location_id, store_id): `RAISE` unless the room
   exists with that `store_id` (sentence: "room % is not a room of store %").
7. Grants: the table already has UPDATE for the upsert; confirm, add nothing new. RLS unchanged (the table is already
   registered). `classification.ts` and `rls/registry.ts`: **no change** (no new table; `opening_counts` stays KEEP).
8. `meta/_journal.json` entry on the grid (ADR-012 §5 step 5), **added by the orchestrator at merge**, never by the
   builder. Schema `packages/db/schema/cutover.ts` mirrors 2-5, with
   a `// NOTE: trigger hand-added in migration 0NNN` beside `locationId`.

### 5.2 Functions

| Function | File | Contract |
|---|---|---|
| `recordOpeningCount(tx, actor, {storeId, locationId, itemId, quantity, unitCost?, costSource?, costEvidence?, note?})` | `domain/cutover/index.ts` (changed) | `run_cutover` on the store. Refuses a room not active in the store, a negative count, a cost without a source (screen passes `'typed'`), and R8's post-open case. A cost (re)sets every room row for that item in that store (R3) |
| `importOpeningCounts(tx, actor, {storeId, rows, priceFiles})` | `domain/cutover/import.ts` (new) | Pure parse + resolve, then `recordOpeningCount` per row. `rows`: `{roomName?, itemCode, quantity}` (blank room = default room). `priceFiles`: ordered `{source, rows: {itemCode, unitCostPerBaseUnit, evidence?}[]}`. Returns `{written, unknownItems[], unknownRooms[], unpriced[]}`. Dry run is the caller's (script) choice |
| `buildV1PriceList(deliveries, v1Items, v2Items)` | `domain/cutover/price-list.ts` (new, PURE) | Last non-voided delivery line per item by `deliveryDate` then id; converts to base unit (R4); maps v1 → v2 by the same normalised-name key `scripts/import-items.ts` uses; returns `{rows, skipped: {name, reason}[]}` |
| `valueOpeningStock(tx, actor, {storeId})` | `domain/cutover/opening-stock.ts` (new) | R5. Refuses: R8, a counted qty > 0 with no cost (lists up to 5 item names), R3 disagreement, an unmapped kind. Returns `{entryId, byAccount: {code, amount}[]}`; no counts with value → removes any old draft, returns `null` |
| `planOpeningStock(counts, itemKinds)` | `domain/cutover/opening-stock.ts` | PURE. The one implementation of R5's arithmetic, used by `valueOpeningStock`, by C5's re-check, and by the tie-out |
| `writeOpeningStock(tx, orgId, actorPersonId)` | `domain/cutover/opening-stock.ts` | Internal, called only from `postOpeningBalances`. R7. Recomputes the plan from the counts; refuses if a store's plan ≠ its draft's lines ("Lipa's count changed after it was valued: press Value the count again"); refuses if any `opening_count` movement already exists |
| `valueOpeningAsset(tx, actor, {assetId, bookValue, remainingLifeMonths, salvageValue?})` | `domain/cutover/opening-assets.ts` (new) | R10. `run_cutover` on the asset's store; R8; book value > 0; life 1-600 whole months |
| `openingTieOut(tx, orgId)` | `domain/cutover/tie-out.ts` (new) | Calls the repo queries in §5.3, returns `{holds, lines: TieLine[]}` with `TieLine = {register, storeId, account, registerFigure, ledgerFigure, difference, sentence}` |
| `postOpeningBalances` | `domain/cutover/opening.ts` (changed) | Order: authorize → exclusive lock (R13) → R8 → drafts exist → C3P attested (R16) → residual → drift → `openingTieOut` → `writeOpeningStock` → post each **distinct** draft id once (R5a) → record C5 |
| `addOpeningFigure` | `domain/cutover/opening.ts` (changed) | + shared lock (R13), R6, R8; party passed through (R12) |
| `applyPurge(tx, plan, {performedBy, …})` | `packages/db/src/cutover/purge.ts` (changed) + `scripts/cutover-purge.ts` (`--by`) | R8: records `C2 performed` per org inside the purge transaction |
| `attestStep` | `domain/cutover/index.ts` (changed) | refuses `C2` (R8) |
| `CUTOVER_STEPS` / `CUTOVER_GATES` | `domain/cutover/steps.ts` (changed) | + `C3P` attested, gate `C3P → C5` (R16); C4 title "3900 nets to zero and every register ties" |
| `cutoverProgress` / `evaluate('C4')` | `domain/cutover/index.ts` (changed) | C4 holds only when residual = 0 **and** `openingTieOut.holds`; `detail` = first sentence + "and N more" |
| Repo | `packages/db/src/repo/cutover.ts` (changed) | per-room upsert keyed on the new index; `countsForStore`, `countsWithoutCost`, `itemsWithoutCount` (still per STORE: one row in any room satisfies B3), `openingPosted(org)`, `c2Performed(org)`, `lockOpening(org)`, `openingStockMovementsExist(org)`, and one query per register (§5.3) |

### 5.3 The registers (R9) — one query each, `repo/cutover.ts`

| # | Register | Register figure | Ledger figure (opening drafts + posted `opening_balance`) | Refusal sentence (shape) |
|---|---|---|---|---|
| T1 | Stock, per store × `1310`/`1320`/`1330` | `planOpeningStock` over the counts | that account's opening line(s) for the store | "Stock at Lipa comes to ₱48,210.50 on 1310 but the opening figure is ₱47,900.00, ₱310.50 apart. Press Value the count again." Also: "12 counted items at Lipa have no cost: Pork belly, …" |
| T2 | Fixed assets, per store × `1510` | Σ `cost` of `active` assets with `acquired_on` = conversion date | `1510` line | "Fixed assets at Malvar come to ₱312,400.00 but the 1510 opening figure is ₱300,000.00, ₱12,400.00 apart." Plus each `pending_valuation` shell by name; plus any `1590` opening line (R6) |
| T3 | Prepaids, per store × `1400` | Σ `total_cost` of `active` prepaid items | `1400` line | same shape |
| T4 | Loans, per loan × `2400` | every `active` loan of the store | `2400` lines with the loan as party | "Loan 'Grab Capital 2' at Lipa has no opening balance. Enter it, or mark the loan paid off if nothing was owed on 31 Dec." / "A 2400 opening figure at Lipa names a loan that is not in the loan register for Lipa." |
| T5 | Advances to employees, `1230` | persons with an employment (any status) at the line's store | `1230` lines | "A 1230 opening figure at Davao names someone who has never been employed at Davao." |
| T6 | AR `1210` / AP `2110`, per party | customers / suppliers of the org | lines on those accounts | orphan or wrong party type, by name; plus the existing double-counting guard (`partiesWithOpeningAndPreCutoverDocs`), **now a refusal** |
| T7 | Money accounts `1110`/`1120`/`1130`/`1140` | active money accounts of the store with that `gl_account_code` | lines naming a `money_account` party | a line naming a money account of another store, another GL code, or a retired one. Active accounts with **no** figure are listed in the gaps panel but **do not refuse** (a zero balance is legitimate and cannot be entered as a figure) |
| T8 | Dates | — | every opening draft | "The opening figure for 2110 (Supplier X) is dated 2026-12-31. Every opening figure is dated 2027-01-01." |
| T9 | Inter-store, per store pair | `2150` at B with party A | `1250` at A with party B | "Lipa says Malvar owes it ₱8,000.00; Malvar's opening says it owes Lipa ₱7,500.00, ₱500.00 apart." |
| T10 | `3900` per store | — | that store's `3900` lines, drafts included | "3900 at Davao carries ₱1,240.00. Each store's opening must clear on its own." |
| — | Not checked here (R15) | — | every other balance-sheet opening account | listed with its figure, never green, never a refusal |

Amounts compared in centavos (`money()`), never floats (T-371). Party-derived registers (T4-T7) say in the panel:
"checked for valid parties; the totals are compared with v1 at the rehearsal (T-394)".

### 5.4 Screens (`apps/erp/src/app/cutover/**`)

- `/cutover/count` — store **and room** selectors; rows per active item with qty, cost, cost source (read-only label;
  typing a cost sets `'typed'`); a per-room "counted N of M" line; B3 stays per store.
- `/cutover/count/sheet?store=&room=` — **print page**. Per room: header (store, room, date 31 Dec, page n of m), one
  row per item (code, name, base unit, purchase-unit hint, empty Qty box, empty Remarks), ten blank rows "Found here,
  not listed", footer "Counted by / Checked by / Time". Items listed for a room: items with any movement in that room
  in the last 90 days (pilot data still exists on 31 Dec), plus items whose default room it is; "All rooms" prints
  one section per active room with a page break. `@media print` hides navigation. **No expected quantity anywhere.**
- `/cutover/opening` — party picker (R12); per-store "Value the count" button showing the generated lines; an
  "Assets to value" list (every `pending_valuation` shell: book value, remaining months, salvage, Save); a **Tie-out**
  panel listing T1-T10 per store: green "ties" / red sentence. The post button stays; it refuses on R9.
- Every refusal is the domain's `userReason` through `redirectWithFlash` (existing pattern). T-389 typed-value keep is
  not required here.

### 5.5 Scripts (`scripts/cutover-*`, L1)

- `scripts/cutover-v1-price-list.ts --v1-store <firestoreStoreId> --store <v2 store code> --basis last|weighted
  [--since YYYY-MM-DD] --out prices.csv` — `--basis` is t390-q2's answer as a SETTING: `last` = the last non-voided
  delivery (`source = v1_last_delivery`); `weighted` = Σ cost ÷ Σ base quantity over deliveries since `--since`
  (default 90 days before 31 Dec; `source = v1_weighted_average_<since>`), half-up to 4 dp. Both are pure functions in
  `price-list.ts`.
  reads v1 Firestore **read-only** (`stores/{id}/deliveries`, `stores/{id}/items` or the path `import-items.ts` uses),
  calls `buildV1PriceList`, writes `item_code,unit_cost_per_base_unit,source,evidence` with `source =
  v1_last_delivery` and evidence `"{deliveryId} {date} {supplier} {qty} {unit} @ {unitCost}"`. Prints the skipped list.
- `scripts/cutover-import-counts.ts --org <id> --store <code> --counts counts.csv --prices a.csv[,b.csv] [--apply]` —
  DRY RUN by default (prints what it would write and every unknown item, unknown room and unpriced item); `--apply`
  calls `importOpeningCounts` inside `withOrgPrincipal`. Price files apply in the order given (R2).

## 6. Invariants (each has a test in §8)

- **I1 · Stock = books at opening.** Immediately after C5, for every store and every inventory account:
  Σ over items of `round2(Σ layers.quantity × unit_cost)` (= `stockLayersRepo.valuation(store)` grouped by account) =
  the posted opening line on that account for that store. And Σ opening lines on `1310`+`1320`+`1330` (org) = Σ of
  every store's plan.
- **I2 · Per room.** For every counted row with qty > 0: `onHand(item, room)` = the counted quantity, exactly one
  `opening` movement and one `opening` layer exist for it, and the layer's `movement_id` is that movement. A zero
  count writes nothing. No movement is negative (the 0063 no-negative trigger stays satisfied by construction).
- **I3 · One cost per item per store.** All `opening` layers of an item in a store share one `unit_cost` and one
  `received_at`.
- **I4 · Idempotent.** A second `postOpeningBalances` writes nothing and refuses in words; a second `valueOpeningStock`
  leaves exactly one inventory draft per store; a retried import writes the same rows (upsert), not more.
- **I5 · One opening per org.** After a posted `opening_balance` entry exists, every opening writer refuses (R8).
  Two concurrent posts: exactly one succeeds (R13).
- **I6 · Tie-out refuses in words.** Every T1-T10 failure blocks C5 and C4 with a sentence naming the register, the
  store and the difference (or the party). No override and no plug (T-134 inv. 6).
- **I7 · All or none.** A refusal anywhere inside C5 (tie-out, changed count, closed period, a trigger) leaves zero
  `opening` movements, zero `opening` layers and every opening entry still `draft`.
- **I8 · `3900` still nets to zero** only when every figure, the generated inventory lines included, is in (unchanged
  C4 arithmetic; the inventory draft now participates).

## 7. Slices (tester first in each; TESTER and BUILDER paths are disjoint)

| Slice | Size | TESTER writes (only) | BUILDER writes (only) |
|---|---|---|---|
| **S1 · Count per room** — migration, schema, repo, `recordOpeningCount` (optional room, R1), R2/R3, count half of R8/R13 | **S 1.0** | `tests/integration/t390-s1-opening-counts-per-room.test.ts` | `packages/db/migrations/0NNN_t390_opening_counts_per_room.sql`, `packages/db/schema/cutover.ts`, `packages/db/src/repo/cutover.ts`, `packages/domain/src/cutover/index.ts`. (`meta/_journal.json`: the **orchestrator**, at merge) |
| **S2 · Opening stock (DEF-623 core)** — ⛔ **gated on t390-q2** — `planOpeningStock`, `valueOpeningStock`, `writeOpeningStock`, R5, R5a, R6-R8, R13, R14, R17, the purge's C2 row, `postOpeningBalances` order | **M 2.0** | `tests/unit/t390-s2-plan-opening-stock.test.ts`, `tests/integration/t390-s2-opening-stock-post.test.ts`, **and the existing callers R8 now refuses:** `packages/domain/tests/integration/cutover.test.ts` (C2 reached through the real `applyPurge`, not `attestStep`) and `apps/erp/tests/integration/t343-s5-5v-followups.test.ts:826` (fixture runs the purge before `addOpeningFigureAction`) | `packages/domain/src/cutover/opening-stock.ts`, `packages/domain/src/cutover/opening.ts`, `packages/domain/src/cutover/index.ts` (exports, `CONVERSION_DATE`, `attestStep` refuses C2), `packages/db/src/repo/cutover.ts`, `packages/db/src/cutover/purge.ts`, `scripts/cutover-purge.ts` |
| **S3 · Tie-out + asset valuation** — T1-T10, R15 refusals and "not checked" list, R16 `C3P`, C4 evaluate, C5 refusal, `valueOpeningAsset` | **M 1.75** | `tests/integration/t390-s3-tie-out.test.ts`, `tests/integration/t390-s3-opening-assets.test.ts` | `packages/domain/src/cutover/tie-out.ts`, `packages/domain/src/cutover/opening-assets.ts`, `packages/domain/src/cutover/{index,opening,steps}.ts`, `packages/db/src/repo/cutover.ts` |
| **S4 · Import + price list** | **S 0.5** | `tests/unit/t390-s4-price-list.test.ts`, `tests/integration/t390-s4-import-counts.test.ts` | `packages/domain/src/cutover/price-list.ts`, `packages/domain/src/cutover/import.ts`, `scripts/cutover-v1-price-list.ts`, `scripts/cutover-import-counts.ts` |
| **S5 · Screens + count sheets** | **S 0.75** | `tests/integration/t390-s5-cutover-actions.test.ts` (actions pass party and room through; refusals reach the flash) | `apps/erp/src/app/cutover/**` (`count/page.tsx`, `count/sheet/page.tsx` new, `opening/page.tsx`, `actions.ts`, `lib.ts`) |

Order: S1 → S2 → S3; S4 after S1 (parallel with S2/S3 only if the orchestrator gives it its own test DB, RULES §2);
S5 last. **S1-S3 serialise on `repo/cutover.ts` and `domain/cutover/index.ts`**: one builder at a time on those files.
If t390-q2 is unanswered when S1 lands, run S3's asset and party registers (T2-T10, R15, R16) before S2; T1 lands
with S2. Total **6.0 lane-days** (review added ~0.5).

## 8. Tests, with the mutant each must kill

Fixtures: one org, two stores (A with rooms Kitchen, Freezer, default room Kitchen; B with one room), items of kinds
`raw_material`, `supply`, `prepped`, fiscal period 2027-01 open, an admin actor, and **C2 reached by running the
real `applyPurge` with `performedBy`** (never a hand-inserted `cutover_steps` row), plus an attested `C3P` where C5
must pass.

| # | Test | Kills mutant |
|---|---|---|
| 1 | S1: same item counted in Kitchen and Freezer = two rows; B3 holds for store A with one row in any room | M1 unique key left as (store, item) |
| 2 | S1: a room of store B on a store A count is refused by the database (raw insert) and by the domain | M2 trigger missing / checks only existence |
| 3 | S1: cost typed in Kitchen appears on the Freezer row; `cost_source = 'typed'` | M3 cost written to one room only |
| 4 | S1: `unit_cost` set with null `cost_source` is refused by the CHECK | M4 pair CHECK missing |
| 5 | S1: count after a posted opening refused; count before C2 accepted | M5 R8 applied to counts before C2 |
| 6 | S2 unit: three rows of 1 unit at ₱0.0050 in three rooms of one store value at ₱0.02 (one rounding of 3 × 0.005 = 0.015 → 0.02), not ₱0.03 | M6 rounding per room instead of per item per store |
| 7 | S2 unit: `supply` lands on 1320, `prepped` on 1330, unmapped kind refused by name | M7 hard-coded 1310 |
| 8 | S2: `valueOpeningStock` twice → one draft per store, figures equal the second call's counts | M8 second draft added (idempotency key ignored) |
| 9 | S2: before C2 refused with the purge sentence | M9 R8 C2 check removed |
| 9a | S2: `applyPurge(…, {performedBy})` writes exactly one `C2 performed` row per org with the row-count note; `--rehearse` leaves none; `attestStep('C2')` refused; an `attested` C2 row does not satisfy R8 | M9a purge records nothing (R8 then refuses forever); M9b R8 accepts any completion |
| 10a | S2: store A holds `raw_material` + `supply` + `prepped` (three lines in one inventory draft) and C5 posts; `posted` = number of distinct entries | **M27** posting per `openingDrafts` row (second `postDraftEntry` on the same id → `recordGone`) |
| 10 | S2: post → per room `onHand` = count; one movement + one layer per qty>0 row; zero rows write nothing; layer `movement_id`, `received_at`, `unit_cost` as specified; movement `journal_entry_id` = the store's inventory entry | M10 one movement per store (room lost); M11 zero-qty row writes a movement (CHECK fails → whole post fails) |
| 11 | S2: I1 asserted through `stockLayersRepo.valuation` against the posted GL lines per store per account | M12 GL built from a different sum than the layers |
| 12 | S2: count edited after valuing → post refused, nothing written (I7) | M13 C5 posts the stale draft without re-checking |
| 13 | S2: a failure injected **after** the movements and layers are written: the test creates (and drops in `finally`) a `BEFORE UPDATE` trigger on `journal_entries` that RAISEs when a row whose memo is a test marker becomes `posted`, and adds that marked opening draft. C5 then fails at `postDraftEntry` → zero `opening` movements, zero `opening` layers, every opening entry still `draft`. (Closing the period is NOT this test: it refuses before the first write) | M14 stock written in a separate transaction / committed before the post |
| 14 | S2: second post refused in words; two concurrent posts on two connections → one success, one refusal, one set of movements | M15 exclusive lock removed and no other guard |
| 14a | S1/S2/S3: for each writer (`recordOpeningCount`, `addOpeningFigure`, `removeOpeningFigure`, `valueOpeningStock`, `valueOpeningAsset`): connection 1 holds C5's exclusive lock (open transaction), connection 2 calls the writer and **blocks**; after connection 1 commits the post, connection 2 is refused by R8 and writes nothing | M28 a writer skips the shared lock (its write commits after C5 checked) |
| 15 | S2: `addOpeningFigure` refuses 1310, 1320, 1330, 1590; S3: also 2120, 1340 | M16 any one allowed |
| 16 | S3: T1-T10, one passing and one failing case each; each failure's sentence contains the store name, the register word and the difference in pesos (or the party name) | M17 a register query dropped (its failing case passes); M18 comparison in floats (₱0.10 + ₱0.20 case) |
| 17 | S3: C4 is not done while any tie fails, even with a recorded C4 row and a zero residual | M19 C4 reads the row, not the query |
| 18 | S3: double-counted party now refuses C5 | M20 guard left as a gaps-only list |
| 18a | S3: C5 refused without an attested `C3P`; a `1240` figure appears under "not checked here" and never as a tie; T9 refuses a 1250/2150 pair ₱500 apart; T10 refuses store B's `3900` of ₱1,240 while the org total is zero | M29 C3P gate missing; M30 per-store 3900 check summed org-wide |
| 18b | S3 (F1 verdict): receive nothing; post the opening; return some opening stock to a supplier through the real supplier-return path (no delivery) → no `2120` line is written; the credit is `1240` | M31 a return of opening stock credits `2120` |
| 19 | S3: `valueOpeningAsset` sets cost, acquired_on = 2027-01-01, life = remaining; T2 then ties; a shell left pending refuses C5 by name | M21 acquired_on set to the original date |
| 20 | S4 unit: last delivery wins by date then id; voided ignored; purchase unit ÷ factor; unknown unit skipped with reason; name match is the normalised key | M22 first delivery wins; M23 factor multiplied |
| 20a | S4 unit: ₱125 per box of 48 → `2.6042` (half-up, 4 dp) and the import accepts it; `--basis weighted` over two deliveries gives Σcost ÷ Σqty at 4 dp | M32 unrounded cost (import refuses); M33 weighted = mean of prices |
| 21 | S4: two price files, the first wins; a blank room goes to the default room; unknown item and room reported, nothing written in dry run | M24 later file overrides; M25 dry run writes |
| 22 | S5: party and room reach the domain from the actions; a refusal reaches the flash as the domain's sentence | M26 party dropped in the action |

Each builder runs its tests red first and records the failing line (RULES §2), then the mutants above by hand and
lists them killed in the report. The full suite runs in CI on the PR (bible row 291); S1 carries the migration, so S1
goes on its own PR (RULES DoD).

## 9. Migration checklist (ADR-012 §5)

Number `0NNN (allocated at merge)` by the orchestrator (next free is 0190 today; do not claim it in the branch name or
file before merge). Header comment names T-390, DEF-623, R1/R2 and the production precheck with its expected 0. Proved
on a scratch database from zero, and on a copy holding one opening count with a default room (backfill path) and one
without (RAISE path). Full suite on a fresh gate DB (memory: a trigger migration is gated on the FULL suite). No
`meta/*_snapshot.json`.

## 10. §9.4 smoke (port 9008, dev seed)

1. `/cutover/count/sheet?store=Lipa` prints one section per room, no expected quantities; browser print preview shows
   no navigation. Screenshot.
2. Count 3 items in Kitchen and 1 of them in Freezer; type a cost on one; see the cost on both rooms.
3. Dry-run then `--apply` `scripts/cutover-import-counts.ts` with a two-line price file; see `cost_source` on screen.
4. Run the purge with `--apply --by <personId>` (rehearsal DB only; T-347's dry-run first) and see C2 recorded as performed. Press **Value the count**: see the
   1310/1320 lines and the residual move.
5. Enter a supplier AP figure with the party picker; value one asset shell; create one prepaid.
6. Tie-out panel: deliberately mistype the 1510 figure, read the red sentence, fix it, see green.
7. POST. Then `/inventory` (stock by room) shows the counted quantities per room, and the trial balance shows 1310 =
   the stock valuation for the store. Screenshots of 1, 6 and 7 in the report.

## 11. Out of scope

- A MACHINE v1-to-v2 comparison for AR/AP/loans/advances/money (T-392 comparator; it later upgrades `C3P` to verified) and for the "not checked here" accounts (T-394 rehearsal).
- The `3900 → 3300` reconcile entry (row 109) and its screen: existing C3 figures cover it; unchanged here.
- Removing a fixed-asset shell after the purge (rare; R10 routes it through disposal before C2; the rehearsal shows if
  it happens).
- A new store joining after cutover (`stock_usage kind='opening'`, T-168 §7.2): untouched; still no caller.
- Counting in purchase units on screen (the sheet prints the hint only).
- Batch inserts for speed: the post writes one movement and one layer per row (~3,000 rows for four stores). The
  rehearsal (T-394) times it; a batch insert is a follow-up only if it is slow.

**Found while specifying, for the orchestrator to log (this spec edits no other file):**
- **F1 → DEF-624: re-verified UNREACHABLE.** An `opening` layer is `is_provisional = true` by construction, but
  `deriveLineCreditBasis` (`supplier-returns.ts:70-78`) returns `supplier_advance` (`1240`) when the return names no
  delivery (`:75`), and `stockLayersRepo.findByDeliveryItem` filters `source = 'delivery'`
  (`repo/stock-layers.ts:240-250`), so an opening layer is never the layer it reads. A return of opening stock credits
  `1240`, never `2120`. DEF-624 can close as not-a-defect; test 18b pins it so a later change to either function
  cannot reopen it silently.
- **F2 (🔸, doc).** `docs/POSTING-PATTERNS.md` `opening_balance.load` shows `1590 Cr 40,000` and the reconcile entry
  clears to `3100`; bible row 109 says assets open at net book value (1590 at zero) and equity clears to `3300`. The
  pattern needs re-wording by the planner; T-390 follows row 109.
- **F3 (🔸).** `addOpeningFigure` today accepts figures before the purge (C2), which the purge would delete. Fixed here
  by R8.

## 12. Done when

- DEF-623 closes: on a restored copy, after C5, every counted item is on hand in its room, every store's inventory
  accounts equal its layer valuation, and the post refused at least once on a deliberate tie-out failure.
- Tests 1-22 and their lettered additions green, mutants listed killed; full suite green in CI on the PR(s); migration proved per §9.
- §10 smoke done with screenshots; typecheck, `npm run build` (dev server stopped) clean.
- `docs/DEFECTS-REGISTER.md` DEF-623 updated by the orchestrator with the commit(s); F1-F3 logged.
- Count sheets printed once for Lipa from the rehearsal copy and handed to Ian for the 13 Nov rehearsal test count.

## 13. Questions for Ian (only his)

- **t390-q2-opening-cost-basis (on the Open Questions page; S2 is gated on it).** Bible §16.11 says weighted average; Q8 (c) says last v1 delivery price. Either is `--basis weighted|last` on the price-list script; no code differs.
- **Q8 (already open on the Open Questions page; not re-asked).** Built as (a) per room + (c) last v1 delivery price.
  Either answer is now data (R1, R2).
- **Q-T390-1 · Items no v1 delivery ever priced.** Commissary-made (`prepped`) items and anything never delivered
  have no last v1 delivery price. Options: **(a) the commissary's price file (its transfer price) for prepped items,
  and the store manager types the rest on count day** · (b) the manager types every one · (c) open them at zero.
  **Recommended (a):** a transfer price is the closest thing to cost the commissary has; zero (c) understates the
  books and hides stock from the valuation. Built so any of the three is just a price file or a typed cost. Priority:
  low until the 13 Nov rehearsal, when the unpriced list for Lipa will show how many there are.
