# T-485: App-wide live business-rule checks (show the error while typing)

**Status:** RESERVED 2026-10-25. Awaiting Ian's OK on the proposal below; no spec yet.
**Asked by Ian, 2026-10-24:** "implement the same show error while typing all through the app."
Same pattern as T-475 S1 (live checks on AP invoice log/verify) and T-440 (live field checks).

## Proposal
- Wave 1 = the top 10 rules plus the shared facts they need: closed month, money-account balance, stock on hand. Starts after T-475 S1's pattern is merged.
- Privacy-sensitive lookups answer yes/no only (never return the other record's data).
- The server keeps refusing on save; live checks are a courtesy, never the only guard.

## Inventory (24 Oct)
# T-485 discovery: business-rule refusals the user learns only after Save (ERP, excluding AP invoices and expenses)

Read-only sweep of C:\Users\ianla\webapps\wt-t455 (main fb17323). Method: every action in apps/erp/src/app/**/actions.ts -> the domain function it calls ->
every refuse()/ok:false/plain-Error site in packages/domain/src (+ packages/auth/src for grants). FORMAT rules (required, number, > 0, date shape) are left to T-440 and not listed.
Counts are of DISTINCT user-visible rules per form (near-duplicates merged). Not a line-by-line audit: ~520 refuse() sites exist; this groups them into rules a page could pre-check.

Paths below are relative: `A:` = apps/erp/src/app/, `D:` = packages/domain/src/.

Columns: Live = Y (page already holds the data, or it is only form values) / L (needs a small extra lookup in the page loader or a `useLookupCheck`) / L* (lookup touches guarded or privacy-sensitive data) / S (only knowable at save: another person got there first, or state changes between page load and Save).
Size: S = one rule + one sentence move; M = rule + a loader fact + parity test; L = needs a new evaluator split (like `approvalVerdict`) or heavy facts.

Legend of recurring facts (build once, reuse everywhere):
- F-PERIOD: "is the month of this date closed/locked?" Used by ~25 rows below (marked `(period)`). One shared loader fact `periodStatusFor(date)` (journalRepo.findPeriodForDate) + one leaf check. Stock sentence: D:stock/period-guard.ts:40-46 (and `...Today` :58). Money sentence: D:ledger/post-entry.ts via postEntry.
- F-ONHAND: on-hand quantity per (item, room). Used by ~8 rows (marked `(on-hand)`).
- F-BAL: money account balance + custodian + overdraft limit. The pure `judgeDraw` already exists client-safe (D:money-accounts/draw-verdict.ts) and `MoneyLines.tsx` (expenses/AP only) already renders it. Used by ~8 rows (marked `(balance)`).

---------------------------------------------------------------------------------------------------

## 1. Inventory / stock  (INV)
| # | Screen | Action | Domain refusal | User sentence (short) | Live | Size |
|---|---|---|---|---|---|---|
| INV1 | /inventory/usage post | A:inventory/usage/actions.ts:104 | D:stock/layers.ts:108-114 | "only {n} available, {m} requested - a shortfall is refused, not absorbed" (no item/room name; quality gap) | L (on-hand) | M |
| INV2 | /inventory/usage post | A:inventory/usage/actions.ts:104 | D:stock/usage-records.ts:263-293 (usage-tolerance.ts) | usage outside the POS-plan tolerance band needs a manager reason | L (plan qty + band per item) | M |
| INV3 | /inventory/usage save/post/void | A:inventory/usage/actions.ts:71,104,175 | D:stock/usage.ts:71,212 -> period-guard.ts:40 | "{Month} is closed. Stock can't be used on {date}..." | L (period) | S |
| INV4 | /inventory/returns record supplier return | A:inventory/returns/actions.ts:26 | D:stock/supplier-returns.ts:148-155 | "only {n} is still returnable (received X, already returned Y)" (line shown by id) | L (received - returned per delivery line) | M |
| INV5 | /inventory/returns record | A:inventory/returns/actions.ts:26 | D:stock/supplier-returns.ts:97,100 | closed month for the return date / today | L (period) | S |
| INV6 | /inventory/returns void | A:inventory/returns/actions.ts:67 | D:stock/supplier-returns.ts:330-338 | "cannot void - the credit this return holds has already been spent" | L (supplier credit balance) | S |
| INV7 | /inventory/returns refund credit | A:inventory/returns/actions.ts:97 | D:stock/supplier-returns.ts:418 | "only {x} of credit is available - {y} does not fit" | L (supplier credit) | S |
| INV8 | /inventory/locations deactivate room | A:inventory/locations/actions.ts:172 | D:stock-locations/service.ts:318 | "{room} still holds stock and cannot be deactivated" (plain Error) | L (stock per room) | S |
| INV9 | /inventory/locations deactivate / set default | A:inventory/locations/actions.ts:172,156 | D:stock-locations/service.ts:325,298 | default room can't be deactivated; inactive room can't be default | Y | S |
| INV10 | /inventory/pos-map add POS item link | A:inventory/pos-map/actions.ts:23 | D:pos/depletion-source.ts:377 | ""{key}" is already linked at {store}. Remove that link first" | L | S |
| INV11 | /menu/usage-source switch source | A:menu/usage-source/actions.ts | D:pos/depletion-source.ts:326-335 | N items plan differently from menu rules; accept differences needs a reason | L (comparison; page already computes it) | M |
| INV12 | /inventory/pos-usage void pull | A:inventory/pos-usage/actions.ts:128 | D:pos/usage-pull.ts:693 | closed month | L (period) | S |
| INV13 | /inventory/production/recipes create/edit | A:inventory/production/recipes/actions.ts:50,59 | D:production/recipe-shape.ts:52-53 | recipe's own output can't be an ingredient; ingredient listed twice | Y | S |
Area total: **13**

## 2. Counts  (CNT)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| CNT1 | /inventory/counts open session | A:inventory/counts/actions.ts:68 | D:stock/count-workflow.ts:70-80 | "room(s) not active in this store: {ids}"; a room already frozen by another count throws (raw) | L (rooms in open sessions) | S |
| CNT2 | /inventory/counts/[id] record line | A:inventory/counts/actions.ts:94 | D:stock/count-workflow.ts:127-132 | "count session is {status} - counting is closed"; room not in session | S (race) / Y | S |
| CNT3 | /inventory/counts/[id] advance to review | A:inventory/counts/actions.ts:124 | D:stock/count-workflow.ts:169 | "is open, not counting - count at least one line first" | Y | S |
| CNT4 | /inventory/counts/[id] commit | A:inventory/counts/actions.ts:143 | D:stock/count-workflow.ts:217-232 | "N item(s) with stock in a frozen room were never counted - {code in room}, ..." | L (expected items per room) | M |
| CNT5 | /inventory/counts/[id] commit | A:inventory/counts/actions.ts:143 | D:stock/count-sessions.ts:98-110 | counted long with no cost basis: "Record a delivery first" | L (cost basis per item) | M |
| CNT6 | /inventory/counts/[id] commit | A:inventory/counts/actions.ts:143 | D:stock/count-workflow.ts:229-235 | item kind has no inventory account (COA-ALIGNMENT, raw jargon) | L | S |
Area total: **6**

## 3. Transfers  (TRF)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| TRF1 | /inventory/transfers create | A:inventory/transfers/actions.ts:33 | D:stock/transfer-rules.ts:26,29,40-45 | same room both ends; no lines; "item {uuid} appears on more than one line" (raw id) | Y | S |
| TRF2 | /inventory/transfers dispatch | A:inventory/transfers/actions.ts:64 | D:stock/transfers.ts:70-76 | "only {n} of item {uuid} is on hand at the source location - cannot move {q}" (raw id) | L (on-hand) | M |
| TRF3 | /inventory/transfers create/dispatch/receive/void | A:inventory/transfers/actions.ts:33,64,72,80 | D:stock/transfers.ts:97,193,244,296 | closed month | L (period) | S |
| TRF4 | /inventory/transfers dispatch/receive/void | A:inventory/transfers/actions.ts:64,72,80 | D:stock/transfers.ts:188,239,288 | "is {status}, not draft / not in transit / already void" | S (race) | S |
| TRF5 | /inventory/transfers dispatch/receive | A:inventory/transfers/actions.ts:64,72 | D:stock/transfers.ts:8 (header) -> freeze trigger (DB) | a room frozen by a count refuses both legs | L (rooms in open counts) | M |
Area total: **5**

## 4. Deliveries  (DLV)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| DLV1 | /inventory/deliveries create | A:inventory/deliveries/actions.ts:112 | D:deliveries/documents.ts:222 | "Line n names {item}, which is {inactive/merged}" | Y (picker already lists usable) | S |
| DLV2 | /inventory/deliveries create | A:inventory/deliveries/actions.ts:112 | D:deliveries/documents.ts:152 | proof photo not found in this org | S | S |
| DLV3 | /inventory/deliveries/[id] receive | A:inventory/deliveries/actions.ts:190 | D:deliveries/documents.ts:328,340 | delivery is {status}, not draft; item became inactive | S (race) | S |
| DLV4 | /inventory/deliveries/[id] receive | A:inventory/deliveries/actions.ts:190 | D:deliveries/receive.ts:87 | closed month | L (period) | S |
| DLV5 | /inventory/deliveries/[id] receive | A:inventory/deliveries/actions.ts:190 | D:deliveries/receive.ts:106 | "Line n has no location, and the store has no Receiving, default, or active room" | L (store rooms) | S |
| DLV6 | /inventory/deliveries/[id] receive | A:inventory/deliveries/actions.ts:190 | D:deliveries/receive.ts:123 | item's kind has no inventory account; ask an admin | L | S |
| DLV7 | /inventory/deliveries/[id] receive | A:inventory/deliveries/actions.ts:190 | D:deliveries/receive.ts:182; documents.ts:351 | every line received as zero; a line was not answered | Y | S |
Area total: **7**

## 5. Wastage  (WST)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| WST1 | /wastage record | A:wastage/actions.ts:71 | D:wastage/orders.ts:286 | opened-on date is not the sales day's date | Y (page has the day) | S |
| WST2 | /wastage record | A:wastage/actions.ts:71 | D:wastage/orders.ts:299-310 | "no '{channel}' channel is configured for this store" / "no longer active" (plain Error, raw) | L (store channels) | S |
| WST3 | /wastage record | A:wastage/actions.ts:71 | D:wastage/orders.ts:316-327 | instant channel needs a disposition; tracked channel takes none | L (channel policy) | S |
| WST4 | /wastage record | A:wastage/actions.ts:71 | D:sales-days/live-day.ts:29 | sales day voided, wastage can't be recorded against it | L | S |
| WST5 | /wastage/[id] resolve | A:wastage/actions.ts:135 | D:wastage/orders.ts:186-192 | charged disposition needs an allocation / a person account nothing can draw | Y | S |
| WST6 | /wastage/[id] reverse/confirm | A:wastage/actions.ts:167,193 | D:wastage/orders.ts:609 note (postEntry) | closed month | L (period) | S |
Area total: **6**

## 6. Production / commissary  (PRD)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| PRD1 | /inventory/production save draft | A:inventory/production/actions.ts:57 | D:production/index.ts:127,147-153 | a cook needs a recipe; recipe not active; ingredients come from the recipe | Y | S |
| PRD2 | /inventory/production save/post | A:inventory/production/actions.ts:57,105 | D:production/index.ts:183 (sliceCategoryRefusal) | slice inputs/outputs not the allowed categories | Y/L (item categories) | M |
| PRD3 | /inventory/production post | A:inventory/production/actions.ts:105 | D:production/index.ts:727 + stock/layers.ts:108 | ingredient short (cook/slice inputs) | L (on-hand) | M |
| PRD4 | /inventory/production post/edit/void | A:inventory/production/actions.ts:105,123,145 | D:production/index.ts:710,779,960 | closed month | L (period) | S |
| PRD5 | /inventory/production cook | A:inventory/production/actions.ts:57,105 | D:production/index.ts:222,234 | "cannot be converted to {unit}"; "comes to less than 0.001 - make a larger batch" | Y (recipe preview) | M |
| PRD6 | /inventory/production/[id] edit posted | A:inventory/production/actions.ts:123 | D:production/index.ts:927 | "only {n} of this output remains on hand - the rest has already moved" | L (layer remaining) | M |
| PRD7 | /inventory/production/[id] edit/void | A:inventory/production/actions.ts:123,145 | D:production/index.ts:717,790,969 | "a live slicer payment covers this date - editing/voiding it would leave labour expensed" | L (slicer payment on date) | S |
| PRD8 | /commissary/orders new + /[id] add line | A:commissary/orders/actions.ts:28; A:commissary/orders/[id]/actions.ts:151 | D:commissary/orders.ts:293,296 | item not active; item not in the commissary's catalogue | Y/L (offerings) | S |
| PRD9 | /commissary/orders/[id] edit after ready | A:commissary/orders/[id]/actions.ts:164-345 | D:commissary/orders.ts:122 | "ready is final" (DEF-511) | Y (stage) | S |
| PRD10 | /commissary/orders/[id] propose/fulfil/ready | A:commissary/orders/[id]/actions.ts:307,321,337 | D:commissary/fulfilment.ts:152-156,205,217,283-293 | line declined; item already on order; can't be priced; proposed lines await branch; all lines zero (plain Errors) | Y | S |
| PRD11 | /commissary/orders/[id] receive | A:commissary/orders/[id]/actions.ts:233 | D:trade/index.ts:939,997 | closed month; negative received quantity | L (period) / Y | S |
| PRD12 | /commissary/catalogue links/offerings/maps | A:commissary/catalogue/actions.ts:26,50,71 | D:commissary/catalogue.ts:131,207-217,306-340 | store can't supply itself; item inactive/not purchasable; no active link; units differ | Y/L | S |
| PRD13 | /commissary/discrepancies resolve | A:commissary/discrepancies/actions.ts:26 | D:commissary/discrepancy.ts:92-176 | closed month; reversal would take the branch below what it holds | L (period, on-hand) | M |
Area total: **13**

## 7. Trade orders  (TRD)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| TRD1 | /trade/orders new | A:trade/orders/actions.ts:40 | D:trade/index.ts:247 | "Line n names {item}, which is inactive" | Y | S |
| TRD2 | /trade/orders/[id] dispatch (credit sale) | A:trade/orders/actions.ts:79 | D:ar/index.ts:79-91 | "{customer} owes P{x}; this charge is P{y}, taking them to P{z} against a limit of P{w}. A manager can charge it anyway by saying why" | L (customer owed + limit; customers page already computes it; needs `can(override_credit_limit)`) | M |
| TRD3 | /trade/orders/[id] dispatch | A:trade/orders/actions.ts:79 | D:stock/layers.ts:108 via dispatch (trade/index.ts ~486-520) | not enough stock to dispatch | L (on-hand) | M |
| TRD4 | /trade/orders/[id] dispatch | A:trade/orders/actions.ts:79 | D:trade/index.ts:486 | closed month | L (period) | S |
| TRD5 | /trade/orders/[id] dispatch | A:trade/orders/actions.ts:79 | D:trade/index.ts:460,512 | pay-now on an already dispatched order / on a branch transfer | Y | S |
| TRD6 | /trade/orders/[id] dispatch branch order | A:trade/orders/actions.ts:79 | D:trade/index.ts:487+ (T-172) | a branch order goes out READY or not at all | Y | S |
| TRD7 | /trade/orders/[id] receive | A:trade/orders/actions.ts:161 | D:trade/index.ts:939,997 | closed month; "a received quantity cannot be negative" | L (period) | S |
| TRD8 | /trade/orders/[id] void | A:trade/orders/actions.ts:217 | D:trade/index.ts:788-790 | closed month (today / order date) | L (period) | S |
| TRD9 | /trade/orders/[id] BIR invoice no. | A:trade/orders/actions.ts:145 | D:trade/index.ts:1123,1139 | "Invoice no. {n} is already on order {ref}" | L* (org-wide invoice-number lookup; return only the order ref) | M |
| TRD10 | /trade/orders/[id] BIR invoice no. | A:trade/orders/actions.ts:145 | D:trade/index.ts:1105 | only on a sale that has been dispatched | Y | S |
| TRD11 | /trade/returns record | A:trade/returns/actions.ts:34 | D:trade/returns.ts:183,191-202,220 | closed month; order not shipped / transfer not received; "only {n} of this line is left to return" | L (period, returnable per line) | M |
| TRD12 | /trade/returns record cash refund | A:trade/returns/actions.ts:34 | D:trade/returns.ts:322 | a cash refund needs a money account (also account balance, see CSH) | Y | S |
Area total: **12**

## 8. AR / customers / collections  (CUS)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| CUS1 | /customers new | A:customers/actions.ts:40 | D:customers/index.ts:58-72 | a customer is a store of ours OR another company, never both; "that is this organisation" | Y | S |
| CUS2 | /customers/[id] reconcile | A:customers/actions.ts:78 | D:customers/index.ts:157 | "this customer owes P{x}; an anchor says verified at ZERO" | Y (page knows balance) | S |
| CUS3 | /customers/[id] charge with pay-now | A:customers/actions.ts:126-167 | D:ar/index.ts:257-271 | paid now more than the charge; account at another store | Y | S |
| CUS4 | /customers/[id] record collection | A:customers/actions.ts:167 | D:ar/index.ts:477-479 | store credit applied > credit held; collecting into another store's account needs a right | L (credit balance; `can`) | M |
| CUS5 | /customers/[id] void charge | A:customers/actions.ts:263 | D:ar/index.ts:373 | "This charge has payments against it. Void the payment first." | Y (page lists payments) | S |
| CUS6 | /customers/price-lists/[id] set price | A:customers/actions.ts:337 | D:customers/index.ts:225-247 | item inactive; item not wholesale-sellable; negative rate | Y/L (item flags in picker) | S |
Area total: **6**

## 9. Cash requests / floats / money transfers  (CSH)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| CSH1 | /cash-requests/[id] release | A:cash-requests/actions.ts:85 | D:cash-requests/index.ts:234-240 + D:money-accounts/overdraft.ts (checkDraw) | released more than approved; "account can't cover it" | L (approved amount, balance; judgeDraw is client-safe) | M |
| CSH2 | /cash-requests/[id] settle | A:cash-requests/actions.ts:108 | D:cash-requests/index.ts:422 | "Only {x} is still held on this cash request" | Y | S |
| CSH3 | /cash-requests/[id] settle | A:cash-requests/actions.ts:108 | D:cash-requests/index.ts:388 | already settled/cancelled | S (race) | S |
| CSH4 | /money-transfers new | A:money-transfers/actions.ts:30 | D:money-transfers/prepare.ts:66,31 | source = destination; retired account (plain Error) | Y | S |
| CSH5 | /money-transfers new | A:money-transfers/actions.ts:30 | D:money-transfers/prepare.ts:88 | "money moves between stores office to office only" (plain Error) | Y (custodian + store per account) | S |
| CSH6 | /money-transfers new | A:money-transfers/actions.ts:30 | D:money-transfers/prepare.ts:125 | "arrived P{a} but only P{b} left - that is income, not a transfer" | Y | S |
| CSH7 | /money-transfers new | A:money-transfers/actions.ts:30 | D:money-transfers/index.ts (checkDraw) | source account can't cover it (overdraft rule) | L (balance) | M |
| CSH8 | /money-transfers settle between stores | A:money-transfers/actions.ts:78 | D:money-transfers/settle.ts:153-176 | records don't match; owe each other nothing; wrong direction; more than the debt | L (inter-store due-to/due-from) | M |
| CSH9 | /money-transfers settle | A:money-transfers/actions.ts:78 | D:money-transfers/settle.ts:103 | both accounts belong to one store | Y | S |
| CSH10 | /money-transfers void | A:money-transfers/actions.ts:114 | D:money-transfers/index.ts:194 | already voided | S (race) | S |
| CSH11 | /till open/close/charge shortage | A:till/actions.ts:61,112,132 | D:till/index.ts:67-91,139-154 | handover can't cross stores; shift doesn't exist (plain Errors) | Y/S | S |
| CSH12 | /money-accounts retire/rename | A:money-accounts/actions.ts:51,69 | D:money-accounts/index.ts:253 (overdraft sign), :320 (setTillFloat: not exactly one drawer) | store has N cashier cash accounts | L | S |
Area total: **12**

## 10. Sales days (incl. remittance and channel settlements)  (SLD)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| SLD1 | /sales-days/new | A:sales-days/actions.ts:98 | D:sales-days/create.ts:102 | "This store already has a sales day for {date} ({status}). Edit that one" | L (existing days of the store) | S |
| SLD2 | /sales-days/new | A:sales-days/actions.ts:98 | D:sales-days/create-block.ts:100 | date was withdrawn earlier; only a manager can re-enter | L* (voided dates + `can(void_sales_day)`) | S |
| SLD3 | /sales-days/new | A:sales-days/actions.ts:98 | D:sales-days/create-block.ts:107 | "Cash handed over has been counted against this date" | L | S |
| SLD4 | /sales-days/new | A:sales-days/actions.ts:98 | D:sales-days/create-block.ts:176 | "{store} takes its sales from POS. Import the day instead." | Y (store has POS link) | S |
| SLD5 | /sales-days/new, /[id] edit | A:sales-days/actions.ts:98,220 | D:sales-days/create.ts:174-256 | channel not set up for store; "no sales" with an amount; tender listed twice; wallet not this store's | Y | S |
| SLD6 | /sales-days/[id] import | A:sales-days/actions.ts:126,203 | D:sales-days/import.ts:128-188 | already verified; typed before link; no POS link; POS unreachable | Y/L | S |
| SLD7 | /sales-days import/correct | A:sales-days/actions.ts:126,180 | D:sales-days/import.ts:257; correction.ts:161 | "{tender}'s money account is no longer active" | L | M |
| SLD8 | /sales-days/[id] edit | A:sales-days/actions.ts:220 | D:sales-days/edit.ts:48 | only an unverified day can be edited | Y | S |
| SLD9 | /sales-days/[id] submit | A:sales-days/actions.ts:234 | D:sales-days/verify.ts:50 | only an open day can be submitted | Y | S |
| SLD10 | /sales-days/[id] verify | A:sales-days/actions.ts:246 | D:sales-days/verify.ts:116 | "You submitted this day, so someone else has to verify it" (twin of T-475 V1; T-385 `verify_own_sales_day` exists) | Y (+`can`) | S |
| SLD11 | /sales-days/[id] verify | A:sales-days/actions.ts:246 | D:sales-days/verify.ts:133 | "This sales day can't be posted yet: {routing reason}" | L (routing verdict; needs a split like `approvalVerdict`) | L |
| SLD12 | /sales-days/[id] void | A:sales-days/actions.ts:258 | D:sales-days/verify.ts:224-241 | day has a POS usage pull / wastage / remittance counted against it | L | M |
| SLD13 | /sales-days/[id] POS correction | A:sales-days/actions.ts:180 | D:sales-days/correction.ts:67-223 | not a verified POS day; feed not newer; unchanged; entry date before business date | L | M |
| SLD14 | /sales-days/[id] platform sales | A:sales-days/actions.ts:287 | D:sales-days/platform.ts:42-68 | verified day; typed day; channel paid at the till | Y | S |
| SLD15 | /remittance new | A:remittance/actions.ts:61 | D:remittance/index.ts:218 | "P{x} handed over exceeds what the verified days owe" | L (owed per float store; page may hold it) | M |
| SLD16 | /remittance variance resolve | A:remittance/actions.ts:213 | D:remittance/index.ts:574-748 | only a shortage can be charged / overage is income; needs a person; date before remittance; wrong account; nothing left to charge | Y/L | M |
| SLD17 | /remittance reverse | A:remittance/actions.ts:193 | D:remittance/index.ts:468 | already reversed | S (race) | S |
| SLD18 | /channel-settlements record | A:channel-settlements/actions.ts:111 | D:channel-settlements/index.ts:521 | "Choose the day this payout settles" (clears one verified channel-day) | Y | S |
| SLD19 | /channel-settlements payout destination | A:channel-settlements/actions.ts:197 | D:channel-settlements/index.ts:773-783 | account belongs to another store / retired | Y | S |
Area total: **19**

## 11. Payroll / leave / attendance  (PAY)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| PAY1 | /payroll preview/post run | A:payroll/actions.ts:46 | D:payroll/index.ts:468,479,489 | "no {SSS/PhilHealth/Pag-IBIG} rate / withholding table / minimum wage in force on {date}" | L (rate coverage for period) | M |
| PAY2 | /payroll post run | A:payroll/actions.ts:46 | D:payroll/index.ts:656 | "These payroll tables are not confirmed yet" | L | S |
| PAY3 | /payroll post run | A:payroll/actions.ts:46 | D:leave/payroll.ts:84,172 | hourly rate has no leave-pay path; SIL payout already taken by another run | L / S | S |
| PAY4 | /payroll/rates add rate/bracket/wage | A:payroll/rates/actions.ts:34,96,130 | D:payroll/rates.ts:31,193 | "a payroll period up to {date} is already paid, pick a later date"; confirmed table is closed | L (latest paid period) | S |
| PAY5 | /payroll/rates confirm/discard | A:payroll/rates/actions.ts:62,73,159,175 | D:payroll/rates.ts:121,145,305,329 | already confirmed; confirmed rates can't be discarded | Y | S |
| PAY6 | /payroll/thirteenth-month post | A:payroll/thirteenth-month/actions.ts:22 | D:payroll/thirteenth-month.ts:105 | "{name}'s 13th month would be over the P90,000 tax-exempt limit" | L (per-person YTD) | M |
| PAY7 | /payroll/separations post | A:payroll/separations/actions.ts:25 | D:payroll/separation.ts:58,114-155 | already has a posted separation; clearance not confirmed; account at another store (plain Errors) | Y/L | S |
| PAY8 | /attendance/leave request/record | A:attendance/leave/actions.ts:61,71 | D:leave/requests.ts:133 | "You cannot record your own leave" | Y | S |
| PAY9 | /attendance/leave request/record | A:attendance/leave/actions.ts:61,71 | D:leave/requests.ts:147-172 | date outside the job; future date as a record; "already has leave on {dates}" | L (employment dates, existing leave) | M |
| PAY10 | /attendance/leave request/record | A:attendance/leave/actions.ts:61,71 | D:leave/checks.ts:80-110 | monthly / yearly cap reached | L (days used) | M |
| PAY11 | /attendance/leave request/record | A:attendance/leave/actions.ts:61,71 | D:leave/checks.ts:119-136 | birth date required; deliveries/days per birth limit | L | M |
| PAY12 | /attendance/leave request/record | A:attendance/leave/actions.ts:61,71 | D:leave/checks.ts:166-186 | Service Incentive Leave: before 1st anniversary / balance exhausted / year paid out | L* (service record, entitlement) | M |
| PAY13 | /attendance/leave request/record | A:attendance/leave/actions.ts:61,71 | D:leave/checks.ts:223,235 | "attendance on {dates}, cannot be leave"; "pay run already posted for {dates}" | L | M |
| PAY14 | /attendance/leave approve/reject/cancel | A:attendance/leave/actions.ts:81,91,101 | D:leave/requests.ts:321-417 | no longer pending; cannot approve your own leave | S (race) / Y | S |
| PAY15 | /attendance/leave void | A:attendance/leave/actions.ts:111 | D:leave/requests.ts:454 | "A pay run has already paid one of these leave days" | L | S |
| PAY16 | /settings/attendance leave cap / type | A:settings/attendance/actions.ts:121,140 | D:leave/requests.ts:519,560 | cap below the legal floor; leave code already exists | Y / L | S |
| PAY17 | /settings/attendance new policy | A:settings/attendance/actions.ts:34 | D:attendance/config.ts:122-133,147-154 | must take effect after the current policy; attendance already computed; semi-monthly payout days | L (live policy, computed-through date) | M |
| PAY18 | /attendance/[dayId] verify/void/approve | A:attendance/[dayId]/actions.ts:78-132 | D:attendance/adjudicate.ts:122 | "frozen by pay run {id}" | Y | S |
Area total: **18**

## 12. Staff / positions / grants  (STF)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| STF1 | /staff/hire | A:staff/actions.ts:102 | D:people/index.ts:101 | "This person already has an open employment at this store ({staff code}). End it first" | L* (person search is store-scoped on purpose, index.ts:318; return a yes/no, not the code, unless viewer may see it) | M |
| STF2 | /staff/hire | A:staff/actions.ts:102 | D:people/index.ts:93 | cannot hire as an ended status | Y | S |
| STF3 | /staff/hire, /staff/[id] positions | A:staff/actions.ts:102,177 | D:people/index.ts:560-589 | managers use their role; position of another store; primary not in list | Y | S |
| STF4 | /staff/[id] end employment | A:staff/actions.ts:198 | D:people/index.ts:365-372 | needs an ended status; end date before start date | Y/L (start date) | S |
| STF5 | /staff store position add | A:staff/actions.ts:346 | D:people/index.ts:489 | name is a canonical position, assign it instead | L | S |
| STF6 | /staff/[id] photo / signature | A:staff/actions.ts:406-447 | D:people/staff-media.ts:54,72 | staff may not change their own photo; employment ended | Y | S |
| STF7 | /staff/[id]/credentials enrol | A:staff/[employmentId]/credentials/actions.ts:28,48 | D:attendance/credentials.ts:173,250,331 | prerequisite refusals (store not ready, ended employment) | L | S |
| STF8 | /admin/users grant capability | A:admin/users/actions.ts:146 | auth: packages/auth/src/roles.ts:615,651 | unknown permission; position grant not active | S (race) | S |
| STF9 | /admin/users unlink / reset PIN cap | A:admin/users/actions.ts:299,343 | auth: packages/auth/src/credentials-admin.ts:209,232,344 | needs a reason; not linked; "Another administrator must clear this" | Y (+viewer = subject) | S |
| STF10 | /admin/access-defaults | A:admin/access-defaults/actions.ts:80-220 | D:people/position-defaults.ts:159,322-341,400 | capability can't be defaulted to a position; position of another store | Y (UI offers only offerable) | S |
Area total: **10**

## 13. Items / menu  (ITM)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| ITM1 | /items new, rename | A:items/actions.ts:129,257 | D:items/index.ts:75 | item name already in use (names the existing item) | L (name lookup; item names are not guarded) | M |
| ITM2 | /items set variant-of | A:items/actions.ts:376 | D:items/index.ts:90-108,1066 | parent merged / different kind / item has variations | Y/L | S |
| ITM3 | /items change unit | A:items/actions.ts:236 | D:items/index.ts:194-234 | unit change refused once stock/history exists | L | M |
| ITM4 | /items retire | A:items/actions.ts:289 | D:items/index.ts:390 | "A store that reads its stock usage from the menu still uses this item" | L (menu rules naming item) | M |
| ITM5 | /items request item | A:items/actions.ts:86 | D:items/index.ts:841 | an open request for this already exists | L | S |
| ITM6 | /items merge | A:items/actions.ts:428 | D:items/index.ts:1029 | loser has variations | Y | S |
| ITM7 | /items pricing | A:items/actions.ts | D:items/index.ts:1249,1285 | inactive item can't be priced; mode needs its own number | Y | S |
| ITM8 | /items code | A:items/actions.ts:348 | D:items/code-allocation.ts:23-49 | no stem / code shape / sequence taken | L | S |
| ITM9 | /menu create category/item/variant/option | A:menu/actions.ts:23,39,76; A:menu/items/[id]/actions.ts:41,76 | D:menu/catalog.ts:36,67,137,211,250,281 | "There is already a category/item/variant called X" | Y (names already on the page) | S |
| ITM10 | /menu/prices set price | A:menu/prices/actions.ts:32,105 | D:menu/shared.ts:107,150,156 | never back-dated; a row exists at that instant; a later row already scheduled | L (price schedule for the key) | M |
| ITM11 | /menu/items/[id] option group | A:menu/items/[id]/actions.ts:120,155 | D:menu/options.ts:32-38 | max below min; pick-one group allows exactly one | Y | S |
| ITM12 | /menu/items/[id] usage rule | A:menu/items/[id]/actions.ts:89 | D:menu/pricing.ts:48-59; menu/shared.ts:173-179 | rule shape; stock item or recipe no longer active | Y | S |
| ITM13 | /menu/items/[id] offers / price rules | A:menu/items/[id]/actions.ts:263; A:menu/prices/actions.ts | D:menu/pricing.ts:142-188 | rule only for online; refill carries no price; bundle fields go together | Y | S |
| ITM14 | /menu/items/[id] reactivate / refill | A:menu/items/[id]/actions.ts:41 | D:menu/catalog.ts:119,217 | refill never sold alone; no active default variant | Y | S |
| ITM15 | /menu/requests | A:menu/requests/actions.ts:80-116 | D:menu/requests.ts:60,75,120 | already decided; only requester withdraws; reject needs a reason | Y | S |
Area total: **15**

## 14. Settings / fiscal periods / close  (SET)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| SET1 | /findings close period | A:findings/actions.ts:49 | D:fiscal-periods/index.ts:101 | "{dates} is missing from the books. Periods close in order" | L (period list) | M |
| SET2 | /findings close period | A:findings/actions.ts:49 | D:fiscal-periods/index.ts:147-149 | cannot close: usage not settled / blocking findings listed | L (blockers; there is a listing already) | L |
| SET3 | /findings acknowledge | A:findings/actions.ts:21 | D:findings/index.ts:319 | "is not currently a finding" (plain Error) | S | S |
| SET4 | /settings/sales-channels deactivate/edit | A:settings/sales-channels/actions.ts:78,102 | D:sales-channels/index.ts:189 | channel is named by a POS link: stay remitted daily and active | L | S |
| SET5 | /settings/pos-link tenders | A:settings/pos-link/actions.ts:104,127 | D:pos/tenders.ts:61-103 | wallet not this store's / retired / a cash drawer; POS name held by another tender; tender name exists | L | M |
| SET6 | /settings/pos-link link | A:settings/pos-link/actions.ts:39 | D:pos/store-link.ts:67-110 | channel not remitted daily/retired; POS store linked elsewhere; unverified typed days exist | L | M |
| SET7 | /settings/pos-link unlink | A:settings/pos-link/actions.ts:195 | D:pos/store-link.ts:219 | N unverified imported days | L | S |
| SET8 | /settings/pos-tablet pair | A:settings/pos-tablet/actions.ts:34 | D:pos/terminal-link.ts:51,60,83 | no live POS link; not a terminal of this store; tablet already registered | L | S |
| SET9 | /settings/expense-categories | A:settings/expense-categories/actions.ts:29,62,83 | D:expenses/categories.ts:61-72,202,247 | no such account; header account; inactive; name exists; seeded name fixed | Y/L (chart of accounts) | S |
| SET10 | /admin/stores opening date | A:admin/stores/actions.ts:206 | D:stores/service.ts:328 | "has traded since {date}; opening date must be on or before" | L (first trading date) | S |
| SET11 | /admin/stores stock model | A:admin/stores/actions.ts:172 | D:stores/service.ts:448 | "cannot become single-room while it holds more than one room" | L (rooms) | S |
| SET12 | /settings/wastage-monitor | A:settings/wastage-monitor/actions.ts:25 | D:stores/service.ts:510 | person no longer active | Y | S |
| SET13 | /setup first run | A:setup/actions.ts:56 | D:organizations/index.ts:150,165 | organization code already exists (plain Error) | S | S |
Area total: **13**

## 15. Cutover  (CUT)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| CUT1 | /cutover/opening add figure | A:cutover/actions.ts:88 | D:cutover/opening.ts:81-111 | 1590 / 3900 / 2120 / 1340 / generated accounts cannot be opened by a figure | Y (account code) | S |
| CUT2 | /cutover/opening add figure | A:cutover/actions.ts:88 | D:cutover/opening.ts:123 | no fiscal period covers the date | L | S |
| CUT3 | /cutover/opening remove | A:cutover/actions.ts:112 | D:cutover/opening.ts:223 | already posted; books are open | Y | S |
| CUT4 | /cutover/opening post | A:cutover/actions.ts:137 | D:cutover/opening.ts:260-302 | nothing to post; equity residual; debits != credits; party step not attested; party lines changed | L (preview of ties) | L |
| CUT5 | /cutover/count record | A:cutover/actions.ts:58 | D:cutover/index.ts:270-303 | books already opened; cost needs a source; room not this store's / inactive; no default room | Y/L | M |
| CUT6 | /cutover value opening stock | A:cutover/actions.ts:156 | D:cutover/opening-stock.ts:162-247 | purge not run; two costs for one item; counted items without cost; no period | L | M |
| CUT7 | /cutover value opening asset | A:cutover/actions.ts:170 | D:cutover/opening-assets.ts:39-75 | purge not recorded; not pending valuation; salvage not below book | Y | S |
| CUT8 | /cutover attest step | A:cutover/actions.ts:35 | D:cutover/index.ts:202-213 | a verified step cannot be ticked; per-store step | Y | S |
Area total: **8**

## 16. Fixed assets  (FAS)
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| FAS1 | /fixed-assets/new | A:fixed-assets/actions.ts:52 | D:fixed-assets/capitalize.ts:98,145-152 | store is deactivated; useful life over the maximum | Y | S |
| FAS2 | /fixed-assets/[id] terms | A:fixed-assets/actions.ts:105 | D:fixed-assets/terms.ts:72-96 | salvage not below cost; depreciation already posted, terms locked | Y/L | S |
| FAS3 | /fixed-assets/[id] in service | A:fixed-assets/actions.ts:137 | D:fixed-assets/in-service.ts:142 | "What this would reverse has changed since you confirmed" | S | S |
Area total: **3**

## 17. Other money-out screens (loans, liabilities, owners, prepaid, service charge)  (OTH)
Not in Ian's list of areas; found by the sweep, same rule families.
| # | Screen | Action | Domain refusal | User sentence | Live | Size |
|---|---|---|---|---|---|---|
| OTH1 | /loans disburse / pay | A:loans/actions.ts:61,79 | D:loans/index.ts (checkDraw import :15) | account can't cover it | L (balance) | M |
| OTH2 | /liabilities charge/pay | A:liabilities/actions.ts:54,75 | D:liabilities/index.ts:94 + checkDraw :19 | obligation retired; account can't cover | L (balance) | M |
| OTH3 | /liabilities/[id] reverse | A:liabilities/actions.ts:101 | D:liabilities/index.ts:273-282 | entry is not a charge/payment of this obligation; retired | Y | S |
| OTH4 | /owners/[id] drawing / settle | A:owners/actions.ts:77,99 | D:owners/index.ts (judgeDraw import) | over the owner's drawing limit / account can't cover | L (balance, limit) | M |
| OTH5 | /prepaid/[id] write off | A:prepaid/actions.ts:127 | D:prepaid/index.ts:453-470 | refund more than the unused amount; refund account missing | Y | S |
| OTH6 | /service-charge distribute | A:service-charge/actions.ts:24 | D:service-charge/index.ts:76-94 | "{store}'s service charge float only holds P{x}"; staff float; other store's account (plain Errors) | L (float balance) | S |
Area total: **6**

## 18. AP / expenses adjacent (listed for the T-475 boundary; NOT counted in totals)
| # | Screen | Action | Domain refusal | Note |
|---|---|---|---|---|
| ADJ1 | /expenses/reimbursements pay | A:expenses/reimbursements/actions.ts:29 | D:expenses/reimbursement.ts:96,156-182 | staff float can't fund; period locked/closed; "{amount} is more than the {owed} owed" |
| ADJ2 | /expenses/[id] void | A:expenses/actions.ts | D:expenses/void.ts:86,120 | allocated to a posted AP payment; cash request not released |
| ADJ3 | /expenses/[id] delete draft | A:expenses/actions.ts | D:expenses/delete.ts:52 | only a draft |
| ADJ4 | /expenses/recurring create | A:expenses/recurring/actions.ts:28 | D:recurring-expenses/index.ts:173-180 | start date before store opening date / no opening date |
Ask Ian/T-475 owner whether ADJ1-4 are "expenses" for exclusion purposes.

---------------------------------------------------------------------------------------------------
## Totals (distinct rules, T-475 areas excluded)
| Area | Rules | Live=Y | Needs lookup (L/L*) | Save-only (S) | Sizes S/M/L |
|---|---|---|---|---|---|
| Inventory / stock | 13 | 2 | 11 | 0 | 8/5/0 |
| Counts | 6 | 1 | 4 | 1 | 4/2/0 |
| Transfers | 5 | 1 | 3 | 1 | 3/2/0 |
| Deliveries | 7 | 2 | 4 | 1 | 7/0/0 |
| Wastage | 6 | 2 | 4 | 0 | 6/0/0 |
| Production / commissary | 13 | 7 | 6 | 0 | 8/5/0 |
| Trade orders | 12 | 5 | 7 | 0 | 8/4/0 |
| AR / customers | 6 | 5 | 1 | 0 | 5/1/0 |
| Cash requests / floats / money transfers | 12 | 6 | 4 | 2 | 8/4/0 |
| Sales days (+ remittance, channel settlements) | 19 | 9 | 9 | 1 | 11/7/1 |
| Payroll / leave / attendance | 18 | 4 | 12 | 2 | 8/10/0 |
| Staff / positions / grants | 10 | 7 | 3 | 0 | 9/1/0 |
| Items / menu | 15 | 9 | 6 | 0 | 11/4/0 |
| Settings / fiscal periods / close | 13 | 1 | 10 | 2 | 8/3/1 |
| Cutover | 8 | 4 | 4 | 0 | 5/2/1 |
| Fixed assets | 3 | 2 | 0 | 1 | 3/0/0 |
| Other money-out | 6 | 2 | 4 | 0 | 3/3/0 |
| **TOTAL** | **172** | **69** | **92** | **11** | **~123/53/3** |
(Live/lookup/save split is approximate where a row says "Y/L"; counted as the cheaper reading.)

Roughly 40% of rules need no new data (just form values or what the page already holds), ~55% need a small lookup, ~6% are save-only races.
The cheapest broad wins are the three shared facts, not the 172 rules one at a time:
F-PERIOD (closed month) alone appears in ~25 rows; F-BAL (`judgeDraw`, already client-safe) in ~8; F-ONHAND in ~8.

## Top 10 most-hit refusals (JUDGEMENT: from how central the screen is and how easy the mistake is; production counts are not reachable from here)
1. Closed month on any stock/money posting (INV3, TRF3, DLV4, TRD4/8, PRD4, WST6 ...) - every posting screen, shared fact F-PERIOD.
2. Not enough stock: usage post INV1, transfer dispatch TRF2, trade dispatch TRD3, production post PRD3 (F-ONHAND). Sentences name uuids, not items, in TRF2/INV1.
3. Sales day already exists for that store and date SLD1 (daily screen).
4. Verify your own sales day SLD10 / can't be posted yet SLD11 (daily screen; SLD11 is the L-sized one).
5. Credit sale over the customer's credit limit TRD2 (daily wholesale screen).
6. Count commit: items with stock never counted CNT4 (every stock count).
7. Cash request release over approval / account can't cover CSH1 and transfers CSH7 (F-BAL).
8. Leave caps and conflicts PAY9-PAY13 (every leave filing; five distinct sentences).
9. Item name already in use ITM1 (item master, frequent near-duplicates).
10. Remittance handed over exceeds what days owe SLD15 / settle between stores CSH8.
Close runners-up: payroll "no rate in force" PAY1; period close order SET1/SET2; staff hire duplicate STF1; menu price schedule ITM10; supplier return qty INV4.

## Cannot be fully live, or needs a guarded lookup
- Pure races (S): CNT2, TRF4, DLV3, CSH3, CSH10, SLD17, PAY14, FAS3, SET3, STF8, SET13. Server-only by nature; leave as is.
- Guarded / privacy-sensitive (L*):
  - STF1 hire duplicate: needs a person search; domain deliberately limits it to the viewer's store scope (D:people/index.ts:318). Return only "already employed here", never the staff code to someone who may not see it. Authorize first (DEF-676 pattern).
  - TRD9 BIR invoice no. across the org: return only the order reference; authorize `approve_buyer` first.
  - SLD2 voided date + `can(void_sales_day)`: reveals that a day was withdrawn; same people who can see the day list.
  - PAY12 / PAY9-PAY13 leave: service start, entitlement, leave history and attendance of ANOTHER person; scope to the viewer's stores and the `record_leave` right; never medical-certificate fields.
  - TRD2 / CUS4 / CUS2: customer balance and credit limit; already shown to the same viewer on /customers/[id], so lookup is consistent with what they can see; still authorize first.
  - CSH1/CSH7/OTH1/OTH2/OTH4/INV7: money-account balances and supplier credit. `judgeDraw` is pure and already ships to the browser; the BALANCE is the guarded fact (office vs cashier vs staff). Only send balance for accounts the viewer's picker already offers.
  - CNT5/CUT6 cost basis / opening costs: item costs are not shown to all staff; return a boolean "has cost", not the cost.
- Not live-able without an evaluator split (size L): SLD11 (sales-day routing verdict), SET2 (period close blockers), CUT4 (opening-balance tie-out). Same technique as T-475 `approvalVerdict`: gather facts then pure verdict.
- Quality note: ~25 rows throw a plain `Error` (money-transfers/prepare.ts, till, service-charge, separation, stores, statutory-discounts, commissary/fulfilment) or ok:false with raw ids (stock layers, transfers, supplier returns). Moving their sentences into a leaf is the same edit as making them live; do it per row when the row is built, or the screen will show a different sentence than the server.
- Not swept in detail: attendance/terminals, statutory-discounts void, dual-run dispositions, budgets, fixed-asset dispose/depreciation run, sales-days/recheck, till shortage charge. They carry few business rules (mostly reason-required/format).
