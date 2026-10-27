# T-398 S5 refresh — the inter-entity sale, against main `bd7cfd0` (2026-10-25)

Binding sources: spec §0b, R5, A3, A4, A6, A7, A10, B5, B8, B9, B11, C3, C5, D-amendments; audit F5, F8, F9, F11, F14;
bible rows 352, 353, 369, **370**. Where this file and the spec disagree, the "Corrections" list says why.

## 1. What S5 is, in plain terms

- The commissary (Ian's company) sells to Padre Garcia (PG, a separate company) as a **real sale**: it bills PG
  (AR + wholesale revenue) and expenses the cost of the goods, exactly as for any outside buyer.
- In the **same** step it leaves PG a **shipment note**: what was sent, how many, at what price. PG can read the note;
  PG can never read the commissary's items, stock layers, costs or other orders.
- PG **clicks "received"** in its own books, says how much actually arrived, and its own books post the stock and the
  amount it owes the commissary. Nobody writes into the other company's books.
- A **daily check (06:30 Manila) and an on-demand check** compare the two sides. A gap shows as a finding in each
  company, in its own words. A shortage becomes a **credit note** the commissary posts in its own books.
- Each side records its own payments. "Paid now" at dispatch is **refused** (row 370, Ian 17 Oct — no longer pending).
- VAT: v2 computes none (bible #75). S5 builds without VAT; Q5's final answer (due 13 Nov) may add a VAT slice later.

## 2. Corrections to the spec, measured on main today

| # | Spec says | Main says | Effect |
|---|---|---|---|
| K1 | Refusal test at `trade.test.ts:873` (B8) | `packages/domain/tests/integration/trade.test.ts:890` (`/no second org exists/`) | Tester re-rules :890 |
| K2 | E23 "pending Ian" (§0b, §6, B5) | Ruled 17 Oct, row 370: refused | E23 is a plain leg, not fenced |
| K3 | PG receipt "existing delivery path posts DR 1310 / CR 2110" (R5) | `receiveDelivery` posts **DR 1310/1320/1330 / CR 2120 GRNI** (`stock/receipt-posting.ts:132`); 2110 only arises via `supplier_invoices` → expense; `ap.openItems` is expense-based (`repo/ap.ts:653`) and `linkInvoiceToReceipt` has **no production caller** | PG could not pay the commissary through the AP screen. Needs ruling **QO-1** |
| K4 | Next migration "0209" (B8) | Head is `0215_t455_lobby_tables`; orchestrator assigns **0218** (0216/0217 held by other lanes) | Journal `when` = previous + 86 400 000 × gap |
| K5 | `CROSS_ORG_BY_DESIGN += deliveries.inter_entity_shipment_id` (R5) | Superseded by A6: composite to `inter_entity_shipments (buyer_org_id, id)`; census learns the shape | No exemption entry |
| K6 | POSTING-PATTERNS entry is "docs only" | `tests/unit/posting-patterns-doc.test.ts:45` makes every `` ### `id` `` heading need a fixture in `tests/worked-examples/fixtures.ts` | S5a is doc **plus** fixtures (a builder touches test code) |
| K7 | Trade orders carry `delivery_fee` + `other_fees` inside `total_amount` (`trade/index.ts:334`) | Spec is silent; PG's receipt has no freight leg | Ruling **QO-6** (default: refuse fees on an inter-entity order) |
| K8 | Delivery paths (B8) | `apps/erp/src/app/inventory/deliveries/{page,actions,lib}.ts`, `[id]/page.tsx`; customer form `apps/erp/src/app/customers/[customerId]/page.tsx` + `customers/actions.ts`, `lib.ts` | Exact paths below |

## 3. Migration 0218 — yes (hand-authored, ADR-012 §5)

`packages/db/migrations/0218_t398_s5_inter_entity_shipments.sql`, header names T-398 S5, R5/A3/A4/A6/C5 and why.
Not a DEF-491 bulk migration, so A1's lock budget does not apply; still `SET LOCAL lock_timeout = '5s'` (it ALTERs
`deliveries`, `suppliers`, `customers`, `scheduler_runs`, `trade_discrepancies`, which are live tables).
1. `suppliers.counterparty_org_id uuid NULL → organizations`, CHECK `num_nonnulls(counterparty_store_id,
   counterparty_org_id) <= 1`, index. (PG's supplier row for the commissary.)
2. `customers.credit_terms_days integer NULL`, CHECK `null or 0..365` — the `suppliers_credit_terms_days_check` shape (C5).
   Display and ageing only; never an accounting input.
3. `inter_entity_shipments` — seller-owned: `org_id` (seller), `buyer_org_id → organizations` (CHECK `<> org_id`),
   `trade_order_id` (same-org composite), `store_id` (same-org composite), `shipped_on`, `bir_invoice_no`,
   `billed_total numeric(14,2)`, `credited_total numeric(14,2) default 0`, `status in ('in_transit','received','void')`,
   `received_at`, `received_by` (composite `(buyer_org_id, received_by) → persons(org_id, id)`), `received_total`,
   void columns. UNIQUE `(trade_order_id)` (A4, E18), `(org_id, id)`, `(buyer_org_id, id)` (A6),
   `(org_id, buyer_org_id, id)` (for lines). Status/columns consistency CHECKs.
4. `inter_entity_shipment_lines` — `org_id`, `buyer_org_id`, composite `(org_id, buyer_org_id, shipment_id) →
   shipments`, `trade_order_line_id` (same-org composite), `line_no`, `item_name`, `unit`, `quantity numeric(14,3)`,
   `rate numeric(14,2)`, `line_total numeric(14,2)`, `received_quantity numeric(14,3) NULL` (only if **QI-1 (a)**),
   CHECK `received_quantity <= quantity` (E20 backstop). **No cost, no person name** (E24).
5. RLS on both: ENABLE + FORCE; SELECT `org_id = app_current_org() OR buyer_org_id = app_current_org()`;
   INSERT/UPDATE `org_id = app_current_org()`; no DELETE policy. GRANT SELECT, INSERT, UPDATE to `shareat_app`.
   Registry gains scope **`dual_org_counterparty`** with `counterpartyColumn` (A10); both tables use it.
6. `deliveries.inter_entity_shipment_id uuid NULL`, FK `(org_id, inter_entity_shipment_id) →
   inter_entity_shipments (buyer_org_id, id)` (A6, E19); partial UNIQUE on it `where status <> 'void'` (E8);
   `DELIVERY_KINDS` += `'inter_entity'` with CHECK `(kind = 'inter_entity') = (inter_entity_shipment_id is not null)`
   and the proof-photo CHECK waived for it (the shipment is the evidence) — ruling **QO-4**.
7. Definer functions (`SECURITY DEFINER`, `search_path` pinned, `REVOKE EXECUTE … FROM PUBLIC`, EXECUTE to
   `shareat_app` only):
   - `receive_inter_entity_shipment(shipment_id uuid, lines jsonb)` (A4): `FOR UPDATE`; refuses unless
     `buyer_org_id = app_current_org()`; refuses void/received; refuses received > shipped; stamps received_at/by/total
     (and per-line `received_quantity` under QI-1 (a)). Called inside PG's receive transaction.
   - `inter_entity_buyer_posted(shipment_ids uuid[])` (A3): per shipment, only where `org_id = app_current_org()`;
     returns exactly `(shipment_id, received_on, posted_total)` read from PG's journal.
   - Under QI-1 (a) only: `inter_entity_counterparty_balance()` — one figure each way (AR↔AP), for E12.
8. `scheduler_runs_job_check` += `'inter_entity_reconcile'` (the full list re-stated, 0209's pattern).
9. `trade_discrepancies`: disposition += `'franchise_credit'`; `inter_entity_shipment_line_id` nullable composite —
   ruling **QO-2** (the day-open block must exclude inter-entity rows).
10. Drizzle mirrors + NOTE comments: new `schema/inter-entity.ts`; `schema/{suppliers,customers,deliveries,
    trade-discrepancies,scheduler}.ts`. Classification (`cutover/classification.ts`: shipments = operational, purged
    per org, B4) and RLS registry entries. Census (`same-org-fk-exemptions.ts` / census test) learns "composite to a
    declared counterparty column" (A6) — no `CROSS_ORG_BY_DESIGN` entry.

## 4. Read gates (F9 / B9)

- New page `apps/erp/src/app/inventory/deliveries/inbound/page.tsx` (+ `[shipmentId]/page.tsx` receipt form) →
  `'/inventory/deliveries/inbound': 'receive_delivery'` in `apps/erp/src/lib/route-capability.ts`; each page calls
  `requirePageAccess`. Today `/inventory/*` is ungated by design; the longer key wins.
- Trade order page (`apps/erp/src/app/trade/orders/[id]/page.tsx`): treatment label + "Padre Garcia received on …"
  from the shipment; already gated by `/trade`. No new route for the credit note: it is an action on the order page.
- Guards that must stay green: `tests/unit/route-capability-coverage.test.ts`, `no-ungated-read-surface.test.ts`,
  `nav-route-reachability.test.ts`.

## 5. The 06:30 reconciliation (F11 / B11)

- Domain: `packages/domain/src/trade/inter-entity-reconcile.ts` — `reconcileInterEntity(tx, orgId)` returns per
  shipment and per counterparty pair the gap, in centavos, as `Money` strings.
- **Findings, derived live** (ruling **QO-5**): two detectors in `packages/domain/src/findings/` — seller side
  (`inter_entity_shipment_gap`, `inter_entity_balance_gap`) and buyer side (same kinds, PG's wording). Derived on read,
  so the Findings page **is** the on-demand check; the existing 01:30 `finding-observation` job records them daily.
- **The 06:30 job** writes what must be stored: in the seller org, one `trade_discrepancies` row per short line
  (idempotent per shipment line) — the commissary manager's to-do that ends in a credit note.
  `runInterEntityReconcile` in `packages/domain/src/scheduler/index.ts` iterates `listOrgsToRun()`, one
  `runJobForOrg(org, 'inter_entity_reconcile', …)` each, under that org's principal (never `systemTransaction`).
- Ops: `docs/ops/shareat-inter-entity-reconcile.{service,timer}` — `OnCalendar=*-*-* 06:30:00 Asia/Manila`,
  `Persistent=true`, `ExecStart=/usr/bin/npm run inter-entity-reconcile`; root `package.json` script +
  `scripts/inter-entity-reconcile.ts`. Touches no `sales_days`/`pos_v1_day_feeds` row, so the 06:00 POS import
  window (D8) does not contend. S7's O7 scan will see it reach `listOrgsToRun`.

## 6. T-433 dispatch and the seller-side receive (F5 / B5)

- `createTradeOrder` (`trade/index.ts:196-206`): the inter-entity refusal is removed; `customer_group` still decides
  nothing (E13). Fees refused on inter-entity (QO-6 default).
- `dispatchTradeOrder` (`:424`): `inter_entity` takes the external path unchanged (`recordCharge`, `postConsumption`,
  credit gate inside `recordCharge` — E27) and, in the same transaction, writes the shipment + lines (snapshot incl.
  `bir_invoice_no`, E25). `payNow` on `inter_entity` → refused before any write (row 370, E23). The idempotent
  early return (`:442`) also must not write a second shipment (E18).
- `receiveTradeOrder` (`:886`): `inter_entity` → refused: "Padre Garcia confirms receipt in its own books" (E22),
  before any write. The seller order stays `dispatched`; its page reads the shipment (ruling **QO-3**).
- `voidTradeOrder` (`:739`): for `inter_entity`, lock the shipment `FOR UPDATE`; received → refused naming the
  receipt (E10); else existing reversal + shipment `void` (E11, E17).

## 7. Fences

- **Q5 VAT (C3):** no leg asserts "no VAT line exists"; POSTING-PATTERNS lines whose amount moves under Q5 (a) are
  marked FENCED. A VAT slice, if any, follows 13 Nov.
- **Pay-now (E23):** no longer a fence (row 370). The spec's §0b/§6 text is stale; the planner fixes it when folding.

## 8. Sub-slices (each ≤ 1 day, done-when = its TESTS.md legs red→green and the named guards green)

| Slice | What | Size | Needs | Parallel with |
|---|---|---|---|---|
| **S5a** | POSTING-PATTERNS entries (from the draft) + `fixtures.ts` fixtures + replace the `:743` warning with a pointer | 0.3 | QO-1 ruled | S5b |
| **S5b** | Migration 0218, schema, repo (`packages/db/src/repo/inter-entity.ts`), registry kind, classification, census shape, test fixture helper that seeds a shipment as the seller | 1.0 | QO-1..4 ruled, QI-1 answered or defaulted to (b) | S5a |
| **S5c** | Seller side: create/dispatch/receive-refusal/void, shipment write, payNow refusal, trade.test.ts:890 re-ruled, treatment label, `credit_terms_days` field on the customer form | 1.0 | S5b | S5d |
| **S5d** | Buyer side: `receiveInterEntityShipment` in `packages/domain/src/deliveries/`, supplier-item mapping, AP per QO-1, inbound list + receipt form, route-capability | 1.0 | S5b (seeds shipments via the S5b helper) | S5c |
| **S5e** | Reconciliation + credit note: definer reads, detectors, 06:30 job + ops files + script, `franchise_transit_shortage` posting, paired-return match | 1.0 | S5c, S5d | — |
| **S5f** | §9.4 smoketest on 9008 (two orgs on a fresh copy), full suite in CI on the PR, auditor mutant table | 0.3 | S5e | — |

Total ≈ **4.6** lane-days (spec said 3.5; +1.1 for QO-1's AP path, K6's fixtures and the job). S5 must still merge
before S6 (A10: both touch the journal, classification and registry). One PR for S5 (it carries a migration).

**Files (union):** migration 0218 + `meta/_journal.json`; `packages/db/schema/{inter-entity,suppliers,customers,
deliveries,trade-discrepancies,scheduler}.ts`; `packages/db/src/repo/{inter-entity,deliveries,trade,
trade-discrepancies}.ts`; `packages/db/src/rls/{registry,same-org-fk-exemptions}.ts`; `packages/db/src/cutover/
classification.ts`; `packages/domain/src/trade/{index,inter-entity-reconcile}.ts`; `packages/domain/src/deliveries/
{documents,receive}.ts` (+ new `inter-entity.ts`); `packages/domain/src/findings/index.ts`;
`packages/domain/src/scheduler/index.ts`; `scripts/inter-entity-reconcile.ts`; `package.json`; `docs/ops/
shareat-inter-entity-reconcile.{service,timer}`; `apps/erp/src/app/inventory/deliveries/**`;
`apps/erp/src/app/trade/orders/{[id]/page.tsx,actions.ts,lib.ts}`; `apps/erp/src/app/customers/{[customerId]/page.tsx,
actions.ts,lib.ts}`; `apps/erp/src/lib/route-capability.ts`; `docs/POSTING-PATTERNS.md` (S5a);
`tests/worked-examples/fixtures.ts` (S5a). ⛔ Not the bible, not the register, not S6's files.
