# T-398 S6 refresh — the franchisor's sales-and-stock view, the access log and break-glass logging, against main `fd3ae7b` (2026-10-28)

Binding sources: spec §0b (Q1 a, Q2 **b**, Q10 a), R6, A5, A10, B3, B9, B13, C4, C6; S5 refresh + rulings (definer shape,
census "composite to a declared counterparty column", DEF-747); bible rows 388, 389, 399, 400. Where this file and the
spec disagree, §2 says why. No posting (POSTING-PATTERNS untouched). Migration **0220**.

## 1. What S6 is, in plain terms

- **Ian looks at Padre Garcia (PG) from his own company.** Two screens: PG's **sales per day** (gross, discounts, net,
  how it was paid, per channel) and PG's **stock on hand today** per item (with PG's own low-stock line). Read-only.
  Nothing about PG's costs, prices paid, suppliers, wages, expenses or bank accounts.
- **Every look is written down by the database itself**, in a log PG's owner (manager) can read. No screen and no
  code path can read PG's figures without leaving that row.
- **Ian's "full access" to PG is a separate person** inside PG's company, with its own email or PIN (Q1 a). Every time
  that person signs in (email, PIN at a PG terminal, Employee-ID tablet) or approves something with their PIN, the
  same log gets a row. PG's owner sees all of it on one screen.
- Nobody else can do any of this: not Ian's managers or staff, not PG reading Ian's company, not a third company.

## 2. Corrections to the spec, measured on main today

| # | Spec says | Main says | Effect |
|---|---|---|---|
| K1 | A5: the definer checks "an active `super_admin` **role** in the franchisor org" | Ian holds role **`admin` + the super-admin-only capabilities as `person_grants` rows** (`createFirstAdmin`, `organizations/index.ts:395-405`; production P0187b `Ian Lalusin | admin | 4`, P0187c `super_admin` holders **0**, docs/ops/README.md) | As written, **Ian would be refused in production.** The DB check is: active `super_admin` role in the caller's org **OR** an active person-level grant (`revoked_at IS NULL AND store_id IS NULL`) of `view_franchise_sales`. Leg V21 seeds the production shape |
| K2 | R6 return "store, date, channel, tender, gross, discounts, net, status" as one row | Channels (`sales_day_channels`) and tenders (`sales_day_tenders`) are two child tables, **orthogonal** (`sales-days.ts:415-460`); one flat row is a cross product. "Tender" in v2 = a **money account** (e.g. "GCash-cashier", "BDO-office") | One function, rows tagged `row_kind` `day` / `channel` (§3.4). Payment split returned as **cash / online / credit** from the day row, **never money-account names** (PG's banking; QO-2) |
| K3 | "gross" = the day's figure | `sales_days.total_sales` is gross **except on a POS-feed day**, where platform (non-remitted) channel sales are added **at routing time** (`sales-days/compose.ts:28-36`) | The definer composes gross exactly as `routeInputForDay`; V1 compares against `routeInputForDay(...).totalSales`; V23 seeds a feed day with a platform channel |
| K4 | Break-glass sign-in logged in `signInWithFirebase` **and** `signInWithPin` (B3) | A **third** session path exists: `signInWithStaffCodeAndPin` / `signInOnPairedTablet` (T-464, `sessions.ts:568-641`). All three call the one private `issue()` → `sessionsRepo.insertSession` (`:643-660`, the only caller) | Logged by an **AFTER INSERT trigger on `sessions`** (the database writes it; no code path can skip it), not by a callable `log_break_glass_sign_in()`. Covers all three paths; new leg V8d |
| K5 | `openAs` gains `personId` via `withOrgPrincipal` (A5/B13) | Still absent (`principal.ts:122,160-171`). S5 worked round it with a local `withActorPrincipal` in `apps/erp/src/app/inventory/deliveries/inbound/lib.ts:31` | S6 adds `withActorPrincipal(orgId, personId, fn)` to `packages/db/src/rls/principal.ts` (one round trip, `app.person_id` set in the same `set_config` select); exported through the `expenses/lib` chokepoint. S5's local helper may delegate to it (no behaviour change) |
| K6 | Log "who" column is cross-org and goes in `CROSS_ORG_BY_DESIGN` (A5) | S5 set the precedent: composite FK to a **declared counterparty column**; the census (`t398-s1-same-org-fk-census.test.ts:104-121`) reads single-column FKs only; `CROSS_ORG_BY_DESIGN` is `[]` and pinned | Two person columns, each composite to its own org (§3.2). `CROSS_ORG_BY_DESIGN` stays `[]` |
| K7 | Matrix row and `view_franchise_sales` note "added by the planner before the tester starts" | `CAPABILITY-MATRIX.md:187` still says "**sales only**"; no `view_franchise_access_log` row; the matrix parser test compares doc to code | The doc rows ride in **S6a** with the code (text in §4), so the parser test stays green in one commit |
| K8 | `dual_org_counterparty` reused (A10) | `registry.ts:27-31` says "only the two inter-entity shipment tables use it"; S5's `t398-s5-migration.test.ts` **G1c** pins that list; S5's X1 sweep (`t398-s5-shipment-rls.test.ts:725`) excepts only the shipment tables | S6 widens the registry comment, G1c and X1 (tester edits, named in TESTS) |
| K9 | V15 "below-threshold" | `lowStock` flags **at or below** (`<=`, `low-stock.ts:59`) and only `status = 'active'` items | `below_threshold` = `threshold IS NOT NULL AND on_hand <= threshold`, wording "at or below"; active items only |
| K10 | R6 agreement has a `scope` column; "written only by S7"; log has `reason` | Q2 (b) fixed one scope for all; nothing yet writes agreements | `scope` dropped (the two functions ARE the scope). `shareat_app` gets **SELECT only** on agreements; S7 writes as owner (its system transaction). `reason` kept, optional text typed on the screen |
| K11 | Franchisor "picks a PG store"; owner screen shows "who" | Ian's org cannot read PG's `stores`, `persons` or `organizations` rows (RLS; same cause as **DEF-747**) | Stock function takes `p_store` NULL = all stores and returns store name; a tiny unlogged definer lists franchisees (id, name, `sales_visible_from`); the log snapshots the person's name at write time |
| K12 | Sessions FK from the log | `sessions` is `derived` (no `org_id`) and classified `purge`; a kept log row pointing at it would block the purge | `session_id` carries **no FK**: one `NO_FK_REFERENCES` entry (kind `snapshot`), `NO_FK_PIN` 30 → 31 re-pinned |
| K13 | Sizes 2.3 | + K4 trigger, K5 helper, K8 test widening, smoketest | ≈ **2.7** lane-days (§8) |

## 3. Migration 0220 — `0220_t398_s6_franchise_view.sql` (hand-authored, ADR-012 §5)

Journal: `idx 220`, `when` = **1805081507084** (0219's 1804995107084 + 86 400 000), `tag 0220_t398_s6_franchise_view`.
Header names T-398 S6, R6/A5/B3/C4 and K1-K12. `SET LOCAL lock_timeout = '5s'` first, `RESET` last. Only live table
touched: `sessions` (CREATE TRIGGER takes SHARE ROW EXCLUSIVE briefly; every sign-in waits for it). New tables empty.
Do not deploy 05:30-07:00 Manila (D8). Add a 0220 row to `docs/ops/README.md` ("no precheck: new tables + one trigger").

1. **`franchise_agreements`** — `id uuid pk uuidv7()`, `org_id` (franchisee) → organizations, `franchisor_org_id` →
   organizations, CHECK `franchisor_org_id <> org_id`, `franchisor_person_id uuid NOT NULL` (Ian's person **in PG's
   org**) composite `(org_id, franchisor_person_id) → persons(org_id, id)`, `sales_visible_from date NOT NULL`,
   `created_at`. UNIQUE `(org_id)` (one franchisor per franchisee), UNIQUE `(org_id, id)`, UNIQUE `(franchisor_person_id)`.
2. **`franchise_access_log`** — `id`, `org_id` (franchisee) , `franchisor_org_id`, `agreement_id` composite
   `(org_id, agreement_id) → franchise_agreements(org_id, id)`; `what text` CHECK in (`sales_daily`, `stock_levels`,
   `break_glass_sign_in`, `break_glass_approval`); `reader_person_id` composite `(franchisor_org_id, reader_person_id) →
   persons(org_id, id)` — set **iff** what in (sales_daily, stock_levels); `franchisee_person_id` composite
   `(org_id, franchisee_person_id) → persons(org_id, id)` — set **iff** what is break-glass; `person_name text NOT NULL`
   (snapshot of `persons.display_name`); `range_from`, `range_to date` (set iff sales_daily, `from <= to`); `store_id`
   composite `(org_id, store_id) → stores` (stock: NULL = all stores; sign-in/approval: the terminal or record store);
   `session_id uuid` (sign-in only; partial UNIQUE where not null; **no FK**, K12); `credential_kind text` (sign-in
   only: `pin`/`firebase`/`biometric`); `capability text` (approval only); `rows_returned int` (reads only, `>= 0`);
   `reason text` (≤ 500, reads only, optional); `occurred_at timestamptz NOT NULL default now()`. One CHECK per `what`
   stating exactly which columns are set. Index `(org_id, occurred_at desc)`.
3. **Append-only:** BEFORE UPDATE OR DELETE row trigger and BEFORE TRUNCATE statement trigger raise for **every role**
   (A5, V7, V13). Same for `franchise_agreements` UPDATE/DELETE/TRUNCATE by `shareat_app` (owner may correct by
   migration only).
4. **Definers** — each `SECURITY DEFINER`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC`,
   `GRANT EXECUTE … TO shareat_app`. ⚠️ The owner bypasses RLS (production `doadmin` is `rolbypassrls`), so **every read
   inside names `org_id = p_franchisee_org` explicitly**; V19 seeds a third org in the same tables to prove it. Shared
   guard (a private `franchise_reader_check(p_franchisee_org) RETURNS franchise_agreements`, not granted to anyone):
   `app_current_org()` NOT NULL; `app.person_id` NOT NULL and a person **of `app_current_org()`**; that person has an
   active `super_admin` role there **or** an active person-level `view_franchise_sales` grant (K1); an agreement with
   `org_id = p_franchisee_org AND franchisor_org_id = app_current_org()`. Any failure → `42501` in words, **no rows, no
   log row**.
   - `franchise_sales_daily(p_franchisee_org uuid, p_from date, p_to date, p_reason text DEFAULT NULL)` — refuses
     `p_from < sales_visible_from`, `p_to < p_from`, or a span over 366 days (V6: **refused**, not clipped, in words).
     RETURNS TABLE exactly: `row_kind text` ('day'|'channel'), `store_id uuid`, `store_name text`, `business_date date`,
     `day_status text`, `gross_sales`, `discounts`, `comps`, `refunds`, `net_sales`, `cash_collected`,
     `online_collected`, `credit_sales`, `channel_name text`, `channel_amount` (all money `numeric(14,2)`). Day rows:
     every **non-voided** day of PG in range (status shown; QI-1); gross composed per K3; discounts = senior + pwd +
     other; net = gross − discounts − comps − refunds; channel columns NULL. Channel rows: one per
     `sales_day_channels` row (`no_sales` rows included as 0), day money columns NULL. Never: service charge, other
     charges, money-account names, `journal_entry_id`, any person, any cost/expense/payroll/AP figure. Inserts **one**
     log row (`rows_returned` = day rows) **before** returning.
   - `franchise_stock_levels(p_franchisee_org uuid, p_store uuid DEFAULT NULL, p_reason text DEFAULT NULL)` — p_store,
     when given, must be a PG store (else 42501, no log). RETURNS TABLE exactly: `store_id`, `store_name`, `item_name`,
     `base_unit`, `on_hand numeric(14,3)` (Σ `stock_movements.quantity` for the store, all locations), `threshold
     numeric(14,3)` (NULL when none), `below_threshold boolean` (K9), `as_of timestamptz` (= `now()`). Rows: active PG
     items with on-hand ≠ 0 or a threshold row. Never: item id/code, cost, value, rate, layer, supplier, movement,
     location, count variance, wastage. One log row (`store_id` = p_store).
   - `franchise_franchisees()` — RETURNS TABLE `(franchisee_org_id, franchisee_name, sales_visible_from)` for agreements
     where `franchisor_org_id = app_current_org()`; same person check; **not logged** (no business figures).
   - `log_break_glass_approval(p_person uuid, p_capability text, p_store uuid)` — inserts one `break_glass_approval` row
     **iff** `p_person` is some agreement's `franchisor_person_id`; else a no-op returning false. Forging it can only
     ADD a row naming Ian's PG person (over-reporting, never hiding); stated in the header.
5. **Session trigger** `sessions_break_glass_log_trg` AFTER INSERT ON `sessions` FOR EACH ROW → definer trigger function:
   when `NEW.person_id` is an agreement's `franchisor_person_id`, insert one `break_glass_sign_in` row (session id,
   credential kind, store id). Otherwise nothing. Rolls back with the session.
6. **RLS:** both tables ENABLE + FORCE; one SELECT policy each: `org_id = app_current_org() OR franchisor_org_id =
   app_current_org()`; **no INSERT/UPDATE/DELETE policy and no such grant** to `shareat_app` (A5, V12, V24). GRANT
   SELECT only.
7. **Registry / classification / census:** `rls/registry.ts` both tables `dual_org_counterparty`,
   `counterpartyColumn: 'franchisor_org_id'`, reason names "SELECT only; written by definers/trigger"; the kind's comment
   widened (K8). `cutover/classification.ts`: agreements **keep** (configuration); access log **keep** (append-only
   history PG is owed; its trigger would refuse a purge anyway). `same-org-fk-exemptions.ts`: one `NO_FK_REFERENCES`
   entry `franchise_access_log.session_id` kind `snapshot` (K12). Drizzle: new `packages/db/schema/franchise.ts` +
   index export, NOTE comments for triggers/definers.

## 4. Read gates and capability (exact names)

- **`packages/auth/src/capabilities.ts`:** new `view_franchise_access_log` — scope `org`, area `franchise`, matrix
  super ✅ admin ✅ manager ✅ staff ✗, label `'view who looked at your franchise data'`, added to
  **`ROLE_ONLY_CAPABILITIES`** (no grant can hand it to staff; QO-3). `view_franchise_sales` unchanged (platform,
  super-only), label → `'view franchise sales and stock levels'`. Pinned counts 96 → 97 (`capability-matrix.test.ts`,
  `t337-capability-areas.test.ts`, label census).
- **`CAPABILITY-MATRIX.md`** (S6a, same commit): line 187 note → "The franchisor view — **sales and stock levels**, per
  Q2 (b), never costs, prices paid or profit (ADR-008 §5). Read only through the two `franchise_*` definers, which log
  every call. Denial: `t398-s6-franchise-capabilities.test.ts`". New row after it:
  `| view_franchise_access_log | org | ✅ | ✅ | ✅ | ✗ | T-398 S6. The franchisee's owner reads every look and every
  break-glass use by the franchisor (Q1 a, Q10 a). Role-only (no grant). Denial: t398-s6-franchise-capabilities.test.ts |`
- **Domain `packages/domain/src/franchise/index.ts`:** `listFranchisees(tx, actor)`, `viewFranchiseSales(tx, actor,
  {franchiseeOrgId, from, to, reason?})`, `viewFranchiseStock(tx, actor, {franchiseeOrgId, storeId?, reason?})` — each
  `authorize(tx, actor, 'view_franchise_sales')` first; `listFranchiseAccessLog(tx, actor, {from?, to?, what?})` —
  `authorize(…, 'view_franchise_access_log')`, reads only `org_id = actor.orgId` rows. Money as `Money` strings, no
  `Number(`. Repo: `packages/db/src/repo/franchise.ts` (the only SQL).
- **Routes (`apps/erp/src/lib/route-capability.ts`):** `'/franchise/sales': 'view_franchise_sales'`,
  `'/franchise/stock': 'view_franchise_sales'`, `'/franchise/access-log': 'view_franchise_access_log'`. Every page calls
  `requirePageAccess(route)`; the three T-435 guards stay green.

## 5. Break-glass logging

- **Logged:** every session created for an agreement's `franchisor_person_id` (email, PIN, Employee-ID tablet: the
  `sessions` trigger, K4); every PIN approval that person gives through `verifyAdminApproval` or
  `verifyPosManagerApproval` (`admin-approval.ts:40`, `pos-approval.ts:47`): each calls `log_break_glass_approval` on its
  success path, **in the lookup transaction**, with the capability and record store.
- **Not logged here:** failed attempts (already `sign_in_attempts` / `pin_attempt_throttle`); PG's own people. The
  existing `audit_log` sign-in rows are unchanged (B13: no second copy).
- **Who sees it:** PG's manager and admin (`view_franchise_access_log`) on `/franchise/access-log`; PG staff ✗. Ian's
  org may SELECT the rows too (dual policy) but gets no screen for them in S6.

## 6. Screens (`apps/erp/src/app/franchise/`)

| Route | Who | Shows | Reads through |
|---|---|---|---|
| `/franchise/sales` | Ian's org, `view_franchise_sales` | Franchisee picker (from `listFranchisees`; one today), date range (defaults to the last 7 days, never before `sales_visible_from`), optional "reason" box, a **"Padre Garcia will see that you looked"** line above the button; table per day: gross, discounts, comps, refunds, net, cash/online/credit, status badge; channel breakdown under each day; totals of **verified days only** with unverified days labelled | `viewFranchiseSales` (one call = one log row; no auto-refresh, no prefetch) |
| `/franchise/stock` | same | Store picker (All / each PG store), table: item, unit, on hand, low-stock line, "at or below" flag, "as of" time; no edit control anywhere | `viewFranchiseStock` |
| `/franchise/access-log` | PG's manager/admin, `view_franchise_access_log` | Newest first: when (Manila), who (name), what (Sales looked at / Stock looked at / Signed in / Approved with PIN), range or store, rows seen, reason; filter by kind; the sentence Q10's notice points to | `listFranchiseAccessLog` |

Nav: a "Franchise" group, each link gated by `capabilitiesForRoute` (no hand-rolled checks). Server actions only for
the two reads (they write a log row, so they are POST, never a GET render-time fetch — a page reload must not log
twice without a click). Plain words, ₱ with two decimals, Manila dates (`@shareat/core/datetime`).

## 7. Fences — S6 must NOT

- Post anything, touch POSTING-PATTERNS, or read any table outside: `franchise_*`, `sales_days`, `sales_day_channels`,
  `sales_channels` (name), `stores` (name), `items` (name, base unit, status), `stock_movements` (quantity),
  `store_item_thresholds`, `persons` (display name), `person_roles`/`person_grants` (reader check), `organizations`
  (name, in `franchise_franchisees` only).
- Widen any existing RLS policy, add a cross-org SELECT policy on any existing table, or grant `shareat_app` any
  write on the two new tables. The definers are the only door (V5).
- Fix DEF-747 (the customer link picker) — same root cause, its own task.
- Write `franchise_agreements` from the app (S7's onboarding writes it). Tests seed it as owner.
- Change `cross_org_access`, `bootstrapOrganization`, sign-in refusal wording, PIN throttles, or S5's definers/tables
  (only S5's **tests** G1c and X1 widen, K8).
- Add a bible row or a DEF number (orchestrator only; next free is DEF-794+ if the builder finds one — ask first).

## 8. Sub-slices (each ≤ 1 day; done-when = its TESTS.md legs red → green, named guards green, typecheck 0)

| Slice | What | Size | Needs | Parallel with |
|---|---|---|---|---|
| **S6a** | Capability + matrix doc rows + labels/areas/ROLE_ONLY + pinned counts; domain `authorize` shells for the four functions (throwing "not built") so V3/V18/V-cap legs can run | 0.3 | — | S6b |
| **S6b** | Migration 0220 + journal, `schema/franchise.ts`, `repo/franchise.ts`, registry/classification/NO_FK entry, S5 G1c/X1 widening, owner-side fixture `seedFranchiseAgreement(owner, …)` | 1.0 | — | S6a |
| **S6c** | `withActorPrincipal`; domain reads; approval-verifier log calls; V8a-d through the real sign-in functions | 0.7 | S6a, S6b | — |
| **S6d** | Three screens + nav + route map; §9.4 smoketest on 9008 with two orgs on a fresh copy (screenshots: Ian's sales/stock, PG's log showing both looks and one PIN sign-in); full suite in CI on the PR; auditor mutant table | 0.7 | S6c | — |

Total ≈ **2.7**. S6 merges **after** S5 (A10) — S5 is on main, so S6 merges whenever green. One PR (it carries a migration).

**Files (union):** migration 0220 + `meta/_journal.json`; `docs/ops/README.md` (0220 row); `packages/db/schema/{franchise,index}.ts`;
`packages/db/src/repo/{franchise,index}.ts`; `packages/db/src/rls/{registry,principal,same-org-fk-exemptions}.ts`;
`packages/db/src/cutover/classification.ts`; `packages/auth/src/{capabilities,admin-approval,pos-approval}.ts`;
`packages/domain/src/franchise/index.ts` + `packages/domain/src/index.ts`; `apps/erp/src/app/franchise/**`;
`apps/erp/src/app/expenses/lib.ts` (re-export only); `apps/erp/src/lib/route-capability.ts`; the nav source;
`docs/decisions/CAPABILITY-MATRIX.md`. ⛔ Not the bible, not the register, not S5's source files.
