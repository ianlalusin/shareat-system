# T-240 — The two-column detail page: a record you can read while its position stays on screen

> **Status**: ✅ **APPROVED by the orchestrator and BUILT, 2026-09-08.** typecheck carries no error
> in any file this task touches · unit suite **77 files / 1163 passed, 1 skipped** · the new guard
> proven to fail for the right reason · `tests/unit/page-container.test.ts` green **unmodified** ·
> six diffs self-reviewed line by line. ⚠️ **Outstanding, and neither is runnable by this lane:**
> the twelve screenshots (§5.3) and `npm run build`. Written by lane B
> (`ianla-3a`, Opus 5) against `0e41ae1`. The first of the two tasks T-234 deliberately
> deferred (`docs/tasks/234-responsive-shell-sidebar-nav.md` §3.3 note (c)). **No migration. No
> database. No bible row** — presentation, and bible §1.2c already grants UI/UX its authority.
>
> ⚠️ **Renumbered 239 → 240 by the orchestrator, 2026-09-08.** All three lanes reserved 239 inside
> the same minute — the collision this tree always produces (memory
> `project_shareat_system_concurrent_sessions`). By arrival order: lane D 239 (DEF-229), **this task
> 240**, lane E 241. ✅ Resolved by the time this task was built: `docs/tasks/` now holds
> `239-def-229-credential-revoke-reason.md` (D), this file, and `241-filter-row-component.md` (E) —
> one file per number.
>
> ⛔ **Provenance, stated because it changes how much you should trust the shortlist.** This session
> was cleared between shipping T-234 slice 2 and receiving this task. The "five candidates nominated
> in lane B's READY" existed only in that chat and are gone. **Every page named below was
> re-derived from the source at `0e41ae1`, not recalled** — and the re-derivation found **six**, not
> five, on a stated criterion (§1). That is better evidence than a remembered list, but it means the
> old five and the new six may not be the same set, and if the orchestrator holds a copy of the
> original READY it is worth diffing.

---

## 0. Assessment first (bible §13 row 163 · RULES §4)

| | |
|---|---|
| **Utilisation** | **Six screens, and they are the finance record screens** — a loan, a liability, a prepaid item, an owner's account, a fixed asset, a cash request. Read by admins and owners, who are the people on laptops; this is precisely the audience the laptop half of T-234 exists to serve. Not high-frequency like the nav, which every person hits on every page — this is a *depth* improvement on the screens where someone sits and reads |
| **Effort** | **~half a lane-day.** One new component (~90 lines with its comments), six page edits of ~15 lines each, one unit guard, one browser pass. No migration, no data, no new capability, no dependency |
| **Adopt or build** | **Build.** The whole thing is one CSS grid and one `position: sticky`. There is nothing to adopt |
| **Industry pattern** | The record-with-summary-rail: the record's long content on the left, its position pinned on the right. Linear's issue view, Stripe's payment detail, GitHub's PR sidebar. Boring and standard (RULES §4) |
| **⚠️ Argument against, made once and properly** | Six of 25 detail pages is not "detail pages get a second column" — it is *six pages get one*. If what you pictured was a sweep, this is not that, and §1 says why the other 19 have nothing to put in a second column: they have no summary block. The honest value is (a) the position stays visible while you scroll a 40-row schedule, and (b) a component exists, so the next detail page has a shape to copy instead of inventing one — the same argument `Page.tsx` made, and that one turned out to be worth it |
| **Recommendation** | **Build it, at six pages, with the summary in the aside and the actions left exactly where they are** (§3.4). That resolves T-234's contradiction in favour of §3.4.3, which is the invariant with a reason behind it |

---

## 1. Current state, measured at `0e41ae1`

**25 `page.tsx` files sit under a dynamic segment.** Counted by element, not by file (memory
`reference_shareat_count_elements_not_files`): 26 `<Page>` wrappers across them —
`admin/stores/[id]` has two, an early-return branch for a store that does not exist.

### 1.1 The criterion, and why it is not the one T-234 wrote down

T-234 §3.3(c) asked the lane to nominate *"the detail pages whose **trailing** section is already
self-contained enough that a two-column grid would move nothing."* ⛔ **Measuring found that the
movable block is the LEADING one, not the trailing one, and the criterion is reported here rather
than quietly satisfied** (RULES §3.4a). Six pages open with a **summary strip**: a row of `<Figure>`
tiles, immediately after the header and immediately before the long content, **containing not one
interactive element** — no form field, no button, no link. That block is what a summary rail is
for, and moving it moves nothing by construction.

The genuinely *trailing* self-contained blocks do exist — a `<dl>` of timestamps and journal ids on
five other pages — and §6 says why they are not in this task.

### 1.2 The six, measured

| Page | Tiles | The block today | Wrapped in | Widest left-column content |
|---|---|---|---|---|
| `cash-requests/[id]` | 5 | `:78` `div.grid.gap-3.sm:grid-cols-5` | `<section class="space-y-3">` `:77-95`, grid + one explanatory `<p>` | — |
| `fixed-assets/[id]` | 3 | `:108` `section.grid.gap-4.sm:grid-cols-3` `:108-120` | the section **is** the grid | — |
| `liabilities/[id]` | 3 | `:75` `div.grid.gap-3.sm:grid-cols-3` | `<section class="space-y-3">` `:74-88` | `min-w-[680px]` |
| `loans/[id]` | 4 | `:59` `div.grid.gap-3.sm:grid-cols-4` | **bare, top level**; the explanatory `<p>` follows at `:66-70` | `min-w-[640px]` |
| `owners/[id]` | 4 | `:81` `div.grid.gap-3.sm:grid-cols-4` | `<section class="space-y-3">` `:80-100` | `min-w-[560px]` |
| `prepaid/[id]` | 3 | `:62` `div.grid.gap-3.sm:grid-cols-3` | **bare, top level** | `min-w-[560px]` |

Three of the six (`cash-requests`, `liabilities`, `owners`) already wrap the strip and its
explanatory paragraph in a `<section class="space-y-3">` — that section moves as one unit. Two
(`loans`, `prepaid`) have the same two children at top level with no wrapper; the build adds one.
`fixed-assets` is the odd one: its `<section>` *is* the grid, and it has no explanatory paragraph.

### 1.3 Why the other 19 are not candidates

- **No summary block at all** (`admin/users/[personId]`, `items/[id]`, `staff/[employmentId]`,
  `staff/[employmentId]/credentials`, `customers/price-lists/[id]`, `wastage/[id]`,
  `attendance/[dayId]`, `admin/stores/[id]`, `inventory/production/[id]`, `commissary/orders/[id]`,
  `inventory/counts/[id]`) — a two-column grid here is a grid with an empty column.
- **The "summary" is a two-up facts panel that is not a summary** (`expenses/[id]:127`,
  `ap/invoices/[id]:99`, `sales-days/[id]:110`, and `sales-days/[id]:220`): a
  `section.grid.md:grid-cols-2` holding *Trail* / *Revenue* / *Tender* panels of `<Row>` pairs.
  These are ~340 px of label-value rows **each**, and two of them side by side is already the
  page's own two-column layout. Squeezing one into a 320 px rail is a redesign of the panel, not a
  move. **Nominated for a later pass, not this one.**
- **Already internally two-column** (`fixed-assets/[id]:122` `lg:grid-cols-2`,
  `liabilities/[id]:90` and `owners/[id]:166` `sm:grid-cols-2`, `attendance/[dayId]:112`,
  `admin/stores/[id]:97`) — ⚠️ this is a *constraint on the left column*, not a disqualification;
  §3.2 does the arithmetic. `fixed-assets` and `liabilities` and `owners` are still in, and §3.2
  is why the breakpoint is where it is.
- **Trailing `<dl>` metadata only** — see §6.

### 1.4 The shell geometry this has to live inside

`AppShell.tsx:31-35` is `div.flex.min-h-dvh` › `[Sidebar]` + `div.flex.min-w-0.flex-1.flex-col` ›
`TopBar` + `main.min-w-0.flex-1`. **No ancestor of `<main>` sets `overflow`**, so `position: sticky`
inside a page resolves against the document scrollport — it works, with no change to the shell.
`TopBar` is `md:hidden` (`TopBar.tsx:26`), so at the widths this task turns on there is no top bar
for a sticky rail to slide under. **Slice 1 is not touched and does not need to be.**

---

## 2. Scope — the exact files, and nothing else

**Create**
1. `apps/erp/src/components/shell/DetailLayout.tsx` — the component (§3.1).
2. `tests/unit/detail-layout.test.ts` — the guard (§5.1). *The orchestrator wires it into the suite;
   this lane writes it, the T-234 §3.5 division.*

**Modify — six page files, and only the blocks §1.2 names**
3. `apps/erp/src/app/cash-requests/[id]/page.tsx`
4. `apps/erp/src/app/fixed-assets/[id]/page.tsx`
5. `apps/erp/src/app/liabilities/[id]/page.tsx`
6. `apps/erp/src/app/loans/[id]/page.tsx`
7. `apps/erp/src/app/owners/[id]/page.tsx`
8. `apps/erp/src/app/prepaid/[id]/page.tsx`

**This spec itself** — `docs/tasks/240-two-column-detail-pages.md`.

**⛔ Not touched, named so the boundary is a list and not a judgement**: the other 19 detail pages ·
every non-dynamic route · `components/shell/{Page,AppShell,Sidebar,SidebarNav,TopBar,sidebar-state,
icons}` · `components/nav.tsx` · `app/layout.tsx` · `app/globals.css` · `apps/erp/tailwind.config.ts`
· **`tests/unit/page-container.test.ts`** · `tests/unit/nav-route-reachability.test.ts` ·
`PROJECT_BIBLE.md` · `docs/DEFECTS-REGISTER.md` · `docs/ROADMAP.html` · anything under `packages/`.

**⭐ This task touches no database.** No migration, no repo function, no integration test, no
fixture. `shareat_test_t229` is irrelevant to it — the lane DB refresh the briefing asked for is
still worth doing before the *next* task, but nothing here runs against Postgres.

---

## 3. Contract

### 3.1 The component

```
apps/erp/src/components/shell/DetailLayout.tsx

  <DetailLayout summary={<Section…/>}>
    …the record: sections, forms, tables, exactly as today…
  </DetailLayout>
```

- Renders **`<div>`s, never `<main>` and never `<aside>`.**
  - `<main>`: `AppShell` owns the document's one landmark, and `tests/unit/page-container.test.ts`
    asserts the shell's total is exactly 1. ⚠️ **The file lives under `components/shell/`, which is
    the directory that guard scans** — writing `<main` in its *code* turns that assertion red. Its
    doc comment may say the word freely; the guard strips comments first.
  - `<aside>`: rejected deliberately. `<aside>` announces *complementary* content — tangential to
    the document. The outstanding balance of a loan is not tangential to the loan; it is the most
    important thing on the page. A `<div>` is the honest element, and it also keeps the landmark
    count a question nobody has to re-open.
- `summary` is **required and non-nullable**. A `DetailLayout` with nothing in the rail is a
  narrower page for no gain, and making the prop optional invites exactly that. If a future page
  has a conditional summary it passes a component that renders its own fallback, or does not use
  this layout.
- The component owns the grid, the gap, the placement and the stickiness. **A page never writes
  `grid-cols-[minmax(0,1fr)_20rem]` itself** — §5.1 guards it, the same shape as the `mx-auto +
  max-w-` guard that keeps width in `Page`.
- It goes **inside** `<Page density="table">`, which every one of the six already has. Page density
  is unchanged on all six.

### 3.2 The breakpoint, and the arithmetic that chooses it

The two-column grid turns on at **`min-[1440px]`**, not at `xl` (1280).

Content box with the sidebar expanded (its default at ≥ 1280) = `min(viewport − 320, 1280)` —
sidebar `16rem` + `xl:px-8` both sides, capped by `table` density's `xl:max-w-[80rem]`
(`Page.tsx`). Left column = box − `20rem` rail − `gap-6`, i.e. **box − 344**:

| Viewport | Content box | Left column | Verdict |
|---|---|---|---|
| 1280 | 960 | **616** | ⛔ `liabilities`' `min-w-[680px]` table and `loans`' `min-w-[640px]` table both begin scrolling sideways **where they do not today** |
| 1366 | 1046 | 702 | `liabilities` clears 680 by 22 px. Too close to ship on |
| **1440** | 1120 | **776** | ✅ every one of the six clears its widest content with ≥ 96 px spare |
| 1536 | 1216 | 872 | ✅ |
| ≥ 1600 | 1280 (capped) | 936 | ✅ |

- ⭐ **This is the whole reason the breakpoint is not `xl`.** Turning the rail on at 1280 would
  introduce a horizontal scroll inside a table on two of the six pages *at the exact width the
  feature switches on*. It would not fail T-234 invariant 1 — the table is already inside
  `overflow-x-auto`, so the **page** still measures 0 px of overflow — which is precisely why it
  needs saying: **the DOM measurement would pass and the screen would be worse.** Same lesson as
  the tablet rail.
- 1440 is also the machine Ian named, and the one T-234's `table` cap was tuned for.
- ⚠️ **Consequence, stated rather than discovered later**: a 1280 or 1366 laptop gets *no* second
  column. Those users are no worse off than today — they simply keep today's single column.
- **Tailwind 3.4's arbitrary variant `min-[1440px]:` is used, and `tailwind.config.ts` is NOT
  edited.** A named breakpoint would be tidier and it is a shared config file that T-234 kept
  untouched and that lane E may also want; one arbitrary variant in one component is the smaller
  footprint. It resolves at build time and the file is under `apps/erp/src`, so the `content` glob
  reaches it (memory `reference_tailwind_content_globs_skip_lib`).

### 3.3 Placement, and why DOM order does not change

```
<div class="min-[1440px]:grid min-[1440px]:grid-cols-[minmax(0,1fr)_20rem] min-[1440px]:gap-6 space-y-6 min-[1440px]:space-y-0">
  <div class="min-[1440px]:col-start-2 min-[1440px]:row-start-1 min-[1440px]:sticky min-[1440px]:top-6 min-[1440px]:self-start">
    {summary}
  </div>
  <div class="min-[1440px]:col-start-1 min-[1440px]:row-start-1 min-w-0 space-y-6">
    {children}
  </div>
</div>
```

- ⭐ **The summary is FIRST in the DOM and SECOND on screen**, placed by explicit grid lines rather
  than by source order. Below 1440 the element is simply first, which is **exactly where it is
  today** — so a phone, a tablet and a 1280 laptop see no change at all, and T-234 invariant 2
  holds without an exception being carved for it. Reading order and tab order are byte-for-byte
  what they are now. ⛔ Do not "simplify" this by putting the summary second in the source and
  using `order-first`: that changes what a screen reader reads first on every phone.
- `min-w-0` on the record column: without it a `min-w-[680px]` table forces the `1fr` track wider
  than its share and the rail gets pushed off. This is the DEF-149 shape, two levels in.
- `self-start` on the rail: a grid item stretches by default, and a stretched item cannot stick.
- `top-6` = 24 px, matching the page's own `md:py-6`. No top bar exists at these widths to clear.
- **The vertical rhythm swap is deliberate**: `space-y-6` below 1440 reproduces `Page`'s default
  gap between the summary and the content; at 1440 they are side by side and `space-y-0` stops the
  grid inheriting a margin it has no use for.

### 3.4 ⛔ What does NOT move into the rail — and this is the ruling on T-234's contradiction

T-234 §3.3 said the rail holds *"the summary card **and the actions**"*; §3.4.3 said *"no action,
form field or link moves"*. They cannot both be honoured, which is why the slice was deferred.
**This task rules for §3.4.3: only the summary moves. Every form, button and link stays exactly
where it is, in the left column, in its current order.**

Three reasons, in order of weight:

1. ⭐ **A form moved into the rail silently breaks, and breaks in the way this project has already
   been bitten by once.** Tailwind breakpoints are *viewport* queries, not container queries. At a
   1440 viewport, `loans`' `<form className="grid gap-4 sm:grid-cols-3">` renders **three columns
   inside a 320 px rail — 98 px per field**. Nothing overflows, no element exceeds its box, every
   DOM assertion passes, and the screen is unusable. That is the tablet rail again, and the app has
   no container-query plugin to fix it with.
2. Re-parenting a `<form>` changes tab order on six screens. Nothing in this task is worth that.
3. It is ~25 per-page judgements about which action is primary — the count T-234 already made and
   correctly declined to make inside a mechanical slice.

### 3.5 ⚠️ The one edit that will silently break if it is skipped

The same viewport-vs-container trap applies to the summary itself. The moved strips carry
`sm:grid-cols-3` / `-4` / `-5`, and `sm` is 640 — **active inside the 320 px rail**, giving five
tiles of 58 px on `cash-requests`. Every moved grid therefore gains **`min-[1440px]:grid-cols-1`**,
so it is a horizontal strip below 1440 exactly as today, and a vertical stack in the rail above it.

| Page | Class today | Class after |
|---|---|---|
| `cash-requests/[id]` | `grid gap-3 sm:grid-cols-5` | `grid gap-3 sm:grid-cols-5 min-[1440px]:grid-cols-1` |
| `fixed-assets/[id]` | `grid gap-4 sm:grid-cols-3` | `grid gap-4 sm:grid-cols-3 min-[1440px]:grid-cols-1` |
| `liabilities/[id]` | `grid gap-3 sm:grid-cols-3` | `grid gap-3 sm:grid-cols-3 min-[1440px]:grid-cols-1` |
| `loans/[id]` | `grid gap-3 sm:grid-cols-4` | `grid gap-3 sm:grid-cols-4 min-[1440px]:grid-cols-1` |
| `owners/[id]` | `grid gap-3 sm:grid-cols-4` | `grid gap-3 sm:grid-cols-4 min-[1440px]:grid-cols-1` |
| `prepaid/[id]` | `grid gap-3 sm:grid-cols-3` | `grid gap-3 sm:grid-cols-3 min-[1440px]:grid-cols-1` |

**This is the single highest-risk line in the task**, because it is invisible to typecheck, to the
unit suite, to the build, and to every overflow measurement. §5.3 is why a screenshot is a
done-condition and not a nicety.

> ⭐ **AMENDMENT, made during the build and reported rather than slipped in (RULES §3.4a).** The
> table above is **one row short**, and the missing row is not in a `summary` at all — it is the
> same trap **one level further into the record column**, which this section did not think to look
> for because it only measured the blocks being moved.
>
> `fixed-assets/[id]:122` carries `div.grid.gap-6.lg:grid-cols-2`, and *inside* those sections sit
> `sm:grid-cols-2` field pairs (`:132` and others). The rail takes 344 px off the record column, so
> at 1440 those two columns are 376 px each, their sections 344 px of content, and **the field
> pairs fall to 164 px** — from 250 px today. Nothing overflows; it is legible only in a screenshot.
> It therefore gains the same class for the same reason: `lg:grid-cols-2 min-[1440px]:grid-cols-1`,
> so the block drops back to one column at exactly the width the rail appears and its fields return
> to ~372 px.
>
> ⚠️ **It is the only one of the six with a two-level nested grid** — the arithmetic was redone for
> all six before touching any of them: `owners`' and `liabilities`' two-up sections hold only
> `space-y` forms (380 px each, fine), and `cash-requests`, `prepaid` and `loans` have their grids at
> full record width (237–364 px per field, fine). **Seven class edits in total, not six.**

### 3.6 Per-page shape

- `cash-requests`, `liabilities`, `owners` — the existing `<section class="space-y-3">` (grid +
  explanatory `<p>`) becomes the `summary` prop verbatim, plus the §3.5 class. **The paragraph goes
  with it**: it explains the tiles and is meaningless beside them.
- `loans`, `prepaid` — the bare grid and the `<p>` that follows it are wrapped in
  `<section class="space-y-3">` to match the other three, then moved. The `{/* ── The figures ── */}`
  banner comments travel with their block.
- `fixed-assets` — the `<section class="grid gap-4 sm:grid-cols-3">` at `:108-120` moves as-is. It
  has no trailing paragraph; nothing is invented for it.
- On all six, `<Page density="table">` and everything after the moved block are untouched.

> ⚠️ **AS BUILT — the record columns were NOT re-indented, deliberately.** Wrapping the content in
> `<DetailLayout>` adds a nesting level, so strictly the children are now two spaces shallow. They
> were left alone: re-indenting would have meant retyping ~900 lines of accounting JSX across six
> files to fix whitespace, and a silently dropped line there is a far worse defect than a shallow
> indent. **There is no formatter in this repo to satisfy** — no prettier or eslint config, no
> `format` script — so nothing is left failing. The payoff is that each of the six diffs is three
> hunks that a reviewer can read in full: the import, the wrapper open with its `summary`, the
> wrapper close. If a whitespace pass is wanted it is a separate, reviewable, whitespace-only commit.

---

## 4. Invariants

1. **Below 1440 px, every one of the six pages is byte-identical in rendered order and visually
   unchanged.** The summary stays first, the content follows, spacing is the same. Proven at 390 /
   768 / 1280.
2. `document.documentElement.scrollWidth − clientWidth === 0` on all six routes at 390 / 768 / 1280
   / 1440 / 1536 — the T-234 standard, extended to the two widths this task introduces.
3. **No table gains a horizontal scroll it did not have.** At 1440 the left column is 776 px and the
   widest content is 680; assert the six tables' `scrollWidth <= clientWidth` at 1440 where they
   already were at 1280.
4. **No action, form field or link moves, and no tab order changes.** Tab through each page at 1280
   and at 1440 and get the same sequence.
5. Exactly one `<main>` in the document, in `AppShell`, unchanged.
6. **`tests/unit/page-container.test.ts` stays green, unmodified.** Checked against its five
   assertions: the six pages keep `<Page`; none gains a `<main>`; none gains `mx-auto` + `max-w-`;
   the shell's `<main>` total stays 1 provided `DetailLayout.tsx` writes none in code (§3.1); the
   prose-measure control is untouched. ⛔ **If it goes red, that is a defect in this task, not a
   stale guard — do not edit it.**

---

## 5. Tests

### 5.1 Unit — `tests/unit/detail-layout.test.ts`

1. ⭐ **Non-zero control first**: the six files are found and read, and `DetailLayout.tsx` exists.
   A scan that matches nothing exits 0 and looks like a codebase in perfect order
   (memory `reference_sweep_needs_nonzero_control`, DEF-179).
2. Exactly the six named pages import `DetailLayout`, and each renders `<DetailLayout` — comment-
   stripped and CRLF-normalised, reusing `page-container.test.ts`'s `codeOnly` idiom (JS `.` never
   matches `\r`; a line scan on a CRLF checkout silently matches nothing).
3. `grid-cols-[minmax(0,1fr)_20rem]` appears **only** in `DetailLayout.tsx` — no page hand-rolls
   the layout. Mirrors the `mx-auto + max-w-` guard.
4. Each of the six contains `min-[1440px]:grid-cols-1` at least once (§3.5).
5. `DetailLayout.tsx`'s code contains no `<main` and no `<aside` (§3.1).

> ⚠️ **Assertion 4 is a weak guard and is labelled as one in the test file.** It proves the class is
> present in a file; it cannot prove it is on the *right* element, and it says nothing about a
> seventh page added later. It is cheap and it catches the one omission that has a name. **The real
> proof of §3.5 is §5.3.**

### 5.2 Not a database test

No integration test. Nothing in this task reaches Postgres.

### 5.3 ⭐ Browser — and the screenshots are a done-condition, not evidence-in-passing

Six routes × five widths (390 / 768 / 1280 / 1440 / 1536), each needing a real record — these are
all `[id]` routes, so the sweep resolves an id per route from the running app rather than assuming
one. Per width: overflow 0, tab order captured, table `scrollWidth` recorded.

**Plus a screenshot of all six at 1440 and at 1536**, read by a human, checking the one thing no
measurement catches: **the tiles are stacked in the rail, not squeezed side by side.** ⛔ The tablet
rail passed every DOM measurement in this codebase yesterday and was visibly broken; §3.5 is the
identical failure mode. A build that reports green without those twelve screenshots being *looked
at* has not been tested.

⚠️ **Lane B has no dev/browser permissions.** A peer starts the server on 9008 and hands over the
port, or the orchestrator runs the matrix — the T-234 precedent, and the shape of
`~/.claude/skills/orchestrator/tools/smoke-t234.mjs` is what this extends.

---

## 6. Out of scope — named, so they are follow-ups and not omissions

- **The trailing `<dl>` metadata blocks** on `commissary/orders/[id]:355`,
  `inventory/counts/[id]:243`, `inventory/deliveries/[id]:204`, `inventory/usage/[id]:129`,
  `trade/orders/[id]:230` — a `dl.sm:grid-cols-2` of timestamps and journal ids, read-only and
  genuinely self-contained. **Excluded because each renders only on a terminal status**
  (`received` / `void` / `dispatched`), so on a draft the rail is empty and the record column is
  344 px narrower for nothing. Making them work needs a nullable `summary` and a layout that
  collapses to one column, which §3.1 deliberately refused. Worth its own small task; the shape is
  known and written down here so it need not be re-found.
- **The two-up facts panels** on `expenses/[id]`, `ap/invoices/[id]`, `sales-days/[id]` (§1.3) —
  a rail redesign, not a move.
- Moving any action into the rail (§3.4). Redesigning any screen's content. Charts. Print styles.
  Column choices. `PageHeader` adoption — still zero callers, still deliberate, still not this task.

---

## 7. Done when

typecheck exit 0 · unit incl. the new guard · **`tests/unit/page-container.test.ts` green
unmodified** · the browser matrix at five widths with 0 px overflow on all six routes · **twelve
screenshots taken and looked at** · `npm run build` exit 0 with 9008 free (and
`git checkout -- apps/erp/next-env.d.ts` after it) · self-reviewed line by line · a claimed edit
verified with `git diff`, never with the report (mixed line endings) · READY carries the per-page
before/after and the screenshots · roadmap line and board updated by the orchestrator · `FOR IAN`.

---

## 8. Cross-lane de-confliction — lane E's `<FilterRow>`

**Measured, not assumed** — the briefing asked whether any candidate also carries a filter row:

- **Zero of the 25 `[id]` detail pages contains `method="get"`.** Verified twice: once by grepping
  the attribute, once by listing every `<form>` whose opening tag lacks `action={` — the second pass
  returned seven files, and every hit was a false positive from a multi-line
  `<form\n  action={serverAction}` or a `<form>` mentioned in a comment. There is no GET filter form
  on any detail page in this app.
- **None of the six files in §2 appears in DEF-199's 22-file filter-row surface.**
- **Zero shared files.** This task's only shared-directory file is a *new* one,
  `components/shell/DetailLayout.tsx`; a `<FilterRow>` would live in `components/`, not
  `components/shell/`. The only plausible collision is if lane E adds an allowlist entry to
  `tests/unit/page-container.test.ts` — **this task does not touch that file at all**, so even that
  is one-sided.
- ⚠️ **The one thing to check on lane E's side**: if its migration sweep touches
  `apps/erp/src/app/**/page.tsx` broadly rather than only the 22 files that carry a filter row, it
  will collide with all six of mine. Worth confirming its file list is the 22, not a glob.

---

## FOR IAN

- **What this is.** On six money screens — a loan, a debt, a prepaid item, an owner's account, a
  fixed asset, a cash request — the row of figures at the top (Outstanding, Still out, Net equity)
  moves to a column on the right that **stays on screen while you scroll**. Today you scroll past
  it and lose it behind a long payment history. Your phone and tablet see no change whatsoever.
- **It is six screens, not all of them, and I would rather say that than let it sound bigger.** The
  other nineteen detail pages have no summary block to put in a second column — nothing to move.
  Two more families of pages could get one later; both are written down so nobody re-finds them.
- **Two decisions I took for you, both reversible.** (1) The second column appears at 1440 px wide,
  not 1280 — at 1280 the main column gets narrow enough that two of the tables would start
  scrolling sideways, which is worse than what you have. Your laptop is 1440, so you get it. (2)
  The **buttons and forms do not move** — only the figures. Moving the actions is what stalled this
  task the first time, and a form squeezed into a 320 px column looks fine to every automated check
  and is unusable to a person.
- **Nothing here needs an answer from you before it starts.** It needs the orchestrator's approval
  and a peer to lend me a browser, because this lane cannot start the dev server itself.
