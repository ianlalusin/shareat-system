# Money audit part 2 - 2026-11-18

Read-only review of `wt-plans` (main). No Node was run, nothing was executed. Scope: sales-day create/import,
commissary orders and transfers, trade returns, settlement-intake parsers and staging, the POS inbox / sale / day
close, and the DB money guards. Skipped anything already in `docs/DEFECTS-REGISTER.md` and DEF-869..893.
Counts: money-wrong 3 (2 confirmed, 1 plausible), minor 4 (1 confirmed, 3 plausible), race 0, data-leak 0.

## Findings, most severe first

### 1. money-wrong - CONFIRMED - a zero-value internal transfer line is received but never enters branch stock
- `packages/domain/src/commissary/orders.ts:149-159` and `:302-315` (branch draft line), `fulfilment.ts:196-203`
  (proposeLine), `fulfilment.ts:161-170` (fulfilLine), `orders.ts:175-186` (`resolveBranchRate`),
  `commissary/transfer.ts:445-446` (receipt).
- Defect: `normaliseRate` accepts `0` (and `0.004` rounds to `0.00`), and `resolveBranchRate` returns a manual cost of
  `0.00` as a real price (the DB CHECK is `>= 0`, 0069). Its "never a silent zero" guard only covers `null`.
  `createTradeOrder` refuses a zero line (`trade/index.ts:320-322`); these three paths do not.
- Scenario: the offering "ice" has manual cost 0.00. A branch orders 10 kg. Dispatch relieves FIFO cost into 1340. At
  receipt `lineCost` is 0, so line 446 `continue`s: no branch movement, no layer, `receivedCost` leaves it out. The
  delivery row says received, there is no short/over row, and the cost sits in 1340 for good. The goods are on the
  shelf and not in the branch's stock ledger.
- Fix: refuse `rate <= 0` or `lineTotal <= 0` in `buildBranchLine`, `fulfilLine`, `proposeLine`; make
  `resolveBranchRate` treat 0 as unpriced.

### 2. money-wrong - CONFIRMED in code, intent unclear - the BRANCH can state the transfer price
- `commissary/orders.ts:301-313` and `:465` (rate typed on the branch's draft line), form box at
  `apps/erp/src/app/commissary/orders/page.tsx:229`, `fulfilment.ts:200` (blank rate in `fulfilLine` keeps the branch's rate).
- Defect: header text says fulfilment's rate is "the commissary's three fields and nobody else's" and that after
  submit "only the ask" is the branch's. A `place_branch_order` holder at the branch can still set any rate, and
  a commissary packer who leaves the rate blank keeps it.
- Scenario: a branch cook types 0.10 on pork per kg. Receipt (transfer.ts:445-598) books branch inventory at ₱0.10 and
  posts a debit to 5175 (the "subsidy" branch of the margin leg). Commissary margin and branch cost are both wrong.
- Fix: take the rate only from `resolveBranchRate` on the branch side; keep typed rates in `fulfilLine` only.

### 3. money-wrong - PLAUSIBLE - Foodpanda Appendix B rows with a blank Category are dropped silently
- `packages/domain/src/settlement-intake/foodpanda-workbook.ts:463-464`.
- Defect: `if (category === '') continue;` skips the row even when Net Total or EWT has a figure. Appendix A refuses
  the same shape (an amount with no Order Code, lines 324-329); Appendix B does not.
- Scenario: a charge row (an adjustment or PandaGO deduction) printed with its Category cell empty. It is never
  staged, so the day's `unexplained` shows the gap but no line names the charge. If approved as is, the books never
  carry that deduction.
- Fix: refuse the row when `netTotal` or `ewt` has a value and the category is blank, as Appendix A does.

### 4. minor (blocks billing) - CONFIRMED - an external wholesale order with one item on two lines cannot be dispatched
- `packages/domain/src/trade/index.ts:669-684` (consume per line), `stock_movements_source_pair_key`
  (`db/migrations/0063_t161_stock_ledger.sql:70`), allowed by design in `0072_t175_...sql:100-112` ("an external
  sale may legitimately list the same item twice").
- Defect: only inter-entity orders refuse duplicate items (`trade/index.ts:216-229`). The external dispatch loop
  calls `consume` once per line with the same (source type, order id, item, room), so the second hits the unique
  index. The internal path guards with `repeatedItemSentence` (`commissary/transfer.ts:215`); this path does not.
- Scenario: a buyer's tiered price is entered as 2 lines of rice. Dispatch posts the AR charge, then fails on the
  second `consume` with a raw 23505, the whole dispatch rolls back, and the order can never be billed or shipped.
  `trade/returns.ts:283` and `franchise-credit.ts:99` already assume two movements per item can exist.
- Fix: call `repeatedItemSentence` before the first write, or merge same-item lines into one `consume`.

### 5. minor - PLAUSIBLE - Grab staging assigns a whole payout to ONE day without checking its rows' own dates
- `settlement-intake/stage.ts:137-222`, `grab-payouts.ts:77-92` (storeDay = payout date minus one day).
- Defect: rows' `createdOn.date` is read but never compared with `storeDay`. If a payout covers several order
  dates (a holiday batch, a delayed run), all of it is staged as one sales day.
- Scenario: a Monday payout pays Sat and Sun orders. Staged as Sunday, the file figure is about double the staff
  figure, and approval books a sales correction on Sunday that overstates it and leaves Saturday uncorrected.
- Fix: warn (or block) when the payout's row dates are not all `storeDay`.

### 6. minor - PLAUSIBLE - no DB guard ties a journal entry's `entry_date` to its period's date range
- `db/migrations/0003_journal_entries_and_lines.sql` (period-open triggers check only `status` of `period_id`).
- Defect: every current writer resolves the period from the date (`postEntry`, `opening.ts`, `opening-stock.ts`), so
  nothing is wrong today. The rule lives in TypeScript only, against RULES section 6 item 3.
- Scenario: a future script or ETL path inserts with a mismatched `period_id` and the DB accepts it.
- Fix: a BEFORE INSERT/UPDATE trigger on `journal_entries` that checks `entry_date` is within the period.

### 7. minor - PLAUSIBLE - Foodpanda duplicate order rows inside one workbook are not detected
- `foodpanda-workbook.ts:322-417` (the Order Code is never read into the output, by design).
- Defect: a repeated order row doubles `orderValue`/`balance` for its day. The identity differences only show a
  per-row mismatch, which a duplicated row satisfies.
- Scenario: an export with a pasted-twice row. The day's file figure is too high and shows as a difference vs staff.
- Fix: keep a one-way hash of the Order Code per row and refuse a repeat within a file.

## Nothing found in (read, with the reason)
- `sales-days/create.ts`, `create-block.ts`, `import.ts`: authorize first, store then day lock order, post-fetch link
  re-check, voided-date and handover rules, tenders checked against the store. The DB CHECKs on `sales_days` cover
  signs and the revenue identity. Create-vs-create races end on the unique index (a raw 23505 at worst).
- `sales-days/routing.ts`: all three identities hold, and the lines balance by construction. The short-payment debit
  goes to 7350 as POSTING-PATTERNS says.
- `pos/sale.ts`, `price.ts`, `discounts.ts`, `inbox.ts`: server re-prices from DB lines, whole-centavo bigint math, `(pairing, seq)`
  insert first so a replay is a no-op, refusals are stored quarantined, PIN and senior card data are scrubbed.
- `pos/day-close.ts`: advisory lock before reading the window, one transaction, a refusal rolls the Z back, and the
  tender plus variance identity is asserted. A second terminal's Z being refused is a documented ruling (task 531).
- `commissary/discrepancy.ts`, `trade/franchise-credit.ts`, `trade/returns.ts`: charge locked first, FOR UPDATE on the
  discrepancy, over/short gates, period checks before writes. The return lines are reversed in one entry.
- `settlement-intake/grab-*.ts`, `foodpanda-workbook.ts` (apart from 3 and 7), `prior-items.ts`, `review.ts`,
  `day-checks.ts`: exact-decimal parsing with named refusals, strict headers, 12-hour clock correct, one payout row per id.
- DB guards: every `_check/_unique/_key/_trg` name referenced in `packages/domain/src` and `packages/db/src` exists in
  a migration (script-checked by name, 3 false hits only). Journal balance, account-eligible, period-open and
  posted-immutable triggers exist (0003/0004/0005/0143). POS receipt, Z and event tables are frozen or append-only (0238/0240).

## Not read
- `sales-days/verify.ts`, `edit.ts`, `correction.ts`, `compose.ts`, `platform.ts`; `ledger/post-entry.ts` beyond its header.
- `commissary/catalogue.ts`, `messages.ts`; `trade/inter-entity-reconcile.ts`; `trade/index.ts` outside create/dispatch/receive.
- `pos/order.ts`, `usage-pull.ts`, `depletion-source.ts`, `receipt-bridge-*` (only skimmed; v1 receipt check, a float discount flagged, not posted), `v1-*`.
- `apps/erp/src/app/pos/**` screens and every API route except `api/pos/events`.
- `settlement-intake/ingest*.ts`, `approve.ts`, `store-match.ts` (excluded), `loan-check.ts`, `safe-zip.ts`, `zip-repack.ts`, `xlsx-worker*`.
- About 230 migrations: read only 0003, 0004, 0005, 0063 (index), 0072 (index), 0143, 0238 (triggers and POS CHECKs), and grepped the rest by name.
- No test files; nothing was run, so every CONFIRMED means confirmed by reading the code path, not by a failing test.
