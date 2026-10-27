# POSTING-PATTERNS draft — `trade_dispatch.franchise` (T-398 S5, planner prerequisite R5/A7/B14)

For S5a. Paste the section below into `docs/POSTING-PATTERNS.md` after "Customer return" and before "Cash request"
(regenerate the TOC with `npm run toc`). Each `` ### `id` `` heading needs a matching fixture in
`tests/worked-examples/fixtures.ts` or `tests/unit/posting-patterns-doc.test.ts` goes red — fixture sketches are in
the appendix. Also replace the warning at the head of "Commissary dispatch" (today `POSTING-PATTERNS.md:743-749`, "Do
not use this one for a franchise … not yet written here") with one line: *"For a franchise (another company), see
**Franchise dispatch** below: a real sale on both sides, never this elimination."*

Accounts are the ones the existing paths already post: `4300` (`WHOLESALE_REVENUE_CODE`, `trade/index.ts:78`),
`1210` (`recordCharge`), `5100` (`postConsumption`, `cogsCategory: 'food'`), `1310/1320/1330`
(`INVENTORY_ACCOUNT_BY_ITEM_KIND`), `2120`/`2110` (`stock/receipt-posting.ts:73-74`), `4950` and `2140`
(`customer.return-*`), `5300` (`commissary.discrepancy-loss`). No new account.

⚠️ **The buyer legs assume orchestrator ruling QO-1 (a)** (receipt to `2120`, then a system supplier bill clears it to
`2110`). If QO-1 rules (b), `trade_receipt.franchise` and `trade_receipt.franchise-bill` collapse into one entry
`DR 1310 / CR 2110` and the fixtures change with them.

---

## Franchise dispatch (`trade_order_dispatch`, inter-entity) — v2-only, T-398 S5, ADR-008 §4

The commissary sells to a franchise that is **another company in its own organisation** (Padre Garcia). Nothing
eliminates: the commissary recognises revenue and cost, the franchise recognises stock and a payable, each **in its own
organisation and its own transaction**. No entry ever has lines in two organisations. The two sides are tied by the
shipment note (`inter_entity_shipments`) and checked by the daily reconciliation, never by a shared transaction.

> **VAT: pending Q5 (Ian answers by 13 Nov).** v2 computes no VAT (bible #75). Every amount below is the
> VAT-inclusive price as billed. A line marked **FENCED** is one whose amount, or whose existence, changes if Q5's final
> answer is (a) "VAT-registered, prices inclusive": revenue and inventory would then post net of VAT, with the VAT on
> `2250 VAT payable` (seller; reserved today) and an input-VAT asset (buyer; no account yet). If Q5 is (b), nothing
> here changes. **No test may assert that a VAT line is absent.**

One worked order for every pattern: 10.000 kg pork belly (`raw_material`, so `1310`) at ₱310.00/kg = **₱3,100.00**,
FIFO cost ₱250.00/kg = **₱2,500.00**. The order carries no delivery fee (QO-6) and no pay-now (row 370).

### `trade_dispatch.franchise` — seller, at dispatch: a real sale, identical to an outside buyer's

Posted in the **commissary's organisation**, store = the commissary, dated the order's date. In code these are TWO
entries — the sale by `recordCharge` (`source_type = 'trade_order_dispatch'`, the AR charge) and the cost by
`postConsumption` (`source_id = <order>:1310`) — shown together, as `customer.return-ar` is.

| Account | Debit | Credit | Party |
|---|---:|---:|---|
| 1210 Accounts receivable | 3,100.00 | | customer (Padre Garcia) |
| 4300 Wholesale sales — **FENCED (Q5)** | | 3,100.00 | |
| 5100 COGS — food | 2,500.00 | | |
| 1310 Inventory — raw materials | | 2,500.00 | |
| *2250 VAT payable — **FENCED (Q5), not posted*** | | *—* | |

**Trap:** the legs are byte-identical to an external sale of the same lines (leg E1 compares against a control
order). The franchise branch adds **no** ledger line: what it adds is the shipment row, written in the same
transaction. ⛔ Never the `1340`/`1250`/`2150` internal shape: that eliminates, and between two companies nothing
eliminates. ⛔ `customer_group = 'franchise'` decides nothing; only `customers.counterparty_org_id` does (ADR-008 §2).
⛔ The credit limit gate inside `recordCharge` applies as for any customer (E27).

### `trade_receipt.franchise` — buyer, at PG's receipt: the stock arrives

Posted in **Padre Garcia's organisation** by PG's `receive_delivery` holder, store = PG's store, dated the receipt date,
through the existing `receiveDelivery` → `postReceiptValue` (`source_type = 'stock_receipt'`). The unit cost of the
new FIFO layer is the shipment's rate (₱310.00), never the commissary's cost, which PG cannot see.

| Account | Debit | Credit | Party |
|---|---:|---:|---|
| 1310 Inventory — raw materials — **FENCED (Q5)** | 3,100.00 | | |
| 2120 Goods received not invoiced | | 3,100.00 | |
| *input VAT asset — **FENCED (Q5), no account yet, not posted*** | *—* | | |

**Trap:** valued at **what PG received × the shipment rate**, never at the dispatched quantity (mutant: post at the
dispatched quantity → E7 red). Over-receipt is refused (received ≤ shipped per line, E20): an extra the commissary
did not bill is not PG's stock to book at a price nobody set.

### `trade_receipt.franchise-bill` — buyer, same transaction: the shipment is the bill

The shipment note is the commissary's bill, so PG's receipt also writes a system supplier bill for exactly the
received value and clears `2120` to `2110` (`source_type = 'stock_receipt_invoice'`, `linkInvoiceToReceipt`, variance
zero by construction). This is what gives PG an open AP item it can pay from its ordinary AP payment screen.

| Account | Debit | Credit | Party |
|---|---:|---:|---|
| 2120 Goods received not invoiced | 3,100.00 | | |
| 2110 Accounts payable | | 3,100.00 | supplier (the commissary, `suppliers.counterparty_org_id` = Ian's org) |

**Trap:** no `5450` line can arise (the bill equals the receipt to the centavo); one appearing means the receipt and
the bill were valued differently — a defect, not a variance. ⛔ Never `2110` without the bill row: `ap.openItems`
reads bills, so a bare `2110` credit would be a debt PG can see but never pay.

### `trade_dispatch.franchise_transit_shortage` — seller, after reconciliation: the credit note

PG received **8.000 of 10.000 kg**, so PG owes ₱2,480.00 (its two entries above at ₱2,480.00). The 06:30
reconciliation raises one `franchise_credit` discrepancy in the commissary's organisation; the commissary manager
posts this credit note, in the **commissary's organisation**, store = the commissary (A7). PG posts nothing — its
payable is already for what it received.

| Account | Debit | Credit | Party |
|---|---:|---:|---|
| 4950 Sales returns and voids — **FENCED (Q5)** | 620.00 | | |
| 1210 Accounts receivable | | 620.00 | customer (Padre Garcia) |
| 5300 Wastage and spoilage | 500.00 | | |
| 5100 COGS — food | | 500.00 | |

**Rules.**
- **Value = billed line total − round(received × rate, 2), per line**, summed: ₱3,100.00 − ₱2,480.00 = ₱620.00. Never
  `round(short × rate, 2)`, which can differ by a centavo from what PG actually booked (mutant → E7/E12 exact-centavo).
- **Cost = what the dispatch's own consumption relieved for the short quantity** (2.000 kg × ₱250.00, read from
  `stock_layer_consumptions` for that order line, pro-rata by quantity), never today's layers. It moves from COGS to
  loss: the goods left and were not sold.
- **Already collected?** Credit `1210` only up to what is still open on that charge; the rest goes to
  `2140 Customer store credits payable` (party = PG) in the SAME entry — `customer.return-credit`'s invariant 9.
- **After:** commissary AR for PG ₱2,480.00 = PG AP for the commissary ₱2,480.00. The next run is clean (E7).
- ⚠️ Per-line received quantities are only available to the commissary under **QI-1 (a)**. Under (b) the manager types
  the short quantity per line and the system refuses unless the lines value to the exact gap PG recorded.

**Trap:** ⛔ not `recordCustomerReturn`: nothing comes back, so no `1310` debit and no stock movement. ⛔ Not `5400`
(count variance): goods that left and did not arrive are a loss (`commissary.discrepancy-loss`'s distinction). ⛔ No
automatic write: a human posts the credit, from the discrepancy row.

#### Void (no new fixture — the generic Reversal pattern)

- **Before PG receives:** the commissary voids its order exactly as today — `voidCharge` mirrors
  `trade_dispatch.franchise`'s sale lines and `reverseConsumption` gives the 10.000 kg back to the layers it came from
  (`source_type = 'trade_order_dispatch_void'`). The shipment is marked `void` under the same `FOR UPDATE` lock as
  PG's receipt (A4), so PG's inbound list stops offering it. PG posts nothing.
- **After PG receives:** refused, naming the receipt (E10). The only corrections after receipt are this credit note
  or a paired return: PG's supplier return (`supplier.return-credit` / `-grni`, in PG's org) matched with the
  commissary's customer return (`customer.return-ar` / `-credit`, in Ian's org), each in its own organisation, paired
  by the reconciliation (E21). Never an edit, never a cross-org reversal.

---

## Appendix — fixture sketches for `tests/worked-examples/fixtures.ts` (S5a builder)

```ts
{ id: 'trade_dispatch.franchise', sourceType: 'trade_order_dispatch',
  title: 'Franchise dispatch, seller — a real sale, identical to an outside buyer',
  narrative: '10 kg at ₱310 to Padre Garcia, another company; FIFO cost ₱250/kg. Shown as one entry; the code posts the sale and the cost as two.',
  input: { customerId: 'CUST-PG', quantity: '10.000', rate: '310.00', unitCost: '250.0000' },
  expect: [ D('1210', '3100.00', { type: 'customer', id: 'customer:CUST-PG' }), C('4300', '3100.00', null),
            D('5100', '2500.00', null), C('1310', '2500.00', null) ],
  entryDate: '2026-12-01', trap: 'Byte-identical to an external sale; never the 1340/1250/2150 elimination.' },
{ id: 'trade_receipt.franchise', sourceType: 'stock_receipt', /* buyer org */
  expect: [ D('1310', '3100.00', null), C('2120', '3100.00', null) ], entryDate: '2026-12-02' },
{ id: 'trade_receipt.franchise-bill', sourceType: 'stock_receipt_invoice',
  expect: [ D('2120', '3100.00', null), C('2110', '3100.00', { type: 'supplier', id: 'supplier:SUP-COMMISSARY' }) ],
  entryDate: '2026-12-02' },
{ id: 'trade_dispatch.franchise_transit_shortage', sourceType: 'trade_order_credit',
  expect: [ D('4950', '620.00', null), C('1210', '620.00', { type: 'customer', id: 'customer:CUST-PG' }),
            D('5300', '500.00', null), C('5100', '500.00', null) ], entryDate: '2026-12-03' },
```
`trade_order_credit` is a new `source_type` — the builder checks it against the journal `source_type` CHECK (if one
exists) and the sourceType list the fixture harness accepts, and adds it in 0218 if needed. The fixtures post in one
org (the harness is single-org); the cross-org behaviour is proved by the S5 integration legs, not here.
