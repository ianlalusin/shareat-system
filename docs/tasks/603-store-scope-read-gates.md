# T-603 — Store-scope read gates, peer-manager PIN, deny-by-default route map (DEF-906..DEF-918)

Status: SPEC (Opus), 2026-11-18. Source: `docs/reviews/2026-11-18-authz-tenant-review.md` (F1..F13, F1 = DEF-906 ... F13 = DEF-918).
Add the 13 register rows in the DEF-866 format (`docs/DEFECTS-REGISTER.md`), each marked `fixed - T-603 Sn` or `deferred` as below.
Risk: **high** (auth). Builder: Sonnet. Auditor: Sonnet. No migration, no schema, **no new capability**, no bible change.
Line numbers are main 9892641 (checked in `wt-plans`, bc30e0b, same code). Bible rows 428, 429 and 470 do not exist on main
(§13 jumps 410 → 430 and ends at 463); the rows that govern this task are 114, 353, 449, 460, 461 and §7 rules 4 and 11.

## Verdict per finding (each checked in code)

| F | DEF | Verdict | Evidence | Slice |
|---|---|---|---|---|
| F1 inventory | 906 | **Confirmed** | 9 list pages + 4 `[id]` pages call `requireSession` + `listStores(orgId)`; `/inventory` absent from the map | S2 |
| F2 till, remittance | 907 | **Confirmed** | worse for till: `storeId = sp.store \|\| ...` is not even checked against the store list (`till/page.tsx:48`) | S2 |
| F3 finance registers | 908 | **Confirmed** | every loader is `(orgId)` / `(orgId, id)`; `service-charge/page.tsx:33` takes `sp.store` unchecked | S3 |
| F4 peer PIN | 909 | **Confirmed** | matrix row `enrol_staff` already says "Staff only — creating another manager is `manage_users`" | S1 |
| F5 trade returns | 910 | **Confirmed** | `customerCreditBalance` looped over every customer (`trade/returns/page.tsx:81-90`) | S2 |
| F6 expenses list | 911 | **Confirmed** | `ListExpensesInput` has no `storeIds` (`repo/expenses.ts:471-490`) | S3 |
| F7 findings | 912 | **Confirmed** | `findingsFor(orgId)` and `scorecardFor(orgId)` unfiltered | S3 |
| F8 offline person | 913 | **Confirmed** | wider than stated: `voidUnpaidSession` (`pos/sale.ts:63`) also skips the manager PIN when the named actor holds `approve_pos_correction`, with the line rule OFF | deferred (C) |
| F9 offline flag | 914 | **By design** | bible row 460: offline is allowed and flagged; audited `high` and shows in the activity log | no fix (C) |
| F10 staff directory | 915 | **Confirmed** | `expenses/lib.ts:78`, used by till, remittance, expenses/[id], sales-days/[id] | S4 |
| F11 wastage | 916 | **Confirmed, worse** | `listPostedSettlementsForStore` (`wastage/page.tsx:68`) authorizes `record_ar_collection` unconditionally, so a cashier at their OWN store gets the error page | S2 |
| F12 re-pair | 917 | **Confirmed** | low risk, audited (`pos-tablet.ts:53-67` writes `pos_tablet.unpaired`) | S4 (doc only) |
| F13 repo by-id | 918 | **Confirmed** | `deliveries.ts:45`, `count-sessions.ts:131`, `customer-returns.ts:98` | partly S4, rest deferred |
| extra | — | **Found** | `/reports/pos-reconciliation` uses `reportScope(..., 'view_financial_reports')` but has no map key (the T-589 B3a error-page shape) | S4 |

No finding was wrong. F9 is a recorded decision, not a defect: register it as `by design - row 460`.

## S1 — F4 / DEF-909: a manager may not set a peer manager's PIN (ships alone, today)

`apps/erp/src/app/staff/actions.ts:250-255` (main):
```ts
await authorize(tx, actor, 'enrol_staff', { storeId: employment.storeId });
assertFieldRules(STAFF_PIN_RULES, formData);
if (await accessRepo.personIsActiveAdmin(tx, actor.orgId, employment.personId)) await authorize(tx, actor, 'manage_users', {});
await requireSuperForSuperTarget(tx, actor, employment.personId);
```
**The rule** (one ladder, `ROLE_RANK` in `packages/auth/src/roles.ts:295`; matrix rows `enrol_staff` and `manage_users`):

| Target's active role | Who may set the PIN |
|---|---|
| none or `staff` | `enrol_staff` at the employment's store (unchanged) |
| `manager`, the actor themself | `enrol_staff` at that store (a manager resets their own PIN) |
| `manager`, anyone else | `manage_users` (an administrator) |
| `admin` | `manage_users` (unchanged) |
| `super_admin` | a super administrator (unchanged, `requireSuperForSuperTarget`) |

No owner decision needed: this is what the matrix already says. Replace line 254 with:
```ts
const targetRole = (await accessRepo.activeRoleForPerson(tx, employment.personId, actor.orgId))?.role;
const ownManagerPin = targetRole === 'manager' && employment.personId === actor.personId;
if (isStoreManagerOrAbove(targetRole) && !ownManagerPin && !(await can(tx, actor, 'manage_users', {}))) {
  await recordPinSetRefused(actor, employment.personId, employment.storeId);
  throw refuse(`issuePin: actor ${actor.personId} lacks manage_users for ${targetRole} target ${employment.personId}`, MANAGER_PIN_ADMIN_ONLY);
}
```
`isStoreManagerOrAbove` and `can` come from `@shareat/auth` (both exported, `index.ts:37`). It runs BEFORE `setPin`, so a refusal
revokes nothing and ends no session. `MANAGER_PIN_ADMIN_ONLY = 'Only an administrator can set a manager’s PIN. Ask an administrator.'`
(the sentence names no person). `personIsActiveAdmin` is no longer called here (still used by `issueAdminPinAction:334`).

**Audit row.** Success already writes `credential.pin_set` (`sessions.ts:978-988`). The refusal is written in a SEPARATE
transaction so it survives the rollback: new `recordPinSetRefused(actor, targetPersonId, storeId)` in `staff/actions.ts`, a copy of
`recordLeaveDocumentViewRefused` (`packages/domain/src/leave/document-access.ts:70-88`: own `withOrgPrincipal`, never throws, logs
on failure), action `credential.pin_set_refused`, `storeId`, `entityId: targetPersonId`, `after: { targetRole }`, no PIN in the payload.
Catalogue: `packages/db/src/audit/catalogue.ts` beside line 331:
`def('credential.pin_set_refused', 'security', 'high', 'org', 'persons', 'T-603', ADMIN)`.

**Tests**, `apps/erp/tests/integration/t412-admin-pin-issue.test.ts` (fixture line 56: add `managerB = await mk('Manager B', 'manager')`
and reuse `employed()` from line 112), new `describe('T-603 S1 (DEF-909) - a manager cannot set a peer manager PIN')`:
1. Manager B has a PIN (`setPin` seed). Manager A calls `issuePinAction` on B's employment → `flash.error` equals the sentence; B's
   live credential id is unchanged; exactly one `credential.pin_set_refused` row (actor A, entity B). **Mutant:** restore the
   `personIsActiveAdmin` line → the PIN is set, red. **Mutant:** move the check below `setPin` → credential id changes, red.
2. An admin sets B's PIN → no error, one live PIN, one `credential.pin_set` (positive).
3. Manager A sets their OWN PIN through their own employment → no error. **Mutant:** delete `!ownManagerPin` → red.
4. Existing line 130 ("a manager still issues an ordinary staff member's PIN") stays green unchanged; existing line 119 stays green.
5. `t402-s1b-catalogue.test.ts`: the new action is listed (update its expected set or count, re-measured, never hand-guessed).
Out of scope: hiding the Issue PIN form on `/staff/[employmentId]` for a manager target (the refusal flash is the control);
grant-holding staff targets (a manager outranks them; the ladder is roles, as `roles.ts:290` explains).

## S2 — store gates on the store-picker screens (F1, F2, F5, F11)

**One helper, keyed on the route map** — new `apps/erp/src/lib/store-scope.ts` (≈30 lines). It reuses T-577's helpers and reads
the capability list from `ROUTE_CAPABILITY`, so the nav, the route gate and the store filter can never disagree:
```ts
export async function storePageScope(route: string, requested: string | undefined): Promise<{ actor; stores; storeId } | { refusal: ReactNode }>
  // requirePageAccess(route) → refusal card; heldStoresFor(tx, actor, capabilitiesForRoute(route)) → none: <StoreNotAvailable/>;
  // requested && not in list → <StoreNotAvailable/> (never a quiet fallback, T-435); else storeId = requested ?? stores[0].id
export async function recordInScope(actor: Actor, route: string, storeId: string): Promise<boolean>   // canReadAtStore(..., capabilitiesForRoute(route))
export async function listStoreIds(actor: Actor, route: string): Promise<readonly string[] | undefined> // heldStoreIdsOrAll(..., capabilitiesForRoute(route))
```
A page calls `const scope = await storePageScope('/till', sp.store); if ('refusal' in scope) return scope.refusal;`. A `[id]` page
calls `requirePageAccess` then `if (!detail || !(await recordInScope(actor, route, detail.storeId))) notFound();` (T-577 rule:
not-found, never "forbidden"). Add `'storePageScope('` to `GATE_MARKERS` in `tests/unit/route-capability-coverage.test.ts:104`.

**Map keys** (`apps/erp/src/lib/route-capability.ts`, each is the screen's own write words, T-577 rule; any one opens it):
```ts
'/inventory': ['record_stock_movement', 'receive_delivery', 'transfer_stock', 'record_supplier_return', 'open_count_session', 'post_usage', 'post_production'],
'/till': ['record_till_count', 'resolve_till_variance'],
'/remittance': 'accept_remittance',
'/trade/returns': ['record_customer_return', 'void_customer_return', 'apply_customer_credit'],
'/wastage': ['record_order_wastage', 'resolve_order_wastage'],   // same list as wastage/[id] (T-577)
```
Existing longer keys `/inventory/deliveries/inbound` and `/inventory/production/recipes(/new)` keep winning.

**Pages** (replace `requireSession(...)` + `listStores(actor.orgId)` + the `storeId =` line with `storePageScope`):
`inventory/page.tsx:21-24`, `inventory/{counts:42,deliveries:29,locations:42,low-stock:29,production:36,returns:33,transfers:31,usage:43}/page.tsx`,
`till/page.tsx:45-48`, `remittance/page.tsx:55-59` (keep `defaultStoreFor` as the default when `sp.store` is absent),
`trade/returns/page.tsx:30-32`, `wastage/page.tsx:29-31`.
**`[id]` pages** (`requireSession` → `requirePageAccess`, then `recordInScope` on the record's `storeId`):
`inventory/deliveries/[id]:68-70` (`doc.storeId`), `inventory/counts/[id]:118-120` (`detail.storeId`), `inventory/usage/[id]:44-46`
(`record.storeId`), `inventory/production/[id]:34-36` (`detail.record.storeId`; confirm the field name).
Current shape, e.g. `inventory/deliveries/[id]/page.tsx:68-70`:
```ts
const { actor } = await requireSession(`/inventory/deliveries/${id}`);
const detail = await deliveryDetail(actor.orgId, id);
if (!detail) notFound();
```
**Extra changes in S2:**
- `/inventory` peso values (stock value, GL control total, drift): render only when `recordInScope(actor, '/reports/income-statement', storeId)`
  (`view_financial_reports` at that store); quantities stay. Default pending owner row 2.
- `remittance/page.tsx:73` `openVarianceCountForOrg(actor.orgId)`: call it only when `listStoreIds(actor, '/remittance')` is `undefined`
  (org-wide viewer); otherwise omit the org banner.
- `trade/returns/page.tsx:81-90`: keep only customers seen on this store's `returnable` lines or `recentReturns`
  (`customer_id` / `customerId` sets) before the credit loop. The balance itself stays org-wide per customer (owner row 9).
- F11, `wastage/page.tsx:68`: `settlements: (await can(tx, actor, 'record_ar_collection', { storeId })) ? await listPostedSettlementsForStore(...) : []`
  (the `wastage/[id]:62` shape). The match suggestions simply do not show to someone who cannot record settlements.

**Tests**, new `apps/erp/tests/integration/t603-store-scope-read-gates.test.ts`, built on `t435-fixture.ts` and the
`t577-finance-read-gates.test.ts` mocks (lines 25-28). Personas: cashier C at S1 holding only `record_sale`; worker W at S1 with
the screen's word by position grant; manager M1 at S1; admin G. Per route: W at S1 sees it (positive); C gets the access card
(`data-capability` attribute, not a thrown error); M1 with `?store=<S2>` gets `StoreNotAvailable`; G sees S2. Per `[id]` page:
M1 + S2 record → `notFound()` (same as a forged id); M1 + S1 record → shown. `/inventory`: M1 sees values; W sees quantities, no
peso text. `/wastage`: W at S1 with tracked open rows renders (no error page). `/trade/returns`: S2-only customers absent.
**Mutants** (each red): drop the `/till` key; make `storePageScope` fall back to `stores[0]` on a foreign `?store=`; skip
`recordInScope` on `deliveries/[id]`; remove the `can(... 'record_ar_collection')` guard on `/wastage`; remove the customer filter.

## S3 — "all my stores" lists and finance detail pages (F3, F6, F7)

Lists use `listStoreIds(actor, route)` and pass `storeIds` to the loader, which filters exactly like `cash-requests/lib.ts:48-55`
(`rows.filter((r) => !storeIds || storeIds.includes(r.storeId))`; `undefined` = org-wide viewer, no filter).

| Screen | Current (main) | Change |
|---|---|---|
| `/loans` | `page.tsx:29` `listRegister(actor.orgId)` | `listRegister(orgId, storeIds)` (`loans/lib.ts:40`) |
| `/loans/[id]` | `page.tsx:34-39` `if (!loan) notFound()` | add `\|\| !(await recordInScope(actor, '/loans', loan.storeId))` |
| `/owners`, `/owners/[id]` | `page.tsx:37`, `[id]:53-58` | same pair (`owners/lib.ts:37,62`) |
| `/liabilities`, `[id]` | `page.tsx:33`, `[id]:43-48` | same pair (`liabilities/lib.ts:30,47`) |
| `/prepaid`, `[id]` | `page.tsx:43`, `[id]:57-62` | same pair; `reviewCount(orgId)` (`prepaid/lib.ts:46`) counts only `storeIds` |
| `/money-accounts` | `page.tsx:49` `listAll(actor.orgId)` | `listAll(orgId, storeIds)`; the store filter stays a narrowing |
| `/money-transfers` | `page.tsx:36-40` | `listAccountBalances` and `listRecentTransfers` take `storeIds`; a transfer shows if its `storeId` OR its destination account's store is held (owner row 7) |
| `/service-charge` | `page.tsx:32-33` takes `sp.store` unchecked | `storePageScope('/service-charge', sp.store)` |
| `/expenses` | `page.tsx:25-38` `listExpenses(tx, { orgId, storeId })` | new key `'/expenses': ['create_expense', 'edit_own_expense', 'approve_expense']` (the `[id]` list); `ListExpensesInput.storeIds?` (`repo/expenses.ts:471`) filtered as `repo/sales-days.ts:673` (`inArray`; an empty list matches nothing); the store dropdown shows held stores only |
| `/expenses/recurring` | `page.tsx:64-68` | key `'/expenses/recurring': 'manage_recurring_expenses'`; `storePageScope` |
| `/findings` | `page.tsx:49-53` `findingsFor(actor.orgId, period)` | key `'/findings': 'view_financial_reports'`; feed rows with a `storeId` kept when held; rows with `storeId: null` (trial balance, fiscal runway) and `readiness` only for an org-wide viewer |
| `/findings/scorecard` | `scorecard/page.tsx:26-28` | inherits `/findings`; `card.stores` filtered by `storeIds` |

`/expenses/new` inherits `/expenses`; every spender holds `create_expense`, so nobody who records an expense loses the form.
`/expenses/reimbursements` keeps its longer key.
**Tests** (same new file, `describe('S3')`): M1 at S1 sees the S1 loan / owner / liability / prepaid / money account / transfer /
expense / finding, never the S2 one; G sees both; M1 opening the S2 `[id]` gets `notFound()`; C (no capability) gets the card on
`/expenses`, `/findings`. Org-level finding hidden from M1, shown to G. **Mutants:** pass `undefined` instead of `storeIds` in
`/loans` (red); drop `recordInScope` on `owners/[id]` (red); drop the `storeIds` clause in `listExpenses` (red); show null-store
findings to M1 (red). Existing `t577-*` tests stay green unchanged.

## C — F8 and F9: deferred, with reasons

**F8 / DEF-913: defer to a new POS task (after the Lipa trial).** The fix binds each event to the PIN sign-in that made it (the
tablet sends its POS session id with each event; `checkPerson` requires that session to belong to `e.personId`, this pairing, and
to have begun before the event), which changes the tablet outbox in `apps/erp/src/app/pos` and the batch format: too big to land
during the trial freeze. **Does it matter for Saturday 21 Nov?** Low. Exploiting it needs someone running script in the paired
tablet's browser, and only a person holding `approve_pos_correction` (admins by role, others by grant; managers ✗) who PIN-signed-in
on that tablet in the last 7 days can be impersonated. **Mitigation for the trial:** whoever holds `approve_pos_correction`
approves by the PIN prompt only and does not sign in to the trial tablet as its user; the line rule stays off (row 460 default).
**F9 / DEF-914: no change.** Row 460 decided "offline: allowed and flagged". Each one is a `pos.line_action_unapproved` row,
severity `high`, store-scoped (`catalogue.ts:222`). A device-clock plausibility check is a possible later hardening, not this task.

## S4 — minor checklist (F10, F12, F13, extra)

- [ ] **F10 / DEF-915**: `listActingPersons(orgId, storeId?)` (`expenses/lib.ts:78`) adds, when given, an `exists` on an active
  employment at that store. Callers pass it: `till/page.tsx:62`, `remittance/page.tsx:77`, `expenses/[id]:72` (`expense.storeId`),
  `sales-days/[id]:58` (`day.storeId`). Test: S2-only person absent from `/till` at S1. Mutant: ignore `storeId` → red.
- [ ] **F12 / DEF-917**: no code. Add one sentence to the `pair_pos_tablet` row's Notes in `CAPABILITY-MATRIX.md`: giving up another
  store's pairing needs only that browser's cookie (physical control), and is audited `pos_tablet.unpaired`.
- [ ] **F13 / DEF-918**: add `orgId` to the by-id repo reads this task's pages reach: `getDelivery`/`getDeliveryDocument`
  (`deliveries.ts:45,260`), `getCountSession` (`count-sessions.ts:131`), `getReturn` (`customer-returns.ts:98`): `where id = ? and
  org_id = ?`, callers updated (`git grep` each). The other ~238 stay deferred (register row `deferred - safe while every ERP caller
  uses withOrgPrincipal`, guarded by `no-direct-transaction-in-erp.test.ts`).
- [ ] **extra**: key `'/reports/pos-reconciliation': 'view_financial_reports'` (equals its `reportScope` word; T-589 B3a shape).

## S5 — §7 rule 11: the route map becomes deny-by-default

**What "opt-in" means here.** `requirePageAccess` returns "allowed" when `capabilitiesForRoute` is `[]` (`page-access.tsx:45`), and
a route with no key gets `[]` (`route-capability.ts:185`). So a new page nobody adds to the map is readable by every signed-in
person, and the comment at `route-capability.ts:25-27` calls that deliberate. Rule 11 says the opposite. T-497 already made
`/admin` and `/settings` default-deny in the TEST (not at runtime). S5 extends that test to every route and every action file.
Runtime behaviour does not change; a new unmapped page fails CI until someone records a decision.

**Baseline today (measured on main by scanning `apps/erp/src/app`):** 154 pages; **46 page files under 36 route prefixes have no
map entry**. 81 `'use server'` files / 363 exported actions; **30 files / 143 actions sit under a route with no entry** (actions are
classified by their folder's route, the same longest-prefix rule; the domain `authorize()` still guards each write).
After S2-S4 land, the unmapped set is: open by decision `/` (T-589 B3a welcome), `/sign-in` and `/setup` (no session yet, T-232),
`/clock` (Firebase kiosk, no ERP session); awaiting a decision (12): `/attendance`, `/attendance/leave`, `/channel-settlements`,
`/channel-settlements/record`, `/commissary/catalogue`, `/commissary/discrepancies`, `/commissary/orders`, `/items`, `/items/import`,
`/opening-balances`, `/statutory-discounts`, `/trade/orders`; actions only: `/franchise` (root `actions.ts`).

**Change**, `tests/unit/route-capability-coverage.test.ts` (generalise lines 155-242, T-497):
- `APPROVED_OPEN_ROUTES` (was `APPROVED_OPEN_ADMIN_ROUTES`): the 4 routes above, each with its citation.
- `ROUTES_AWAITING_A_DECISION`: the 12 + `/franchise`, comment "Ian decides each; this list can only shrink".
- `unmappedRoutes()` drops the `isAdminOrSettings` filter; apply it to page routes AND to the folder route of every `'use server'`
  file under `apps/erp/src/app` (folders starting `_` or `(` contribute nothing, as `routeOf` does).
- Update the two tests that use `/till` as the example open route (lines 267-277): use `/` and `/attendance`.
- `route-capability.ts:21-40` comment: replace "deliberately not exhaustive" with the deny-by-default rule and point at the test.
**Tests/plants:** a new page `/brand-new-screen` → red; a new `'use server'` file under an unmapped folder → red; a route removed from
`ROUTES_AWAITING_A_DECISION` while still unmapped → red; an awaiting entry that becomes mapped must be deleted (shrink check) → red if left.

## Census and guards touched (re-measure, never hand-edit)
`route-capability-coverage.test.ts` (S2 markers, S5 rewrite), `t402-s1b-catalogue.test.ts` (S1 action), `capability-matrix.test.ts`
(F12 note only; must stay green), `no-ungated-read-surface.test.ts` and `no-direct-transaction-in-erp.test.ts` (new helper uses
`withOrgPrincipal`; must stay green), `t343-throw-ratchet.test.ts` (S1 uses `refuse`, no new `throw new Error`).

## Out of scope
New capabilities; runtime deny-by-default in `requirePageAccess` (S5 is a CI guard); the 12 awaiting routes' gates; F8's token
binding; hiding cost columns on delivery pages; payroll and POS screens (already gated).

## Build order (one commit each; LF endings; paste each mutant's red line in the commit message)
**S1 ships alone today** (one action, one catalogue line, one test file). S2 and S3 change who sees daily screens: land them
**after the Lipa trial on 21 Nov**, or before only if every Lipa trial user's role/positions are checked to hold the new keys'
words. Then S4, then S5 (S5 last: its baseline list is written after S2-S4 remove their routes).
```
npx vitest run --project integration apps/erp/tests/integration/t412-admin-pin-issue.test.ts --maxWorkers=2
npx vitest run --project integration apps/erp/tests/integration/t603-store-scope-read-gates.test.ts apps/erp/tests/integration/t577-finance-read-gates.test.ts --maxWorkers=2
npx vitest run --project integration apps/erp/tests/integration/t435-s2-customers.test.ts apps/erp/tests/integration/t435-s4-trade.test.ts --maxWorkers=2
npx vitest run --project unit tests/unit/route-capability-coverage.test.ts tests/unit/no-ungated-read-surface.test.ts tests/unit/no-direct-transaction-in-erp.test.ts tests/unit/capability-matrix.test.ts tests/unit/t343-throw-ratchet.test.ts packages/db/tests/t402-s1b-catalogue.test.ts --maxWorkers=2
```
No whole-repo `tsc` locally (keep the machine under 90% memory): type-check the touched workspace only if it fits, else rely on CI.
The test DB must be a `_test` database. Full suite runs in CI on the PR.

## Owner's decision table (answer in one pass; the default ships if no answer)

| # | Screen | Who sees it today | Proposed default | Needs owner? |
|---|---|---|---|---|
| 1 | `/inventory` and children (stock, deliveries, counts, usage, production, transfers, returns) | anyone signed in, any store | holders of an inventory write word, their stores only | no (screen's own words) |
| 2 | Peso stock value and GL totals on `/inventory` | anyone | managers and up (`view_financial_reports`) at that store; others see quantities | **yes**: may cashiers/cooks see stock values? |
| 3 | Unit costs on a delivery | anyone | unchanged for receivers at their own store (they enter them) | **yes**: hide costs from receivers? |
| 4 | `/till` | anyone, any store | till counters and managers, their stores | no |
| 5 | `/remittance` | anyone, any store | managers and up (`accept_remittance`), their stores | **yes**: should cashiers see it? |
| 6 | Loans, owners, liabilities, prepaid, money accounts, service charge | every manager, every store | each manager sees only their stores; admins see all | no (matrix: store scope) |
| 7 | `/money-transfers` between two stores | every manager, all transfers | a manager sees a transfer if either side is their store | **yes** |
| 8 | `/trade/returns` | anyone, any store | return/credit holders at their store; only that store's customers | no |
| 9 | A customer's credit balance on `/trade/returns` | everyone, every customer | that store's customers, balance org-wide | **yes**: org-wide or this store only? |
| 10 | `/expenses` list | anyone, all stores | expense recorders/approvers, their stores | no (same as the expense page) |
| 11 | Colleagues' expenses at my store | any recorder | yes, as the single expense page already allows | **yes** |
| 12 | `/findings` | anyone, whole org | managers: their stores' findings; org-wide checks (trial balance, periods) admins only | **yes**: should managers see findings at all? |
| 13 | `/findings/scorecard` (ranks stores by manager response) | anyone, all stores | managers see only their own store's row | **yes** |
| 14 | `/wastage` | anyone (cashier hits an error page) | wastage recorders/resolvers, their stores; settlement hints only to settlement recorders | no |
| 15 | Staff picker on till, remittance, expense, sales day | everyone in the org | people employed at that store | no |
| 16 | The 12 routes still awaiting a decision (S5 list) | anyone | stay open until mapped one by one | **yes**, later, per route |

**9 rows need the owner (2, 3, 5, 7, 9, 11, 12, 13, 16).** My picks are the defaults above; all are the safer reading except 3 and 11,
which keep today's behaviour because changing them would stop people doing their jobs.
