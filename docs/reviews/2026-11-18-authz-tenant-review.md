# Authorization and tenant-isolation review, 2026-11-18

Read-only review of main (9892641). No Node run. Scope: `apps/erp` pages, server actions, route handlers, POS-in-ERP, auth, repo and RLS.
Excluded as already known: DEF-834 (named screens), DEF-866. Severity: data-leak / privilege / integrity / minor.

## Headline

Org isolation is strong: RLS on every table plus a registry test, same-org FK census, and an org principal on every ERP transaction.
Write paths are strong: every action calls a domain function that runs `authorize()` first, and record-by-id writes compare `row.storeId`.
The weak layer is STORE isolation on READS. The page gate (`requirePageAccess`) checks the capability org-wide, not store scope. Many pages
then take `?store=` or an id from the URL and read it with no per-store check. T-577 fixed only the screens DEF-834 named.
Also bible section 7 rule 11 ("a route with no declared permission is denied") is not what the code does. `ROUTE_CAPABILITY`
is opt-in (`route-capability.ts:26`), so every new page is open by default.

## Findings, most severe first

**F1. data-leak. CONFIRMED. Inventory screens: no capability, no store scope, on list and by-id pages.**
`apps/erp/src/app/inventory/page.tsx:20-30` (`stockSummary(orgId, storeId)`, `inventory/lib.ts:50`), `inventory/deliveries/[id]/page.tsx:68-70`,
`inventory/counts/[id]/page.tsx:118`, `inventory/usage/[id]/page.tsx:44`, `inventory/production/[id]/page.tsx:34`, plus the list pages
`deliveries`, `counts`, `usage`, `production`, `low-stock`, `returns`, `transfers` (all `requireSession` + `listStores(actor.orgId)` + `?store=`).
Scenario: a cashier at store A opens `/inventory?store=<B>` and sees B's stock peso value and GL control totals; opens a delivery and sees unit costs and goods totals.
Fix: `heldStoresFor` / `canReadAtStore` on each page (the `trade/orders` pattern), a capability key in `ROUTE_CAPABILITY`, and `getXDetail(actor, id)` that checks `row.storeId`.

**F2. data-leak. CONFIRMED. Cash custody and remittance read any store.**
`till/page.tsx:45-62` (`tillOverview(orgId, storeId)`, `sp.store` unvalidated beyond the URL) and `remittance/page.tsx:55-84` (`endDays`, `recentRemittances`,
`openVariances`, `openVarianceCountForOrg`). Neither calls `authorize`/`can`. Shows counted cash, shortages charged to named people, office/cashier accounts.
Scenario: any signed-in staff member at store A picks store B in the dropdown and reads B's till counts and open remittance variances by name.
Fix: gate the page with `submit_sales_day`/`accept_remittance`-style words at the store; `StoreNotAvailable` otherwise.

**F3. data-leak. CONFIRMED. Finance registers are org-wide for a store-scoped manager.**
`loans/page.tsx:34-38`, `loans/[id]:34-38`, `owners/page.tsx:53-60`, `owners/[id]:53-58`, `liabilities/page.tsx:29-33`, `liabilities/[id]:43-48`, `prepaid/page.tsx:38-44`,
`prepaid/[id]:57-62`, `money-accounts/page.tsx:45-49` (filter is cosmetic: `storeFilter` only narrows), `money-transfers/page.tsx:33-40`, `service-charge/page.tsx:28-46`.
Route key is `view_financial_reports`, which the matrix gives managers at store scope, but the gate is the org-wide union (`page-access.tsx:44`) and the loaders take `(orgId, id)`.
All these tables carry `store_id`. Not named in DEF-834/T-577.
Scenario: the manager of store A holds the capability at A only, opens `/loans` and `/owners/<id>`, and reads store B's loans, owner capital/drawings and balances.
Fix: `heldStoreIdsOrAll` on lists, `canReadAtStore(record.storeId)` then `notFound()` on `[id]` pages (reuse T-577's helpers).

**F4. privilege. CONFIRMED. A manager can set the PIN of a peer manager.**
`staff/actions.ts:246-255`: `issuePinAction` needs `enrol_staff` at the store (manager has it) and only escalates when the target is admin/super_admin (`personIsActiveAdmin`).
Scenario: manager A at Lipa re-issues manager B's PIN, signs in as B (or approves with B's PIN), defeating "the person who submits is not the person who approves" and attributing actions to B. The matrix says managers handle staff only.
Fix: refuse (or require `manage_users`) when the target's active role is `manager` or above.

**F5. data-leak. CONFIRMED. `/trade/returns` bypasses the customer-data gates.**
`trade/returns/page.tsx:30-110`: `listStores(actor.orgId)`, raw SQL by `?store=` (no `org_id` in the WHERE; RLS only), reads B2B customer names, order lines with rates, and every customer's store-credit balance org-wide (`customerRows` loop).
T-435 gated `/customers` with `record_ar_collection` for exactly this data. Scenario: any signed-in person opens the page and sees wholesale buyers, prices and credit balances of every store.
Fix: `tradeStoresFor(actor)` plus `record_ar_collection`/`approve_buyer` at the store; filter `customerRows` by customers the viewer may read.

**F6. data-leak. CONFIRMED. `/expenses` list and `/expenses/recurring` read every store.**
`expenses/page.tsx:25-42` (`expensesRepo.listExpenses(tx, {orgId, storeId})`, storeId undefined means ALL stores); `expenses/recurring/page.tsx:64-75`. T-577 gated only `expenses/[id]`.
Scenario: a cashier opens `/expenses` and sees every store's date, category, particulars and total; the row link then 404s but the list already leaked.
Fix: same `heldStoreIdsOrAll` filter as the `[id]` page; pass `storeIds` to the repo.

**F7. data-leak. CONFIRMED. `/findings` and `/findings/scorecard` readable by any signed-in person, org-wide.**
`findings/page.tsx:49`, `findings/scorecard/page.tsx:~27`; neither is in `ROUTE_CAPABILITY`. `findingsFor(orgId, period)` returns every ledger-integrity finding and period-close readiness; the scorecard ranks stores by manager responsiveness.
Fix: gate with `view_financial_reports` (or a findings word) and scope by store.

**F8. privilege. PLAUSIBLE. An offline POS event can name any person who PIN-signed-in on that tablet in the last 7 days.**
`packages/domain/src/pos/inbox.ts:322-342` (`checkPerson` trusts `e.personId`, vouched only by `hasPinSessionOnPairing`); window `POS_OFFLINE_SIGNIN_WINDOW_MS` = 7 days (`sessions.ts:47`). The device cookie is the only credential on `POST /api/pos/events`.
Scenario: a cashier who can run script in the tablet browser posts events as the manager who signed in that morning; `gateLineAction` then sees `can(approve_pos_correction)` and returns `approvedBy: actor` (`line-approval.ts:100`), skipping the manager PIN.
Fix: bind each event to a per-sign-in signed token minted at PIN sign-in, or shorten the window and require the approval token for any person holding `approve_pos_correction`.

**F9. integrity. PLAUSIBLE. The "I was offline" flag bypasses the line-approval PIN.**
`line-approval.ts:101-107`: with `requirePinLineActions` on, `offline: true` in the event lets a cancel/discount through, audited only. The flag is client-supplied; the server cannot verify it. Rule defaults OFF.
Scenario: a cashier cancels a printed line online and sets `offline:true`; the only trace is a `pos.line_action_unapproved` audit row.
Fix: accept the flag only when the batch's device time is older than the receive time by a margin, and report unapproved actions on a manager screen.

**F10. minor. CONFIRMED. Whole-org staff directory shown on open screens.**
`expenses/lib.ts:78` `listActingPersons(orgId)` (names plus role of every active person) feeds `/till`, `/remittance` and others for any signed-in user. Fix: limit to people employed at the chosen store.

**F11. minor. CONFIRMED. `/wastage` list loads before it authorizes.**
`wastage/page.tsx:25-42` reads `open/recent/monitor` for any `?store=`, then `listPostedSettlementsForStore` throws (`record_ar_collection`), so nothing renders for a foreign store but a cashier gets an error page instead of a refusal card. Data is not shown; fix by checking the store first.

**F12. minor. PLAUSIBLE. Re-pairing a tablet revokes another store's pairing with no capability at that store.**
`pos-tablet.ts:75-86`: holding the old cookie "proves the right to give it up". Requires physical control of that browser, so low risk. Fix: note it in the capability matrix or require `pair_pos_tablet` at the held store.

**F13. minor. CONFIRMED. Many repo functions are by-id with no `org_id` in the WHERE.**
242 functions of the shape `fn(tx, id|storeId, ...)` in `packages/db/src/repo/*` (e.g. `deliveries.ts:45,260`, `count-sessions.ts:131`, `customer-returns.ts:98`). Org isolation then rests on RLS alone, against bible 7 rule 4 / 15.11 "no layer the only one". Safe while every ERP caller uses `withOrgPrincipal` (guarded by `no-direct-transaction-in-erp`), but the first `systemTransaction` caller would leak. Fix: add `orgId` to these signatures over time; at least for the ones F1 and F3 call.

## Checked and found sound

- `authorize()` / `decide()`: org axis first, role or grant, store scope always, `close_period` whole-org rule. Grant-expiry: there is no expiry column.
- POS routes (`/api/pos/*`, 11 handlers): session plus tablet pairing with org match, store taken from the cookie, `effectiveStore` refuses a different `?storeId`, content-type checks, capped bodies, PINs only in POST bodies, uniform refusal sentences.
- Tokens: PIN lookup HMAC is org-scoped and throttled (`runChargedPinLookup`); line-approval token binds store, pairing, approver, action, target and detail; DEF-866 canonical-signature fix present.
- `/files/[fileId]`, `/files/upload` (origin check, capability before body), `/documents/signature/[id]`: uniform 404, org-scoped, signed URL per click.
- Report pages and all 9 `reports/*/export` routes: `reportScope` then per-store `authorize`; `pos-data` export audited; statutory export re-checks `remit_statutory`.
- Dev fake POS route: 404 in production, key compared with `timingSafeEqual`, path built only from regex-validated values.
- `/api/health`: unauthenticated; returns only status, build sha, latency (error text hidden in production).
- Customer lobby (`apps/customer`): device cookie of 32 random bytes with only its HMAC stored, restricted DB role, one uniform "closed" reply (read lightly).
- Capability matrix: `CAPABILITY_MATRIX` is a typed exhaustive table parsed against the markdown by a unit test; I found no cell that disagrees. The matrix itself looks right except where F4 is concerned.

## Coverage

- Server actions: 81 `'use server'` files, 363 exported action functions. Read in full: dual-run, trade/returns, staff credentials, staff `issuePin`, POS kitchen. Sampled by call-graph (action calls a domain function that authorizes) for the rest via grep counts of `authorize`/`can` per file; 4 files have zero direct hits and all four delegate to a gated domain function.
- Route handlers: 28 of 28 read (health, 11 POS, dev fake POS, files x2, signature, leave export, statutory export, 10 report exports; report exports read by their gate lines, `trial-balance`, `store-comparison` and `pos-data` in full).
- Pages: 154 enumerated. Session marker check on all (only `/clock`, a Firebase kiosk page, has none). Store-scope marker check on all dynamic and list pages; 47 routes are absent from `ROUTE_CAPABILITY`; about 30 pages read in part.
- Repo: signature scan of `packages/db/src/repo/*` (105 files), not line-by-line. RLS registry skimmed (scope kinds, `system_only` and `derived` lists), `principal.ts` read.
- Not reached: `packages/domain` bodies other than POS inbox/snapshot/line-approval, wastage, statutory; payroll maths; `apps/pos`, `apps/website`; Firestore rules and `/clock` Firestore paths; migrations and policy SQL; `credentials-admin.ts`, `roles.ts` role-assignment rank rules; `sessions.ts` beyond signatures; CSRF on server actions beyond Next's origin check; `apps/customer` beyond lobby cookie and `handleStore`.
