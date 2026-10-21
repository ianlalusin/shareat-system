# T-450 — ERP tables become phone cards

Status: built; 244 affected checks, typecheck and corrected production build pass. Visual check and full PR CI pending.
Ian approved 2026-10-21; cards below 768px, tablets retain tables.

## Goal
Every ERP table row reads as a labeled card on a phone without losing fields, forms or actions.

## Scope
- apps/erp/src/components/shell/PhoneTableCards.tsx and ui/phone-table-cards.ts
- apps/erp/src/components/shell/AppShell.tsx; apps/erp/src/app/globals.css
- apps/erp/src/app/admin/access-defaults/grid.tsx; apps/erp/src/app/liabilities/unpaid/page.tsx
- apps/erp/src/components/reports/BalanceSheetTable.tsx, CashFlowTable.tsx, IncomeStatementTable.tsx
- apps/erp/src/app/expenses/[id]/page.tsx; apps/erp/src/app/cutover/count/sheet/page.tsx
- apps/erp/tests/t450-phone-table-cards.test.ts and t450-phone-table-coverage.test.ts
- existing affected breakpoint assertions under apps/erp/tests, only when asserting the former 640px rule
- package.json and package-lock.json (Happy DOM, development dependency only)
- docs/discovery/erp-phone-table-cards.md; docs/reviews/t450-table-inventory.json; docs/reviews/t450-phone-tables.md; this task

## Contract
`enhancePhoneTables(root: HTMLElement): void` annotates original tables/cells without replacing,
reparenting or mounting copies of live nodes. Detached header copies are inspected only for labels.
`observePhoneTables(root: HTMLElement): () => void` handles table additions, streamed rows,
header text and column changes, and disconnects on unmount. The shell mounts the adapter once.
Read labels from column headers (respect colspan/rowspan and explicit headers), or explicit
`data-card-columns` for existing headerless tables. Preserve header controls and full-width totals.
CSS card rules apply only to screen widths below 768px, never to tablet/desktop or print.

## Invariants
Discovery: docs/discovery/erp-phone-table-cards.md. Same DOM forms, ids, entered values, disabled states,
row selection, link destinations and action handlers; all monetary strings remain complete. No writes,
new requests or changed permissions. Native table semantics remain available to assistive technology.
Loading, empty and refusal content stays intact; hover/focus remain visible and phone controls clear 44px.
No JavaScript is a native scrollable-table fallback; do not claim cards before hydration.

## Tests (before implementation)
DOM: labels, actual node identity and values, action clicks, idempotence, grouped headers, colspan totals,
header controls, explicit headerless labels, late rows/tables, changed header text, observer cleanup,
React rerender/removal, nested tables, existing roles, hidden inputs and malformed span dimensions. Source/CSS: exact 768px rule,
screen-only cards, shell coverage, existing card pairs, every headerless source explicitly labeled.

## Out of scope
POS, customer, database, data loading, print document content, unrelated dirty work and bible amendments.

## Done when
Affected tests/typecheck/build pass; real phone/tablet/desktop smoke completed; self-review; commit;
full PR CI passes on exact head before merge and deployment. Record any unavailable gate plainly.
