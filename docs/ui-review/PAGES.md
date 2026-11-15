# UI review coverage ledger (T-589)

One row per `apps/erp/src/app/**/page.tsx`, guarded by `apps/erp/tests/t589-pages-ledger.test.ts`.
Seeded from the 15 Nov 2026 full-page scan (`shareat-ui-scan/2026-11-15/review-G1..G4.md`). A new page must get a row here.
Status: OK, minor, fix, not captured, not reviewed. "Fixed in PR" is filled by each T-589 batch.

| route | file | last reviewed | status | findings ref | fixed in PR |
|---|---|---|---|---|---|
| / | apps/erp/src/app/page.tsx | 2026-11-15 | fix | G3 | T-589 B3a |
| /admin/access-defaults | apps/erp/src/app/admin/access-defaults/page.tsx | 2026-11-15 | fix | G1 |  |
| /admin/pos-tablets | apps/erp/src/app/admin/pos-tablets/page.tsx | 2026-11-15 | fix | G1 |  |
| /admin/prerequisite-refusals | apps/erp/src/app/admin/prerequisite-refusals/page.tsx | 2026-11-15 | minor | G1 |  |
| /admin/stores | apps/erp/src/app/admin/stores/page.tsx | 2026-11-15 | minor | G1 |  |
| /admin/stores/[id] | apps/erp/src/app/admin/stores/[id]/page.tsx | 2026-11-15 | fix | G1 |  |
| /admin/stores/[id]/pos-preflight | apps/erp/src/app/admin/stores/[id]/pos-preflight/page.tsx | 2026-11-15 | minor | G1 |  |
| /admin/users | apps/erp/src/app/admin/users/page.tsx | 2026-11-15 | OK | G1 |  |
| /admin/users/[personId] | apps/erp/src/app/admin/users/[personId]/page.tsx | 2026-11-15 | fix | G1 |  |
| /ap | apps/erp/src/app/ap/page.tsx | 2026-11-15 | minor | G1 |  |
| /ap/invoices/[id] | apps/erp/src/app/ap/invoices/[id]/page.tsx | 2026-11-15 | fix | G1 |  |
| /ap/suppliers | apps/erp/src/app/ap/suppliers/page.tsx | 2026-11-15 | fix | G1 |  |
| /ap/suppliers/[id] | apps/erp/src/app/ap/suppliers/[id]/page.tsx | 2026-11-15 | minor | G1 |  |
| /ap/vat | apps/erp/src/app/ap/vat/page.tsx | 2026-11-15 | minor | G1 |  |
| /attendance | apps/erp/src/app/attendance/page.tsx | 2026-11-15 | minor | G1 |  |
| /attendance/[dayId] | apps/erp/src/app/attendance/[dayId]/page.tsx | 2026-11-15 | not captured | G1 |  |
| /attendance/lane | apps/erp/src/app/attendance/lane/page.tsx | 2026-11-15 | fix | G1 |  |
| /attendance/leave | apps/erp/src/app/attendance/leave/page.tsx | 2026-11-15 | minor | G1 |  |
| /attendance/terminals | apps/erp/src/app/attendance/terminals/page.tsx | 2026-11-15 | fix | G1 |  |
| /budgets | apps/erp/src/app/budgets/page.tsx | 2026-11-15 | fix | G1 |  |
| /cash-requests | apps/erp/src/app/cash-requests/page.tsx | 2026-11-15 | minor | G1 |  |
| /cash-requests/[id] | apps/erp/src/app/cash-requests/[id]/page.tsx | 2026-11-15 | fix | G1 |  |
| /channel-settlements | apps/erp/src/app/channel-settlements/page.tsx | 2026-11-15 | minor | G4 |  |
| /channel-settlements/record | apps/erp/src/app/channel-settlements/record/page.tsx | 2026-11-15 | minor | G4 |  |
| /channel-settlements/review | apps/erp/src/app/channel-settlements/review/page.tsx | 2026-11-15 | minor | G4 |  |
| /channel-settlements/upload | apps/erp/src/app/channel-settlements/upload/page.tsx | 2026-11-15 | minor | G4 |  |
| /clock | apps/erp/src/app/clock/page.tsx | 2026-11-15 | minor | G2 |  |
| /commissary/catalogue | apps/erp/src/app/commissary/catalogue/page.tsx | 2026-11-15 | minor | G2 |  |
| /commissary/discrepancies | apps/erp/src/app/commissary/discrepancies/page.tsx | 2026-11-15 | fix | G2 |  |
| /commissary/orders | apps/erp/src/app/commissary/orders/page.tsx | 2026-11-15 | minor | G2 |  |
| /commissary/orders/[id] | apps/erp/src/app/commissary/orders/[id]/page.tsx | 2026-11-15 | not captured | G2 |  |
| /customers | apps/erp/src/app/customers/page.tsx | 2026-11-15 | fix | G4 |  |
| /customers/[customerId] | apps/erp/src/app/customers/[customerId]/page.tsx | 2026-11-15 | minor | G4 |  |
| /customers/price-lists | apps/erp/src/app/customers/price-lists/page.tsx | 2026-11-15 | minor | G4 |  |
| /customers/price-lists/[id] | apps/erp/src/app/customers/price-lists/[id]/page.tsx | 2026-11-15 | minor | G4 |  |
| /cutover | apps/erp/src/app/cutover/page.tsx | 2026-11-15 | fix | G4 |  |
| /cutover/count | apps/erp/src/app/cutover/count/page.tsx | 2026-11-15 | fix | G4 |  |
| /cutover/count/sheet | apps/erp/src/app/cutover/count/sheet/page.tsx | 2026-11-15 | minor | G4 |  |
| /cutover/opening | apps/erp/src/app/cutover/opening/page.tsx | 2026-11-15 | fix | G4 |  |
| /expenses | apps/erp/src/app/expenses/page.tsx | 2026-11-15 | fix | G4 |  |
| /expenses/[id] | apps/erp/src/app/expenses/[id]/page.tsx | 2026-11-15 | fix | G4 | #278 |
| /expenses/new | apps/erp/src/app/expenses/new/page.tsx | 2026-11-15 | fix | G4 |  |
| /expenses/recurring | apps/erp/src/app/expenses/recurring/page.tsx | 2026-11-15 | fix | G4 |  |
| /expenses/reimbursements | apps/erp/src/app/expenses/reimbursements/page.tsx | 2026-11-15 | OK | G4 |  |
| /findings | apps/erp/src/app/findings/page.tsx | 2026-11-15 | fix | G4 |  |
| /findings/scorecard | apps/erp/src/app/findings/scorecard/page.tsx | 2026-11-15 | minor | G4 |  |
| /fixed-assets | apps/erp/src/app/fixed-assets/page.tsx | 2026-11-15 | fix | G4 |  |
| /fixed-assets/[id] | apps/erp/src/app/fixed-assets/[id]/page.tsx | 2026-11-15 | fix | G4 | #278 |
| /fixed-assets/new | apps/erp/src/app/fixed-assets/new/page.tsx | 2026-11-15 | minor | G4 |  |
| /franchise/access-log | apps/erp/src/app/franchise/access-log/page.tsx | 2026-11-15 | minor | G4 |  |
| /franchise/sales | apps/erp/src/app/franchise/sales/page.tsx | 2026-11-15 | OK | G4 |  |
| /franchise/stock | apps/erp/src/app/franchise/stock/page.tsx | 2026-11-15 | OK | G4 |  |
| /inventory | apps/erp/src/app/inventory/page.tsx | 2026-11-15 | fix | G2 |  |
| /inventory/counts | apps/erp/src/app/inventory/counts/page.tsx | 2026-11-15 | fix | G2 |  |
| /inventory/counts/[id] | apps/erp/src/app/inventory/counts/[id]/page.tsx | 2026-11-15 | fix | G2 |  |
| /inventory/deliveries | apps/erp/src/app/inventory/deliveries/page.tsx | 2026-11-15 | minor | G2 |  |
| /inventory/deliveries/[id] | apps/erp/src/app/inventory/deliveries/[id]/page.tsx | 2026-11-15 | not captured | G2 |  |
| /inventory/deliveries/inbound | apps/erp/src/app/inventory/deliveries/inbound/page.tsx | 2026-11-15 | minor | G2 |  |
| /inventory/deliveries/inbound/[shipmentId] | apps/erp/src/app/inventory/deliveries/inbound/[shipmentId]/page.tsx | 2026-11-15 | not captured | G2 |  |
| /inventory/locations | apps/erp/src/app/inventory/locations/page.tsx | 2026-11-15 | minor | G2 |  |
| /inventory/low-stock | apps/erp/src/app/inventory/low-stock/page.tsx | 2026-11-15 | fix | G2 |  |
| /inventory/production | apps/erp/src/app/inventory/production/page.tsx | 2026-11-15 | minor | G2 |  |
| /inventory/production/[id] | apps/erp/src/app/inventory/production/[id]/page.tsx | 2026-11-15 | not captured | G2 |  |
| /inventory/production/recipes | apps/erp/src/app/inventory/production/recipes/page.tsx | 2026-11-15 | OK | G2 |  |
| /inventory/production/recipes/[id] | apps/erp/src/app/inventory/production/recipes/[id]/page.tsx | 2026-11-15 | not captured | G2 |  |
| /inventory/production/recipes/new | apps/erp/src/app/inventory/production/recipes/new/page.tsx | 2026-11-15 | fix | G2 |  |
| /inventory/returns | apps/erp/src/app/inventory/returns/page.tsx | 2026-11-15 | fix | G2 |  |
| /inventory/transfers | apps/erp/src/app/inventory/transfers/page.tsx | 2026-11-15 | fix | G2 |  |
| /inventory/usage | apps/erp/src/app/inventory/usage/page.tsx | 2026-11-15 | minor | G2 |  |
| /inventory/usage/[id] | apps/erp/src/app/inventory/usage/[id]/page.tsx | 2026-11-15 | not captured | G2 |  |
| /items | apps/erp/src/app/items/page.tsx | 2026-11-15 | minor | G2 |  |
| /items/[id] | apps/erp/src/app/items/[id]/page.tsx | 2026-11-15 | fix | G2 | #278 |
| /items/import | apps/erp/src/app/items/import/page.tsx | 2026-11-15 | minor | G2 |  |
| /kitchen | apps/erp/src/app/kitchen/page.tsx | 2026-11-15 | minor | G2 |  |
| /liabilities | apps/erp/src/app/liabilities/page.tsx | 2026-11-15 | minor | G4 |  |
| /liabilities/[id] | apps/erp/src/app/liabilities/[id]/page.tsx | 2026-11-15 | fix | G4 |  |
| /liabilities/unpaid | apps/erp/src/app/liabilities/unpaid/page.tsx | 2026-11-15 | minor | G4 |  |
| /loans | apps/erp/src/app/loans/page.tsx | 2026-11-15 | minor | G4 |  |
| /loans/[id] | apps/erp/src/app/loans/[id]/page.tsx | 2026-11-15 | minor | G4 |  |
| /menu | apps/erp/src/app/menu/page.tsx | 2026-11-15 | fix | G2 | #278 |
| /menu/hours | apps/erp/src/app/menu/hours/page.tsx | 2026-11-15 | minor | G2 |  |
| /menu/items/[id] | apps/erp/src/app/menu/items/[id]/page.tsx | 2026-11-15 | fix | G2 | #278 |
| /menu/prices | apps/erp/src/app/menu/prices/page.tsx | 2026-11-15 | minor | G2 |  |
| /menu/requests | apps/erp/src/app/menu/requests/page.tsx | 2026-11-15 | minor | G2 |  |
| /menu/usage-source | apps/erp/src/app/menu/usage-source/page.tsx | 2026-11-15 | fix | G2 |  |
| /money-accounts | apps/erp/src/app/money-accounts/page.tsx | 2026-11-15 | fix | G4 |  |
| /money-transfers | apps/erp/src/app/money-transfers/page.tsx | 2026-11-15 | minor | G4 |  |
| /owners | apps/erp/src/app/owners/page.tsx | 2026-11-15 | minor | G4 |  |
| /owners/[id] | apps/erp/src/app/owners/[id]/page.tsx | 2026-11-15 | fix | G4 |  |
| /payroll | apps/erp/src/app/payroll/page.tsx | 2026-11-15 | fix | G3 | #278 |
| /payroll/rates | apps/erp/src/app/payroll/rates/page.tsx | 2026-11-15 | minor | G3 |  |
| /payroll/separations | apps/erp/src/app/payroll/separations/page.tsx | 2026-11-15 | minor | G3 |  |
| /payroll/statutory-payments | apps/erp/src/app/payroll/statutory-payments/page.tsx | 2026-11-15 | OK | G3 |  |
| /payroll/statutory-payments/[id] | apps/erp/src/app/payroll/statutory-payments/[id]/page.tsx | 2026-11-15 | not captured | G3 |  |
| /payroll/statutory-payments/month | apps/erp/src/app/payroll/statutory-payments/month/page.tsx | 2026-11-15 | minor | G3 |  |
| /payroll/statutory-payments/new | apps/erp/src/app/payroll/statutory-payments/new/page.tsx | 2026-11-15 | OK | G3 |  |
| /payroll/thirteenth-month | apps/erp/src/app/payroll/thirteenth-month/page.tsx | 2026-11-15 | minor | G3 |  |
| /pos | apps/erp/src/app/pos/page.tsx | 2026-11-15 | minor | G3 |  |
| /pos/kitchen | apps/erp/src/app/pos/kitchen/page.tsx | 2026-11-15 | minor | G3 |  |
| /pos/receipts | apps/erp/src/app/pos/receipts/page.tsx | 2026-11-15 | minor | G3 |  |
| /pos/refills | apps/erp/src/app/pos/refills/page.tsx | 2026-11-15 | minor | G3 |  |
| /pos/till | apps/erp/src/app/pos/till/page.tsx | 2026-11-15 | minor | G3 |  |
| /prepaid | apps/erp/src/app/prepaid/page.tsx | 2026-11-15 | fix | G4 |  |
| /prepaid/[id] | apps/erp/src/app/prepaid/[id]/page.tsx | 2026-11-15 | minor | G4 |  |
| /remittance | apps/erp/src/app/remittance/page.tsx | 2026-11-15 | fix | G4 | #278 |
| /reports/ap-aging | apps/erp/src/app/reports/ap-aging/page.tsx | 2026-11-15 | fix | G1 |  |
| /reports/ar-aging | apps/erp/src/app/reports/ar-aging/page.tsx | 2026-11-15 | minor | G1 |  |
| /reports/balance-sheet | apps/erp/src/app/reports/balance-sheet/page.tsx | 2026-11-15 | fix | G1 | #277 |
| /reports/cash-flow | apps/erp/src/app/reports/cash-flow/page.tsx | 2026-11-15 | fix | G1 |  |
| /reports/dual-run | apps/erp/src/app/reports/dual-run/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a |
| /reports/dual-run/[store]/[week] | apps/erp/src/app/reports/dual-run/[store]/[week]/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a |
| /reports/dual-run/pack | apps/erp/src/app/reports/dual-run/pack/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a |
| /reports/expense-items | apps/erp/src/app/reports/expense-items/page.tsx | 2026-11-15 | minor | G1 |  |
| /reports/income-statement | apps/erp/src/app/reports/income-statement/page.tsx | 2026-11-15 | fix | G1 |  |
| /reports/journal-lines | apps/erp/src/app/reports/journal-lines/page.tsx | 2026-11-15 | minor | G1 | T-589 B3a |
| /reports/pos-data | apps/erp/src/app/reports/pos-data/page.tsx | 2026-11-15 | fix | G1 |  |
| /reports/pos-reconciliation | apps/erp/src/app/reports/pos-reconciliation/page.tsx | 2026-11-15 | fix | G1 |  |
| /reports/sales-rollup | apps/erp/src/app/reports/sales-rollup/page.tsx | 2026-11-15 | minor | G1 |  |
| /reports/store-comparison | apps/erp/src/app/reports/store-comparison/page.tsx | 2026-11-15 | fix | G1 |  |
| /reports/trial-balance | apps/erp/src/app/reports/trial-balance/page.tsx | 2026-11-15 | fix | G1 | #277 |
| /sales-days | apps/erp/src/app/sales-days/page.tsx | 2026-11-15 | minor | G3 | T-589 B3a |
| /sales-days/[id] | apps/erp/src/app/sales-days/[id]/page.tsx | 2026-11-15 | minor | G3 | T-589 B3a |
| /sales-days/[id]/edit | apps/erp/src/app/sales-days/[id]/edit/page.tsx | 2026-11-15 | fix | G3 | T-589 B3a |
| /sales-days/new | apps/erp/src/app/sales-days/new/page.tsx | 2026-11-15 | fix | G3 | T-589 B3a |
| /service-charge | apps/erp/src/app/service-charge/page.tsx | 2026-11-15 | minor | G4 |  |
| /settings | apps/erp/src/app/settings/page.tsx | 2026-11-15 | minor | G3 |  |
| /settings/attendance | apps/erp/src/app/settings/attendance/page.tsx | 2026-11-15 | fix | G3 | #278 |
| /settings/business-rules | apps/erp/src/app/settings/business-rules/page.tsx | 2026-11-15 | minor | G3 |  |
| /settings/expense-categories | apps/erp/src/app/settings/expense-categories/page.tsx | 2026-11-15 | fix | G3 |  |
| /settings/organization | apps/erp/src/app/settings/organization/page.tsx | 2026-11-15 | fix | G3 | #278 |
| /settings/pos-link | apps/erp/src/app/settings/pos-link/page.tsx | 2026-11-15 | minor | G3 |  |
| /settings/pos-tablet | apps/erp/src/app/settings/pos-tablet/page.tsx | 2026-11-15 | minor | G3 |  |
| /settings/sales-channels | apps/erp/src/app/settings/sales-channels/page.tsx | 2026-11-15 | fix | G3 | #278 |
| /settings/usage-tolerance | apps/erp/src/app/settings/usage-tolerance/page.tsx | 2026-11-15 | fix | G3 |  |
| /settings/wastage-monitor | apps/erp/src/app/settings/wastage-monitor/page.tsx | 2026-11-15 | minor | G3 |  |
| /setup | apps/erp/src/app/setup/page.tsx | 2026-11-15 | OK | G3 |  |
| /sign-in | apps/erp/src/app/sign-in/page.tsx | 2026-11-15 | OK | G3 |  |
| /staff | apps/erp/src/app/staff/page.tsx | 2026-11-15 | fix | G3 | #277 |
| /staff/[employmentId] | apps/erp/src/app/staff/[employmentId]/page.tsx | 2026-11-15 | fix | G3 | #278 |
| /staff/[employmentId]/credentials | apps/erp/src/app/staff/[employmentId]/credentials/page.tsx | 2026-11-15 | minor | G3 |  |
| /staff/hire | apps/erp/src/app/staff/hire/page.tsx | 2026-11-15 | minor | G3 |  |
| /statutory-discounts | apps/erp/src/app/statutory-discounts/page.tsx | 2026-11-15 | minor | G4 |  |
| /till | apps/erp/src/app/till/page.tsx | 2026-11-15 | fix | G2 |  |
| /trade/orders | apps/erp/src/app/trade/orders/page.tsx | 2026-11-15 | fix | G2 |  |
| /trade/orders/[id] | apps/erp/src/app/trade/orders/[id]/page.tsx | 2026-11-15 | fix | G2 | #277 |
| /trade/orders/[id]/print | apps/erp/src/app/trade/orders/[id]/print/page.tsx | 2026-11-15 | not captured | G2 |  |
| /trade/returns | apps/erp/src/app/trade/returns/page.tsx | 2026-11-15 | fix | G2 |  |
| /wastage | apps/erp/src/app/wastage/page.tsx | 2026-11-15 | minor | G2 |  |
| /wastage/[id] | apps/erp/src/app/wastage/[id]/page.tsx | 2026-11-15 | not captured | G2 |  |
