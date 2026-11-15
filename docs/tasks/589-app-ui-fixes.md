# T-589 — App-wide UI fixes from the 15 Nov full-page scan

Status: SPEC (Opus, UI UX), 2026-11-16. BOSS, relaying Ian's approval (15 Nov) of all four batches and the icon rule.
Input: `C:\Users\ianla\webapps\shareat-ui-scan\2026-11-15\review-G1.md … review-G4.md` (Section A per route, B
patterns, C top fixes; INDEX.md has the screenshots). 149 pages: 9 OK, 69 minor, 61 fix. Findings tagged T-587
(the settings hub, `/admin/stores/[id]`) belong to the SETTINGS session and are skipped here.

## Ian's rulings
- **R1** Main actions show icon + a short word ("Add", "Approve", "Save"), keeping the 8 Nov icons (bible row 451).
  Minor actions may stay icon-only, with an accessible name.
- **R2** "store", never "branch" — except the commissary's "Branch orders".
- **R3** Dates use the one existing en-PH long formatter ("February 14, 2022").

Freeze (row 435): ERP-only, safe for live stores, small PRs, no migrations.

## Coverage ledger (lands in the FIRST PR, B1)
`docs/ui-review/PAGES.md`: one row per `apps/erp/src/app/**/page.tsx`, with
`route | file | last reviewed | status (OK/minor/fix/not captured) | findings ref (G1–G4) | fixed in PR`, seeded from
the four reviews (a page absent from the reviews: status `not reviewed`). Unit guard
`apps/erp/tests/t589-pages-ledger.test.ts`: every page.tsx has exactly one row, and every row's file exists; failure
message for a missing row: `new page, not reviewed: <route> — add it to docs/ui-review/PAGES.md`. Every later batch
flips its rows' "fixed in PR" to the PR number.

## B1 — bugs (before the 21 Nov soak)
1. **DEF-867.** A manager on `/reports/balance-sheet` or `/reports/trial-balance` lands on the error boundary.
   - Root cause: report pages never call `requirePageAccess`; `reportScope` (`app/reports/lib.ts`) calls
     `requireSession` and then `authorizeForScope`, which THROWS for a refused person. Also `lib/route-capability.ts`
     maps balance-sheet to `view_financial_reports` while the page's data gate is `view_trial_balance`.
   - Fix once, in the shared code: `reportScope` gates with `requirePageAccess(path)` and returns the refusal to the
     page (a union the pages early-return), so EVERY report page refuses with the standard refusal card instead of
     throwing. Make the balance-sheet route key equal its data gate (`view_trial_balance`). This narrows nothing and
     widens nothing: a manager could never see the balance sheet's data.
   - Whether a manager should get a STORE-level balance sheet is a permission question for Ian — not changed here.
   - Test: a manager (no `view_trial_balance`) on balance-sheet and trial-balance gets the refusal, not a throw; an
     admin gets the report. Name the mutant: put `requireSession` back in reportScope → red.
2. **`/staff` Administrator PINs card overflow** (`PinSignInPanel.tsx`, `IssueAdminPinForm.tsx`): no horizontal
   overflow at 390 or 1280.
3. **`/trade/orders/[id]` overflow**: the Dispatch form inside `StatusHero`, same rule.

## B2 — show saved values
`EditableRecord` gets an optional read-mode summary (label/value list, "Not set" muted italic as T-587 S4 does) and
every pencil-only card the reviews list uses it (~15 pages). Shared component: census pins will move — report them.

## B3 — plain words, dates, confirms
Developer text out of user view (~68 pages: task/ADR/DEF numbers, `npm run`, code names, raw capability keys,
account codes without names, "Save is off until:" walls, "the2110"); "(s)" plurals; R2; R3; confirms on Retire
category, Retire channel, Withdraw day, owners/[id] and run-depreciation. Split by area if big.

## B4 — phone layout + R1
`shell/PhoneTableCards` clipping/overlap (~10 pages), dashboard tiles at 390, hydration mismatches on /owners,
/cash-requests/[id], /settings/expense-categories (suspect PhoneTableCards rewriting the table DOM), and R1 icon + word.

## Verification (each batch)
tsc; the touched unit tests + censuses (re-measured, never hand-edited); rendered check at 1440 and 390 on a scratch
`shareat_test_*` DB, port 9028, before the PR (impeccable).
