# T-398: Padre Garcia on v2 as its own organisation (plan C11)

**Status:** SPEC DRAFT 2026-10-10 (Opus planner) — awaiting a fresh Opus review (money/auth).
**Model:** Sonnet lanes (tester then builder per slice); Opus for the review and for any spec amendment.
**Why now:** bible row 305 (Ian, 2026-10-10, plan-q4 = (b)): *Padre Garcia runs on v2 by 1 January 2027, as its own
organisation.* Row 246's trigger ("before a second organisation is onboarded") therefore fires before cutover, so
DEF-491 and DEF-421 are cutover scope. Plan: `docs/plans/remaining-build-plan.md` §0b and §1.1 C11 (≈ 11 lane-days).
**Deadline:** 4 Dec on production (plan §2.1); second rehearsal with two organisations on 18 Dec.
**Drop-alone rule (plan §2.2):** if S5-S7 are not on production by 4 Dec, Padre Garcia stays on v1 past 1 Jan and
Ian's organisation cuts over alone. S1-S4 land regardless: they harden Ian's own org and cost nothing to keep.
**Migrations:** every slice that has one takes **the next free number at merge** (0193 today, after T-386 S6's 0192).
No slice hard-codes a number; the journal `when` is the previous entry's + 86 400 000.

---

## 1. Goal (row 283: v1's goal, not its method)

| | |
|---|---|
| **v1 today** | Padre Garcia (`y1DMgfisuTHBF57cNL6i`) is a `stores/{id}` document inside Ian's Firebase project (ADR-008 §7, DEF-050). v1 has **no franchise concept at all** (`grep -ri franchise ERP-rebuild/src`: 0 hits). A commissary dispatch to it is a **branch sale**: AR + `branch_sales` revenue recognised at the branch's receipt, variances settled after (`ERP-rebuild/src/lib/financial/commissary/branch-sale-ar.ts:19-36`). Ian sees all of its books, because it is one of his stores |
| **The goal v1 serves** | The commissary bills the franchise for what it actually received; the franchise's sales are visible to the franchisor for royalties |
| **What v1 gets wrong** | A separate company's books sit in Ian's database and roll into his totals (DEF-050); the franchise's cost structure is open to the franchisor; nothing records who looked |
| **v2 goal** | Padre Garcia trades on v2 from 1 Jan **in its own books**. The commissary sells to it as a **real sale on both sides** (seller AR + revenue + COGS; buyer inventory + AP) and the two sides **reconcile**. Ian sees **its sales only**, and every look is logged where Padre Garcia can read it. **No row of one org can point at a row of another**, enforced by the database and kept true by a build guard |

**What already exists** (plan C11): `organizations` with RLS (T-120/T-121); `createOrganization` / `createFirstAdmin`
(`packages/domain/src/organizations/index.ts:133,243`); one person row per org (row 175); a franchise owner is a
`manager` (row 114); `customers.counterparty_org_id` and the derived `inter_entity` treatment (ADR-008 §2,
`packages/db/src/repo/customers.ts:57-60`); capability `view_franchise_sales`, super-admin only, platform-scoped,
**no reader** (`packages/auth/src/capabilities.ts:988`); the external-sale dispatch with FIFO COGS
(`packages/domain/src/trade/index.ts:425`, COGS at `:580-647`); supplier deliveries that post inventory + AP
(`packages/domain/src/deliveries/documents.ts:122,313`, capability `receive_delivery`); customer returns and credits
(`packages/domain/src/trade/returns.ts:169,645`); POS links, globally unique per POS store
(`packages/db/schema/pos-v1.ts`, `pos_v1_store_links_pos_store_id_unique`).

**What is missing** — and the order this spec builds it in:

1. **DEF-491** — ≈360 org→org FKs + 79 derived-scope→org FKs with no same-org check (census: T-357 R1). S1, S3, S4.
2. **DEF-421** — 165 `tx: Tx | null` signatures in 49 files of `packages/domain/src`, ≈132 `transaction(run)` null
   branches with no org principal. S2.
3. **The inter-entity sale** — `createTradeOrder` refuses it (`trade/index.ts:198-206`). S5.
4. **The franchisor's sales-only view** and its access log. S6.
5. **Onboarding** — the org, Ian's PG person, the store, the two counterparty rows, items split out of the T-391
   import, POS link, multi-org checks on every scheduled job. S7.

---

## 2. Rulings (planner, 2026-10-10)

- **R1 — The structural guard lands first and is mechanical.** S1 adds a census test that reads `pg_constraint` and
  **fails the build** on any FK from a table with `org_id` to another table with `org_id` (excluding `organizations`)
  that has no companion composite `(org_id, col) → parent(org_id, id)`, and on any derived-scope→org FK with no
  registered same-org trigger. Exceptions live in ONE file, `packages/db/src/rls/same-org-fk-exemptions.ts`, as two
  lists:
  - `CROSS_ORG_BY_DESIGN` — permanent, each with a one-line reason (S5 adds the inter-entity links). Never grows
    without a planner ruling.
  - `OPEN_DEF_491` — the ratchet. S1 seeds it with every gap still open after S1; S3 and S4 delete what they fix;
    **it is empty when S4 merges.** The test also fails on a **stale** entry (listed, but now guarded), so the list
    can only shrink.
  - The guard runs in the integration suite on the CI database, so a new table with a bare cross-org FK is red on
    its PR. That is the "mechanically verified" bar; a reviewer is not.
- **R2 — Shape: T-357's, unchanged** (`0171`; T-357 R3-R5). `UNIQUE (org_id, id)` on each parent, then
  `FOREIGN KEY (org_id, col) REFERENCES parent (org_id, id) ON DELETE RESTRICT`, MATCH SIMPLE (a NULL `col` skips the
  check), name `<table>_<col>_same_org_fk` (≤63 chars; where too long, the builder shortens and records the mapping
  in the migration header). Single-column FKs stay. Drizzle mirrors each composite (ADR-012 §5.3).
  - ⚠️ **Production lock budget.** Each FK is added `NOT VALID`, then `VALIDATE CONSTRAINT` in a later statement of the
    same migration: the add takes a brief lock, the validate a `SHARE UPDATE EXCLUSIVE` that does not block writes.
    The migration runs on production **during the dual run**; a blocking 300-FK migration at 06:00 would stall the
    T-396 timer.
  - **Pre-flight, fail closed** (T-357 R4): a DO block counts cross-org rows per FK and RAISEs naming each non-zero
    one with *"DEF-491: no silent fix; each row needs a human decision"*. Production holds one org, so its count is
    0 by construction; a lane DB with residue is re-made, never the migration edited (T-357 R7).
- **R3 — Derived-scope children (the 79) get a trigger, not a new column.** One generic `plpgsql` function,
  `assert_same_org_via_parent()`, parameterised by `TG_ARGV` (child FK column, header table, header FK column,
  target table), raising `23503`-class `foreign_key_violation` with a named message; one `BEFORE INSERT OR UPDATE OF
  <col>` trigger per FK. Reason: adding `org_id` to ≈40 child tables means backfill + 40 Drizzle schema changes +
  40 repo writers, for the same guarantee. The trigger runs as the table owner, so RLS does not blind it. The census
  test reads the registry of these triggers from `pg_trigger` (`tgargs`), not from a TS list.
- **R4 — DEF-421: `tx: Tx` is non-nullable in `packages/domain/src`, with a closed allow-list.** The compiler is the
  guard (a `null` argument stops typecheck), plus a source-scanning unit test so the allow-list cannot grow silently.
  - **Allowed to keep `Tx | null`** (the AUTH door, before any principal exists, and one deliberate case):
    `signInWithFirebase`, `signInWithPin`, `resolveTerminalIdentity`, `resolveActor`, `signOut`, and
    `runDepreciation` (DEF-421 note: one tx per asset). The builder confirms each by reading it; any other function
    found to need it is a **spec defect to report**, not an addition.
  - `runDepreciation`'s null branch opens `withOrgPrincipal(orgId, …)` per asset, never a bare `transaction()`.
  - No `transaction(` import remains in `packages/domain/src` outside the allow-listed files.
  - The 12 non-test `null` callers (`apps/erp/src/app/fixed-assets/actions.ts:205`, sign-in, setup, session,
    `scripts/smoke-pin-throttle.ts:51`) are all allow-listed functions; nothing else changes in apps.
  - The ≈100 test call sites (22 files) that pass `null` move to `withOrgPrincipal(org, (tx) => fn(tx, …))`. That is
    the tester's work in S2, and it is the bulk of S2.
- **R5 — The inter-entity sale: two orgs, two transactions, one handoff, one reconciliation.** No transaction spans
  two orgs once RLS isolates them (T-133 §4, discovery 19 §7.5). So:
  - **Seller (Ian's org), at dispatch:** the existing external-sale path, unchanged — `recordCharge` (AR `1210` +
    revenue) and FIFO COGS. `treatmentOf` = `inter_entity` now dispatches like `external` (the refusal at
    `trade/index.ts:198-206` is removed). In the **same** seller transaction it writes an
    `inter_entity_shipments` row + lines: the buyer org, the trade order, and a **snapshot** of each line (item name,
    unit, quantity, rate, line total). The buyer can read the shipment, never the seller's items, layers or costs.
  - **Buyer (Padre Garcia), at receipt — a deliberate click** (discovery 19 §7.4, answering ADR-008 Open 2): PG's
    `receive_delivery` holder opens the inbound shipment, maps each line to a PG item (via `supplier_items`), enters
    the quantity actually received, and the existing delivery path posts `DR 1310 Inventory / CR 2110 AP`, party =
    PG's supplier row for the commissary (`suppliers.counterparty_org_id` = Ian's org, new). The delivery row carries
    `inter_entity_shipment_id` — a cross-org FK **by design**, listed in `CROSS_ORG_BY_DESIGN`.
  - **Shortage:** PG receives less → its AP is for what it received. The seller learns of it through the
    reconciliation (below) as a `trade_discrepancies` row in its own org, and resolves it with the existing customer
    return/credit (`recordCustomerReturn` / `applyCredit`). No automatic cross-org write.
  - **Reconciliation, scheduled (06:30 Manila) and on demand:** a system job (the scheduler's per-org loop,
    `packages/domain/src/scheduler`) compares per shipment *seller charged − credits* with *buyer AP posted*, and per
    pair *seller AR balance for the franchise customer* with *buyer AP balance for the commissary supplier*. A
    difference raises a finding **in each org, in that org's own words** (the seller does not see the buyer's AP
    detail, only "Padre Garcia has recorded ₱X against shipment N"). This is ADR-008 §4's "the same debt viewed
    twice", checked rather than assumed.
  - **Payments** are recorded independently on each side (PG's AP payment, the commissary's AR collection); the
    balance check above catches a one-sided payment.
  - **Price:** the franchise customer's price list (ADR-008 §3) — Q4.
  - The posting pattern **"dispatch to a franchise"** is added to `docs/POSTING-PATTERNS.md` by the planner **before
    S5's tester starts** (ADR-008 "What this changes today"); S5 implements it, it does not decide it.
- **R6 — The franchisor's view is enforced in the database, and the log is written by the database.**
  - `franchise_agreements` — `org_id` = the franchisee (PG), `franchisor_org_id` → `organizations`,
    `franchisor_person_id` (Ian's person **in PG's org**, so a same-org FK), `sales_visible_from`, scope. Written only
    by the S7 onboarding path; readable by both orgs.
  - `franchise_access_log` — append-only (trigger refuses UPDATE/DELETE), readable by both orgs: who, when, which
    org, which range, what (`sales_daily` / `break_glass_sign_in`), reason.
  - `franchise_sales_daily(franchisee_org uuid, from date, to date)` — `SECURITY DEFINER`, `search_path` pinned. It
    returns **only** store, business date, channel, tender, gross, discounts, net and sales-day status, and only when
    an agreement row has `franchisor_org_id = app_current_org()` and the range is on/after `sales_visible_from`. It
    **inserts the log row itself**, so no caller can read without logging.
  - The domain `viewFranchiseSales(tx, actor, …)` calls `authorize(…, 'view_franchise_sales')` first (§15.11: two
    layers — the capability and the function's own agreement check).
  - **Full-books access is not this function.** It is Ian's own person row in PG's org (row 175), with its own
    credential; every session that person opens writes a `break_glass_sign_in` row to the log. That **is** the
    break-glass of T-121 A.3: an identity, not a bypass, and PG can see each use.
  - A PG `manager` can read the log through a new capability `view_franchise_access_log` (store-less, org scope;
    manager + admin ✅, staff ✗). CAPABILITY-MATRIX row added by the planner before S6's tester starts.
- **R7 — Onboarding is a CLI, not `/setup`.** `bootstrapOrganization` refuses a second org by design
  (`organizations/index.ts:349-360`) and that stays. A new domain function `onboardFranchiseOrganization` calls
  `createOrganization` + `createFirstAdmin` (Ian's PG person, org-admin) + the store, in one system transaction; the
  two counterparty rows (Ian-side customer with `counterparty_org_id`, PG-side supplier with `counterparty_org_id`)
  and the agreement row are written each under its own org principal. `scripts/onboard-franchise.ts` follows
  `scripts/bootstrap-org.ts`'s guards exactly (no defaults, `--confirm`, dry run by default, never a unit).
  - ⚠️ `person_credentials_external_id_unique` is global (`schema/sessions.ts:134`): **Ian needs a second sign-in
    identity** (another email) for his PG person. Q1.

---

## 3. Slices

Order: **S1 ∥ S2 → S3 → S4 → (S5 ∥ S6) → S7.** S1 and S2 touch disjoint trees (db schema/migrations vs domain/tests)
and share no state if each runs on its own lane DB (row 298 worktrees). S5 and S6 both add a migration: whichever
merges second renumbers to the next free slot and re-runs `migration-journal.test.ts`.

| Slice | What | Migration | Size | Needed by |
|---|---|---|---|---|
| **S1** | Census guard + exemptions file; persons (143) + stores (71) composites | yes | M 1.5 | 13 Nov (plan) |
| **S2** | DEF-421: non-nullable `tx`, allow-list guard, tests moved to principals | none | M 1.5 | 13 Nov |
| **S3** | DEF-491: the remaining org→org parents (journal_entries, items, stock_locations, suppliers, employments, the rest ≈146) | yes | M 1.5 | 20 Nov |
| **S4** | DEF-491: the 79 derived-scope FKs by trigger; `OPEN_DEF_491` reaches empty | yes | S-M 1.5 | 24 Nov |
| **S5** | Inter-entity sale: shipment handoff, buyer receipt, reconciliation | yes | M 2 | 1 Dec |
| **S6** | Sales-only view + access log + break-glass sign-in logging + screen | yes | M 1.5 | 1 Dec |
| **S7** | Onboarding CLI, split item import, POS link, multi-org job checks, two-org rehearsal data | none expected | M 1.5 | 4 Dec |
| | **Total** | 5 | **≈ 11** | |

### S1 — the census guard, persons and stores (DEF-491 part 1)

**TESTER paths:** new `packages/db/tests/integration/t398-s1-same-org-fk-census.test.ts`; new
`packages/db/src/rls/same-org-fk-exemptions.ts` (seeded with the full measured list, persons/stores entries marked for
deletion by the builder); new `packages/db/tests/integration/t398-s1-persons-stores-same-org.test.ts`.
**BUILDER paths:** the new migration; `packages/db/migrations/meta/_journal.json`; the Drizzle schema files holding
the 214 child columns (the builder lists them in its report, from the census query); `schema/persons.ts`,
`schema/stores.ts` (NOTE comments for the hand-added uniques); `same-org-fk-exemptions.ts` (deletions only).
⛔ No domain/repo/app code, no other test file, not the register or the bible.

| Id | Case | Target | Red today |
|---|---|---|---|
| C1 | Census: every org→org FK has a composite twin, or is in one of the two lists | Pass | Red once the 214 persons/stores entries are removed from `OPEN_DEF_491` (the tester records that red on its branch, then restores them; the builder deletes them in the same PR as the migration) |
| C2 | Stale entry: an `OPEN_DEF_491` entry whose FK now has a twin | Fails naming it | Green today (none) — proven by a synthetic entry in a unit of the test's own helper |
| C3 | A brand-new bare org→org FK added on a scratch DB (`CREATE TABLE … REFERENCES stores(id)`) | Census fails naming it | Red: guard absent |
| C4 | Count pin: `OPEN_DEF_491.length` ≤ the baseline written in the file | Pass; fails if it grows | — |
| P1 | As `shareat_app`, org A: INSERT an A row pointing at B's person (three representative tables: `person_store_scope`-free ones the builder names, e.g. `expenses.created_by`, `till_shifts.cashier_person_id`, `stock_transfers.requested_by`) | `23503` | ACCEPTED |
| P2 | Same for B's store on three tables (`sales_days.store_id`, `expenses.store_id`, `stock_locations.store_id`) | `23503` | ACCEPTED |
| P3 | Owner (bypasses RLS) cross-org UPDATE on one person FK and one store FK | `23503` | Accepted |
| P4 | Same-org positive control on all six | Succeeds | Green (guard) |
| N1 | NULL on a nullable person FK | Succeeds (MATCH SIMPLE) | Green |
| M1 | Pre-flight: scratch DB migrated to the entry before S1's, one cross-org persons row + one stores row seeded, apply | RAISEs naming both FKs and DEF-491; no constraint left | Red: migration absent |
| M2 | Same scratch DB, same-org only | Applies; C1 holds | As M1 |

**Mutants (auditor applies each; each must turn a named leg red):** delete one composite from the migration → C1;
drop the pre-flight DO block → M1 (message assertion); add a bare FK in a test-only migration → C3; add an
`OPEN_DEF_491` entry for an FK S1 fixed → C2; widen `CROSS_ORG_BY_DESIGN` with a persons FK → C1's "by-design
entries need a planner ruling id" assertion.

### S2 — DEF-421, transactions always carry an org principal

**TESTER paths:** new `tests/unit/t398-s2-domain-tx-non-nullable.test.ts` (scans `packages/domain/src` for
`Tx | null` and for `transaction(` imports outside the R4 allow-list); every test file that passes `null` to a
domain function (≈22 files; the tester lists them) — **only** the `null` → `withOrgPrincipal` change; new
`packages/domain/tests/integration/t398-s2-depreciation-principal.test.ts`.
**BUILDER paths:** `packages/domain/src/**` signatures and null branches only; no behaviour change. ⛔ No app, db,
or test file.

| Id | Case | Target | Red today |
|---|---|---|---|
| T1 | Scan: `Tx \| null` appears only on the six allow-listed functions | Pass | Red: 165 sites |
| T2 | Scan: no `transaction(` import in `packages/domain/src` outside the allow-listed files | Pass | Red |
| T3 | Typecheck with one test deliberately passing `null` to `createTradeOrder` (a `// @ts-expect-error` line) | The directive is satisfied (i.e. `null` is a type error) | Red: `@ts-expect-error` unused |
| T4 | `runDepreciation(null, …)` as the app role over two assets | Both post; each ran under `app.org_id` = the actor's org (read back `current_setting` inside a test hook, or the posted rows' visibility under RLS) | Red if the null branch is a bare `transaction()` under the app role (DEF-417 refusal) |
| T5 | Full integration suite | Green with only R4's call-site moves | — |

**Mutants:** re-add `| null` to `dispatchTradeOrder` → T1; replace one `withOrgPrincipal` in `runDepreciation` with
`transaction` → T2 and T4; add a seventh name to the allow-list → T1's pinned list (the list is pinned by value).

### S3 — DEF-491, the remaining org→org parents

**TESTER paths:** new `packages/db/tests/integration/t398-s3-same-org.test.ts` (one INSERT-as-app-role leg per parent
table, ≥ 1 per parent, the tester names the child), plus M1/M2 as in S1.
**BUILDER paths:** the new migration, the journal, the Drizzle schema files for the children, NOTE comments on each
parent, `same-org-fk-exemptions.ts` (deletions only).
Legs: K1 (census green with the shrunken list), one F-leg per parent (`23503` as `shareat_app`), one owner leg,
same-org controls, M1/M2. **Workflow sweep allowed** (row 298 #5) for writing the ≈146 `ADD CONSTRAINT` lines from
the census query output; the builder pastes the query and the sweep's diff stat in its report.
**Mutants:** drop any one composite → C1; reorder `VALIDATE` before `ADD … NOT VALID` → migration fails on scratch.

### S4 — DEF-491, the derived-scope children

**TESTER paths:** new `packages/db/tests/integration/t398-s4-derived-same-org.test.ts`.
**BUILDER paths:** the new migration (R3's function + 79 triggers + pre-flight), the journal,
`same-org-fk-exemptions.ts` (deletions to empty).
| Id | Case | Target |
|---|---|---|
| D1 | Census: every derived→org FK has a trigger whose `tgargs` name it; `OPEN_DEF_491` is empty | Pass |
| D2 | As app role: INSERT `remittance_lines` (A header) with B's `from_money_account_id`; same for `sales_day_tenders`, `till_count_lines`, `expense_payments`, and one person- and one item-derived FK | Rejected, `foreign_key_violation`, message names DEF-491 |
| D3 | UPDATE of the FK column to a cross-org target | Rejected |
| D4 | UPDATE of an unrelated column on a row (trigger is `UPDATE OF <col>`) | Succeeds, trigger not fired |
| D5 | Same-org positive controls | Succeed |
| M1/M2 | Pre-flight as S1 | — |
**Mutants:** make the function compare against the child's own nonexistent `org_id` (always NULL) → D2; drop one
trigger → D1; change `UPDATE OF col` to plain `UPDATE` → no leg reds, so D4 also asserts the trigger did not run
(a counter in a test-only session variable, or `pg_stat_user_functions.calls` delta).

### S5 — the inter-entity sale

**Planner pre-requisite:** the "dispatch to a franchise" posting pattern in `docs/POSTING-PATTERNS.md` (R5).
**TESTER paths:** new `packages/domain/tests/integration/t398-s5-inter-entity-sale.test.ts`; new
`packages/db/tests/integration/t398-s5-shipment-rls.test.ts`; the existing T-133 test that asserts the refusal
(the tester finds it by grepping "belongs to another organisation") is **ruled** to assert the new behaviour.
**BUILDER paths:** the new migration (`suppliers.counterparty_org_id`; `inter_entity_shipments` +
`inter_entity_shipment_lines` with a dual-org RLS policy — SELECT `org_id = app_current_org() OR buyer_org_id =
app_current_org()`, INSERT/UPDATE/DELETE seller only; `deliveries.inter_entity_shipment_id`); the journal;
`schema/suppliers.ts`, `schema/deliveries.ts`, a new `schema/inter-entity.ts`; `packages/db/src/repo/` for the new
tables; `packages/db/src/cutover/classification.ts` and `packages/db/src/rls/registry.ts` (the build requires both);
`same-org-fk-exemptions.ts` (`CROSS_ORG_BY_DESIGN` += `deliveries.inter_entity_shipment_id`,
`inter_entity_shipments.buyer_org_id` is to `organizations` and needs nothing); `packages/domain/src/trade/index.ts`;
`packages/domain/src/deliveries/`; a new `packages/domain/src/trade/inter-entity-reconcile.ts`; the scheduler job
registration; `apps/erp/src/app/deliveries/` (an "Inbound from commissary" list and receipt form on the existing
delivery screens) and `apps/erp/src/app/trade/` (treatment label only).

| Id | Case | Target | Red today |
|---|---|---|---|
| E1 | Dispatch to the PG customer (`counterparty_org_id` = PG) | Seller: one AR charge, revenue, COGS from FIFO layers — **identical legs** to an external sale of the same lines (compare to a control order to an external customer) | Refused |
| E2 | Same transaction writes one shipment + lines; the snapshot equals the order lines | — | Red |
| E3 | As PG (`app.org_id` = PG): the shipment is readable; Ian's `items`, `stock_layers`, `trade_orders`, `ar_charges` are not (0 rows) | — | Red (table absent) |
| E4 | As PG: UPDATE or DELETE a shipment row | Rejected by RLS (0 rows / error) | Red |
| E5 | As a third org C: the shipment is invisible | 0 rows | Red |
| E6 | PG receives in full | PG: `DR 1310` / `CR 2110`, party = the commissary supplier, amount = shipment total; FIFO layer at the shipment rate; delivery links the shipment | Red |
| E7 | PG receives 8 of 10 on a line | PG AP = received value; reconciliation raises one discrepancy in Ian's org and one finding in each org; after the commissary records the credit for 2, the next run is clean | Red |
| E8 | Receive twice | Second refused (idempotent: one delivery per shipment, unique index) | Red |
| E9 | PG receive by a PG person without `receive_delivery` | `AuthorizationError` (the ✗ for the ✅) | Red |
| E10 | Void the seller order after PG received | Refused, naming the receipt (the seller cannot unwind the buyer's books) | Red |
| E11 | Void before receipt | Seller reverses (existing path); shipment marked void; PG's inbound list no longer offers it | Red |
| E12 | Balance tie: after a mix (two shipments, one short, one payment each side) seller AR for PG = PG AP for commissary | Equal; and a one-sided payment produces exactly one finding per org | Red |
| E13 | `customer_group` drives nothing: a `franchise`-group customer with no `counterparty_org_id` still posts as external, writes no shipment | — | Green (guard, ADR-008 §2) |

**Mutants:** drop the `OR buyer_org_id` arm → E3 red; widen it to UPDATE → E4 red; post buyer AP at the dispatched
(not received) quantity → E7 red; let reconciliation tolerate ±1 centavo → E12 (exact-centavo assertion); derive
treatment from `customer_group` → E13.

### S6 — the sales-only view and the access log

**Planner pre-requisite:** CAPABILITY-MATRIX rows for `view_franchise_access_log` (R6) and a note on
`view_franchise_sales` naming its reader.
**TESTER paths:** new `packages/db/tests/integration/t398-s6-franchise-sales-fn.test.ts`; new
`packages/auth/tests/integration/t398-s6-franchise-capabilities.test.ts`; new
`apps/erp/tests/integration/t398-s6-view-franchise-sales.test.ts`.
**BUILDER paths:** the new migration (two tables, the function, the append-only trigger, grants: `EXECUTE` to
`shareat_app` only); the journal; a new `schema/franchise.ts`; repo; classification + RLS registry;
`packages/auth/src/capabilities.ts` (the new capability, matrix, labels, area); `packages/domain/src/franchise/`
(new: `viewFranchiseSales`, `listFranchiseAccessLog`); the sign-in path for a person whose org has a
agreement and who is its `franchisor_person_id` (logs `break_glass_sign_in`) in
`packages/domain/src/people/` or the session module — the builder names the file; `apps/erp/src/app/franchise/`
(new screens: sales by day/channel/tender for Ian's org; access log for PG's org); nav entry gated on the
capability.

| Id | Case | Target | Red today |
|---|---|---|---|
| V1 | Ian (super-admin, his org) reads PG's sales for a week | Rows match PG's verified sales days to the centavo; one log row per call, visible as PG | Red (no reader) |
| V2 | The function's result columns | Exactly the R6 list (catalog check on the function's `RETURNS TABLE`) — no expense, COGS, payroll or AP column can be added without this leg reddening | Red |
| V3 | Ian's org admin / manager / staff call `viewFranchiseSales` | `AuthorizationError` ×3 (the ✗s) | Red |
| V4 | PG's admin and manager call it for Ian's org | Refused (no agreement with PG as franchisor) | Red |
| V5 | Direct SQL as app role with `app.org_id` = Ian's org: `SELECT * FROM expenses WHERE org_id = PG` | 0 rows (RLS unchanged — the function is the only door) | Green (guard) |
| V6 | A range before `sales_visible_from` | Refused or clipped (builder states which; the test pins it) | Red |
| V7 | UPDATE / DELETE on `franchise_access_log` as owner | Rejected by trigger | Red |
| V8 | Ian's PG person signs in | One `break_glass_sign_in` row; PG manager sees it via `listFranchiseAccessLog`; PG staff refused (✗) | Red |
| V9 | The function called with no app org set | Refused, no rows, no log row | Red |

**Mutants:** remove the log INSERT from the function → V1 (log count); add `total_expenses` to the return → V2;
change `view_franchise_sales` to admin ✅ → V3 and `capability-matrix.test.ts`; make the function `SECURITY INVOKER`
→ V1 (returns 0 rows, under PG's RLS); drop the agreement check → V4.

### S7 — onboarding Padre Garcia

**TESTER paths:** new `packages/domain/tests/integration/t398-s7-onboard-franchise.test.ts`; new
`tests/unit/t398-s7-multi-org-jobs.test.ts` (asserts every scheduled job iterates `listOrgsToRun`, not a single
org, by scanning job registrations); the existing `tests/unit/organization-insert-callers.test.ts` and
`tests/unit/system-transaction-callers.test.ts` are **ruled** to admit exactly the new call sites.
**BUILDER paths:** `packages/domain/src/organizations/index.ts` (`onboardFranchiseOrganization`);
`scripts/onboard-franchise.ts` (new); `scripts/import-items.ts` (a `--v1-store` filter so PG's items import into PG's
org and are excluded from Ian's — coordinate with T-391, which owns that script's other changes; ⛔ if T-391 is
mid-flight on it, stop and report); `docs/ops/README.md` (the onboarding runbook section).
| Id | Case | Target |
|---|---|---|
| O1 | Onboard on an empty-of-PG DB with Ian's org present | PG org with seeded chart, periods, positions; Ian's PG person = admin; one store; agreement; Ian-side customer (`franchise`, `counterparty_org_id`, price list); PG-side supplier (`counterparty_org_id`) |
| O2 | Run twice | Second is a no-op naming the existing org (by code) |
| O3 | Dry run (no `--confirm`) | Prints the plan, writes nothing |
| O4 | Inject a failure after the org insert | Nothing remains (one transaction for the org half) |
| O5 | PG's manager (the owner) signs in | Sees PG's store only; sees no commissary screen (ADR-008 §6: "no rule needed") — the nav and every Ian-org route return not-found under PG's principal |
| O6 | Link PG's POS store id in PG's org when Ian's org already linked it | Refused (global unique) with a message naming "already linked elsewhere", not the other org's name |
| O7 | Multi-org jobs scan | Every scheduler job iterates orgs |
**§9.4:** on a fresh copy, onboard PG, receive one commissary shipment as PG, read its sales as Ian, open the access
log as PG's manager — screenshots of each, plus `select org_id, count(*) from journal_lines group by 1`.
**Production (4 Dec, with Ian):** run the CLI; PG's money accounts, staff, POS link and opening count are **data
through existing screens**, not code; the 18 Dec rehearsal runs with both orgs (T-394).

---

## 4. Out of scope

- PG's attendance and payroll on v2 (row 302 binds Ian's org; PG's is PG's business — follows Q1's answer).
- BIR invoicing between the two companies (a commissary-to-franchise sale is a taxable sale; v2's wholesale
  documents are not BIR invoices today). Logged as a capability gap by the orchestrator, not built here.
- A group/consolidated view of Ian's own orgs (ADR-008 §5 row 3).
- An org switcher (row 175: one person per org; Ian signs in separately).
- Loyalty across owners (discovery pos-sales-usage Q-C).
- Any change to `bootstrapOrganization` or `/setup`.

## 5. Done when

- Every leg above red→green or green-as-guard as stated; every mutant reds its named leg (auditor's table).
- `OPEN_DEF_491` is empty; DEF-491 and DEF-421 → `fixed` citing commits; the full integration suite green in CI on
  the PR (row 291/296); typecheck clean; each migration applies from zero on a scratch DB (ADR-012 §5.8).
- §9.4 per slice with screenshots; S7's production run done with Ian.
- **Orchestrator / planner records:** a bible row answering ADR-008 Open 2 (same instance; buyer posts on its own
  receipt; reconciliation, not a shared transaction) and Open 3 (each org keeps its own items and stores); Q1-Q4's
  answers; the POSTING-PATTERNS entry; the CAPABILITY-MATRIX rows; the BIR gap in `docs/CAPABILITY-GAPS.md`.

## 6. Questions for Ian (Open Questions page)

- **Q1 — Who signs in at Padre Garcia?** (a) the owner as **manager** of PG's store; you hold PG's **org-admin** as a
  separate person with **a second sign-in email**, and every time you sign in there it is logged where the owner can
  see it; PG staff by PIN · (b) the owner is org-admin from day one and you hold nothing inside PG · (c) you run PG as
  admin until the owner is trained. **Recommended (a)** — row 114's plan; transferable later by data, not code.
- **Q2 — What may you see of PG?** (a) daily sales per store by channel and tender (gross, discounts, net), every
  look logged and visible to the owner · (b) (a) plus item sales mix · (c) monthly totals only. **Recommended (a)** —
  the royalty basis, nothing about their costs (ADR-008 §5). Please also say whether the franchise agreement fixes
  a date from which you may see sales.
- **Q3 — Is PG's v1 history imported?** (a) no: PG starts with opening balances only (its own 31 Dec count, opening
  cash, AP/AR) and its v1 data stays readable in v1 · (b) its 2026 closed sales days, for royalty comparisons ·
  (c) everything. **Recommended (a)** — the roster showed 0 documents for PG; please confirm whether PG has started
  trading in v1.
- **Q4 — At what price does the commissary sell to PG?** (a) a franchise **price list** (ADR-008 §3), first filled
  from today's branch price for each item, then yours to change · (b) the branch price rule as is · (c) cost only.
  **Recommended (a)** — a separate company buys at an agreed price; the price list already exists for wholesale.

## 7. Risks to 4 Dec

| # | Risk | Mitigation |
|---|---|---|
| K1 | DEF-491 is ≈440 constraints in three migrations applied to production during the dual run | `NOT VALID` + `VALIDATE` (R2); apply each outside 05:30-07:00; the pre-flight count is 0 with one org |
| K2 | S2's ≈100 test call-site moves collide with lanes editing the same test files before 15 Nov | S2 in its own worktree; merge at a lane boundary; the full suite in CI |
| K3 | Lanes are needed for C1-C8 before 15 Nov; S1+S2 alone are due 13 Nov | S1/S2 are the plan's "C11 part 1"; S3-S7 start after 15 Nov (≈ 8 lane-days in 13 working days) |
| K4 | Ian's answers and data: Q1-Q4, a second sign-in email, PG's owner and staff names, POS store id, tenders, money accounts | On the Open Questions page now; needed by 20 Nov for S7 |
| K5 | T-391 owns `scripts/import-items.ts`; PG's split collides | S7 stops and reports if T-391 is mid-flight; otherwise one flag |
| K6 | Reconciliation is weaker than a shared transaction (by design) | Daily job + findings in both orgs; E7/E12 pin exactness |
