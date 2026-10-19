# T-446 — Plain white ERP workspace

Status: BUILT locally, 2026-10-19; 212 affected unit tests and 67 affected PostgreSQL tests pass, typecheck and build succeed. Browser verification remains blocked by a saved permission/managed policy despite Ian enabling access; not released. Supersedes the red arch/wave proposals: no pattern.

## Contract

Keep the existing sidebar color. Make the light-mode content workspace pure white with no
background image, gradient or decoration. Keep form sections visually continuous with the page;
use quiet neutral table dividers/striping, existing red actions and readable field boundaries.
Retain the approved T-445 compact controls and sectioned forms. Preserve opt-in dark mode and
warning/success/error surfaces. No data, permissions or posting behavior changes.

Use workspace-specific tokens so changing content does not recolor the sidebar. This is a
clarification of T-444/T-445's approved layout, not a new design system or dependency.

## Scope

Ian's follow-up: related fields share a row whenever their actual container can fit them. The item
Name/Kind/Unit row must not reserve an entire row for Name; buying/selling checkboxes share a
wrapping row. Use concise visible labels with complete accessible names/help. Long prose and
long pickers retain room. Narrow screens reflow rather than squeezing text or overflowing.

- apps/erp/src/app/globals.css
- apps/erp/src/components/shell/AppShell.tsx
- apps/erp/src/components/ui/FormGrid.tsx
- apps/erp/src/app/items/{page,ItemCodeField}.tsx and [id]/page.tsx
- apps/erp/src/app/{ap,customers,loans,owners,prepaid,liabilities,admin/stores,inventory/pos-map,statutory-discounts}/page.tsx (content-sized name hints on the T-445 screens)
- apps/erp/tests/t446-white-workspace.test.ts
- apps/erp/tests/t343-s6c-screen-labels.test.ts (concise empty Kind placeholder; still no default kind)
- apps/erp/tests/integration/t378-s1-item-unit-no-default.test.ts (concise Unit/Kind placeholders; blank/required/options assertions unchanged)
- docs/tasks/446-plain-white-workspace.md; docs/reviews/t446-white-workspace.md
- docs/reviews/t445-compact-forms.md (record that the background decision is now settled)

## Verification

Write regression tests first. Run workspace, theme contrast, shell, compact-form and layout
tests, typecheck and production build with port 9008 stopped. Browser gate has twice denied
local access, including after Ian's permission; do not bypass it or claim visual verification.
No merge/release until the required gates can be completed. Do not touch docs/operations/.
