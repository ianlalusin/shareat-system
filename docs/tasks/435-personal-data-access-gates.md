# T-435: personal-data access gates (payroll, customers, staff, trade credit limits)

**Status:** spec written 2026-10-16, not started — PRIORITY (the live ERP leaks personal data)
**Model:** Sonnet tester first (commits red), then Sonnet builder, per slice (bible row 184). Auth path: Sonnet, not Haiku.
**Migration:** NO. No new capability: every gate reuses one already in `CAPABILITY-MATRIX.md` and already seeded.
**Order:** S1 payroll (HIGH), S2 customers, S3 staff, S4 trade credit limits (S4 after T-433 S3 merges: same two files).
**Closes:** DEF-665, DEF-666, DEF-667 (the trade part too). Governed by bible row 353 and T-288 (read gates).

## Goal (plain words)
Today a cashier signed in to the ERP can open the customer list (phone numbers, balances, credit limits) and the
staff roster, and a payroll admin of one branch can type another branch's id into the address bar and read its pay
rates and payslips. Ian's rule (row 353): personal data is shown only to people whose job needs it, only for their
own stores, and the check lives where the data is READ, not only in the menu.

## Diagnosis (verified at `8d9d9d5`)
- **Payroll.** `payroll/page.tsx:48` `requirePageAccess('/payroll')` passes on `run_payroll` held at ANY store
  (`heldCapabilities` is store-blind); `:53` then trusts `sp.store`; `:76-82` `rosterFor`/`runsFor`/`cashAccountsFor`
  and `:82` `slipsFor` are bare repo reads (`payroll/lib.ts:36-55`, `rosterFor` `:44-55` returns every rate). Only
  `preview` authorizes (domain `previewPayRun`, `packages/domain/src/payroll/index.ts:155`). Same shape:
  `thirteenth-month/page.tsx:38` (store), `:52` `runsFor`, `:57` `payoutsFor`; `separations/page.tsx:48` (store),
  `:59-61` `worklistFor`/`cashAccountsFor`/`separationsFor`.
- **Customers.** `customers/page.tsx:35` and `customers/[customerId]/page.tsx:84` call only `requireSession`;
  `/customers` is absent from `lib/route-capability.ts:41-90`; `customers/lib.ts:30` `listRegister` reads every
  customer and an org-wide balance; the detail page's `:90-112` reads position, store credit, charges and collections
  for ALL stores, and `:101-104` accepts any `?store=` that has open items. Customers are org master data (no
  `store_id`, ADR-008); AR is per store.
- **Staff.** `staff/page.tsx:33` `requireSession` only; `:35` picks any org store from `?store=`; `:46-49`
  `rosterForStore`. `staff/lib.ts:5` says *"the gate belongs to the WRITE, not to looking at a roster"* — overturned by
  T-288 (`route-capability.ts:4-8`, Ian 2026-09-12 "do both hide the menu and gate the reads") and now by row 353.
  `staff/lib.ts:31` `rosterForStore`, `:53` `employmentDetail`, `:83` `livePinFor`, `otherOpenBranchesFor` all
  ungated; `staff/[employmentId]/page.tsx:29-40` renders them for any session. `staff/hire/page.tsx:35` and
  `staff/[employmentId]/credentials/page.tsx:50-61` (person name read before the gated `listCredentials`) likewise.
- **Trade.** `trade/orders/[id]/page.tsx:49` `requireSession` only; `:112-114` prints `customer.creditLimit`.
  `trade/orders/lib.ts:96` sends every active customer's `creditLimit` to the client form (`NewOrderForm`).
- **Exports:** none. No CSV, print or `route.ts` under `payroll/`, `customers/`, `staff/`, `trade/orders/` today.

## Design
1. **One helper, not five copies.** New `apps/erp/src/lib/stores-holding.ts`: `storesHolding(actor, capability)`
   returns the org stores where `can(tx, actor, capability, { storeId })` is true (the idiom already in
   `expenses/reimbursements/lib.ts:27-35`), and `pickHeldStore(held, requested)` returns the requested store if held,
   the first held store if none was requested, or `refused`. Add `<StoreNotAvailable/>` to `lib/page-access.tsx`:
   the fixed sentence **"This store is not available to you."** and nothing else (no store name, no counts).
2. **Two layers, both real** (bible §15.11). The PAGE resolves the store through `storesHolding` and renders the
   refusal itself (DEF-189: a thrown refusal is a 500). Every LOADER in `*/lib.ts` that returns personal data takes
   the full `Actor` (not `orgId`) and calls `authorize(tx, actor, CAP, { storeId })` first, so a future caller that
   skips the page check still gets nothing. A by-id loader (payslips, employment, customer) looks up the row's store
   and authorizes on THAT store.
3. **Refused vs. missing look identical** for by-id pages: an employment or customer out of the viewer's scope gets
   the same `notFound()` as a forged id (DEF-497 shape), so the page does not confirm the record exists.
4. **Capabilities** (all in the matrix, all store-scoped, manager+ except payroll):
   - payroll: `run_payroll` (admin-only, matrix :148). Route entry already exists.
   - customers: `record_ar_collection` (:109). There is no read capability and none is needed: everyone with a
     reason to see a B2B customer's contacts and balance collects from them. Add `'/customers': 'record_ar_collection'`
     (prefix covers `/customers/[id]` and `/customers/price-lists`).
   - staff: `enrol_staff` (:142). Add `'/staff': 'enrol_staff'` (covers hire, employment, credentials).
   - trade credit limit: shown only if `can(approve_buyer)` or `can(override_credit_limit)` at the order's store (the
     words `dispatchTradeOrder` and T-433's override already check). No route gate on `/trade/orders` (staff dispatch
     branch orders there); only the limit is withheld.
5. **Customer scope rule.** A viewer sees a customer if it has any AR row at a held store, or its
   `counterpartyStoreId` is a held store, or it has no AR rows anywhere (a new buyer any manager may bill). Balances,
   "owes", store credit, charges, collections and receipt links are summed/listed over held stores only. Repo additions
   in `customers.ts`/`ar.ts` take `storeIds: string[]`. Admins hold every store, so they see what they see today.
6. **Staff.** `otherOpenBranchesFor` names only branches where the viewer holds `enrol_staff`; others render as
   "and N other branch(es)" so the PIN warning (T-302) still fires. Rewrite the `staff/lib.ts:1-9` and `:70-73`
   comments to cite T-288 and row 353.
7. **No new ✅ is created**, so no new matrix denial test is owed; each gate below has its own ✗ case anyway.

## Fixture (shared by all tester files)
Stores S1, S2. **A** admin, all stores. **P1** admin whose store list is {S1} only (payroll is admin-only, so this is
"another store's payroll admin"). **M1** manager at S1, **M2** manager at S2. **C** staff (cashier) at S1. Employees
E1 (S1, rate 650), E2 (S2, rate 720, phone set), a posted pay run at each store. Customers X (charges only at S2),
Y (owes 1,000.00 at S1 and 5,000.00 at S2, limit 10,000.00, phone set), Z (no AR rows).
"Sees nothing" below means the rendered HTML (or loader result) contains none of: the names, phones, rates, payslip
amounts, balances or limits of the out-of-scope people.

## Cases (each names its mutant M#)
**S1 Payroll**
1. C and M1 open `/payroll`, `/payroll/thirteenth-month`, `/payroll/separations` -> access refusal, sees nothing. M1: delete the `/payroll` route entry.
2. P1 `/payroll`: store picker lists S1 only; E1 and 650 render; E2/720/S2 absent. M2: use `listStores` instead of `storesHolding`.
3. P1 `/payroll?store=<S2>` -> "This store is not available to you."; sees nothing of S2. M3: page trusts `sp.store`.
4. `rosterFor(P1, S2)` throws the `run_payroll` refusal. M4: remove the loader `authorize`.
5. `runsFor`, `cashAccountsFor`, `premiumSettingsFor(P1, S2)` each throw. M5: remove the authorize in `runsFor`.
6. `slipsFor(P1, <S2 run id>)` throws (authorized on the run's own store). M6: authorize on a caller-supplied store.
7. `/payroll/thirteenth-month?store=<S2>` -> not available; `runsFor`/`payoutsFor(P1, S2 run)` throw. M7: drop the 13th-month loader gate.
8. `/payroll/separations?store=<S2>` -> not available; `worklistFor`/`separationsFor(P1, S2)` throw. M8: drop the separations loader gate.
9. A sees both stores, E2 and 720 render under S2. M9: `storesHolding` returns only the first store.

**S2 Customers**
10. C opens `/customers`, `/customers/<Y>`, `/customers/price-lists` -> refusal; no name, phone, balance. M10: delete the `/customers` entry.
11. `listRegister(C)` throws (loader gate even with the route gate). M11: remove the loader `authorize`.
12. M1 register shows Y and Z, not X (no X name or phone). M12: drop the store filter.
13. M1 register shows Y owing 1,000.00, not 6,000.00. M13: unscoped `balancesByCustomer`.
14. M1 `/customers/<X>` -> the same not-found as a random uuid. M14: `getCustomer` skips the scope rule.
15. M1 `/customers/<Y>?store=<S2>` -> S1 view or not-available; no S2 charge, collection, receipt link or 5,000.00. M15: trust `sp.store`.
16. M1 `/customers/<Y>`: charges, collections and "owes" are S1 only. M16: `listCharges` without `storeIds`.
17. M2 sees X; M2 sees Y at 5,000.00. M17: filter by the viewer's FIRST store only.
18. A sees X, Y (6,000.00), Z. M18: over-filtering (admin loses Z).

**S3 Staff**
19. C opens `/staff`, `/staff/<E1>`, `/staff/<E1>/credentials`, `/staff/hire` -> refusal; no colleague names. M19: delete the `/staff` entry.
20. M1 `/staff`: picker S1 only; E1 renders, E2 does not. M20: `listStores` instead of `storesHolding`.
21. M1 `/staff?store=<S2>` and `/staff/hire?store=<S2>` -> not available. M21: page trusts `sp.store`.
22. `rosterForStore(M1, S2)` throws. M22: remove the loader `authorize`.
23. M1 `/staff/<E2>` and `/staff/<E2>/credentials` -> same not-found as a forged id; no name, PIN state or branches. M23: `employmentDetail` skips the store check.
24. E1's person also open at S2: M1's employment page shows "and 1 other branch", not S2's name. M24: render branch names unfiltered.
25. A sees both rosters and S2's name in the warning. M25: over-filtering.

**S4 Trade credit limit** (after T-433 S3)
26. `orderFormData(C, S1)`: every customer's `creditLimit` is null. M26: return `c.creditLimit` unconditionally.
27. `orderFormData(M1, S1)` carries Y's 10,000.00. M27: always strip.
28. C, and M2 (no `approve_buyer` at S1), open an S1 sale order for Y: "10,000" absent from the HTML. M28: remove the `can()` around `:112`.
29. M1 on the same order sees the limit and the override field. M29: strip for everyone.

**Structural**
30. Every exported reader in `payroll/**/lib.ts`, `customers/lib.ts`, `staff/lib.ts` that returns personal data takes
    `actor: Actor`, not `orgId: string` (source scan, allow-list for `listStores`/`positionsForStore`). This is what
    keeps a future CSV or print route on the same scope. M30: revert `rosterFor` to `(orgId, storeId)`.
31. `route-capability-coverage` and `no-ungated-read-surface` stay green with the two new entries; every page under
    `/customers` and `/staff` calls `requirePageAccess`. M31: one page keeps bare `requireSession`.

## Files
**TESTER** (writes only these):
- `apps/erp/tests/integration/t435-fixture.ts` (personas and data above)
- `apps/erp/tests/integration/t435-s1-payroll.test.ts` (1-9), `t435-s2-customers.test.ts` (10-18),
  `t435-s3-staff.test.ts` (19-25), `t435-s4-trade-credit-limit.test.ts` (26-29)
- `apps/erp/tests/t435-readers-take-actor.test.ts` (30); `tests/unit/route-capability-coverage.test.ts` (31: add
  the `/customers` and `/staff` nav assertions next to `:175-179`)
**BUILDER** (writes only these):
- `apps/erp/src/lib/stores-holding.ts` (new), `apps/erp/src/lib/page-access.tsx` (`StoreNotAvailable`),
  `apps/erp/src/lib/route-capability.ts` (two entries, with the row-353 reason)
- `apps/erp/src/app/payroll/{page.tsx,lib.ts}`, `payroll/thirteenth-month/{page.tsx,lib.ts}`,
  `payroll/separations/{page.tsx,lib.ts}`
- `apps/erp/src/app/customers/{page.tsx,lib.ts}`, `customers/[customerId]/page.tsx`, `customers/price-lists/**/page.tsx`
  (switch to `requirePageAccess` only)
- `packages/db/src/repo/customers.ts`, `packages/db/src/repo/ar.ts` (`storeIds` filters)
- `apps/erp/src/app/staff/{page.tsx,lib.ts}`, `staff/[employmentId]/page.tsx`, `staff/[employmentId]/credentials/page.tsx`,
  `staff/hire/page.tsx`
- `apps/erp/src/app/trade/orders/{page.tsx,lib.ts}`, `trade/orders/[id]/page.tsx` (S4 only, after T-433 S3)
Not touched: `packages/auth/**`, the matrix, migrations, any domain write path.

## Done when
Cases 1-31 green; each mutant shown red in the hand-back; grep the diff for leftover mutants. Typecheck, lint, the
existing payroll, AR, staff (T-202/T-217/T-302/T-387/T-395) and trade suites, route-capability and ungated-read guards
green. Browser on **9008** at **390** and **1280**, signed in as a cashier and as a one-store manager: `/customers`,
`/staff`, `/payroll` refuse; the manager's pickers list only their stores; a forged `?store=` shows the one sentence.
Screenshots in the hand-back. Orchestrator then closes DEF-665/666/667.

## Not in scope
DEF-668 (file-view audit, sensitive document types) and signatures (T-434). `/reports/ar-aging` store scoping. Hiding
B2B customer NAMES on trade orders from staff who dispatch them. Masking fields inside the rightful holder's view.

## Questions for Ian (defaults the builder uses if unanswered)
- **Q1.** Should a manager see a business customer who only buys from ANOTHER branch? Default **no** (rule 5).
- **Q2.** Should someone who holds only `manage_attendance` (not `enrol_staff`) still see the staff roster? Default
  **no**; today every manager holds both, so nobody loses access.
- **Q3.** `/customers/price-lists` becomes manager+ (prefix). Default **yes**; staff still see quoted prices on the order form.
