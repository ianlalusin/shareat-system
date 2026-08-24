# B2B order-to-cash — the minimum chain for a dozen wholesale meat buyers

**Date:** 2026-08-24
**Method:** Source code read directly (GitHub raw + API, not vendor docs). Three systems' sales
modules read at the controller/DDL level: **ERPNext** (`frappe/erpnext`, pinned
`ac2bacd3d08483523e874ea0b7fcaade5eca1bfb`, branch `develop`), **Odoo Community** (`odoo/odoo`,
pinned `cb286d53c2a2dc646e5f24fb9af4a8d002c40b7b`, branch `18.0`), **Tryton** (`tryton/sale`,
pinned `0b09b5c44f0df0a3c8425944b27107ed1168b636`, branch `develop`, plus `tryton/sale_credit_limit`
for the credit-limit add-on) — plus **Dolibarr** (`Dolibarr/dolibarr`, pinned
`a99e0dde8a9bde2432430e58130e637570e73cc1`, branch `develop`) read specifically for the
"how little can this chain be" question, since it is the lightest of the four. Odoo's stock-valuation
files (`odoo_stock_move.py`, `stock_controller.py`) were already on disk from the prior (17)
research pass and re-used here for the revenue-recognition question rather than re-fetched.

**Read first, honored throughout:** `docs/RULES.md` §3.6 (research informs, never decides);
`docs/discovery/17-industry-erp-patterns.md` (the format this document matches, and several of
its findings — credit-account-on-the-line, the AP/AR party-on-journal-line decision — are load-
bearing here too, not re-litigated); `docs/decisions/ADR-008-multi-company-and-inter-entity-trade.md`
(all 11 sections — this is the decision this research is scoped to leave open, not re-argue);
`docs/decisions/COA-ALIGNMENT.md`; `PROJECT_BIBLE.md` §1.1, §16, decision rows 103–112;
`docs/POSTING-PATTERNS.md` (41 worked examples — every posting recommended below is checked
against these, not invented alongside them).

**The business, restated so the verdicts below are legible:** a commissary selling raw meat in
bulk to roughly a dozen named restaurants, staff-entered (not self-service), on credit terms.
Retail diners are explicitly not accounting customers (ADR-008 §11). One live franchise exists on
the same system today. ADR-008 §8 has **already decided** the order/fulfilment shape: one shared
document, counterparty-derived accounting treatment, lifecycle `ordered → picked → dispatched →
received`. This research does not reopen that. It asks what a real order-to-cash system needs
*downstream* of that document — invoicing, payment, returns, credit — that ADR-008 left open.

---

## 1. The order-to-cash document chain — a tree, not a chain, and less is mandatory than it looks

The task brief frames this as Quote → Sales Order → Delivery Note → Invoice → Payment. Reading the
actual controllers shows something more useful: even ERPNext, the most document-heavy system
studied, does not treat this as one serial chain.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 1.1 | **Delivery Note and Sales Invoice are both independent children of Sales Order, not serial links.** `make_delivery_note` and `make_sales_invoice` are two separate top-level functions, both taking `"Sales Order"` as their *source* doctype — an invoice can be created directly from the order with no Delivery Note in between | ERPNext — `erpnext/selling/doctype/sales_order/mapper.py:232` (`make_delivery_note`) and `:432` (`make_sales_invoice`), both mapping from `"Sales Order"` | This is our own stated reference system, and it does not enforce the serial chain the task brief describes | **The "chain" framing is generous to the generality.** Even ERPNext treats Quote→SO as optional (see 1.5) and DN as an optional sibling of SI, not a mandatory predecessor | Corrects the framing, not a row to adopt/skip on its own |
| 1.2 | **Whether a Delivery Note is even required before invoicing is an explicit, per-item-group setting**, not a hardcoded rule | ERPNext — `erpnext/accounts/doctype/sales_invoice/sales_invoice.py:866`, `"Delivery Note": ["dn_required", "update_stock"]` gate | One vendor's own configurability — but revealing: the system that supports full three-doc chains still ships a switch to skip the middle one | Confirms a Delivery Note is a **should**, not a **must**, even in the heaviest reference system | Informs 1.6 below |
| 1.3 | **Dolibarr bills directly from a validated order with no shipment document at all.** An order can be invoiced (`facture=0` cleared) the moment its status is `VALIDATED`; `SHIPMENTONPROCESS` is one *optional* intermediate status among several an order can pass through before `CLOSED`, never a required gate | Dolibarr — `htdocs/commande/class/commande.class.php:393-416` (status constants), `:3693-3698` (an "order to bill" query matches `STATUS_VALIDATED` directly, no shipment required) | The lightest of the four systems studied treats delivery tracking as optional bookkeeping, not a gate on billing | Directly answers "what does the omission cost": for a business that dispatches and bills in the same act (which ours may — see §2.5), a delivery note is **pure traceability**, not a control | ADAPT — a fulfilment *status*, not a separate mandatory *document* |
| 1.4 | **Tryton collapses Quote/SO/DN/SI into ONE `sale.sale` record.** States are `draft → quotation → confirmed → processing → done`; a single `process()` step auto-creates the invoice and the shipment as *separate records*, but the sale itself is one document the whole way through, and `invoice_method` (`manual` / `order` / `shipment`) decides *when* | Tryton — `sale.py:262-266` (state enum), `:838-854` (`create_invoice`), `:899-940` (`create_shipment`), `:191-194` (`invoice_method`) | One vendor's design, but the one closest in spirit to a small, staff-run operation rather than a multi-department enterprise | **This is the closest published precedent to what ADR-008 §8 already chose** — one order document, status-driven, invoice/shipment as *derived* records rather than independently re-keyed ones | ADOPT (already decided, ADR-008 §8) — now corroborated by a second real system, not merely argued from first principles |
| 1.5 | **The Quotation step exists specifically for the self-service/negotiation case** (`Quotation.update_opportunity("Converted")`) — it is the record of an offer that may or may not be accepted, tracked separately from the order itself | ERPNext — `erpnext/selling/doctype/sales_order/sales_order.py:441-448` | Standard wherever a sales team negotiates before a customer commits | **Genuinely not needed here.** ADR-008 §11: staff-entered, not self-service, ~12 named buyers with an ongoing relationship. A quote step exists to record a negotiation that, for repeat wholesale buyers on a standing price list, has already happened once — at customer setup, not per order | DELIBERATELY SKIP — the price list *is* the standing quote; a new quote document per order would be ceremony this business does not have |
| 1.6 | **What the multi-document shape buys, concretely: "delivered but not yet billed" becomes a queryable position** feeding the credit-limit calculation (see §4.2) — something a single-document, single-status model loses unless the status transition itself is timestamped and queryable | ERPNext — `erpnext/selling/doctype/customer/customer.py:733-793`, the `outstanding_based_on_dn` subquery | Common wherever partial fulfilment and partial billing can diverge | **This is the one thing worth protecting when collapsing ADR-008's one-document model**: `dispatched` and `received`/`billed` must remain distinct, queryable states on that one document — not collapsed into a single "done" flag — or the business loses visibility into goods that have left the building but not yet been billed | ADOPT the *principle* (keep dispatch and billing as separately timestamped states) inside the one-document model, not as separate documents |

**The minimum viable chain, stated plainly:** for ~12 staff-entered wholesale buyers on standing
prices, the load-bearing states are **order → dispatched → billed → paid**. Quote is unneeded
(1.5). A separate Delivery Note document is unneeded (1.3, 1.4) — its *information* (what shipped,
when, not yet billed) must survive as a status and a timestamp on the one order document, not as a
second document. What is **not** optional, in any system studied, is a real billing event that
creates a receivable, and a real payment event that clears it — sections 2 and 5.

---

## 2. Revenue recognition, and how delivery and invoice avoid double-counting

This is the risk the brief names explicitly (the ₱198,148.29 platform-fee double-count), so the
mechanism matters more than the label.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 2.1 | **Revenue and the receivable recognise only at the invoice, never at delivery**, in both flagship systems | ERPNext — `sales_invoice.py:463` (`self.make_gl_entries()` inside `on_submit`); Delivery Note's own `on_submit` posts stock movement only, no revenue account. Odoo — revenue posts on `account.move` (the invoice), never on `stock.move` | Genuinely standard — this is the "Anglo-Saxon perpetual" pattern already confirmed by the prior research pass (17 §2.5) | Confirms the general shape: whatever document *is* our invoice-equivalent is the only thing allowed to touch 4xxx/1210 | ADOPT (already implied by our COA; now confirmed at the sales side, not just inventory) |
| 2.2 | **COGS/inventory-value DOES post at delivery**, but through an **interim/clearing account structurally separate from revenue and receivable** — so the delivery-time entry and the invoice-time entry can never collide on the same account pair even if both fire | Odoo — `_account_entry_move` / `_prepare_anglosaxon_account_move_vals`, `odoo_stock_move.py:708-770`, gated by `company_id.anglo_saxon_accounting` | Common wherever perpetual inventory and invoice-time revenue coexist | **This is the actual double-count guard, and it is structural, not procedural**: the two events are kept apart by writing to *different accounts*, not by a rule someone has to remember not to violate | ADOPT the principle — matches our own already-decided fix for the platform-fee bug (`ar_collection` pattern: the fee is booked **once**, at collection, and never again as a separate expense — POSTING-PATTERNS.md, `ar_collection.with-platform-fee`). Same shape, different bug class |
| 2.3 | **Revenue-recognition timing is itself a configurable policy per sale**, not a system-wide constant | Tryton — `invoice_method` (`manual` / `order` / `shipment`), `sale.py:191-194`, `:678-686` | One vendor's choice, genuinely useful as a menu of the real options, not evidence any one is universal | Useful vocabulary for §2.5's decision: our choice is really "which `invoice_method` does a wholesale dispatch use" | Informational — see §2.5 |
| 2.4 | **A v1-shaped danger this class of bug lives in: two code paths writing the same account for the same event.** Our own confirmed defect (₱198,148.29) was exactly this — a platform fee booked once as part of collection AND once again as a manual expense document, same account, same event, twice | `docs/POSTING-PATTERNS.md`, `ar_collection.with-platform-fee` — already fixed by construction (one function owns the posting) | N/A — this is our own history, checked against the field | The Odoo interim-account pattern (2.2) is the *general form* of the fix we already applied to one specific instance: keep the accounts that two different events can touch **non-overlapping**, so even a bug that fires both events cannot double-post to the same line | ADOPT — worth stating in `POSTING-PATTERNS.md` as the general principle, not just the specific fixed instance |

### 2.5 The decision this section actually hands the planner

Given §1's finding that dispatch and billing don't have to be separate documents, there are two
real options for the wholesale flow, and they are **not** equivalent:

| | **Dispatch = the billing event** | **Dispatch and billing can diverge** |
|---|---|---|
| Mechanism | `dispatched` posts `DR 1210 AR / CR 4xxx Revenue / CR 5xxx COGS` in one entry — exactly today's `commissary_dispatch` shape, generalised | `dispatched` posts only the stock movement (no revenue); a separate `billed` step, batching one or several dispatches, posts revenue+AR |
| Matches | Dolibarr's default (§1.3); most PH small-wholesale practice for a dozen named buyers billed per delivery | Odoo's interim-account model (§2.2); needed if buyers get one weekly invoice for several deliveries |
| Cost | None extra — no new document, no unbilled-dispatch tracking needed | A real interim/clearing account (`5xxx COGS` still posts at dispatch; revenue waits), and an "unbilled dispatches" report so nothing is forgotten |
| Risk if wrong | If buyers actually want consolidated invoices, this either forces one-invoice-per-delivery on them (a customer-facing downgrade) or forces a later redesign | If dispatch-only tracking is built but buyers are always billed per-delivery, it's unused generality — cost paid for nothing |

**Recommendation:** dispatch = billing event, unless Ian confirms any current or expected wholesale
buyer wants period-batched invoicing. This is a real fork, not a detail — see "the three things for
the planner."

---

## 3. Price lists

ADR-008 §3 already decided the shape ("a price list attached to the customer... this is standard,
it is what Ian named, and it needs no invention"). This section checks that decision against the
field and finds it under-specified in one place, not wrong.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 3.1 | **A price record is scoped by item, price list, and optionally customer, with effective dates** (`valid_from`/`valid_upto`) | ERPNext — `erpnext/stock/doctype/item_price/item_price.py:20-43` (`customer`, `valid_from`, `valid_upto` fields), `:87-134` (uniqueness check across exactly this key) | Common, and matches ADR-008 §3's own description almost exactly | Corroborates an already-decided design | ADOPT (already decided) |
| 3.2 | **The rate is captured onto the order line at creation and travels forward unchanged** — every downstream document-mapping function copies `rate` from source to target rather than re-deriving it from the current price list | ERPNext — `erpnext/selling/doctype/sales_order/mapper.py`, `field_map: {"rate": "rate"}` at every `make_delivery_note` / `make_sales_invoice` / `make_purchase_order` call site (e.g. `:334`, `:589-591`) | Universal wherever a price is meant to be an agreed, not a live-quoted, figure | **This directly answers the brief's question** ("whether historical orders keep their original price"): yes, by construction — a price-list change never retroactively touches an already-created order line, only documents created *after* the change | ADOPT — and state it explicitly (3.4) |
| 3.3 | **Odoo's `product.pricelist.item` is a full rules engine** — four `applied_on` levels (global / category / product / variant), `min_quantity` volume breaks, date ranges, formula-based computation | Odoo — `addons/product/models/product_pricelist_item.py:8-70` | One vendor's choice, and a materially heavier feature than ERPNext's own `Item Price` | **ADR-008 §3 already named this exact class of feature ("pricing rules... volume breaks, date-ranged promotions") as out of scope**, and this confirms it: Odoo's version is heavier again than the ERPNext Pricing Rule doctype (`erpnext/accounts/doctype/pricing_rule/pricing_rule.py`, 22KB) that the same section already declined to adopt | DELIBERATELY SKIP — ADR-008 §3, now corroborated by a second, heavier reference rather than reconsidered |
| 3.4 | **ADR-008 §3 says "a price list attached to the customer" but does not say the rate is captured, not live-referenced.** This is a real gap: the project's general instinct (bible §4.2 rule 7, "a view, not a hand-maintained row") pulls the *opposite* direction from what a price needs here | N/A — gap in our own design, exposed by comparison | N/A | **Get this backwards and a price-list edit silently reprices every open, undispatched wholesale order** — the correct behaviour for an *agreed* price is the frozen value, and only a fresh order (or an explicit re-price action before dispatch) should ever pick up a new number | NEEDS IAN / Opus — one line in whatever schema doc governs order lines: the rate column is captured at line-creation, never a live join to `price_lists` |

---

## 4. Credit limits and credit holds

The four systems studied give four genuinely different answers to "how much credit-limit
machinery belongs in the base flow" — useful precisely because it is not a consensus.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 4.1 | **A hard block by default, checked at THREE independent document-submit hooks** (Sales Order, Delivery Note, Sales Invoice), each importing and calling the same `check_credit_limit()` function, with a named "credit controller" role able to override and an email-the-controller escape hatch for everyone else | ERPNext — `erpnext/selling/doctype/customer/customer.py:514-572` (the check + override flow); called from `sales_order.py:519-529`, `delivery_note.py:569-598`, `sales_invoice.py:658-676` | One vendor's choice — the most thorough of the four, and the most expensive | The override mechanism (named role, not a blanket admin bypass) matches our own already-adopted "admin/manager bypass gates" pattern in spirit | ADAPT — the *control* (block + role override) is worth having; the *three separate check points* are not (see 4.3) |
| 4.2 | **Credit exposure is computed from THREE sources, not just the ledger**: the GL receivable balance, plus the un-billed portion of open Sales Orders, plus the un-billed portion of delivered-but-not-invoiced Delivery Notes | ERPNext — `customer.py:705-793` (`get_customer_outstanding`), specifically the `outstanding_based_on_so` and `outstanding_based_on_dn` subqueries | Necessary *only* where order, delivery and invoice are genuinely separate documents that can drift apart in time | **This is a direct consequence of §1's multi-document chain, not an independent design choice.** If dispatch = billing (§2.5's recommended default), this three-source aggregation collapses to just the GL balance — simpler, and with no window where shipped goods are invisible to the credit check | ADOPT the *simplified* version (GL balance only) contingent on §2.5's recommendation; the three-source version is only needed if dispatch and billing diverge |
| 4.3 | **Checking credit limit at three separate document hooks is exactly the "enforced by remembering, not by construction" anti-pattern this project's own rules already name** (RULES §6.3, bible row 104) — one function, three call sites, each of which could be forgotten on a future fourth document type | Ours — the observation, checked against ERPNext's own code | N/A | A caution to carry alongside adopting the underlying control: our design should have **one** gate, not three, precisely because ADR-008 §8 already gives us one document instead of three | DELIBERATELY SKIP the multi-hook shape — check once, at the point of no return (dispatch) |
| 4.4 | **Odoo Community computes the same figure but only ever displays it as a UI warning banner — never blocks.** `_build_credit_warning_message`'s own docstring: *"the warning message... displayed in a yellow banner."* No `action_confirm` or `action_post` path reads this field to raise | Odoo — `addons/account/models/account_move.py:1858-1905`; confirmed by grep across `sale_order.py` showing `partner_credit_warning` is never referenced from `action_confirm` (`:1145`) | One vendor's choice — informational-only, by explicit design | A legitimate lighter alternative to ERPNext's hard block | ADAPT — informs the choice in 4.6, not adopted wholesale |
| 4.5 | **Tryton does not ship credit-limit checking in the core `sale` module at all.** It is a separate, optional add-on (`sale_credit_limit`, ~27 lines) that hooks the existing `confirm()` transition via `PoolMeta` inheritance | Tryton — `tryton/sale_credit_limit/sale.py` (full file read; `must_check_credit_limit`, `credit_limit_amount`, and a wrapped `confirm()`) | One vendor's choice, and instructive precisely because it is a *third* answer, not a variation on the first two | Shows how cheap a credit-limit gate is to add cleanly **when the base flow is a single, well-factored transition** — exactly the shape ADR-008 §8 already gives us | Informational — the smallest working reference implementation among the four |
| 4.6 | **Dolibarr stores an `outstanding_limit` field on the customer record, computes the actual outstanding via `getOutstandingBills()`, and checks it NOWHERE** — grepped across both the order and invoice controller classes, the field is written and read for display but never compared against anything before a document posts | Dolibarr — `htdocs/societe/class/societe.class.php:243,760,1503,1722,2200`; absence confirmed by grep across `commande.class.php` and `facture.class.php` | A real, shipped, negative example — not a hypothetical | **This is exactly the failure shape our own rules warn about**: a field that *looks* like a control (named, typed, shown on screen) but enforces nothing is worse than no field at all, because it reads as safety that isn't there | Cite as the negative example — do not ship a `credit_limit` column without the check that makes it real |

**Recommendation, stated once (see also §16.4):** a `credit_limit` on the customer record, an
admin/manager-role override (matching our existing bypass pattern), checked at exactly one gate —
dispatch, the point of no return under §2.5's recommended model. **§16.4 already deliberately
omits "payment-terms schedules, dunning, credit scoring."** A credit *limit* is not credit
*scoring* — scoring predicts risk from behaviour; a limit is a stored number and a comparison,
the same shape as the statutory-obligation tracking §16.5 already commits to. Worth a one-line
clarification in §16.4 so a future reader doesn't read "credit scoring" as covering this and skip
a control a receivables book this size genuinely needs.

---

## 5. Partial everything — delivery, invoice, and payment against several invoices

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 5.1 | **Partial fulfilment is tracked as an explicit remaining-quantity computation on every downstream mapping**, not a status flag — `get_pending_qty`, `get_billed_qty_by_item` recompute from the actual sum of already-invoiced quantities each time, rather than trusting a cached running total | ERPNext — `erpnext/selling/doctype/sales_order/mapper.py:450-476` | Standard wherever partial fulfilment is real | Matches our own "derive, don't hand-maintain" instinct (bible §4.2 rule 7) — the remaining quantity is a query result, not a field someone updates | ADOPT (matches an existing principle; worth the explicit citation) |
| 5.2 | **A single payment allocates itself across several outstanding invoices for the same party**, oldest-first by default, via a `references` child table where each row carries its own `outstanding_amount` and gets its own computed `allocated_amount` | ERPNext — `erpnext/accounts/doctype/payment_entry.py:1635-1724` (`allocate_amount_to_references`) | Common wherever a party can carry several open items at once | **This is exactly bible §16.10's already-adopted rule** ("payments must name the open items they settle... no floating cash") extended to the multi-invoice case | ADOPT (already decided in principle; this is the concrete multi-invoice mechanics we don't yet have a worked example for — see below) |
| 5.3 | **Our own `POSTING-PATTERNS.md` has the single-item shape (`ar_collection.with-platform-fee`, `ap_payment.overpayment`) but no worked example of one payment settling several open items for the same party** — the normal case for ~12 wholesale buyers paying a lump sum against several weeks of dispatches, not an edge case | `docs/POSTING-PATTERNS.md` — gap, checked against the field | N/A | A genuine, currently-missing worked example, not a new mechanism — invariant 6 and the party-on-journal-line model (bible row 98) already make it representable; it just hasn't been written down | ADD — a new POSTING-PATTERNS fixture (e.g. `ar_collection.multi_invoice`), Phase 2 |
| 5.4 | **ERPNext needed a separate `Payment Ledger Entry` table specifically because its `GL Entry` rows don't carry the same per-line party-and-status richness our `journal_lines` already will** — `get_outstanding_invoices_for_customer` reads the *Payment Ledger*, not the GL, precisely because the GL alone can't answer "which invoices, aged how" | ERPNext — `customer.py:648-670`; contrasted with our own row 98 (party on the journal line itself) | N/A — an artifact of ERPNext's own two-table history | **Our design is already ahead of this specific problem**, not behind it: `party_type`/`party_id` on `journal_lines` (already decided) makes the open-item-aging query a `GROUP BY` over the one ledger table, without needing a second parallel ledger the way ERPNext does | Worth noting as a place we do **not** need to replicate a structure ERPNext only has for historical reasons |

---

## 6. Returns and credit notes for B2B

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 6.1 | **A return is a NEW document of the same type** (`is_return=1`, `return_against=<original>`), with **quantities negated but the unit rate preserved unchanged**, flowing through the exact same posting logic as a normal sale and naturally producing reversed signs | ERPNext — `erpnext/controllers/sales_and_purchase_return.py:450-608` (`make_return_doc`); rate is never touched, only `qty`/`stock_qty`/`received_qty` are multiplied by `-1` | Standard wherever "credit note" exists as a concept | **Confirms a rule worth stating explicitly for our own future return pattern**: credit back at the ORIGINAL transaction price, never the current price-list rate — the natural mistake is to re-price on return | ADAPT — the rule (original price, not current), not the document-level mechanism (see 6.2) |
| 6.2 | **Our own model achieves the same economic effect at the ledger level already** (`reverseEntry`, T-106): swap debit/credit, same party, a new dated entry that never touches history. ERPNext's document-level return exists because its GL posting is *derived from* a document; ours can reverse the ledger directly without needing a fictional "negative invoice" | Ours — T-106, `docs/POSTING-PATTERNS.md` "Reversal — the correction path" | N/A — comparing our own already-adopted mechanism against a real alternative | Confirms `reverseEntry` is the right mechanism for the *ledger* side of a B2B return; ERPNext's document-level return is solving a problem (deriving GL from documents) we don't have | ADOPT (already decided) — no change needed to the reversal mechanism itself |
| 6.3 | **What ERPNext's return model does that a pure ledger reversal does not: it also reverses the STOCK movement** — a return re-adds quantity to inventory in the same document that reverses the sale | ERPNext — same `make_return_doc`, item quantities feed back into `Stock Ledger Entry` on submit | Necessary wherever a return is of physical goods, not merely a billing correction | **A genuine gap for a wholesale MEAT return** (spoiled, wrong item, short-dated): `reverseEntry` alone corrects the ledger but does not, by itself, put the meat back in inventory. A wholesale return needs a `reverseEntry` **paired with** an inventory receipt, not a novel mechanism | ADD (Phase 3, once inventory exists) — name this pairing explicitly in whatever return pattern gets written; do not assume `reverseEntry` alone is sufficient for a physical-goods return |

---

## 7. ⭐ Inter-company sales within one instance

This is the section ADR-008 §4 and Open Q2 leave genuinely unresolved, and it is directly
load-bearing: the commissary will sell to a franchise on the same system.

| # | The pattern | Who does it | How standard | Relevance to us | Verdict |
|---|---|---|---|---|---|
| 7.1 | **Neither system auto-creates the counterparty document on submit. It is always an explicit, human-triggered "Create" action** using a generic document-mapper (`get_mapped_doc`), never a database trigger or an `on_submit` side effect | ERPNext — `sales_order.js:1649` (`make_inter_company_order`), `sales_invoice.js:520` (`make_inter_company_invoice`), `purchase_invoice.js:413`, all calling `erpnext...mapper.make_inter_company_transaction` (`erpnext/accounts/doctype/sales_invoice/mapper.py:180-283`) | Consistent across every inter-company code path found in ERPNext | **Directly answers the brief's question.** "Does it auto-create the counterparty document" — no, by deliberate design, in the one system studied that has this feature working end to end | ADAPT — the *principle* (never silent, always a deliberate act), not the specific two-document mechanism (see 7.3) |
| 7.2 | **Odoo Community ships NO inter-company mechanism at all** — confirmed against the live `18.0` addons directory (626 top-level module folders, zero matching `inter_company` or `intercompany`) | Odoo — `GET /repos/odoo/odoo/contents/addons?ref=18.0`, checked directly, this session | Re-confirms and sharpens the prior research pass's finding (17 §3.1, which described "a settings toggle pointing at code that isn't shipped") with fresher evidence: as of the current commit there is not even a stub visible in Community | Corroborates 17 §3.1 rather than reopening it | DELIBERATELY SKIP (already the standing verdict, now doubly confirmed) |
| 7.3 | **We don't need ERPNext's general mechanism at all, because we never have two separate documents to begin with.** ADR-008 §8 already collapsed the entire external/franchise/branch flow into ONE shared order document with counterparty-derived treatment (§2) — there is no "Sales Invoice on Company A creates a linked Purchase Invoice on Company B" ceremony to replicate, because there was only ever one row | Ours — ADR-008 §2, §8, checked against ERPNext's two-document reality | N/A | **Our design is structurally simpler here than the reference system**, not behind it — worth stating plainly so nobody imports ERPNext's two-document dance as if it were the standard we're missing | Confirmed: our shape is already the leaner one |
| 7.4 | **What we DO need an analog for is ADR-008's own Open Q2** ("does v2 post the franchisee's side automatically?"). ERPNext's answer — never automatic, always a deliberate click — maps directly onto ADR-008 §8's existing fulfilment lifecycle: `ordered → picked → dispatched → received`. **Recommendation: the "received" step, done by the buyer/franchisee, is what creates their side's posting** (`DR Inventory / CR AP`), not the seller's `dispatched` action | Synthesis of 7.1 and ADR-008 §8's own lifecycle, not a new source | N/A | This both matches ERPNext's "never silent" convention and gives Open Q2 a concrete mechanism instead of leaving it open: dispatch creates the seller's entry and a *draft* of the buyer's; receipt confirmation posts the buyer's side for real. It also matches physical reality — goods can arrive short or damaged, so the buyer confirming what actually landed is a genuine control, not ceremony | ADOPT as the answer to ADR-008 Open Q2, for the case where both parties are on the same instance |
| 7.5 | **The two sides' reconciliation cannot inherit the same-transaction guarantee our intra-company due-from/due-to pair has.** `commissary_dispatch.transfer` posts both stores' legs in ONE journal entry because both stores are rows in one database with no isolation between them (bible landmine #27's fix). An inter-**org** trade, once RLS (bible row 112) is adopted, has the seller's org and the buyer's org as genuinely isolated principals — there is no single transaction that can span both | Ours — checked against ADR-008 §9's own RLS design and §4's reconciliation language | N/A | ADR-008 §4 already says the receivable and payable "must reconcile" but describes it in the same breath as invariant 6's reciprocal check, which IS same-transaction. **This is weaker, and should be named as weaker**: a periodic cross-org reconciliation query, not a live constraint | NEEDS IAN / Opus — state explicitly in whatever supersedes the `commissary_dispatch` franchise pattern that this reconciliation is a scheduled check, not a transactional guarantee, so nobody designs it expecting the stronger property |

---

## 8. What these systems get wrong or over-build

| # | The finding | Evidence | Relevance to us |
|---|---|---|---|
| 8.1 | **ERPNext's document-mapper file for Sales Order alone generates NINE different downstream document types** (Maintenance Schedule, Material Request, Project, Delivery Note, Sales Invoice, drop-ship Purchase Order, Pick List, Work Orders, Production Plan, Raw Material Request, Inter-company Purchase Order, Subcontracting Inward Order) in a single ~1,150-line file | `erpnext/selling/doctype/sales_order/mapper.py`, full file read | A twelve-buyer meat wholesaler needs at most two of these (dispatch, invoice). **DELIBERATELY SKIP** the general "any document can spawn any other document" mapper framework — a fixed two-or-three-step flow, hardcoded, is correct here, not a simplification that loses something |
| 8.2 | **Checking the same rule at three separate document hooks** (§4.3) is what generality costs even inside one vendor's own codebase — three call sites is three places to get it right, and three places for a fourth future document type to forget | `customer.py` `check_credit_limit` called from three files | Direct argument for the single-gate design recommended in §4 |
| 8.3 | **Odoo's Pricelist Item rules engine** (§3.3) is a full parallel data model — category rules, quantity breaks, formulas, date ranges — for a pricing need ADR-008 §3 already scoped down to "one price list per customer" | `addons/product/models/product_pricelist_item.py` | Corroborates an already-made DELIBERATELY SKIP, not a new finding |
| 8.4 | **No system studied enforces "shipped-but-unbilled must eventually become a receivable" as a hard rule.** ERPNext's own credit-limit query treats it as informational input to a warning/block, never as a standalone SLA with its own alert. If our wholesale flow ever needs a "dispatched 5 days ago, still not billed" alert, that is something we would be **adding**, in the spirit of COA-ALIGNMENT §2's "clearing accounts... monitored to zero" language, not adopting from a reference system | Absence, checked across `customer.py`, `sale_order.py`, `commande.class.php` | Names a real gap in all four references — worth having if §2.5 chooses the "dispatch and billing can diverge" option; moot if dispatch = billing |
| 8.5 | **Dolibarr's `outstanding_limit` field is a shipped, real-world instance of a control that looks real and enforces nothing** (§4.6) | `societe.class.php`, confirmed absent from both `commande.class.php` and `facture.class.php` | The clearest negative example in this research pass — worth keeping as the concrete "don't do this" reference the next time a credit or limit field gets added anywhere in the system |

---

## What we have not thought about

1. **Whether dispatch is the billing event or can diverge from it (§2.5) is not yet decided**, and
   it changes the credit-exposure calculation (§4.2), whether an "unbilled dispatch" report is
   needed (§8.4), and whether an interim/clearing account is needed at all. This is the single
   largest open fork in this document.
2. **`journal_entries`/order-line schema does not yet say the captured price is frozen at
   line-creation, not a live join** (§3.4). Cheap to state now; expensive if a report or an edit
   path is built against a live price-list join before this is written down.
3. **§16.4's "payment-terms schedules, dunning, credit scoring" omission does not clearly cover or
   exclude a plain credit LIMIT** (§4, closing recommendation). A one-line clarification avoids a
   future reader skipping a control this scale of receivable needs, or building the scoring
   machinery §16.4 correctly rejects.
4. **`POSTING-PATTERNS.md` has no multi-invoice, single-payment worked example** (§5.3) — the
   normal case for a wholesale buyer paying a lump sum against several weeks of dispatches, not an
   edge case, and not a new mechanism to design, just a fixture to write.
5. **A wholesale physical-goods return needs `reverseEntry` paired with an inventory receipt**
   (§6.3), and nothing currently names that pairing. Phase 3-gated, but worth flagging now so it
   isn't designed as a ledger-only fix later.
6. **ADR-008's inter-org reconciliation (§7.5) needs to be named explicitly as a periodic check,
   not a same-transaction guarantee**, before whoever writes the franchise-sale posting pattern
   assumes it inherits invariant 6's stronger property by association with the due-from/due-to
   pair it superficially resembles.

---

## Where we diverge, and whether that is deliberate

| Divergence from common practice | Recorded decision? | Assessment after this research |
|---|---|---|
| One shared order document instead of separate Quote/SO/DN/SI doctypes | **Yes** — ADR-008 §8 | Corroborated, not merely asserted: Tryton's single `sale.sale` record (§1.4) and Dolibarr's optional-shipment model (§1.3) are real precedent for exactly this shape, not an invented simplification |
| No self-service quotation step | **Yes** — ADR-008 §11 (staff-entered) | Confirmed correct: ERPNext's own Quotation doctype exists to solve a negotiation problem this business does not have at the wholesale layer (§1.5) |
| One price list per customer, no pricing-rule engine (volume breaks, date ranges) | **Yes** — ADR-008 §3 | More strongly validated than ADR-008 itself claims: Odoo's Pricelist Item (§3.3) is heavier again than the ERPNext Pricing Rule doctype ADR-008 already declined |
| Party (`party_type`/`party_id`) on the journal line itself, not a separate Payment Ledger table | **Yes** — bible row 98 | Confirmed as *ahead of*, not behind, ERPNext's own design: ERPNext needed a second ledger table specifically to work around a limitation our schema doesn't have (§5.4) |
| Whether dispatch = billing, or the two diverge | **Not decided** — a genuine, load-bearing gap (§2.5) | The most consequential open item in this document |
| Whether a credit limit is enforced, and where | **Not decided** — §16.4 is ambiguous on limit vs. scoring | Real fork identified (§4), with a specific recommendation (one gate, at dispatch) |
| Whether an inter-org (franchise/wholesale) counterparty posting is automatic or requires confirmation | **Open** — ADR-008 Open Q2 | This research proposes a specific answer (§7.4: bind it to the existing `received` status), not just a menu of options |

---

## The three things for the planner

1. **Does a wholesale dispatch *become* the invoice, or can invoicing lag and batch several
   dispatches?** This is not a detail — it decides whether an interim/clearing account is needed at
   all (§2.2, §2.5), whether credit exposure needs to look beyond the GL balance (§4.2), and
   whether an "unbilled dispatch" report is required (§8.4). **Recommendation: dispatch = the
   billing event**, matching the lightest system studied (Dolibarr, §1.3) and the standard PH
   practice for a small, named wholesale buyer list billed per delivery. Revisit only if Ian
   confirms a specific buyer wants period-batched invoices — that is a stated, visible trigger,
   not a guess to build ahead of.

2. **Is a credit limit worth enforcing at this scale, and where?** Three of four systems studied
   answer differently (hard block / warning-only / separate opt-in module), and the fourth
   (Dolibarr) is the cautionary tale of a limit field that enforces nothing. **Recommendation:
   yes, enforce it — a dozen buyers on credit terms is exactly where an unbounded receivable is a
   real risk, not a theoretical one — but check it at exactly ONE gate (dispatch, under
   recommendation 1), with an admin/manager override, matching our existing bypass pattern.** Do
   not replicate ERPNext's three-separate-check-points shape (§4.3) — we don't have three
   documents to check it on, and building three gates for one document would be generality with
   no corresponding need.

3. **When the commissary dispatches to the franchise, does the buyer's `DR Inventory / CR AP`
   entry post automatically, or does it wait for their confirmation?** ADR-008 Open Q2 leaves this
   unanswered. **Recommendation: bind it to the `received` status already in ADR-008 §8's own
   fulfilment lifecycle** — the seller's entry posts at `dispatched`; the buyer's posts at
   `received`, when they confirm what actually arrived. This matches every reference system's
   convention that inter-entity postings are never silent (§7.1), and it makes the eventual
   receivable/payable reconciliation (§7.5) a check against a real confirmed fact on both sides,
   not a guess based on what the seller says was sent.
