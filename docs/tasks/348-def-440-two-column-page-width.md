# T-348: page descriptions use the full width and clamp at 3 lines (DEF-474); two-column pages use the full width (DEF-440)

**Status:** APPROVED 2026-09-28 (orchestrator) — S0 renders first; S1-S3 follow Ian's picks. Planner: Opus, 2026-09-28. Supersedes the reservation text.
**Defects:** DEF-474 (🔸, Ian 2026-09-28, from `/liabilities`), DEF-440 (⚠️, Ian 2026-09-26). **Migration:** none, any slice.
**Governing rules:** bible §1.2c (one uniform, reusable pattern set across screens); "render before deciding" (a
rendering-dependent choice is made from screenshots, not argument); RULES §2 (tests first and red for the right
reason; smoketest on 9008; the spec names the files).

## Ian's requirement (DEF-474)
The description under a page title must: use the **full content width**; **adapt to screen size**; be **at most 3
lines on any screen**; when longer, **clip with "…"** and show an **expand control (arrow)** that reveals all of it.
One shared component, every title description.

## Census (planner-verified 2026-09-28, working tree incl. uncommitted edits)
Method in Appendix B. **139** `<h1>` + `<p>` pairs in `apps/erp/src/app`, classified:

| Class | Sites | Treatment |
|---|---|---|
| **A. Title description** — `text-sm text-neutral-600 dark:text-neutral-400`, optionally `mt-1` / `max-w-2xl` / `max-w-3xl`; plus the `admin/stores` and `admin/users` list pages, whose prose uses `neutral-500` | **102 in 92 files** | **Swept** (Appendix A) |
| · of which capped `max-w-2xl` / `max-w-3xl` | 39 + 8 = **47** | cap removed |
| · of which carry inline markup (`strong`/`em`/`code`/`span`/links) | 46 | children kept verbatim |
| · of which contain a link (`Link`/`a`) | 9 — `budgets`, `customers`, `expenses/new`, `money-accounts`, `money-transfers`, `payroll/separations`, `settings/attendance`, `settings/organization`, `settings/sales-channels` | focus expands (S1 item 6) |
| · of which are early-return one-liners ("No store is set up yet.", no margin) in 10 two-site files | 10 | swept for uniformity; never overflow, so no control renders |
| B. Empty-state body message (`mt-4` / `mt-2`, "no stores yet") | 24 | not a description; untouched |
| C. Record-metadata subtitle in `neutral-500` — `admin/stores/[id]:75`, `admin/users/[personId]:83`, `items/[id]:62`, `staff/[employmentId]:49` | 4 | untouched (one line of facts, different tone) |
| D. Not a description — `admin/stores/[id]:56` amber callout, `ap/suppliers/[id]:64` "Owed" label, `customers/[customerId]:112` treatment badge | 3 | untouched |
| E. Own layout / pre-session / error — `sign-in`, `setup`, `clock`, `error.tsx`, `global-error.tsx`, `not-found.tsx` | 6 | untouched (allowlisted out of the `Page` sweep; `global-error` owns its own `<html>`) |

DEF-474's figures (118 / 45 / ~103) were an estimate; 102 / 47 supersede them (register corrected at wrap-up, not by a
lane). **`PageHeader` has zero callers today** (no `<PageHeader`, no `<Page title=`): all 102 hand-roll. Section blurbs
capped `max-w-2xl` that are not under the page title (`findings/page.tsx:241,319,379`, `payroll/page.tsx:337`,
`remittance/page.tsx:479`, `till/page.tsx:101`) are out of scope.

⚠️ **11 of the 92 files are dirty in the working tree today** (DIRTY in Appendix A — an in-flight T-343 lane). S2 does
not start until they are committed; line numbers are re-derived by the census at S2 start.

## DEF-440 (register row read, verified at source)
Eight pages sit in `<Page density="form">` (`max-w-3xl`, 768 px) and leave most of a ~1600 px area empty. ⚠️ The row
says each splits that into `lg:grid-cols-2`; at source **only `admin/stores/[id]/page.tsx:102` does**. The other seven
use in-form field grids (`sm:grid-cols-2`; `settings/attendance:250` `md:grid-cols-3`; `expenses/new:90` a bare
`grid-cols-2`) inside the 768 px cap. The defect stands; the mechanism differs per page. **Independent of DEF-474 in
mechanism** (density/layout, not the description) **but it shares files** (`cutover/opening`, `fixed-assets/new`,
`settings/attendance`, `expenses/new`, `settings`, `admin/users/[personId]` …) → its own slice, **after** the sweep,
never in parallel with it.

---

## S0: render the candidates; Ian picks (nothing committed)
**Model:** Sonnet, TESTER only. **Migration:** none. **BUILDER paths:** none. **TESTER paths:** a throw-away prototype
of `apps/erp/src/components/shell/PageDescription.tsx` and temporary edits to the pages below, on 9008; **reverted
before the slice ends; nothing from S0 is committed** (`git diff` empty at the end is part of done).

**S0a — DEF-474 treatments** on `/liabilities` (`liabilities/page.tsx:37`, 238 chars, `<strong>`),
`/payroll/separations` (`:71`, 395 chars, a link) and `/money-accounts` (`:46`, 387 chars, `Link` + `em` + `strong`):
- **T1 — inline chevron:** `line-clamp-3`; a chevron button pinned to the end of line 3 over a short fade, the native
  "…" still visible. Zero layout shift.
- **T2 — "Show more ▾" below:** `line-clamp-3`; text + chevron button on its own line under the paragraph. Clearest
  affordance; a one-line shift when the client discovers the overflow after hydration.
- **T3 — right-gutter chevron:** paragraph `flex-1`, chevron in a fixed ~44 px gutter at its right, aligned to line 3.
  Zero shift; costs ~44 px of width on overflowing descriptions only.
Each at **375, 1366, 1920 px × light + dark × collapsed + expanded**. Deliver one contact sheet per treatment (3) plus
one side-by-side row of the three at 1366 light collapsed. Record, per page and width, whether the text overflows at
all (at 1920 some will not — correct, not a failed render).

**S0b — DEF-440 widths** on `admin/stores/[id]`, `expenses/new`, `settings` at 375 / 1366 / 1920, light:
- **W1** status quo `form`. **W2** `density="table"`, content unchanged (fields stretch). **W3** `density="table"` with
  the page's top-level sections in `lg:grid-cols-2`, field grids unchanged inside each card. **W4** `table` density with
  the form column capped (`max-w-3xl` on the form element) and the page's summary/status in a right rail where one
  exists.

**Done when:** the sheets are in front of Ian, he has named one T and one W (or a variant), and the orchestrator has
written them into this spec as Amendment A1. `git status` shows no S0 residue.

---

## S1: the `PageDescription` component (+ `PageHeader` uses it)
**Model:** Sonnet, tester then builder. **Migration:** none. Visual treatment = Ian's S0a pick; items 1–8 hold for
all three.

1. **New file `apps/erp/src/components/shell/PageDescription.tsx`**, `'use client'` on line 1, React 18 hooks.
   ⛔ **Its own module — not exported from `Page.tsx`.** Five tests replace that module wholesale with
   `vi.mock('@/components/shell/Page', () => ({ Page: … }))` (`t343-s5-5r-prepaid-refund-render`,
   `t343-s6b-admin-users-labels`, `t343-s6c-screen-labels`, `t343-s6d-wastage-detail-label`,
   `t349-hold-own-right-page`); an export living in `Page.tsx` would be `undefined` under those mocks and crash the page
   render. Signature: `export function PageDescription({ children, className }: { children: ReactNode; className?:
   string })`. `className` is **spacing only** (`mt-1` where the site had it); size and tone belong to the component.
2. **Server render = clamped, no control.** The `<p>` renders `text-sm text-neutral-600 dark:text-neutral-400
   line-clamp-3` (Tailwind 3.4 core; gives the native "…"), `id` from `useId()`. Initial state `{ overflows: false,
   expanded: false }`, so server HTML equals the first client render: no hydration mismatch, no flash of full text.
3. **Overflow detection.** Exported pure helper `exceedsLines(scrollHeight: number, lineHeightPx: number, lines = 3):
   boolean` = `scrollHeight > Math.ceil(lineHeightPx * lines) + 1`. `scrollHeight` is the full content height whether
   clamped or expanded, so one formula is right in both states — ⛔ a `scrollHeight > clientHeight` check goes false the
   moment the user expands, and the collapse control would vanish. Measured in `useLayoutEffect` on mount and from a
   `ResizeObserver` on the `<p>` (disconnected on unmount); `lineHeightPx = parseFloat(getComputedStyle(p).lineHeight)`.
4. **The control** renders only when `overflows`: `<button type="button" aria-expanded={expanded}
   aria-controls={id}>`, accessible name "Show full description" / "Show less" (the chevron glyph/SVG is
   `aria-hidden`); chevron rotates, no animation. Native button = Enter/Space. Focus ring: `focus-visible:outline
   focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500` (the `sidebar-state.ts:52`
   convention). **Hit area ≥ 44×44 CSS px as authored classes** (`min-h-11 min-w-11`) so `touch-target-geometry.ts`
   resolves it PASS (its floor is 24 px). Colour `text-neutral-600 dark:text-neutral-400`, hover `text-neutral-900
   dark:text-neutral-100`; any fade uses the page background in both themes.
5. **Expanded** drops `line-clamp-3`. State is per page view, not persisted.
6. **A link hidden by the clamp must not take focus invisibly.** `onFocus` on the `<p>` (React focus events bubble):
   if `!expanded` and the focused element's box lies below the clamped box's bottom, set `expanded = true`. Keeps the
   9 linked descriptions keyboard-reachable.
7. **`PageHeader` (`Page.tsx:131-144`)** renders `<PageDescription className="mt-1">{description}</PageDescription>` in
   place of its `<p>`; its text column becomes `min-w-0 flex-1` so the description takes the row beside the actions.
   `description` stays `string` (no caller to widen it for).
8. ⛔ **Do not add `PageDescription` to `OPAQUE_COMPONENTS`** (`apps/erp/tests/touch-target-geometry.ts:98`). Its button
   is resolved at its definition; listing it would turn 102 call sites into 102 UNRESOLVED (= FAIL).

- **BUILDER paths (2):** `apps/erp/src/components/shell/PageDescription.tsx` (new), `apps/erp/src/components/shell/Page.tsx`.
- **TESTER paths (2):** `apps/erp/tests/t348-page-description.test.ts` (new); `apps/erp/tests/action-link-sweep.test.ts`
  (baseline only: candidate total `1054 → 1055` at `:250` and PASS +1, with a dated history comment in the file's own
  style — if the resolver instead reports the button UNRESOLVED, STOP and report; do not bump FAIL/UNRESOLVED).
  No jsdom/happy-dom is installed and `vitest.config.mts` runs `environment: 'node'` — **do not add one**; browser
  behaviour is the smoketest leg.
  - **Red legs** (red today because the module does not exist — the right reason):
    - R1 `exceedsLines`: `(60,20)`→false; `(61,20)`→false (≤ 1 px rounding); `(62,20)`→true; `(200,20)`→true;
      `(59.5,19.5)`→false.
    - R2 `renderToStaticMarkup(<PageDescription>` ~400 chars incl. `<strong>x</strong>` `</PageDescription>)`: exactly
      one `<p>` whose class contains `line-clamp-3`, `text-sm`, `text-neutral-600`, `dark:text-neutral-400`; no `max-w-`;
      `<strong>x</strong>` preserved; **no `<button`** (the server never renders the control).
    - R3 `className="mt-1"` appears on the `<p>`.
    - R4 `renderToStaticMarkup(<PageHeader title="T" description="D" />)` contains `line-clamp-3`, and the text column
      class contains `flex-1` (red today: a plain `<p>`, no `flex-1`).
    - R5 code-only scan (comments stripped) of `PageDescription.tsx`: `'use client'` is line 1; contains
      `aria-expanded`, `aria-controls`, `ResizeObserver`, `.disconnect(`, `min-h-11`, `min-w-11`, `focus-visible:`,
      `onFocus`.
    - R6 `touch-target-geometry.ts`'s `OPAQUE_COMPONENTS` does not contain `'PageDescription'` (green; pins item 8).
  - **Smoketest (tester, 9008, after the builder):** temporarily render `/liabilities`'s description through the
    component (revert, or defer this leg to S2): at 375 the control shows and "…" is visible; click expands and
    `aria-expanded` flips; click collapses; collapsed at 1920 the control is absent if the text fits and reappears on
    narrowing (ResizeObserver); Tab reaches it with a visible ring; dark mode legible; no hydration warning in the console.
- **Out of scope:** the sweep (S2); persisting expanded state; animation.
- **Done when:** R1–R5 red→green, R6 green; `action-link-sweep` green at the new baseline; typecheck clean; smoketest
  recorded.

---

## S2: the sweep — 102 descriptions in 92 files (SWEEP-SHAPED)
**Model:** Sonnet, tester then builder. **Migration:** none. **Preconditions:** S1 committed; the 11 DIRTY files
committed by their lane; census re-run at start and diffed against Appendix A — a site added or removed since
2026-09-28 is reported, not silently absorbed.

1. At every Appendix A site: `<p className="[mt-1 ][max-w-2xl |max-w-3xl ]text-sm text-neutral-600
   dark:text-neutral-400">…</p>` → `<PageDescription[ className="mt-1"]>…</PageDescription>`. Children
   **byte-identical** (`strong`/`em`/`code`/`span`/`Link`/`a`/`{' '}`/`&apos;` untouched). `mt-1` carried exactly where
   it was; `max-w-*` dropped (that is the fix). Import `{ PageDescription } from '@/components/shell/PageDescription'`.
2. `admin/stores/page.tsx:37` and `admin/users/page.tsx:28` are prose descriptions in `neutral-500`; they move to the
   component's `neutral-600` — the one deliberate tone change, uniform with the other 100.
3. Early-return branches are separate sites: 10 files carry two (Appendix A lists every site, not every file).
4. Nothing else on the page changes — no heading moved into `PageHeader` (a content change `Page.tsx`'s docstring
   defers to a deliberate pass), no density change (that is S3).
5. `tests/unit/page-container.test.ts:172-179`'s docstring says a `max-w-2xl` description paragraph is "right to" cap —
   now false for title descriptions. The tester rewrites that paragraph to cite DEF-474 (comment only; the
   `mx-auto` + `max-w-` rule is unchanged and still passes).

- **BUILDER paths (92):** every file in Appendix A.
- **TESTER paths (2):** `apps/erp/tests/t348-page-description-sweep.test.ts` (new); `tests/unit/page-container.test.ts`
  (docstring only).
  - **Red legs:**
    - SW1 (the ratchet): in every `apps/erp/src/app/**/*.tsx` outside class E, a `<p` within 7 lines after an `<h1`
      whose class contains `text-sm text-neutral-600` and does not start `mt-4 ` / `mt-2 ` is a violation; expected `[]`.
      Red today: 100 (the two `neutral-500` prose sites are pinned by SW3).
    - SW2: no `<p` within 7 lines after an `<h1` carries `max-w-2xl` or `max-w-3xl`. Red today: 47.
    - SW3: `admin/stores/page.tsx` and `admin/users/page.tsx` each render `<PageDescription` after their `<h1`.
    - SW4: exactly **102** `<PageDescription` call sites under `app/` (a dropped or double-wrapped site fails).
    - SW5: the 9 linked sites keep their link targets — the tester records the 9 pre-sweep `href`s as literals first;
      after, each is inside a `<PageDescription>`.
  - **Green before and after (must not move):** SW6 — the 24 + 4 + 3 class B/C/D sites keep their exact current class
    strings; `page-container.test.ts`; `action-link-sweep` at S1's baseline (call sites are not candidates); the five
    `vi.mock(Page)` render tests (they get the real `PageDescription`, which renders its children on the server); every
    test reading description TEXT through `renderToStaticMarkup` (text unchanged). No existing test asserts
    `max-w-2xl`/`max-w-3xl` on a description (grepped: `apps/erp/tests`, `tests`, `packages/*/tests`).
  - **Smoketest:** `/liabilities`, `/payroll/separations`, `/money-accounts`, `/expenses/new`, `/admin/stores` at 375 and
    1920, light + dark: the description spans the content width; long ones stop at 3 lines with "…" and the control;
    short ones render whole with no control.
- **Out of scope:** the 6 section blurbs; classes B–E; `PageHeader` adoption; `apps/pos` / `apps/customer` (not built).
- **Done when:** SW1–SW5 red→green, SW6 green throughout, full `apps/erp` unit suite green, typecheck clean,
  `npm run build` (dev server stopped) clean, smoketest recorded.

---

## S3: DEF-440 — the eight two-column pages use the full width
**Model:** Sonnet, tester then builder. **Migration:** none. **Preconditions:** S2 committed (shared files); Ian's W pick
recorded as Amendment A1. Items 1–2 are written for **W3**, the planner's expectation; if Ian picks W2 or W4 the
orchestrator rewrites them in A1 before this runs.

1. On `admin/stores/[id]`, `admin/users/[personId]`, `cutover/opening`, `expenses/new`, `fixed-assets/new`,
   `settings/attendance`, `settings`, `staff/hire` (all `apps/erp/src/app/<route>/page.tsx`), the **main** return's
   `<Page density="form">` becomes `density="table"`. The early-return branches that render only a heading and a
   message (`admin/stores/[id]:49`, `settings/attendance:39`, `staff/hire:41`) stay `form`.
2. The page's top-level sections sit in `grid gap-6 lg:grid-cols-2` (`admin/stores/[id]:102` already does). In-card
   field grids are unchanged. A page with one form card spans it (`lg:col-span-2`) with `max-w-3xl` on the FORM
   element — a measure, not a container (`page-container.test.ts` forbids only `mx-auto` + `max-w-`).
3. Report the register correction (only one of the eight used `lg:grid-cols-2`); the row is fixed at wrap-up.
- **BUILDER paths (8):** the eight `page.tsx` files above.
- **TESTER paths (1):** `apps/erp/tests/t348-def440-page-width.test.ts` (new).
  - **Red legs:** P1 each of the eight's main return uses `density="table"` (red: `form`). P3 (W3) each page's
    top-level section wrapper carries `lg:grid-cols-2`, or the single card carries `lg:col-span-2` (red on 7 of 8).
  - **Green before and after:** P2 the three named early-return branches still use `form`.
  - **Smoketest:** the eight at 375 / 1366 / 1920, light + dark: no sideways scroll at 375 (DEF-199's lesson), no field
    stretched absurdly at 1920, dark mode legible.
- **Out of scope:** other `form`-density pages (Ian named eight); `DetailLayout` changes.
- **Done when:** P1/P3 red→green, P2 green; full `apps/erp` unit suite, typecheck and build clean; smoketest recorded.

---

## Order and parallelism
S0 → Ian picks → S1 → S2 → S3, strictly serial: S1 creates what S2 uses; S2 and S3 share six files. No integration
tests, no DB, so no lane database.

## Questions only Ian can answer
1. **S0a:** which treatment — T1 inline chevron, T2 "Show more" below, or T3 right gutter (from the screenshots).
2. **S0b:** which width — W1–W4 (from the screenshots).
3. The 4 record-metadata subtitles (class C) and the 6 section blurbs stay as they are unless Ian says "every paragraph".

---

## Appendix A — the 102 sweep sites (under `apps/erp/src/app/`; `:line`, cap if any; DIRTY = uncommitted edits on 2026-09-28)
- `admin/access-defaults/page.tsx` :90 (max-w-2xl)
- `admin/stores/page.tsx` :37
- `admin/users/page.tsx` :28
- `ap/invoices/[id]/page.tsx` :72
- `ap/page.tsx` :32 (max-w-2xl)
- `ap/suppliers/page.tsx` :51 (max-w-3xl)
- `attendance/[dayId]/page.tsx` :89
- `attendance/lane/page.tsx` :69 (max-w-2xl)
- `attendance/page.tsx` :57, :79
- `attendance/terminals/page.tsx` :78 (max-w-2xl)
- `budgets/page.tsx` :60 (max-w-2xl)
- `cash-requests/[id]/page.tsx` :60 — DIRTY
- `cash-requests/page.tsx` :49 (max-w-2xl) — DIRTY
- `channel-settlements/page.tsx` :61 (max-w-2xl)
- `commissary/catalogue/page.tsx` :79 (mt-1,max-w-3xl)
- `commissary/discrepancies/page.tsx` :65 (mt-1)
- `commissary/orders/[id]/page.tsx` :85 (mt-1)
- `commissary/orders/page.tsx` :65 (mt-1)
- `customers/page.tsx` :48 (max-w-2xl)
- `customers/price-lists/[id]/page.tsx` :42 — DIRTY
- `customers/price-lists/page.tsx` :31 (max-w-2xl)
- `cutover/count/page.tsx` :54 (max-w-2xl)
- `cutover/opening/page.tsx` :56 (max-w-2xl) — DIRTY
- `cutover/page.tsx` :41 (max-w-2xl)
- `expenses/[id]/page.tsx` :111
- `expenses/new/page.tsx` :53
- `expenses/page.tsx` :50
- `expenses/recurring/page.tsx` :82 (max-w-2xl)
- `findings/page.tsx` :82 (max-w-2xl)
- `findings/scorecard/page.tsx` :36 (max-w-2xl)
- `fixed-assets/new/page.tsx` :34 — DIRTY
- `fixed-assets/page.tsx` :71 (max-w-2xl)
- `inventory/counts/[id]/page.tsx` :111 (mt-1)
- `inventory/counts/page.tsx` :58
- `inventory/deliveries/[id]/page.tsx` :64 (mt-1)
- `inventory/deliveries/page.tsx` :57 (mt-1,max-w-2xl)
- `inventory/locations/page.tsx` :70 (mt-1,max-w-3xl)
- `inventory/low-stock/page.tsx` :63 (mt-1)
- `inventory/pos-map/page.tsx` :48 (mt-1,max-w-2xl)
- `inventory/pos-usage/page.tsx` :171 (mt-1,max-w-2xl)
- `inventory/production/[id]/page.tsx` :48 (mt-1)
- `inventory/production/page.tsx` :54 (mt-1,max-w-2xl)
- `inventory/returns/page.tsx` :119 (mt-1)
- `inventory/transfers/page.tsx` :96 (mt-1)
- `inventory/usage/[id]/page.tsx` :53 (mt-1)
- `inventory/usage/page.tsx` :53 (mt-1,max-w-2xl)
- `items/page.tsx` :39 (max-w-2xl)
- `liabilities/[id]/page.tsx` :57 — DIRTY
- `liabilities/page.tsx` :37 (max-w-2xl)
- `loans/[id]/page.tsx` :44 — DIRTY
- `loans/page.tsx` :36 (max-w-2xl) — DIRTY
- `money-accounts/page.tsx` :46 (max-w-2xl)
- `money-transfers/page.tsx` :64 (max-w-2xl)
- `owners/[id]/page.tsx` :62 — DIRTY
- `owners/page.tsx` :48 (max-w-2xl)
- `page.tsx` :141 (mt-1,max-w-2xl)
- `payroll/page.tsx` :54, :85 (max-w-3xl) — DIRTY
- `payroll/separations/page.tsx` :50, :71 (max-w-3xl)
- `payroll/thirteenth-month/page.tsx` :40, :58 (max-w-3xl)
- `prepaid/[id]/page.tsx` :47
- `prepaid/page.tsx` :53 (max-w-2xl)
- `remittance/page.tsx` :49, :80 (max-w-2xl)
- `reports/ap-aging/page.tsx` :62
- `reports/ar-aging/page.tsx` :61
- `reports/balance-sheet/page.tsx` :54
- `reports/cash-flow/page.tsx` :59
- `reports/income-statement/page.tsx` :65
- `reports/journal-lines/page.tsx` :85
- `reports/pos-reconciliation/page.tsx` :49
- `reports/sales-rollup/page.tsx` :72
- `reports/store-comparison/page.tsx` :86
- `reports/trial-balance/page.tsx` :65
- `sales-days/[id]/page.tsx` :87
- `sales-days/new/page.tsx` :49
- `sales-days/page.tsx` :59
- `service-charge/page.tsx` :32, :48 (max-w-2xl) — DIRTY
- `settings/attendance/page.tsx` :41, :53 (max-w-2xl)
- `settings/expense-categories/page.tsx` :65 (max-w-2xl)
- `settings/organization/page.tsx` :66 (max-w-2xl)
- `settings/page.tsx` :56 (max-w-2xl)
- `settings/sales-channels/page.tsx` :64, :89 (max-w-2xl)
- `settings/wastage-monitor/page.tsx` :59, :76 (max-w-2xl)
- `staff/[employmentId]/credentials/page.tsx` :83
- `staff/hire/page.tsx` :61 (max-w-2xl)
- `staff/page.tsx` :48 (mt-1,max-w-2xl)
- `statutory-discounts/page.tsx` :61
- `till/page.tsx` :47, :68 (max-w-3xl)
- `trade/orders/[id]/page.tsx` :67 (mt-1)
- `trade/orders/page.tsx` :44 (max-w-3xl)
- `trade/returns/page.tsx` :119 (mt-1)
- `wastage/[id]/page.tsx` :90 (mt-1)
- `wastage/page.tsx` :92 (mt-1)

## Appendix B — census method (for re-derivation)
From `apps/erp/src`, for every `*.tsx` under `app/`: for each line containing `<h1`, scan the next 7 lines; the first
whose trimmed text starts with `<p` (stopping at another `<h1`) forms a pair; read its `className` (string or template
literal). Class A = class contains `text-neutral-600` and does not start `mt-4 ` / `mt-2 `, minus class E files, plus
`admin/stores/page.tsx:37` and `admin/users/page.tsx:28`. Expected on 2026-09-28: 139 pairs; 102 class A in 92 files;
47 capped. The planner's script: `scratchpad/census.py` + `scope.py` (session scratch, not committed).

---

## Reservation (superseded, kept for history)

# T-348: two-column pages use the full content width (DEF-440)

**Status:** RESERVED 2026-09-26 (orchestrator). Spec not written. Queued after T-346; Ian: "must be fixed". **+DEF-474 (2026-09-28, Ian):** page descriptions use the full width, adapt to screen size, clamp at 3 lines with an ellipsis and an expand control — one shared component, every title description.

Root cause and blast radius: `docs/DEFECTS-REGISTER.md` DEF-440. Method: render the width options on the eight pages at 1366/1920 and phone width, Ian picks from screenshots, then one slice fixes all eight.
