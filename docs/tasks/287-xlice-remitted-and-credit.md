# T-287 — Xlice is the WHOLESALE channel, and the machinery for it already exists

> ⭐ **REWRITTEN 2026-09-12 after Ian's answer.** The first draft proposed a
> `receivable_amount` column on `sales_day_channels`. **That is now withdrawn as wrong** — see
> "What the first draft got wrong". Spec only, no code.

**Ian, 2026-09-12, question:** *"Xlice is a sales channel that is remittable daily but also can be
settled as credit - AR how do i set that up?"*

**Ian, 2026-09-12, the answer that changes the design:** *"yes possible xlice sales can be mixed of
cash online credit from more than 1 customer this basically is our wholesale channel. separate from
dine in channel."*

## ⭐ The finding: build nothing. Xlice is `trade_orders`, and that module is already built.

`packages/db/schema/trade.ts` opens with *"Wholesale orders — the document a franchisee sale has
never had. T-132."* It already carries everything Ian described:

| Xlice needs | Already exists |
|---|---|
| A named buyer per sale | `trade_orders.customer_id` → `customers` |
| Per-item lines at an agreed price | `trade_order_lines`, priced from `price_lists` (T-129) |
| Only wholesale-able items | the `sellable_wholesale` line guard (T-149) |
| Billing on dispatch | `dispatchTradeOrder` → `ar_charges` (`trade.ts:84`, `arChargeId`) |
| Credit that ages | `ar_charges` + the AR aging report |
| Cash or online payment | `ar_collections.money_account_id` + allocation |
| Proof for an online payment | `ar_collections.receipt_file_id` — *"required for an ONLINE collection, never for cash"* |
| Several customers in one day | one order each; nothing aggregates them |
| Returns | `trade/returns` |

**So the setup is configuration and habit, not code:** a customer record per wholesale buyer, a
price list, items flagged `sellable_wholesale`, and wholesale sales entered as **trade orders** —
never as a figure on the sales day.

## ⭐ The question everyone expects to be hard, and why it is not

*"If a wholesale buyer pays CASH into the cashier's till, how does that cash get into the day's
expected remittance?"*

**Automatically, and by design.** `packages/db/src/repo/remittance.ts:13`:

> ⛔ **No `expected` column exists, and none should.** A query that enumerated document types would
> be wrong the day a new one appears — silently, and in the safe-looking direction. This one asks
> the ledger what the cashier actually holds, so **a document type nobody has invented yet is
> already included.**

Expected remittance is the cashier's **net ledger movement for the date**, not a sum over sales
channels. An `ar_collection` into the till's money account posts to the ledger, so it is in the
day's owed figure without a line of new wiring. Ian, 2026-08-27 (row 157): *"the composition of all
money movement of the day across transactions."*

⭐ **This is that decision paying off.** The one design choice that looked like extra rigour in
T-143 is the reason Xlice needs no remittance change at all.

## ⛔ What the first draft got wrong, recorded rather than deleted

It proposed `sales_day_channels.receivable_amount` — splitting a channel's daily figure into
collected and owed. **Three things are wrong with it**, and all three only became visible once Ian
said "wholesale, more than one customer":

1. **A receivable with no party is v1's `unallocatedAmount`** — *"money tied to nothing on 38
   collections, no way to re-apply"*, which `ar.ts` lists as one of four v1 behaviours refused here.
   A column on a channel row has nowhere to put the buyer.
2. **It would have been a second, poorer copy of `ar_charges`** — no lines, no item, no price
   history, no ageing, no allocation, no returns path.
3. **Mixed cash + online + credit in one day cannot be expressed as one split.** Three payment
   routes across several buyers is a set of transactions, not a pair of numbers.

⭐ The first draft's own "open question 1" — *can one day carry credit to more than one customer?*
— is exactly what killed it. **Asking was cheaper than building it.**

## ⛔ The real risk: DOUBLE COUNTING

If a wholesale sale is entered **both** as a trade order **and** as a figure on the sales day's
Xlice channel line, revenue and receivables are counted twice.

⭐ **Measured: there is no Xlice channel in the dev database today** — the only channels on any
store are Walk-in, Foodpanda and GrabFood. So this is a greenfield setup with nothing to unwind,
**provided a "Xlice" sales channel is never created.** If one already exists in production, that
must be checked before anything else.

**Recommendation: do NOT create a sales channel named Xlice.** Dine-in and delivery are aggregated
daily and anonymous; wholesale is per-buyer and documented. They are different shapes and the
sales-day channel list is the wrong home for the second.

## What may genuinely be missing — to confirm, not assume

1. **Can `dispatchTradeOrder` record immediate payment, or only bill to AR?** If a cash wholesale
   sale needs two steps (dispatch, then a separate collection), that is a usability gap worth a
   one-screen fix — **not** a schema change. ⚠️ Read `packages/domain/src/trade/index.ts:336-533`
   before deciding; do not assume from this spec.
2. **Is a wholesale buyer required to exist as a `customer` first?** If Xlice sells to walk-up
   wholesale buyers with no account, that needs a decision — a generic "cash wholesale" customer,
   or a real record each time. **Ian's call.**
3. **Does the income statement separate wholesale revenue from dine-in?** If both land on one
   revenue account, "how is wholesale doing" is unanswerable. Check the account on
   `trade_order`'s posting before concluding either way.

## Open questions for Ian

1. **Does Xlice sell items that dine-in also sells, at a different price?** That is what
   `price_lists` is for, but it changes which items need `sellable_wholesale`.
2. **Walk-up wholesale buyers with no account — do they exist?** (Question 2 above.)
3. **Should wholesale revenue post to its own account** so it is separable in reporting?

## Files a future implementation would touch

⭐ **Possibly none in `packages/db`.** Most likely `apps/erp/src/app/trade/orders/**` only, plus
configuration. Confirm items 1–3 above before writing a line.
