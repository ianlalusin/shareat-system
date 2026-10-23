# T-461: ERP forms appear only when called

Ian, 2026-10-22: hide every ERP form; reveal through Add/Edit/Update or another action. Existing authorizations and server actions stay intact.

## Scope
- apps/erp/src/components/forms/{FormDisclosure,ActionForm}.tsx (new)
- apps/erp/src/components/forms/{CheckedForm,EditableRecord,index}.tsx/index.ts (existing exact files: CheckedForm.tsx, EditableRecord.tsx, index.ts)
- apps/erp/src/components/ui/{DisclosureCard,FlashBanner}.tsx
- apps/erp/src/app/globals.css
- apps/erp/src/components/shell/ScreenState.tsx: expose the existing account scope to the local reveal marker; no persisted field values or cross-account reveal state.
- apps/erp/tests/t461-action-forms.test.ts (new)
- apps/erp/tests/t440-s1-checked-form.test.ts: adapt only the old root-form assertion to the new disclosure, preserving every form/disabled validation assertion.
- apps/erp/src/app/expenses/reimbursements/page.tsx; apps/erp/src/app/admin/stores/page.tsx; apps/erp/src/app/payroll/rates/page.tsx: mark forms inside existing native disclosures as already called, avoiding a second prompt. Same marking for the existing scoped items/page.tsx and ap/invoices/[id]/page.tsx.
- docs/discovery/erp-action-only-forms.md; docs/reviews/t461-action-forms.md; this spec
- Raw entry-form adopters (shared wrapper/imports only, unchanged native form/action/props/children):
- apps/erp/src/app/wastage/[id]/page.tsx
- apps/erp/src/app/remittance/page.tsx
- apps/erp/src/app/liabilities/[id]/page.tsx
- apps/erp/src/app/cutover/page.tsx
- apps/erp/src/app/attendance/[dayId]/page.tsx
- apps/erp/src/app/cash-requests/[id]/page.tsx
- apps/erp/src/app/cutover/opening/page.tsx
- apps/erp/src/app/attendance/terminals/ProvisionForm.tsx
- apps/erp/src/app/admin/users/[personId]/page.tsx
- apps/erp/src/app/commissary/orders/[id]/page.tsx
- apps/erp/src/app/items/[id]/page.tsx
- apps/erp/src/app/items/page.tsx
- apps/erp/src/app/attendance/leave/page.tsx
- apps/erp/src/app/commissary/discrepancies/page.tsx
- apps/erp/src/app/findings/page.tsx
- apps/erp/src/app/payroll/thirteenth-month/page.tsx
- apps/erp/src/app/ap/invoices/[id]/page.tsx
- apps/erp/src/app/fixed-assets/page.tsx
- apps/erp/src/app/payroll/separations/page.tsx
- apps/erp/src/app/till/page.tsx
- apps/erp/src/app/inventory/usage/NewUsageForm.tsx
- apps/erp/src/app/payroll/page.tsx
- apps/erp/src/app/menu/usage-source/page.tsx
- apps/erp/src/app/menu/requests/page.tsx
- apps/erp/src/app/inventory/pos-usage/page.tsx
- apps/erp/src/app/inventory/pos-map/page.tsx
- apps/erp/src/app/inventory/deliveries/[id]/page.tsx
- apps/erp/src/app/menu/items/[id]/page.tsx
- apps/erp/src/app/staff/[employmentId]/page.tsx
- apps/erp/src/app/staff/[employmentId]/credentials/page.tsx
- apps/erp/src/app/inventory/production/recipes/new/page.tsx
- apps/erp/src/app/inventory/production/recipes/[id]/page.tsx
- apps/erp/src/app/settings/wastage-monitor/page.tsx
- apps/erp/src/app/settings/expense-categories/page.tsx

## Contract
1. EditableRecord fields hidden while locked, Edit reveals; Save/Cancel, refusal typing, dirty registry, version and reset remain unchanged. Stored read-only content outside editors stays visible.
2. CheckedForm and raw mutation entry forms use one shared native disclosure; its action text reuses the existing submit label. Keyboard and no-JS opening work. Forms stay mounted; no nested forms.
3. An existing DisclosureCard supplies the reveal, avoiding a second prompt. Inputs are never shown just because scripts loaded.
4. Search/report/store/date filters and sign-in/clock authentication are navigation/access controls, not record editors; remain usable. A submit-only command already IS its action button; no redundant reveal.
5. Preserve field checking, confirmation, auth, uploads, form ids/ref, foreign submit buttons and server actions. Server refusal reopens the submitted reveal without saving typed values.
6. No DB/schema/auth changes, no permission-policy bypass.

## Evidence
Target regression first, typecheck/build with dev stopped, affected shared-component tests and guards/census. Running ERP visual gate requires Ian because saved browser permission is denied. Do not claim visual approval.

## Follow-up 2026-10-24 (Opus planner, AUDIT session) — DEF-755: a finished delivery's lines hide behind "Update"

Source: Codex read-only audit 2026-10-23 finding 3, re-verified at a892aef. `apps/erp/src/app/inventory/deliveries/[id]/page.tsx:111`
wraps the whole line table in an unconditional `<FormDisclosure>`. `formNeedsReveal` (`components/forms/FormDisclosure.tsx:36`)
counts any non-kit component (`LinkRow`, `RowLink`) as an entry control, so a `received` or `void` delivery, which has no
editable field, renders its item / quantity / cost history inside a closed `<details>` labelled the fallback "Update".
That breaks Contract 1 ("Stored read-only content outside editors stays visible").

**Ruling:** the reveal applies only to the editable receive state. `FormDisclosure` wraps the form only when
`canReceive` (status `draft`); a received or void delivery renders the same table with no disclosure. The detector is not
changed (its conservative "unknown component = entry" rule protects custom inputs elsewhere).

**Test (red first):** a received delivery's line table (item name, ordered, unit cost, received) renders outside any
`<details>`; a draft delivery still starts in a closed disclosure. Prefer rendering the page against a dedicated local
Postgres test database (never a shared one in use by another lane); a source-shape assertion alone is not enough.

**Files:** `apps/erp/src/app/inventory/deliveries/[id]/page.tsx`, one test file, this spec, `docs/DEFECTS-REGISTER.md`
(section E, DEF-755). Visual confirmation in the running ERP still needs Ian (browser automation is denied).
