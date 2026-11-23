# T-630 — Breadcrumbs on every ERP page

Status: building on `feat/t630-breadcrumbs` (from origin/main 06c14c7). No migration, no database.

## Why

Ian, 2026-11-23: "some sub pages has this link some has no, its useful in navigation, add to all
pages, step browsing path so its easier to go to previous pages from nested ones" (his example:
"Settings / Sales channels").

## Today

- `PageHeader` in `apps/erp/src/components/shell/Page.tsx` takes an optional `crumb`. Only 8 of 157
  pages pass one.
- The nav route list with labels is `GROUPS` in `apps/erp/src/components/nav.tsx`.

## Rule

1. Breadcrumbs are automatic, built from the URL path. Every page shows the path from its top-level
   section down to the current page. Each step except the last is a link. Example:
   Settings › Sales channels, or Customers › Price lists › <list name>.
2. Step labels come from nav.tsx `GROUPS` (reuse them; no second copy of the labels). For a path
   segment that isn't in nav (for example /new, /edit, or a sub-page), use the page's own title, or
   a small explicit map kept beside nav.tsx.
3. Last step: the current page's title, not a link. For a [id] detail page, use the record's name
   the page already loads (the page's title), never the raw id.
4. A middle path segment with no page of its own (no page.tsx at that URL) is shown as plain text,
   never a dead link.
5. Pages that pass an explicit `crumb` keep it working; remove the duplicates where the automatic
   crumb now says the same thing. No crumb on top-level pages (a single step adds nothing), and none
   on the Dashboard.
6. Phone width (390px): the crumb wraps or shortens the middle steps with an ellipsis; never a
   sideways scroll. Real `<a>`/`<Link>` elements with a 44px-ish tap area per the touch-target
   census, and `nav aria-label="Breadcrumb"` with `aria-current="page"` on the last step.
7. The POS (/pos) and the customer pages are out of scope.

## Tests (each needs a mutant proven red)

- A unit test of the path→steps function: nested path, [id] page, segment without a page,
  top-level page (no crumb).
- A census-style test that every page.tsx under apps/erp/src/app (except the exclusions above)
  renders the breadcrumb, i.e. no page opts out silently.

Then `npm run census:write`; resolve NEEDS APPROVAL in code where possible, list the rest for BOSS.
Keep the existing `text-xs text-neutral-500` crumb style. tsc apps/erp if memory allows (~3 GB),
otherwise CI runs it.

Commit locally; do not push. Report (≤15 lines) to C:\shareat\t630-report.txt.
