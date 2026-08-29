# T-179 — Customer returns: the goods come back, and they hold a credit

> **Status:** SPEC, 2026-08-29. Written before implementation (bible §1.2a).
> ⭐ **A capability no phase has ever owned.** It arrived with Ian's answer on supplier returns
> (bible **row 166**) and is not in `CAPABILITY-GAPS.md`'s 34, not in v1, and not in the phase plan
> as first written — because **v1 cannot do it**, so no capability inventory could have found it.
> **Depends on:** T-162 (`stock_layer_consumptions` — ⭐ the return's cost basis), T-164, T-131 (AR,
> `2140`), T-132/T-133 (`trade_orders` and the derived treatment), T-173 (the internal path).
> **Sibling:** T-170 is this shape pointing the other way.

## 1. Goal

A customer sends goods back, the goods re-enter our stock at the cost they left at, the revenue
reverses, and the customer ends up holding **a credit they can spend on their next order — or cash,
if they would rather have it back.**

## 2. ⭐ Ian's answer, and the one thing it left open

> *"Us being the supplier to other customers, return to us must be treated the same I guess: store
> credit customer may use, or we refund."*

**Treated the same** — a return creates a credit, not a silent reversal. Symmetric with T-170, and
the account already exists: **`2140 Customer store credits payable`**, party-required, active, whose
own seed comment says *"a store credit that does not say WHOSE credit it is cannot be paid back to
anyone — v1 had a boolean flag and no balance at all behind it."*

⚠️ **Ian said *"I guess"*, so the one place I extended rather than copied is flagged rather than
buried:** a customer return is **not** perfectly symmetric with a supplier return, because **we
recognised revenue on the way out and we did not on the way in.** So this document reverses three
things where T-170 reverses two — revenue, cost, and stock. §3 shows all three.

## 3. The posting — external and franchise customers

A ₱5,000 wholesale line that cost us ₱3,800, returned in full and resaleable:

| Account | Dr | Cr |
|---|---:|---:|
| `4950` Sales returns and voids *(contra-revenue)* | 5,000.00 | |
| `1210` AR *(party: customer)* — **if they still owe us** | | 5,000.00 |
| *…or* `2140` Customer store credits payable *(party)* — **if they have paid** | | 5,000.00 |
| *…or* `1110`/`1140` Cash — **if they want a refund** | | 5,000.00 |
| `1310`/`1330` Inventory | 3,800.00 | |
| `5xxx` COGS *(the account the sale debited)* | | 3,800.00 |

⭐ **`4950 Sales returns and voids` already exists** as contra-revenue (`chart-of-accounts.ts:299`).
⛔ **Do not debit the revenue account directly** — a return is a fact worth seeing, and netting it
into `4300` hides the return rate, which is a number a wholesale operation manages.

**Which credit leg fires is DERIVED, with one user choice inside it:**

| The customer | Default | User may choose |
|---|---|---|
| Still owes on the order | Reduce `1210` | — |
| Has paid | `2140` store credit | **Cash refund** |
| Has paid, and asks for cash | Cash refund | — |

⚠️ **The refund is the only decision a human makes here.** Everything else follows from what the
ledger already knows.

## 4. ⭐ An INTERNAL return is not a credit at all

A branch returning goods to its own commissary posts **T-173 backwards**:

| Account | Store | Dr | Cr |
|---|---|---:|---:|
| `2150` Due to related store *(party: commissary code)* | branch | 3,100.00 | |
| `1310`/`1330` Inventory | branch | | 3,100.00 |
| `1310`/`1330` Inventory | commissary | 3,100.00 | |
| `1250` Due from related store *(party: branch code)* | commissary | | 3,100.00 |

**No revenue, no contra-revenue, no `2140`, no refund** — *a branch has no credit relationship with
its own commissary.*

⭐ **This falls straight out of ADR-008 §8's rule** — *"a mode is a fork; a derived treatment is a
fact"* — and it is the same `counterparty_store_id` fact that already decides how a **dispatch**
posts (T-133 §5). **One return document, three treatments, all derived. ⛔ Never a mode the user
picks.**

## 5. ⭐ The cost the goods come back at, and why the design already has it

Returned goods must re-enter inventory at **what the original sale actually relieved** — not at
today's cost, which would silently re-value the return and leak a gain or loss into COGS.

**T-162 already stores exactly that.** `stock_layer_consumptions` snapshots `unit_cost` per
(layer, movement), with the header note explaining why: *"a cost used in a past transaction **is** a
fact."* ⭐ **So the return is not a new mechanic — it is `reverseConsumption` on the sale's
movements**, and T-162 invariant 7 already says quantity returns to **the exact layers it came
from**, never to the oldest open layer.

⚠️ **Two extensions this task needs, both small and both named rather than assumed:**

1. **Partial reverse.** T-162's `reverseConsumption(movementId)` reverses a whole movement. A
   partial return needs a quantity, reversed in **reverse order of consumption** — the last layer
   consumed is the first returned. ⭐ Chosen because it makes a sequence of partial returns sum to
   exactly the full reversal, and because it is the same direction T-162 already reverses in. One
   rule in the system, not two.
2. **Reopening a closed layer is correct and is not a special case.** The goods resume their
   original FIFO position, so returned old stock goes out **first** — which for a perishable
   business is the physically right answer, not merely the arithmetically convenient one.

### Goods that come back unsaleable

⛔ **Not a special posting.** Reverse the consumption normally, then **post a wastage** (T-164) for
the same quantity, reason `customer_return_unsellable` — which is already in the shared enum.

⭐ **Two events, because two things happened**: the goods came back, and then they were written off.
The stock ledger shows in-then-out, which is what physically occurred, and the loss lands in `5300`
where every other write-off lives.

## 6. Scope

**Create:** `packages/db/schema/customer-returns.ts` ·
`packages/db/migrations/<next>_t179_customer_returns.sql` ·
`packages/domain/src/trade/returns.ts` ·
`packages/db/src/repo/customer-returns.ts` ·
`apps/erp/src/app/trade/returns/page.tsx` + `actions.ts` ·
`packages/domain/tests/integration/customer-returns.test.ts`

**Modify:** `packages/domain/src/stock/layers.ts` (partial `reverseConsumption`, §5) ·
`packages/domain/src/ar/index.ts` (⚠️ `2140` redemption — §7) ·
`packages/domain/src/trade/index.ts` (a trade order may be paid partly by credit) · barrels ·
`classification.ts` · `rls/registry.ts` · `CAPABILITY-MATRIX.md` ·
`docs/POSTING-PATTERNS.md` (four patterns) · `tests/worked-examples/fixtures.ts` ·
`repo/findings.ts` · `docs/tasks/131-accounts-receivable.md` (its out-of-scope line, §7) ·
`_journal.json` · `docs/ROADMAP.html`

## 7. ⚠️ This supersedes one line of T-131, and says so rather than quietly diverging

T-131's *Out of scope* reads: **"Store credit redemption — `2140` accrues here, spending it is a POS
concern."**

**That was right for the case T-131 had** — a retail diner's collection surplus, spent at the till.
⛔ **It is wrong for a wholesale customer**, who has no till to spend it at and whose credit is
redeemed against the next **trade order**. Ian's answer creates that case.

⭐ **So redemption is built here, for trade orders only.** The POS/retail path stays out of scope and
stays T-131's sentence. **Report the divergence** (§3.4a) — do not let a superseded line sit
unmarked in a spec someone will read later.

## 8. Contract

```
customer_returns
  id, org_id, store_id
  trade_order_id  uuid NOT NULL -> trade_orders
  customer_id     uuid NOT NULL -> customers
  treatment       'external' | 'inter_entity' | 'internal' NOT NULL   -- DERIVED, §4
  returned_on     date NOT NULL
  reason          text NOT NULL
  settlement      'reduce_ar' | 'store_credit' | 'cash_refund' | 'reverse_transfer' NOT NULL
  status          'posted' | 'void' NOT NULL default 'posted'
  journal_entry_id uuid NOT NULL -> journal_entries
  voided_at, voided_by, void_reason, created_by, created_at
  check (treatment <> 'internal' or settlement = 'reverse_transfer')
  check (treatment =  'internal' or settlement <> 'reverse_transfer')

customer_return_lines
  id, return_id -> customer_returns (cascade)
  line_no
  trade_order_line_id uuid NOT NULL -> trade_order_lines
  quantity   numeric(14,3) NOT NULL check (quantity > 0)
  saleable   boolean NOT NULL default true          -- false -> §5's wastage
  amount     numeric(14,2) NOT NULL                 -- revenue reversed, at the captured rate
  cost       numeric(14,2) NOT NULL                 -- COGS reversed, from the consumption rows
  movement_id uuid NOT NULL -> stock_movements
  unique (return_id, line_no)
```

```ts
recordCustomerReturn(input): Promise<CustomerReturn>   // one transaction, all legs
voidCustomerReturn(id, reason): Promise<void>
returnableQuantity(tradeOrderLineId): Promise<Quantity>
customerCreditBalance(customerId): Promise<Money>      // ⭐ derived from 2140, never stored
applyCredit(tradeOrderId, amount): Promise<void>       // §7
```

## 9. Invariants

1. **A return is against a `received` trade order line**, capped at `received − already returned`.
2. ⭐ **`treatment` is DERIVED from the counterparty** (T-133 §5's rule), never stored as a choice
   and never a mode. The DB checks pin `internal` ↔ `reverse_transfer` in both directions.
3. **Revenue reverses to `4950`, never by debiting the revenue account.** §3.
4. ⭐ **The rate reversed is the rate CAPTURED on the order line** (T-151 invariant 6), never today's
   price list. *A captured rate stays captured — that is the whole point of capturing it.*
5. ⭐ **The cost reversed is what the sale's consumption actually relieved**, read from
   `stock_layer_consumptions`. ⛔ Never recomputed from current layers.
6. **Saleable goods reopen their original layers** (T-162 invariant 7), in reverse order of
   consumption for a partial return. §5.
7. **Unsaleable goods reopen the layers and are then wasted** (T-164), reason
   `customer_return_unsellable`. ⛔ Not a bespoke posting.
8. **The credit is a `2140` balance with the customer as party.** ⛔ No `customer_credits` table and
   no `credit_balance` column — a query over the ledger (DEF-075).
9. **`reduce_ar` may not exceed the customer's open balance on that order**; the excess becomes
   store credit in the same entry.
10. **Credit redemption draws `2140` down oldest-first** against a trade order, and cannot exceed
    the balance.
11. **A cash refund draws `2140` down** and is not a second document type.
12. **An internal return posts one entry across both stores**, `1250`/`2150` equal and opposite —
    invariant 6's reciprocal check holds by construction, exactly as in T-173.
13. **Void reverses every leg in one transaction**, and is refused once the credit has been redeemed
    or refunded — ⭐ unwind that first.
14. **Period lock applies** to record, void, redeem and refund.
15. **Two-sided access on an internal return** (T-173 invariant 8) — either store's principal may
    record it.

## 10. Tests

1. A full resaleable return of a ₱5,000 line costing ₱3,800: `Dr 4950 5,000 / Cr 1210 5,000` and
   `Dr 1310 3,800 / Cr 5xxx 3,800`; on-hand rises by the quantity; the trial balance ties.
2. ⭐ **The cost is the sale's cost, not today's.** Receive a cheaper lot between the sale and the
   return, then return: the reversal still posts ₱3,800. *The test that proves §5.*
3. ⭐ **Partial return across two consumed layers** reverses in reverse order of consumption, and two
   successive partial returns sum to exactly the full reversal. Asserted per layer.
4. Returned goods **reopen their original layers** and are consumed **before** newer stock on the
   next usage — the FIFO-position assertion.
5. A paid customer's return credits `2140` with the customer as party; an unpaid customer's reduces
   `1210`; a return exceeding the open balance splits across both **in one entry**.
6. A cash refund credits cash and creates no `2140` balance.
7. ⭐ **The credit is spendable:** redeeming it against a later trade order posts `Dr 2140 / Cr 1210`
   (or reduces the amount due), and `customerCreditBalance` returns zero. *Ian's actual
   requirement.*
8. Redeeming more than the balance is refused.
9. An unsaleable return reopens the layer **and** posts a `5300` wastage — **two movements**, in and
   out, asserted on the ledger.
10. ⭐ **An internal (branch → commissary) return posts the four-leg reverse transfer** — `1250`/
    `2150` equal and opposite, and **no `4950`, no `2140`, no refund leg at all**. Asserted by
    absence, because the tempting implementation treats every return the same way.
11. A `store_credit` settlement on an `internal` return is refused **by the database**.
12. Returning more than was received on the line is refused.
13. Void reverses everything; balances return to prior values. Void after redemption is refused.
14. A return into a closed period is refused.
15. ⭐ After every path, `Σ 1310+1320+1330+1340 = Σ` open-layer value — the Phase 3 gate, across both
    stores for the internal case.
16. Live route on 9008: record a return, see the credit, spend it on a new order.

## 11. Out of scope

⛔ **Retail / POS returns and their refunds.** T-131's sentence stands for that path (§7). A diner
is not a customer (ADR-008 §11), and the till is POS's.
⛔ **Restocking fees and partial-credit policies.** Nobody has asked; adding a percentage nobody
maintains is how `2140` becomes wrong.
⛔ **A credit-note document with its own numbering.** The return is the document; the credit is a
balance. Same reasoning as T-170.
⛔ **Credit expiry.** ⚠️ **Named, not assumed away** — an expiring liability is a real policy with
tax consequences and it needs Ian's decision, not a default. `2145 Unredeemed vouchers` is where
that conversation will start if it happens.
⛔ **Supplier returns.** T-170.

## 12. Done when

- [ ] Migration hand-written (DEF-073), next free number, journalled `previous.when + 86400000`.
- [ ] `classification.ts` **PURGE**; `rls/registry.ts` NULLIF-guarded (DEF-077).
- [ ] `docs/POSTING-PATTERNS.md` gains `customer.return-credit`, `customer.return-ar`,
      `customer.credit-applied` and `customer.return-internal`, pinned by `fixtures.ts`.
      ⚠️ `npm run toc`.
- [ ] `customerCreditAgeing` registered in `repo/findings.ts` — an unredeemed credit is a liability
      the customer may have forgotten and we have not.
- [ ] ⭐ **T-131's out-of-scope line annotated** with what this task superseded and why (§7). ⛔ Do
      not delete it — the retail half is still true.
- [ ] `typecheck` · `npm test` · `npm run test:integration` · `npm run build` green (dev server
      stopped; `ListAgents` first).
- [ ] `CAPABILITY-MATRIX.md`: `record_customer_return`, `refund_customer` (manager+),
      `apply_customer_credit`, `void_customer_return` — each with its ✗ test.
- [ ] `docs/ROADMAP.html` updated.
