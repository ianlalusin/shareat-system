# T-448 — Apply Ian's ERP multi-device UI skill to dashboards and detail views

Status: in progress, authorized 2026-10-20: install the supplied skill and start with every dashboard and detail view.

## Contract

Installed `erp-multi-device-ui` from Ian's Downloads file; retain the source document unchanged.
Use its audit/spec/generate sequence. Existing rulings remain: plain white content, warm sidebar, compact desktop
controls, short fields grouped by meaning, full financial amounts readable. The supplied document is design guidance,
not authority to alter capabilities, postings, routes, queries, permissions or saved values.

## Assessment and bounded research

Build on existing Page, DetailLayout and SplitWorkspace. One ERP dashboard and 27 dynamic detail routes are present.
Six detail routes already have a summary rail and items has a split workspace; avoid duplicate layout systems.
Usage counts are unavailable; this is Ian's directly reported daily usability problem. Shared layout changes reach
all these views without a new dependency or data migration. Per-route action regrouping needs explicit review.
Legacy ERP CompactKpiCard already uses compact cards; POS supplies dashboard and session-detail patterns; CUSTOMER
and Website are customer-facing rather than record workspaces. All references remain read-only.
[Carbon's shell](https://github.com/carbon-design-system/carbon/blob/main/packages/react/src/components/UIShell/README.md)
supports contextual panels; [W3C table guidance](https://design-system.w3.org/styles/tables.html) preserves table grids.
[shadcn/ui](https://github.com/shadcn-ui/ui) is MIT; adopting another component stack adds no benefit over existing UI.
Do not adopt motion, new libraries, clipped amounts or automatic conversion of interactive financial tables to cards.

## Scope

`apps/erp/src/components/shell/Page.tsx`, `DetailLayout.tsx`, `apps/erp/src/components/dashboard/**`,
`apps/erp/src/app/globals.css`, `apps/erp/src/app/page.tsx`, `apps/erp/src/app/loading.tsx`, and the 27 tracked dynamic
`page.tsx` routes in the detail inventory below; `apps/erp/tests/t448-responsive-workspaces.test.ts`.
Existing affected dashboard/layout tests may be updated only when this contract intentionally replaces their layout
assertion; retain data, authorization, visibility and amount assertions. This task and its review own the UI audit.
Supporting documentation: `docs/DEFECTS-REGISTER.md` records the missing shared loading-state finding.

## Implementation and gates

1. Audit every candidate and record route coverage; exclude reports, print-only documents and dedicated kiosk flows
   from record layout changes, explaining each exclusion.
2. Establish shared dashboard/detail view hooks, compact section rhythm and zero page-width overflow. Preserve DOM
   reading order. Existing financial rails split only when record content has room; no empty rail or squeezed totals.
3. Dashboard: compact header/filters, readable hero, phone metric strip with keyboard-reachable horizontal scrolling,
   desktop grid, compact chart spacing and plain white operational summary.
4. Details: named sections and aligned short controls; read-only key/value stacks on phones, existing native tables
   stay navigable with full headers and amounts. Move actions only after inspecting their real form ownership.
5. Tests first; affected tests, guards, typechecks and build. Full PR CI before merge. No deployment claim without it.
Browser automation is still denied by saved policy; do not bypass it or claim screenshots were verified.

FOR IAN: applying the skill begins here; UI work stays separate from red validation and unfinished POS branches.

## Detail inventory (all dynamic routes reviewed)

| Route | Initial layout | Scope |
|---|---|---|
| `apps/erp/src/app/admin/stores/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/admin/users/[personId]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/ap/invoices/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/ap/suppliers/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/attendance/[dayId]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/cash-requests/[id]/page.tsx` | Summary rail | Compact record view |
| `apps/erp/src/app/commissary/orders/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/customers/[customerId]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/customers/price-lists/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/expenses/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/fixed-assets/[id]/page.tsx` | Summary rail | Compact record view |
| `apps/erp/src/app/inventory/counts/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/inventory/deliveries/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/inventory/production/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/inventory/production/recipes/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/inventory/usage/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/items/[id]/page.tsx` | Split workspace | Compact record view |
| `apps/erp/src/app/liabilities/[id]/page.tsx` | Summary rail | Compact record view |
| `apps/erp/src/app/loans/[id]/page.tsx` | Summary rail | Compact record view |
| `apps/erp/src/app/menu/items/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/owners/[id]/page.tsx` | Summary rail | Compact record view |
| `apps/erp/src/app/prepaid/[id]/page.tsx` | Summary rail | Compact record view |
| `apps/erp/src/app/reports/dual-run/[store]/[week]/page.tsx` | Sectioned document | Report drilldown: preserve comparison layout |
| `apps/erp/src/app/sales-days/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/staff/[employmentId]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/trade/orders/[id]/page.tsx` | Sectioned document | Compact record view |
| `apps/erp/src/app/wastage/[id]/page.tsx` | Sectioned document | Compact record view |
