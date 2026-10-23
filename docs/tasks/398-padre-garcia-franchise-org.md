# T-398: Padre Garcia on v2 as its own organisation (plan C11)

**Status:** S1 LIVE (0194); S2a BUILT, NOT RELEASED 2026-10-18 (DEF-421 ratchet); S2b-S6 SPEC AUDITED, buildable (amended B1-B14, C1-C6); S7 WAITING ON data (Q11 answered b, row 369: PG HR on v2 needs a new task).
**Ian's answers to Q1-Q10, given 2026-10-10** — §0b.
- **Buildable now (no Ian answer needed):** **S2a**, **S2b**, **S3**, **S4** — and their production apply too: Q9 (b)
  lets a DEF-491 migration deploy at any time, short pauses accepted (C2). S3's lock timing still uses a restore taken
  after T-391's production load (B6).
- **S5 — buildable now** (Q4 a, Q6 a, Q7 a, Q8 a answered) once the planner writes the `trade_dispatch.franchise`
  entries in POSTING-PATTERNS (planner work, not Ian's). Two items stay open and are fenced (C3): **Q5** (VAT,
  Ian answers by **13 Nov**) — v2 computes no VAT today (bible #75), so S5 builds the no-VAT legs and a VAT leg, if
  Q5 says (a), is a follow-on amendment; and the **pay-now ruling** (§6) — S5 builds the recommended refusal (E23)
  and rewrites one leg if Ian rules otherwise. Q7's **figures** (limit, terms) are data entered later, not a build.
- **S6 — buildable now** (Q1 a, Q2 **b**: sales **plus stock levels**, C4). Planner prerequisites: the
  CAPABILITY-MATRIX rows for `view_franchise_access_log` and the `view_franchise_sales` reader note.
- **S7 — Q11 answered (b), row 369; PG HR needs a new task** — still blocked by **K4's data** (second sign-in email, owner and
  staff names, POS store id, `org_code`/`store_code`, and Ian's confirmation whether PG trades in v1 today, Q3).
  Q1 and Q3 are answered (a).
- Q10 (a) blocks no build: Ian's written notice to PG is due before 4 Dec production (C6).

Amendments A1-A11, B1-B14 and C1-C6 in §8 bind and win over any earlier sentence they correct; the corrected
sentences are also fixed in place.
**Model:** Sonnet lanes (tester then builder per slice); Opus for the review and for any spec amendment.
**Why now:** bible row 305 (Ian, 2026-10-10, plan-q4 = (b)): *Padre Garcia runs on v2 by 1 January 2027, as its own
organisation.* Row 246's trigger ("before a second organisation is onboarded") therefore fires before cutover, so
DEF-491 and DEF-421 are cutover scope. Plan: `docs/plans/remaining-build-plan.md` §0b and §1.1 C11 (≈ 11 lane-days).
**Deadline:** 4 Dec on production (plan §2.1); second rehearsal with two organisations on 18 Dec.
**Drop-alone rule (plan §2.2):** if S5-S7 are not on production by 4 Dec, Padre Garcia stays on v1 past 1 Jan and
Ian's organisation cuts over alone. S1-S4 land regardless: they harden Ian's own org and cost nothing to keep.
**Migrations:** every slice that has one takes **the next free number at merge** (0209 today, after T-439's 0208 — B8).
No slice hard-codes a number; the journal `when` is the previous entry's + 86 400 000.

---

## 0b. Ian's answers (2026-10-10, Open Questions page — these bind)

The 10 Oct spec and the 17 Oct audit treated Q1-Q10 as open. They were answered on 10 Oct. Two answers are **not**
the recommended option (Q2, Q9); both are folded as given. Each answer still needs its bible row (§5, B14).

| Q | Answer | What it changes here |
|---|---|---|
| Q1 | **(a)** The owner signs in as **manager** of PG's store. Ian holds PG's **org-admin** as a **separate person** with a **second sign-in email**; every use is logged where the owner can see it. PG staff by PIN | R6/R7 as written; S6's break-glass legs (V8a-c) stand; the second email is K4 data |
| Q2 | **(b), not the recommended (a).** From his own org Ian may see PG's **sales plus stock levels**. Every look is logged and visible to the owner | **C4:** S6 adds a second definer function for stock levels (§R6, S6), read-only, quantities only, logged |
| Q3 | **(a)** No v1 history import; PG starts from opening balances on 1 Jan. Ian to confirm whether PG trades in v1 today | S7/B4 as written; the confirmation is K4 data (it decides whether PG's opening has v1 balances to carry) |
| Q4 | **(a)** A franchise price list, first filled from today's branch prices | S5/S7: onboarding creates the price list and fills it from the branch price per item (C5) |
| Q5 | **(c)** Not sure; Ian asks the accountant and answers by **13 Nov** | **S5's VAT posting stays blocked** (C3); everything else in S5 builds |
| Q6 | **(a)** The sale is recorded at dispatch; a PG shortage becomes a credit note | R5/A7 as written |
| Q7 | **(a)** Credit limit + payment terms on PG's customer record; figures from the franchise agreement, **owed by Ian** | S5 builds the mechanism (C5); the numbers are data entered later |
| Q8 | **(a)** The commissary may see per shipment "PG recorded ₱X", nothing else | A3 as written |
| Q9 | **(b), not the recommended (a).** Integrity migrations may run **at any time**; short pauses are accepted. No night window, no Ian-attended precheck required by this rule | **C2:** A1's night-window clause is withdrawn; the lock-timeout, budget and split-VALIDATE rules stay |
| Q10 | **(a)** Written notice to PG that the operator can reach all data and every use is logged | No build; Ian's action before 4 Dec (C6) |

**Answered 2026-10-17:** **Q11 = (b)** PG runs attendance, leave and payroll on v2 from 1 Jan (bible row 369,
**against the recommendation**); **pay-now = (a)** refused, as E23 builds (row 370).

> **Ian's ruling changes the spec (Q11 b, row 369):** PG's HR is no longer out of scope. Before 1 Jan PG needs its
> own statutory rates and withholding brackets (today seeded only for org `shareat`, `0206:317,326`;
> `createOrganization` seeds none), and someone above PG's manager to approve the manager's own leave (row 355;
> PG has no super-admin under Q1 a). §4's "PG's attendance and payroll" and B7 out-of-scope lines no longer hold.
> Planner: write a new task for PG HR on v2 (not T-398 S1-S6); S7 is unblocked on Q11, still waits on K4's data.

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
(`packages/domain/src/trade/index.ts:426`, COGS at `:580-647`; since T-433 it also takes `payNow` and
`creditOverrideReason` and stamps an optional `bir_invoice_no` — B5); supplier deliveries that post inventory + AP
(`packages/domain/src/deliveries/documents.ts:122,313`, capability `receive_delivery`); customer returns and credits
(`packages/domain/src/trade/returns.ts:169,645`); POS links, globally unique per POS store
(`packages/db/schema/pos-v1.ts`, `pos_v1_store_links_pos_store_id_unique`).

**What is missing** — and the order this spec builds it in:

1. **DEF-491** — 370 org→org FKs + 77 derived→org + 5 org→derived/derived→derived FKs + 5 FK-less refs with no same-org check (S1 tester census, A11; T-357 R1 said ≈360 + 79). S1, S3, S4.
2. **DEF-421** — 206 `Tx | null` occurrences in 55 files of `packages/domain/src` (measured 2026-10-17 at
   `c6b16cf`; was 165 in 49 — B2), and 188 `transaction(` calls in 60 files, many of them null branches with no org
   principal. S2 (S2a ratchet, S2b conversion).
3. **The inter-entity sale** — `createTradeOrder` refuses it (`trade/index.ts:198-206`). S5.
4. **The franchisor's sales-only view** and its access log. S6.
5. **Onboarding** — the org, Ian's PG person, the store, the two counterparty rows, then PG's master data loaded by
   T-391's `master-data run` against PG's org (B1), POS link and clock terminal, multi-org checks on every scheduled
   job, and the per-org 1 Jan purge and opening (B4). S7.

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
  - ⚠️ **Production lock budget — corrected by A1.** drizzle applies every pending migration in ONE transaction
    (`drizzle-orm` pg-core `dialect.js:60`), so `NOT VALID` then `VALIDATE` in the same migration gains nothing: each
    `ADD FOREIGN KEY` holds `SHARE ROW EXCLUSIVE` on child and parent, and each `UNIQUE (org_id, id)` holds `SHARE`,
    until commit. The rule is A1 as amended by C2: `SET LOCAL lock_timeout`, a timed run on a production-size
    restore with the budget stated in the migration header, deploy at any time (Q9 b — no night window), and
    `VALIDATE` in a separate deploy where the budget is exceeded.
  - **Pre-flight, fail closed** (T-357 R4): a DO block counts cross-org rows per FK and RAISEs naming each non-zero
    one with *"DEF-491: no silent fix; each row needs a human decision"*. Production holds one org, so its count is
    0 by construction; a lane DB with residue is re-made, never the migration edited (T-357 R7).
- **R3 — Derived-scope children (A11: 77 derived→org + 5 org→derived/derived→derived) get a trigger, not a new column.** One generic `plpgsql` function,
  `assert_same_org_via_parent()`, parameterised by `TG_ARGV` (child FK column, header table, header FK column,
  target table), raising `23503`-class `foreign_key_violation` with a named message; one `BEFORE INSERT OR UPDATE OF
  <col>, <header fk col>` trigger per FK. Reason: adding `org_id` to ≈40 child tables means backfill + 40 Drizzle
  schema changes + 40 repo writers, for the same guarantee. ⛔ **Corrected by A2:** a trigger runs as the INVOKER;
  under `shareat_app` with FORCE RLS a cross-org target is invisible, so a plain comparison sees NULL and passes. The
  function therefore RAISEs when the header or the target is NOT FOUND (precedent: `0185:126`). The census
  test reads the registry of these triggers from `pg_trigger` (`tgargs`), not from a TS list.
- **R4 — DEF-421: `tx: Tx` is non-nullable in `packages/domain/src`, with a closed allow-list.** The compiler is the
  guard (a `null` argument stops typecheck), plus a source-scanning unit test so the allow-list cannot grow silently.
  - **Allowed to keep `Tx | null`.** In `packages/domain/src`: **only `runDepreciation`** (DEF-421 note: one tx per
    asset). The AUTH door — `signInWithPin`, `signInWithFirebase`, `resolveTerminalIdentity`, `resolveActor`,
    `signOut` in `packages/auth/src/sessions.ts` (`:94,379,495,557,597`), **plus the two PIN approval verifiers**
    `verifyAdminApproval` (`packages/auth/src/admin-approval.ts:40`) and `verifyPosManagerApproval`
    (`packages/auth/src/pos-approval.ts:47`) (B3) — lives outside the scan root and stays as it is. Any other
    function found to need it is a **spec defect to report**, not an addition.
  - `runDepreciation`'s null branch opens `withOrgPrincipal(orgId, …)` per asset, never a bare `transaction()`.
  - No `transaction(` call remains in `packages/domain/src`. That includes the **bare `transaction((trx) => …)`
    forms** that are not `transaction(run)` (A9 names them, e.g. `files/index.ts:112,282`, `expenses/*`,
    `ledger/post-entry.ts:148`, `ledger/reverse-entry.ts:92`, `money-accounts/index.ts:77,129`,
    `money-transfers/index.ts:68,164`, `fixed-assets/*`); each one's principal is ruled in A9.
  - The 12 non-test `null` callers (`apps/erp/src/app/fixed-assets/actions.ts:205`, sign-in, setup, session,
    `scripts/smoke-pin-throttle.ts:51`) are all allow-listed functions; nothing else changes in apps.
  - The test call sites that pass `null` (44 test files pass `(null, ` today; the tester lists them — B2) move to
    `withOrgPrincipal(org, (tx) => fn(tx, …))`. That is the tester's work in S2b, and it is the bulk of S2.
  - **B2: S2 is split.** S2a lands the scan (T1/T2) first as a **ratchet pinned at today's measured counts**, so no
    lane adds to DEF-421 while S2b converts it.
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
  - **Shortage — corrected by A7:** PG receives less → its AP is for what it received. The seller sees it through
    the reconciliation function (A3) and raises a **credit note** (contra-revenue / `CR 1210`) with the lost cost
    expensed as a loss, modelled on the commissary discrepancy-loss pattern — **not** `recordCustomerReturn`, because
    nothing comes back. No automatic cross-org write.
  - **Reconciliation, scheduled (06:30 Manila) and on demand — mechanism ruled by A3** (the per-org loop cannot
    read the other org): compares per shipment *seller charged − credits* with *buyer AP posted*, and per
    pair *seller AR balance for the franchise customer* with *buyer AP balance for the commissary supplier*. A
    difference raises a finding **in each org, in that org's own words** (the seller does not see the buyer's AP
    detail, only "Padre Garcia has recorded ₱X against shipment N"). This is ADR-008 §4's "the same debt viewed
    twice", checked rather than assumed.
  - **Payments** are recorded independently on each side (PG's AP payment, the commissary's AR collection); the
    balance check above catches a one-sided payment. **B5:** `dispatchTradeOrder`'s `payNow` is refused on an
    inter-entity order, and the seller-side `receiveTradeOrder` (`trade/index.ts:887`) is refused for an
    inter-entity order (PG confirms receipt in its own books) — *orchestrator recommendation, pending Ian's ruling*.
  - **Price:** the franchise customer's price list (ADR-008 §3) — Q4 (a): created at onboarding, first filled from
    today's branch price per item, then Ian's to change (C5).
  - **Credit:** Q7 (a) — PG's customer row carries a credit limit (the existing `customers.credit_limit`, enforced at
    dispatch with the manager override, `schema/customers.ts:150-159`) and payment terms (new, C5). Figures are data.
  - The posting pattern **"dispatch to a franchise"** is added to `docs/POSTING-PATTERNS.md` by the planner **before
    S5's tester starts** (ADR-008 "What this changes today"); S5 implements it, it does not decide it.
- **R6 — The franchisor's view is enforced in the database, and the log is written by the database.**
  - `franchise_agreements` — `org_id` = the franchisee (PG), `franchisor_org_id` → `organizations`,
    `franchisor_person_id` (Ian's person **in PG's org**, so a same-org FK), `sales_visible_from`, scope. Written only
    by the S7 onboarding path; readable by both orgs.
  - `franchise_access_log` — append-only (trigger refuses UPDATE/DELETE), readable by both orgs: who, when, which
    org, which range, what (`sales_daily` / `break_glass_sign_in` / `break_glass_approval` — B3), reason.
  - `franchise_sales_daily(franchisee_org uuid, from date, to date)` — `SECURITY DEFINER`, `search_path` pinned. It
    returns **only** store, business date, channel, tender, gross, discounts, net and sales-day status, and only when
    an agreement row has `franchisor_org_id = app_current_org()` and the range is on/after `sales_visible_from`. It
    **inserts the log row itself**, so no caller can read without logging.
  - **C4 (Q2 b) — `franchise_stock_levels(franchisee_org uuid, store uuid)`**, same guards as the sales function
    (`SECURITY DEFINER`, `search_path` pinned, agreement with `franchisor_org_id = app_current_org()`, A5's person
    and super-admin checks, `EXECUTE` to `shareat_app` only, it inserts its own log row with what = `stock_levels`).
    **Read-only, a snapshot "as of now", quantities only.** It returns exactly, per PG store and per PG item with a
    non-zero on-hand or a threshold row: store, item name, base unit, **on-hand quantity** (the sum of
    `stock_movements` quantity across all the store's locations — the same definition as `lowStock`,
    `packages/db/src/repo/low-stock.ts`), the store's **threshold** for the item (`store_item_thresholds`, NULL when
    none), a **below-threshold** boolean, and `as_of` (the call's timestamp). It returns **no** cost, value, rate,
    layer, supplier, movement history, count variance or wastage column — those are PG's cost structure (ADR-008
    §5). No history range: Ian sees today's stock, not a time series. Items are PG's own items (Open 3).
  - `franchise_access_log.what` gains `stock_levels`; the log row records the store asked for (range columns NULL).
  - The domain `viewFranchiseSales(tx, actor, …)` and `viewFranchiseStock(tx, actor, …)` each call
    `authorize(…, 'view_franchise_sales')` first (§15.11: two layers — the capability and the function's own agreement
    check). One capability covers both reads (Ian's org super-admin only); the matrix note says "sales and stock
    levels of a franchisee, per Q2 (b)".
  - **Full-books access is not this function.** It is Ian's own person row in PG's org (row 175), with its own
    credential; every session that person opens — **by email or by PIN** (`signInWithPin` is per org, so a PG
    terminal accepts that person's PIN) — writes a `break_glass_sign_in` row, and every PIN approval that person
    gives through `verifyAdminApproval` or `verifyPosManagerApproval` writes a `break_glass_approval` row (B3). That
    **is** the break-glass of T-121 A.3: an identity, not a bypass, and PG can see each use.
  - A PG `manager` can read the log through a new capability `view_franchise_access_log` (store-less, org scope;
    manager + admin ✅, staff ✗). CAPABILITY-MATRIX row added by the planner before S6's tester starts.
- **R7 — Onboarding is a CLI, not `/setup`.** `bootstrapOrganization` refuses a second org by design
  (`organizations/index.ts:349-360`) and that stays. A new domain function `onboardFranchiseOrganization` calls
  `createOrganization` + `createFirstAdmin` (Ian's PG person, org-admin) + the store, in one system transaction; the
  two counterparty rows (Ian-side customer with `counterparty_org_id`, PG-side supplier with `counterparty_org_id`)
  and the agreement row are written each under its own org principal. `scripts/onboard-franchise.ts` follows
  `scripts/bootstrap-org.ts`'s guards exactly (no defaults, `--confirm`, dry run by default, never a unit).
  - **B10:** the CLI takes `--last`, `--first` and `--middle` for Ian's PG person and writes them through the
    name-parts path (T-438, row 360); `createFirstAdmin`'s `displayName`-only form is not enough.
  - **B1:** the CLI's `--code` **must equal** the PG `org_code` in Ian's `stores.csv` (today the placeholder
    `PADRE_GARCIA`), and the store code must equal its `store_code`; T-391's `assertRunTarget`
    (`packages/etl/src/master-data/store-map.ts:87-94`) refuses a run otherwise. The CLI's PG-side supplier and
    Ian-side customer take the v1 names of the commissary-mirror supplier and the PG AR customer, so T-391's planner
    links them instead of creating them twice.
  - ⚠️ `person_credentials_external_id_unique` is global (`schema/sessions.ts:134`): **Ian needs a second sign-in
    identity** (another email) for his PG person. Q1.

---

## 3. Slices

Order: **S1 ∥ S2 → S3 → S4 → (S5 ∥ S6, merges serialised: S5 first) → S7.** (B2: S2a lands first, now, on its
own; S2b follows.) S1 and S2 touch disjoint trees (db schema/migrations vs domain/tests)
and share no state if each runs on its own lane DB (row 298 worktrees). S5 and S6 both edit the migration journal, `cutover/classification.ts` and `rls/registry.ts`
(A10): they build in parallel worktrees but **merge one after the other, S5 first**; S6 rebases, renumbers to the next
free slot and re-runs `migration-journal.test.ts`, `rls-registry.test.ts` and `cutover-classification.test.ts`.

| Slice | What | Migration | Size | Needed by |
|---|---|---|---|---|
| **S1** | Census guard (A8 scope) + exemptions file; persons (153) + stores (76) = 229 composites (A11) | yes | M 2 | 13 Nov (plan) |
| **S2a** | DEF-421 ratchet (B2): T1/T2 pinned at today's counts; may fall, never rise | none | S 0.2 | now |
| **S2b** | DEF-421: non-nullable `tx`, allow-list guard at its final value, tests moved to principals | none | M 1.8 | 13 Nov |
| **S3** | DEF-491: the remaining org→org parents (journal_entries, items, stock_locations, suppliers, employments, the rest: 141) + 5 FK-less `ref-gap` columns (A11) | yes | M 1.5 | 20 Nov |
| **S4** | DEF-491: the 82 derived-scope FKs (A11) by trigger; `OPEN_DEF_491` reaches empty | yes | S-M 1.5 | 24 Nov |
| **S5** | Inter-entity sale: shipment handoff, definer receive/void, credit note, reconciliation fn | yes | L 3.5 | 1 Dec |
| **S6** | Sales + stock-levels view (C4) + access log + break-glass sign-in logging + screens (A5 hardening) | yes | M 2.3 | 2 Dec, merged after S5 |
| **S7** | Onboarding CLI, then T-391's master-data load into PG (B1), POS link + clock terminal, multi-org job checks, per-org purge runbook, two-org rehearsal data | none expected | M 1.5 | 4 Dec |
| | **Total** | 5 | **≈ 14.3** (was 13.5; S2 re-sized to ≈ 2.0 by B2; S6 +0.3 for stock levels, C4) | |

### S1 — the census guard, persons and stores (DEF-491 part 1)

**TESTER paths:** new `packages/db/tests/integration/t398-s1-same-org-fk-census.test.ts`; new
`packages/db/src/rls/same-org-fk-exemptions.ts` (seeded with the full measured list, persons/stores entries marked for
deletion by the builder); new `packages/db/tests/integration/t398-s1-persons-stores-same-org.test.ts`.
**BUILDER paths:** the new migration; `packages/db/migrations/meta/_journal.json`; the Drizzle schema files holding
the 229 child columns (A11) (the builder lists them in its report, from the census query); `schema/persons.ts`,
`schema/stores.ts` (NOTE comments for the hand-added uniques); `same-org-fk-exemptions.ts` (deletions only).
⛔ No domain/repo/app code, no other test file, not the register or the bible.

| Id | Case | Target | Red today |
|---|---|---|---|
| C1 | Census: every org→org FK has a composite twin, or is in one of the two lists | Pass | Red once the 229 persons/stores entries are removed from `OPEN_DEF_491` (the tester records that red on its branch, then restores them; the builder deletes them in the same PR as the migration) |
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

**Split by B2 into S2a (now) and S2b (the conversion).**

**S2a — the ratchet (≈ 0.2 day, tester only, buildable now).** New `tests/unit/t398-s2-domain-tx-non-nullable.test.ts`
with T1 and T2 written as **ceilings pinned at the counts measured on main at `c6b16cf` (2026-10-17)**:
- T1 ceiling: **206** occurrences of the literal `Tx | null` across **55** files under `packages/domain/src`;
- T2 ceiling: **188** occurrences of `\btransaction\(` across **60** files under `packages/domain/src`
  (and **38** lines importing `transaction` there).
The test fails if any count rises above its pin, and also fails (stale pin) if a count falls without the pin being
lowered in the same commit, so the number only ever goes down. The tester re-measures on the branch's base before
committing and writes the measured numbers (not these, if main has moved) into the file, stating the commit.
S2a touches no other file. S2b later replaces the ceilings with T1/T2's final form below.

**S2b TESTER paths:** the same test file, its pins replaced by T1/T2's final form; every test file that passes `null`
to a domain function (44 test files pass `(null, ` today; the tester lists them) — **only** the `null` →
`withOrgPrincipal` change; new `packages/domain/tests/integration/t398-s2-depreciation-principal.test.ts`.
**S2b BUILDER paths:** `packages/domain/src/**` signatures and null branches only. No behaviour change **except** the
A9 bare-`transaction((trx) => …)` sites, each of which now opens the principal A9 rules. ⛔ No app, db, auth, or test
file.

| Id | Case | Target | Red today |
|---|---|---|---|
| T1 | Scan: `Tx \| null` appears only on `runDepreciation` (A9, B2) | Pass | Red: 206 sites (S2a pins this as a ceiling meanwhile) |
| T2 | Scan: no `transaction(` import in `packages/domain/src` outside the allow-listed files | Pass | Red |
| T3 | Typecheck with one test deliberately passing `null` to `createTradeOrder` (a `// @ts-expect-error` line) | The directive is satisfied (i.e. `null` is a type error) | Red: `@ts-expect-error` unused |
| T4 | `runDepreciation(null, …)` as the app role over two assets | Both post; each ran under `app.org_id` = the actor's org (read back `current_setting` inside a test hook, or the posted rows' visibility under RLS) | Red if the null branch is a bare `transaction()` under the app role (DEF-417 refusal) |
| T5 | Full integration suite | Green with only R4's call-site moves | — |

**Mutants:** re-add `| null` to `dispatchTradeOrder` → T1; replace one `withOrgPrincipal` in `runDepreciation` with
`transaction` → T2 and T4; add a second name to the allow-list → T1's pinned list (the list is pinned by value).
S2a mutant: add one `Tx | null` to any domain file → T1's ceiling reds.

### S3 — DEF-491, the remaining org→org parents

**TESTER paths:** new `packages/db/tests/integration/t398-s3-same-org.test.ts` (one INSERT-as-app-role leg per parent
table, ≥ 1 per parent, the tester names the child), plus M1/M2 as in S1.
**BUILDER paths:** the new migration, the journal, the Drizzle schema files for the children, NOTE comments on each
parent, `same-org-fk-exemptions.ts` (deletions only).
**B6 — skip parents that already carry the key.** Add `UNIQUE (org_id, id)` **only** to parents that do not already
have `<parent>_org_id_id_unique`. At least seven S3 parents already do — `items`, `production_recipes`,
`stock_locations` (`0196:56-58`); `employments`, `positions`, `pay_runs`, `separations` (`0205:23-29`);
`stored_files` (`0204:11`); `pos_v1_store_links` (`0202:15`); `money_accounts` (earlier). A second
`ADD CONSTRAINT … UNIQUE` with the same name fails the migration. **Generate the list from `pg_constraint`, not by
hand**, and paste the query in the migration header.
**B6 — lock timing:** A1's timed run is done on a restore taken **after** T-391's production load, because items and
parties are now real rows.
**C2 — deploy (Q9 b):** the migration ships with the next ordinary deploy, **at any hour**; short pauses are
accepted. No night window and no Ian-attended precheck. What still binds: `SET LOCAL lock_timeout = '5s'`, the
timed budget in the header, the fail-closed pre-flight, and the split `VALIDATE` deploy if the timed run exceeds 60 s.
A deploy whose migration hits `lock_timeout` fails and is simply re-run; it is never edited to pass.
Legs: K1 (census green with the shrunken list), **K2 (B6): every composite's parent has exactly one `(org_id, id)`
unique** (catalog), one F-leg per parent (`23503` as `shareat_app`), one owner leg,
same-org controls, M1/M2. **Workflow sweep allowed** (row 298 #5) for writing the 146 `ADD CONSTRAINT` lines from
the census query output; the builder pastes the query and the sweep's diff stat in its report.
**Mutants:** drop any one composite → C1; reorder `VALIDATE` before `ADD … NOT VALID` → migration fails on scratch;
add a duplicate `(org_id, id)` unique on a parent that already has one → K2.

### S4 — DEF-491, the derived-scope children

**TESTER paths:** new `packages/db/tests/integration/t398-s4-derived-same-org.test.ts`.
**BUILDER paths:** the new migration (R3's function + 82 triggers + pre-flight), the journal,
`same-org-fk-exemptions.ts` (deletions to empty).
**C2 — deploy (Q9 b):** as S3 — any hour, short pauses accepted, `lock_timeout` + budget header still required.
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

**Buildable now (C3).** Q4 (a), Q6 (a), Q7 (a), Q8 (a) are answered. Fenced, not blocking:
- **Q5 (VAT, answer by 13 Nov):** v2 computes no VAT anywhere today (`POSTING-PATTERNS.md:124`, bible #75), so the
  seller legs are the external-sale legs exactly (E1) and PG's receipt is `DR 1310 / CR 2110` with no VAT split.
  If Q5 comes back (a), a follow-on amendment adds the output/input VAT legs (and the POSTING-PATTERNS lines) as a
  separate slice; if (b), nothing changes. No leg in this slice may assert "no VAT line exists" — that would pin an
  answer Ian has not given.
- **Pay-now ruling (§6):** build E23 as the recommended refusal; if Ian rules (b), E23 is rewritten as stated there.
**Planner pre-requisite:** the `trade_dispatch.franchise` and `trade_dispatch.franchise_transit_shortage` entries in
`docs/POSTING-PATTERNS.md` (R5, A7), written **now** with a "VAT: pending Q5 (13 Nov)" note, replacing the
"do not use for a franchise" warning at `POSTING-PATTERNS.md:743` with a pointer to them (B14).
**C5 — price and credit (Q4 a, Q7 a):** S5's migration adds `customers.credit_terms_days integer NULL`, with the same
check as `suppliers.credit_terms_days` (`schema/suppliers.ts:145,182`): NULL = no terms set, display and AR ageing
only, ⛔ never an input to an accounting decision; the enforced gate stays `credit_limit` at dispatch. The limit and
days for PG are **data** Ian enters from the franchise agreement. New legs **E26** (`credit_terms_days` stored and
shown; negative refused by the check) and **E27** (a dispatch over PG's `credit_limit` without override is refused,
the same as any customer — a guard leg proving the inter-entity branch did not bypass the gate).
**TESTER paths:** new `packages/domain/tests/integration/t398-s5-inter-entity-sale.test.ts`; new
`packages/db/tests/integration/t398-s5-shipment-rls.test.ts`; the existing T-133 refusal test
**`packages/domain/tests/integration/trade.test.ts:873`** (it asserts `/no second org exists/`) is **ruled** to
assert the new behaviour (B8).
**BUILDER paths:** the new migration (`suppliers.counterparty_org_id`; `inter_entity_shipments` +
`inter_entity_shipment_lines` with a dual-org RLS policy — SELECT `org_id = app_current_org() OR buyer_org_id =
app_current_org()`, INSERT/UPDATE/DELETE seller only; `deliveries.inter_entity_shipment_id`); the journal;
`schema/suppliers.ts`, `schema/deliveries.ts`, a new `schema/inter-entity.ts`; `packages/db/src/repo/` for the new
tables; `packages/db/src/cutover/classification.ts` and `packages/db/src/rls/registry.ts` (the build requires both);
`same-org-fk-exemptions.ts` (`CROSS_ORG_BY_DESIGN` += `deliveries.inter_entity_shipment_id`,
`inter_entity_shipments.buyer_org_id` is to `organizations` and needs nothing); `packages/domain/src/trade/index.ts`;
`packages/domain/src/deliveries/`; a new `packages/domain/src/trade/inter-entity-reconcile.ts`; the scheduler entry
point in `packages/domain/src/scheduler/index.ts` (iterating `listOrgsToRun`) plus its `docs/ops/*.service` /
`*.timer` pair (B11); `apps/erp/src/app/inventory/deliveries/` (`actions.ts`, `lib.ts` — an "Inbound from
commissary" list and receipt form on the existing delivery screens; B8) and `apps/erp/src/app/trade/` (treatment
label only); `apps/erp/src/lib/route-capability.ts` (B9: the inbound list → `receive_delivery`; each new page calls
`requirePageAccess`, and `tests/unit/{route-capability-coverage,no-ungated-read-surface,nav-route-reachability}.test.ts`
stay green).
**B5 — dispatch since T-433:** E1's control order uses **no `payNow` and no `creditOverrideReason`**. The shipment
snapshot carries the order's `bir_invoice_no` (0203) when set, for PG's input VAT under Q5.
**Paths added by C5:** `schema/customers.ts` (the new column), the customer edit form and its action under
`apps/erp/src/app/` (the field beside credit limit).

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
| E14-E21 | As A3, A4, A6, A7 in §8 | — | Red |
| E22 | (B5) Seller calls `receiveTradeOrder` (`trade/index.ts:887`) on a dispatched `inter_entity` order | Refused: "Padre Garcia confirms receipt in its own books"; nothing written | Red (accepted today via `approve_buyer`, `:906`) |
| E23 | (B5, pending Ian) `dispatchTradeOrder` with `payNow` on an `inter_entity` order | Refused in words; nothing posted. *If Ian rules "allow" instead: it posts, and E12's one-sided-payment finding fires until PG records its AP payment — the leg is rewritten to that* | Red |
| E24 | (B9, row 353, ADR-008 §5) The shipment snapshot as PG reads it | Holds no person name and no cost column (catalog check on the snapshot columns plus a row read) | Red |
| E25 | (B5) Order dispatched with a `bir_invoice_no` | The shipment carries the same number; without one, NULL | Red |
| E26 | (C5, Q7 a) Set PG's `credit_terms_days` = 30; then try −1 | Stored and shown; −1 refused by the check | Red (column absent) |
| E27 | (C5, Q7 a) Dispatch to PG over its `credit_limit`, no override | Refused exactly as for an external customer; with a manager override it posts | Green (guard) |

**Mutants:** drop the `OR buyer_org_id` arm → E3 red; widen it to UPDATE → E4 red; post buyer AP at the dispatched
(not received) quantity → E7 red; let reconciliation tolerate ±1 centavo → E12 (exact-centavo assertion); derive
treatment from `customer_group` → E13; remove the `receiveTradeOrder` inter-entity refusal → E22; drop the `payNow`
refusal → E23; add `unit_cost` to the snapshot → E24; skip the credit-limit check when `treatmentOf` =
`inter_entity` → E27.

### S6 — the franchisor's sales-and-stock view and the access log

**Buildable now** — Q1 (a) and Q2 (**b**, C4) answered.
**Planner pre-requisite:** CAPABILITY-MATRIX rows for `view_franchise_access_log` (R6) and a note on
`view_franchise_sales` naming its reader and its scope "sales and stock levels, per Q2 (b)" (still open on 17 Oct —
B14).
**C4 — stock levels (Q2 b):** the migration also creates `franchise_stock_levels` (R6) and widens
`franchise_access_log.what` to include `stock_levels`; the domain adds `viewFranchiseStock`; the screen adds
`/franchise/stock` (Ian's org: pick a PG store, see today's on-hand per item, threshold, below-threshold flag; no
edit control anywhere) → `view_franchise_sales` in `route-capability.ts`. PG's access-log screen shows stock looks
beside sales looks.
**TESTER paths:** new `packages/db/tests/integration/t398-s6-franchise-sales-fn.test.ts`; new
`packages/auth/tests/integration/t398-s6-franchise-capabilities.test.ts`; new
`apps/erp/tests/integration/t398-s6-view-franchise-sales.test.ts`.
**BUILDER paths:** the new migration (two tables, the function, the append-only trigger, grants: `EXECUTE` to
`shareat_app` only); the journal; a new `schema/franchise.ts`; repo; classification + RLS registry;
`packages/auth/src/capabilities.ts` (the new capability, matrix, labels, area); `packages/domain/src/franchise/`
(new: `viewFranchiseSales`, `viewFranchiseStock` (C4), `listFranchiseAccessLog`); the sign-in path for a person whose org has a
agreement and who is its `franchisor_person_id` (logs `break_glass_sign_in`) in
`packages/auth/src/sessions.ts` — **both** `signInWithFirebase` and `signInWithPin` (B3) — (A5: also where
`app.person_id` is set for this path); `packages/auth/src/admin-approval.ts` and `packages/auth/src/pos-approval.ts`
(B3: an approval by the franchisor person writes `break_glass_approval` through the same definer function);
`packages/db/src/rls/principal.ts` (A5/B13: `withOrgPrincipal` gains an optional `personId` passed into `openAs`;
`applyPrincipal`'s existing branch at `:51-52` is the model); `apps/erp/src/app/franchise/`
(new screens: sales by day/channel/tender and stock levels (C4) for Ian's org; access log for PG's org); nav entry
gated on the capability; `apps/erp/src/lib/route-capability.ts` (B9: `/franchise/sales` and `/franchise/stock` →
`view_franchise_sales`, `/franchise/access-log` → `view_franchise_access_log`; each page calls `requirePageAccess`;
the three T-435 unit guards stay green).

| Id | Case | Target | Red today |
|---|---|---|---|
| V1 | Ian (super-admin, his org) reads PG's sales for a week | Rows match PG's verified sales days to the centavo; one log row per call, visible as PG | Red (no reader) |
| V2 | The function's result columns | Exactly the R6 list (catalog check on the function's `RETURNS TABLE`) — no expense, COGS, payroll or AP column can be added without this leg reddening | Red |
| V3 | Ian's org admin / manager / staff call `viewFranchiseSales` | `AuthorizationError` ×3 (the ✗s) | Red |
| V4 | PG's admin and manager call it for Ian's org | Refused (no agreement with PG as franchisor) | Red |
| V5 | Direct SQL as app role with `app.org_id` = Ian's org: `SELECT * FROM expenses WHERE org_id = PG` | 0 rows (RLS unchanged — the function is the only door) | Green (guard) |
| V6 | A range before `sales_visible_from` | Refused or clipped (builder states which; the test pins it) | Red |
| V7 | UPDATE / DELETE on `franchise_access_log` as owner | Rejected by trigger | Red |
| V8a | (B3) Ian's PG person signs in **by email** | Exactly one `break_glass_sign_in` row; PG manager sees it via `listFranchiseAccessLog`; PG staff refused (✗) | Red |
| V8b | (B3) Ian's PG person signs in **by PIN** at a PG terminal | Exactly one `break_glass_sign_in` row | Red |
| V8c | (B3) Ian's PG person gives a PIN approval through `verifyAdminApproval`, and again through `verifyPosManagerApproval` | Exactly one `break_glass_approval` row each | Red |
| V9 | The function called with no app org set | Refused, no rows, no log row | Red |
| V15 | (C4) Ian (super-admin, his org) reads one PG store's stock | Each item's on-hand equals the sum of that store's `stock_movements` across all its locations (two locations seeded) and equals `lowStock`'s on-hand for items with a threshold; exactly one `stock_levels` log row, visible to PG's manager | Red |
| V16 | (C4) `franchise_stock_levels`' result columns | Exactly: store, item name, base unit, on-hand, threshold, below-threshold, `as_of` (catalog check) — no cost, value, rate, layer, supplier or movement column | Red |
| V17 | (C4) The stock function is read-only and fenced | Called by a third org, by Ian's org without an agreement, with a NULL person, or by a non-super-admin → refused, no rows, no log row; `stock_movements`/`stock_layers` row counts and PG's 1310 balance unchanged after a successful call | Red |
| V18 | (C4) Ian's org admin / manager / staff call `viewFranchiseStock` | `AuthorizationError` ×3 | Red |

**Mutants:** remove the log INSERT from the function → V1 (log count); add `total_expenses` to the return → V2;
add `unit_cost` or a valuation column to the stock return → V16; remove the stock function's log INSERT → V15;
drop its agreement check → V17;
change `view_franchise_sales` to admin ✅ → V3 and `capability-matrix.test.ts`; make the function `SECURITY INVOKER`
→ V1 (returns 0 rows, under PG's RLS); drop the agreement check → V4; drop the PIN-path log → V8b; drop the
log call from either approval verifier → V8c.

### S7 — onboarding Padre Garcia

**Blocked by:** K4's data (see Status); Q11 answered (b), row 369. Q1 (a) and Q3 (a) are answered: Ian's PG person is org-admin with
the second email, the owner is PG's manager, and PG opens from balances on 1 Jan. **Ian's confirmation whether PG
trades in v1 today** (Q3) is K4 data: if it does, PG's 31 Dec count and open AP/AR are its opening entry; if not, the
opening is the count and cash alone.
**C5 (Q4 a):** `onboardFranchiseOrganization` creates PG's franchise price list on Ian's side and fills it, per item
the commissary sells, from today's branch price; the CLI's dry run prints the item count and the total it would
write. New leg **O11**: after onboarding the price list has one line per commissary-offered item, each equal to that
item's branch price at onboarding time; a later change to the branch price does not move the franchise price.
**TESTER paths:** new `packages/domain/tests/integration/t398-s7-onboard-franchise.test.ts`; new
`tests/unit/t398-s7-multi-org-jobs.test.ts` (B11: scans every `ExecStart` script in `docs/ops/*.service`; each must
reach `listOrgsToRun` (`packages/domain/src/scheduler/index.ts:220`) or be on a pinned allow-list — `dual-run`
(single-org by design, `packages/etl/src/dual-run/snapshot.ts:60`), `db-backup`, `restore-drill` — each with its
reason); the existing `tests/unit/organization-insert-callers.test.ts` and
`tests/unit/system-transaction-callers.test.ts` are **ruled** to admit exactly the new call sites.
**BUILDER paths:** `packages/domain/src/organizations/index.ts` (`onboardFranchiseOrganization`);
`scripts/onboard-franchise.ts` (new; takes `--last/--first/--middle` for Ian's PG person — B10);
`scripts/provision-terminal.ts` (the `--org` flag — B12);
`docs/ops/README.md` (the onboarding runbook section). ⛔ **`scripts/import-items.ts` is NOT touched (B1)**: PG's
items, suppliers, customers and staff are loaded by T-391's existing command, not by a new filter.
**B1 — the data load, in this order:**
1. `onboard-franchise --code <C>` where `<C>` **equals** PG's `org_code` in Ian's `stores.csv` (today the
   placeholder `PADRE_GARCIA`), and the store code equals that row's `store_code`. Ian fixes the CSV or the code
   so they match **before** step 1; `assertRunTarget` refuses any mismatch.
2. Then T-391's load against PG: `npm run master-data -- run --snapshot <dir>/v1-snapshot.json --map
   <dir>/stores.csv --org <PG uuid> --org-code <PG code> --stores <PG store code> --actor <Ian's PG person uuid>
   --sheets <dir>` (dry run), then the same with `--apply`. Onboarding always comes before the load.
3. The CLI's PG-side supplier and Ian-side customer are named exactly as v1's commissary-mirror supplier and PG AR
   customer, so the planner links them rather than creating a second copy.
**B12 — clock terminal:** PG staff sign in by PIN only, so the runbook adds `scripts/provision-terminal.ts --org
<PG uuid>` for PG's store. ⚠️ That flag **does not exist yet**: `findStoreByCode` looks a store up by code alone and
its comment says a second organisation "would need `--org=` added here" (`scripts/provision-terminal.ts:101-110`).
S7's BUILDER therefore also owns `scripts/provision-terminal.ts`: add a required-when-more-than-one-org `--org`,
and refuse a code that matches stores in two orgs without it (new leg **O10**).
**B4 — the 1 Jan purge is per org:** `applyPurge` loops every org and refuses unless each has a performer
(`packages/db/src/cutover/purge.ts:513-528`), so PG's December operational rows (shipments, receipts, AR, AP) are
purged on both sides; configuration survives. The runbook (T-394) therefore says: `npm run cutover:purge -- … --apply`
gets **one `--by <personId>` per organization** — Ian's org's performer **and** `--by <Ian's PG person uuid>` (the
script maps each person to its org, `scripts/cutover-purge.ts:198-222`; the audit's `--performed-by` form does not
exist); PG's opening entry (Q3 (a): count, cash,
AP/AR) is entered **per org after** the purge; 3900 = 0 is checked **per org**; **no real inter-entity trade is
posted on production before 1 Jan**, except as part of a rehearsal.
| Id | Case | Target |
|---|---|---|
| O1 | Onboard on an empty-of-PG DB with Ian's org present | PG org with seeded chart, periods, and the six canonical positions **by their row-362 names** (e.g. "Kitchen Staff", 0208); Ian's PG person = admin, with last/first/middle name parts set (row 360, B10); one store; agreement; Ian-side customer (`franchise`, `counterparty_org_id`, price list); PG-side supplier (`counterparty_org_id`) |
| O2 | Run twice | Second is a no-op naming the existing org (by code) |
| O3 | Dry run (no `--confirm`) | Prints the plan, writes nothing |
| O4 | Inject a failure after the org insert | Nothing remains (one transaction for the org half) |
| O5 | PG's manager (the owner) signs in — **with an org-wide role and no employment row** (row 340, B12) | Sign-in succeeds; sees PG's store only; sees no commissary screen (ADR-008 §6: "no rule needed") — the nav and every Ian-org route return not-found under PG's principal |
| O6 | Link PG's POS store id in PG's org when Ian's org already linked it | Refused (global unique) with a message naming "already linked elsewhere", not the other org's name |
| O7 | Multi-org jobs scan (B11) | Every `docs/ops/*.service` `ExecStart` reaches `listOrgsToRun` or is on the pinned allow-list with its reason; S5's 06:30 reconciliation job is in the scanned set |
| O8 | (B1) After onboarding, a PG `master-data run` dry run on the T-391 snapshot fixture | Plans **0** new suppliers named like the commissary and **0** new customers named like PG (both linked); a `--org-code` that differs from the onboarded code is refused |
| O10 | (B12) `provision-terminal` with a store code present in both orgs: without `--org`, and with `--org <PG>` | Without: refused, naming the ambiguity; with: provisions PG's store only |
| O9 | (B4) Two-org purge on a scratch DB: both orgs with December trades, `cutover:purge --apply` with one `--by` per org, then an opening entry per org | Apply refuses with either `--by` missing; after it and the openings, 3900 = 0 **in each org** |
**§9.4:** on a fresh copy, onboard PG, receive one commissary shipment as PG, read its sales as Ian, open the access
log as PG's manager — screenshots of each, plus `select org_id, count(*) from journal_lines group by 1`.
**Production (4 Dec, with Ian):** run the CLI, then T-391's load (B1), then provision PG's clock terminal (B12); PG's
money accounts, POS link and opening count are **data through existing screens**, not code; the 18 Dec rehearsal runs
with both orgs (T-394), including the per-org purge and opening (B4, O9).

---

## 4. Out of scope

- ~~PG's attendance and payroll on v2~~ — **back in scope by Q11 (b), row 369**: a new task, not T-398.
- BIR invoicing between the two companies (a commissary-to-franchise sale is a taxable sale; v2's wholesale
  documents are not BIR invoices today). Logged as a capability gap by the orchestrator, not built here.
- A group/consolidated view of Ian's own orgs (ADR-008 §5 row 3).
- An org switcher (row 175: one person per org; Ian signs in separately).
- Loyalty across owners (discovery pos-sales-usage Q-C).
- Any change to `bootstrapOrganization` or `/setup`.
- **(B7) PG's leave (T-436) and statutory payroll (T-190).** `statutory_rates` / `withholding_brackets` are seeded only
  for org code `shareat` (`0206:317,326`) and `createOrganization` does not seed them, so PG's payroll preview refuses
  for want of rates; `leave_types` is a shared platform seed (`0205:57-62`), but row 355 routes a manager's or admin's
  own leave to the super-admin, and PG has none under Q1 (a). Both follow Q1 and **Q11**; not built in T-398.
- **(B7) POS v2 for PG.** The POS v2 server serves one organisation by design (`POS_ORG_ID`,
  `apps/pos/src/server/pos2/deps.ts:8,25`). PG gets a second `shareat-pos` instance with PG's `POS_ORG_ID` at P4
  (Q3 2027, `docs/plans/pos-customer-v2-phase-plan.md:35`), not in T-398. Row 348's "11 Jan" is the POS v2 go-live,
  not the ERP one, so it does not conflict with 4 Dec / 1 Jan.
- **(B13) Writing break-glass sign-ins to PG's `audit_log` as well.** Not adopted: `franchise_access_log` stays the
  single place PG reads every use of the franchisor identity, through one capability.

## 5. Done when

- Every leg above red→green or green-as-guard as stated; every mutant reds its named leg (auditor's table).
- `OPEN_DEF_491` is empty; DEF-491 and DEF-421 → `fixed` citing commits; the full integration suite green in CI on
  the PR (row 291/296); typecheck clean; each migration applies from zero on a scratch DB (ADR-012 §5.8).
- §9.4 per slice with screenshots; S7's production run done with Ian.
- **Orchestrator / planner records:** a bible row answering ADR-008 Open 2 (same instance; buyer posts on its own
  receipt; reconciliation, not a shared transaction) and Open 3 (each org keeps its own items and stores); Ian's
  Q1-Q10 answers (§0b, given 2026-10-10); the POSTING-PATTERNS entry; the CAPABILITY-MATRIX rows; the BIR gap in
  `docs/CAPABILITY-GAPS.md`.
- **(B14, C1)** Each of Q1-Q10's answers has a bible row citing T-398 and §0b; Q11, the pay-now ruling and Q5's
  final answer get theirs when given.

## 6. Questions for Ian (Open Questions page)

**Q1-Q10 were answered by Ian on 2026-10-10** — see §0b for each answer and what it changed. The original options
are on the Open Questions page. Q5's answer was (c) "ask the accountant": its **final** answer, (a) VAT-registered
and inclusive or (b) not registered, is still due by **13 Nov** (C3). Two questions remain open:

- **Q11 (B7) — Does Padre Garcia run attendance, leave and payroll on v2 from 1 Jan?** (a) no: PG keeps doing its
  staff time and pay outside v2 for now; v2 holds PG's books, stock and sales only · (b) yes: PG's own government
  rates (SSS, PhilHealth, Pag-IBIG, tax) are set up for its company, and someone other than you approves its
  manager's own leave. **Recommended (a)** — nothing in T-398 builds (b); (b) would be its own task, and PG's owner
  can move to it later without redoing anything. **Blocks S7.**
- **Pay-now at dispatch (B5) — May the commissary mark a Padre Garcia order "paid now" when it ships?** (a) no:
  each side records its own payment — the commissary when the money arrives, PG when it pays (R5) · (b) yes: then a
  "payment not matched" warning shows in both companies until PG records the same payment. **Recommended (a)** — it
  keeps the two companies' books matching without warnings. Either way, the commissary cannot mark PG's order
  "received"; PG does that in its own books. **Blocks nothing:** S5 builds (a) and rewrites one test leg if Ian
  picks (b).

## 7. Risks to 4 Dec

| # | Risk | Mitigation |
|---|---|---|
| K1 | DEF-491 is ≈440 constraints in three migrations applied to production during the dual run, in one drizzle transaction holding `SHARE ROW EXCLUSIVE` until commit | A1: `lock_timeout`, timed on a production-size restore, `VALIDATE` split into a later deploy if over budget; deployed at any hour, short pauses accepted (Q9 b, C2) |
| K2 | S2b's test call-site moves (the tester lists the files; 44 pass `(null, ` today) collide with lanes editing the same test files before 15 Nov | S2a's ratchet lands now so the count cannot grow (B2); S2b in its own worktree; merge at a lane boundary; the full suite in CI |
| K3 | Lanes are needed for C1-C8 before 15 Nov; S1+S2 (3.5) are due 13 Nov | S3-S7 are ≈ 10 lane-days in the 13 working days 16 Nov-4 Dec: **4 Dec holds only with two lanes on C11 from 16 Nov** (S3→S4→S7 on one; S5→S6 on the other). One lane ≈ 18 Dec, i.e. the drop-alone rule fires |
| K4 | Ian's remaining answers and data: Q11, the pay-now ruling, Q5's final answer (by 13 Nov); a second sign-in email, PG's owner and staff names, POS store id, tenders, money accounts, PG's `org_code`/`store_code` in `stores.csv`, whether PG trades in v1 today (Q3), PG's credit limit and terms (Q7) | Q1-Q10 answered 2026-10-10 (§0b); the rest on the Open Questions page; needed by 20 Nov for S7 |
| ~~K5~~ | *Deleted by B1: S7 no longer edits `scripts/import-items.ts`; PG's data loads through T-391's `master-data run`* | — |
| K6 | Reconciliation is weaker than a shared transaction (by design) | Daily job + findings in both orgs; E7/E12 pin exactness |

## 8. Amendments (fresh Opus review, 2026-10-10 — these bind)

- **A1 — Migration locks (R2, K1).** drizzle runs every pending migration in one transaction
  (`drizzle-orm` pg-core `dialect.js:60`). Each DEF-491 migration (S1, S3, S4) therefore:
  - starts with `SET LOCAL lock_timeout = '5s'` (fail fast rather than queue behind live traffic);
  - is **timed on a production-size restore** by the builder; the measured time and the locks taken go in the
    migration header as its budget;
  - ~~is applied in a night window (Q9)~~ — **withdrawn by C2** (Q9 b): applied with any deploy, at any hour;
  - if the timed run exceeds 60 s, `VALIDATE CONSTRAINT` moves to a **separate later migration and deploy**.
  - New leg **L1** (S1, S3, S4): the migration text contains `lock_timeout` and its header states the budget (a
    source assertion in the census test file).
- **A2 — Triggers fail closed (R3, S4).** The function selects the header's and the target's `org_id` into
  variables; if either is NOT FOUND it RAISEs `foreign_key_violation` naming DEF-491 (precedent `0185:126`), because
  under `shareat_app` + FORCE RLS an invisible cross-org row reads as absent. The trigger is `UPDATE OF <fk col>,
  <header fk col>`. New legs: **D6** as app role, a target in org B (invisible) → rejected, not passed; **D7** UPDATE of
  the child's header FK to a header in org B → rejected; **D8** D6 as owner (visible, different org) → rejected.
  Mutant: replace the NOT FOUND RAISE with `RETURN NEW` → D6 red.
- **A3 — Reconciliation mechanism (R5).** The per-org scheduler loop runs under one org and cannot read the other.
  Ruling: a `SECURITY DEFINER` function `inter_entity_buyer_posted(shipment_ids uuid[])`, `search_path` pinned,
  `EXECUTE` to `shareat_app` only, returning **per shipment only** the buyer's received date and posted total, and
  only for shipments whose `org_id = app_current_org()` (the seller). The seller's job runs under the seller's
  principal and calls it; the buyer's job reads the seller's billed total through the shipment rows it can already
  see. No `systemTransaction` caller is added. The AR = AP balance check **excludes shipments in transit**
  (dispatched, not received, not void). New legs: **E14** a third org calling it gets 0 rows; **E15** it returns no
  column beyond those two (catalog check); **E16** an in-transit shipment raises no finding. Mutant: drop the
  `org_id = app_current_org()` filter → E14.
- **A4 — Void vs receive (R5).** Receipt is `SECURITY DEFINER receive_inter_entity_shipment(shipment_id)`: it locks the
  shipment row `FOR UPDATE`, refuses if voided or already received, and sets `received_at` / `received_by` (the buyer
  still cannot UPDATE the table directly — E4 stands). The seller's void takes the same row lock and refuses once
  `received_at` is set (E10). `UNIQUE (inter_entity_shipments.trade_order_id)` makes dispatch idempotent. New legs:
  **E17** concurrent void and receive (two connections, a barrier) → exactly one wins, the other refuses in words;
  **E18** a retried dispatch writes no second shipment. Mutant: drop `FOR UPDATE` → E17 red (run 20 times).
- **A5 — The "who" cannot be forged (R6, S6).** `openAs` (`packages/db/src/rls/principal.ts:161`) does not set
  `app.person_id` today; it gains the person id, and the S6 path sets it from the session's actor.
  `franchise_sales_daily` refuses a NULL `app.person_id` and checks that the person holds an active `super_admin`
  role in the franchisor org. `REVOKE EXECUTE … FROM PUBLIC` on every T-398 function; no INSERT, UPDATE or DELETE
  grant on `franchise_access_log` to `shareat_app` (break-glass sign-in writes through a definer function
  `log_break_glass_sign_in()`); a statement-level trigger refuses TRUNCATE. The log's "who" column names a person of
  the **reader's** org while the row's `org_id` is the franchisee: it is listed in `CROSS_ORG_BY_DESIGN` with this
  amendment as its reason. New legs: **V10** NULL person id → refused, no log row; **V11** a non-super-admin person
  → refused; **V12** `shareat_app` INSERT into the log → permission denied; **V13** TRUNCATE as owner → refused;
  **V14** `PUBLIC` holds no EXECUTE (catalog). Mutants: grant INSERT to `shareat_app` → V12; drop the super-admin
  check → V11.
- **A6 — The buyer's link is a composite too (R5).** `UNIQUE (buyer_org_id, id)` on `inter_entity_shipments`;
  `deliveries` gets `FOREIGN KEY (org_id, inter_entity_shipment_id) REFERENCES inter_entity_shipments (buyer_org_id,
  id)`, so a PG delivery can point only at a shipment addressed to PG. The census learns this shape ("composite to a
  declared counterparty column") instead of an exemption: `CROSS_ORG_BY_DESIGN` does **not** gain
  `deliveries.inter_entity_shipment_id` (R5's sentence is superseded). New leg **E19**: a delivery in org C pointing
  at a PG shipment → `23503`.
- **A7 — Corrections after dispatch (R5, E7).** The planner adds to `docs/POSTING-PATTERNS.md` before S5's tester
  starts: **`trade_dispatch.franchise`** (seller: the external-sale legs) and
  **`trade_dispatch.franchise_transit_shortage`** (seller: `DR` sales returns and allowances (contra-revenue) /
  `CR 1210` at the sale value of the short quantity; and that quantity's cost `DR` the commissary discrepancy-loss
  account / `CR` the COGS it was relieved to, modelled on the existing commissary discrepancy-loss entry; buyer:
  nothing — its AP is already for what it received). Rules: **over-receipt is refused** at PG's receipt (received
  ≤ shipped per line); a **physical return** after receipt is a PG supplier-return paired with a commissary
  customer-return, each in its own org, matched by the reconciliation; **after receipt the only correction is a
  return or a credit**, never an edit. E7 is restated against the credit note, not `recordCustomerReturn`. New legs:
  **E20** over-receipt refused; **E21** a paired return clears the reconciliation.
- **A8 — Census scope (R1, S1).** The census also covers: `journal_lines.party_id` (text, no FK — asserted against
  the party tables of the line's own org); `jsonb` reference fields (the tester lists them from the schema, each
  asserted or declared); org→derived and derived→derived FKs; and a **declared no-FK reference list** (`*_id`
  columns with no FK) in the exemptions file, each with a reason. `CROSS_ORG_BY_DESIGN` and the `OPEN_DEF_491`
  baseline are **pinned by value** in the test, so changing either file without the test is red. Every child of a
  composite asserts `org_id NOT NULL` (catalog). New legs: **C5** a seeded cross-org `party_id` → red; **C6** a new
  `*_id` column with no FK and no declaration → red; **C7** a nullable `org_id` on a composite child → red.
- **A9 — DEF-421 scope (R4, S2).** The domain allow-list is `runDepreciation` only; `packages/auth/src/sessions.ts`
  holds the auth door and is outside the scan. Every bare `transaction((trx) => …)` in `packages/domain/src` (the
  tester lists each `file:line`, e.g. `files/index.ts:112,282`, `ledger/post-entry.ts:148`) becomes either (a)
  removed with its `| null`, the caller passing a principal-bearing `tx` — the default — or (b) for a function with a
  real non-request caller (scheduler, `scripts/`), `withSystemOrgPrincipal(orgId, …)`. The builder states (a) or (b)
  per site in its report; a (b) not reached from the scheduler or `scripts/` is a defect. T1/T2 scan both forms.
- **A10 — Merge order and the RLS-registry exception (S5, S6).** `inter_entity_shipments(_lines)` carry a **dual-org
  SELECT policy** (`org_id = app_current_org() OR buyer_org_id = app_current_org()`), and the franchise tables one
  keyed on `franchisor_org_id`. `rls-registry.test.ts` expects the single `org_id` shape, so `rls/registry.ts` gains a
  named policy kind **`dual_org_counterparty`** (counterparty column named per table) that the registry test learns,
  rather than a per-table skip. S5 introduces it; S6 reuses it. Sizes now S1 2, S5 3.5, S6 2; total ≈ 13.5
  lane-days (K3).
- **A11 — The S1 tester's measured catalog (2026-10-11) replaces T-357's estimates.** Every count above that
  disagrees is superseded by these:
  - **S1:** persons 153 + stores 76 = **229** FKs (not 143 + 71). Org→org total is **370** (not ≈360), so S3's
    remainder is **141**.
  - **`ORG_LESS_TABLES`:** the 4 `etl_*` FKs have no org on either side; they are listed in the exemptions file as
    org-less, never as cross-org, and the census skips them by that list.
  - **S4 = 82:** the 77 derived→org triggers plus the 3 org→derived and 2 derived→derived FKs —
    `sessions.credential_id`, `supplier_return_lines.delivery_line_id`, `stock_layers.invoice_line_id`,
    `attendance_punches.captured_by_session_id`, `attendance_adjustments.decided_by_session_id` — each by R3's
    fail-closed trigger (A2).
  - **S3 gains 5 FK-less references** as new same-org composite FKs: `payslips.journal_entry_id`,
    `separations.journal_entry_id`, `thirteenth_month_payouts.journal_entry_id`,
    `owner_drawing_closes.adjustment_entry_id`, `pos_v1_day_feeds.batch_id`. Until S3 merges they are declared
    `ref-gap` in `NO_FK_REFERENCES` (A8's no-FK list); S3 deletes the declarations. Each gets S3's pre-flight.
  - **Post-S1 `OPEN_DEF_491` pin = 223** (by value, A8).

### Amendments B1-B14 (2026-10-17 — Opus re-audit against main `d335959`/`c6b16cf`; these bind, keep A1-A11, and win over any earlier sentence)

Source: `docs/tasks/398-audit-2026-10-17.md`. Each one is also written into the slice it changes, so a builder
reading only that slice sees the current rule. Confirmed still true by the audit: `OPEN_DEF_491` = 223, every table
added since 0194 was guarded at creation, `CROSS_ORG_BY_DESIGN` is `[]`, and A11's S3 (141) / S4 (82) counts hold.

- **B1 — S7's data load is T-391's (supersedes the `scripts/import-items.ts --v1-store` filter and deletes K5).**
  T-391 R6/R7 already load PG with `npm run master-data -- run … --org <PG uuid> --org-code <PG code> --stores <PG
  store code> --actor <Ian's PG person>`; `assertRunTarget` (`packages/etl/src/master-data/store-map.ts:87-94`)
  refuses unless `organizations.code` equals `--org-code`. Rules: (1) `onboard-franchise --code` MUST equal PG's
  `org_code` in Ian's `stores.csv` (today the placeholder `PADRE_GARCIA`) and the store code its `store_code`;
  (2) onboarding runs first, then the master-data dry run and apply; (3) the CLI's PG-side supplier and Ian-side
  customer take the v1 names of the commissary-mirror supplier and the PG AR customer, so the planner links rather
  than duplicates them (in a PG run that supplier's linked store is in another org, so `own` is null —
  `parties-plan.ts:239` — and it would otherwise be created twice). New leg **O8**.
- **B2 — S2 is split; T1 matches A9.** Measured on main at `c6b16cf`: **206** `Tx | null` in **55** files and
  **188** `\btransaction\(` in **60** files of `packages/domain/src` (38 lines import `transaction`); 44 test files
  pass `(null, `. **S2a** (≈ 0.2 day, now) lands `tests/unit/t398-s2-domain-tx-non-nullable.test.ts` with T1/T2 as
  ceilings pinned at those counts — may fall (the pin lowered in the same commit), never rise; the tester re-measures
  on its base and records the commit. **S2b** does the conversion and sets the final form: T1 "`Tx | null` appears
  only on `runDepreciation`"; the mutant is "add a **second** name". S2 re-sized to ≈ 2.0; K2's file count is "the
  tester lists them".
- **B3 — Break-glass logging covers PIN sign-in and both PIN approvals (R4, R6, A5, V8).** PINs are per org
  (`signInWithPin`, `packages/auth/src/sessions.ts:94`), so Ian's PG person can sign in at a PG terminal by PIN; and
  `verifyAdminApproval` (`admin-approval.ts:40`) and `verifyPosManagerApproval` (`pos-approval.ts:47`) let a person
  act by PIN without a session. R4's auth door is now `sessions.ts:94,379,495,557,597` **plus** those two. Each path
  writes through the definer function A5 names (it now takes the kind): `break_glass_sign_in` for sign-in by email
  (**V8a**) and by PIN (**V8b**), `break_glass_approval` for an approval by Ian's PG person through either verifier
  (**V8c**) — exactly one row each. Mutants: drop the PIN-path log → V8b; drop either verifier's log → V8c.
- **B4 — The 1 Jan purge is per org (S7, §9.4, §5).** `applyPurge` loops every org and refuses an apply when any org
  lacks a performer (`packages/db/src/cutover/purge.ts:513-528`); classification is global, so PG's December
  operational rows (shipments, receipts, AR, AP) are purged on both sides; configuration survives. The T-394 runbook:
  `cutover:purge --apply` takes one `--by <personId>` **per organization**, including Ian's PG person
  (`scripts/cutover-purge.ts:198-222`; the audit's `--performed-by <org>=<person>` form does not exist); PG's opening
  entry (Q3 (a)) is entered per org after the purge; 3900 = 0 is checked per org; no real inter-entity trade is posted
  on production before 1 Jan except in a rehearsal. New leg **O9** (two-org purge + openings; 3900 = 0 in each), run
  again in the 18 Dec rehearsal.
- **B5 — S5 vs T-433 (R5, A4).** `receiveTradeOrder` (`trade/index.ts:887`) lets the SELLER mark a dispatched order
  received (`approve_buyer`, `:906`); `dispatchTradeOrder` (`:426-429`) now takes `payNow` and
  `creditOverrideReason`, posts through `recordChargeWithCollection` (`:601`) and stamps an optional `bir_invoice_no`
  (0203). Rulings: **E22** `receiveTradeOrder` on an `inter_entity` order is refused ("Padre Garcia confirms receipt
  in its own books"). **E23** `payNow` on an inter-entity dispatch is **refused** — *orchestrator recommendation,
  pending Ian* (on the decisions page beside Q11); if Ian allows it, E23 is rewritten so the dispatch posts and E12's
  one-sided-payment finding fires until PG records its AP payment. E1's control order uses no `payNow` and no
  override. The shipment snapshot carries `bir_invoice_no` when set, for PG's input VAT under Q5 (**E25**).
- **B6 — S3 skips parents that already have the key (R2).** At least `items`, `production_recipes`,
  `stock_locations` (0196), `employments`, `positions`, `pay_runs`, `separations` (0205), `stored_files` (0204),
  `pos_v1_store_links` (0202) and `money_accounts` already carry `<parent>_org_id_id_unique`. Add `UNIQUE (org_id, id)`
  only where it is missing, from a `pg_constraint` query (pasted in the header), never a hand list. New leg **K2**:
  every composite's parent has exactly one `(org_id, id)` unique. A1's timed run uses a restore taken **after** T-391's
  production load.
- **B7 — Out of scope, named (§4).** PG's leave (T-436) and statutory payroll (T-190) are not seeded for PG (rates
  only for org `shareat`, `0206:317,326`; row 355's super-admin leave approver does not exist in PG under Q1 (a)):
  they follow Q1 and new **Q11**. POS v2 for PG is a second `shareat-pos` instance with PG's `POS_ORG_ID` at P4,
  not T-398.
- **B8 — Paths corrected in place.** Delivery screens are `apps/erp/src/app/inventory/deliveries/` (`actions.ts`,
  `lib.ts`); the T-133 refusal test is `packages/domain/tests/integration/trade.test.ts:873` (asserts
  `/no second org exists/`); `dispatchTradeOrder` is `:426`; the next free migration is **0209**.
- **B9 — New pages pass T-435's read-gate guards (S5, S6).** BUILDER paths add `apps/erp/src/lib/route-capability.ts`:
  `/franchise/sales` → `view_franchise_sales`, `/franchise/access-log` → `view_franchise_access_log`, the inbound
  list → `receive_delivery`; each page calls `requirePageAccess`; `tests/unit/{route-capability-coverage,
  no-ungated-read-surface,nav-route-reachability}.test.ts` stay green. New leg **E24**: the shipment snapshot carries
  no person name and no cost (row 353, ADR-008 §5).
- **B10 — Name parts and positions (R7, O1; rows 360, 362).** The CLI takes `--last/--first/--middle` and writes
  them through the name-parts path; O1 asserts the six canonical positions by their row-362 names ("Kitchen Staff",
  0208).
- **B11 — O7 scans `docs/ops/*.service` (there is no job registry).** Every `ExecStart` script must reach
  `listOrgsToRun` (`scheduler/index.ts:220`) or sit on a pinned allow-list with its reason — `dual-run` (single-org
  by design, `packages/etl/src/dual-run/snapshot.ts:60`), `db-backup`, `restore-drill`. S5's 06:30 reconciliation
  job joins the scanned set.
- **B12 — Clock terminal and owner sign-in (S7; rows 361, 340).** The runbook adds `scripts/provision-terminal.ts
  --org <PG uuid>`; O5 asserts an owner with an org-wide role and no employment row signs in. *Planner addition while
  folding:* `--org` does not exist yet (`provision-terminal.ts:101-110` looks a store up by code alone), so S7 adds
  it, with leg **O10**.
- **B13 — A5 restated.** `applyPrincipal` already sets `app.person_id` when given a `personId`
  (`principal.ts:51-52`); only `openAs` lacks it. So: `withOrgPrincipal` gains an optional `personId`, passed into
  `openAs`, modelled on `applyPrincipal`'s branch. The optional second copy of break-glass rows in PG's `audit_log` is
  **not adopted** (§4).
- **B14 — Process.** Q1-Q11 (and B5's ruling) go on the decisions page now; Q5 is needed by **13 Nov** for the S5
  posting pattern and K4's set by 20 Nov. Planner prerequisites still open: the POSTING-PATTERNS franchise entry
  (`POSTING-PATTERNS.md:743` still says "do not use for a franchise") and the CAPABILITY-MATRIX row for
  `view_franchise_access_log`. Bible rows 347-362 contradict nothing here.

### Amendments C1-C6 (2026-10-17 — Ian's Q1-Q10 answers of 2026-10-10 folded; these bind and win over any earlier sentence)

- **C1 — The answers exist.** §0b records Ian's 10 Oct answers. The 10 Oct spec's "pending Q1-Q10" and the 17 Oct
  audit's B14 "Q1-Q11 go on the decisions page" are superseded for Q1-Q10; only Q11, the pay-now ruling and Q5's
  final answer remain (§6).
- **C2 — Q9 (b): integrity migrations deploy at any time.** A1's night-window clause and R2's "a night window" are
  withdrawn; no Ian-attended precheck is required by this rule. Kept: `SET LOCAL lock_timeout = '5s'`, the timed
  budget in the header (L1), the fail-closed pre-flight, and the split `VALIDATE` deploy over 60 s. A deploy that
  hits `lock_timeout` is re-run, never edited. S3 and S4 state this in their slice text.
- **C3 — Q5 (c): S5 builds without VAT.** v2 computes no VAT (bible #75), so S5's legs carry none and S5 is not
  blocked; a VAT leg, if Q5's final answer is (a), is a follow-on amendment after 13 Nov. No S5 leg may assert the
  absence of a VAT line. The planner writes the POSTING-PATTERNS franchise entries now with a "VAT: pending Q5" note.
  The pay-now ruling likewise fences one leg (E23) and blocks nothing.
- **C4 — Q2 (b): sales plus stock levels.** R6 gains `franchise_stock_levels`: read-only, "as of now", per PG store
  and item — item name, base unit, on-hand (summed across the store's locations, `lowStock`'s definition), threshold,
  below-threshold, `as_of`; no cost, value, rate, layer, supplier or history. Same guards and same self-written log
  (`what` = `stock_levels`) as the sales function, one capability (`view_franchise_sales`) for both. New legs
  V15-V18; S6 re-sized to ≈ 2.3.
- **C5 — Q4 (a) and Q7 (a).** Onboarding fills PG's franchise price list from today's branch prices (leg O11). S5 adds
  `customers.credit_terms_days` (display and ageing only) beside the existing enforced `credit_limit` (legs E26, E27).
  The figures are Ian's data, entered from the franchise agreement, and block no build.
- **C6 — Q10 (a).** Ian gives PG written notice (franchise agreement or privacy notice) that the operator can reach
  all data and every use is logged — before 4 Dec production. No build; the S6 access-log screen is what the notice
  points PG's owner to.

### Amendments D1-D8 (2026-10-22 - Opus re-audit against main `4a82378`; these bind and win over any earlier sentence)

Counts re-measured and unchanged: DEF-421 ratchet 206 / 188; `OPEN_DEF_491` 223 (141 org->org, 77 derived->org, 3
org->derived, 2 derived->derived); `NO_FK_PIN` 28; `JSONB_PIN` 9. Line numbers in A9 / trade have moved (re-grep, never
trust a line number here). Migrations: **0213 = S3, 0214 = S4 (0212 taken by T-464, PR #49)**. S3 merges before S4; S2b (no migration) runs after
the T-441 merge (it shares `leave/` and `files/`).
- **D1 (S3, blocker):** composite FKs carry `org_id`, which the purge never clears, so `purge.ts`'s "every FK child
  column is in clearColumns" check refuses (`fixed_assets.source_expense_id`, `recurring_expenses.last_drafted_expense_id`).
  S3 makes that check ignore `org_id` (MATCH SIMPLE accepts NULL in the other column) and adds test leg **P1**:
  `applyPurge` succeeds with the composites present. `packages/db/src/cutover/purge.ts` and
  `t347-cutover-purge-shells.test.ts` join S3's paths.
- **D2 (S3):** `pos_v1_day_feeds.batch_id` has no parent (a minted grouping id): reclassify as `idempotency-key`.
  S3 adds 4 ref-gap FKs, so **145 composites** and **38 new `UNIQUE (org_id, id)`** (7 parents already have one).
  The parent list comes only from the `pg_constraint` query pasted in 0213's header (B6's hand list is wrong).
- **D3 (S4):** 27 of the 82 derived FKs are the table's own RLS `via` header; the census treats those as guarded by
  construction (pinned list), and S4 builds **55** triggers. `packages/db/src/triggers/registry.ts` (55 entries,
  `validator`, `origin`) joins S4's paths.
- **D4 (S4):** delete A2's citation of `0185:126` - it returns true on NOT FOUND (fail-open). The function raises.
- **D5 (S2b):** `scripts/dual-run.ts:100` calls `runDualRun(null, ...)`: it joins S2b's paths and wraps the call in
  `withOrgPrincipal`; the T1 allow-list does NOT grow beyond `runDepreciation`. `runDepreciationCore`,
  `depreciateAsset`, `depreciationDrift` lose `| null` like the rest. T4 is a regression guard (already green).
- **D6 (S2b):** T2 counts non-member `transaction(` calls and imports only; `tx.transaction(` savepoints are allowed.
- **D7:** S3 and S4 each carry their own L1 leg (lock_timeout + budget header); the existing L1 is pinned to 0194.
- **D8 (Ian):** before the merge that deploys 0213 / 0214, Ian runs the read-only prechecks P0212a/b, P0214 as doadmin
  (scripts written by the builder lane under `C:\Users\ianla\shareat-master-data\`). Avoid deploying 05:30-07:00
  Manila (the T-396 POS import locks sales_days / pos_v1_day_feeds). Time 0213 on a restore or synthetic volume; over
  60 s -> split VALIDATE into a later deploy.

### Production prechecks run by Ian (2026-10-23, read-only)
- S3 / migration 0213 (script `p0212-check.sh`, same predicate as P0212a/b): organisations visible 1; foreign keys checked 145 (expected 145); ALL ZERO: yes.
- S4 / migration 0214 (`p0214-check.sh`, same SQL as `docs/ops/P0214-precheck.sql`): organisations visible 1; 55 keys (expected 55); ALL ZERO: yes.
Logs: `C:\Users\ianla\shareat-master-data\2026-10-22\prod-p0212.log`, `prod-p0214.log`. Both migrations may deploy; avoid 05:30-07:00 Manila (D8).
