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
- **S5b tester questions (orchestrator, 25 Oct):** (1) "linked as franchisor/franchisee" = the trade order's customer
  carries `counterparty_org_id = buyer_org_id`, enforced in the database (trigger or CHECK); shipping to an unlinked org
  is refused. (2) Over-receipt / second-receive sentences: builder words them plainly; tests pin the meaning only.
  (3) Scheduler job list: carry every job from the newest earlier migration (0217 adds none). (5) Void columns:
  `voided_at`, `voided_by`, `void_reason` on `inter_entity_shipments` (all three or none); the tester adds the void legs
  after the build.

## S5a+S5b audit (25 Oct) — must be fixed before S5's PR; next session starts here
1. **HIGH (branch red):** `inter_entity_reconcile` is in SCHEDULER_JOBS (schema/scheduler.ts:126) but `runInterEntityReconcile`
   and the `inter-entity-reconcile` ops script come in S5e, so scheduler-job-run-recording (:446-514) and
   scheduler-job-hosting (:62) are red. Either keep it out of the TS list until S5e (the SQL CHECK may stay widened) or
   land S5e's stub + script + units first.
2. **MEDIUM (money integrity):** once received, the seller can still rewrite billed_total, credited_total, quantity, rate,
   line_total, item_name (UPDATE policy admits org_id; guards cover only received_*). Add a BEFORE UPDATE trigger
   freezing money/identity columns once status <> 'in_transit' (credited_total moves only via the credit-note path), and
   a check that billed_total = sum(line_total). Tests first.
3. **LOW-MEDIUM:** receive-function input legs missing: duplicate line, another shipment's line, negative quantity, missing
   line, void shipment, edit-after-receipt (finding 2).
4. **LOW (QI-1 a):** the buyer can read void_reason / voided_by / store_id / trade_order ids; the seller can read
   received_by. Narrow: seller-only side table for void details, or serve the buyer through a definer function.
5. **LOW:** 0217 (PR #69) must merge and deploy BEFORE 0218 (drizzle skips a lower `when`); re-run migration-journal after.
6. **LOW:** the six ADD CONSTRAINTs on deliveries / trade_discrepancies / suppliers / customers / scheduler_runs are plain
   (full scan under ACCESS EXCLUSIVE): use NOT VALID + VALIDATE; add a 0218 row to docs/ops/README.md; prefer plain
   DROP (fails loudly on drift) over DROP IF EXISTS where the name is certain.
Checked clean: RLS shape, definers (search_path, REVOKE/GRANT, app_current_org scoping), receipt guard role test
(requests run SET LOCAL ROLE shareat_app), link trigger, money rounding, credit-note balance, LF/BOM/lock_timeout, cutover.

## Audit fixes landed (26 Oct, orchestrator) - S5c/S5d start from here
- Findings 1, 2, 3, 5, 6 above: FIXED. Finding 2 also gained, after a second audit round: no status change by the app
  role once a shipment leaves in_transit (void -> in_transit -> edit loop); no line INSERT or line move into a received
  or void shipment (parent status read FOR SHARE, so a concurrent receive is waited for); the deferred
  billed_total = sum(line_total) check reads the rows under the row's own org context (it failed open with no or another
  org context) and raises if lines exist without a visible header; receive refuses a zero-line shipment (22023).
  Every 0218 money column now has a *_finite_check.
- Finding 1 ruling: `inter_entity_reconcile` is out of SCHEDULER_JOBS, out of 0218's scheduler CHECK and out of the schema
  CHECK sql. **S5e puts all three back together** (plus the scheduler unit pins and t398-s5-migration J1).
- Finding 4 (buyer can read void details / seller can read received_by): **deferred to S5d** - the buyer's reads go
  through a definer function that returns only what QI-1 (a) allows.
- Label ruling: disposition `franchise_credit` displays as "Credit note to the franchise".
- ⛔ KNOWN RED until S5c/S5d: tests/unit/production-caller-ratchet.test.ts - buyerPosted, counterpartyBalance,
  findByTradeOrder, listInbound (S5b repo functions) have no production caller yet. Do NOT regenerate the baseline:
  S5c/S5d give each a real caller; the S5 PR does not go up while this is red.
- Unit runs on the laptop time out under load (~100 of 110 failures on 26 Oct were 5 s timeouts); judge the full unit
  suite in CI, and re-run a suspected file on its own.
