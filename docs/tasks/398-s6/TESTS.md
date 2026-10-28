# T-398 S6 — tester checklist, per sub-slice

Rules for every leg: real Postgres (never a mock); app legs run as `shareat_app` under `withActorPrincipal(org, person, …)`
(or `withOrgPrincipal` where the leg says "no person"); "owner" legs connect as the migrator. Tests run on any `_test`
DB (no lane-DB name). Every leg is first seen **red for the stated reason**, red output pasted in the hand-back. Every
refusal is asserted by its **words** and its SQLSTATE, not only its class. Log counts are read **as owner** (so a missing
row cannot hide behind RLS).

**Fixture (S6b):** three orgs — **L** (Ian's: person `ianL` = role `admin` + person-level grant `view_franchise_sales`,
the production shape; `superL` = role `super_admin`; `adminL`, `mgrL`, `staffL` without the grant), **PG** (franchisee:
`ianPG` = the agreement's `franchisor_person_id`, `mgrPG`, `adminPG`, `staffPG`; two stores, store 1 with two
locations), **X** (a third org with its own agreement to a fourth org, plus sales days and stock on the same dates/items
names as PG). Agreement L→PG, `sales_visible_from` = D0. PG data: 3 verified days, 1 submitted, 1 open, 1 voided, one
**feed day with a platform channel** (K3), channel rows incl. one `no_sales`; stock movements with layers whose
`unit_cost` = sentinel **98765.43**; one expense, one payroll line and one AP bill of **87654.32**; one money account named
**"SENTINEL-BANK"**.

## Standing invariants

| Id | Invariant | How |
|---|---|---|
| L1 | **Every successful read writes exactly one log row; every refused read writes none** | Count `franchise_access_log` as owner before/after in every V-leg |
| L2 | **No sentinel leaks:** no returned value of either function equals 98765.43, 87654.32 or contains "SENTINEL" | Scan every cell of every result in V1, V15, V23 |
| M1 | No floats in new money/quantity code | Unit source scan of `domain/src/franchise/index.ts`, `repo/franchise.ts`: no `Number(`/`parseFloat(` |

## S6a — capability and matrix (`packages/auth/tests/integration/t398-s6-franchise-capabilities.test.ts`, unit pins)

| Id | Leg | Red today because | Mutant it kills |
|---|---|---|---|
| V3 | `adminL`, `mgrL`, `staffL` call `viewFranchiseSales` → `AuthorizationError` ×3 | function absent | `view_franchise_sales` admin ✅ (also `capability-matrix.test.ts`) |
| V18 | same three call `viewFranchiseStock` → `AuthorizationError` ×3 | absent | stock read skips `authorize` |
| C1 | `staffPG` calls `listFranchiseAccessLog` → refused; `mgrPG`, `adminPG` succeed | capability absent | matrix manager ✗ or staff ✅ |
| C2 | a `person_grants` row of `view_franchise_access_log` for `staffPG` confers nothing (`ROLE_ONLY`) | not role-only | remove from `ROLE_ONLY_CAPABILITIES` |
| C3 | Matrix doc ↔ code parser passes with the two edited rows; counts 97 | rows absent | edit one cell in the doc only |

## S6b — migration 0220 (`packages/db/tests/integration/t398-s6-franchise-sales-fn.test.ts`)

| Id | Leg | Red today because | Mutant it kills |
|---|---|---|---|
| V1 | `ianL` reads PG D0..D0+6: day rows = the 5 non-voided days; each verified day's `gross_sales` = `routeInputForDay(day,…).totalSales`, discounts/comps/refunds/net to the centavo; channel rows match `sales_day_channels`; 1 log row, `rows_returned` = 5, `person_name` = ianL's display name, visible to `mgrPG` | no function | remove the log INSERT (L1); `SECURITY INVOKER` (0 rows under RLS) |
| V2 | Catalog: `franchise_sales_daily`'s `RETURNS TABLE` column names and types equal the §3.4 list exactly | absent | add `total_expenses` / `service_charge` / `money_account` column |
| V4 | `adminPG`/`mgrPG` (in PG) call it with `p_franchisee_org` = L → 42501, no rows, no log | absent | drop the agreement check |
| V5 | As `shareat_app` with org = L: `SELECT count(*) FROM sales_days WHERE org_id = PG` (and `expenses`, `stock_movements`, `persons`, `stores`) → 0 | green guard | any widened policy |
| V6 | `p_from` = D0−1 → refused "before … visible from …"; span 367 days → refused; `to < from` → refused; none logs | absent | clip instead of refuse; drop range cap |
| V7 | UPDATE / DELETE on a log row **as owner** → raised | absent | drop the row trigger |
| V9 | Called with no `app.org_id` → 42501, no log | absent | guard checks person only |
| V10 | `app.person_id` NULL (org = L) → 42501, no log | absent | drop the NULL-person check |
| V11 | `adminL` (admin, no grant) via raw SQL with person set → 42501 | absent | drop the role/grant check |
| V21 | `ianL` (admin + grant, **production shape**) succeeds; `superL` (role, no grant) succeeds; after revoking ianL's grant → 42501 | absent | check role only (K1) or ignore `revoked_at` |
| V22 | A person of org **X** with org set to L (`app.person_id` of another org) → 42501 | absent | person-in-caller-org check dropped |
| V12 | `shareat_app` INSERT into `franchise_access_log` and into `franchise_agreements` → permission denied | absent | grant INSERT |
| V13 | TRUNCATE either table as owner → raised | absent | drop TRUNCATE trigger |
| V14 | Catalog: every `franchise_%` / `log_break_glass_%` function: `prosecdef`, `search_path` pinned, no PUBLIC EXECUTE, EXECUTE to `shareat_app`; `franchise_reader_check` has **no** EXECUTE for `shareat_app`; the `SECURITY DEFINER` set matching `franchise_%` / `log_break_glass_%` / `sessions_break_glass_%` equals the list pinned in 0220's header (5 callable + the session trigger function) | absent | grant to PUBLIC; add an unpinned definer |
| V15 | `ianL` reads PG store 1: on_hand per item = Σ `stock_movements` over both locations; equals `lowStock`'s on-hand for thresholded items; 1 log row with `store_id`; visible to `mgrPG` | absent | remove stock log INSERT |
| V16 | Catalog: `franchise_stock_levels` returns exactly store_id, store_name, item_name, base_unit, on_hand, threshold, below_threshold, as_of | absent | add `unit_cost` / value column |
| V17 | Stock function by X's reader, by L without agreement (agreement removed as owner), NULL person, non-grant admin, `p_store` = an X store → all refused, no rows, no log; after a successful call `stock_movements` / `stock_layers` counts and PG's 1310 balance unchanged | absent | drop agreement check; accept a foreign store id |
| V19 | **Third org sees nothing:** org X's reader (with its own agreement to org Y) calls both functions for PG → refused; for Y → gets only Y's rows (no PG or X row; value check against X's identical-name seed) | absent | a read missing `org_id = p_franchisee_org` (definer bypasses RLS) |
| V20 | `below_threshold` true at on_hand = threshold, false above, NULL threshold → false; inactive item excluded | absent | `<` instead of `<=` (K9) |
| V23 | Feed day: gross = `total_sales` + platform channel sum; `no_sales` channel row returned as 0 | absent | gross from `total_sales` alone (K3) |
| V24 | Log `CHECK`s: a break-glass row with `reader_person_id`, a read row without `range_*`, an approval row without `capability` → each rejected (as owner) | absent | loosen one CHECK |
| V25 | `franchise_franchisees()` as ianL → one row (PG name, D0); as `mgrL` with person set → 42501; writes no log | absent | drop the person check |
| G1c' | S5's `t398-s5-migration.test.ts` G1c: the `dual_org_counterparty` users = the 2 shipment tables + the 2 franchise tables | pinned at 2 | a fifth table on the kind |
| X1' | S5's X1 sweep: also excepts the two franchise tables, and as **X** both franchise tables show 0 rows of L/PG | excepts 2 | a franchise table readable by a third org |
| N1 | Census: `CROSS_ORG_BY_DESIGN` still `[]`; `NO_FK_PIN` = 31 with `franchise_access_log.session_id` (kind snapshot) | pin 30 | add a single-column cross-org person FK |
| R1 | `rls-registry`, `cutover-classification`, `migration-journal` (0220 `when` = 0219 + 86 400 000) green | entries absent | omit a registry entry |

## S6c — domain, principal, break-glass (`packages/auth/tests/integration/t398-s6-break-glass.test.ts`)

| Id | Leg | Red today because | Mutant it kills |
|---|---|---|---|
| P1 | `withActorPrincipal(org, person, fn)` sets `app.person_id`; the next transaction on the same pool sees it NULL | helper absent | session-scoped `set_config` (false) |
| V8a | `ianPG` signs in by email (`signInWithFirebase`, both `tx` and `null` forms) → exactly 1 `break_glass_sign_in` row with the session id and `firebase`; `mgrPG` sees it via `listFranchiseAccessLog`; `staffPG` refused | trigger absent | drop the trigger |
| V8b | `ianPG` signs in by PIN at a PG terminal (`signInWithPin`) → exactly 1 row, `pin`, store id | absent | trigger filters `credential_kind = 'firebase'` |
| V8c | `ianPG` approves via `verifyAdminApproval`, then via `verifyPosManagerApproval` → exactly 1 `break_glass_approval` row each, capability recorded | calls absent | drop either verifier's call |
| V8d | `ianPG` signs in on a paired tablet (`signInOnPairedTablet`) → exactly 1 row (K4) | absent | — (covered by the trigger mutant) |
| V8e | `mgrPG` signs in (all three ways) and approves → **0** rows; a failed `ianPG` PIN → 0 rows | absent | log every sign-in |
| V8f | A sign-in whose transaction rolls back after `issue()` leaves 0 log rows | — | log written outside the tx |
| D1 | `viewFranchiseSales` returns `Money` strings equal to V1's figures; `listFranchiseAccessLog` as `mgrPG` returns only PG rows (none of X's) | absent | repo read without `org_id` filter |

## S6d — screens (`apps/erp/tests/integration/t398-s6-view-franchise-sales.test.ts` + unit guards)

| Id | Leg | Red today because | Mutant it kills |
|---|---|---|---|
| U1 | `route-capability-coverage`, `no-ungated-read-surface`, `nav-route-reachability` green with the 3 routes; each page calls `requirePageAccess` with its literal route | routes absent | drop one `requirePageAccess` |
| U2 | `/franchise/sales` and `/franchise/stock` refuse `adminL`; `/franchise/access-log` refuses `staffPG` and `ianL` (no capability in L) | absent | map the access log to `view_franchise_sales` |
| U3 | Rendering the sales page writes **0** log rows; one submit writes 1 | — | fetch on render |
| S1 | Smoketest on 9008 (two orgs, fresh copy): screenshots of the three screens; the PG log shows Ian's sales look, stock look and one PIN sign-in | — | — |
