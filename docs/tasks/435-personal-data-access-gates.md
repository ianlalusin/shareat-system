# T-435: personal-data access gates (payroll, customers, staff, trade)

**Status:** DONE 2026-10-17 — merged to main; in release PR #34 (not yet live).
Opus review; Ian answered Q1-Q3. Ships with the next normal release (not a hotfix).
**Model:** Sonnet tester first (commits red), then Sonnet builder, per slice (bible row 184). Auth path: Sonnet, not Haiku.
**Migration:** NO. No new capability: every gate reuses one already in `CAPABILITY-MATRIX.md` and already seeded.
**Order:** S1 payroll (HIGH), S2 customers, S3 staff, S4 trade (S4 after T-433 S3 merges: same two files).
**Closes:** DEF-665, DEF-666, DEF-667. Governed by bible row 353 and T-288 (read gates).

## Goal (plain words)
Today a cashier signed in to the ERP can open the customer list (phone numbers, balances, credit limits) and the
staff roster, and a payroll admin of one branch can type another branch's id into the address bar and read its pay
rates and payslips. Ian's rule (row 353): personal data is shown only to people whose job needs it, only for their
own stores, and the check lives where the data is READ, not only in the menu.

## Diagnosis (verified at `8d9d9d5`)
- **Payroll.** `payroll/page.tsx:48` `requirePageAccess('/payroll')` passes on `run_payroll` held at ANY store
  (`heldCapabilities` is store-blind); `:53` then trusts `sp.store`; `:76-82` `rosterFor`/`runsFor`/`cashAccountsFor`
  and `:82` `slipsFor` are bare repo reads (`payroll/lib.ts:36-55`; `rosterFor` `:44-55` returns every rate). Only
  `preview` authorizes (domain `previewPayRun`, `packages/domain/src/payroll/index.ts:155`). Same shape:
  `thirteenth-month/page.tsx:38` (store), `:52` `runsFor`, `:57` `payoutsFor`; `separations/page.tsx:48` (store),
  `:59-61` `worklistFor`/`cashAccountsFor`/`separationsFor`.
- **Customers.** `customers/page.tsx:35` and `customers/[customerId]/page.tsx:84` call only `requireSession`;
  `/customers` is absent from `lib/route-capability.ts:41-90`; `customers/lib.ts:30` `listRegister` reads every
  customer and an org-wide balance. The detail page `:90-112` reads position, store credit, charges and collections
  for ALL stores; its store dropdown `:93` (`storesWithOpenItems`) names every store with open items and `:101-104`
  accepts any of them from `?store=`. Customers are org master data (no `store_id`, ADR-008); AR is per store.
- **Staff.** `staff/page.tsx:33` `requireSession` only; `:35` accepts any org store from `?store=`; `:46-49`
  `rosterForStore`. `staff/lib.ts:5` says *"the gate belongs to the WRITE, not to looking at a roster"*, overturned by
  T-288 (`route-capability.ts:4-8`, Ian 2026-09-12) and now row 353. `staff/lib.ts:31` `rosterForStore`, `:53`
  `employmentDetail`, `:83` `livePinFor`, `otherOpenBranchesFor` are ungated; `staff/[employmentId]/page.tsx:29-40`
  renders them for any session. `staff/hire/page.tsx:35` and `staff/[employmentId]/credentials/page.tsx:50-61`
  (person name read before the gated `listCredentials`) likewise. `searchPersons`
  (`packages/domain/src/people/index.ts:258-280`) passes on `enrol_staff` at ANY one store, then returns persons
  org-wide (`personsRepo.searchPersons`, `repo/persons.ts:116`).
- **Trade.** `trade/orders/page.tsx:23-25` `requireSession`, then any org store from `?store=`. `[id]/page.tsx:49`
  `requireSession` only; `:112-114` prints `customer.creditLimit`. `trade/orders/lib.ts:96` sends every active
  customer's `creditLimit` to the client, where nothing reads it (`NewOrderForm.tsx` has no `creditLimit`).
- **No admin bypass.** `authorize()` needs a store-scope row even for admins; rows are fanned out on store create
  (`packages/domain/src/stores/service.ts:198`), and an admin appointed while a store was inactive has none for it.
- **Exports:** none. No CSV, print or `route.ts` under `payroll/`, `customers/`, `staff/`, `trade/orders/` today.

## Design
1. **Reuse `reportScope`'s store rule, do not invent one.** Extract the store-list half of `reports/lib.ts:73-114`
   into `scopedStores(tx, actor, { includeRetired })` in the same file: active stores (DEF-200), all of them if
   `personCoversWholeOrg`, else the actor's scope rows. `reportScope` calls it unchanged (no report behaviour moves).
   T-435 pages call `scopedStores`, then keep the stores where `can(tx, actor, CAP, { storeId })` passes for ANY of the
   page's capabilities. Why not `reportScope` itself: it authorizes ONE capability and throws (a 500 for a refused
   page, DEF-189), and it silently falls back on a forged store, where this task shows a sentence.
2. **Retired stores.** Payroll and separations pass `includeRetired: true`: retired stores are added only where the
   actor has a scope row (so `authorize` passes); final pay at a closed branch stays reachable for its admins. An admin
   with no row for a retired store does not see it (no bypass) — named in Done-when.
3. **The refusal.** Add `<StoreNotAvailable/>` to `lib/page-access.tsx`: the fixed sentence **"This store is not
   available to you."** and nothing else. A requested store not in the held list renders it; no request falls back to
   the first held store; an empty held list renders the existing access refusal.
4. **Two layers, both real** (bible §15.11). Every loader that returns personal data takes the full `Actor` (not
   `orgId`) and calls `authorize(tx, actor, CAP, { storeId })` first; a by-id loader (payslips, employment, customer)
   authorizes on the ROW's store. By-id pages show the same `notFound()` for out-of-scope and forged ids (DEF-497).
   Any `cache()`-wrapped helper keys on actor AND capability, never on actor alone.
5. **Route map** (`lib/route-capability.ts`). Widen the value to `Capability | readonly Capability[] | null`:
   an array means ANY-OF; `null` means OPEN. `capabilityForRoute` returns `readonly Capability[] | null` (longest
   prefix still wins, so a longer `null` key re-opens a sub-route). `navHrefAllowed` and `requirePageAccess` (`:44`)
   pass if any is held; `AccessRefused` names them joined by " or ". Entries:
   `'/customers': 'record_ar_collection'`, `'/customers/price-lists': null` (Ian Q3: price lists stay open),
   `'/staff': ['enrol_staff', 'manage_attendance']` (Ian Q2), `'/staff/hire': 'enrol_staff'`.
6. **Capabilities** (all in the matrix, all store-scoped): payroll `run_payroll` (:148, admin-only); customers
   `record_ar_collection` (:109; no read capability is needed, everyone with a reason to see a B2B customer collects
   from them); staff roster and employment pages `enrol_staff` OR `manage_attendance`; hire and person search
   `enrol_staff`; trade register: the viewer's scoped stores (the domain gates on dispatch are unchanged).
7. **Customer scope (Ian Q1: no cross-branch customers).** A viewer sees a customer if it has any AR row at a held
   store, or its `counterpartyStoreId` is a held store, or it has no AR rows anywhere. Balances, "owes", store credit,
   charges, collections, receipt links and the store dropdown cover held stores only. ⭐ **The over-limit FLAG stays
   org-wide** (a credit limit is extended to the buyer, `recordCharge` judges it org-wide): compute the org-wide
   position server-side, render only "over limit", never the org-wide figure or another store's amount. Repo additions
   in `customers.ts`/`ar.ts` take `storeIds: string[]`.
8. **Staff.** `otherOpenBranchesFor` names only branches the viewer holds; others render as "and N other
   branch(es)" so the T-302 PIN warning still fires. `searchPersons` returns all matches if the actor covers the whole
   org, else only persons with an employment (any status) at a held `enrol_staff` store or with no employment at all.
   Rewrite the `staff/lib.ts:1-9` and `:70-73` comments to cite T-288 and row 353.
9. **Trade.** Drop `creditLimit` from `orderFormData` entirely. The order page shows the limit only if
   `can(approve_buyer)` or `can(override_credit_limit)` at the order's store. `/trade/orders` uses held stores.

## Fixture (shared)
Stores S1, S2 (plus S3 retired, for case 10). **A** admin, all stores. **P1** admin with scope rows for {S1} only:
both "another store's payroll admin" and "an admin missing a scope row". **M1** manager at S1, **M2** at S2, **T1**
holds only `manage_attendance` at S1. **C** staff (cashier) at S1. Employees E1 (S1, rate 650), E2 (S2, rate 720,
phone set), a posted pay run at each store; E3 separated at S3. Customers X (charges only at S2), Y (owes 1,000.00 at
S1 and 9,500.00 at S2, limit 10,000.00, phone set), Z (no AR rows). Person Q employed only at S2.
"Sees nothing" = the HTML or loader result holds none of the out-of-scope names, phones, rates, amounts or limits.

## Cases (each names its mutant M#)
**S1 Payroll**
1. C and M1 open `/payroll`, `/payroll/thirteenth-month`, `/payroll/separations` -> access refusal, sees nothing. M1: delete the `/payroll` entry.
2. P1 `/payroll`: picker lists S1 only; E1 and 650 render; E2/720/S2 absent. M2: use `listStores` instead of `scopedStores`.
3. P1 `/payroll?store=<S2>` -> "This store is not available to you."; sees nothing of S2. M3: page trusts `sp.store`.
4. `rosterFor(P1, S2)` throws the `run_payroll` refusal. M4: remove the loader `authorize`.
5. `runsFor`, `cashAccountsFor`, `premiumSettingsFor(P1, S2)` each throw. M5: remove the authorize in `runsFor`.
6. `slipsFor(P1, <S2 run id>)` throws (authorized on the run's own store). M6: authorize on a caller-supplied store.
7. `/payroll/thirteenth-month?store=<S2>` -> not available; `runsFor`/`payoutsFor(P1, S2 run)` throw. M7: drop that loader gate.
8. `/payroll/separations?store=<S2>` -> not available; `worklistFor`/`separationsFor(P1, S2)` throw. M8: drop that loader gate.
9. A sees S1 and S2; E2 and 720 render under S2. M9: held list cut to the first store.
10. A (scope row at retired S3) opens separations for S3 and sees E3; P1 (no S3 row) is not offered S3 and `?store=<S3>` is not available. M10: `includeRetired` ignored.
11. P1 is an admin yet sees nothing of S2: no admin bypass, by design. M11: an `isAdmin` short-circuit in the held-store filter.

**S2 Customers**
12. C opens `/customers`, `/customers/<Y>` -> refusal; no name, phone, balance. M12: delete the `/customers` entry.
13. C opens `/customers/price-lists` -> renders (open, Ian Q3). M13: remove the `null` entry (prefix closes it).
14. `listRegister(C)` throws (loader gate). M14: remove the loader `authorize`.
15. M1 register shows Y and Z, not X (no X name or phone). M15: drop the store filter.
16. M1 register shows Y owing 1,000.00, not 10,500.00. M16: unscoped `balancesByCustomer`.
17. M1 `/customers/<X>` -> the same not-found as a random uuid. M17: `getCustomer` skips the scope rule.
18. M1 `/customers/<Y>?store=<S2>` -> not available; the dropdown and HTML hold no "S2" store name, no S2 charge,
    collection, receipt link or 9,500.00. M18: dropdown from unfiltered `storesWithOpenItems`.
19. M1 `/customers/<Y>`: charges, collections and "owes" are S1 only. M19: `listCharges` without `storeIds`.
20. M1 `/customers/<Y>` shows "over limit" (org-wide 10,500 > 10,000) but neither 9,500.00 nor 10,500.00. M20a: flag
    computed from S1 only (no flag); M20b: render the org-wide figure.
21. M2 sees X, and Y at 9,500.00 with the flag. M21: filter by the viewer's FIRST store only.
22. A sees X, Y (10,500.00), Z. M22: over-filtering (admin loses Z).

**S3 Staff**
23. C opens `/staff`, `/staff/<E1>`, `/staff/<E1>/credentials`, `/staff/hire` -> refusal; no colleague names. M23: delete the `/staff` entry.
24. T1 (manage_attendance only) opens `/staff` at S1 -> roster renders; `/staff/hire` -> refusal. M24: `/staff` maps to `enrol_staff` alone.
25. M1 `/staff`: picker S1 only; E1 renders, E2 does not. M25: `listStores` instead of `scopedStores`.
26. M1 `/staff?store=<S2>` and `/staff/hire?store=<S2>` -> not available. M26: page trusts `sp.store`.
27. `rosterForStore(M1, S2)` throws. M27: remove the loader `authorize`.
28. M1 `/staff/<E2>` and `/staff/<E2>/credentials` -> same not-found as a forged id; no name, PIN state or branches. M28: `employmentDetail` skips the store check.
29. E1's person also open at S2: M1's employment page shows "and 1 other branch", not S2's name. M29: names unfiltered.
30. `searchPersons(M1, "Q")` returns no Q; `searchPersons(A, "Q")` returns Q; an unemployed person matches for M1. M30: repo search without the store filter.
31. A sees both rosters and S2's name in the warning. M31: over-filtering.

**S4 Trade** (after T-433 S3)
32. `orderFormData` result has no `creditLimit` key for any actor (loader-only). M32: keep the field.
33. C, and M2 (no `approve_buyer` at S1), open an S1 sale order for Y: "10,000" absent. M33: remove the `can()` at `:112`.
34. M1 on the same order sees the limit and the override field. M34: strip for everyone.
35. C `/trade/orders?store=<S2>` -> not available; register lists S1 orders only. M35: page validates against `listStores`.

**Structural**
36. Every exported reader in `payroll/**/lib.ts`, `customers/lib.ts`, `staff/lib.ts` returning personal data takes
    `actor: Actor`, not `orgId: string` (source scan; allow-list `listStores`, `positionsForStore`). Keeps any future
    CSV or print route on the same scope. M36: revert `rosterFor` to `(orgId, storeId)`.
37. `route-capability-coverage` and `no-ungated-read-surface` stay green; every gated page under `/customers` and
    `/staff` calls `requirePageAccess`; `capabilityForRoute('/customers/price-lists') === null`; any-of and `null`
    entries unit-tested in `navHrefAllowed`. M37: one page keeps bare `requireSession`.

## Files
**TESTER** (writes only these):
- `apps/erp/tests/integration/t435-fixture.ts`; `t435-s1-payroll.test.ts` (1-11), `t435-s2-customers.test.ts` (12-22),
  `t435-s3-staff.test.ts` (23-29, 31), `t435-s4-trade.test.ts` (32-35), all under `apps/erp/tests/integration/`
- `packages/domain/tests/integration/t435-search-persons.test.ts` (30)
- `apps/erp/tests/t435-readers-take-actor.test.ts` (36); `tests/unit/route-capability-coverage.test.ts` (37, next to `:175-179`)
**BUILDER** (writes only these):
- `apps/erp/src/app/reports/lib.ts` (extract `scopedStores`; `reportScope` behaviour unchanged)
- `apps/erp/src/lib/route-capability.ts` (value type, entries, row-353 reason), `apps/erp/src/lib/page-access.tsx`
- `apps/erp/src/app/payroll/{page.tsx,lib.ts}`, `payroll/thirteenth-month/{page.tsx,lib.ts}`, `payroll/separations/{page.tsx,lib.ts}`
- `apps/erp/src/app/customers/{page.tsx,lib.ts}`, `customers/[customerId]/page.tsx`
- `packages/db/src/repo/customers.ts`, `packages/db/src/repo/ar.ts`, `packages/db/src/repo/persons.ts` (store filters)
- `packages/domain/src/people/index.ts` (`searchPersons` scope)
- `apps/erp/src/app/staff/{page.tsx,lib.ts}`, `staff/[employmentId]/page.tsx`, `staff/[employmentId]/credentials/page.tsx`, `staff/hire/page.tsx`
- `apps/erp/src/app/trade/orders/{page.tsx,lib.ts}`, `trade/orders/[id]/page.tsx` (S4 only, after T-433 S3)
Not touched: `packages/auth/**`, the matrix, migrations, `customers/price-lists/**`, any domain write path.

## Done when
Cases 1-37 green; each mutant shown red in the hand-back; grep the diff for leftover mutants. Typecheck, lint, the
existing payroll, AR, staff (T-202/T-217/T-302/T-387/T-395), people, trade and report suites, route-capability and
ungated-read guards green. **Before shipping:** count live admin scope rows on production, read-only (active admins
x active stores, minus `fan_out`/manual scope rows), and name every admin-store gap in the hand-back: after this task
an admin with a missing row loses that store's payroll, staff and customers. Browser on **9008** at **390** and
**1280**, as a cashier and as a one-store manager: `/customers`, `/staff`, `/payroll` refuse; pickers list only their
stores; a forged `?store=` shows the one sentence. Screenshots in the hand-back. Orchestrator then closes DEF-665/666/667.

## Not in scope
DEF-668 (file-view audit, sensitive document types) and signatures (T-434). `/reports/ar-aging` store scoping. Hiding
B2B customer NAMES on trade orders from staff who dispatch them. Repairing missing admin scope rows (report only).

## Ian's answers (16 Oct)
- **Q1.** Managers do NOT see a business customer who only buys at another branch (design 7).
- **Q2.** Holding only `manage_attendance` at a store is enough to see that store's roster (design 5-6).
- **Q3.** Price lists stay open; a longer `null` route key re-opens `/customers/price-lists` (design 5).
