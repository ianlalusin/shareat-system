# T-448 — Forms in modals, one control height, denser pages

Status: SPEC (Opus), 2026-10-22. Ian's request with 16 screenshots, nine concerns.
Builds on T-444 (split workspaces), T-445 (compact controls), T-440 (live field checks).

## Ian's concerns → root cause → fix

| # | Concern | Root cause (measured in source) | Fix |
|---|---|---|---|
| 1 | Uneven input heights | T-445's 32px rule sits inside `:where()` (specificity 0). Any Tailwind `py-*`/`min-h-*` class on a native control or on `Input`/`Select`/`Button` (`min-h-11`, `py-2.5`) beats it, so those stay 38–44px | One compact rule with real specificity (`.erp-page` + element), fine pointer >=768px: 32px, `padding-block: .25rem`; buttons the same. Touch stays 44px |
| 2 | Field alignment | `Field` hint/check lines of different heights push neighbours down; `items-start` | Hints become a `(?)` tip in the label row (#7); check line shows only when failing → rows align on the control |
| 3 | White space, one card per row | Pages stack cards vertically even when 2–3 fit | `CardGrid` (auto-fit, `minmax(min(100%,24rem),1fr)`), used where sibling cards are short |
| 4 | Forms always exposed; disabled inputs on view | Add-forms render inline; `EditableRecord` (32 files) shows a locked `<fieldset disabled>` of inputs | `FormModal`: an action button opens a native `<dialog>` holding the form. `EditableRecord` locked state = just an **Edit** button; editing happens in a modal |
| 5 | Qty/price fields too long | Fields without `width` hint grow to 16–32rem | `Field width="short"` for qty/price/amount/%/days; CSS ceiling already exists for inputmode numeric — apply via Field too |
| 6 | Money accounts columns overlap | Actions column holds a whole edit form (name input + limit + Edit) in a cell | Row shows values; actions cell = Edit button → modal (falls out of #4) |
| 7 | Long description text | `Field hint` and T-440's muted "Required - an amount like 1250.00" line under every field | `hint` renders as `HelpTip` `(?)` beside the label (hover/focus/click toggletip). FieldCheck's muted line becomes screen-reader-only; failing line stays visible. Required fields get a `*` in the label |
| 8 | AP: forms only at the bottom; AP under suppliers | `/ap` = invoice list + two inline forms; `/ap/suppliers` separate | `/ap` = invoices (daily): "+ Log invoice" button top-right → modal. `/ap/suppliers` = supplier directory: "+ Add supplier" → modal. Cross-links in each header. Supplier detail lists its invoices |
| 9 | Trial balance filter wraps | Filter card uses FormGrid tracks; select stretches | Filter bar = `FormGrid layout="fields"` with width hints; Apply inline |

## Amendment A1 — buttons and toasts (Ian, 2026-10-22, same session)

"make all buttons modern, edges more curved; instead of text use white icon on red or black button; on
hover display button name; all toasts display center middle."

- `Button` reads its own words (`action-icons.tsx` `actionIconFor`): Save/Edit/+ Add/Cancel/Delete/Show/
  Apply/Download/Approve/Post… become a round icon button, white glyph on brand red (primary, danger)
  or ink (secondary, ghost). The words stay as the accessible name and the hover name (`data-tip`,
  drawn by one `TooltipLayer` in the root layout, portalled into an open dialog). `icon={null}` keeps
  words; unknown words stay a text pill (`rounded-full`). This supersedes ADR-013's outlined danger
  for ICON buttons only; text danger buttons stay outlined.
- Toaster: centre of the screen, with a check badge; sits below the VOID/POSTED stamp when both show.
- Photo uploads (square drop box, drag-and-drop, finish animation, in-app pan/zoom viewer) were asked
  in the same message and are owned by T-441 S8 (orchestrator), not this task.

## Contract

1. **No behaviour change.** Field names, server actions, validation rules, permissions, posting:
   unchanged. Only where the form is drawn changes.
2. `FormModal` (client): `trigger` label + variant, `title`, `children` (the form). Native
   `<dialog>`: Esc and backdrop close, focus moves in and returns to the trigger, `aria-labelledby`.
   It **closes when the URL changes** (every action redirects with a fresh `?f=`), and
   **opens on load when `defaultOpen`** — the page passes `defaultOpen` when it has a refill
   (`typed`) for that form, so a refused save reopens with the user's typing. Server-rendered
   children are fine (children of a client component).
3. `EditableRecord`: same props. Locked = Edit button only (plus a `summary` slot if a caller
   needs one). Editing = the same form inside a modal; Cancel/Esc = reset + lock. One-open
   registry, `typed` reopen, `__changed`, rules: unchanged.
4. `HelpTip`: `(?)` button, `aria-label="Help: <label>"`, toggles a popover on click/Enter,
   shows on hover; Esc closes. Content reachable by keyboard and screen reader.
5. Heights: fine pointer >=768px, every single-line control and button is 32px; textarea >=64px.
   Coarse pointer 44px. Checked by a test reading globals.css + component classes.
6. No new dependency (no Radix). Native `<dialog>` is supported by every target browser.

## Rollout

- Primitives (Opus): globals.css, Input/Select/Button, FormGrid `Field`, FieldCheck, new
  `FormModal`, `HelpTip`, `CardGrid`, EditableRecord. Index exports.
- Page lanes (Sonnet, disjoint files): the 16 screenshot pages first —
  payroll, payroll/rates, expenses/[id], inventory/locations, inventory/deliveries,
  inventory/usage, inventory/low-stock, menu, money-accounts, prepaid, liabilities, owners,
  ap + ap/suppliers, customers/price-lists, reports/trial-balance, settings/expense-categories.
  Then a sweep of remaining inline add-forms (separate slice, listed in the review doc).

## Verification

Typecheck; affected unit tests (EditableRecord, FieldCheck, kit, touch-target census) updated
where they asserted the old drawing; browser check of each of the 16 pages on desktop + phone
width with screenshots. Report anything not browser-checked plainly.

## Amendment A2 — corner scale

Ian, 2026-10-22: "inputs 12px, cards/tables/banners 20px, modals 24px, buttons and badges fully round.
Keep the dashboard and staff ID cards untouched."

| Thing | Radius | Where |
|---|---|---|
| Input, Select, Textarea (and native page inputs) | 12px | components/ui + globals.css A2 block |
| Card, Table wrapper, Banner (FlashBanner uses it), EmptyState, StatusHero, ConfirmDestructive | 20px | components/ui |
| Inline page panels `rounded-lg` / `rounded-xl` / `rounded-[14px]` | 20px | globals.css A2 block |
| `.erp-dialog` | 24px (phone full-screen stays 0) | globals.css |
| `.erp-help-tip-pop` | 12px | globals.css |
| Button, Badge | full | unchanged |
| Checkbox | 4px | unchanged |

Exclusions: the dashboard (`.erp-page` holding `[aria-label="Right now"]`) and anything inside
`[data-staff-card]`. The inline-panel rule also skips button, input, select, textarea, a, img and anything
inside td/th, so chips and row bits keep their size. Radio, checkbox and file inputs keep their own radius.
Not touched: page.tsx, components/dashboard, app/staff, components/upload, NewDeliveryForm.tsx.
