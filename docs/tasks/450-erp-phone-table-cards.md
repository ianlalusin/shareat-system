# T-450 — ERP tables become phone cards

Status: built; 244 affected checks, typecheck and corrected production build pass. Visual check and full PR CI pending.
Ian approved 2026-10-21; cards below 768px, tablets retain tables.

## Goal
Every ERP table row reads as a labeled card on a phone without losing fields, forms or actions.

## Scope
- apps/erp/src/components/shell/PhoneTableCards.tsx and ui/phone-table-cards.ts
- apps/erp/src/components/shell/AppShell.tsx; apps/erp/src/app/globals.css
- apps/erp/src/components/ui/Table.tsx, ui/index.ts (shared card metadata API); docs/ERP-UI-PATTERNS.md
- apps/erp/src/components/ui/FormGrid.tsx; apps/erp/tests/t445-compact-forms.test.ts and t384-s2-full-width.test.ts (shared default contract)
- apps/erp/src/app/admin/access-defaults/grid.tsx; apps/erp/src/app/liabilities/unpaid/page.tsx
- apps/erp/src/app/items/page.tsx (explicit compact card hierarchy)
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

### Compact card correction — Ian, 2026-10-21
The stacked-column preview was rejected: it made each card a long document. A collapsed card shows
one title, one subtitle, at most two key values on the right, and an existing circular image on
the left (initials when no image exists). No repeated field label above the title or subtitle.
Secondary read-only cells collapse behind an accessible 44px Details chevron; existing editable
cells and actions remain reachable without expanding. More details restores the original cells,
never copies their values or reparents existing controls. A single adapter-owned toggle cell is
allowed per row, excluded from the logical column grid and hidden on tablet/desktop/print.
Items explicitly use Item / Kind / Priced per. Never invent photos or add image storage to this slice.
Forms default to shared content-sized rows; explicit grid layouts, wide spans and grid-column overrides
retain grid behavior. Field widths infer familiar control semantics when no explicit width/span was supplied.
Tests: compact hierarchy, image reuse/initials, expand/collapse, no hidden editors, dynamic toggle
cleanup, original node identity and tablet/print exclusion. User screenshots are a rejection of
the prior layout, not a completed visual release check.

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
