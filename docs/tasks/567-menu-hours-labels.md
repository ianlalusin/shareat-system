# Taken by BOSS (Haiku subagent), 11 Nov - Ian: small jobs go to a subagent, not DeepSeek
# T-567 — Call the hours "Menu hours", not "Lunch and dinner hours"

| Field | Value |
|---|---|
| Planner | BOSS |
| Builder | <app and model> |
| Branch | `wo/t567-menu-hours-labels` (the builder creates it from `origin/main`) |
| Worktree | `C:\Users\ianla\webapps\wt-t567` (the builder creates it, and works only there) |
| Risk class | **low** (screen text only) |
| Numbers reserved | migration: none · DEF: none · bible row: none |

## 1. Goal

Ian, 11 Nov: time windows are already admin-configured (any name: Breakfast, Lunch, Dinner, Merienda…),
but the screens still call them "Lunch and dinner hours", which reads as if only those two exist. Rename the
user-facing text to the generic **"Menu hours"** wording. Behaviour does not change.

## 2. Read first

- `AGENTS.md` (section "Building from a work order") and `docs/RULES.md`
- `apps/erp/src/app/menu/DaypartsSection.tsx`

## 3. What to build

Change only USER-VISIBLE strings (headings, link text, titles, hints, error messages, nav labels) in these files.
Code comments may stay.

| File | Change |
|---|---|
| `apps/erp/src/components/nav.tsx:216` | label → `Menu hours` |
| `apps/erp/src/app/menu/page.tsx:132` | → `Menu hours` |
| `apps/erp/src/app/menu/hours/page.tsx:11,28,40` | title → `Menu hours - Shareat System`; headings → `Menu hours` |
| `apps/erp/src/app/menu/DaypartsSection.tsx:50,114` | heading → `Menu hours`; modal title → `Add menu hours`. Line 34's example: replace "dinner ends" with "the window ends". Placeholder at line 16 becomes `Breakfast, Lunch, Dinner…` |
| `apps/erp/src/app/admin/stores/[id]/page.tsx:107` | → `Menu hours →` |
| `apps/erp/src/app/menu/prices/page.tsx:145,149,197,198,213,299,464` | "lunch or dinner" / "lunch and dinner hours" → "a time window" / "menu hours". E.g. 213 hint → `All day, or only during one of the store's menu hours.`; 299 → `...to time-of-day prices, withdraw the all-day price first.` Keep each sentence's meaning. |

Then:
1. Fix any existing test that asserts the old exact text: update ONLY the expected string to the new text, and
   list each such test in the PR body (this is a text change, not a guard relaxation).
2. New test `apps/erp/tests/t567-menu-hours-labels.test.ts`: scans `apps/erp/src` (excluding `app/pos/` and
   code comments is not required: just lines inside JSX/string literals is fine to approximate by scanning
   for the exact phrases) and fails if `Lunch and dinner hours` or `lunch or dinner hours` appears.
3. Not to build: no route or file renames (`/menu/hours` stays), no changes under `apps/erp/src/app/pos/`,
   no database or logic changes, no comment rewrites.

## 4. Checks to run

- `npm run typecheck`
- `npx vitest run --project unit apps/erp/tests/t567-menu-hours-labels.test.ts` plus any test you updated
- the full `npx vitest run --project unit` (paste the summary lines)
- Guard tests that move (census numbers): do NOT edit them; report them in the PR body.

## 5. Done when

The PR shows only the files above (plus updated tests, the new test and the docs/tasks copy), checks pasted.

## Builder notes

