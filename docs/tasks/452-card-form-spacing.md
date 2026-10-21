# T-452 — shared two-column card forms with aligned controls
Status: built locally 21 October; final production build passed, preview restarted on 9008; visual approval and full PR CI pending.
Goal: government numbers and other cramped record cards use two columns when their container fits, one on phones.
AST sweep found 57 FormGrid groups in bordered sections outside EditableRecord; record their inventory in
docs/discovery/card-form-inventory.json. Shared form containment applies pairs at widths up to 42rem,
stacks below 24rem/on phones, and preserves content-sized rows in wider entry forms. No per-page style copies.
Shared labels are compact, help follows controls, field widths fit their content, no field or action disappears.
Paired tracks do not stretch short controls: units/counts cap at 8rem, codes/amounts at 14rem,
dates at 11rem; government identifiers explicitly use code width, and long text can span the pair.
Reuse the pattern across EditableRecord's existing FormGrid groups (27 page definitions); preserve explicit grids/full spans.
Settlement payout, amounts, deductions, loan and provenance use the shared paired layout, with account text on its own helper line.
On wide screens reuse SplitWorkspace: entry groups left, payout check and posting controls right; stack on narrow containers.
Scope: apps/erp/src/components/ui/FormGrid.tsx; apps/erp/src/components/forms/EditableRecord.tsx;
apps/erp/src/app/globals.css; apps/erp/src/app/staff/[employmentId]/page.tsx;
apps/erp/src/app/channel-settlements/SettlementForm.tsx; apps/erp/tests/t452-card-form-spacing.test.ts;
affected form tests only if a documented new markup contract supersedes an old assertion; docs/ERP-UI-PATTERNS.md;
docs/DEFECTS-REGISTER.md; this task; docs/discovery/staff-role-and-card-form-spacing.md;
docs/reviews/t451-t452-role-forms.md. No posting math, parsing, validation or permission changes.
Tests first: paired layout markers; label/control/help order; record wrapper; government 2x2 wiring;
settlement grouped layout and separate account helper; native names/required/disabled/negative-money behavior retained.
CSS uses container width; narrow viewport always stacks. Read-only values and error helpers remain complete.
Runtime screenshots are a release gate; saved browser denial must not be bypassed. No false geometry claims from SSR tests.
