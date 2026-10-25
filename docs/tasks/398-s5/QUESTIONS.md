# T-398 S5 — questions

## For Ian (plain words; goes on the Open Questions page)

### QI-1 — What may the commissary see of Padre Garcia's receipt? (blocks S5e's credit note; S5b needs a default)

Today's answer (Q8 a, 10 Oct): per shipment, "Padre Garcia recorded ₱X", nothing else.
Example: you send 10 kg; PG records ₱2,480. You know ₱620 is missing, but not **which item** was short.
- **(a) Also show, per item on that shipment, how many PG received; plus one total "PG owes us ₱Y" figure.**
  The credit note is then exact (we know which goods went missing and what they cost us), and a payment one side
  forgot is caught automatically. It shows nothing of PG's prices, costs, other suppliers or staff — only your own
  goods, counted at the door.
- **(b) Keep it to the per-shipment total.** Your manager must ask PG which items were short and type them in; the
  system checks they add up to exactly the gap. A payment one side forgot is not caught by the system.
- **Recommended: (a).** It is your own goods, so it reveals nothing about PG's business, and it removes a manual step
  that will be wrong sometimes. Priority: high (needed before S5e, ≈ 20 Nov). If unanswered, S5 builds (b).

### Q5 — VAT (already asked; final answer due 13 Nov)

No change: S5 builds without VAT. Lines that would change are marked FENCED in the posting draft.

### QI-2 — Delivery fee to Padre Garcia (does not block; S5 builds the default)

Trade orders can carry a delivery fee. Should an order to PG?
- **(a) No separate fee; freight is priced into PG's price list.** (Default S5 builds.)
- **(b) Yes, a separate fee line** — then PG's books need a freight entry too (a small follow-on).
- **Recommended: (a)** — simpler, and the two companies' books cannot disagree about a fee.

## For the orchestrator / planner to rule (not Ian)

| Id | Question | Options | Recommend |
|---|---|---|---|
| **QO-1** (blocker for S5a/S5b/S5d) | Spec R5 says PG's receipt posts `DR 1310 / CR 2110`. Main's delivery path posts `CR 2120 GRNI`; `2110` only comes from a supplier bill → expense, and `ap.openItems` (`repo/ap.ts:653`) lists bills, so PG could not pay the commissary from its AP screen | (a) receipt as today (`2120`) + in the same transaction a system supplier bill for the received value, linked by `linkInvoiceToReceipt` (`DR 2120 / CR 2110`, first production caller), status verified, evidence = the shipment; (b) a new receipt posting straight to `2110` + teach `openItems` a non-bill open item | **(a)**: reuses the AP payment, ageing and open-items code unchanged. Spike first hour of S5d: does the two-person verify CHECK (`supplier_invoices_two_person_verification_check`) admit a system-created bill (`created_by` NULL), and must the bill carry an expense row to appear in `openItems`? If either fails, report before building — do not widen the CHECK silently |
| **QO-2** | Where the shortage to-do lives | (a) `trade_discrepancies` + disposition `franchise_credit` + `inter_entity_shipment_line_id`; the day-open block query excludes inter-entity rows; (b) a new table | **(a)**: one discrepancy screen; the block exists for goods stuck in `1340`, which a franchise sale never uses |
| **QO-3** | Seller order status after PG receives | (a) stays `dispatched`; order page shows "PG received on …" from the shipment; (b) the 06:30 job marks it `received` | **(a)**: the seller never writes on PG's evidence; avoids a system `received_by` |
| **QO-4** | Delivery row kind for a PG receipt | (a) new kind `inter_entity`, proof photo waived, `supplier_id` required; (b) kind `supplier` + a proof exemption | **(a)**: the CHECK states the rule; no special case hidden in `supplier` |
| **QO-5** | Reconciliation shape | findings detectors (derived live, both orgs — the "on demand" check) + a 06:30 job that only writes the seller's discrepancy rows | as stated; spec A3 binds the definer read |
| **QO-6** | Fees on an inter-entity order | refuse at create (default, QI-2 a) | refuse |
| **QO-7** | Lines RLS shape | both tables carry `org_id` + `buyer_org_id`, scope `dual_org_counterparty`, lines composite to header `(org_id, buyer_org_id, id)` | as stated (one registry kind, no derived dual predicate) |
| **QO-8** | Spec text now stale | §0b/§6/B5 say pay-now "pending Ian" — ruled by row 370; B8 `trade.test.ts:873` → `:890`; B8 "0209" → 0218; R5's `CROSS_ORG_BY_DESIGN` line superseded by A6; R5's "DR 1310 / CR 2110 via existing path" → QO-1 | fold as amendment E1-E5 when S5 starts |
| **QO-9** | Size | S5 re-sized 3.5 → ≈ 4.6 lane-days (QO-1 AP path, fixtures, job). With S6 merging after S5, the 1 Dec target for S5 needs S5 started by ≈ 24 Nov on one lane, or S5c ∥ S5d on two | confirm lane plan |

## Rulings (orchestrator, 2026-10-25)
- **QO-1: accepted.** At PG's receive, in the same transaction, a system supplier bill moves the liability from 2120
  (goods received, not billed) to 2110 (AP) via `linkInvoiceToReceipt`, so PG pays the commissary from its normal AP
  screen. ⛔ S5b/S5c first SPIKE whether the two-person verification CHECK (and 0217's self-verify rules) admit a
  system-created bill; if not, STOP and report: the fix is designed, not patched around.
- **QI-1 = (a) — Ian, 2026-10-25 ("QI-1 is a").** The commissary sees, per item on each shipment, how many PG received,
  plus one "PG owes us ₱Y" balance. Nothing else of PG's (prices, costs, other suppliers, staff). The credit note is
  computed from the per-item shortfall; a payment one side forgot is caught by the reconciliation. Amends Q8 (a).
  Bible row to be written at wrap-up (next free row).
- QO-2..QO-9 and QI-2: the planner's defaults stand.
- Migration number: **0218** (reserved on the coordination board).
