# T-132 — Wholesale orders: the document a franchisee sale has never had

> **Status:** ✅ **BUILT 2026-08-28** — domain and tests; ⚠️ **no screen until 2026-09-03**
> (DEF-138: `createTradeOrder`/`dispatchTradeOrder` had zero callers in `apps/`, every live test
> used a seeded order). Screen added 2026-09-03: `apps/erp/src/app/trade/orders/` — register,
> create form (rate blank = the price-list rate, shown as the placeholder before it is captured),
> detail with Dispatch / Receive / Void; `nav.tsx` Trade › Trade orders. Smoketested live end to
> end, postings verified in the database — see the DEF-138 row. ⚠️ **§8's "no COGS" is no longer
> true**: T-165 (2026-09-02) made dispatch relieve stock and post cost of sales.
> Spec by the Opus planner the same day; Wave 4's first
> item. `4300 Wholesale sales` added to the chart by migration — every other 4xxx leaf is retail.
> **Depends on:** T-129 (`customers`, `price_lists`), T-145 (`items`), T-149 (`sellable_wholesale`),
> T-131 (`ar_charges`), T-105 (`postEntry`).
> **Research: already done and NOT repeated.** `docs/discovery/19-b2b-order-to-cash.md`
> (2026-08-24) read ERPNext, Odoo, Tryton and Dolibarr at controller level, at pinned commits.
> This spec answers its three closing questions rather than re-asking them.
> **Assessed before specced**, per bible row 163.

## 1. The gap, precisely

`ar_charges` has `total_amount` and a caller-chosen `revenue_account_code`, and **no lines**.

So today a franchisee sale is a lump sum. That single fact causes all of the following:

- ⛔ **No quantity and no item.** The item master (T-145), the wholesale flag (T-149) and the price
  lists (T-129) have **no consumer** — three shipped features feeding nothing.
- ⛔ **No margin, ever.** Revenue with no line items cannot be costed, now or retrospectively.
- ⛔ **The price is retyped.** A standing price list exists and nothing reads it, so the agreed
  rate is whatever the person entering the charge remembers.

## 2. What the research already settled — and the three forks it handed over

⭐ **The four-document chain is not what real systems enforce.** Tryton collapses Quote/SO/DN/SI
into one `sale.sale` record; Dolibarr bills straight from a validated order with no shipment
document at all. ADR-008 §8's one-document, status-driven shape is corroborated, not invented.

The three open forks, with the answer taken here:

| Fork | Taken | Why |
|---|---|---|
| §2.5 Does dispatch **become** the invoice, or can billing lag and batch? | ⭐ **Dispatch = the billing event** | The research's own recommendation, matching Dolibarr and standard PH practice for a dozen named buyers billed per delivery. Divergence costs a clearing account and an unbilled-dispatch report, for generality nobody has asked for. ⚠️ Revisit **only** on a stated buyer request for period-batched invoices |
| §4 Credit limit — enforce, and where? | **Yes, at exactly ONE gate: dispatch**, manager override | Three of four systems answer differently; Dolibarr's non-enforcing limit field is the cautionary tale. ⛔ ERPNext checks at three document-submit hooks — we have one document, so three gates would be generality with no need |
| §3.4 Is the line rate captured or live-joined? | ⭐ **Captured at line creation** | An agreed price must not move. A live join means editing a price list silently reprices every open order — and bible §4.2's derive-don't-store instinct pulls the *wrong* way here. Every system studied copies `rate` forward rather than re-deriving it |

## 3. ⛔ The boundary with T-133, which is a chart decision, not a naming one

`customer_group` is already `wholesale | franchise | internal | staff | other`.

| Buyer | Is it real revenue? | Owner |
|---|---|---|
| A franchisee, an external restaurant (`wholesale`, `franchise`) | **Yes** — a separate business. Nothing eliminates | **T-132, this task** |
| Our own branch (`internal`) | ⛔ **No** — consolidated, it must ELIMINATE against the buying store's `5170`, or the same peso is counted twice | **T-133** |

⚠️ So this task **refuses an `internal` customer outright**, naming T-133 in the error. The chart
already carries the buy side (`5170 COGS — commissary transfers`, with the double-count warning
written beside it) and the reciprocal pair (`1250` / `2150`). Posting an internal transfer to
ordinary revenue would be the exact bug that comment exists to prevent.

## 4. The chart needs one new account

⛔ **There is no wholesale revenue account.** The 4xxx range is `4100` unli, `4150` à la carte,
`4400` beverage, `4500` other charges — all retail. Wholesale has been booked to whatever the
caller passed.

```
4300  Wholesale sales   income / credit / parent 4000
```

⚠️ Added by **migration**, not by editing the seed alone: the seed builds a fresh database, and
both live databases already exist. Both get the row, the same way `0012`, `0038` and `0040` added
theirs.

## 5. Contract

```
wholesale_orders
  id, org_id, store_id            -- the SELLING store
  customer_id                     -- active; group in (wholesale, franchise)
  order_date, reference_no, notes
  status        draft | confirmed | dispatched | void
  total_amount                    -- must equal the sum of its lines
  ar_charge_id                    -- the receivable raised at dispatch; linked, never duplicated
  journal_entry_id
  dispatched_at, dispatched_by
  voided_at, voided_by, void_reason
  created_by, created_at, updated_at

wholesale_order_lines
  id, org_id, order_id
  item_id, quantity, unit
  rate                            -- ⭐ CAPTURED at creation. Never a live join to price_list_items
  line_total

customers
  credit_limit  numeric NULL      -- NULL means no limit, which is not the same as a limit of zero
```

### Lifecycle

`draft → confirmed → dispatched`, and `void` from any of them.

⭐ **Dispatch is the only step that posts**, and it posts one entry:

```
DR 1210  Accounts receivable   (party = the customer)
CR 4300  Wholesale sales
```

## 6. Invariants

1. `total_amount` equals the sum of its lines. Enforced where the lines are validated, as T-145
   does for supplier invoices.
2. A line's item must be **sellable wholesale at the selling store** — `sellabilityAt(storeId)`,
   not the org default. ⭐ This is Ian's bulgogi case read from the other side: Lipa may sell the
   sauce it makes; a branch that merely buys it in may not.
3. The rate is captured. A later price-list edit never changes an existing line.
4. An `internal` customer is refused, naming T-133.
5. Dispatch is **idempotent** — dispatching twice posts once.
6. Void reverses through `reverseEntry`, never by deleting the entry.
7. At dispatch, `outstanding + this order ≤ credit_limit`, unless an override reason is recorded.
   NULL limit skips the check entirely.
   ⚠️ **The gate demands a REASON, not a rank, and that is deliberate.** `approve_buyer` is
   manager+, and every role that clears it also holds `override_credit_limit` — so the limit is
   never a wall between ranks. It forces the person dispatching to state, on the record, why they
   went past it. Same choice Ian made for write-off on 2026-08-28: identity and evidence beat
   rank, which was the weaker guard and left an admin-less store stuck.

## 7. Tests

1. An order priced from the customer's price list carries the captured rate; editing the price
   list afterwards leaves the order untouched.
2. A retail-only item (the bento box) is refused on a wholesale line.
3. An item sellable wholesale **only at another store** is refused here, and accepted there.
4. An `internal` customer is refused, and the message names T-133.
5. Dispatch posts exactly one balanced entry to `1210` / `4300`, with the customer as party.
6. Dispatching twice posts once.
7. Void reverses the entry and leaves the AR charge with no outstanding balance.
8. A dispatch that would breach the credit limit is refused when no reason is given; a stated
   reason lets it through and is kept; a NULL limit never blocks; staff cannot dispatch at all, so
   the gate never runs for them.
9. Lines that do not sum to `total_amount` are refused.

## 8. Out of scope — each with its reason

⛔ **COGS and inventory movement.** There is **no inventory module in v2** — `packages/domain/src`
has no stock quantities to relieve. So a dispatch moves no stock and posts no COGS, and ⚠️ **that
means wholesale margin is still not measurable after this task.** Revenue and the receivable are;
cost is not. Named here so the omission is a decision rather than a discovery.

⛔ **A quotation step.** The price list *is* the standing quote for ~12 named buyers on an ongoing
relationship. ERPNext's Quotation doctype solves a negotiation problem this business does not have.

⛔ **A separate delivery-note document.** Its information — what shipped, when — survives as
`dispatched_at` on the one order. Both light systems studied treat it as optional bookkeeping.

⛔ **Pricing rules** — volume breaks, date-ranged promotions. ADR-008 §3 declined ERPNext's
Pricing Rule; Odoo's is heavier again.

⛔ **Period-batched invoicing.** §2.5's other fork. Build it when a buyer asks, which is a visible
trigger, not a guess.

## 9. Done when

- [ ] Migration hand-written per DEF-073, journalled `previous.when + 86400000`; new tables in
      `cutover/classification.ts` **and** `rls/registry.ts`, RLS policies on `app_current_org()`.
- [ ] `4300` inserted into both live databases, not only the seed.
      NOT 4200 - the 2026-08-23 amendment removed that code, and reusing it would read as the
      take-out account returning.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green.
- [ ] `docs/ROADMAP.html` updated — standing rule, Ian 2026-08-28.
