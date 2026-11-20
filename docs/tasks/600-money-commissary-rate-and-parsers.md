# T-600 - Money: zero and branch-typed transfer rates, wholesale repeat items, settlement parser gaps, period dates

Status: SPEC (Opus), 2026-11-18. Source: `docs/reviews/2026-11-18-money-audit-part-2.md` (findings 1-7). Fixes DEF-897..DEF-903
(add each as a register row in the DEF-866 format, `fixed - T-600`, in the slice that fixes it). Risk: **high** (money).
Builder: Sonnet. Every line number is main 9892641. **All slices unblocked (BOSS rulings at the end). S6 carries migration 0262.**
No new capability, no bible change, no POSTING-PATTERNS change (every fix is a refusal or a warning; no leg moves).

Verification summary: all seven findings re-read on main and confirmed in code. Two review citations were off:
`fulfilLine` is `fulfilment.ts:131-158` (rate at 146), `proposeLine` rate is 199-208, not 161-170 / 196-203 / "~200".
DEF-900 is **not** covered by T-536 (`7bafb29`, PR #168): T-536 guarded only the internal `dispatchOrder`
(`commissary/transfer.ts:213-220`); the external loop in `trade/index.ts` was never touched. Bible row 428 does not exist
(rows jump 410 -> 430); row 316 is about menu prices, not transfer prices.

## DEF-897 - a ₱0.00 internal transfer line is received but never enters branch stock

Main `commissary/orders.ts:149-159` `normaliseRate` accepts `0` and rounds `0.004` to `0.00`; `:182-184`:
```ts
if (bp) return { rate: normaliseRate(bp.price, 'branch price'), from: 'branch_price' };
const manual = await lowStockRepo.offeringCost(tx, orgId, commissaryStoreId, itemId);
if (manual !== null && manual !== undefined) return { rate: normaliseRate(manual, 'manual cost'), from: 'manual_cost' };
```
`commissary/transfer.ts:445-446` then drops the line at receipt with no movement and no discrepancy row:
```ts
const value = lineCost(booked, line.rate);
if (compare(value, ZERO) <= 0) continue;
```
**Decision: refuse at every entry path AND at `markReady`.** Entry refusals tell the person who typed it; the
`markReady` check is the backstop for zero-rate lines already saved on open orders (no migration, and dispatch can only
follow ready, trigger 0121). Refusing only at dispatch would let a whole day's packing be done on a bad price first.
Change, `orders.ts`:
1. New exported helper beside `normaliseRate`: `requirePositiveRate(rate: Money, itemName: string, verb: string): Money`
   that, when `compare(rate, ZERO) <= 0`, throws
   `refuse(\`${verb}: ${itemName} rate is ${rate}\`, \`The rate for ${itemName} must be more than ₱0.00. Set its price on the commissary catalogue.\`)`.
2. `resolveBranchRate` 182-184: a branch price or manual cost that normalises to `0.00` is treated as unpriced (fall
   through to the next tier, then `null`). Callers already refuse `null` by name; `auto-order.ts:179` already skips it;
   `orderableCatalogue` (229) then shows the item as unpriced.
3. Call `requirePositiveRate` after the rate is decided in: `buildBranchLine` (after 315), `updateBranchOrderLine`
   (after 465), `fulfilment.ts` `fulfilLine` (after 146, only when `qty` is positive: a zero-quantity line sends
   nothing), `proposeLine` (after 208).
4. `fulfilment.ts` `markReady`, after line 281: for each counted line with a positive `fulfilledQuantity` and
   `compare(money(l.rate), ZERO) <= 0`, refuse (first offender, item name via `itemsRepo.getItemById`):
   `'<name> is priced at ₱0.00, so the branch could not take it into stock. Enter its rate before marking the order ready.'`
Leave `transfer.ts:446` as it is (out of scope; after this fix it is unreachable for new orders).
Tests, `packages/domain/tests/integration/branch-orders.test.ts`, new `describe('DEF-897 - no ₱0 transfer line')`:
- refused with the sentence, zero lines written: draft with `rate: '0'`; draft with `rate: '0.004'`; `fulfilLine` with
  `rate: '0'` and quantity 5; `proposeLine` with `rate: '0'`; an offering whose manual cost is `0.00` and no branch price
  (draft with blank rate -> the existing "cannot be priced" sentence).
- positive: `fulfilLine` quantity `0` with blank rate still saves (zero is an answer, file header line 14).
- `markReady` backstop: set a line's `rate` to 0 by SQL on an accepted order -> refused with the sentence.
- end to end (positive): a ₱0.01 line dispatches and receives, branch movement exists.
**Mutants:** delete each `requirePositiveRate` call / the `resolveBranchRate` zero check / the `markReady` loop -> each red.

## DEF-898 - the branch can type the transfer price (ruled: option A, R1)

Main `orders.ts:302-304` (new draft and added lines) and `:465` (draft edit):
```ts
if (draft.rate != null && draft.rate.trim() !== '') {
  rate = normaliseRate(draft.rate, item.name);
```
Boxes: `apps/erp/src/app/commissary/orders/page.tsx:227-229` ("Rate ₱ (blank = default)", new order),
`commissary/orders/[id]/page.tsx:268-269` (branch add-line, form 252) and `:581-582` (branch draft edit, form 576).
`fulfilLine` blank rate keeps `line.rate` (`fulfilment.ts:146`), so a branch-typed figure survives packing.
T-172 invariant 10 (`docs/tasks/172-branch-order-and-fulfilment.md:136`): "The branch may edit only its own lines; the
commissary only fulfilment fields." Invariant 11 / T-151 inv. 6: "a stated rate on a line wins over the branch price"
(written for the commissary's rate; it never says who may state one). **v1:** the branch screen fills the price from the
catalogue and shows it read-only (`ERP-rebuild/src/app/inventory/branch-orders/[id]/page.tsx:261`, `:617`); only the
commissary changes it, at fulfilment (`inventory/commissary/[id]/page.tsx:348`, `unitPriceAtFulfilment ?? unitPriceAtRequest`).
v1's server trusts a client-sent request price (`lib/actions/branch-order.actions.ts:274`) - log that as a `reported` v1 row.

Options for Ian (plain words):
- **A. Only the commissary sets the price (recommended).** The branch sees the catalogue price and cannot change it. The
  commissary can still change it when packing. An item with no price cannot be ordered until someone prices it on the
  catalogue. Matches v1, matches invariant 10, and a cook can no longer make pork cost ₱0.10.
- **B. The branch may suggest a price, the commissary's figure always wins.** The branch's number is kept as a note;
  accepting the order resets every line to the catalogue price. More screens and a second rate column, for little gain.
- **C. Keep the box, but only for people allowed to set prices** (an existing price capability at that store). Useful
  only if a branch manager really must order an unpriced item urgently; leaves two owners for one field.
Change (A, ruled):
- Domain: delete `rate` from `BranchLineDraft` (orders.ts:266-271) and from `updateBranchOrderLine`'s input (450);
  `buildBranchLine` always uses `resolveBranchRate`; `updateBranchOrderLine` keeps `money(line.rate)`. The "state a rate
  on the line" hint in the unpriced sentence (311) becomes `'... Ask the commissary to set its price on the catalogue.'`
  Typecheck then names every caller.
- Screens/actions: remove the three branch boxes above and the helper text "The rate you use is saved on the line."
  (page.tsx:234-235); `orders/actions.ts:33,37` and `[id]/actions.ts:158,171` stop reading `rate`; the catalogue option
  text `' — no price, state one'` (page.tsx:217) becomes `' — no price yet'`; check `keepTyping`'s
  `COMMISSARY_LINE_UPDATE` field list and `orders/[id]/README.md` for `rate`.
- Commissary boxes stay: propose (`[id]/page.tsx:328`) and fulfil (605, 629). `fulfilLine` blank-keeps-rate is then
  correct (the line's rate is always the catalogue's or the commissary's).
- Open orders already carrying a branch-typed rate (R1): `acceptOrder` (`fulfilment.ts:80-85`), while seeding
  `fulfilledQuantity`, also sets each `origin = 'requested'` line's `rate` to `resolveBranchRate(...)` and re-derives
  `lineTotal`, then `refreshOrderTotal`. Unpriced -> refuse the accept naming the item (`'<name> has no price on the
  catalogue. Set its price before accepting the order.'`). After accept, the commissary's `fulfilLine` rate still wins.
  Orders already accepted, dispatched or received are never re-priced (no silent change to anything posted).
  Read-only count for BOSS before deploy (open branch orders whose rate may be branch-typed):
  `select count(distinct o.id) filter (where o.accepted_at is null) as not_yet_accepted, count(distinct o.id) filter (where
  o.accepted_at is not null) as accepted_keep_rate from trade_orders o join trade_order_lines l on l.order_id = o.id where
  o.requested_by_store_id is not null and o.status in ('draft','confirmed') and l.origin = 'requested';`
  (`trade_orders.accepted_at`, `packages/db/schema/trade.ts:88`).
  Test: a line saved at 0.10 by SQL on a submitted order -> after `acceptOrder` its rate is the catalogue's. **Mutant:**
  drop the re-price -> red.
- Tests that pass a branch rate must move the stated rate to `fulfilLine`: `branch-orders.test.ts:285` (invariant 11
  test), `t383-retired-item-usable.test.ts`, `apps/erp/tests/integration/t389-s4-commissary-web.test.ts` (grep `rate`).
New test in `branch-orders.test.ts`: a branch draft for a priced item takes the catalogue rate; the commissary's
`fulfilLine` with `rate: '315'` wins and is captured. Web (`t389-s4-commissary-web.test.ts`): a new-order FormData that
still carries `rate=0.10` saves the line at the catalogue price. **Mutant:** restore the action's `rate: rates[i]` and
the domain field -> red.

## DEF-899 - Foodpanda Appendix B row with amounts and no Category is skipped silently

Main `settlement-intake/foodpanda-workbook.ts:462-464`:
```ts
const row = data[r] ?? [];
const category = textOf(cellAt(row, at, 'category'));
if (category === '') continue;
```
Change: before `continue`, if `hasValue(cellAt(row, at, 'netTotal')) || hasValue(cellAt(row, at, 'ewt'))`, throw
`intakeRefusal('FOODPANDA_BAD_VALUE', \`Appendix B row ${r + 1} has amounts but no Category, so it is not a blank row and cannot be skipped.\`)`
(the same shape as Appendix A, 324-329). Parsers refuse through `intakeRefusal` with a code, not `refuse()`; that is the
house rule for this folder. **Before writing the fix, run the four real-workbook tests** (`t511-s3-foodpanda.test.ts`:
Banay, Lipa July, Malvar, the Appendix-B-only invoice). If any real file has a cached total row in Appendix B (blank
Category, a Net Total), stop and report: the rule then needs a total-row exception.
Tests, `packages/domain/tests/unit/t511-s3-audit-fixes.test.ts`, new describe beside "a row with no Order Code" (line 100),
using `fpChargeRow` (`t511-s3-helpers.ts:314`) with category `''`: Net Total 50.00 -> `FOODPANDA_BAD_VALUE` naming the
sheet row (`mentionsNumber`); EWT only -> refused; every cell blank -> skipped, charges unchanged (positive).
**Mutant:** delete the check -> red.

## DEF-900 - an external wholesale order with one item on two lines cannot be dispatched

Main `trade/index.ts:669` and `:674-679`:
```ts
cogsLines.push({ itemId: line.itemId, quantity: quantity(line.quantity), inventoryAccount });
...
for (const line of cogsLines) {
  const consumed = await consume(trx, { ... itemId: line.itemId, quantity: line.quantity,
    kind: 'usage', sourceType: 'trade_order_dispatch', sourceId: order.id, ... });
```
Two lines of one item -> second `consume` hits `stock_movements_source_pair_key` (0063:70), raw 23505, after the AR charge.
**Decision: merge, do not refuse.** Migration 0072:100-104 allows an external sale to list one item twice (tiered price,
free portion), and inter-entity orders already refuse it at create (`trade/index.ts:216-229`). Change: at 669, if
`cogsLines` already holds the item, add the quantity with `addQuantity` (`../stock/quantity`, add it to the import at
line 41) instead of pushing. One `consume` per item. Readers already cope: `returns.ts:283` takes the item's movement by
`find`, `franchise-credit.ts:99-104` shares one item's movements across its lines by quantity.
Tests, `packages/domain/tests/integration/trade.test.ts`, in `describe('dispatch is the billing event')` (395): an outside
buyer's order with rice on two lines (5 at 50.00, 3 at 0.01) dispatches; one `usage` movement of 8; COGS equals FIFO cost of
8; AR charge equals the order total. Then `customer-returns.test.ts`: return 2 of the second line -> succeeds.
**Mutant:** restore the plain `push` -> 23505, red.

## DEF-901 - Grab staging books a whole payout on one day without checking the orders' dates

Main `grab-payouts.ts:81` `storeDay: dayBefore(t.payoutDate.date, t.line),` and `stage.ts:225-233`; `grabDay` (137-222)
reads `row.createdOn.date` only for other-line dates. Spec rule (task 511 S1 §4.4): store day = payout date minus one.
**Decision: warn, never block** (the rule is Ian's; a block would stop every upload if Grab batches differently).
Change in `stageGrabDays`: for each staged payout, collect the distinct `createdOn.date` of its `payment` rows that differ
from `p.storeDay`; if any, push to the returned file-level `warnings` (NOT the day's `warnings`: `ingest.ts:319` counts
those as "do not add up to the payout"):
`Grab payout <settlementId> (paid <payoutDate>) includes orders from <dates>, but all of it is loaded as sales day <storeDay>. Check those days before approving.`
**First measure** on the real Lipa, Malvar and Banay pairs (`t511-s4-stage.test.ts:67` loop): count payouts that would
warn. If more than a few per file, stop and report the count: §4.4 is then wrong and goes to Ian.
Tests, `t511-s4-stage.test.ts`: a hand-built pair (pattern line ~196) whose payment rows are dated the day before the
payout and two days before -> one warning naming both; all rows on store day -> no warning (positive); the real files'
count pinned at the measured value. **Mutant:** compare against `payoutDate` instead of `storeDay` -> red.

## DEF-902 - no DB guard ties a journal entry's date to its period

Main `0003_journal_entries_and_lines.sql:214-243` and `0143_t264_period_override.sql:34-64` check only the period's
`status`. Same-org is already covered (`0213:141`, composite FK on `period_id`). Today every writer resolves the period
from the date, so this is a missing backstop (RULES §6 item 3), not wrong money.
Change: **migration `0262_t600_journal_entry_date_in_period.sql`** (0262 is free; BOSS confirmed T-593 needs none),
hand-authored per ADR-012 §5, header modelled on 0214 (task, why, lock budget, precheck):
1. `SET LOCAL lock_timeout = '5s';`
2. Pre-flight `DO $$` block: `select count(*) from journal_entries je join fiscal_periods fp on fp.id = je.period_id where
   je.entry_date not between fp.starts_on and fp.ends_on`; if > 0, `RAISE EXCEPTION '0262: % journal entries are dated
   outside their period; fix them before this migration', n;`. Same query saved read-only as `docs/ops/P0262-precheck.sql`
   for Ian to run on production as doadmin before the deploy (expect 0).
3. New function `journal_entries_check_entry_date_in_period()`: look up `starts_on, ends_on` of `NEW.period_id`; raise
   `'journal entry date % is outside fiscal period % (% to %)'` when outside. Trigger
   `journal_entries_entry_date_in_period` `BEFORE INSERT OR UPDATE OF entry_date, period_id ON journal_entries FOR EACH ROW`.
   A separate trigger, so the period-open function (0143) is not replaced a third time.
4. Journal row: `{ "idx": 262, "version": "7", "when": 1808710307084, "tag": "0262_t600_journal_entry_date_in_period", "breakpoints": true }`.
5. `packages/db/schema/journal.ts`: `// NOTE: entry_date within the period's dates is hand-added in migration 0262`.
6. Domain error wording: none needed; `postEntry` never sends a mismatch (proved by the full suite).
Risk: 107 test files insert `journal_entries` by raw SQL; any whose fixture period does not cover its date goes red. Fix
the fixture, never the trigger. Hence the FULL suite on a fresh gate DB and its own PR (memory "full suite for migrations").
Tests, new `packages/domain/tests/integration/t600-entry-date-in-period.test.ts`: raw insert dated inside its period
(positive); dated one day after `ends_on` -> rejected, message matches `/outside fiscal period/`; update an entry's
`entry_date` out of range -> rejected. **Mutant:** drop the trigger in the test transaction -> both refusals pass, red.

## DEF-903 - a repeated Foodpanda order row doubles the day

Main `foodpanda-workbook.ts:322-417`: nothing compares rows; the Order Code is read only at 324 to skip the total row.
Change in `readOrders`: a local `const seen = new Map<string, number>()` keyed on the whole row's cell texts
(`row.map(textOf).join('\u0001')`, Order Code included, kept in memory only and never output). On a repeat:
`intakeRefusal('FOODPANDA_BAD_VALUE', \`Appendix A row ${r + 1} repeats row ${first} exactly (same order, same amounts). Remove the repeated row and upload again.\`)`.
An exact-row key, not the Order Code alone: a reversal or fee row may share an order's code with different figures.
**First measure** on the four real workbooks: count Order Codes that appear more than once with different cells; report
the number in the commit (expect 0 exact repeats).
Tests, `t511-s3-audit-fixes.test.ts`: two identical `fp34Order('zz99-0001-aa')` rows -> refused naming both row numbers;
same code with a different balance (a reversal shape) -> accepted (positive); `t511-s3-foodpanda.test.ts:261` (no Order
Code in the output) stays green. **Mutant:** key on `balance` only -> the reversal test goes red.

## Census and guards (re-measure, never hand-edit)
- `tests/unit/t343-throw-ratchet.test.ts`: `packages/domain/src/commissary` 46 (line 90), `trade` 51 (131). New refusals
  use `refuse()`; if a count drops (S2 removes code), lower the pin.
- `packages/domain/tests/unit/t511-s3-source-scan.test.ts` and `t511-s4-source-scan.test.ts`: must stay green.
- `apps/erp/tests/t440-s5-stock-rules.test.ts`, `apps/erp/tests/t343-s5-1c-commissary-refusals.test.ts`: S1/S2.
- `packages/db/tests/migration-journal.test.ts`: S6.

## Out of scope
Making `transfer.ts:446` raise a discrepancy; zero-rate orders already dispatched and in transit (BOSS may run, read only:
`select count(*) from trade_order_lines l join trade_orders o on o.id = l.order_id where o.requested_by_store_id is not null
and o.status = 'dispatched' and l.rate = 0 and l.fulfilled_quantity > 0`); refusing `proposeLine` of an item already on the
order (T-536 left it); a Grab per-row day split; a DB CHECK `rate > 0`; Foodpanda Appendix C duplicates.

## Build order (one commit each; LF endings; paste each mutant's red line in the commit message)
S1 DEF-897 zero rate. S2 DEF-898 option A (R1). S3 DEF-900 merge. S4 DEF-899 + DEF-903
Foodpanda parser. S5 DEF-901 Grab warning. S6 DEF-902 migration 0262 (own PR, full suite in CI, P0262 precheck run by Ian).
Commands (worktree root; test DB must be a `_test` database, never lane-pinned):
```
npm run typecheck
npx vitest run --project integration packages/domain/tests/integration/branch-orders.test.ts packages/domain/tests/integration/commissary-transfer.test.ts packages/domain/tests/integration/t372-ready-is-final.test.ts packages/domain/tests/integration/t383-retired-item-usable.test.ts --maxWorkers=2
npx vitest run --project integration apps/erp/tests/integration/t389-s4-commissary-web.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/trade.test.ts packages/domain/tests/integration/customer-returns.test.ts --maxWorkers=2
npx vitest run --project unit packages/domain/tests/unit/t511-s3-foodpanda.test.ts packages/domain/tests/unit/t511-s3-audit-fixes.test.ts packages/domain/tests/unit/t511-s4-stage.test.ts packages/domain/tests/unit/t511-s3-source-scan.test.ts packages/domain/tests/unit/t511-s4-source-scan.test.ts --maxWorkers=2
npx vitest run --project integration packages/domain/tests/integration/t600-entry-date-in-period.test.ts packages/domain/tests/integration/period-override.test.ts --maxWorkers=2
npx vitest run --project unit tests/unit/t343-throw-ratchet.test.ts packages/db/tests/migration-journal.test.ts apps/erp/tests/t440-s5-stock-rules.test.ts apps/erp/tests/t343-s5-1c-commissary-refusals.test.ts --maxWorkers=2
```
(Check each file's project with `vitest.workspace` if a run reports "no test files"; unit tests under `apps/erp/tests/`
may sit in a different project.) Smoketest on a private port: commissary order with a ₱0 rate is refused in words.

## Rulings (BOSS, 18 Nov)
R1. DEF-898 = option A: only the commissary sets the transfer price; the branch sees the catalogue price. This restores
T-172 invariant 10 and v1 behaviour, so no new ruling from Ian is needed. Open branch orders are re-priced from the
catalogue at accept; nothing accepted or posted changes silently; BOSS runs the count query above.
R2. DEF-900: merging one item's lines into one stock withdrawal is accepted.
R3. Migration 0262 belongs to T-600 for DEF-902; T-602 takes 0263.
R4. The builder adds register rows DEF-897..DEF-903.
DEF-901 stays a warning (spec decision); DEF-902 ships as its own PR.

No open questions remain.
