# T-391: Production master-data load (items, suppliers, customers, staff), with sheets Ian fills

**Status:** ✅ **BUILD DONE 2026-10-12** — S1-S6 on main (S6 `00539cf`, main `c9dc5f0`: readiness report; `canAt` shares `authorize()`'s decision code). Remaining: the rollout with Ian (§Rollout: extract on Ian's machine, sheets answered, dry run, apply per store). | Earlier: S1 (0193), S2, S3 DONE (S3 `ee32d86`, on main and in PR #16). **S4 DONE** 2026-10-12 (`8395e11` + re-audit fixes `1ea3490`, main `bc3936b`; two audit rounds; integration 100/100 t391 s1/s3/s4). **S5 DONE** 2026-10-12 (`96a318d`, main `3bd884f`; audit S14 applied; extract rates keyed by person_ref; integration 127/127 t391 s1-s5). **S6 (readiness) next.** | Earlier: SPEC APPROVED WITH CHANGES 2026-10-10 (fresh Opus review applied). Drafted 2026-10-10 by the Opus planner.
(≈4.0 lane-days, six slices; the plan says M 3, see §Research "Where this spec disagrees with the plan").
Migration **0NNN (allocated at merge)**. Seven questions for Ian; the recommended option is what gets built.
**T-390 S4 depends on this task's apply, per store** (its price list reads `v1_master_links`).

## Goal

Every item, supplier, wholesale customer, position and staff member that the dual run needs is in
production **once**, deduplicated, owned by the right organisation, and traceable back to the v1 record it
came from. **Lipa by 17 October** (so its encoder starts on 19 October), **the other three stores by 31 October**
(all four double-enter from 2 November). Every decision a machine must not make goes on a sheet that Ian fills,
and the load reads his answers. It never guesses.

## Source

- `docs/plans/remaining-build-plan.md` §1.1 row C3, §2.1 (16/23/31 Oct), §3.3 (T-391, L2, wave 1, M 3).
- Bible rows **302** (HR sheet by 31 Oct; if late, staff are hired without statutory ids and payroll stays on v1),
  **303** (Lipa double entry from 19 Oct, all four from 2 Nov, one office encoder per store; *cashiers and other
  positions with staff roles encode; the manager verifies*), **304** (opening stock valued at the last v1 delivery
  price: T-390 needs v1 units converted to v2 base units), **305** (Padre Garcia is its own organisation: its
  items, suppliers and customers must not land in Ian's org), **283** (v1 owns the goal, not the method).
- Ian's rulings on the item conflicts, Open Questions page, 2026-10-10 (plan-q5): **q5-1** one unit per item, the
  majority unit; another store's unit becomes a conversion only with a supplied factor, otherwise it is listed.
  **q5-2 = a** an item counted in box/pack is counted in what is inside; the box becomes the buying unit; one sheet
  asks "how many in a box". **q5-3 = b** "1 pack = N packs" items get a pre-filled sheet "count in pcs, 1 pack = N
  pcs" that Ian ticks or corrects. **q5-4 = a** punctuation twins go on a sheet, Ian ticks same/different.
  **q5-5 = a** junk names are not imported and are listed once.
- `scripts/import-items.ts` (T-145/T-147, sample mode), `scripts/recode-items.ts` and
  `docs/tasks/386-item-code-auto-suggest.md` (codes are allocated from the name, never hand-picked; the recode was
  applied on production on 10 Oct). DEF-634 (a one-off script on the droplet needs `NODE_ENV=production`).
- v1, read as requirements: `ERP-rebuild/src/types/index.ts` (`StaffPlain` :718, `SupplierPlain` :410,
  `ARCustomerPlain` :1611), `src/types/staff-identity.ts`, and the per-store collections
  `stores/{id}/items|suppliers|arCustomers|staff` plus the top-level `staffIdentities`.
  `docs/STORE-ROSTER.md` for the seven v1 store ids (Padre Garcia is `y1DMgfisuTHBF57cNL6i`).

## Research

### What v1 is trying to achieve (the goal), and what v1 does (the method)

| Goal | v1's method | Why the method cannot be copied |
|---|---|---|
| Each store knows what it buys and counts | One item master **per store**: 842 records for ~385 names; `white onion` is kg at Lipa and Malvar, pcs at Padre Garcia | v2's item master is org-level (T-145): one identity, one price history |
| Each store knows who it buys from and sells on credit to | Suppliers and AR customers **per store**; the commissary's branch customers mirror as suppliers (`linkedStoreId`) | v2 parties are org-level; an own store is `counterparty_store_id`, a franchise customer `counterparty_org_id` (ADR-008) |
| A person who works at two stores is one person | Staff **per store**, stitched afterwards by `staffIdentities` (built for salary advances) | v2 has one `persons` row and one `employments` row per store |
| Staff can do the work of their positions | Free-text position names per store | v2 has six canonical positions with capability defaults plus store positions |
| A staff member has a code people say out loud | `staffCode` `SE-NNN` per store | v2 allocates `SE-` max+1 per store (`allocateStaffCode`), so a fresh v2 numbering **collides** with v1's during the dual run (Q6) |

### What is already in the tree (verified 2026-10-10)

| Piece | Where | State |
|---|---|---|
| Item import, five conflict classes held back | `scripts/import-items.ts` | Sample mode. **Inserts through `itemsRepo` as `firstPersonId`, not through `createItem` with an actor**, so no `approve_item` check runs |
| A **sixth** skipped group | same file: `unknown kind` | Not ruled by Ian. Plus a **latent seventh**: when two stores give an item different kinds, the script takes `[...kinds][0]` silently (first wins). That is the exact guess q5-1 forbids for units |
| Code allocation | `allocateItemCode` / `requireItemCodeStem` (T-386); `createItem` allocates when no code is typed | Live. A re-run that creates nothing must consume no number |
| Item-level buying unit | **none.** `PURCHASE_UNITS` exists, but only on invoice and delivery lines, typed every time | **Missing.** q5-2 and q5-3 need a home, and T-390 R4 ("the purchase unit with its factor", "÷ `conversion_factor`") already assumes one |
| v1 id to v2 id | **none.** `stores` has no v1 id; `items`, `suppliers`, `customers`, `persons` have no legacy key | **Missing.** Idempotent re-runs, Lipa-then-others, T-390's price list and T-392's "AP per supplier" tie all need it |
| Item name uniqueness | `items_org_name_key` on `(org_id, lower(name))`, **across every status**, `merged` and `inactive` included | A v1 name equal to a merged or inactive v2 item cannot be created again (I-i) |
| Supplier, customer, person, employment, position writers | `createSupplier` (`approve_supplier`), `editSupplier` (no status), `createCustomer` (`manage_chart_of_accounts`), `createPerson` + `createEmployment` (`enrol_staff`, allocates `staff_code`, default position Server, **always adds the baseline `staff` role, the store scope and the position-default grants**), `upsertStorePosition`, `setPayRate` | Live, actor-gated. **`createItem`, `createSupplier` and `createCustomer` write no `audit_log` row.** No customer status writer exists |
| Supplier mirror of an own store | `suppliers.counterparty_store_id`, **system-managed only** (`suppliers.ts:79-91`); `createSupplier` does not take it; **no `counterparty_org_id` on suppliers** | The load needs its own named, audited writer (P5) |
| Statutory id storage | **none** (payroll schema comment: not one of 126 staff has an id in v1). T-190 adds it | The HR sheet is validated here and stored by T-190 (row 302) |
| A franchise organisation | T-398 (reserved) | Not created yet. Padre Garcia's data waits for it |

### Industry pattern (Odoo / ERPNext data import, master data management)

| Practice | Our reading |
|---|---|
| Import in two passes: validate (test import) then load | Dry run by default; `--apply` runs the **same** writes and commits. The dry run executes them inside one transaction that is rolled back (the `recode-items` pattern), so it proves every row passes the actor gate and the CHECKs |
| Keep an external id per imported record (Odoo `ir.model.data`, ERPNext "Data Import" naming) | **Adopted:** `v1_master_links`. Re-runs update nothing and create only what is new |
| A product has one stock UoM and a purchase UoM with a ratio (Odoo `uom_id` / `uom_po_id`) | **Adopted:** `items.purchase_unit` + `items.purchase_factor`, a default only; invoice and delivery lines still snapshot their own factor |
| Survivorship rules for duplicate records, with a steward for the doubtful ones | Exact-name duplicates merge (T-145's own unique key says they are one); look-alikes go to a steward sheet (Ian) |
| Never load personal data you do not need | The v1 snapshot keeps a field whitelist (R10); pay rates and the filled HR sheet never leave Ian's machine (R15) |

**What we are NOT doing, and why:**

- **No fuzzy matching or similarity threshold.** `Coke 1.5` and `Coke 15` differ by one dot. Ian ticks.
- **No overwrite of a v2 row on a re-run.** v2 rows are edited by people during the dual run; v1 drift is listed.
- **No opening balances.** AP and AR outstanding, stock, and fixed assets are T-390's opening figures.
- **No role above staff, and no PIN.** A manager role is a security grant made on a screen; a PIN is issued by a
  manager at the store (T-217). The load hires people into positions, which carries only the baseline every hire gets.
- **No web upload screen for the sheets.** The operator runs it with Ian, a handful of times. A screen is a
  week of work for four runs.

### Where this spec disagrees with the plan, or with another spec

1. **Size: ≈4.0, not 3.** Two missing pieces (a v1 link table and an item buying unit) are one small migration;
   the review added audited writers the load needs (buying unit, supplier mirror, customer and supplier status,
   a staff-code override) and the Padre Garcia split. Without them neither re-runs nor q5-2 have a home.
2. **T-390 R4 / S4 assumes an item-level purchase unit that does not exist.** S1 here adds it, and the link
   table carries each v1 store's `factor_to_base`. **T-390 S4 depends hard on T-391's apply for each store**: its
   price list reads `v1_master_links` (v1 item id to v2 item and factor, following `merged_into_id`) instead of
   matching by name. Written into T-390's S4 row and the plan's C1/C3 rows.
3. `scripts/import-items.ts` stays (`t386-s5-recode.test.ts` imports `insertCleanItems`), but its `main` prints
   "superseded by `npm run master-data`" and exits 1.

## Rulings

| # | Ruling | Reason |
|---|---|---|
| R1 | **Three steps, one command.** `extract` reads v1 **on Ian's machine** (the v1 service account lives only in `ERP-rebuild/.env.local`) through a **read-only** client (no write call exists in the module) and writes a snapshot file. `run` (dry run) and `run --apply` read the snapshot, the store map and Ian's sheets, and run on the target database (production: on the droplet). `extract` and `validate-hr` refuse when `NODE_ENV=production` | Production holds no v1 credentials and must not get them. The snapshot is the one fixed input, so a dry run and its apply see the same v1 data |
| R2 | **Dry run by default: ONE outer transaction, a savepoint per entity, everything rolled back at the end.** So the staff step of a dry run sees the positions its own positions step created. Without `--apply` nothing is committed; the sheets and `report.html` are written either way | Proves the apply before it happens, as `recode-items` does, including the dependencies between entities |
| R3 | **On `--apply`, one transaction per entity per run** (positions, items, suppliers, customers, staff, in that order). A failure leaves that entity untouched and stops the run | All or nothing per entity is easy to reason about at ~400 rows |
| R4 | **Idempotent through `v1_master_links`.** A v1 record with a link is never written again. A v1 record with no link whose name matches an existing v2 row (exact key) is **linked**, not duplicated (I-i for items). A run that creates nothing consumes no item code and no staff code | Re-runs are how Lipa goes first and the others follow |
| R5 | **Per-store scope, org-wide decisions.** `--stores LIPA` writes only what Lipa's v1 records need. But every unit, kind and twin decision is computed over **all stores of the TARGET org in the map** (role `own` for Ian's org; the franchise's own store for its org), whatever the scope | Otherwise Lipa could fix `white onion` as pcs and Malvar's later run would contradict it; and one org's majority never counts another's stores |
| R6 | **The store map is the org boundary.** `stores.csv` pairs each v1 store id with `role` (`own` / `franchise` / `exclude`), `org_code` and `store_code`. A run targets one org (`--org`), and **is refused when the actor's org is not `--org`**. Rows of another org are ignored. A `franchise` row and an `own` row may never share an `org_code` (refused). **Padre Garcia's v1 id `y1DMgfisuTHBF57cNL6i` is hard-coded (from `docs/STORE-ROSTER.md`); a map giving it any role but `franchise` is refused.** The target store must exist in the target org | Row 305: Padre Garcia's data cannot reach Ian's org, even by a typo in the map |
| R7 | **Padre Garcia never counts in Ian's org's majorities**, and its run waits for T-398's org (`--org <PG> --stores <PG code>`). **A `staffIdentities` group spanning Padre Garcia and an own store is split**: the own-store employments go to Ian's org, the Padre Garcia one is never written there (it waits for PG's run, as a separate person in PG's org) | Row 305. Its `pcs` for `white onion`, and its staff, are its own business |
| R8 | **The actor is a person (`--actor`), and the domain functions gate it.** Items need `approve_item`, suppliers `approve_supplier`, customers `manage_chart_of_accounts`, staff `enrol_staff` at each store. No repo insert, no `firstPersonId`. ⚠️ **`createItem`, `createSupplier` and `createCustomer` write no `audit_log` row**, so each `--apply` writes **one audit row per entity applied**: action `master_data_load`, entity the entity name, `after` = `{ snapshotSha, stores, created, linked, held }`, source `script`. The new writers below (buying unit, supplier mirror, statuses, staff-code override) audit each row themselves | Every row is attributed and authorised like a screen write; the load as a whole is on the audit trail |
| R9 | **Sheets live outside the repository.** `--sheets <dir>` resolving inside the git work tree is refused. Files are written mode 0600 | The staff sheet holds names |
| R10 | **The snapshot keeps only what the load uses.** Items: id, name, kind, baseUnit, purchaseUnit, conversionFactor, store. Suppliers: id, businessName, classification, address, contacts, email, representative, vatStatus, vatRegistrationNo (as TIN), issuesOfficialReceipt, lastCreditDueDays, first bank account, isActive, linkedStoreId, updatedAt. AR customers: id, name, address, contactNo, classification, status, linkedStoreId, **updatedAt**. Staff: id, store, staffCode, fullName, positions, employmentStatus, dateHired, isActive. `staffIdentities`: id and staffRefs. **Nothing else** (no birthday, address, email, photo, signature, balances, **no pay rates**) | The snapshot travels to the droplet. Less personal data is less to leak |
| R11 | **Every sheet row has a `row_key`**: the first 12 hex of sha256 over the v1 inputs that row decides. An answer whose key no longer matches is ignored, re-emitted blank and listed as stale | v1 keeps changing during the dual run. An answer must never apply to data it was not given for |
| R12 | **A held row holds back only itself** (and what depends on it). Unanswered rows never block the rest | Lipa can start with the clean majority while Ian works through the sheets |
| R13 | **v1 drift is reported, never applied.** A linked v1 record that changed since its link (name, unit, contact) is listed in `report.html` | v2 rows are edited by people during the dual run |
| R14 | **Junk names (q5-5)** are listed once in `items-not-imported.csv` and never imported. Junk = under 2 characters or no letter | Ian, q5-5 = a |
| R15 | **No statutory id and no pay rate is stored here, and neither goes to the droplet.** `extract` writes pay rates to a **local-only** `v1-staff-rates.local.csv` beside the snapshot (not in it). The filled `staff-roster.csv` is **never copied to the droplet**: the droplet run emits a roster skeleton (names, store, positions, `staff_code`); Ian's machine runs `validate-hr`, which merges the local rates and validates the ids. T-190 stores them (Q4) | Row 302: v2 has no column yet, and payroll may stay on v1 |
| R16 | **One apply at a time per org**: `--apply` takes `pg_advisory_xact_lock` on a key derived from `('t391', org_id)` in each entity transaction; a second concurrent apply waits, then finds the links and writes nothing | Two operators, or a re-run in a second terminal, must not mint two items for one name |

### Items (q5-1 to q5-5, plus the two groups Ian has not ruled)

| # | v1 shape | What the load does | Sheet |
|---|---|---|---|
| I-a | Same name (exact key `lower(trim)`) at several stores of the target org, same unit, same kind | One item; every store's v1 record linked with `factor_to_base = 1` | none |
| I-b | Units differ across the org's stores (q5-1) | The item takes the **majority unit** (count of stores). A minority store's record is linked only when Ian supplies `factor` (1 v1 unit = factor base units); blank = that store's record is listed, the item is still created. **A tie has no majority, so it is held** until Ian picks (our reading of q5-1, which names no tie rule) | `items-units.csv`: item, majority unit, `store`, `v1_unit`, **`factor`** (blank); tie rows get **`unit`** |
| I-c | Base unit is a container, `box` / `pack` / `case` / `sack` / `tray` / `dozen` (q5-2) | Held until Ian gives what is inside and how many. Then base = the inside unit; `setItemPurchaseUnit(container, N)`; link `factor_to_base` = N | `items-box.csv`: item, v1 unit, **`inside_unit`** (pre-filled with v1 `purchaseUnit` when it is a real unit), **`how_many`** |
| I-d | `pack -> pack` (or `box -> box`) at factor N not 1 (q5-3) | Pre-filled: base `pcs`, purchase `pack`, factor N. **Held until ticked** or corrected | `items-pack-pack.csv`: item, **`base_unit`** = pcs, **`per_pack`** = N, **`ok`** |
| I-e | Names equal once punctuation and spacing are stripped (q5-4), **including existing v2 names** (Lipa's encoders create items from 19 Oct) | Every name in the group held until Ian answers. `same` = one item named `keep_name` (pre-filled with the existing v2 name if there is one, else the spelling most stores use), all records linked. `different` = each name is its own item | `items-twins.csv`: group, name, stores or "in v2", **`same_or_different`**, **`keep_name`** |
| I-f | Junk name (q5-5) | Never imported, listed once | `items-not-imported.csv` |
| I-g | **No kind, or an unknown kind** (unruled, Q2) | Held. Ian may fill the kind; blank = not imported | `items-kind.csv`: item, v1 kinds per store, **`kind`** |
| I-h | **Kinds differ across the org's stores** (latent, today first-wins) | Same sheet, majority kind pre-filled, held until ticked | `items-kind.csv`, **`ok`** |
| I-i | Name already in v2 (exact key, any status) | **Active, same unit:** linked. **Unit differs:** treated like a minority store: the v2 item is never changed, and the record is linked only once `factor` is given on `items-units.csv` ("already in v2 as X"). **`merged`:** linked to its `merged_into_id` (with the factor rule above against the winner's unit). **`inactive`:** held on `items-units.csv` with **`link_inactive`** (yes/no); never re-created, because `items_org_name_key` covers every status | `items-units.csv` |

A row answered on two sheets (a twin that is also a box) is held until both are answered. The item's
`kind` and `base_unit` are decided once, before `createItem`, so `items_base_unit_fixed` never has to be crossed.

### Suppliers and customers

| # | Ruling |
|---|---|
| P1 | Exact-name duplicates across the org's stores are **one** supplier (or customer); every store's v1 record is linked |
| P2 | Look-alike names (the item `loose` key, existing v2 names included) go to `suppliers-twins.csv` / `customers-twins.csv`, same answer shape as items |
| P3 | Field survivorship for merged copies: each field takes the non-empty value of the **most recently updated** copy, **except `vat_status` and `tin`**: copies that disagree are held on `suppliers-tax.csv` for Ian (tax treatment of input VAT is not a coin toss) |
| P4 | v1 `classification` `Corporate`/`Individual`/`Other` maps to `corporate`/`individual`/`other`; `VAT Reg`/`Non-VAT Reg` to `vat_registered`/`non_vat`; `lastCreditDueDays` to `credit_terms_days`; the first bank account only, the rest named in `notes` |
| P5 | **Own-store links.** A v1 AR customer with `linkedStoreId` on an own store becomes `createCustomer({ counterpartyStoreId })`, group `internal`. A v1 supplier with `linkedStoreId` (the commissary mirror) is created by `createSupplier` and then given its link by **`setSupplierCounterpartyStore`**, a new, named writer in S4 (`approve_supplier`, refuses a store of another org, one `audit_log` row), because `counterparty_store_id` is system-managed and `createSupplier` does not take it. **Franchise links:** a customer pointing at a franchise store is held until the franchise org exists, then becomes `counterparty_org_id`, group `franchise` (ADR-008 §7). **A supplier pointing at a franchise store stays held, with no v2 target**: suppliers have no `counterparty_org_id`, and T-398 decides what it becomes |
| P6 | AR `classification` `staff` maps to group `staff`; `individual`/`corporate` to `wholesale`; `other` to `other` |
| P7 | **Inactive v1 records are imported as `inactive`** (Q7; they keep the v1 to v2 map whole for the comparator). The create functions make rows `active`, so S4 adds **`setCustomerStatus`** (`manage_chart_of_accounts`, audited) and a `status` field on **`editSupplier`** (`approve_supplier`, audited), and the load calls them right after the create. Balances, reconciliation stamps and AP/AR documents are **not** imported |
| P8 | A bank account number never appears in a sheet or the report (last four digits only) |
| P9 | *(orchestrator, at S4 RED, 2026-10-11)* A franchise-pointing party goes on `parties-held` with reason `franchise` **for information only**: never written, and **not counted** in `held`, so it never blocks apply |
| P10 | *(orchestrator, 2026-10-11)* A blank `tin`/`vat_status` on one copy is not a disagreement (P3's newest non-empty applies); only two different non-blank values hold the row |
| P11 | *(orchestrator, 2026-10-11)* A merged party with mixed active/inactive copies is `active` if any copy is active (refines P7) |
| P12 | *(orchestrator, 2026-10-11)* Audit actions: `set_supplier_counterparty_store`, `set_customer_status`, `set_supplier_status` (before/after, only on a real change); load rows `master_data_load`, source `etl` |
| P13 | *(orchestrator, at S4 audit, 2026-10-11)* An unmapped non-blank `vat_status` (`Exempt`, `Zero-rated`, a typo) is a distinct value: it holds the row on `suppliers-tax` for Ian, never silently blank. A non-integer or negative `lastCreditDueDays` becomes null and is listed. A manager's apply with customers in scope is refused before anything is written. The report says a stored bank number is masked and must be re-entered |

### Positions and staff

| # | Ruling |
|---|---|
| S1 | A v1 position name equal to a canonical one (case and spacing ignored) is that position. Any other name goes to `positions.csv` per store: Ian writes a canonical name, `new:<name>` (a store position via `upsertStorePosition`) or `none` |
| S2 | **The load grants no role beyond a hire's baseline.** `createEmployment` always adds the baseline `staff` role, the store scope and the position-default grants; nothing else is granted: **no manager, admin or super_admin role, no PIN, no credential**. v1 positions that read as management (`Manager`, `Supervisor`, `OIC`, …) are answered `none` on `positions.csv` and listed on `access-to-grant.csv` for Ian to grant on the screen |
| S3 | Only **active** v1 staff are hired (`isActive` and a status that is not `resigned`/`terminated`/`inactive`), Q3 |
| S4 | **One person per human, within one org.** A `staffIdentities` group is one person with one employment per store of the target org (split at the org boundary, R7). Same exact name at two stores of the org, not in a group, or the same name as an existing v2 person: held on `staff-same-person.csv` (`same` / `different`) |
| S5 | `started_on` = v1 `dateHired` as a Manila date. Missing: held until the roster sheet gives it. `employment_status` maps one to one (`part-time` exists in v2) |
| S6 | A staff member with at least one resolved position is hired with those (first resolved = primary); unresolved names are listed. With none at all, `createEmployment`'s default (`Server`) applies, as in v1 |
| S7 | **The HR sheet is `staff-roster.csv`, one per org** (format in §Contract). The droplet run emits the skeleton; `validate-hr` on Ian's machine merges rates and validates the statutory columns, and reports "N of M complete"; nothing of it is stored (R15) |
| S8 | Row 303 (q12) is checked, not configured: the readiness report names each store's encoders (a position holding `create_expense` and `receive_delivery`, i.e. Cashier today) and its verifiers (a manager role), and flags a store where they are the same person or either is missing |
| S9 | **Staff codes keep v1's (Q6, recommended).** `createEmployment` gains an optional `staffCode` override (`enrol_staff`; shape `SE-NNN`; **refused when the code is taken at that store**, with a `userReason`; one `audit_log` row when used). The load passes v1's `staffCode`; a v1 code that is blank, malformed or duplicated at its store falls back to allocation and is listed. Later hires keep `max + 1`, which then starts above v1's numbers |
| S10 | *(orchestrator, at S5 RED, 2026-10-11)* A person whose v1 positions are ALL unanswered on `positions.csv` is held (nothing written for them) until answered; a person with at least one resolved position is hired with those, and the unanswered names are listed. Every staffCode-override refusal carries a `userReason` |
| S11 | *(orchestrator, 2026-10-11)* A v1 staffCode duplicated at one store: the copy with the earliest `dateHired` (then the lowest v1 id) keeps it; the other falls back to allocation and is listed |
| S12 | *(orchestrator, 2026-10-11)* `dateHired` is accepted as an ISO timestamp or a date-only `YYYY-MM-DD`, read as a Manila date; any other form is held on `staff-roster.csv` like a missing date |
| S13 | *(orchestrator, 2026-10-11)* `person_ref` on `staff-roster.csv` and the rates file is the `staffIdentities` group key for a grouped person and the v1 staff id otherwise; a blank `person_ref` row in the rates file is incomplete, not an error |
| S14 | *(orchestrator, at S5 audit, 2026-10-12)* With positions in scope, `applyMasterData` authorizes `manage_store_settings` at every in-scope store up front, beside `enrol_staff`. A later-step refusal or hold reports which entities already committed (as S4). The rates file is keyed by `person_ref`, the same key as the roster; `validate-hr` lists roster persons with no rate row. `access-to-grant.csv` merges by `row_key` and never drops an ungranted row. An UNANSWERED management-looking position also lands on it (pending). `rate_effective_from` follows the rate basis. Dismissed: an SE-999 override pushing allocation to 4 digits (existing allocator behaviour); `new:` position not yet created aborts staff with an honest error; concurrent override race (unique index `employments_store_staff_code_unique` + store-row lock) |

## Contract

### Command (`scripts/master-data.ts`, `npm run master-data`)

```
npm run master-data -- extract --out <dir>                      # Ian's machine only; refuses NODE_ENV=production
npm run master-data -- run --snapshot <dir>/v1-snapshot.json --map <dir>/stores.csv \
    --org <uuid> --actor <person uuid> --sheets <dir> [--stores LIPA,MLVR] \
    [--only positions|items|suppliers|customers|staff]... [--apply]
npm run master-data -- readiness --org <uuid> --stores LIPA --sheets <dir>
npm run master-data -- validate-hr --roster <file> --rates <dir>/v1-staff-rates.local.csv   # Ian's machine only, pure
```

On production, always: `sudo -u shareat env NODE_ENV=production npm run master-data -- run …` (DEF-634).

- `extract` reads **all** v1 stores (no cap; it prints the store count beside the number, STORE-ROSTER's rule),
  writes `v1-snapshot.json` (R10 whitelist), `v1-snapshot.sha256`, the local-only `v1-staff-rates.local.csv`
  (R15), and a `stores.csv` pre-filled with every v1 store id and name, `role` pre-filled from STORE-ROSTER (four
  `own`, Padre Garcia `franchise`, two `exclude`), and `org_code` / `store_code` blank. No credential, key or token
  is written to any output.
- `run` exit codes: **0** nothing held; **2** rows held for Ian (not a failure); **1** error or refusal.
- `report.html` (static, no scripts): counts per class, held rows by sheet, stale answers, drift, and what the
  apply wrote. Viewable at 375 px.
- `validate-hr` is a pure function over two local files: no database, no network. It writes the merged roster
  back beside its input and prints completeness.

### Sheets (CSV, UTF-8 with BOM so Excel opens it, RFC 4180 quoting)

Every sheet: `row_key` first, decision columns in **bold names** in §Rulings, a `note` column last. The parser
accepts Excel's re-save (BOM, CRLF, quoted commas). Item sheets: `items-units`, `items-box`, `items-pack-pack`,
`items-twins`, `items-kind`, `items-not-imported`. Parties: `suppliers-twins`, `suppliers-tax`, `customers-twins`,
`parties-held`. People: `positions`, `staff-same-person`, `access-to-grant`, `staff-roster` (skeleton only on the
droplet).

**`staff-roster.csv` (the HR sheet, S7):**

| Column | Filled by | Rule |
|---|---|---|
| `row_key`, `person_ref` | load | `person_ref` is stable across runs (the identity group or the v1 staff id) |
| `full_name`, `store_code`, `positions`, `primary_position`, `employment_status`, `started_on` | load from v1, HR may correct before apply | `started_on` YYYY-MM-DD |
| `staff_code` | load, after apply | v2's code (v1's, per S9) |
| `sss_no` | HR | 10 digits (`NN-NNNNNNN-N`); dashes and spaces ignored |
| `philhealth_no` | HR | 12 digits |
| `pagibig_no` | HR | 12 digits (HDMF MID) |
| `tin` | HR | 9 digits, or 12 with the branch code |
| `pay_basis`, `rate`, `rate_effective_from` | `validate-hr` from the local rates file (`payType`, `hourlyRate`/`dailyRate`, `hourlyRateEffectiveFrom`), HR confirms | not loaded (Q4) |
| `hr_note` | HR | free text |

The same id on two persons is refused by name. A malformed id is reported by name and column, never echoed in full.

### Migration 0NNN (S1, hand-authored, ADR-012 §5; statement breakpoints and named FK constraints as 0190)

```sql
ALTER TABLE "items" ADD COLUMN "purchase_unit" text;
ALTER TABLE "items" ADD COLUMN "purchase_factor" numeric(14,6);
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_pair_check"
  CHECK (("purchase_unit" IS NULL) = ("purchase_factor" IS NULL));
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_unit_check"
  CHECK ("purchase_unit" IS NULL OR ("purchase_unit" in ('pcs','kg','g','ltr','ml','roll','box','pack','case','sack','tray','dozen')
         AND "purchase_unit" <> "base_unit"));
ALTER TABLE "items" ADD CONSTRAINT "items_purchase_factor_check"
  CHECK ("purchase_factor" IS NULL OR ("purchase_factor" > 0 AND "purchase_factor" < 'Infinity'::numeric));

CREATE TABLE "v1_master_links" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "org_id" uuid NOT NULL,
  "entity" text NOT NULL,
  "v1_store_id" text NOT NULL,          -- '' for an org-level v1 document (a staffIdentities group)
  "v1_id" text NOT NULL,
  "v2_id" uuid NOT NULL,                -- polymorphic by entity; resolved by test 15, not by FK
  "v1_unit" text,
  "factor_to_base" numeric(14,6),
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "v1_master_links_entity_check" CHECK ("entity" in ('item','supplier','customer','person','employment','position')),
  CONSTRAINT "v1_master_links_v1_id_not_blank_check" CHECK (btrim("v1_id") <> ''),
  CONSTRAINT "v1_master_links_item_factor_check" CHECK (
    ("entity" = 'item' AND "factor_to_base" > 0 AND "factor_to_base" < 'Infinity'::numeric AND "v1_unit" IS NOT NULL)
    OR ("entity" <> 'item' AND "factor_to_base" IS NULL AND "v1_unit" IS NULL))
);
ALTER TABLE "v1_master_links" ADD CONSTRAINT "v1_master_links_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "v1_master_links" ADD CONSTRAINT "v1_master_links_created_by_persons_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "persons"("id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "v1_master_links_key" ON "v1_master_links" ("org_id","entity","v1_store_id","v1_id");
CREATE INDEX "v1_master_links_v2_idx" ON "v1_master_links" ("org_id","entity","v2_id");
-- ENABLE + FORCE ROW LEVEL SECURITY; policy org_id = app_current_org() (USING and WITH CHECK), as 0190.
-- Grants: SELECT, INSERT to the app role. No UPDATE, no DELETE: a link is a fact about the load.
```

Registry: `org_column`. Classification: **`keep`**: it is the v1 to v2 key that T-390's price list and T-392's AP
tie read, and after 1 January it is provenance. Drizzle: `packages/db/schema/v1-master-links.ts`; `items.ts` gains
the two columns. The SQL unit list must equal `PURCHASE_UNITS` (test 15).

### Domain

- **S1:** `setItemPurchaseUnit(tx, actor, { itemId, purchaseUnit, purchaseFactor })` (both, or both null to clear),
  gated on `approve_item` and audited exactly like `changeItemBaseUnit` (one `audit_log` row, before/after), because
  T-390 divides delivered prices by the factor. Refuses with a `userReason` what the CHECKs refuse. `createItem`
  does **not** take the pair. `changeItemBaseUnit` refuses while a purchase unit is set:
  *"Clear the buying unit first; its factor is in the old unit."*
- **S1:** `packages/db/src/repo/master-links.ts`: `linksFor(tx, orgId, entity)`, `insertLink(tx, row)`. Nothing else.
- **S4:** `setSupplierCounterpartyStore` (P5), `setCustomerStatus` and `editSupplier`'s `status` (P7), each audited.
- **S5:** `createEmployment`'s optional `staffCode` override (S9), audited when used.

### Pure planner (`packages/etl/src/master-data/`, no database, unit-tested)

`snapshot.ts` (types, whitelist, sha), `keys.ts` (`key`, `loose`, `isJunkName`, moved from `import-items.ts`),
`store-map.ts` (parse + R6), `sheets.ts` (CSV read/write, row keys, stale detection), `items-plan.ts`,
`parties-plan.ts`, `staff-plan.ts`, `hr-sheet.ts`. Each planner takes the snapshot, the map, the existing v2 rows
and links (plain arrays), and the parsed answers, and returns `{ writes, sheets, listed, drift }`. The writer
(`scripts/lib/master-data-apply.ts`) only executes `writes` through the domain functions and inserts links.

## Invariants

| # | Invariant | Test |
|---|---|---|
| I1 | No v1 record from a `franchise` or `exclude` store is ever written to an org that holds an `own` store; a run whose actor is of another org is refused | 12, 20, 25 |
| I2 | A re-run with unchanged inputs writes zero rows and consumes no item code or staff code | 16 |
| I3 | The dry run writes nothing and reports exactly what `--apply` writes, entity dependencies included | 17, 26 |
| I4 | Every link's `v2_id` resolves to a row of its entity in the same org | 15 |
| I5 | No item is created with a container base unit, and no item's unit or kind is first-wins | 2, 5, 8 |
| I6 | An answer applies only to the `row_key` it was given for | 9 |
| I7 | An existing v2 row is never updated by the load (only the new audited writers touch the rows the load itself just created) | 19, 23 |
| I8 | No sheet, report, log line or droplet input file contains a full bank account number, a full statutory id or a pay rate | 11, 21, 27 |
| I9 | The load grants no role beyond a hire's baseline `staff` role, store scope and position-default grants; no manager, admin or super_admin; no PIN or credential | 22 |
| I10 | Majorities are computed over all stores of the target org, whatever `--stores` says, and never over another org's | 3 |

## Slices

| Slice | What | TESTER writes (first) | BUILDER owns | Size |
|---|---|---|---|---|
| **S1** | Migration 0NNN, schema, repo, `setItemPurchaseUnit`, `changeItemBaseUnit` refusal | `packages/domain/tests/integration/t391-s1-purchase-unit-and-links.test.ts` | `packages/db/migrations/0NNN_t391_master_links.sql` + `meta/_journal.json`, `packages/db/schema/{items.ts,v1-master-links.ts,index.ts}`, `packages/db/src/repo/{master-links.ts,index.ts}`, `packages/db/src/rls/registry.ts`, `packages/db/src/cutover/classification.ts`, `packages/domain/src/items/index.ts` | 0.75 |
| **S2** | `extract`, snapshot, store map, sheets, item planner, `run` dry run for items | `packages/etl/tests/t391-s2-item-plan.test.ts`, `packages/etl/tests/t391-s2-extract.test.ts`, `packages/etl/tests/fixtures/t391-v1-snapshot.json` (invented names, every class I-a..I-i present) | `packages/etl/src/master-data/{snapshot,keys,store-map,sheets,items-plan,index}.ts`, `scripts/master-data.ts`, `package.json` (one script line), `scripts/import-items.ts` (`main` superseded) | 1.0 |
| **S3** | Item apply: writer, links, audit row, advisory lock, idempotence, per-store scope | `packages/domain/tests/integration/t391-s3-item-apply.test.ts` | `scripts/lib/master-data-apply.ts`, `scripts/master-data.ts` | 0.5 |
| **S4** | Suppliers and customers: planner, apply, the mirror and status writers | `packages/etl/tests/t391-s4-parties-plan.test.ts`, `packages/domain/tests/integration/t391-s4-parties-apply.test.ts` | `packages/etl/src/master-data/parties-plan.ts`, `scripts/lib/master-data-apply.ts`, `packages/domain/src/ap/index.ts`, `packages/domain/src/customers/index.ts`, `packages/db/src/repo/{ap,customers}.ts` | 0.75 |
| **S5** | Positions and staff: planner, HR sheet validator, `validate-hr`, staff-code override, apply | `packages/etl/tests/t391-s5-staff-plan.test.ts`, `packages/etl/tests/t391-s5-hr-sheet.test.ts`, `packages/domain/tests/integration/t391-s5-staff-apply.test.ts` | `packages/etl/src/master-data/{staff-plan,hr-sheet}.ts`, `scripts/lib/master-data-apply.ts`, `scripts/master-data.ts`, `packages/domain/src/people/index.ts`, `packages/db/src/repo/employment*.ts` | 0.85 |
| **S6** | `readiness` per store (read-only) | `packages/domain/tests/integration/t391-s6-readiness.test.ts` | `scripts/lib/master-data-readiness.ts`, `scripts/master-data.ts` | 0.25 |

S1 and S2 can run in parallel (no shared path). S3 needs both. S4 and S5 need S3's writer and follow it in
either order. **Lipa's run needs S1-S5; S6 is wanted before 17 Oct but does not block the load.**

**If a slice slips past 16 Oct, Lipa's apply goes ahead without it:**
- **S4 late:** items and staff load. There are no suppliers or customers in v2, so Lipa's encoder cannot record
  supplier invoices against a v1 supplier, only expenses. T-392 has no AP-per-supplier tie for those days.
  `--only suppliers,customers` runs the day S4 lands.
- **S5 late:** items (and parties) load, but there are no staff, so nobody signs in at Lipa. **19 Oct then
  slips day for day.** The fallback is hiring Lipa's encoder and manager by hand on `/staff/hire`. They are
  linked when S5 runs: staff ruling S4 (existing person) holds them on `staff-same-person.csv`.

## Tests (TESTER writes first; each red leg is shown red on HEAD or against the named mutant)

**Unit, pure (S2, S4, S5)**

1. Keys: `3D W/LID` and `3D W/LID.` are twins; `Coke 1.5` and `Coke 15` are twins and **not** merged; `2` and
   `--` are junk; `Pork Belly` / `pork belly ` share the exact key. *Mutant: `loose` = `key`.*
2. Majority unit: kg at two own stores, pcs at Padre Garcia: kg, no sheet row. Add a third own store with pcs:
   kg plus one `items-units` row for that store. 1-1 between two own stores: held, no item. *Mutants: first wins;
   franchise counted.*
3. Scope independence: the planned unit and kind for every item are identical with `--stores LIPA` and with all
   stores; a run targeting the PG org counts only PG's store. *Mutants: majority over the scoped stores; over
   every store in the map.*
4. Minority store: `factor` filled gives a link with that `factor_to_base` and `v1_unit`; blank gives a listed
   record and the item is **still created**. *Mutant: the whole item held.*
5. Box (q5-2): base `box` is held; `inside_unit = pcs`, `how_many = 24` gives base `pcs`, a `setItemPurchaseUnit`
   write of box/24, link factor 24. `how_many` 0 or blank stays held. *Mutants: base `box` accepted; factor
   inverted (1/24).*
6. Pack to pack (q5-3): pre-filled `pcs`, N from v1; `ok` ticked gives pcs/pack/N; a corrected `per_pack` wins over
   v1's N; unticked stays held. *Mutant: the correction ignored.*
7. Twins (q5-4): `same` gives one item named `keep_name` and links for every record; `different` gives one item per
   name; blank holds every name in the group; a v1 name that is a look-alike of an existing v2 name lands in a group
   with it. *Mutants: auto-merge on `loose`; v2 names left out of the look-alike scan.*
8. Kind: an unknown kind is held; two stores with different kinds give a pre-filled majority that applies only when
   `ok` is ticked. *Mutant: today's `[...kinds][0]`.*
9. Stale: change one v1 field behind an answered row; the answer is ignored, the row re-emitted blank and listed
   stale. *Mutant: answers matched by item name.*
10. CSV: a sheet re-saved by Excel (BOM, CRLF, a quoted comma, `ñ`) round-trips. *Mutant: split on commas.*
11. HR sheet (`validate-hr`): each id's valid and invalid forms; dashes ignored; the same SSS on two persons refused
    by both names; completeness `N of M`; rates merged from the local file; the error message shows at most the
    last 4 digits. *Mutants: an off-by-one length; the full id echoed.*
12. Store map: a `franchise` row sharing an `org_code` with an `own` row refused; **`y1DMgfisuTHBF57cNL6i` mapped as
    `own` or `exclude` refused**; `exclude` rows ignored; a blank `store_code` on a scoped store refused; `--sheets`
    inside the work tree refused. *Mutants: R6 guard removed; the hard-coded PG id removed.*
13. Parties plan: exact duplicates merge with newest-non-empty survivorship (customers too, by `updatedAt`); a
    `vat_status` disagreement held on `suppliers-tax`; commissary `linkedStoreId` gives a mirror write; a customer
    link to the franchise store is held; a supplier link to it is held with no target; classifications map per
    P4/P6. *Mutants: oldest wins; tax fields survivorship-merged.*
14. Staff plan: an identity group across Lipa and Malvar is one person with two employments; **a group across Lipa
    and Padre Garcia gives Ian's org one employment (Lipa) and nothing for PG**; resigned and `isActive: false` are
    not hired; `Cashier ` resolves canonical; `Manager` with no answer is held and with `none` lands on
    `access-to-grant`; same name at two stores without a group is held; v1 `staffCode` is planned as the override,
    a duplicate one falls back and is listed. *Mutants: one person per store record; ended staff hired; the PG leg
    written.*
15a. Extract (S2, against a fake Firestore client): the snapshot holds only the R10 fields (no rate, birthday,
    address on staff); no output file contains the service-account key, `private_key` or `client_email`; the client
    module exposes no write call (`set`, `update`, `delete`, `add`, `batch`, `runTransaction` absent); `extract`
    refuses under `NODE_ENV=production`. *Mutants: rates kept in the snapshot; the key echoed into `stores.csv`.*

**Integration (gate database)**

15. S1: the CHECKs (pair both-or-neither; purchase unit equal to base refused; factor 0 and negative refused; link
    factor required for items and forbidden otherwise); `setItemPurchaseUnit` stores the pair, refuses without
    `approve_item` (the ✗ fires) and writes one `audit_log` row; `changeItemBaseUnit` refuses while it is set; the
    migration's unit list equals `PURCHASE_UNITS` (read from `pg_constraint`); RLS on `v1_master_links` (org B
    cannot see or insert org A's rows); no UPDATE grant; after any apply test, every link's `v2_id` resolves (I4).
    *Mutants: the pair check dropped; the `<> base_unit` leg dropped; `dozen` missing from the SQL list.*
16. S3 idempotence: apply the fixture twice; the second run writes no item, no link, and leaves
    `item_code_counters` unchanged. *Mutant: allocate the code before the existing-name check.*
17. S3 dry run: row counts and counters unchanged, and its report equals the following `--apply`'s write list.
    *Mutant: commit in dry run.*
18. S3 scope: `--stores LIPA` then `--stores MLVR`: Malvar's records link to Lipa's items, no duplicate item, and
    only Malvar-only names are created. *Mutant: the exact key made per store.*
19. S3 existing rows: an active item with another unit is linked only after a `factor`, and unchanged; a `merged`
    item's name links to its winner; an `inactive` one is held and never re-created. *Mutants: `updateItem` on
    mismatch; link to the merged loser.*
20. S3 org boundary: a run on Ian's org never writes a Padre Garcia record; a run on a second org with the PG map row
    writes only PG's. *Mutant: the role filter removed.*
20a. S3 audit and lock: one `master_data_load` audit row per applied entity carrying the snapshot sha and counts; two
    concurrent applies of the same fixture create each item once. *Mutants: no audit row; the advisory lock removed.*
21. S4 apply: one supplier with two links; the mirror supplier's `counterparty_store_id` set through
    `setSupplierCounterpartyStore` with an audit row, refused for another org's store; inactive v1 records end
    `inactive` through `setCustomerStatus` / `editSupplier`, each audited, and each refused without its capability;
    no AP or AR document rows; the output directory contains no full bank account number (scan every file).
    *Mutants: all bank accounts written to the sheet; the status writer unaudited.*
22. S5 apply: persons, employments, positions as planned; v1 staff codes kept, a taken code refused by the override
    with its `userReason`; a `new:` position created at that store only. For every imported person, the role and
    scope rows are **exactly** the baseline `createEmployment` writes (the `staff` role, the store scope, the
    position defaults), **no** manager, admin or super_admin row, and no credential or PIN (I9). An actor without
    `enrol_staff` at Malvar is refused **before any write** (the ✗ fires). *Mutants: an access row written for
    `Manager`; the authorize call removed; the override accepting a taken code.*
23. Drift: re-extract with a changed supplier contact and a renamed item; the re-run writes nothing to either and
    lists both. *Mutant: survivorship re-applied to linked rows.*
24. S6 readiness: a store with no POS link, no cash money account, no encoder, or the same person as encoder and
    verifier, is named with each reason; a ready store says ready. *Mutant: encoder = verifier allowed.*
25. Actor's org: `--org` of Ian's org with an actor of another org (and the reverse) is refused before any read of
    the sheets and before any write. *Mutant: the check removed (RLS alone would write under the actor's org).*
26. Dry-run dependencies: a fixture whose staff need a `new:` store position: the dry run plans and executes the
    position and the employments in one outer transaction (staff see the position), reports both, and leaves zero
    rows of either. *Mutant: one independent transaction per entity in dry run (staff then fail or are skipped).*
27. I8 on the droplet input: after `extract`, scan exactly the files the Rollout copies to the droplet (snapshot,
    sha, `stores.csv`, the filled non-HR sheets): no pay rate, no statutory id, no full bank number;
    `v1-staff-rates.local.csv` and a filled `staff-roster.csv` are not in that set. *Mutant: rates in the snapshot.*

## Smoke (§9.4)

1. Local, fixture: `make-test-dbs`, `bootstrap-org --store-code=SMK …`, then `run` on the fixture with
   `--stores SMK`: exit 2, every sheet written, `report.html` at 375 and 1366 px, light and dark. Fill the sheets
   from `packages/etl/tests/fixtures/t391-answers/`, `run` again: exit 0. `--apply`, then `--apply` again: the
   second writes nothing.
2. Local, real v1 (Ian's machine, read-only): `extract`, then a dry run against a local database: prints
   about 842 item records, about 385 names, 126 staff (the plan's numbers) and the size of every sheet. This is the
   first set of sheets Ian fills.
3. Production (operator with Ian): the Rollout below. **Unmet locally:** the droplet's file permissions and the
   `sudo -u shareat` run; the first production dry run is that check.

## Rollout (with Ian)

| When | Step |
|---|---|
| 13-14 Oct | S1-S3 merged and deployed; smoke 1-2. Ian fills `stores.csv` (Q1) and the item sheets from the local dry run |
| 15 Oct | S4-S5 merged. Copy `v1-snapshot.json` (+ `.sha256`), `stores.csv` and the filled sheets **except `staff-roster.csv`** to `/srv/shareat-shared/master-data/` (owner `shareat`, mode 0600). `v1-staff-rates.local.csv` never leaves Ian's machine. On the droplet: `sudo -u shareat env NODE_ENV=production npm run master-data -- run … --stores LIPA` (dry run). Copy the refreshed sheets back to Ian |
| 16 Oct | Ian finishes Lipa's held rows. Dry run again, then `--apply`. `readiness --stores LIPA`. **T-390 S4 can price Lipa from this point** |
| 17 Oct | Lipa's manager issues PINs; Ian grants the manager role from `access-to-grant.csv`; the encoder signs in |
| 19 Oct | Lipa double entry starts (row 303) |
| by 31 Oct | Re-extract, then the same for `--stores MLVR,BNBN,DVO` (codes per Q1). The droplet emits the roster skeleton; HR fills it locally, and `validate-hr` reports `N of 126 complete` for the 31 Oct checkpoint (row 302) |
| 2 Nov | All four double-enter |
| after T-398 | `--org <Padre Garcia org> --actor <a PG person> --stores <PG code>` |

After each apply, delete the snapshot and sheets from the droplet (they hold names). The local copies are Ian's.

## Out of scope

- Opening balances of any kind (T-390, wizard C5). Statutory id storage and pay rates (T-190, Q4).
- Roles above the hire's baseline, PINs, email credentials (screens; T-217, T-395 rollout). Store, money account
  and POS link creation (S6 reports what is missing; C8/T-396 links the POS).
- Supplier catalogue declarations (`supplier_items`), item prices and price lists, POS item maps.
- **v1 cost-basis links (`costBasisProductId`) and sliced-meat parent-slab links are not loaded.** A sliced item is
  imported as an ordinary item of its kind; `setCostBasisItem` and the slab link are set on the item screen. Listed
  in `report.html` so nothing is forgotten.
- Pre-filling the buying unit on the delivery and invoice forms. **Follow-up task, to be reserved by the
  orchestrator after T-389 S4** (which owns those forms this week). Until it ships, the buying unit is stored and
  read by T-390's count sheet hint and price list.
- The Padre Garcia organisation itself (T-398), and what a supplier mirror of a franchise store becomes.

## Done when

- S1-S6 merged; tests 1-27 (with 15a and 20a) green and every named mutant shown red. Typecheck clean; the full suite
  passes in CI on the wrap-up PR (a migration: bible row 296 exception, the full suite on a fresh gate DB).
- The migration is hand-authored, `v1_master_links` classified in `registry.ts` and `classification.ts`.
- Smoke 1-2 ran, with output and screenshots in the hand-back. Lipa's apply ran on production with Ian, its
  readiness report says ready, and the hand-back carries the counts (created, linked, held, listed per sheet).
- `FOR IAN` block: the open held rows by sheet; the HR sheet completeness; the stores still to run. The
  orchestrator updates plan row C3 and asks the Opus planner for the bible §13 row (R1, R2, R4-R8, R15, R16, S9,
  the buying unit and the link table), and confirms the T-390 lane reads `v1_master_links` in S4.

## Questions for Ian

**Q1. Which v2 store is each v1 store?** The load needs, for each of Lipa, Malvar, Banay-Banay and Davao, the store
code it has in v2 (`stores.csv`). Is there a commissary store in v2, and does any v1 store's data belong to it?
- **(a) The four operating stores map to their v2 stores; the commissary has no v1 data to load.** Recommended:
  v1's only commissary is `Test Commissary`, a test store (STORE-ROSTER).
- (b) A named v1 store feeds the commissary (tell us which).

**Q2. Items with no kind, or a kind v1 does not use (the sixth group, not covered by q5).**
- **(a) They go on a sheet with a blank `kind` column; you fill the ones you want; blank ones are not imported.**
  Recommended: it costs you one column, and nothing is guessed.
- (b) Not imported at all.

**Q3. Which staff are hired into v2?**
- **(a) Active staff only** (v1 says active and not resigned or terminated). Recommended: a person who left needs no
  sign-in, and v2 cannot hire someone as "resigned".
- (b) Everyone, the leavers hired and ended on their v1 end date.

**Q4. Pay rates.** v1 holds hourly or daily rates for most staff. They stay on your computer and fill the HR sheet
there.
- **(a) Load them at the 31 October checkpoint, together with the statutory ids, once it is known whether payroll
  runs on v2.** Recommended: if payroll stays on v1 (row 302), salaries in v2 are personal data with no use.
- (b) Load them now from the sheet.

**Q5. The HR sheet.** One CSV, one row per person, with columns for SSS, PhilHealth, Pag-IBIG, TIN, and the pay
rate to confirm (§Contract). Who fills it, and how does it come back?
- **(a) The load produces it pre-filled after Lipa's run; HR fills the four id columns in Excel on your computer; it
  is checked there and never goes to the server until T-190 loads it. Due 31 October.** Recommended: the names,
  stores and staff codes are already right, so HR types only the ids.
- (b) HR sends its own sheet, and we map its columns.

**Q6. Staff codes.** v1 numbers staff `SE-001`, `SE-002`, … per store. v2 numbers its own the same way, so during the
dual run Lipa could have two different people called `SE-014`, one in each system.
- **(a) Keep each person's v1 code in v2; new hires continue after the highest.** Recommended: one code per person in
  both systems, which is what the encoder and the payroll bridge read. A v1 code that is blank or used twice at a
  store gets a new one, and is listed for you.
- (b) Let v2 number everyone afresh.

**Q7. Suppliers and customers marked inactive in v1.**
- **(a) Import them as inactive.** Recommended: they cannot be picked on any form, and the dual-run comparison can
  still match an old v1 invoice to its supplier.
- (b) Leave them out.
