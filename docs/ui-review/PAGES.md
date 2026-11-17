# UI review coverage ledger (T-589)

One row per `apps/erp/src/app/**/page.tsx`, guarded by `apps/erp/tests/t589-pages-ledger.test.ts`.
Seeded from the 15 Nov 2026 full-page scan (`shareat-ui-scan/2026-11-15/review-G1..G4.md`). A new page must get a row here.
Status: OK, minor, fix, not captured, not reviewed. "Fixed in PR" is filled by each T-589 batch.

## Re-capture eba6b0b (2026-11-17)

154 pages; 144 re-captured on main eba6b0b (after the T-589 batches), signed in as admin (sign-in and setup signed out), desktop 1280 px
and phone 390 px, synthetic data only. The other 10 are record pages with no record in the synthetic data. Each page was scored from its
two screenshots by a Haiku reviewer; scores are in the last column. Opus checked every "needs fixing" by eye and raised /liabilities and
/prepaid/[id] from "could improve" (same phone-card fault as /prepaid). Screenshots: `shareat-ui-scan/2026-11-17/` (outside the repo).

| score | pages |
|---|---|
| needs fixing | 8 |
| could improve | 41 |
| good | 95 |
| not captured | 10 |

Top 10 "needs fixing":

1. /ap/invoices/[id] (phone): the verify-preview card splits words letter by letter, and the same refusal reasons are printed twice.
2. /inventory/counts (phone): the room name and status pill wrap one letter per line.
3. /prepaid (phone): the item name wraps one letter per line.
4. /liabilities (phone): the obligation name wraps one letter per line.
5. /reports/store-comparison (phone): each card shows only one store, and the store name runs into the figure.
6. /prepaid/[id] (phone): month names split mid-word in the schedule cards.
7. /admin/users/[personId]: raw capability codes (set_pay_rate) shown to users.
8. /opening-balances/balance-sheet: the tie-out message names account "1400" instead of saying what it is.

Only 8 pages scored "needs fixing", so the list stops at 8. Items 1-6 share one cause: on the phone, the record card (initials circle, name, figures) leaves the name column too narrow. One fix to that card should clear all six.

| route | file | last reviewed | status | findings ref | fixed in PR | re-capture eba6b0b |
|---|---|---|---|---|---|---|
| / | apps/erp/src/app/page.tsx | 2026-11-15 | fix | G3 | T-589 B3a, T-589 B3d, #289, #288, #283 | could improve: Dense dashboard with empty charts; phone shows a no-sales tooltip over the chart. |
| /admin/access-defaults | apps/erp/src/app/admin/access-defaults/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286 | could improve: Dense capability grids; phone intro text is cut off and the lists run very long. |
| /admin/pos-tablets | apps/erp/src/app/admin/pos-tablets/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #289, #286 | good: Clear empty state with an obvious Register tablet button; phone works. |
| /admin/prerequisite-refusals | apps/erp/src/app/admin/prerequisite-refusals/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #286 | good: Clean empty state saying nobody has been stopped yet; fine at both widths. |
| /admin/stores | apps/erp/src/app/admin/stores/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #289, #286 | could improve: Phone store names wrap onto three lines in cramped cards. |
| /admin/stores/[id] | apps/erp/src/app/admin/stores/[id]/page.tsx | 2026-11-15 | fix | G1 |  | could improve: Phone stacks eight long cards; the readiness list and actions compete for attention. |
| /admin/stores/[id]/pos-preflight | apps/erp/src/app/admin/stores/[id]/pos-preflight/page.tsx | 2026-11-15 | minor | G1 |  | good: Grouped fix list is clear at both widths; phone "Fix this" links are small text targets. |
| /admin/users | apps/erp/src/app/admin/users/page.tsx | 2026-11-15 | OK | G1 |  | good: Clean table on desktop, readable cards on phone. |
| /admin/users/[personId] | apps/erp/src/app/admin/users/[personId]/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286, T-589 B4b, #294 | needs fixing: Raw codes like set_pay_rate shown to users; phone page is very long. |
| /ap | apps/erp/src/app/ap/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #289, #286, T-589 B4b, #294 | could improve: Phone header is crowded, description truncated, Log invoice button squeezed. |
| /ap/invoices/[id] | apps/erp/src/app/ap/invoices/[id]/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #289, #286, T-589 B4b, #294 | needs fixing: Phone: verify-preview card splits words (De mo pur cha se); the same refusal reasons print twice; payment #1 jargon. |
| /ap/suppliers | apps/erp/src/app/ap/suppliers/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #289, #286, T-589 B4b, #294 | could improve: Phone header crowded, description truncated beside the Add supplier button. |
| /ap/suppliers/[id] | apps/erp/src/app/ap/suppliers/[id]/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #286, T-589 B4b, #294 | good: Clear details and invoice list at both widths. |
| /ap/vat | apps/erp/src/app/ap/vat/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #286, T-589 B4b, #294 | good: Simple form with a clear prompt to choose a store; fits phone width. |
| /attendance | apps/erp/src/app/attendance/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #286, T-589 B4b, #294 | good: Three clear sections with empty states; phone stacks cleanly. |
| /attendance/[dayId] | apps/erp/src/app/attendance/[dayId]/page.tsx | 2026-11-15 | not captured | G1 | T-589 B3b, #286, T-589 B4b, #294 | not captured: no record in the synthetic data |
| /attendance/lane | apps/erp/src/app/attendance/lane/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286, T-589 B4b, #294 | good: Clear at both widths. Status panels readable, empty states explained, nothing blocking. |
| /attendance/leave | apps/erp/src/app/attendance/leave/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #289, #286, T-589 B4b, #294 | good: Clear at both widths. Empty states readable and the Record leave action is easy to find. |
| /attendance/terminals | apps/erp/src/app/attendance/terminals/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286 | good: Clear set-up form and empty list at both widths. The main action is obvious. |
| /budgets | apps/erp/src/app/budgets/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286, T-589 B4b, #294 | could improve: Forty collapsed categories with no grouping. Phone tags wrap awkwardly. |
| /cash-requests | apps/erp/src/app/cash-requests/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #289, #286 | could improve: Phone-only: the request card crowds. Still out and Released figures sit awkwardly beside the name. |
| /cash-requests/[id] | apps/erp/src/app/cash-requests/[id]/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #289, #286, T-589 B4b, #294 | good: Decision and money figures clear at both widths. Approve and refuse fields well ordered. |
| /channel-settlements | apps/erp/src/app/channel-settlements/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288 | could improve: Phone save icons look small to tap. Long warning banner, but the main action stays visible. |
| /channel-settlements/record | apps/erp/src/app/channel-settlements/record/page.tsx | 2026-11-15 | minor | G4 |  | could improve: Phone-only: squeezed header, and the Post settlement button sits far down the long form. |
| /channel-settlements/review | apps/erp/src/app/channel-settlements/review/page.tsx | 2026-11-15 | minor | G4 |  | good: Clear filters and empty state at both widths. Nothing blocking. |
| /channel-settlements/upload | apps/erp/src/app/channel-settlements/upload/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #288 | could improve: A stray round floating icon sits over the upload area at both widths. No clear primary button. |
| /clock | apps/erp/src/app/clock/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287 | good: Shows the Pair this terminal screen with no sidebar. Clear and readable at both widths. |
| /commissary/catalogue | apps/erp/src/app/commissary/catalogue/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287 | could improve: Empty state tells the user to link a store but gives no link or button. |
| /commissary/discrepancies | apps/erp/src/app/commissary/discrepancies/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287 | good: Clear explanation, store picker and empty state at both widths. |
| /commissary/orders | apps/erp/src/app/commissary/orders/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #289, #287 | good: Clear explanation of branch orders and the store link at both widths. |
| /commissary/orders/[id] | apps/erp/src/app/commissary/orders/[id]/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #289, #287, T-589 B4b, #294 | good: Clear "not a branch order" message with a link to Trade orders at both widths. |
| /customers | apps/erp/src/app/customers/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288 | good: Clear table on desktop, tidy cards on phone; Add customer is easy to find. |
| /customers/[customerId] | apps/erp/src/app/customers/[customerId]/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #288 | good: Clear balance, empty states and headings at both widths. |
| /customers/price-lists | apps/erp/src/app/customers/price-lists/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288, T-589 B4b, #294 | good: Simple list with New price list button; phone intro collapsed behind a chevron. |
| /customers/price-lists/[id] | apps/erp/src/app/customers/price-lists/[id]/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #288, T-589 B4b, #294 | good: Clear empty message and Set rate button at both widths. |
| /opening-balances | apps/erp/src/app/opening-balances/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #288 | could improve: Very long 16-step checklist; the next step is hard to spot. |
| /opening-balances/stock-count | apps/erp/src/app/opening-balances/stock-count/page.tsx | 2026-11-15 | fix | G4 |  | could improve: Desktop table is clear; phone cards repeat labels and run very long. |
| /opening-balances/stock-count/sheet | apps/erp/src/app/opening-balances/stock-count/sheet/page.tsx | 2026-11-15 | minor | G4 | #289 | good: Clean printable count sheet at both widths. |
| /opening-balances/balance-sheet | apps/erp/src/app/opening-balances/balance-sheet/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #288 | needs fixing: Red error text shows raw account code 1400 to users, both widths. |
| /expenses | apps/erp/src/app/expenses/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288 | could improve: Phone "New expense" button wraps onto two lines beside the heading. |
| /expenses/[id] | apps/erp/src/app/expenses/[id]/page.tsx | 2026-11-15 | fix | G4 | #278, #289, #279, T-589 B4b, #294 | could improve: Approve blocked by jargon ("payment #1", "nameable") shown to users; otherwise layout holds. |
| /expenses/new | apps/erp/src/app/expenses/new/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288 | good: Form reads top to bottom; Save draft disabled with a clear count of missing fields. |
| /expenses/recurring | apps/erp/src/app/expenses/recurring/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #288, T-589 B4b, #294 | could improve: Long add-a-template form crowds the empty template list; Store select text cut off. |
| /expenses/reimbursements | apps/erp/src/app/expenses/reimbursements/page.tsx | 2026-11-15 | OK | G4 |  | good: Clear store picker and plain empty message at both widths. |
| /findings | apps/erp/src/app/findings/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288, T-589 B4b, #294 | good: Four summary tiles and clear cards; phone layout stacks cleanly. |
| /findings/scorecard | apps/erp/src/app/findings/scorecard/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #288, T-589 B4b, #294 | good: Clear empty-state notice and explanation panel at both widths. |
| /fixed-assets | apps/erp/src/app/fixed-assets/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288 | could improve: Phone asset card cramped; "Ask whoever looks after the server" is developer wording. |
| /fixed-assets/[id] | apps/erp/src/app/fixed-assets/[id]/page.tsx | 2026-11-15 | fix | G4 | #278, #279, T-589 B4b, #294 | good: Clean at both widths; figures, status and actions are clear. |
| /fixed-assets/new | apps/erp/src/app/fixed-assets/new/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #288 | could improve: Phone-only: the "Goes into service" dropdown text is cut off mid-word. |
| /franchise/access-log | apps/erp/src/app/franchise/access-log/page.tsx | 2026-11-15 | minor | G4 | T-589 B4b, #294 | could improve: Phone-only: the intro text is clipped to one line with an expand arrow. |
| /franchise/sales | apps/erp/src/app/franchise/sales/page.tsx | 2026-11-15 | OK | G4 |  | good: Clear empty state at both widths; nothing broken or cramped. |
| /franchise/stock | apps/erp/src/app/franchise/stock/page.tsx | 2026-11-15 | OK | G4 |  | could improve: Phone-only: the intro text is clipped with an expand arrow. |
| /inventory | apps/erp/src/app/inventory/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287 | good: Clean summary and empty state with one obvious action at both widths. |
| /inventory/counts | apps/erp/src/app/inventory/counts/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #289, #287, T-589 B4b, #294 | needs fixing: Phone: the room name wraps one letter per line and the status pill text is unreadable. |
| /inventory/counts/[id] | apps/erp/src/app/inventory/counts/[id]/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287, T-589 B4b, #294 | could improve: Both widths show an empty unlabeled row with only a red X button, which is confusing. |
| /inventory/deliveries | apps/erp/src/app/inventory/deliveries/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #289, #287, T-589 B4b, #294 | good: Clear empty state and "New delivery" action at both widths. |
| /inventory/deliveries/[id] | apps/erp/src/app/inventory/deliveries/[id]/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #287, T-589 B4b, #294 | not captured: no record in the synthetic data |
| /inventory/deliveries/inbound | apps/erp/src/app/inventory/deliveries/inbound/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287, T-589 B4b, #294 | could improve: Phone-only: the intro text is clipped with an expand arrow. |
| /inventory/deliveries/inbound/[shipmentId] | apps/erp/src/app/inventory/deliveries/inbound/[shipmentId]/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #287, T-589 B4b, #294 | not captured: no record in the synthetic data |
| /inventory/locations | apps/erp/src/app/inventory/locations/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #289, #287, T-589 B4b, #294 | good: Room card and explanation read clearly; "Add room" and "Edit" are easy to find. |
| /inventory/low-stock | apps/erp/src/app/inventory/low-stock/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Clear empty state and threshold list at both widths; phone cards are tidy. |
| /inventory/production | apps/erp/src/app/inventory/production/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Record types and "New production record" action are clear at both widths. |
| /inventory/production/[id] | apps/erp/src/app/inventory/production/[id]/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #287, T-589 B4b, #294 | not captured: no record in the synthetic data |
| /inventory/production/recipes | apps/erp/src/app/inventory/production/recipes/page.tsx | 2026-11-15 | OK | G2 |  | good: Empty state, tabs and "New recipe" button are clear at both widths. |
| /inventory/production/recipes/[id] | apps/erp/src/app/inventory/production/recipes/[id]/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #287 | not captured: no record in the synthetic data |
| /inventory/production/recipes/new | apps/erp/src/app/inventory/production/recipes/new/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287 | good: Form is long on phone but labelled clearly; Save is easy to reach. |
| /inventory/returns | apps/erp/src/app/inventory/returns/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Clean at both widths; empty states explain themselves. |
| /inventory/transfers | apps/erp/src/app/inventory/transfers/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Clear empty-state message at both widths; nothing cut off. |
| /inventory/usage | apps/erp/src/app/inventory/usage/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #289, #287, T-589 B4b, #294 | good: Clean layout; empty records state and New record button are obvious. |
| /inventory/usage/[id] | apps/erp/src/app/inventory/usage/[id]/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #287, T-589 B4b, #294 | not captured: no record in the synthetic data |
| /items | apps/erp/src/app/items/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Table on desktop, cards on phone; both readable. |
| /items/[id] | apps/erp/src/app/items/[id]/page.tsx | 2026-11-15 | fix | G2 | #278, T-589 B3c, #287, #279, T-589 B4b, #294 | could improve: Very long stacked cards on desktop; on phone, Item details sits at the bottom. |
| /items/import | apps/erp/src/app/items/import/page.tsx | 2026-11-15 | minor | G2 |  | good: Simple form, readable at both widths. |
| /kitchen | apps/erp/src/app/kitchen/page.tsx | 2026-11-15 | minor | G2 |  | good: Clear and readable at both widths; empty state explains the next step. |
| /liabilities | apps/erp/src/app/liabilities/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288, T-589 B4b, #294 | needs fixing: Phone: the obligation name wraps one letter per line in the record card (same card fault as /prepaid; Opus-checked). |
| /liabilities/[id] | apps/erp/src/app/liabilities/[id]/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #288, T-589 B4b, #294 | good: Summary figures and actions clear at both widths. |
| /liabilities/unpaid | apps/erp/src/app/liabilities/unpaid/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #288, T-589 B4b, #294 | good: Clear grouped totals at both widths. |
| /loans | apps/erp/src/app/loans/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288 | good: Clean table on desktop and cards on phone. |
| /loans/[id] | apps/erp/src/app/loans/[id]/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #288, T-589 B4b, #294 | good: Figures and actions clear at both widths. |
| /menu | apps/erp/src/app/menu/page.tsx | 2026-11-15 | fix | G2 | #278, T-589 B3c, #289, #287, #279, T-589 B4b, #294 | could improve: Desktop works; on phone the filters stack and push the list down. |
| /menu/hours | apps/erp/src/app/menu/hours/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287 | good: Clear empty state with one obvious Add hours button. |
| /menu/items/[id] | apps/erp/src/app/menu/items/[id]/page.tsx | 2026-11-15 | fix | G2 | #278, T-589 B3c, #287, #279, T-589 B4b, #294 | could improve: Long stacked page; the variant save icon is disabled with little explanation. |
| /menu/prices | apps/erp/src/app/menu/prices/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Clear at both widths; each price slot and Set price button is obvious. |
| /menu/requests | apps/erp/src/app/menu/requests/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Clean at both widths; empty states read clearly. |
| /menu/usage-source | apps/erp/src/app/menu/usage-source/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287, T-589 B4b, #294 | could improve: Long inline link form crowds the page, especially on phone. |
| /money-accounts | apps/erp/src/app/money-accounts/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288 | could improve: Desktop tables are dense; phone needs chevron taps to see details. |
| /money-transfers | apps/erp/src/app/money-transfers/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288, T-589 B4b, #294 | good: Clear table on desktop; readable stacked cards on phone. |
| /owners | apps/erp/src/app/owners/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288 | good: Simple table on desktop, readable card on phone. |
| /owners/[id] | apps/erp/src/app/owners/[id]/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288, T-589 B4b, #294 | good: Summary cards and drawing actions are clear at both widths. |
| /payroll | apps/erp/src/app/payroll/page.tsx | 2026-11-15 | fix | G3 | #278, #279, T-589 B4b, #294 | could improve: Phone stacks many controls before the records; desktop settings line is busy. |
| /payroll/rates | apps/erp/src/app/payroll/rates/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #289, #288 | could improve: Dense rate forms; phone rows run long and save buttons sit apart from fields. |
| /payroll/separations | apps/erp/src/app/payroll/separations/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288 | good: Clear empty states and store picker at both widths. |
| /payroll/statutory-payments | apps/erp/src/app/payroll/statutory-payments/page.tsx | 2026-11-15 | OK | G3 | T-589 B3d, #288, T-589 B4b, #294 | good: Clear filters and empty state at both widths. |
| /payroll/statutory-payments/[id] | apps/erp/src/app/payroll/statutory-payments/[id]/page.tsx | 2026-11-15 | not captured | G3 | T-589 B3d, #288, T-589 B4b, #294 | not captured: no record in the synthetic data |
| /payroll/statutory-payments/month | apps/erp/src/app/payroll/statutory-payments/month/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288, T-589 B4b, #294 | good: Clean at both widths; info box and empty state read clearly. |
| /payroll/statutory-payments/new | apps/erp/src/app/payroll/statutory-payments/new/page.tsx | 2026-11-15 | OK | G3 | T-589 B4b, #294 | good: Clean at both widths; form and empty state are clear. |
| /payroll/thirteenth-month | apps/erp/src/app/payroll/thirteenth-month/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288 | good: Clean at both widths; on phone the Show button drops to its own row. |
| /documents | apps/erp/src/app/documents/page.tsx |  | not reviewed | T-584 |  | good: Clear filters and empty state; phone intro collapsed behind a chevron. |
| /documents/[id] | apps/erp/src/app/documents/[id]/page.tsx |  | not reviewed | T-584 |  | not captured: no record in the synthetic data |
| /documents/[id]/print | apps/erp/src/app/documents/[id]/print/page.tsx |  | not reviewed | T-584 |  | not captured: no record in the synthetic data |
| /documents/new | apps/erp/src/app/documents/new/page.tsx |  | not reviewed | T-584 |  | good: Clear empty state with a short explanation at both widths. |
| /documents/templates | apps/erp/src/app/documents/templates/page.tsx |  | not reviewed | T-584 |  | could improve: Long new-template form sits above the records; Kind select text truncated on desktop. |
| /pos | apps/erp/src/app/pos/page.tsx | 2026-11-15 | minor | G3 |  | good: Clean at both widths; tab bar sits at the bottom on phone. |
| /pos/kitchen | apps/erp/src/app/pos/kitchen/page.tsx | 2026-11-15 | minor | G3 |  | good: Clean at both widths; empty state reads clearly on the dark screen. |
| /pos/receipts | apps/erp/src/app/pos/receipts/page.tsx | 2026-11-15 | minor | G3 |  | could improve: Empty placeholder card only, saying receipts are coming in the next update. |
| /pos/refills | apps/erp/src/app/pos/refills/page.tsx | 2026-11-15 | minor | G3 |  | good: Clean at both widths; on phone the ask-for-refill panel stacks above the list. |
| /pos/till | apps/erp/src/app/pos/till/page.tsx | 2026-11-15 | minor | G3 |  | good: Clean at both widths; one info banner explains the till is on the store tablet. |
| /prepaid | apps/erp/src/app/prepaid/page.tsx | 2026-11-15 | fix | G4 | T-589 B3d, #289, #288 | needs fixing: Phone only: item table squeezed, name breaks letter by letter and text overlaps. |
| /prepaid/[id] | apps/erp/src/app/prepaid/[id]/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288, T-589 B4b, #294 | needs fixing: Phone: month names split mid-word (Novembe r, Septemb er) in the schedule cards (same card fault; Opus-checked). |
| /remittance | apps/erp/src/app/remittance/page.tsx | 2026-11-15 | fix | G4 | #278, #289, #279 | good: Clean at both widths; cash policy and Edit button are easy to find. |
| /reports/ap-aging | apps/erp/src/app/reports/ap-aging/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286 | good: Clean at both widths; Download CSV wraps to two lines on phone. |
| /reports/ar-aging | apps/erp/src/app/reports/ar-aging/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #286 | good: Clean at both widths; empty state and delivery-platform note are clear. |
| /reports/balance-sheet | apps/erp/src/app/reports/balance-sheet/page.tsx | 2026-11-15 | fix | G1 | #277, T-589 B3b, #286 | good: Clean at both widths; filters stack neatly on phone. |
| /reports/cash-flow | apps/erp/src/app/reports/cash-flow/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286 | good: Clean at both widths; reconciliation banner reads clearly at both sizes. |
| /reports/dual-run | apps/erp/src/app/reports/dual-run/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a, T-589 B3b, #286, #283 | good: Clear empty state with a go-live check link; readable at both widths. |
| /reports/dual-run/[store]/[week] | apps/erp/src/app/reports/dual-run/[store]/[week]/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a, T-589 B3b, #286, #283 | good: Clear "no compare report" empty state with a back link; readable at both widths. |
| /reports/dual-run/pack | apps/erp/src/app/reports/dual-run/pack/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a, T-589 B3b, #286, #283 | good: Red "Not signable" box and day counts are clear at both widths. |
| /reports/expense-items | apps/erp/src/app/reports/expense-items/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #286 | good: Empty state and filters are clear; phone description truncates with an expand chevron. |
| /reports/income-statement | apps/erp/src/app/reports/income-statement/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286 | good: Filters, empty state and export are clear and stack cleanly on phone. |
| /reports/journal-lines | apps/erp/src/app/reports/journal-lines/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a, T-589 B3b, #286, #283 | good: Tells the user to open it from an account row; nothing is broken at either width. |
| /reports/pos-data | apps/erp/src/app/reports/pos-data/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286 | good: Download chips wrap cleanly into a grid on phone. |
| /reports/pos-reconciliation | apps/erp/src/app/reports/pos-reconciliation/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #286 | good: "Not comparable" panel is readable at both widths; labels are plain enough. |
| /reports/sales-rollup | apps/erp/src/app/reports/sales-rollup/page.tsx | 2026-11-15 | minor | G1 | T-589 B3b, #286 | good: Clear empty state and filters; stacks cleanly on phone. |
| /reports/store-comparison | apps/erp/src/app/reports/store-comparison/page.tsx | 2026-11-15 | fix | G1 | T-589 B3b, #289, #286 | needs fixing: Phone: each card shows one store, and its name and opened date run into the figure. |
| /reports/trial-balance | apps/erp/src/app/reports/trial-balance/page.tsx | 2026-11-15 | fix | G1 | #277, T-589 B3b, #286 | good: Clear empty state and filters; stacks cleanly on phone. |
| /sales-days | apps/erp/src/app/sales-days/page.tsx | 2026-11-15 | minor | G3 | T-589 B3a, T-589 B3d, #288, #283 | good: Warnings, filters and list are clear; phone list cards are readable. |
| /sales-days/[id] | apps/erp/src/app/sales-days/[id]/page.tsx | 2026-11-15 | minor | G3 | T-589 B3a, T-589 B3d, #289, #288, #283, T-589 B4b, #294 | good: Submit and withdraw actions are visible; layout is clean at both widths. |
| /sales-days/[id]/edit | apps/erp/src/app/sales-days/[id]/edit/page.tsx | 2026-11-15 | fix | G3 | T-589 B3a, T-589 B3d, #288, #283 | could improve: Very long inline form on phone; Save sits at the bottom, far from the top of the form. |
| /sales-days/new | apps/erp/src/app/sales-days/new/page.tsx | 2026-11-15 | fix | G3 | T-589 B3a, T-589 B3d, #288, #283, T-589 B4b, #294 | could improve: Store appears twice (dropdown plus read-only field), adding clutter at both widths. |
| /service-charge | apps/erp/src/app/service-charge/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288 | good: Clean and readable at both widths; empty state says nothing is held. |
| /settings | apps/erp/src/app/settings/page.tsx | 2026-11-15 | minor | G3 |  | good: Clear grouped menu at both widths; search box sits at the top. |
| /settings/attendance | apps/erp/src/app/settings/attendance/page.tsx | 2026-11-15 | fix | G3 | #278, #289, #279 | good: Clear summary and leave list at both widths; main action visible. |
| /settings/business-rules | apps/erp/src/app/settings/business-rules/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288, T-589 B4b, #294 | good: Grouped rules with visible change buttons, readable at both widths. |
| /settings/expense-categories | apps/erp/src/app/settings/expense-categories/page.tsx | 2026-11-15 | fix | G3 | T-589 B3d, #288 | could improve: Desktop table is very long and crowded; phone list is long with tiny text. |
| /settings/organization | apps/erp/src/app/settings/organization/page.tsx | 2026-11-15 | fix | G3 | #278, #279 | good: Warning banner and fields clear at both widths; Edit easy to find. |
| /settings/pos-link | apps/erp/src/app/settings/pos-link/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288, T-589 B4b, #294 | good: Clear status badges and warning at both widths. |
| /settings/pos-tablet | apps/erp/src/app/settings/pos-tablet/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288, T-589 B4b, #294 | good: Stacked store cards readable at both widths; text-heavy but clear. |
| /settings/sales-channels | apps/erp/src/app/settings/sales-channels/page.tsx | 2026-11-15 | fix | G3 | #278, #289, #279, T-589 B4b, #294 | could improve: Long inline add-channel form crowds the records at both widths; Save is disabled. |
| /settings/usage-tolerance | apps/erp/src/app/settings/usage-tolerance/page.tsx | 2026-11-15 | fix | G3 | T-589 B3d, #288, T-589 B4b, #294 | could improve: Phone only: the Allowed difference label wraps and its red asterisk floats away. |
| /settings/wastage-monitor | apps/erp/src/app/settings/wastage-monitor/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288 | could improve: Desktop store select cuts off the Monitor option text; otherwise clean at both widths. |
| /setup | apps/erp/src/app/setup/page.tsx | 2026-11-15 | OK | G3 |  | good: Signed out it opens on sign-in with a "setup window has closed" message; clear at both widths. |
| /sign-in | apps/erp/src/app/sign-in/page.tsx | 2026-11-15 | OK | G3 |  | good: Clean centered sign-in at both widths; both sign-in paths visible. |
| /staff | apps/erp/src/app/staff/page.tsx | 2026-11-15 | fix | G3 | #277 | good: Clear cards and PIN section at both widths; Hire button visible. |
| /staff/[employmentId] | apps/erp/src/app/staff/[employmentId]/page.tsx | 2026-11-15 | fix | G3 | #278, #279, #285, T-590 A1, #292 | good: Profile sections clear at both widths; Issue PIN action visible. |
| /staff/[employmentId]/credentials | apps/erp/src/app/staff/[employmentId]/credentials/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #288 | could improve: Testing-only fingerprint block in bright yellow dominates both widths; reads as a developer form. |
| /staff/hire | apps/erp/src/app/staff/hire/page.tsx | 2026-11-15 | minor | G3 | T-589 B3d, #289, #288 | could improve: Long stacked form on phone; intro text cut off behind a chevron (phone). |
| /statutory-discounts | apps/erp/src/app/statutory-discounts/page.tsx | 2026-11-15 | minor | G4 | T-589 B3d, #289, #288 | could improve: Phone intro cut off behind a chevron; dense legal warning copy crowds the top of the page. |
| /till | apps/erp/src/app/till/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #289, #287 | good: Clear "Open shift" action and empty state at both widths; layout clean. |
| /trade/orders | apps/erp/src/app/trade/orders/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #289, #287, T-589 B4b, #294 | good: Clear New trade order action and readable list at both widths; phone uses cards. |
| /trade/orders/[id] | apps/erp/src/app/trade/orders/[id]/page.tsx | 2026-11-15 | fix | G2 | #277, T-589 B3c, #289, #287, T-589 B4b, #294 | good: Draft status, Dispatch action and lines are clear at both widths. |
| /trade/orders/[id]/print | apps/erp/src/app/trade/orders/[id]/print/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #287, T-589 B4b, #294 | good: Clear "Nothing to print" message explains the fix at both widths. |
| /trade/returns | apps/erp/src/app/trade/returns/page.tsx | 2026-11-15 | fix | G2 | T-589 B3c, #287 | good: Clear empty states and one Show action; clean at both widths. |
| /wastage | apps/erp/src/app/wastage/page.tsx | 2026-11-15 | minor | G2 | T-589 B3c, #289, #287 | good: Clear Record wastage action and empty state; clean at both widths. |
| /wastage/[id] | apps/erp/src/app/wastage/[id]/page.tsx | 2026-11-15 | not captured | G2 | T-589 B3c, #287 | not captured: no record in the synthetic data |
