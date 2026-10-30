# T-398 S7 refresh — onboarding Padre Garcia, against `origin/main` `b3ace76` (2026-10-29)

Binding sources: spec §0b (Q1 a, Q3 a, Q4 a, Q7 a, Q10 a, Q11 b), §3 S7, B1, B4, B10, B11, B12, C5; S5 refresh (shipments,
`supplier_items` mapping on receipt), S6 refresh (`franchise_agreements` written by S7 as owner, K10/K11; DEF-747
fenced out of S6); bible rows 305, 340, 360, 362, 369, 380, 381. **New from Ian, 29 Oct:** (1) S7 is built and rehearsed
on **mock data now**; the real data (K4: second sign-in email, owner and staff names, POS store id, codes) is swapped in
later **by a data file, never hard-coded**; (2) **Padre Garcia (PG) opens on 16 Nov 2026**; (3) **Q3 confirmed: PG does
not trade in v1**, so there is no v1 history to import. Where this file and the spec disagree, §2 says why.
**Depends on:** S5 (on main, 0218) and **S6 merged** (0220, `franchise_agreements`, on `lane/t398-s6` today).
**Migration:** **one, `0223`**, only for the DEF-747 definer (§9). Onboarding itself needs none.

## 1. What S7 is, in plain terms

- **One command sets up Padre Garcia as its own company in v2.** It reads everything it needs from **one data file**
  (company name and code, the store, the owner, the staff, Ian's separate PG login, the POS store id). It first shows
  what it would create and writes nothing; it writes only when re-run with `--confirm`. Run twice, it does nothing the
  second time.
- It creates: PG's company with its own chart of accounts, months and the six standard positions; Ian's PG person
  (admin, the second email, every use logged by S6); the owner (manager); the staff (badge numbers issued
  automatically); the store and its room; the **franchise agreement** row S6 reads; on Ian's side the customer "Padre
  Garcia" with its franchise price list filled from today's branch prices; on PG's side the supplier "SharEat
  Commissary" and **a PG item for every item the commissary sells to PG**, so PG can receive its first delivery.
- After it: PG's own master data from v1 (if any) loads through T-391's existing command; PG's clock terminal is
  provisioned; PG's POS store is linked on the existing screen.
- It proves every nightly job runs per company, and that the 1 Jan purge and opening work with two companies.
- It closes **DEF-747**: only an admin of a company that has a franchise agreement with the other may link a customer
  to it, and the picker lists only those companies.
- Today it all runs on a **MOCK** file. On production day Ian points the same command at the real file, which never
  enters git.

## 2. Corrections to the spec, measured on main today

| # | Spec says | Main says | Effect |
|---|---|---|---|
| K1 | S7 "blocked by K4's data" (Status, §3 S7) | Ian 29 Oct: build and rehearse on mock data now | Inputs are a **data file** (§4); a MOCK file is committed; real file never in git (row 380: the repo is public, and names/emails are personal data) |
| K2 | B1: PG's items, suppliers, customers and staff come from T-391's `master-data run` | Q3 confirmed: PG never traded in v1. v1 does hold some PG item records (`packages/etl/tests/fixtures/t391-v1-snapshot.json` has PG-store items; T-391 test "Padre Garcia (pcs) is not counted"), but how many on production is unmeasured. S5's receipt maps each line to **a PG item declared for the commissary supplier** (`repo/inter-entity.ts:290` `declaredItemsOf` reads `supplier_items`); with none, PG cannot receive | Onboarding **creates PG's items from the franchise price list** (name + base unit, no cost) and declares them on PG's commissary supplier (§5 step 9). T-391's load runs **after** and links by exact name (its I-i rule). Staff come from the data file, not v1 (§5 step 6) |
| K3 | S7 writes the agreement (S6 K10) | `franchise_agreements` exists only on `lane/t398-s6` (0220); `shareat_app` has SELECT only | S7 starts after S6 merges; the insert runs inside the onboarding's owner (`systemTransaction`) write. `tests/unit/system-transaction-callers.test.ts` admits exactly that call site |
| K4 | PG-side supplier "with `counterparty_org_id`" | No domain or screen writer sets `suppliers.counterparty_org_id` on main (only S5's tests seed it; readers at `repo/inter-entity.ts:270,477,527`) | Onboarding is its only writer (owner write). No screen gains one in S7 |
| K5 | DEF-747 owner "T-398 S5c/S5d" (register :988); S6 refresh §7 fences it out as "its own task" | Nobody owns it. `createCustomer` (`packages/domain/src/customers/index.ts:72-95`) checks only "not both links" and "not this org"; `customersRepo.otherOrgs` (`repo/customers.ts:396`) returns nothing under RLS | **S7 takes it** (onboarding is where links are made; §9), slice S7d, migration 0223 |
| K6 | B11 allow-list: `dual-run`, `db-backup`, `restore-drill` | `docs/ops/*.service` on main has **16** `ExecStart`s; **no dual-run service exists**; two are `npm run start` (`shareat-erp`, `shareat-pos`). The 13 job scripts all take `--org` or loop orgs, but `pos-day-import`, `pos-receipt-bridge`, `usage-auto-post` reach the org loop **inside** their domain sweep, not in the script | O7 scans each script **and follows into the sweep function** it calls; allow-list = `db-backup`, `restore-drill`, `start` (×2), each with its reason; `dual-run` removed from the list |
| K7 | Deadline 4 Dec; PG trades on v2 from 1 Jan; B4 purges PG's December rows | PG **opens 16 Nov** (Ian, 29 Oct) | If PG keeps real books on v2 from 16 Nov, B4's purge would **delete them** on 1 Jan, and the commissary (Ian's org, still on v1) cannot send a real two-sided shipment before 1 Jan anyway. Ian decides (Q-S7-1); this refresh builds for the recommended (c) and names what (a) would add |
| K8 | `provision-terminal --org` "does not exist yet" (B12) | Still true: `scripts/provision-terminal.ts:105-110` looks up by code alone | B12 stands (O10) |
| K9 | Q11 (b) "a new task, needed before 1 Jan" (row 369) | No task file for PG HR exists on main (`grep -l "row 369" docs/tasks` → only the T-398 spec) | Not S7. Orchestrator must reserve it now; S7's data file carries what that task will need (staff, positions) but S7 seeds **no** statutory rates and no leave approver |
| K10 | Size M 1.5 | + data file and guards, PG item seeding (K2), DEF-747 (K5), O7 depth (K6), rehearsal recipe | ≈ **5.0** lane-days (§11) |
| K11 | `onboard-franchise --code <C>` must equal `stores.csv`'s PG `org_code` (today placeholder `PADRE_GARCIA`) | `assertRunTarget` (`packages/etl/src/master-data/store-map.ts:87`) enforces it at load time only | The CLI also checks it **before** writing (O14) when `--map` is given, so a mismatch is found before the company exists |

## 3. Migration need

**One: `0223_t398_s7_linkable_orgs.sql`** (next free after S6's 0220 and the two numbers held by other lanes; the
orchestrator confirms at merge). Hand-authored (ADR-012 §5): journal `when` = previous entry's + 86 400 000 per gap.
Contents: **only** the definer function of §9 (`linkable_counterparty_orgs()`), `SECURITY DEFINER`,
`SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO shareat_app`. No table, no
policy change, no live table touched (no lock budget). `docs/ops/README.md` row: "no precheck: one function".
If the orchestrator prefers no migration: the picker may call S6's `franchise_franchisees()` instead, at the cost that
the person linking must also hold `view_franchise_sales` (super-admin only). Recommended: the migration.

## 4. Inputs: the onboarding data file

- **Real file:** on Ian's PC or `/srv/shareat-shared/onboarding/padre-garcia.json` (owner `shareat`, mode 0600).
  Never in the repo, never pasted in chat.
- **Mock file (committed):** `scripts/fixtures/onboarding/MOCK-padre-garcia.onboarding.json`. Every name starts with
  `Mock`, every email ends `@example.test`, POS id `MOCK-POS-STORE-0001`, org code `MOCK_PG`, `"mock": true`.
- **Shape** (validated by a zod schema in `packages/domain/src/organizations/onboarding-file.ts`; unknown keys refused):

```json
{
  "mock": true,
  "franchisorOrgCode": "shareat",
  "org":   { "code": "MOCK_PG", "name": "Mock Padre Garcia Foods" },
  "store": { "code": "MPG", "name": "Mock SharEat Padre Garcia", "v1StoreId": "y1DMgfisuTHBF57cNL6i", "posStoreId": "MOCK-POS-STORE-0001" },
  "franchisorPerson": { "last": "Mock", "first": "Franchisor", "middle": null, "email": "franchisor.pg@example.test" },
  "owner":  { "last": "Mock", "first": "Owner", "middle": null, "email": "owner.pg@example.test" },
  "staff":  [ { "last": "Mock", "first": "Cook", "middle": null, "position": "Kitchen Staff" } ],
  "agreement": { "salesVisibleFrom": "2027-01-01" },
  "commissary": { "customerName": "SharEat Padre Garcia", "supplierName": "SharEat Commissary",
                  "creditLimit": null, "creditTermsDays": null, "priceListName": "Padre Garcia franchise prices" }
}
```

- **Refused fields (allow-list, not deny-list):** anything not in the schema, so a PIN, password, bank number, TIN,
  SSS/PhilHealth/Pag-IBIG number or pay rate can never ride in. PINs are set through the existing enrolment flow.
- `positions` must be one of the six row-362 names; `customerName`/`supplierName` must equal v1's PG AR customer and
  commissary-mirror supplier names (B1 step 3) so T-391 links rather than duplicates.
- **Guards:** (1) a file with `"mock": true` is refused against production (`NODE_ENV=production` **or** the database
  host equals the production host in `SYSTEM_DATABASE_URL`); (2) a non-mock file whose path is inside the repo is
  refused (T-391's `assertSheetsOutsideRepo` precedent, `packages/etl/src/master-data/sheets.ts:4`); (3) with
  `--map stores.csv`, `org.code`/`store.code` must equal the PG row's `org_code`/`store_code` and `store.v1StoreId`
  must be that row's id (K11).

## 5. The onboarding CLI

`npm run onboard-franchise -- --file <path> [--map <stores.csv>] --by <Ian's person id in his org>` prints the plan;
the same with `--confirm` writes it. New `scripts/onboard-franchise.ts` + `packages/domain/src/organizations/index.ts`
`onboardFranchiseOrganization(input, { dryRun })`. The `--by` person must be a super-admin-capability holder of the
franchisor org (`createFirstAdmin`'s grants; S6 K1) and is the audit actor on Ian's side.

Order, **one transaction for the PG half (steps 1-7) and one for Ian's side and the links (steps 8-10)**; a failure in
the second leaves PG's company in place and a re-run completes it (O2/O4):
1. Refuse if `org.code` exists with a different name; no-op naming it if it exists with the same name and all of
   steps 2-10 already hold (O2).
2. `createOrganization` (chart, categories, periods via `fiscalPeriodSeedWindow`); the six positions by their row-362
   names.
3. Ian's PG person: `createFirstAdmin` with the second email and last/first/middle parts (row 360, B10).
4. The store + its default room + store scope for that admin.
5. The owner: person with an **org-wide `manager` role and no employment row** (row 340, O5).
6. Staff: `createPerson` + `createEmployment` at PG's store, `staff_code` issued automatically (row 381); position
   from the file.
7. `franchise_agreements` row: franchisee = PG, franchisor = `franchisorOrgCode`'s org, `franchisor_person_id` = step
   3, `sales_visible_from` from the file.
8. **Ian's side:** customer `commissary.customerName` with `counterparty_org_id` = PG (derives `inter_entity`), price
   list `priceListName` filled per commissary-offered item from `branchPriceFor` at this moment (C5, O11); credit
   limit and terms if given (null = not set; Q7's figures are data).
9. **PG's side:** supplier `commissary.supplierName` with `counterparty_org_id` = Ian's org (K4); for every item on
   that price list, a PG item (same name, same base unit, kind copied, **no cost, no price**) unless an active PG item
   with that name exists, plus a `supplier_items` row declaring it for that supplier (K2, O17).
10. Print: company id, store id, the two person ids, counts (staff, items mirrored, price-list lines and their total),
    and the next three commands (T-391 dry run, `provision-terminal --org`, POS link screen).

Dry run prints the same plan with "(dry run: nothing written)" and exits 0 having opened no write transaction (O3).

## 6. Master data, POS link, clock terminal

- **T-391 load into PG (B1 steps 2-3), after onboarding:** `npm run master-data -- run --snapshot … --map … --org <PG
  uuid> --org-code <PG code> --stores <PG store code> --actor <Ian's PG person>` dry run, then `--apply`. Expected:
  items that match a mirrored name link (I-i); a unit clash is held for Ian; 0 new suppliers named like the commissary,
  0 new customers named like PG (O8). If the dry run plans nothing, the apply is skipped and the runbook says so.
- **POS link:** PG's POS v1 store id goes into the v2 POS key map (`docs/ops/pos-v1-key.md` steps; Ian's action) and is
  linked on `/settings/pos-link` **inside PG's company** by its admin. The link is made on **the day PG starts on v2**
  (1 Jan under Q-S7-1 (c)), because the morning import drafts up to 7 days back but never before the link date; an
  earlier link would pull Nov-Dec PG sales into v2. O6 proves a second link of the same POS id is refused.
- **Clock terminal:** `scripts/provision-terminal.ts --org <PG uuid> --store <code>` (B12, O10). PIN set by each
  person through the existing flow.

## 7. Multi-org job checks (B11, O7)

New `tests/unit/t398-s7-multi-org-jobs.test.ts`: for every `ExecStart` in `docs/ops/*.service`, resolve the npm script
to its `scripts/*.ts` file and then to the domain function it calls; pass when that function reaches `listOrgsToRun`
(`packages/domain/src/scheduler/index.ts:222`) or a `*Sweep({ orgId })` that does; else fail unless on the pinned
allow-list: `db-backup` (whole database by design), `restore-drill` (same), `start` ×2 (the web servers). The 06:30
`inter-entity-reconcile` is in the scanned set. A new `.service` added later without either is a build failure.
Plus one integration leg (O7b): `posDayImportSweep` and `usageAutoPostSweep` with two orgs each run both and write
`scheduler_runs` rows under each org's principal.

## 8. Purge and opening with two companies (B4, O9) — runbook

Under Q-S7-1 (c) (recommended) B4 stands: everything PG has in v2 before 1 Jan is rehearsal data. `docs/ops/
cutover-runbook.md` §3 gains: `npm run cutover:purge -- … --apply --by <Ian's org performer> --by <Ian's PG person>`
(the script maps each person to its org, `scripts/cutover-purge.ts:198-222`; apply refuses with either missing,
`packages/db/src/cutover/purge.ts:514-535`); then PG's opening per org: its 31 Dec count, cash, and **what it owes the
commissary**, which must equal Ian's opening receivable from PG (both come from the commissary's v1 balance for PG,
Q-S7-2); 3900 = 0 checked per org. ⛔ No real inter-entity trade on production before 1 Jan except on a rehearsal copy.
Under (a) S7 would also need a **keep-org** purge mode (`--keep-org <PG>`, refusing when a kept org's rows point at a
purged org's rows) and the receipts of Nov-Dec entered as plain supplier deliveries: +1.5 lane-days in the cutover
tooling in the go/no-go week, and S7 on production by 13 Nov. Not built unless Ian picks (a).

## 9. DEF-747 — who may link a customer to another company

- **Rule (Q-S7-3 recommended a):** a customer may point at another company only when a `franchise_agreements` row links
  the two companies (either direction), and only by a person holding `manage_chart_of_accounts` (unchanged). Anything
  else is refused in words: "You can only link a customer to a company you have a franchise agreement with."
- `createCustomer` (and any edit that sets `counterpartyOrgId`) checks the agreement with a plain SELECT under the
  caller's principal (the agreements' dual policy lets either side read it), before any write.
- Picker: migration 0223's `linkable_counterparty_orgs()` returns `(org_id, name, code)` for orgs that share an
  agreement with `app_current_org()`, never the caller's own org, nothing when `app_current_org()` is null; not
  logged (no business figures). `apps/erp/src/app/customers/lib.ts:209` `otherOrgs` calls it; `repo/customers.ts:396`
  `otherOrgs` is replaced by a repo call to the function. Supplier side: no screen sets a supplier's org link, so
  nothing to fix there (K4).
- Register: DEF-747 → fixed citing the S7d commit (orchestrator).

## 10. Two-company rehearsal data

`scripts/fixtures/onboarding/MOCK-padre-garcia.onboarding.json` + a recipe in `docs/ops/README.md` ("Onboarding a
franchise"), used for the §9.4 smoke and the 18 Dec rehearsal until the real file exists: fresh copy → onboard mock →
T-391 dry run on `packages/etl/tests/fixtures/t391-v1-snapshot.json` for the PG store → one commissary dispatch →
PG receives it (mirrored items appear in the receipt form with no hand setup) → Ian opens S6's sales and stock pages
→ PG's manager opens the access log → two-performer purge → an opening per org → 3900 = 0 in each. Screenshots of
each, plus `select org_id, count(*) from journal_lines group by 1`.

## 11. Tests (tester first; each names the mutant it kills)

| Id | Case | Expect | Mutant |
|---|---|---|---|
| O1 | Onboard mock on a DB with Ian's org | PG org, chart, periods, six row-362 positions; Ian's PG person admin with name parts; owner manager org-wide, no employment; staff with auto codes; store + room; agreement; Ian-side customer `inter_entity` + price list; PG supplier with org link | Any one step skipped (one assertion per object) |
| O2 | Run twice | Second prints "already onboarded: <code>", writes nothing (row counts equal) | Idempotency check on name only, so a second org with a new id |
| O3 | No `--confirm` | Prints the plan; zero rows written; no write transaction opened | Dry run that writes then rolls back the org but not the audit row |
| O4 | Fault injected after the org insert (PG half) | Nothing of PG remains | Org insert in its own transaction |
| O5 | PG's owner signs in | Sees PG's store only; every Ian-org route not-found under PG's principal | Owner given an employment row / Ian-org scope |
| O6 | Link PG's POS id when another org has it | Refused "already linked elsewhere", no other org's name | Refusal text interpolating the other org |
| O7 | Job scan (§7) | Every service reaches the org loop or the allow-list with a reason | Scan of the script file only (would pass `usage-auto-post` without following it) |
| O7b | Two orgs, `posDayImportSweep`, `usageAutoPostSweep` | Both orgs run, each under its own principal | Sweep reading the first org only |
| O8 | T-391 PG dry run after onboarding | 0 new commissary-named suppliers, 0 new PG-named customers; mirrored names link; `--org-code` mismatch refused | Onboarding names that differ from v1's |
| O9 | Two-org purge on a scratch DB | Apply refuses with either `--by` missing; after purge + openings, 3900 = 0 in each org | Purge loop over the first org only |
| O10 | `provision-terminal` with a code in both orgs | Without `--org`: refused naming the ambiguity; with `--org <PG>`: PG's store only | `limit 1` kept without `--org` |
| O11 | Price list after onboarding; then the branch price changes | One line per commissary-offered item equal to the branch price at onboarding; later change does not move it | Price list reading the live branch price |
| O12 | Mock file against production | Refused before any connection write | Guard on `NODE_ENV` only (fails when the host is production but `NODE_ENV` is unset) |
| O13 | File with an extra field (`pin`, `tin`, `bankAccount`) | Refused naming the field | Deny-list missing one name |
| O14 | `--map` whose PG `org_code` differs from the file | Refused before writing | Check only at T-391 time |
| O15 | DEF-747: `createCustomer` with an org that has no agreement | Refused in words, nothing written; with an agreement: created | Check that the org merely exists |
| O16 | `linkable_counterparty_orgs()` with a third org seeded | Returns only agreement-linked orgs; never self; empty with no org principal | Agreement join dropped |
| O17 | After onboarding, a mock shipment | Receipt form offers the mirrored PG items for every line; receive succeeds with no hand-made item | Items created but no `supplier_items` row |
| O18 | Staff codes | Each staff has a distinct `SE-NNN` code at PG's store; none taken from the file | Code from the file |
| O19 | Agreement write | Present after onboarding; the app role cannot insert one (S6's grant unchanged) | Agreement written through `shareat_app` with a widened grant |

Guards that stay green and are re-ruled to admit exactly the new call sites: `tests/unit/organization-insert-callers.test.ts`,
`tests/unit/system-transaction-callers.test.ts`; plus `migration-journal`, `rls-registry`, `cutover-classification`,
the S1 same-org FK census, S5's G1c/X1 and S6's legs.

## 12. Fences — S7 must NOT

- Commit any real PG data (names, emails, POS id, codes) or read the real file in a test.
- Seed statutory rates, withholding brackets or a leave approver for PG (the PG HR task, row 369, K9).
- Edit `scripts/import-items.ts` (B1), `bootstrapOrganization` or `/setup`, S5's or S6's definers and tables, any RLS
  policy, or POSTING-PATTERNS.
- Post an inter-entity trade on production before 1 Jan, or link PG's POS store before PG's first v2 day.
- Build the keep-org purge mode unless Ian picks Q-S7-1 (a).
- Write the bible or the register (orchestrator).

## 13. Slices (each ≤ 1 day; done-when = its legs red→green, named guards green, typecheck 0)

| Slice | What | Size | Needs | Parallel with |
|---|---|---|---|---|
| **S7a** | Data-file schema + parser + guards (O12-O14) + MOCK file | 0.5 | S6 merged | — |
| **S7b** | `onboardFranchiseOrganization` PG half (steps 1-7) + CLI dry run/confirm (O1 PG part, O2-O5, O18, O19) | 1.0 | S7a | S7d, S7e |
| **S7c** | Ian side + links + PG item mirror (steps 8-10; O1 rest, O8, O11, O17) | 1.0 | S7b | S7f |
| **S7d** | DEF-747: migration 0223, `createCustomer` check, picker (O15, O16) | 0.75 | S6 merged | S7b, S7e |
| **S7e** | `provision-terminal --org` (O10), POS link refusal (O6), job scan (O7, O7b) | 0.5 | — | S7b, S7d |
| **S7f** | Purge/opening runbook + O9 + `docs/ops/README.md` onboarding section and rehearsal recipe | 0.75 | S7b | S7c |
| **S7g** | §9.4 smoke on a fresh copy with the MOCK file (§10); full suite in CI on the PR; auditor mutant table | 0.5 | all | — |

Total ≈ **5.0** lane-days. One PR (it carries 0223). Real-data production run (Ian present): after Q-S7-1 and K4's
data, before 4 Dec under (c).

## 14. Questions for Ian (plain words)

**Q-S7-1. Padre Garcia opens on 16 Nov. Where does it keep its books from 16 Nov to 31 Dec?** *(blocks the production
date, not the build)*
- (a) **On v2 for real from 16 Nov.** Needs S7 live by 13 Nov (the rehearsal and go/no-go week), a new "keep PG" mode
  in the 1 Jan clean-up so its real records are not wiped, and its deliveries from the commissary typed as ordinary
  supplier deliveries until 1 Jan (your company is still on v1 then). About 1.5 extra days of risky work on the
  cutover tools.
- (b) **On v1 from 16 Nov, then v2 from 1 Jan.** Undoes "PG does not trade in v1": PG's people learn v1 for six weeks,
  then v2.
- (c) **Selling on POS v1 from 16 Nov; its purchases and expenses on paper until 1 Jan; v2 from 1 Jan**, opening from
  its 31 Dec stock count, its cash and what it owes the commissary. Its staff attendance and pay move to v2 on 1 Jan
  as already ruled (row 369).

**Recommended: (c).** The commissary's real "both books" sale only works once your company is on v2 (1 Jan), so (a)
adds risk in the busiest week for little gain. (c) changes nothing in the cutover plan and keeps PG out of v1.

**Q-S7-2. Between 16 Nov and 31 Dec, how is the commissary's sale to PG recorded in v1?** *(only under b or c)*
- (a) The commissary finishes each PG order itself in v1. (v1 has a settle step, `settleBranchSaleAction`; whether
  it works without the branch clicking "received" is **not yet checked**, a read-only look in v1 before 16 Nov.)
- (b) Someone at PG confirms each delivery in v1.

**Recommended: (a)**, so PG never touches v1. What PG still owes on 31 Dec becomes both your opening "PG owes us" and
PG's opening "we owe the commissary", and the two must match.

**Q-S7-3. Who may link a customer to another company?** (DEF-747)
- (a) Only an admin, and only to a company you have a franchise agreement with. The list shows only those companies.
- (b) Any admin, to any company (what the code allows today).

**Recommended: (a).** Today an admin who knows another company's id could link to it and see its name.

**Q-S7-4. PG's item list on day one.**
- (a) Setup copies every item the commissary sells to PG into PG's own list (name and unit only), so its first
  delivery can be received at once. PG adds its other items later.
- (b) PG's owner types its items by hand before the first delivery.

**Recommended: (a).** Without it, PG's first delivery cannot be received until someone builds the list.

**Data still needed later (no decision, swapped in by the file):** the second sign-in email for your PG login; the
owner's and staff names and positions; PG's POS store id (recorded: `g2CVxzCKVRE7e0cczU0t`, `docs/ops/pos-v1-key.md`);
PG's company code and store code (must match `stores.csv`); the credit limit and payment days (Q7); the date your
sales view starts. Under (c), needed by 27 Nov for a 4 Dec production run.

**For the orchestrator:** reserve the PG HR task now (row 369: PG's government rates and the approver for its
manager's own leave, needed before 1 Jan). No task file exists on main.

## 15. Ian's answers (2026-10-29, orchestrator session) — these bind
- **Q-S7-1 = (c).** PG sells on POS v1 from 16 Nov; purchases and expenses on paper until 1 Jan; v2 from 1 Jan, opening
  from its 31 Dec count, cash and what it owes the commissary. No "keep PG" purge mode is built.
- **Q-S7-2 = (a).** Lipa (the commissary) records each PG order in v1 itself; PG never touches v1. The read-only v1
  check of `settleBranchSaleAction` without "received" is still owed before 16 Nov (Haiku, read-only).
- **Q-S7-3 = (a).** Linking a customer to another company: admin only, only to a company with a franchise agreement;
  the picker lists only those (S7d as specified).
- **Q-S7-4 = (a).** Onboarding copies every commissary-sold item to PG (name and unit only) and declares them on PG's
  commissary supplier (§5 step 9).
- Build on the **MOCK** data file now (Ian, 29 Oct); real data swapped in by file before the production run.
- Orchestrator rulings (29 Oct, S7b build): PG's owner also gets PG **store scope** (source `manual`) so the org-wide
  manager can act on the store; staff from the file are hired as **probationary** (a new store's new hires). Audit
  action `onboard.franchise`. `onboard-franchise.ts` is an admitted `systemTransaction` caller.
