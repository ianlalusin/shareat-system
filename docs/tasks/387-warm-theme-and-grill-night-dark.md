# T-387: the ERP looks like the brand. SharEat Warm in light, Grill Night in dark

**Status:** BUILD PLAN 2026-10-10 (Opus planner), **ready to build; every open question is answered** (Ian,
2026-10-10: *"4 - a , 5 - a , 6 - a, 7 -a"*). NOT BUILT. Next: S1.
**Ruling:** Ian, 2026-10-09: *"go with B, C as dark mode"*. The values are recorded in ADR-013 **Amendment 7** and
bible §13 **row 295**. ⛔ The values are RULED. This task builds them and does not re-pick them.
**Sources:** brand sheet Artifact `L7hn691wjL76rSV2BgPa1A`; screen looks Artifact `9cvfRibBSRuvBbZYe8DfjW`.
⭐ **Builders read the boards from `docs/design/t387/*.dc.html`** (copied into the repo). They are HTML mock-ups:
copy their geometry, tokens, copy and motion, never their markup. `/_blob/…` image links in them are the logo, which
now lives at `apps/erp/public/brand/`.
**Model:** each slice runs tester first, then builder, then auditor, all as Sonnet subagents of the orchestrator
(memory: lanes as subagents). A spec amendment is written in plan mode (Opus).
**Ship route:** one branch and one PR per slice, merged to `main` only when CI is green (bible row 291).
**Migration:** none. Every slice is tokens, components, read queries and static assets. ⛔ A builder who finds a
need for a migration stops and reports; that would be a spec change.
**Relation to T-334:** this re-values T-334 slice 1's tokens and reshapes slice 2's components. T-334 slice 3's sweep
(local `BTN`/`INPUT` constants) becomes S8 here, so the sweep runs once, onto the finished kit.

## Goal
- Every screen sits on the cream canvas in warm ink, with Baloo 2 headings, Plus Jakarta Sans body text and the
  SharEat logo. Dark mode (the existing `shareat_theme` cookie) shows Grill Night.
- One kit, one look per state: buttons (primary, secondary, ghost, danger × default, hover, focus, disabled,
  pending), fields (default, focus, invalid, disabled), status badge, banner, toast, stamp.
- The dashboard, order status and staff screens look like the boards Ian picked.
- Every contrast figure in Amendment 7 is recomputed by a test from the hex values, not copied.

## v1 as requirement (bible §1.2d)
1. **What v1 does.** Amber on white (`ERP-rebuild/src/app/globals.css`). `status-badge.tsx` maps a status to a tone.
   `bubble-toast.tsx` stamps "approved" or "void". `FormModal.tsx` puts Cancel then Save at the bottom right.
   `StaffIdCard.tsx` is the ID card. The dashboard is KPI cards plus an attention rail.
2. **The goal underneath.** Staff read a document's state at a glance, get a physical confirmation when money
   moves, and recognise their own company in the tool.
3. **Count (measured 2026-10-10).** v2 has 0 badges, 0 toasts and 0 charts. Status display is spread across 16
   local `STATUS_LABEL` maps, 4 `STATUS_TONE` maps and 6 separate `function StatusBadge`. Flash banners appear in 93
   files: `bg-red-50` on 116 lines, `bg-amber-50` on 76 and `bg-emerald-50` on 42. 1 app line imports `Button` from
   the kit.
4. **Beat it.** One `Badge` driven by one tone map that a test keeps complete. One toast system, where v1 had two.
   Errors are marked at the field. A stamp that uses the right word for each entity (see `t387-q5`; v1 said
   "approved" where v2's glossary says the expense is *posted*).

## ⛔ Landmines found while planning (read before building)
| # | Landmine | Where | Consequence for this task |
|---|---|---|---|
| L1 | `theme-tokens.test.ts` pins every light hex and exact contrast figures (5.47, 8.32, 1.77). It also pins dark `--brand` and dark `--warning` as **undefined**, on purpose | `apps/erp/tests/theme-tokens.test.ts:52-63, ~110-122` | S1 rewrites it, deliberately. Amendment 7 is the authority. Keep its negatives: each pinned value needs a mutant that fails |
| L2 | `ui-button.test.ts:100-121` and `ui-input.test.ts:37-56` compare the exact class token sets | the tests | S2 edits the snapshot literals. That is intended, not a regression |
| L3 | The touch-target census models `Button` = 42px and `Input` = 38px by hand (`KNOWN_COMPONENT_HEIGHT_PX`). The baseline is pinned at `{fail:151, unresolved:63}` | `tests/touch-target-geometry.ts:138`, `action-link-sweep.test.ts:207,396` | S2 updates the table to the new heights. Each new kit component that renders an interactive element with a non-literal className adds one UNRESOLVED; bump it with a comment, as earlier bumps did (`:323-386`). A new capitalised component missing from the table **silently leaves the census** (audit F2, `geometry.ts:117-137`), so add `Select`, `Textarea` and `Checkbox` |
| L4 | `components/ui` guards: no stock hue utilities, no `text-warning`, no solid `bg-danger`, **no `'use client'` and no hooks**, no `dark:*-danger`, no `#f87171` | `ui-token-discipline.test.ts` (Guards 7-10), `t334-slice3-danger-token-guard.test.ts` | Server-safe pieces (Badge, Banner, Select, Textarea, Checkbox, Table, StatusHero, StatusIcon, EmptyState) go in `components/ui`. Client pieces (Toaster, Stamp, SubmitButton, CountUp) go in **`components/feedback/`**, a new folder. Do NOT weaken the guards |
| L5 | `BASE_CLASSES` in Button and Input must stay single string literals | `Button.tsx:16-19` | Keep them literal, never `+`-joined |
| L6 | Vitest runs `.test.ts` only, with `environment: node`. There is no jsdom and no testing-library | `vitest.config.mts` | Components are tested with `renderToStaticMarkup`. Client behaviour (toast de-dupe, count-up maths, stamp vocabulary) goes into **pure modules** tested directly. A `.test.tsx` silently runs nothing |
| L7 | The flash cookie lives 60s and is not one-time. Reload or Back within 60s replays it | `apps/erp/src/lib/flash.ts:216,275` | The toast and stamp must de-dupe on the URL's `f` token (sessionStorage), or they fire twice |
| L8 | Status words differ by entity. Approving an expense **posts** it; a cash request is approved and then **released**; dispatch is an order's posting event. `void` vs `voided` spellings both exist | `docs/GLOSSARY.md:154-155`, schema | `statusTone` must accept both spellings. The stamp word comes from a per-action table, not from a verb (`t387-q5`) |
| L9 | Transfer actions throw instead of `redirectWithFlash`, and transfers have no detail page | `inventory/transfers/actions.ts` | Transfers get the Badge only in this task. Their stamp and big-state card wait for the transfer detail page |
| L10 | Trade orders have no `submittedAt`/`submittedBy`. Branch-order stages are derived from timestamps | `trade.ts:88-108`, `domain/src/commissary/orders.ts:58-100` | The big-state card shows times only for the steps that have them. ⛔ No migration to add `submittedAt` |
| L11 | There is no shift or rota table, so a "scheduled" band cannot be drawn for the roster | schema; `store_attendance_config` holds store rules only | See `t387-q6` |
| L12 | `next dev` is dead on this machine (DEF-401). Smoke tests use `npm run start` on 9008 with standalone Playwright Chromium | `docs/SMOKETEST.md:148-190` | Every slice's "seen" step follows SMOKETEST.md. Theme is switched by setting the `shareat_theme` cookie |
| L13 | `AppShell` returns bare children without a session (sign-in, kiosk) | `components/shell/AppShell.tsx` | Mount the Toaster in `layout.tsx`, not in `AppShell`, so sign-in gets toasts |

## Slices (in order; S4 to S7 can overlap once S3 is merged; each slice is one PR)

### S1: tokens, fonts, ground, logo. ⭐ The half-day that changes every screen
**Files:** `apps/erp/src/app/globals.css`, `apps/erp/tailwind.config.ts`, `apps/erp/src/app/layout.tsx`,
`components/shell/Sidebar.tsx` (`Wordmark` at `:111-121` and the drawer at `:261`), `components/shell/TopBar.tsx:105`,
`app/global-error.tsx`. Assets are **already in the repo** at `apps/erp/public/brand/` (prepared by this plan).
- `globals.css`: Amendment 7's table, light and dark, verbatim. Add the new tokens (`--field`, `--field-border`,
  `--muted`, `--brand-ink`, `--warning-ink`, `--info`/`-soft`, `--progress`/`-soft`, `--closed`/`-soft`,
  `--success-soft`, `--warning-soft`). Dark gets `--brand` (`#d40909`, fill only) and `--warning` (`#2b2210`).
  `body { background: var(--canvas); color: var(--ink); font-family: var(--font-body) }`. A base layer puts
  `h1`–`h3` in `var(--font-display)`. Keep `color-scheme: dark` in the dark block (see the comment there). Rewrite every
  header comment the new values make false (the "nothing consumes the tokens" comment, the "dark is incomplete"
  comment).
- `tailwind.config.ts`: a colour for each new token in the existing `alpha()` `color-mix` shape. Keep the 6-space
  indentation the test regex needs (L1). `fontFamily: { sans: ['var(--font-body)', …fallbacks], display: […] }`.
- `layout.tsx`: `next/font/google` for Baloo 2 (600, 700, 800) and Plus Jakarta Sans (400 to 800), each with
  `variable:` and `display: 'swap'`, both classes on `<html>`. ⚠️ next/font downloads at **build** time (in CI) and
  self-hosts the files; the server never calls Google at runtime. Read `node_modules/next/dist/docs/` for the
  next/font API in this Next version before writing (AGENTS.md: this is not the Next you know). Metadata: title
  "SharEat ERP" and `icons` pointing at `/brand/favicon.ico`, `/brand/favicon-32.png` and `/brand/apple-touch-icon.png`.
- Sidebar and TopBar: a 32px logo (`/brand/logo-icon.png`, `alt=""` beside the text) plus the wordmark
  "Shar<span class=text-brand-ink>E</span>at" in `font-display`. The collapsed rail shows only the logo.
- `global-error.tsx`: inline canvas and ink colours. It keeps its own `<html>`, and its dark gap stays documented.
- **Tests (tester first, red):**
  - `theme-tokens.test.ts` rewritten. It pins every Amendment 7 hex in both themes and recomputes each contrast
    figure in the ADR table with a WCAG helper. The new dark `--brand`/`--warning` assertions replace the "undefined"
    pins. **Negatives:**
    - `--field-border: #eadfc6` fails, because it is under 3:1.
    - Dark `--brand-ink: #d40909` fails, because it is under 4.5:1.
    - A `prefers-color-scheme` rule still fails.
  - A layout render test: `<html>` carries both font variables and `data-theme`.
- **Seen (§9.4 plus the render-first memory):** `/sign-in`, `/`, `/expenses/new` and `/reports/income-statement`, in
  light and dark. The screenshots go in the PR. Expect stock-hue islands (old banners, `bg-white` cards) to clash on
  cream. That is S8's job. List them; do not fix them here.
- **Addendum (Opus lead, 2026-10-10, after Ian: *"go on and fix the clash in colors"*): the warm neutral ramp.**
  - The S1 screenshots showed the clash came mostly from stock `neutral-*` grey: 4,946 utilities in 154 of 171 files.
    One part of it was a regression, not a look: stock `text-neutral-500` (the caption grey, 575 lines) is 4.34:1 on
    the new cream canvas, under AA.
  - Fix: `apps/erp/warm-neutral.ts` re-values Tailwind's `neutral` palette (`tailwind.config.ts`). Six steps ARE
    ruled tokens, chosen by how the app uses them: 200 = light `--surface-border`, 400 = dark `--muted`, 500 = light
    `--muted`, 800 = dark `--surface-border`, 900 = dark `--surface`, 950 = dark `--canvas`. The other five keep stock
    neutral's OKLCH lightness in `--ink`'s warm hue. No ruled value was re-picked; no new token was added.
  - `t387-s1-warm-neutral.test.ts` reads the anchors from `globals.css`, holds the others within 3% of stock
    contrast, checks the ramp is monotonic, and asserts captions clear AA on the cream canvas and the dark surface.
  - ⛔ Not fixed by this, and still S2 + S8: buttons stay near-black (`bg-neutral-900` is now warm `#1c1a18`) until
    they move onto `Button`; banners and badges keep stock emerald, amber and red until `Banner`/`Badge`; field
    borders reach `--field-border` only through `Input`/`Select`. ⚠️ S8 removes local `neutral-*` uses file by file;
    the ramp is what keeps the files S8 has not reached yet on-brand meanwhile.

### S2: the kit reshaped (Button, Input, Card) plus SubmitButton
- `Button`:
  - `rounded-[12px]` (`t387-q3` = b; ⛔ never `rounded-full`) and `font-semibold`.
  - The height is the one geometry from `t387-q4`.
  - Secondary gets `hover:bg-canvas`.
  - New `ghost` variant, for Cancel: `border-transparent bg-transparent text-ink hover:bg-canvas`.
  - Danger stays outlined with its icon (ADR-013 §1).
- `Input`: `rounded-[10px] bg-field border-field-border`. `invalid` sets a 2px `border-danger`. `focus-visible:ring-ink`
  is unchanged (Amendment 6). Width stays the caller's choice (the tested rule g).
- `Card`: `rounded-[14px] bg-surface border-surface-border`.
- `components/feedback/SubmitButton.tsx` (`'use client'`):
  - It wraps `Button` and reads `useFormStatus()`.
  - While pending it sets `aria-busy="true"`, `disabled`, a spinner, and `pendingLabel` ("Saving…" by default).
  - Its pure label logic goes in `submit-button-state.ts` and is unit-tested.
- **Tests:**
  - New snapshot literals in `ui-button.test.ts` and `ui-input.test.ts`.
  - `KNOWN_COMPONENT_HEIGHT_PX` set to the new heights, with a comment citing `t387-q4`.
  - Baseline totals may only fall. If they move, regenerate per the JSON `_note`.
  - Ghost: no `bg-brand`, no `border-danger`.
  - SubmitButton SSR markup is not pending by default.
  - Negative: a `rounded-full` on Button fails.
- **Seen:** a form page with primary, secondary, ghost, danger and disabled buttons in both themes, plus keyboard
  focus on each.

### S3: the missing kit (server-safe, all in `components/ui`)
- `Badge` and `statusTone(status)` (`components/ui/status-tone.ts`):
  - `Badge` is a pill with a dot and a word, `role` none. Tones are `info | warning | success | progress | danger |
    closed`, each `bg-<tone>-soft text-<tone>`; warning uses `text-warning-ink`.
  - One table maps **every** status value in `packages/db/schema/*.ts` to a tone, with both `void` and `voided`
    spellings. Labels are sentence case. Branch-order stages (`BRANCH_ORDER_STAGE_LABEL`) are included.
  - **The test imports each schema's status const or enum and fails if any value has no tone.** That is the
    "complete map" guard. Negative: delete one entry and the test fails.
- `Banner` (`tone: error | warning | success | info`):
  - `role="alert"` for error, `role="status"` otherwise. Each tone has an inline icon.
  - Optional `fieldId`: renders "Go to <label>" as `<a href="#fieldId">`. Uses tokens only (Guard 7).
- `FlashBanner({ flash })`: renders `error`, `warning` and `notice` from a `withFlash` result as Banners. `ok` is
  deliberately **not** rendered; the Toaster shows it (S4).
- `Select`, `Textarea`, `Checkbox`: native elements with Input's geometry and its `invalid` contract. Add them to
  `KNOWN_COMPONENT_HEIGHT_PX` and bump UNRESOLVED with a comment (L3).
- `Table`, `Th`, `Td`, `NumTd`: `NumTd` is `tabular-nums text-right`; the header row is `bg-canvas`, and the table
  scrolls in an `overflow-x-auto` box.
- `EmptyState({ illustration, title, body, action })`: the three illustrations from the `Feedback` board (truck,
  flame, magnifier) as inline SVG. `reports/EmptyState` re-exports it.
- `StatusIcon({ kind })`: the 11 animated icons from the `OrderStatus` board (draft, submitted, preparing, ready,
  dispatched, received, disputed, cancelled, rejected, void, counting).
  - The keyframes go in `globals.css` under `@media (prefers-reduced-motion: no-preference)`, so reduced motion gets
    still icons.
  - CSS only, no hooks (Guard 10).
- **Tests:** SSR markup for each; Guards 7 to 10 pass on every new file. Banner error has `role="alert"`. Badge
  never renders a colour without a word. Reduced-motion keyframes are scoped (a static check of `globals.css`).

### S4: feedback wiring. Toast, stamp, field errors
- `flash.ts`:
  - Add `stamp` and `field` to `FLASH_KEYS` (`:52`), to `interface Flash` (`:119`) and to the `pick()` whitelist
    (`:198`).
  - `stamp` is a closed vocabulary from `t387-q5` and is checked in `redirectWithFlash`.
  - `field` is an element id (`[a-z0-9-]{1,40}`).
- `components/feedback/Toaster.tsx` (`'use client'`, mounted once in `layout.tsx`, L13):
  - It receives `{ token, ok, stamp }` from the server layout. The layout needs these values, so it reads the flash
    for the current URL via a small server helper.
  - It shows the `ok` toast bottom-right, with `role="status"` and `aria-live="polite"`, for 4s, from the
    `Feedback` board.
  - It shows the stamp for 1.2s. Under reduced motion the stamp skips the slam and shows the word briefly.
  - It **de-dupes on `token`** through sessionStorage (L7). The pure logic is `toast-dedupe.ts`, unit-tested.
- Field errors: in 3 pilot forms (`/expenses/new`, `/cash-requests` new, `/sales-days/new`), each refusal that names
  a field sends `field`. The page passes `invalid` to that control and the Banner links to it. Other forms follow
  in S8.
- Stamp wiring: one line per action from the `t387-q5` table, in the listed action files (expenses, sales-days, ap,
  cash-requests, payroll, commissary orders, voids).
  - ⛔ This sends a word only. It changes no domain behaviour and no permission.
  - Actions that today return a bare redirect (`approveExpenseAction`, the sales-day actions) gain an `ok` message
    and a `stamp`.
- **Tests:**
  - `redirectWithFlash` refuses a stamp word outside the vocabulary.
  - The de-dupe module shows once per token.
  - Each wired action's flash carries the agreed word, through the flash-jar helper.
  - Negative: the expense approve stamp must be `POSTED`, not `APPROVED` (L8).
- **Seen:** approve an expense, verify a sales day, void something; each shows the toast and stamp once, and a reload
  shows nothing.

### S5: dashboard, editorial (`DashEditorial` board)
**Files:** `apps/erp/src/app/page.tsx` (rewritten), new `app/dashboard/lib.ts`, new `components/dashboard/*`
(`HeroNumber`, `SalesLine`, `StoreBars`, `ChannelDonut`, `OutlineCount`, `RightNowBand`). `Tile.tsx` is retired.
`RangeForm.tsx` becomes preset links plus the existing custom form.
- **Data (all existing functions, called inside the existing `runReport` transaction; no new SQL except one count):**
  | Block | Source |
  |---|---|
  | Hero total and line | `getSalesRollup({groupBy:'day'})` for the range (no caller uses `'day'` yet; it exists, `reports.ts:303`) |
  | Last period, dashed | the same call over the previous equal-length range (new helper `previousRange(from,to)`, unit-tested) |
  | Delta | the two totals |
  | Expenses, net income | `getIncomeStatement` (as today) |
  | AR, AP | `arAging` / `apAging` totals (as today) |
  | By store | `getSalesRollup({groupBy:'store'})`, only when the scope covers more than one store |
  | By channel | `salesRollup.channels` (as today) |
  | Waiting on you | findings (hard, open), low stock, open disputes, open floats (as today) |
  | Right now | on shift: **new** `attendanceDaysRepo.countOpenToday(tx, orgId, storeIds)`, a read-only count of `status='open'` for today's shift day, inside RLS; on the road: `inFlightOrders` stage `dispatched`; books: `balanceSheet.ties` and totals |
- **Differences from the board, decided here:**
  - Sparklines appear only where a series exists, which is sales. There is no per-day expense series and no AR/AP
    history. A per-day expense series is a follow-up.
  - The "busiest day" callout comes from the day series.
- Presets: Today, 7 days, 30 days and Month-to-date are `?range=` links. The custom from/to form stays. Preset
  buttons are 12px rectangles, the segmented control from the `Shapes` board.
- Motion:
  - Pure CSS: the line draws itself, bars grow and the donut fills.
  - The hero count-up is `components/feedback/CountUp.tsx` (client). Its easing maths is a pure tested module, and
    it shows the final value immediately under reduced motion. Every number is also present as text in the SSR
    output.
- Gate unchanged: `reportScope('/', 'view_financial_reports', sp.store)`. ⛔ Do not add data the gate does not
  already cover. "On shift" is a count only, never names.
- **Tests:**
  - `previousRange` edge cases: month boundaries and 1-day ranges.
  - `countOpenToday` under RLS: store B's rows are invisible to a store-A-scoped actor. That is the ✗ proof.
  - Page SSR contains each block's text value.
  - With one store in scope, there is no "By store" block.
- **Seen:** `/` in light and dark, at 1440 and 390 wide, with each preset clicked.

### S6: order status, the big state (`OrderStatus` board, option 3)
- `components/ui/StatusHero.tsx` (server-safe):
  - Props: `{ kind, word, step, steps, line, tone, children /* the action */ }`.
  - It renders the `StatusIcon`, the large state word, the chevron progress (`steps` cells: done, current, todo),
    one line on what happens next, and the action slot.
  - Side exits (rejected, cancelled, void, disputed) show the red state with the chevrons greyed from that step.
- Adopted on:
  1. `commissary/orders/[id]/page.tsx`. Stage comes from `branchOrderStage()`. The steps are draft → submitted →
     accepted → ready → dispatched → received. The "next" line is written per stage and per side (branch vs
     commissary, already computed on the page). The action slot is the existing primary form for that stage.
     Timestamps show only where a column exists (L10).
  2. `inventory/deliveries/[id]/page.tsx`. Steps: draft → received.
  3. `trade/orders/[id]` if it has a detail page; otherwise a Badge.
- The Badge (S3) replaces the status text in the order, delivery, transfer and trade-order **lists**. Transfers print
  raw `{t.status}` today (L9).
- **Tests:** stage → step-index mapping for every stage; side-exit rendering; the next-line text per stage and side.
  Negative: an unknown stage throws, not blank.
- **Seen:** one order walked from draft to received, in both themes and at phone width.

### S7: staff, the ID card wall plus the live roster (`StaffCards`, `StaffRoster` boards)
- `/staff`: `?view=cards` is the default and `?view=roster` is the second view, as a segmented control. Store picker
  as today.
- Cards: the lanyard ID card from the board. It shows the name, primary position, store, tenure from `startedOn`,
  the employment status, and the live-state chip. Hire stays the one primary button. The positions card stays below
  the wall.
- Photo:
  - **New read** `employmentRepo.photoFileIds(tx, employmentIds)`, which reads `employments.photo_file_id`. No
    migration; the view is not altered.
  - The photo is shown through the existing `/files/[fileId]` route, only when `canViewPhoto(actor, fileId)`.
    Otherwise initials on a tone.
- Live state: **new** domain read `todayStateFor(tx, actor, storeId)`, giving `{ employmentId → on | break | off }`
  plus the times.
  - It is built from today's `attendance_days` (`status='open'`) and the latest punch intent (`break_start` → break).
  - **Gated like `attendanceRoster`** (`manage_attendance` for that store). Without it the chip is not rendered.
  - A capability ✓ needs its ✗ test (CAPABILITY-MATRIX).
- Roster view: rows with the avatar ring (state colour), name and position, a day strip (worked, break, now), hours
  this cutoff (if a cheap existing read gives it; otherwise omitted), and the state chip. The scheduled band waits on
  `t387-q6`.
- **Tests:**
  - `todayStateFor`: on, break and off from fixtures.
  - The gate ✗: a store-A manager gets nothing for store B, and a person without `manage_attendance` gets no chips.
  - `photoFileIds` under RLS.
  - The tenure formatter.
- **Seen:** `/staff` in both views and both themes, with a photo and without.

### S8: the sweep onto the kit (was T-334 slice 3). ✅ Runs as a Workflow (`t387-q7` = a)
Mechanical, many files. Ian opted in to a multi-agent Workflow for this slice (2026-10-10). Workflow agents edit
only; the orchestrator runs the guards, tests and smoke, then commits each tranche.
- The 93 flash-banner files → `FlashBanner`. The `ok` banners are removed because the Toaster shows them.
- The 16 `STATUS_LABEL`, 4 `STATUS_TONE` and 6 local `StatusBadge` → `Badge` + `statusTone`.
- Local `BTN`/`INPUT` constants (T-334 slice 3's census: 65 files, 99 declarations) → `Button`/`Input`. Raw
  `<select>` → `Select`.
- Stock-hue islands listed during S1's screenshots.
- Each tranche: guards green, the touch-target totals only fall, and screenshots of three touched pages.

## Not in this task (follow-ups to allocate after S7; each needs its own spec)
| Board | Why not here |
|---|---|
| Leaderboard, checklist photo review, memo signing kiosk, onboarding exam | Ian accepted the looks (2026-10-09), but **the features do not exist in v2** (performance scoring, checklists, memos, onboarding). Each is a capability first. They are already tracked in `docs/CAPABILITY-GAPS.md` (performance scoring is Phase 7; onboarding is the row at `:357`). When one is specced, it cites its board in `9cvfRibBSRuvBbZYe8DfjW` as the UI reference |
| Payslip, 2 per page, employee and office copy | Payroll exists in v2. A print view is a self-contained follow-up (`/payroll/[run]/payslips/print`), with the board as the reference |
| 80mm delivery receipt | v2 has no thermal print path yet |
| Till count, clock terminal | Not reviewed by Ian yet |
| Hour-by-day heat map | POS, not the ERP (Ian) |
| A 52px floor density | A second size; Ian's call (Amendment 3) |

## Screen picks: Ian, 2026-10-09 (from the sheet "SharEat ERP Screen Looks", Artifact `9cvfRibBSRuvBbZYe8DfjW`)
Ian, verbatim: *"1. editorial 2. option 3 big state, 3. other i like the id card wall, roster with live stat 4. i like
the heatmap for pos not erp"*. On the success toast: *"i like this toast notif at the bottom too"*.

| Screen | Chosen look (board) | Slice |
|---|---|---|
| Dashboard `/` | **Editorial** (`DashEditorial`) | S5 |
| Order and delivery status | **Option 3, the big state** (`OrderStatus`) plus the animated icon set | S3 (icons), S6 |
| Staff `/staff` | **ID card wall** (`StaffCards`) default, **roster with live state** (`StaffRoster`) second view | S7 |
| Success feedback | **Toast at the bottom right** (`Feedback`). Errors stay banners plus the field | S4 |
| Hour-by-day heat map | **Not for the ERP.** POS (`DashScoreboard`) | out |

✅ **Button shape RULED: a 12px rounded rectangle for every button in the app** (Ian, 2026-10-09: *"rounded rectangle
like your pick"*). Pills only for status badges, filter chips and counts.

**Board feedback (Ian, 2026-10-09):** *"performance good, could be better, checklist good, memo signing good,
onboarding good, payslip must be compressed 2 slips per page duplicate for employee and office copy with signature
and confirmation texts"*. Done the same day on the canvas: the leaderboard was improved, and the payslip became 2-up
with employee and office copies. Checklist, memo kiosk and onboarding were accepted as drawn.

## Open questions (for Ian)
- `t387-q1-toast`: ✅ **ANSWERED (a), 2026-10-09.** Success becomes a toast; errors stay as banners.
- `t387-q2-stamp`: ✅ **ANSWERED (a), 2026-10-09:** *"keep the stamp"*.
- `t387-q3-shape`: ✅ **ANSWERED (b), 2026-10-09.** A 12px rounded rectangle.
- `t387-q4-height`: ✅ **ANSWERED (a), Ian 2026-10-10. Every button and field is 44px.** Was: should every button and field be **44px** tall? Today a Button is 42px and an Input
  is 38px. The boards Ian approved draw 44px, and 44px is the touch-target floor the shell already uses on touch
  screens. (a) 44px for both · (b) keep 42 and 38. **Recommended: (a).** Controls only get bigger, which Amendment 3
  allows.
- `t387-q5-stamp-words`: ✅ **ANSWERED (a), Ian 2026-10-10. The table below is the stamp vocabulary.** One word per action, following the glossary:
  | Action | Stamp |
  |---|---|
  | Verify a sales day, an AP invoice, an attendance day | VERIFIED |
  | Approve an expense (it posts), post payroll, post usage or production | POSTED |
  | Approve a cash request | APPROVED |
  | Release a cash request | RELEASED |
  | Receive an order or a delivery | RECEIVED |
  | Any void | VOID |
  | Reverse a remittance, a loan entry, a prepaid month | REVERSED |

  (a) as listed · (b) changes. **Recommended: (a).**
- `t387-q6-schedule`: ✅ **ANSWERED (a), Ian 2026-10-10.** Build the roster without a scheduled band. "Staff schedules" is now in `docs/CAPABILITY-GAPS.md` (added 2026-10-10). Was: v2 has no shift schedule (neither did v1). Build the
  roster now with worked, break and now, and no scheduled band? (a) yes, and add "staff schedules" to CAPABILITY-GAPS
  as its own feature · (b) wait for schedules. **Recommended: (a).**
- `t387-dark-warning-soft`: ✅ **RULED by Ian, 2026-10-10: "keep #2b2210".** ADR-013 Amendment 7 gives no dark
  `--warning-soft`; S1 reused the dark `--warning` surface (`#2b2210`, warning-ink on it 8.86:1). Pinned in
  `theme-tokens.test.ts`. Dark `--brand-hover` stays unruled (inherits `#b00707`).
- `t387-q7-sweep`: ✅ **ANSWERED (a), Ian 2026-10-10. S8 runs as a multi-agent Workflow.** This is Ian's explicit opt-in for that slice only. Was: run the sweep as a multi-agent **Workflow** (fast, more tokens), or as ordinary lane
  tranches (slower, fewer tokens)? (a) Workflow · (b) lane tranches.

## Done when
- S1 to S7 are each merged by their own PR with green CI (bible row 291). Each PR carries its screenshots in both
  themes.
- `theme-tokens.test.ts` recomputes every Amendment 7 figure, and each pinned value has a negative that fails.
- The tone map test proves every schema status has a tone.
- S8 is done when no `bg-red-50`, `bg-amber-50` or `bg-emerald-50` flash banner, and no local `STATUS_LABEL`, is left
  in `apps/erp/src`.
