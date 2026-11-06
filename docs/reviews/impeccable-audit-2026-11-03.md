# Impeccable audit — ERP v2 screens (2026-11-03)

Scope: `apps/erp` on main 14c74b1. Method: Impeccable `audit` (5 dimensions, 0–4 each). Evidence: source detector
(4 findings), rendered detector on 12 routes × 2 widths (47 hits, `next start` on 9028, empty throwaway DB),
three Sonnet code audits. Screenshots were not kept (6 Nov cleanup).
Limits: empty data (no long lists rendered), dark mode not rendered (users can't turn it on), no screen reader,
no physical-touch test.

## Health score: 13/20 — Acceptable

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 3 | `text-neutral-400` at 2.6:1 in light mode (sidebar group names on every page, ~117 sites) |
| 2 | Performance | 3 | Three always-on DOM observers on all of `<main>`, ungated by viewport |
| 3 | Theming | 2 | Two colour systems: 1,032 token uses vs 3,689 `neutral-*` + 1,721 inert `dark:` classes |
| 4 | Responsive | 3 | 44px touch rule lives only in kit components; raw buttons and the modal Close are 26–32px |
| 5 | Implementation integrity | 2 | Kit built, page adoption partial: PageHeader title 0 callers, Card 1, Table 17 vs 98 raw |

**Integrity verdict: FAIL (narrowly).** The visual identity is coherent and product-specific (warm cream, brand red,
real icon set, tested tokens). But pages bypass the kit in repeated ways, so headers, panels, tables and inputs
drift page to page.

## Findings (P0 0 · P1 4 · P2 9 · P3 6)

**P1**
1. Low-contrast grey text — `text-neutral-400` (#a89f92) 2.38–2.61:1, needs 4.5. `SidebarNav.tsx:161` (every page),
   `p.text-xs.text-neutral-400` on /sales-days and ~117 more. Rendered scan: 18 hits, only this one pair. → `/impeccable polish` + a ban-rule test.
2. Pages hand-roll the header — `shell/Page.tsx:100-125` title/actions prop has 0 callers; ~145 hand-written h1s,
   action placement differs per page (e.g. Customers "+" sits below the note). → `/impeccable layout`
3. Panels hand-rolled — `Card` 1 caller vs ~323 bordered rounded panels; radius sprawl (~8 values vs the T-448 scale). → `/impeccable polish`
4. Form-control drift — 15 per-file INPUT/BUTTON class constants (e.g. `loans/page.tsx:233`, `ap/invoices/[id]/page.tsx:641`)
   miss the T-448 32/44px rule; 30 raw `<select>`, 18 raw checkboxes; black-fill "selected pill" buttons duplicated in 5 files. → `/impeccable harden`

**P2**
5. Dashboard chart label covers the first date (`text-occlusion`, "Nov 1" under the "₱0.00 no sales yet" pill) — `components/dashboard/SalesLine*`. → `/impeccable layout`
6. Icon-button names invisible on touch — `TooltipLayer.tsx:53,56` shows then hides on the same tap. → `/impeccable adapt`
7. Modal Close 32px on touch — `Dialog.tsx:72-75` (`data-erp-size="free"`); also SignaturePad buttons, PhotoUpload, Lightbox Close (26–32px). Census floor is 24px so guards miss them. → `/impeccable adapt`
8. No skip link — ~40 sidebar links before `<main>` every page (WCAG 2.4.1), `AppShell.tsx:61-69`. → `/impeccable harden`
9. Tables have no names — 113 tables, 0 caption/aria-label; 513 of 526 raw `<th>` lack `scope`. → `/impeccable harden`
10. Scroll-memory observer never disconnects, rescans every mutation, forces layout on scroll — `shell/screen-state.ts:79-102`. → `/impeccable optimize`
11. Phone-card enhancer runs on desktop too, before paint — `PhoneTableCards.tsx:11`, `phone-table-cards.ts:204-237`. → `/impeccable optimize`
12. Phone card titles can't wrap (nowrap + ellipsis, ~140px at 390) — `globals.css:618-628`. → `/impeccable adapt`
13. Dark mode half-built — tokens ready, but 1,721 `dark:neutral-*` classes are unreachable (no toggle) and 62 of them fail contrast. Decide: ship the toggle or stop adding `dark:`. → `/impeccable colorize`

**P3**
14. Bounce easing on toast/stamp (`globals.css:242-243`) — real but guarded by reduced-motion; decorative.
15. Developer notes in user copy — `expenses/page.tsx:51-52` "(docs/tasks/122-expenses.md)", ★/⛔ markers, DEF refs. → `/impeccable clarify`
16. Off-scale text sizes (`text-[11px]` ×24, `[13px]` ×12…). → `/impeccable typeset`
17. Sidebar drawer doesn't return focus to ☰; drawer slide + spinner ignore reduced motion. → `/impeccable harden`
18. Thumbnails load full photos (up to 2000px) — `PhotoThumb.tsx:47-53`. → `/impeccable optimize`
19. Typography stragglers / em-dash density in long page descriptions (/attendance, /settings/expense-categories). → `/impeccable clarify`

False positives / ruled out: `cream-palette` on every route (Ian's warm-cream identity — the brief wins);
`SalesHover.tsx:61` side-tab (full outline, stronger left edge); `MoneyLines.tsx:451` side-stripe is on tokens (P3 at most).

## Systemic patterns
1. Kit built, page adoption unenforced — guards cover Button/links/destructive, nothing covers PageHeader, Card, Table, Input.
2. Two colour systems — tokens vs remapped `neutral-*`; contrast fixed for the common pair only (500 light / 400 dark).
3. Touch guarantees live in component classes; raw elements and `free` opt-outs fall to 24–32px; hover-first affordances lack a touch path.

## Working well
- Tokens pass AA everywhere for semantic pairs, verified by test; badges never colour-only.
- Native `<dialog>`, full error wiring (aria-invalid, describedby, live summary, native required).
- Reduced-motion discipline; no `will-change`; server-first (59 of 262 tsx are client); gesture surfaces handle touch.

## Recommended order
1. [P1] `/impeccable polish` — grey-text sweep + a test banning bare `text-neutral-300/400` and `dark:text-neutral-600+`.
2. [P1] `/impeccable layout` — every page onto `<Page title description actions>`; actions top-right; fix the chart label.
3. [P1] `/impeccable harden` — swap per-file input/select/checkbox constants to the kit; add census guards for Card/Table/Input; skip link; table names.
4. [P2] `/impeccable adapt` — 44px coarse for Close/raw buttons, touch path for icon names, phone card titles.
5. [P2] `/impeccable optimize` — gate the three observers; thumbnail variant.
6. [P2] `/impeccable colorize` — after Ian decides dark mode.
7. `/impeccable polish` — final pass, then re-run `/impeccable audit`.
