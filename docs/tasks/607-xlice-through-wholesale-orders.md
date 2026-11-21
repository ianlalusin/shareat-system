# T-607 — Xlice through wholesale orders: staff draft, pick-up day, credit limit screen, wholesale in the day

Status: SPEC (Opus), 2026-11-18. Every line number is `wt-plans` HEAD 2365316. Risk: **high** (money, auth).
Builder: Sonnet, one commit per slice. **No migration. No new capability.** Bible: no change (rows 352, 375, T-287 hold).
Ruling (Ian, 18 Nov): *"go with xlice through wholesale orders, staff draft"*. Added the same day via BOSS: *"it must be
computed together with the pos sales in computing the cash remittance daily and online remittance"*.

## How a wholesale order flows today (verified)
| Step | Who | Code | Posts |
|---|---|---|---|
| Create (status `draft`) | `approve_buyer` at the store (manager+) | `packages/domain/src/trade/index.ts:170-176`; action `apps/erp/src/app/trade/orders/actions.ts:40-76` | nothing |
| Confirm | `approve_buyer` | `trade/index.ts:399-411` — **no caller** (`tests/unit/domain-actions-have-callers.test.ts:255`) | nothing |
| Dispatch (from draft or confirmed) | `approve_buyer` (`:450-454`) | `:439-487`; charge dated `order.orderDate` (`:628`); stock moved on `orderDate` (`:678,692`) | Dr 1210 / Cr 4300, COGS |
| Paid now | same, one transaction | `:635-637` → `ar/index.ts:242-290` `recordChargeWithCollection`, collection dated **today** (`:290`), account must be at the order's store (`:272`) | Dr money account / Cr 1210 |
| Credit gate | in `recordCharge` / helper | `ar/index.ts:279` (`creditExposure`, org-wide, `FOR UPDATE`), override `override_credit_limit` + reason | — |
| Delivery receipt | `approve_buyer` or `record_ar_collection` | `trade/orders/lib.ts:275-293`, `/trade/orders/[id]/print`; dispatched sales only | — |

Already there and reused: `create_wholesale_order` (`packages/auth/src/capabilities.ts:187,612,1055`; matrix
`docs/decisions/CAPABILITY-MATRIX.md:129`, "Staff-entered by design", staff by position grant). It is checked only by the
order page's view gate (`trade/orders/lib.ts:186-192`); `createTradeOrder` ignores it. T-435 already hides the credit
limit from a W1 (create-only) viewer (`lib.ts:54-57,145-150`; `[id]/page.tsx:62-63`; test `apps/erp/tests/integration/t435-s4-trade.test.ts:73`).

## S1 — Staff draft, manager confirms (size M)
**Capability: reuse `create_wholesale_order`** (nearest existing word; it exists for exactly this). No matrix ✅ changes;
the row's note gains "T-607: lets the holder create and edit a DRAFT external order at its own store; never confirm,
dispatch, void, state a rate or a fee". `dispatch_wholesale_order` stays unwired (out).

**What a drafter sees — options:**
- A. Items and quantities only; no rates, no totals. Needs a second form and hiding the register's Total column.
- **B (pick). Items, quantities and the price-list rate as a read-only default; no credit figures, no rate override, no fees.**
  Price lists are already open to everyone by Ian's ruling (Q3, 16 Oct: `apps/erp/src/lib/route-capability.ts:151-152`)
  and the form already ships rates to any signed-in viewer (`lib.ts:115-118`), so A hides nothing that is not already
  readable. Credit limit and balance stay hidden (T-435, `/customers` needs `record_ar_collection`, `route-capability.ts:150`).
- C. Everything including rate override and fees. Rejected: a rate is a pricing decision.

Domain, `packages/domain/src/trade/index.ts`:
- `createTradeOrder:176` `await authorize(trx, actor, 'approve_buyer', { storeId: input.storeId });` becomes
  `await authorizeEither(trx, actor, [{ capability: 'approve_buyer', storeId }, { capability: 'create_wholesale_order', storeId }])`
  (helper `:54-67`). Then `const drafter = !(await can(trx, actor, 'approve_buyer', { storeId }))`. When `drafter`, after
  the customer load (`:186-209`), refuse with `refuse()`:
  R1 treatment `internal` → "A transfer to another store is entered by a manager."; R2 any line `rate` given →
  "Only a manager can change a price. Leave the price blank to use the customer's price list."; R3 a fee given →
  "Only a manager can add a delivery or other fee."
- Extract `:211-377` (lines, pricing, fees, totals) into a private `priceOrder(trx, actor, input, customer, treatment)`
  returning `{ lines, totalAmount }`; `createTradeOrder` calls it unchanged in behaviour.
- New `updateTradeOrderDraft(tx, actor, { orderId, customerId, orderDate, lines, referenceNo, notes, deliveryFee, otherFees })`:
  `getOrderById(..., { forUpdate: true })` → `authorizeEither` at `order.storeId` → refuse unless `status === 'draft'`
  and `requestedByStoreId === null` ("Only a draft can be changed. This order is {status}.") → same drafter checks →
  `priceOrder` → new repo `tradeRepo.replaceDraft(tx, orgId, id, header, lines)` (`packages/db/src/repo/trade.ts`: one
  `update trade_orders ... where status = 'draft'` + `delete from trade_order_lines where order_id` + `insertLines`;
  zero rows updated → `recordGone`). Posts nothing, moves no stock, bills nobody.
- `confirmTradeOrder` unchanged (manager). Wire it: `confirmOrderAction` in `actions.ts`; a "Confirm" button on
  `[id]/page.tsx` for a draft when the viewer holds `approve_buyer`. Remove the `confirmTradeOrder` row from
  `domain-actions-have-callers.test.ts:255-257`.
- Screens: `trade/orders/page.tsx:73-90` shows "+ New" only to `approve_buyer` or `create_wholesale_order` holders at
  `storeId`; `NewOrderForm.tsx` gets `canPrice` (false for a drafter: rate and fee inputs not rendered, internal
  customers filtered out). `[id]/page.tsx:66` `canDispatch` additionally needs `approve_buyer` (else the dispatch, void
  and pay-now blocks at `:145`, `:313`, `:381` are not rendered); a draft gets an "Edit draft" `FormModal` reusing
  `NewOrderForm` prefilled, action `updateDraftAction`.

Tests, new `packages/domain/tests/integration/t607-s1-staff-draft.test.ts` (harness from `t433-s1-pay-now.test.ts`;
staff W with only `create_wholesale_order` at store A, as `apps/erp/tests/integration/t435-fixture.ts:217`):
1. W creates a draft at A with blank rates → status `draft`, rates from the price list, **zero** journal entries, zero
   stock movements, zero `ar_charges`. **Mutant:** keep `authorize('approve_buyer')` → AuthorizationError, red.
2. W at store B → AuthorizationError (store scope). Staff with no grant at A → refused. **Mutant:** pass `{}` as scope → red.
3. W states a rate → R2; a fee → R3; an internal customer → R1; nothing written. **Mutant:** delete each check → red.
4. W edits the draft (qty 2 → 3, swap item) → lines replaced, total re-priced, still zero entries. After a manager
   confirms, W's edit → "Only a draft can be changed"; W calls `confirmTradeOrder` / `dispatchTradeOrder` → AuthorizationError.
   **Mutant:** drop the status check in `updateTradeOrderDraft` → red.
5. Manager dispatches W's draft → posts as today (Dr 1210 / Cr 4300). Positive control.
Web, `apps/erp/tests/integration/t607-s1-draft-screen.test.ts` (server render, t435 fixture): W sees no rate input, no
fee input, no Dispatch, no Confirm, no credit limit; a manager sees all. **Mutant:** render `canPrice` true → red.

## S2 — Pick-up day and the "To prepare" list (size S, no migration)
Finding: an order carries `order_date` only (`packages/db/schema/trade.ts:62`), plus `created_at`. No requested or
scheduled column. **`order_date` already is the day the goods leave**: dispatch dates the charge, the revenue and the
stock movement by it (`trade/index.ts:628,678,692`). A separate pick-up column would leave revenue dated on the chat
day while goods leave days later. So: **use `order_date` as the pick-up date; time and "walk-in" go in the note.**
(Fallback if Ian wants the chat date kept too: `0265` adds `pickup_date date null`, ADR-012 §5. Not recommended.)
- `NewOrderForm.tsx`: label "Order date" → "Pick-up / delivery date"; field rule label in
  `packages/domain/src/field-rules/trade.ts:12` → "The pick-up date". Notes placeholder "Pick-up time, who collects".
- Dispatch guard, `trade/index.ts` after `:487`, non-branch orders only: `order.orderDate > toBusinessDate()` → refuse
  "This order is due for pick-up on {date}. Change the date to today before dispatching it." (stops future-dated
  revenue and stock).
- "To prepare" section at the top of `trade/orders/page.tsx` (above the register `:98`): non-void `draft`/`confirmed`
  external orders at the store with `orderDate <= today + 6`, grouped by day (earlier days labelled "Late"), each with
  customer, status badge (Draft = "waiting for manager", Confirmed = "pack it"), and item × qty × unit. New repo
  `tradeRepo.toPrepare(tx, orgId, storeId, upTo)` (one query joining `trade_order_lines` and `items`). No print: the
  delivery receipt serves dispatched orders only and a pick list is out.
Tests (`packages/db/tests/integration/t607-s2-to-prepare.test.ts` + domain): today, tomorrow and +8 orders → first two
listed, +8 not; a void and a dispatched order not listed; another store's not listed (**mutant:** drop `store_id` filter
→ red). Dispatch of a tomorrow-dated order refused, today's passes (**mutant:** delete guard → red).

## S3 — Credit limit screen (size S)
`set_credit_limit`: scope `org`, ✅ super/admin/manager, ✗ staff (`capabilities.ts:591,1018`; matrix `:109`, Ian
2026-08-25). The code comment `capabilities.ts:591` still says "OPEN — Ian to confirm"; the matrix says decided. **Owner
need not decide**; the builder corrects the comment. Only writer today: franchise onboarding
(`packages/domain/src/organizations/onboard-franchise.ts:329` → `packages/db/src/repo/customers.ts:424`).
- Repo `customers.ts:424` `setCreditLimit(..., creditLimit: Money)` → `Money | null` (null = no limit).
- Domain `packages/domain/src/customers/index.ts`: `setCreditLimit(tx, actor, { customerId, creditLimit: string | null })`:
  `authorize('set_credit_limit', {})` first; field rule (new `CUSTOMER_CREDIT_RULES`): blank = no limit, else money ≥ 0
  ("0 means this customer may not owe anything"); unchanged → no-op; else repo + `auditLogRepo.append` action
  `customer.credit_limit_set`, before/after. Catalogue `packages/db/src/audit/catalogue.ts` beside `:323`:
  `def('customer.credit_limit_set', 'money', 'high', 'org', 'customers', 'T-607')`.
- Screen: `customers/[customerId]/page.tsx:189-195` gets an inline "Change limit" `FormModal` for `set_credit_limit`
  holders; action `setCreditLimitAction` in `apps/erp/src/app/customers/actions.ts`.
- Payment terms: no column exists (`ar_charges.due_date` is per charge); terms stay out (T-433 "Not in scope").
Tests `packages/domain/tests/integration/t607-s3-credit-limit.test.ts`: manager sets 10,000 → stored, one audit row; then
blank → null, second row; same value → no row; staff → AuthorizationError, unchanged; "-1" / "abc" → field sentence.
Then a dispatch over the new limit is refused (ties to `recordCharge`). **Mutants:** drop `authorize`; drop the append;
treat blank as `0` → each red.

## S4a — Wholesale money in the daily cash and online remittance (size S)
**Answers (owner's requirement):**
1. **Cash at pick-up: yes, already.** Paid-now posts an `ar_collection` dated today (`ar/index.ts:290`) whose cash leg
   debits the chosen account at that account's store (`ar/index.ts:579-592`). Expected remittance is the ledger's net
   movement on cashier-custody `11xx` accounts per store per date, any source except transfers
   (`packages/db/src/repo/remittance.ts:81-131`, `notCustodySourceType :46`), and the till's expected is the account
   balance (`packages/domain/src/till/index.ts:179`). So ₱500 cash into the store's cashier cash adds ₱500 that day.
2. **E-wallet: yes, already**, by the same query: a `1140` line names its wallet and counts when that wallet's custodian
   is `cashier` (`remittance.ts:94-103`); the per-account split is `cashierMovementByAccount` (`:262-356`).
3. **Collection of an old balance: yes**, on its own `collectionDate`, into whichever account is chosen
   (`ar/index.ts:432-438,579-592`).
Caveat, same rule as POS: money paid into an **office** account is not the cashier's to remit and is not counted.
Credit never touches a money account, so it is never remitted. **No money fix needed**; double count is only possible
through a typed Xlice sales-channel figure, hence retiring that channel (owner section).
Change (labels and pins only):
- `remittance.ts:87-131`: `cashier_movement` adds `coalesce(sum(jl.debit - jl.credit) filter (where je.source_type =
  'ar_collection'), 0)::text as customer_receipts`; `EndDayReport` gains `customerReceipts` (reversals keep the source
  type, so a voided collection nets out).
- `apps/erp/src/app/remittance/page.tsx:340-369`: a column "of which customer payments (wholesale)" beside "Cashier
  movement", and the page description says these are inside the expected total.
- Pay-now picker (`[id]/page.tsx` pay-now fieldset `:158+`): cashier accounts listed first, cashier cash selected by default.
Tests, extend `packages/domain/tests/integration/remittance.test.ts` (`fixtureWithWallet`): (a) POS cash 1,000 + wholesale
paid-now cash 500 on day D → D movement/owed 1,500.00, `customerReceipts` 500.00; (b) same with the cashier wallet →
that wallet's `cashierMovementByAccount` +500; (c) a credit-only dispatch → movement unchanged; (d) a collection on D+1
→ in D+1, not D. **Mutant:** add `and je.source_type <> 'ar_collection'` to `endDayReports` → (a),(d) red; filter
`cashierMovementByAccount` likewise → (b) red.

## S4 — "Wholesale today" on the sales-day page (size S)
Owner/managers read a store's day on `/sales-days/[id]` (gate `submit_sales_day`/`verify_sales_day`, `page.tsx:53`) and
the range dashboard `/` (`getSalesRollup`, sales days only). Wholesale revenue is on the income statement as 4300 already.
**Screen: `/sales-days/[id]` only**, a read-only panel after "Channels" (`page.tsx:271`): "Wholesale (Xlice) this day —
not part of dine-in or à la carte sales": Billed · Paid in cash · Paid online · Still on credit. Dashboard: out.
Query, new `packages/db/src/repo/trade.ts` `wholesaleDay(tx, orgId, storeId, date)`: billed = Σ `ar_charges.total_amount`
(status posted) joined to `trade_orders.ar_charge_id` with `chargeDate = date`, `store_id`, customer not internal;
cash/online = Σ posted `ar_collections.amount` at the store dated `date` for customers with a dispatched trade order,
split by `money_accounts.instrument` (`cash` vs other); still on credit = Σ `outstandingForCharge` of that day's charges
(`packages/db/src/repo/ar.ts:303`). Never written, never added to any sales-day total.
Tests `packages/db/tests/integration/t607-s4-wholesale-day.test.ts`: 5,000 order, 2,000 cash paid now → 5,000 / 2,000 /
0 / 3,000; the sales day's own totals unchanged (**mutant:** add billed into the day's sales → red); a void order → zero.

## S5 — Labels (size XS, no route changes)
| Where | Old | New |
|---|---|---|
| `apps/erp/src/components/nav.tsx:135` | Trade orders | Wholesale orders (Xlice) |
| `trade/orders/page.tsx:16,36,48` | Trade orders | Wholesale orders (Xlice) |
| `page.tsx:75-76` | + New trade order / New trade order | + New wholesale order / New wholesale order |
| `page.tsx:100` | No trade orders at this store yet. | No wholesale orders at this store yet. |
| `[id]/page.tsx:110` | ← Trade orders | ← Wholesale orders |
| `actions.ts:75` flash | Draft saved at ₱X... | unchanged |
Group "Trade" stays (it also holds Suppliers). Update the pinned text in
`apps/erp/tests/t589-b4b-refusal-messages.test.ts:90` and its source sentence ("listed under Wholesale orders").

## Walk-in (rare)
Existing flow covers it: Wholesale orders → + New → customer, item, qty, Save → on the order: paid amount, account,
(photo if e-wallet), Dispatch. About 8 clicks, 2 screens, one sitting, nothing posted until Dispatch. **No shortcut.**

## How Lipa moves Xlice from the old way to this (for the owner)
Today Xlice is one typed figure on the daily report plus typed credit sales: no items, no kilos, no per-buyer record.
Set up once (an admin does it; managers can set credit limits):
1. **Customers**: one per Xlice buyer, group "wholesale" (Customers screen).
2. **Price lists**: one per buyer (or shared), today's Xlice prices per item; link each customer to its list.
3. **Items**: mark each Xlice item "Sold to other stores or buyers (wholesale)" for Lipa.
4. **Credit limits**: per buyer on the customer page (S3). Blank = no limit.
5. **Opening balances**: what each buyer owes on the go-live day, entered as opening receivables.
6. **Retire the "Xlice" sales channel** in Settings → Sales channels (switch off, do not delete). Why: a channel is an
   anonymous daily total; it cannot hold a buyer's debt, and typing it beside the orders counts the same sale twice.
   Retired keeps its history.
Daily: staff draft the order from the chat; a manager confirms; on pick-up the manager dispatches and records any
payment. Cash and e-wallet paid to the cashier fall into the same day's cash and online remittance as POS sales,
shown on their own line. **Stops being typed:** the Xlice total and the Xlice credit lines on the daily report.
**Data the owner must supply:** list of Xlice buyers (name, contact); price per buyer per item; which items; each
buyer's credit limit (optional); each buyer's balance owed on go-live day.

## Open points (recommendations)
- **VAT (POSTING-PATTERNS Q5, `docs/POSTING-PATTERNS.md:796-800`)**: wholesale posts VAT-inclusive to 4300. Not blocked
  in use; if the answer is "registered, inclusive", 4300 is overstated by the VAT and the delivery receipt lacks a VAT
  line until a later task splits it. Recommend: go live, keep the fence.
- **T-287 Q1** (Xlice items also sold to diners at another price): handled by price lists; no build. Ask to confirm.
- **T-287 Q2** (walk-up buyers with no account): recommend one customer "Xlice walk-in (cash)" with credit limit 0.
- **T-287 Q3** (own revenue account): answered, 4300 exists and is separate on the income statement.
- Slicing prices and packaging types (settings decision 7): OUT, waiting on the owner.

## Guards and census (re-measure, never hand-edit)
- `tests/unit/t343-throw-ratchet.test.ts`: trade ≤ 51 (`:131`), customers 0 (`:91`), remittance 17 (`:115`). New refusals
  use `refuse()`; lower a pin if a count drops.
- `packages/db/tests/t402-s1b-catalogue.test.ts:95` ceiling 278 → 279 (S3), reason in the comment.
- `tests/unit/capability-matrix.test.ts:333` and `tests/unit/t398-s6-franchise-capability-cells.test.ts:42` stay 131.
- `apps/erp/tests/action-link-sweep.test.ts` (touch targets and link styles): new Confirm, Edit draft, Change limit use
  `Button`/`FormModal`; `apps/erp/tests/t384-s3-editable-record.test.ts` and `t389-editable-record-typed.test.ts` for
  the draft edit and credit forms; `tests/unit/t402-s1a-action-coverage.test.ts` for the three new actions.
- `apps/erp/tests/t589-pages-ledger.test.ts`: no new `page.tsx`, so no PAGES.md row.
- `tests/unit/domain-actions-have-callers.test.ts`: remove `confirmTradeOrder` (S1); `updateTradeOrderDraft` and
  `setCreditLimit` get callers in their slices.

## Out of scope
A POS wholesale mode or customer on a POS sale; an Xlice sales channel; `dispatch_wholesale_order` wiring; payment terms;
pick-list printing; batched invoices; dashboard tile; slicing fees and packaging; VAT split.

## Build order and commands
S1, S2, S3, S4a, S4, S5. One commit each; mutant red lines in the commit message; LF endings; no root `tsc`.
```
npx vitest run --project integration <the slice's test files> packages/domain/tests/integration/trade.test.ts packages/domain/tests/integration/t433-s1-pay-now.test.ts apps/erp/tests/integration/t435-s4-trade.test.ts --maxWorkers=1
npx vitest run --project unit tests/unit/t343-throw-ratchet.test.ts tests/unit/domain-actions-have-callers.test.ts tests/unit/t402-s1a-action-coverage.test.ts tests/unit/capability-matrix.test.ts --maxWorkers=1
npx vitest run packages/db/tests/t402-s1b-catalogue.test.ts apps/erp/tests/action-link-sweep.test.ts apps/erp/tests/t384-s3-editable-record.test.ts apps/erp/tests/t589-pages-ledger.test.ts --maxWorkers=1
```
S4a also runs `remittance.test.ts` and `t373-s4-reversed-remittance-variance.test.ts`. Full suite in CI on the PR.
Smoketest on a private port: staff draft → manager confirm → dispatch with ₱500 cash → `/remittance` shows it in the
day's line; `/sales-days/[id]` shows the wholesale panel.
