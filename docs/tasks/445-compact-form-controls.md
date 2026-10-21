# T-445 — Compact controls and sectioned forms

Status: BUILT locally, Ian's sample approved 2026-10-19. Automated checks pass; browser gate denied access despite explicit permission. Await visual verification and green PR CI before release.

## Decision

Ian approved the 32px desktop sample with widths matched to content and named sections.
This supersedes T-384's requirement that every individual control stretch: the page still uses
the available width, while dates, quantities, units and codes remain short. Touch controls stay
44px. No data model, permissions, posting rules or form submission changes.

## Assessment and evidence

Every ERP form visit benefits; live visit counts are unavailable. Input and Select currently use
min-h-11; FormGrid treats unlike fields as equal tracks. Reuse these primitives, adding a wrapping
field-row option and semantic width hints, rather than adopting a dependency. GOV.UK's
[text-input guidance](https://design-system.service.gov.uk/components/text-input/) sizes controls
for expected content; T-444 already researched Carbon/SAP/shadcn and the four reference apps.
No new package, service or table. Keep POS/Customer touch layouts; do not shrink their controls.

## Scope

- apps/erp/src/app/globals.css
- apps/erp/src/components/ui/{Input,Select,Textarea,Button,FormGrid,index}.tsx (index.ts)
- apps/erp/src/app/items/{page,ItemCodeField}.tsx and [id]/page.tsx
- apps/erp/src/app/customers/page.tsx
- apps/erp/src/app/ap/{page,suppliers/page}.tsx
- apps/erp/src/app/inventory/deliveries/NewDeliveryForm.tsx
- apps/erp/src/app/trade/orders/NewOrderForm.tsx
- apps/erp/src/app/{loans,payroll/rates,statutory-discounts,owners,prepaid,liabilities,admin/stores,inventory/pos-map,attendance/leave}/page.tsx
- apps/erp/tests/t445-compact-forms.test.ts and affected existing layout/kit tests if required
- docs/reviews/t445-compact-forms.md; this task; defect register for incidental findings

## Contract

1. At viewport >=768px with a fine pointer, single-line shared controls and buttons have a
   32px minimum height; natural wrapping may grow. Default/coarse-pointer geometry remains 44px.
   Preserve text size, focus rings, invalid/disabled states and native semantics. Textareas retain
   multiple lines and vertical resizing. File pickers, checkboxes and radios are not squeezed.
2. ERP native fields get the same density; dates/numbers/codes/units use semantic maximum widths,
   names/pickers have room for long values. No width may force horizontal page overflow.
3. FormGrid's existing mode and span behavior remain compatible. New field-row mode wraps by
   container space; Field width hints keep labels, hints and errors with their control.
4. Named fieldsets group identity, contact, terms, document, lines, fees and evidence as appropriate
   in the listed screens. Preserve field names, validation, action bindings and every line action.
5. Inspect existing form layout patterns and record exact rollout coverage and remaining screen
   review limits. Do not describe a source survey as a browser test of every screen.

## Verification

Scope expanded after the source survey: 146 ERP files with controls, 370 form/editable wrappers,
1,283 native/shared control source sites, 32 forms with >=6 visible control sites (loops count
once). Nine further long forms above get named sections; smaller transaction/line/allocation
forms keep their existing layouts and receive the shared sizing. This is a source inspection,
not proof that every role and populated state has been browser-tested.

Regression tests first; affected kit/layout/census and caller checks; typecheck; production build
with ERP server stopped; browser desktop and phone smoke if browser access is available. Browser
permission was declined for the earlier sample origin: do not bypass that denial. Report any
browser limitation plainly. Commit only this task's files; leave docs/operations/ untouched.
