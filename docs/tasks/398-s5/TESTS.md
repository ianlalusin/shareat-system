# T-398 S5 — tester checklist, per sub-slice

Rules for every leg: real Postgres (never a mock); run as `shareat_app` under `withOrgPrincipal(org, …)` unless the
leg says "owner"; tests run on any `_test` DB (no lane-DB name pinned). Every leg is first seen **red for the stated
reason** and the red output is pasted in the hand-back. Every refusal is asserted by its **words**, not only its class.

## Standing invariants (asserted in every sub-slice that posts)

| Id | Invariant | How |
|---|---|---|
| M1 | No floats: every amount is a decimal string / `Money`; no `Number(` or `parseFloat(` on money in new code | Unit source scan of the files S5 adds or edits (`trade/inter-entity-reconcile.ts`, `deliveries/inter-entity.ts`, `repo/inter-entity.ts`, the new `trade/index.ts` branch) |
| M2 | Every entry S5 writes balances: Σ debit = Σ credit per `entry_id`, to the centavo | SQL read-back per entry in each posting leg |
| M3 | No entry has lines in two orgs; no journal line's `org_id` differs from its entry's | SQL over the entries a leg created |
| M4 | Exact equality, never a tolerance: AR for PG = PG's AP for the commissary, in centavos (`toCentavos`) | E7, E12 |
| X1 | **Cross-org sweep:** with both orgs seeded (orders, layers, AR, AP, persons, items), as PG's principal, for **every** table in `RLS_REGISTRY` with `org_id`, count rows whose `org_id` = Ian's org → **0**, except `inter_entity_shipments` and `inter_entity_shipment_lines`. Same sweep as Ian's org against PG's rows → 0 except the same two | `packages/db/tests/integration/t398-s5-shipment-rls.test.ts` |
| X2 | **The handoff is closed by value:** the only policies naming `buyer_org_id` are the two tables' SELECT policies (catalog, `pg_policies`); the only `SECURITY DEFINER` functions matching `inter_entity%` are the pinned list (`receive_inter_entity_shipment`, `inter_entity_buyer_posted`, + `inter_entity_counterparty_balance` under QI-1 a); each has `search_path` pinned, no `PUBLIC` EXECUTE, EXECUTE to `shareat_app` | same file |
| X3 | Only cross-org FK shapes: `deliveries (org_id, inter_entity_shipment_id) → shipments (buyer_org_id, id)` and `shipments (buyer_org_id, received_by) → persons (org_id, id)`; the census learns them as "composite to a declared counterparty column"; `CROSS_ORG_BY_DESIGN` stays `[]` | census test (S1 file) |

## S5a — POSTING-PATTERNS + fixtures

| Id | Leg | Red today because | Mutant it kills |
|---|---|---|---|
| PP1 | `posting-patterns-doc.test.ts`: the four new ids exist both as headings and fixtures | headings/fixtures absent | delete one heading or one fixture |
| PP2 | `tests/integration/posting-patterns.test.ts` posts each new fixture through `postEntry`, reads back, reverses | fixtures absent | change `5300` to `5400` in the shortage fixture (doc test reds on the account) |
| PP3 | The `:743` "do not use for a franchise" warning is gone and points at the new section (text assertion) | warning present | — |

## S5b — migration 0218, schema, repo, registry

File: `packages/db/tests/integration/t398-s5-shipment-rls.test.ts` (+ X1-X3).

| Id | Leg | Target | Mutant |
|---|---|---|---|
| E3 | As PG: shipment + lines readable; Ian's `items`, `stock_layers`, `trade_orders`, `ar_charges` → 0 rows | Pass | drop the `OR buyer_org_id` arm → E3 red |
| E4 | As PG: UPDATE / DELETE a shipment or line | 0 rows / error | widen UPDATE policy to the buyer → E4 red |
| E5 | As a third org C: shipment invisible | 0 rows | — |
| E19 | A delivery in org C pointing at a PG shipment | `23503` | point the FK at `(org_id, id)` → E19 red |
| E24 | Snapshot columns (catalog) contain no cost/`unit_cost`/`layer`/person-name column; a row read as PG shows none | Pass | add `unit_cost` → E24 red |
| E26 | `customers.credit_terms_days` = 30 stored; −1 and 366 refused by the CHECK | Pass | drop the CHECK → red |
| E18a | Second shipment row for the same `trade_order_id` | unique violation | drop UNIQUE → red |
| E20a | `received_quantity > quantity` on a line (owner insert) | CHECK violation | drop the CHECK → red |
| S1 | `suppliers`: both `counterparty_store_id` and `counterparty_org_id` set | CHECK violation | — |
| D-K | `deliveries.kind = 'inter_entity'` without a shipment id, and a `supplier` kind with one | both refused | — |
| L0 | 0218 applies from zero on a scratch DB; journal `when` on the grid; `migration-journal`, `rls-registry`, `cutover-classification` tests green | Pass | — |

## S5c — seller side

File: `packages/domain/tests/integration/t398-s5-inter-entity-sale.test.ts`; re-rule `trade.test.ts:890`.

| Id | Leg | Refusal / target | Mutant |
|---|---|---|---|
| E1 | Dispatch to PG (`counterparty_org_id` = PG): AR charge, `4300`, COGS — legs identical to a control external order of the same lines, **control uses no `payNow`, no `creditOverrideReason`** (B5). Asserts amounts, accounts, parties; **never** that a VAT line is absent (C3) | identical legs | write a 1340 leg for inter-entity → red |
| E2 | Same transaction writes one shipment + lines; snapshot = order lines (name, unit, qty, rate, line total); `billed_total` = order total | Pass | — |
| E13 | `franchise`-group customer with no `counterparty_org_id` posts as external, writes **no** shipment | Green guard | derive treatment from `customer_group` → red |
| E18 | Retried dispatch: one shipment, one charge | Pass | drop the early-return shipment guard → red |
| E22 | `receiveTradeOrder` on a dispatched inter-entity order | refused: "Padre Garcia confirms receipt in its own books"; nothing written (row counts unchanged) | remove the refusal → red |
| E23 | `dispatchTradeOrder` with `payNow` on inter-entity (row 370) | refused in words before any write; zero entries, zero stock moves | drop the refusal → red |
| E25 | Order with `bir_invoice_no` → shipment carries it; without → NULL | Pass | — |
| E27 | Dispatch over PG's `credit_limit`, no override → refused as for an external customer; with a manager override → posts | Green guard | skip the gate when inter-entity → red |
| E10 | Void after PG received | refused, naming the receipt date | — |
| E11 | Void before receipt: charge reversed, stock back, shipment `void`; PG's inbound list no longer shows it | Pass | leave shipment `in_transit` → red |
| E17 | Concurrent void (Ian) and receive (PG), two connections + barrier, ×20 | exactly one wins; the other refused in words | drop `FOR UPDATE` → red |
| F1 | Create an inter-entity order with a delivery fee (QO-6 default) | refused: "Delivery charges to Padre Garcia go into the franchise price…" | — |
| T890 | `trade.test.ts:890` re-ruled to assert creation now succeeds for an inter-entity customer | Pass | — |

## S5d — buyer side

Same domain file (buyer block) + an apps unit/integration leg for the page gate.

| Id | Leg | Refusal / target | Mutant |
|---|---|---|---|
| E6 | PG receives in full: per QO-1 (a) `DR 1310 / CR 2120` then `DR 2120 / CR 2110` party = commissary supplier; layer unit cost = shipment rate; delivery links the shipment; one AP open item = shipment total (`ap.openItems`) | Pass | post `CR 2120` only (no bill) → open-items assertion red |
| E7a | PG receives 8 of 10: PG AP = 8 × rate (exact centavos) | Pass | post at dispatched qty → red |
| E8 | Receive twice | second refused: "already received on …"; one delivery | drop partial unique → red |
| E9 | PG person without `receive_delivery` | `AuthorizationError` (the ✗) | — |
| E20 | Over-receipt (11 of 10) | refused in words naming the line; nothing written | — |
| B1 | PG receives a shipment addressed to org C (forged id) | refused by the definer (`buyer_org_id <> app_current_org()`); nothing written | drop that check → red |
| B2 | Item mapping: a shipment line with no PG `supplier_items` mapping | refused naming the line, asks to map the item | — |
| G1 | `/inventory/deliveries/inbound` → `receive_delivery` in `route-capability.ts`; page calls `requirePageAccess`; the three T-435 guards green | Pass | remove the map entry → coverage test red |

## S5e — reconciliation and credit note

| Id | Leg | Target | Mutant |
|---|---|---|---|
| E14 | Third org calls `inter_entity_buyer_posted` | 0 rows | drop `org_id = app_current_org()` → red |
| E15 | Function's result columns (catalog) = exactly `(shipment_id, received_on, posted_total)` | Pass | add a column → red |
| E16 | In-transit shipment raises no finding and is excluded from the balance check | Pass | — |
| E7 | After E7a, the 06:30 job (called directly) writes **one** `franchise_credit` discrepancy in Ian's org (idempotent: a second run writes none); each org's findings feed shows one gap finding, in its own words (Ian's: "Padre Garcia has recorded ₱2,480.00 against shipment N"; no PG account, cost or person); after the credit note (`DR 4950 620 / CR 1210 620; DR 5300 500 / CR 5100 500`) the next run is clean | Pass | let reconciliation tolerate ±₱0.01 → red; compute credit as round(short × rate) → red on a rounding fixture (e.g. 0.333 kg × ₱10.00) |
| E12 | Two shipments (one short), one payment each side: AR = AP exactly; then a one-sided payment → exactly one finding per org (needs QI-1 a; under b the leg is restated per shipment only) | Pass | — |
| E21 | Paired return (PG supplier return + commissary customer return) clears the reconciliation | Pass | — |
| C1 | Credit after the charge is fully collected → `CR 2140` (party PG) for the excess, same entry | Pass | always `CR 1210` → red |
| C2 | Credit cost leg = the dispatch's consumption for the short qty (layers changed since) | Pass | re-cost from today's layers → red |
| J1 | `runInterEntityReconcile` iterates `listOrgsToRun`, writes one `scheduler_runs` row per org with `job = 'inter_entity_reconcile'`; one org failing does not stop the next | Pass | — |
| J2 | `docs/ops/shareat-inter-entity-reconcile.timer` has `OnCalendar=*-*-* 06:30:00 Asia/Manila`, `Persistent=true`; the `.service` `ExecStart` script reaches `listOrgsToRun` (S7's O7 scanner input) | Pass | remove the zone → red |

## S5f — closing gates

Full integration suite in CI on the PR (it carries a migration: own PR, row 296 exception). Typecheck clean.
§9.4 on 9008 (fresh copy, two orgs): dispatch to PG, receive 8 of 10 as PG, run the check, post the credit, show both
findings feeds; screenshots + `select org_id, count(*) from journal_lines group by 1`. Auditor applies every mutant
above and pastes which leg reds.
