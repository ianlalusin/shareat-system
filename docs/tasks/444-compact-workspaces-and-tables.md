# T-444 — Compact workspaces and readable tables

Status: BUILT and locally audited, 2026-10-19; release requires green full PR CI. Ian requested implementation and audit/test/commit/merge of the pending work.

## Decision and evidence

Build a reusable responsive form/details workspace, adopt it on the item catalogue and item detail,
and improve table structure and desktop spacing across ERP pages. Ian approved implementation in chat.
Keep the full page width; use the space for related information instead of stretching a short form.

Existing code has Page, FormGrid, semantic tables and theme tokens; no new dependency is needed.
The legacy ERP, POS, Customer and Website were searched read-only for split/preview patterns. They
serve different audiences; ERP gets operator density, while POS and Customer keep their touch layouts.
The handoff has separate unfinished POS/Customer slices; this task does not silently merge them.

Prior art: [Carbon data tables](https://www.carbondesignsystem.com/building-blocks/core/components/data-table/guidelines)
uses compact desktop rows and zebra striping; [SAP flexible columns](https://www.sap.com/design-system/fiori-design-web/v1-96/page-types/page-layouts/flexible-column-layout)
adapts related panels to available width. [shadcn/ui](https://github.com/shadcn-ui/ui) is MIT licensed,
but another table library would duplicate our existing semantic kit for this CSS/layout change.
Utilisation is every ERP list visit; live visit counts are unavailable. Scope: two screen layouts,
one shared workspace, shared table styles, no new tables or runtime packages.

## Scope

- apps/erp/src/components/ui/SplitWorkspace.tsx, ui/index.ts, ui/Table.tsx
- apps/erp/src/components/shell/Page.tsx; apps/erp/src/app/globals.css
- apps/erp/src/app/items/page.tsx and [id]/page.tsx
- apps/erp/tests/t444-compact-workspace.test.ts and existing affected UI tests
- docs/reviews/t443-t444-audit.md; this task; task 443 audit addendum/status

## Contract

Form on the left, useful details on the right when the actual content container is at least 58rem;
one column below it. Both tracks must shrink safely; wide tables scroll within their own panel.
Catalogue: request/add form on the left, kind-filtered family table and review controls on the right.
Detail: edit controls on the left, item facts, suppliers and price history on the right.
No control or existing workflow is removed. No form nesting. No speculative live price calculations.

Tables retain table/thead/th/tbody/td semantics, numeric alignment and full-row links. Add clear row
and column rules, a distinct header, subtle alternating rows, and visible hover/focus. The catalogue
scrolls in a bounded region with sticky headers. Desktop rows may be 36px under a fine pointer;
coarse pointers and form controls retain 44px targets. Light/dark use existing tokens only.
Page padding/vertical gaps become more compact on wide screens; no font-size reduction or width cap.

## Tests and done

Write layout regression tests first; verify the actual screens at desktop and 375px, light/dark,
with data and keyboard links. Audit T-443 including database invariants under concurrent writes.
Typecheck, affected unit/integration tests against isolated real PostgreSQL, build, browser smoke,
review, commit to a feature branch, then full CI green on the exact PR head before merging.
