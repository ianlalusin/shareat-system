# T-568 - Groups pass: table/card UI, inline admin PIN, in-app notifications, toast design

**Status:** ported 2026-11-11 from the never-pushed branch `ui/groups-pass` (26 Oct base) onto main 2f38142.
That branch wrote its docs and code comments under four task numbers that main now uses for other work, so
everything here is T-568 and main's own task docs for those numbers are untouched. Screenshots moved to
`docs/reviews/t568/`. Audit findings UI-001 to UI-009 (`shareat-audits`, 2026-11-09 ui-groups-pass-FINAL) are fixed
inside the slice each belongs to; each slice section says which.

## Port notes (S1)

- **Main wins every conflict.** Where the old diff clashed with main (T-548 `<DialogActions>` on modal forms,
  T-544 channel-settlement tabs, T-549 icon rules, T-540 page headers, T-542 no task codes on screen, T-546 and
  later), main's logic, fields and guards were kept and only the table/card presentation was re-applied.
- **Nav regrouping NOT ported.** The old pass added its own People and Franchise groups. Main already has a
  People group and a different Franchise group (the franchisor's sales/stock/access-log view, T-398 S6d; Ian's
  31 Oct sidebar ruling). `nav.tsx` and `shell/icons.tsx` are left exactly as main has them.
- **`/inventory/pos-map`** was retired by main (T-550); the old edits to it are dropped.
- **Expense categories**: the old grouped/filtered table was rebuilt on main's page, keeping main's
  sub-category block, the "real choice" account select and `<DialogActions>` in the Set-account modal.
- **Trade orders**: main moved the new-order form into a `FormModal`; the old details disclosure was not ported.
- Payroll's table keeps main's "Repayments" column (old branch said "Advance").
- Census baselines (`action-link-sweep`, `touch-target-baseline.json`, `t450-table-inventory.json`) were
  re-measured, not carried over (UI-008). After all four slices: total 1629 controls, FAIL 104, UNRESOLVED 53.
  Deltas: S1 FAIL 113 to 104, UNRESOLVED 50 to 53, total 1626 to 1628 (the Inventory landing's eight 20px links became
  nav pills; three controls moved inside the shared Table into UNRESOLVED, baselined); S2 total 1628 to 1629 (+2
  confirmation-dialog buttons, -1 the PIN Button became a SubmitButton); S3 and S4 add no ERP controls. t348
  PageDescription call sites 126 to 127.
- UI-009 (S1): a help tip inside a clipped phone-card header leaves the tab order (`visibility:hidden` on it in the
  clipped thead), test `t568-help-tip-clipped-header.test.ts`.

## S1 part 1 - People and Inventory

### The improved brief (what this task actually does)

> Evaluate every People and Inventory screen at 1440 px and 390 px. On wide screens, any
> homogeneous collection of records must be a real table — readable columns, one row per record,
> aligned numbers, a visible header. On phones the same collection must become a card list that
> surfaces the two or three facts a manager acts on without opening anything. Keep the app's warm
> paper/ink/brand language, but make the two groups feel like one system: one page header, one
> filter bar, one table surface, one empty state, one set of action buttons.

Concretely:

1. A **People** nav group (Staff, Attendance, Leave, Clock terminals, Clock lane, Payroll, Payroll
   rates, Users and roles, Position access defaults). Inventory stays as it is.
2. `/staff` opens on **Roster**, not the lanyard wall. Roster is a real table on desktop and a
   card list on phone; Cards remains an optional visual mode.
3. The list screens in both groups use the shared `Table` / `Th` / `Td` / `NumTd` primitives,
   with `card` metadata so the phone card shows meaningful keys instead of hiding them.
4. Fix the shared phone-card annotator where it currently damages a screen:
   - a `HelpTip` in a `<th>` must not turn the whole header row into a visible card;
   - hidden tooltip prose must not be concatenated into a card label;
   - a table may opt out of the generated initials avatar.
5. `FilterRow` submits with a visible **Show** button. The icon-only eye is not a filter affordance.
6. "Open count" is a visible word button, not a red eye.
7. Inventory landing: replace the seven inline text links with one compact subnav; give the
   ledger-tie figures real hierarchy; use the shared empty state.
8. Low stock: both tables use the shared surface; the threshold editor reads as a row action, not
   an unlabelled form; the "no threshold" warning is a banner, not a sentence with an emoji.
9. Copy in these screens is user-facing prose: no `⭐`, `⚠️`, `DEF-nnn`, `T-nnn`, or "bible row"
   in anything a person reads.

### Files this task may touch

- `apps/erp/src/components/nav.tsx`
- `apps/erp/src/components/shell/icons.tsx`
- `apps/erp/src/components/FilterRow.tsx`
- `apps/erp/src/components/ui/Table.tsx`
- `apps/erp/src/components/ui/HelpTip.tsx`
- `apps/erp/src/components/ui/phone-table-cards.ts`
- `apps/erp/src/app/globals.css`
- `apps/erp/src/app/staff/page.tsx`, `StaffViews.tsx`
- `apps/erp/src/app/admin/users/page.tsx`
- `apps/erp/src/app/payroll/page.tsx`
- `apps/erp/src/app/attendance/page.tsx`
- `apps/erp/src/app/inventory/page.tsx`
- `apps/erp/src/app/inventory/low-stock/page.tsx`
- `apps/erp/src/app/inventory/usage/page.tsx`
- `apps/erp/src/app/inventory/counts/page.tsx`
- `apps/erp/src/app/inventory/locations/page.tsx`
- `apps/erp/src/app/items/page.tsx`
- `apps/erp/tests/filter-row.test.ts` (the visible Show button)

### Invariants

- No route, capability, query or write path changes. Presentation only.
- Every table keeps its native headers for assistive technology; the phone card is an annotation
  of the original row, never a copy.
- Desktop is table-first at `md` (768 px) and above; phone is card-first below it.
- Numeric columns stay right-aligned and tabular.
- The phone card must be readable without expanding: title, subtitle, and at most two key values.

### Verification

- `npm run typecheck`
- `npm run test -- filter-row` and the phone-table suites
- Screenshots at 1440×900 and 390×844 before/after for the People and Inventory routes named above.

### Result (2026-11-08)

Built:

- A **People** nav group with the Staff / Attendance / Payroll / Users cluster moved out of Daily and
  Setup; Inventory is unchanged.
- `/staff` defaults to the Roster **table**; Cards stays as an optional visual mode. The roster is
  one shared `<Table>` row per person (Photo, Person, Position, Today, Status) and becomes a card
  on a phone.
- Shared `Table` / `Th` / `Td` / `NumTd` adoption for Users and roles, Payroll (preview + rates),
  Attendance (days + leave), Inventory landing, Low stock, Locations, Deliveries, Usage, Counts and
  POS item mapping.
- Phone-card key values now keep an inline label ("Stores 9", "Status Draft", "Code T343-001").
- Phone-card titles clamp to two lines instead of cutting names to "…"; initials come from the first
  two words, so "T343S6C Test Item (slab)" is "TT", not "T(".
- `FilterRow` submits with a visible **Show**; "Open count" and Payroll's "Preview" are word buttons.
- Fixed the shared annotator's two real defects:
  - a `HelpTip` button in a `<th>` made the whole header row render as a card on a phone;
  - hidden tooltip prose was concatenated into the card label ("ThresholdA number of 0 or more").
- Low stock's threshold editor is now a card row with a visible **Threshold** label, not an
  unlabelled input under a stray header card.
- Inventory landing: one compact section nav instead of seven inline links, a real KPI panel for the
  ledger tie, and the shared truck empty state.
- User-facing copy in the touched screens lost the task IDs, ⭐/⚠️/⛔ glyphs and "bible row" prose.

### Verification

- `npm run typecheck` — clean.
- Focused suites: `filter-row`, `t450-phone-table-cards`, `t450-phone-table-coverage`,
  `ui-button`, `t411-row-link-census`, `t348-page-description-sweep`, `t384-s2-full-width`,
  `staff-s7-page`, `t343-s6c-screen-labels`, `action-link-sweep` — green.
- Full ERP unit run: 3,953 passed / 5 failed. The five are pre-existing environment failures, not
  this change: two 5-second cold-import timeouts (`t343-s5`, `t441-s1`), one Windows
  `spawnSync ... ENOENT` in `t541`, and `no-typed-values-in-urls` (passes when run alone; it
  raced the full-suite run).
- `npm run build` — clean.
- Screenshots: `docs/reviews/t568/s1-people-inventory/` (before/after pairs, 1440×900 and 390×844).

### Known follow-up (not done here)

- `/admin/users/[personId]` is still a ~7,800 px wall of capability checkboxes (12,600 px on a
  phone) with no search or grouping. It is the next People-group UI task; it is not a table/card
  problem, so it sits outside this brief.

## S1 part 2 - Money, Trade, Franchise, Reports and Setup

### The brief, tightened

> Keep the **staff ID cards** as the default view. Improve them — a different card, grouped,
> stacked — but they must stay cards, never a table. Then apply the part 1 system to the remaining
> groups: **Money, Trade, Franchise, Reports, Setup**. On a wide screen a collection of records is
> a table with a real header; on a phone the same collection is a card list that surfaces the
> facts a manager acts on. Long forms collapse behind a disclosure. One branch, one audit, one
> merge later.

### What changed

- **Staff cards are the default again.** The lanyard wall is replaced by a compact horizontal ID
  badge: brand band, punched slot, avatar, name, role, store/tenure, live status and an
  `ID CARD / View profile` footer. Cards are grouped by **On shift / On break / Off today** (or by
  position when the viewer cannot see live state). Roster stays as the table-first alternate.
- **New Franchise nav group**: Franchise owners, Customers, Price lists, Franchise orders, Customer
  returns. Trade is now supplier-facing only; Money no longer carries Owners.
- **Money accounts**: filters (store / kind / search), one table per account type, no repeated
  "Always present" badge on every row, store code and name stacked, no column overlap. Phone cards
  show store, custodian and limit; edit/retire sit behind the card's disclosure.
- **Money transfers**: the 48 loose balance cards became a **store × account matrix** (9 stores,
  5 account types, totals in `tfoot`). On a phone it is one card per store with its five balances.
- **POS link**: nine fully open store forms (5,643 px desktop / 13,300 px phone) became nine
  disclosures with a status pill. 900 px / 1,042 px.
- **Expense categories**: grouped by CAPEX / COGS / OPEX / PERSONAL, with a group filter and
  search. The 19,938 px phone page became 8,304 px, then 4,152 px after the card metadata was
  reduced to Category / Posts to.
- **Findings**: every finding and every missed month is a collapsed disclosure; the action form
  opens only where it is used. 3,890 → 2,386 px desktop; 7,720 → 2,964 px phone.
- **Trade orders**: the new-order form is a disclosure; the page is 844 px on a phone.
- Loans, prepaid and owners use the shared table/card surface with card metadata.

### Files this task may touch

- `apps/erp/src/components/nav.tsx`, `components/shell/icons.tsx`
- `apps/erp/src/app/staff/StaffViews.tsx`, `staff/page.tsx`
- `apps/erp/src/app/money-accounts/page.tsx`
- `apps/erp/src/app/money-transfers/page.tsx`
- `apps/erp/src/app/loans/page.tsx`, `prepaid/page.tsx`, `owners/page.tsx`
- `apps/erp/src/app/settings/pos-link/page.tsx`, `settings/expense-categories/page.tsx`
- `apps/erp/src/app/findings/page.tsx`
- `apps/erp/src/app/trade/orders/page.tsx`
- `apps/erp/tests/staff-s7-page.test.ts`, `action-link-sweep.test.ts`,
  `touch-target-baseline.json`

### Verification

- `npm run typecheck` — clean.
- Focused suites — green: staff, nav reachability, row-link census, phone table cards/coverage,
  page-description sweep, full-width ratchet, action-link sweep.
- Full ERP unit run — 3,954 passed / 4 failed; all four are pre-existing environment issues
  (three 5-second cold-import timeouts and one Windows `spawnSync ... ENOENT`), not this change.
- `npm run build` — clean.
- Before/after screenshots: `docs/reviews/t568/s1-money-trade-setup/`.

### Still owed

- `/admin/users/[personId]` is still the 7,800 px capability wall. It needs search, grouping and
  progressive disclosure; it is the next People task, not a table/card patch.

## S2 - Inline admin PIN with a confirmation that asks every time

Source commits 6a2385f, b64a02a, 0ab63f9. Administrator PINs on `/staff` (`IssueAdminPinForm.tsx`): the
field and its button share one row; submitting opens a dialog that explains what an administrator PIN
approves, that re-issuing replaces the old PIN and ends live sessions, and that the PIN must be handed
over privately. Nothing is issued until the person confirms, and **every** issue asks again.

Audit fixes folded in (audit `2026-11-09-ui-groups-pass-FINAL`):

- **UI-001** - the approval is not a flag that lives between submits. `confirm()` raises it only for the
  duration of its own `requestSubmit()` call and drops it in a `finally`, so a confirmed submit that never
  fires (a refusal, a rule that went invalid) cannot wave the next issue past the question. A pending guard
  (React's form status) stops a second question or send while one is in flight.
- **UI-006** - the form is the shared `CheckedForm` with `STAFF_PIN_RULES` and a ruled `Field`, so the
  "A PIN must be exactly 6 digits." line and the disabled Save come from the shared path. The confirmation
  runs after the rules: a failing PIN never reaches the dialog. No baseline exemption.
- **UI-007** - the fixed `w-40` is gone; the field uses `Field width="code"` inside `FormGrid layout="fields"`.

Tests: `apps/erp/tests/issue-admin-pin-confirm.test.ts` (asks every time, asks after Cancel, no consent left
behind by a submit that never fires, shared rules refuse first, nothing sent while in flight).
Screenshots: `docs/reviews/t568/s2-admin-pin/`.
