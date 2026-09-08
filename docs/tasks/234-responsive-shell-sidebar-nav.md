# T-234 — A responsive shell: sidebar navigation, and a layout that uses a laptop screen

> **Status**: 📝 **SPEC — written by the orchestrator (Fable) at Ian's request, 2026-09-08, for the
> NEXT orchestrator's team to build.** Two slices, two lanes, disjoint files (§ "Sequencing"). A lane
> reads this before building and reports every defect it finds as `QUESTION` (RULES §3.4a); the
> orchestrator approves lane amendments in the header. No migration. No bible row — this is
> presentation, and bible §1.2c already says UI/UX is a third authority with **POS as the
> presentation-quality benchmark.**
>
> **Ian's WHAT, verbatim in spirit (2026-09-08):** *"Design the nav links on the sidebar nicely —
> responsive in screen size. And optimise the wide screen: the majority of users are on tablet and
> phone, but admins and super-admins are on laptops, so a truly responsive screen."*

---

## 0. Assessment first (bible §13 row 163)

| | |
|---|---|
| **Utilisation** | Every signed-in person, every page, every day. The navigation is the first thing on every screen; today it is a wall of **58 links in 6 groups** rendered inline across the top (`apps/erp/src/components/nav.tsx:158-194`) — roughly ten rows of text above every page on a phone, and on a laptop a 6xl-wide ribbon over content that then narrows to `max-w-2xl`/`5xl` and leaves a third of the screen empty |
| **Effort** | Slice 1 (shell) ~1.5 lane-days; slice 2 (layout) ~1 lane-day plus lane C's sweep. No migration, no data, no new capability |
| **Adopt or build** | **Build, ~250 lines, no new dependency.** POS's `src/components/ui/sidebar.tsx` (shadcn/ui, 764 lines) is the benchmark for *behaviour and look*, but porting it means Radix `Sheet`, `class-variance-authority`, `lucide-react` and shadcn's `cn`/`Button`/`Skeleton` base — four dependencies for one component into an app that has none of them (`apps/erp/package.json`: `next`, `react` only). Rejected. The three-state sidebar is ~200 lines hand-rolled with Tailwind, which this app already uses everywhere |
| **Industry pattern** | The **three-state sidebar** (shadcn/ui Sidebar; Material's navigation drawer → rail → modal drawer): phone = off-canvas drawer from a top bar; tablet = icon rail that expands on demand; laptop = expanded sidebar with grouped links; the open/collapsed choice persisted in a **cookie** so the server renders the right width with no flash (POS: `sidebar_state`, 7 days). Content: a per-page **density** container, and two-column detail pages on wide screens (memory `feedback_details_page_layout`: `mx-auto` + 2-column). Boring and standard (RULES §4) |
| **Recommendation** | Build both slices; slice 1 first |

## 1. Current state, measured (2026-09-08, `4093bb1`)

- `apps/erp/src/components/nav.tsx` — a **server** component: reads `currentSession()`, returns
  `null` without one, else renders `GROUPS` (6 × 58 links, data at `:3-156`) as `flex-wrap` rows in
  a `border-b` top bar; the DEF-149 fix (`flex-wrap` on each group) is what keeps 390 px from
  scrolling sideways. **No icons, no active state, no collapse, no gating** (every signed-in person
  sees every link — the control is the server gate on each route, DEF-051; unchanged by this task).
- `apps/erp/src/app/layout.tsx:16` mounts `<Nav />` then `{children}`. `/sign-in`, `/setup` and
  the kiosk `/clock` render with no session, so the nav is already absent there.
- Page widths are ad hoc — six different widths chosen per page, none of them a rule. ⚠️ **Corrected
  2026-09-08 by lane B before building**: the first figures here (`5xl` ×71, `2xl` ×43, `4xl` ×37,
  `3xl` ×24, `6xl` ×6, `md` ×5) counted *occurrences anywhere*, inner elements included. **Per page,
  at the top-level wrapper, across all 101 pages: `5xl` 48 · `4xl` 32 · `3xl` 13 · `md` 3 · `6xl` 3
  · `2xl` 2.** It matters for expectations: "today's `2xl`/`3xl` → form" sounds like 67 pages and is
  15. (Six files contain `max-w-6xl`, only three at top level — the payroll trio use `5xl` outside
  and `6xl` on an inner table; the first `max-w` is the right read of the wrapper.)
- Padding is not uniform either: of the 101 top-level `<main>`s, **66 are `p-4 sm:p-8`, 33 are bare
  `p-8`, one is `p-6`** — so a `px-4` phone rule is a real visual change on 34 pages (see §3.4.2).
- Tailwind: default screens (`sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536), `dark:`
  classes in use, `tailwind.config.ts` has no theme extension. **`content` is `./src/**`** — a
  class used in `packages/*` gets no CSS (memory `reference_tailwind_content_globs_skip_lib`); keep
  every shell class inside `apps/erp/src`.
- DEF-199: twelve phone-width overflows trace to ONE shared, unwrapped filter row — slice 2 closes it.
- Guard: `tests/unit/nav-route-reachability.test.ts` proves every non-dynamic route is reachable from
  the nav (it reads the link data). The link DATA stays where the guard reads it, or the guard's
  source moves in the same commit — the orchestrator owns the guard.

## 2. Slice 1 — the navigation shell

### 2.1 Goal

One `AppShell` that renders the right navigation for the width: a **drawer** on a phone, a
**rail that expands** on a tablet, an **expanded sidebar** on a laptop — the same 58 links in the
same 6 groups, each with an icon, the current page marked, the current group open, the collapse
choice remembered, and never a layout shift on load.

### 2.2 Scope — the exact files

**Create** `apps/erp/src/components/shell/AppShell.tsx` (server: reads the session and the sidebar
cookie, renders `TopBar` + `Sidebar` + `<main>`; returns bare `{children}` when there is no session),
`Sidebar.tsx` (client island: open/collapsed state, the drawer on phone, the toggle, the cookie
write), `SidebarNav.tsx` (the grouped links; server-renderable; takes `groups`, `pathname` for the
active state via `usePathname` in a tiny client leaf), `TopBar.tsx` (phone/tablet: wordmark, ☰,
page title slot, signed-in affordance), `sidebar-state.ts` (the cookie name, TTL, parse/serialise —
**no secret, not httpOnly**: the client toggles it), `icons.tsx` (inline SVG components: one per
group + menu/close/chevron/collapse; **no icon dependency**). ⚠️ **"Heroicons outline, MIT, pasted"
is struck** (lane E, 2026-09-08, ruled by the orchestrator): nobody in the build session can verify
the real path data, and reconstructing bezier curves from memory then labelling them "MIT, pasted"
is a licence attribution that would be right only by accident. The icons are **hand-drawn for this
project** in the same visual idiom (24 × 24, `strokeWidth` 1.5, `currentColor`, rounded caps), and
`icons.tsx`'s header says exactly that. The lane was right to refuse the claim rather than make it.
**Modify** `apps/erp/src/components/nav.tsx` (becomes the DATA module: `GROUPS` gains an `icon`
key per group; the old top-bar render is deleted; keep the export the guard reads),
`apps/erp/src/app/layout.tsx` (mount `AppShell`), `apps/erp/src/app/globals.css` only if a CSS
variable for the sidebar width is cleaner than a Tailwind arbitrary value.
**Tests:** `apps/erp/tests/shell-active-href.test.ts` (unit) and the browser matrix in §2.6.
**Not touched:** any route's `page.tsx` (slice 2), the kiosk's chrome, `tests/unit/*` guards
(orchestrator), the bible, the roadmap.

### 2.3 Contract — three widths, one component

| Width | State | Behaviour |
|---|---|---|
| **< 768 (phone)** | no sidebar | A 56 px top bar: wordmark, ☰ (44 px target), current page title, signed-in affordance. ☰ opens an **off-canvas drawer** `min(18rem, 85vw)` from the left with a scrim; closes on link tap, scrim tap, Escape; body scroll locked while open; focus moves into the drawer and returns to ☰ on close |
| **768–1279 (tablet)** | rail, expandable | A sticky **rail** `4rem` wide showing the six group icons (44 px targets). The rail's top button expands it to `16rem` (the full grouped list); tapping a group icon on the rail expands it with that group open. Default on first visit: **collapsed** |
| **≥ 1280 (laptop)** | sidebar, collapsible | The **expanded** `16rem` sidebar by default; the same button collapses it to the rail. Content gets the remaining width |

- **Persistence:** cookie `shareat_sidebar` = `expanded` \| `collapsed`, `path=/`, `sameSite=lax`,
  `max-age` 7 days, NOT httpOnly. `AppShell` reads it server-side and renders the matching width, so
  the first paint is right — **no flash, no layout shift** (the client island hydrates into the same
  markup). Phone ignores it.
- **Groups:** six collapsible sections with the existing 11 px uppercase headings. At ≥ 768 the
  section containing the current route is open and the others closed; a heading toggles its section;
  the open/closed set is component state only (not persisted — the current group rule is enough).
- **Active link:** `aria-current="page"` on the link whose `href` is the longest prefix of the
  pathname (`/` matches only exactly; `/attendance` does not claim `/attendance/terminals` when the
  longer one exists). A filled pill background, not only colour — visible in both themes.
- **Touch first, no hover-only affordances** (memory `feedback_design_for_apk_tablet_phone`): link
  rows are 44 px tall under `@media (pointer: coarse)` and 36 px with a fine pointer; every control is
  reachable by keyboard with a visible focus ring; `<nav aria-label="Main">`; the drawer is a
  `role="dialog" aria-modal="true"`.
- **Geometry:** at ≥ 768 the sidebar is `position: sticky; top: 0; height: 100dvh; overflow-y: auto`
  and the content scrolls on its own; `<main>` gets `min-width: 0` so a wide table inside it cannot
  push the shell (the DEF-149 shape, one level up).
- **Visual family:** POS's sidebar is the benchmark — read
  `C:\Users\ianla\webapps\POS\src\components\ui\sidebar.tsx` (READ-ONLY) for spacing, the active
  pill, the collapsed-rail tooltip idea (skip tooltips: hover-only), the wordmark row, the footer
  row. Neutral palette as today, **one** accent for the active state; dark mode through the existing
  `dark:` classes; no new colour tokens.
- **The kiosk and the pre-session screens keep no shell**: `AppShell` returns bare children whenever
  `Nav` would have returned `null` today. ⛔ **"and `/clock` is additionally excluded by path" is a
  SPEC DEFECT and is struck** (found 2026-09-08 by lane E before building; ruled by the orchestrator):
  `AppShell` is a server component, and Next 16 does not support reading the current URL from one
  (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-pathname.md` — design, not
  oversight). The session check alone does not cover the case it was written for, because `/clock`
  authenticates through Firebase separately from the `__session` cookie, so a manager with an ERP
  session in the same browser gets the shell on the kiosk. **This slice ships the session-only rule**
  — exactly `Nav`'s behaviour today, so nothing regresses — and the gap is filed as **DEF-233** with
  its two supported fixes (a `middleware.ts` header read through `headers()`, or route groups),
  neither of which belongs inside a UI slice. `AppShell`'s comment names DEF-233.
- **The single `<main>` lives in `AppShell`**, and slice 2's `<Page>` renders a plain `<div>` inside
  it (added 2026-09-08 from lane B's cross-slice catch). Today all 101 pages are a `<main>` and
  slice 2 replaces that wrapper: if both slices render one the app ships two per document, if
  neither does it ships none. Both lanes hold this instruction.

### 2.4 Invariants

1. Every one of the 58 hrefs is still reachable from the nav — the guard proves it, unmodified.
2. `document.documentElement.scrollWidth − clientWidth === 0` at 390 px on every route (lane C's
   sweep). The drawer, when open, does not widen the document.
3. No session → no shell, exactly as `Nav` behaves today; `/sign-in`, `/setup`, `/clock` unchanged.
4. First paint matches the cookie: measured by asserting the sidebar's rendered width in the SSR HTML
   (fetch the page with the cookie set, no JS) equals the width after hydration.
5. No behaviour change on any page: the shell wraps, it does not touch page content.

### 2.5 Tests

- **Unit** `apps/erp/tests/shell-active-href.test.ts`: `activeHref(pathname, hrefs)` — six cases:
  exact `/`, prefix, longest-prefix wins, trailing slash, unknown path → none, query string ignored.
  Static-import (the 5 s trap).
- **Guard** `tests/unit/nav-route-reachability.test.ts` stays green **unmodified** (or, if the data
  export moves, the orchestrator moves the guard's source in the same commit).
- **Browser matrix** (lane C if its terminal has dev permissions; otherwise the orchestrator, with
  `~/.claude/skills/orchestrator/tools/smoke-dev.mjs` on a lane DB and the npx-cache Playwright): six
  routes (`/`, `/sales-days`, `/expenses`, `/admin/users`, `/inventory/deliveries`, `/reports/...`) ×
  three widths (390, 768, 1280): shell present/absent as §2.3; 0 px overflow; drawer opens, traps
  focus, closes on Escape and returns focus; collapse persists across a reload (cookie); the right
  link carries `aria-current`; screenshots at the three widths beside the report.

### 2.6 Out of scope

Capability-gated link visibility (today every signed-in person sees every link; a separate task);
a command palette or search; breadcrumbs; per-user pinned links; the kiosk's chrome; tooltips.

### 2.7 Done when

typecheck · unit · the guard · the browser matrix with screenshots · `npm run build` with 9008 free
· self-reviewed · `docs/ROADMAP.html` line moved by the orchestrator · FOR IAN block in READY.

---

## 3. Slice 2 — a layout that uses the screen it is on

### 3.1 Goal

Replace six ad-hoc page widths with **one density rule**, give detail pages a second column on a
laptop, and close DEF-199's unwrapped filter row — so a laptop admin sees more and a phone user sees
exactly what they see today.

### 3.2 Scope — the exact files

**Create** `apps/erp/src/components/shell/Page.tsx`: `<Page density="form" | "narrow" | "table" |
"wide" title=… actions={…}>` — the one container every route uses; and `PageHeader` inside it
(title left, actions right, wraps on a phone). **Modify** every `apps/erp/src/app/**/page.tsx`
top-level wrapper — a sweep replacing `mx-auto max-w-*` (and its padding) with `<Page density>`;
**DEF-199's filter rows** (below); **Tests:** a unit guard (§3.5).
**Not touched:** the shell files of slice 1, any page's content or behaviour, `nav.tsx`.

> ⭐ **Three amendments made 2026-09-08 by the orchestrator, on lane B's pre-build report. Build
> against these, not the text they replace.**
>
> **(a) `Page` renders a plain `<div>`; slice 1's `AppShell` owns the single `<main>`.** All 101
> pages are a `<main>` today and this sweep replaces that wrapper, so if both slices render `<main>`
> the app ships two per document (invalid landmark structure) and if neither does, none. The spec
> never said which element `Page` was; it says so now. Both lanes hold the same instruction.
>
> **(b) The "shared filter-row component DEF-199 names" DOES NOT EXIST**, and neither does DEF-199
> say it does — it names the *pattern*. The real surface is **22 `page.tsx` files** each carrying an
> inline `<form method="get" className="flex items-end gap-3">`; none of the 12 overflowing routes
> imports anything from `components/`. Scope is therefore widened by exactly this much: **the sweep
> adds `flex-wrap` and `gap-y-2` to those 22 inline rows**, listed in the lane's READY, and the "no
> content change" rule reads *"top-level wrappers, plus DEF-199's inline filter rows"*. ⛔ Extracting
> a real `<FilterRow>` component and migrating 22 pages to it is the right end state and is NOT this
> slice — a component migration riding inside a mechanical sweep is how a sweep becomes a regression
> hunt. DEF-199 carries a line saying the component is still owed.
>
> **(c) The two-column detail page is DEFERRED out of this slice**, because §3.3 and §3.4.3
> contradict each other and the lane was right to stop: *"a sticky aside holding the summary card
> and the actions"* moves actions, and *"no action, form field or link moves"* forbids it. There is
> also nothing to move mechanically — `expenses/[id]` and `cash-requests/[id]` are flat runs of
> state-conditional `<section>`s with no marked summary card, so doing it properly is ~25 per-page
> judgements. **What this slice does instead**: the lane NOMINATES, page by page, the detail pages
> whose trailing section is already self-contained enough that a two-column grid would move nothing,
> one clause each on what belongs in the aside — evidence for the follow-up task rather than 25
> pages re-read from scratch. It applies the grid to none of them.

### 3.3 Contract — the density rule

> ⭐ **Amended 2026-09-08 (orchestrator, on lane B's report): map by PAGE KIND, not by today's
> width.** §3.2 originally said the sweep maps from the width a page has now; that inverts this
> table's own intent, because today's widths do not track page kind at all — every report is
> `3xl`/`4xl`/`5xl` and the dashboard is `5xl`, so a width-based rule puts **all ten reports and the
> dashboard into `table`**, precisely what this table says they must not be; while the only three
> top-level `6xl` pages are ordinary lists (`ap/suppliers`, `fixed-assets`, `statutory-discounts`),
> which a width-based rule would make the app's only `wide` pages. **Today's width is evidence, not
> the rule.** The lane sends a route → density table for approval BEFORE sweeping, flagging every
> page whose kind is arguable rather than deciding it silently.
>
> ⭐ **`table`'s larger cap moved from `2xl` (1536) to `xl` (1280)** — amended 2026-09-08 after lane B
> worked the geometry against slice 1's sidebar. With the sidebar at 16 rem and `px-8`, content =
> viewport − 320. On a 1440-logical laptop — the machine Ian named — that is 1120 px available, but
> `table` below the old breakpoint capped at 64 rem = 1024 and **bound**, wasting 96 px, while `wide`
> did not. Moving the cap to `xl` makes it 1280 there, so the content box fills the screen. This is
> the change that delivers the laptop half of Ian's request, and it lands on **75 of 101 pages**
> rather than on the 12 `wide` ones. ⚠️ Consequence worth stating: `wide` and `table` now render
> identically below a **1600 px** viewport, so `wide`'s honest scope is external monitors. It is kept
> for them, and its comment says so, rather than being discovered later to do nothing on a laptop.
>
> ⚠️ **`narrow` ships with zero callers** — the only `max-w-md` pages are `sign-in`, `setup` and
> `clock`, all allowlisted and none swept. It is KEPT, with its zero callers stated in the
> component's own comment: this project has been bitten by exports nobody calls, and a documented
> intent with a written reason is a different thing from a silent orphan.

| Density | Max width | Use |
|---|---|---|
| `narrow` | `28rem` | sign-in, setup, single-purpose confirmations (today's `max-w-md`) |
| `form` | `48rem` | create/edit forms, settings pages (today's `2xl`/`3xl`) |
| `table` | `64rem`, **`80rem` at ≥ 1280** | lists and tables — the default (today's `4xl`/`5xl`) |
| `wide` | `96rem` | dashboards, reports, reconciliation screens (today's `6xl`) |

- **Detail pages** (`/…/[id]`): density `table`, and at ≥ 1280 a two-column grid
  `grid-cols-[minmax(0,1fr)_20rem]` — the record on the left, a sticky aside on the right holding the
  summary card and the actions (memory `feedback_details_page_layout`). Below 1280 the aside stacks
  under the record, unchanged from today.
- **Padding:** `px-4` on phone, `px-6` at ≥ 768, `px-8` at ≥ 1280; vertical rhythm `py-4`/`py-6`.
- **Tables:** the table's own wrapper is the only `overflow-x: auto`; ids and amounts `whitespace-
  nowrap`; the page body never scrolls sideways. Column count is not changed by this task.
- **`PageHeader`:** `h1` + optional description left, actions right, `flex-wrap` so a phone stacks
  them; one component so every page gets the same rhythm.
- **Mapping is mechanical and recorded**: the sweep produces a table (route → density) in the READY
  report; anything that does not fit the four densities is a `QUESTION`, not a fifth density.

### 3.4 Invariants

1. Nothing scrolls sideways at 390 px on any route — the sweep asserts `scrollWidth − clientWidth
   === 0` on **every** non-dynamic route (the T-227 route list) at 390 / 768 / 1280.
2. Below 768 no page changes visually except DEF-199's filter row wrapping **and the padding
   normalisation** (amended 2026-09-08 by the orchestrator on lane B's report: 34 pages carry bare
   `p-8`, and 32 px on a 390 px screen spends 16% of the width; the change is an improvement and it
   helps DEF-199 rather than fighting it, but it is a real visual change on a third of the app, so
   it is named here instead of riding in under an invariant that forbade it. The 34 are listed in
   the lane's READY).
3. No behaviour change: no action, form field or link moves; only containers and padding.

### 3.5 Tests

- **Unit guard** `tests/unit/page-container.test.ts` (orchestrator wires it; the lane writes it):
  every `apps/erp/src/app/**/page.tsx` contains `<Page ` except an allowlist of pre-session and
  kiosk pages (`sign-in`, `setup`, `clock`, `api/*`), with the same *"a real file, a real reason"*
  discipline as `nav-route-reachability`'s registry. Enumerate with `git ls-files --cached --others
  --exclude-standard` (untracked routes count — today's lesson).
- **Browser sweep**: the full route list × three widths, 0 px overflow each, plus screenshots of two
  detail pages at 1280 showing the aside.

### 3.6 Out of scope

Redesigning any screen's content; charts; print styles; column choices in tables; the filter row's
behaviour (only its wrapping).

### 3.7 Done when

typecheck · unit incl. the new guard · the sweep at three widths with 0 px everywhere · build ·
self-review · the route → density table in READY · roadmap line · FOR IAN block.

---

## 4. Sequencing and lanes

- **Slice 1 first**: it changes `layout.tsx` and the top-of-page geometry; slice 2's `Page.tsx` and
  the per-page sweep can be built in parallel (new file + wrappers, disjoint from the shell files),
  but its browser proof runs after slice 1 lands.
- **Two lanes, disjoint files**: slice 1 = `components/shell/{AppShell,Sidebar,SidebarNav,TopBar,
  sidebar-state,icons}` + `nav.tsx` + `layout.tsx`; slice 2 = `components/shell/Page.tsx` +
  `app/**/page.tsx` wrappers + the filter-row component. The orchestrator owns both guard tests and
  the roadmap. **Model**: both slices execute this spec → Sonnet lanes (row 184); the design
  judgement is in this document, and POS is the benchmark for anything it leaves open. An Opus
  second read of each READY, as today.
- **Recommended assignment** (the next orchestrator's call): slice 1 → lane E (`ianla-60`, Sonnet)
  after DEF-226, or a fresh lane; slice 2 → lane B (`ianla-3a`) after DEF-222 — it built `/setup`'s
  page and knows the form pattern. Lane C proves both in the browser if Ian grants its terminal
  dev/build permissions; otherwise the orchestrator does.

## FOR IAN

- **You asked for a nicely designed, responsive sidebar and a layout that uses a laptop screen.**
  This spec builds the standard three-state sidebar (drawer on a phone, rail on a tablet, full
  sidebar on a laptop, your collapse choice remembered) with the same links and groups you have
  today, plus one width rule for every page and a second column on detail pages when the screen is
  wide. Phones and tablets keep what they have; laptops stop wasting a third of the screen.
- **Decisions I took for you, each reversible:** no new library (POS's sidebar is the *look* we copy,
  not code we import); the collapse choice lives in a cookie so the page never jumps on load; four
  page widths instead of six ad-hoc ones; link visibility is NOT gated by role in this task (every
  signed-in person still sees every link; the server gate on each page is the control) — say the
  word and that becomes a third slice.
- **Nothing here needs a decision before the build starts.** It is queued for the next orchestrator's
  team behind DEF-226 and DEF-222.
