# T-258 — DEF-244: make the whole row the tap target

> **Status: RESERVED by the orchestrator, 2026-09-10. Unassigned. ⭐ IAN'S DECISION, 10 Sep:
> the WHOLE ROW becomes tappable** — not a taller row with a small link inside it.
> Number reserved so no peer takes it. Nothing below is built.

## The constraint this exists to remove

`/customers/[customerId]`'s dense entry rows are **too short to host a real touch target at all**,
and that — not a CSS class — is the actual problem. Measured by lane B on 2026-09-09 with the
project's own Tailwind CLI against the real markup at 390px: two consecutive entry links given a
44px box (`min-h-11 -my-3.5`) **overlap by 3.2px**, and `elementFromPoint()` at the *visual gap*
returns **row 2's link** rather than neutral space.

⛔ **That is worse than the defect it fixes.** A target you miss is a nuisance; one that
confidently opens a different customer's journal entry is a wrong action taken with certainty.
T-249 therefore shipped **32px** (`py-2 -my-2`) as a deliberate, safe compromise — below the 44px
standard, and honest about being a compromise.

## Ian's decision, 2026-09-10

**Make the entire row the tap target.** The standard mobile-list pattern — contacts, mail,
banking. Rows sit flush with no gap, so overlap is not merely avoided but *impossible*: there is no
inter-row space for a tap to fall into, and every tap lands on the row the eye is on.

⭐ It also usually lets rows stay compact, because a 44px target no longer has to fit *inside* a
shorter row — the row **is** the target.

## What the spec must resolve

1. **Rows with more than one action.** Making the row one target means a row cannot also host a
   second, different action. Find every such row on this page and say what happens to it — a
   trailing explicit control outside the row target, a detail screen, or a long-press. ⛔ Do not
   discover this during the build.
2. **The 32px classes T-249 shipped.** They become redundant here. Say whether they are removed on
   this page or left; do not leave two competing target mechanisms on one row.
3. **Whether this generalises.** DEF-244's measurement found the other two dense contexts
   (`admin/stores/[id]`, `settings/expense-categories`) are **safe** at 44px — 28px and 6.4px gaps
   respectively — so this is specific to this table. ⚠️ Resist widening it into a sweep; if the
   pattern is worth generalising that is a separate, deliberate task.
4. **Keyboard and screen-reader behaviour.** A whole-row target is trivially wrong if it is a
   `<div onClick>`. It must remain a real link or button with an accessible name.
5. **Re-measure, do not assume.** The orchestrator runs the browser pass at 390 and 1280 —
   ⚠️ `elementFromPoint` is VIEWPORT-relative and returns null below the fold, so scroll into
   view, then probe. A pass that reports fewer failures at 1280 than at 390 is measuring the
   viewport, not the page.

## Done when

- Every entry row on `/customers/[customerId]` is a single full-width target, flush with its
  neighbours, at least 44px tall.
- A browser pass at 390 and 1280 probes the centre AND the boundary between every consecutive
  pair, and no probe returns a neighbour's target.
- Rows needing a second action are handled as the spec decided, not left ambiguous.
- Keyboard reachable, with an accessible name per row.

See `docs/DEFECTS-REGISTER.md` DEF-244 and `docs/tasks/249-*.md` for the 32px compromise this
supersedes.

---

## Resolved and built, 2026-09-10 (lane D, Sonnet 5; verified by the orchestrator)

**1. Rows with more than one action.** There are exactly **two row shapes**, not the several the
register implied. ⚠️ The orchestrator's brief cited two line numbers as two shapes; lane D
corrected that — they are the same `<tr>`.
- **Charges rows** (`page.tsx:319-348`) — at most ONE action, the entry link, conditional on
  `c.journalEntryId`.
- **Collections rows** (`page.tsx:445-502`) — up to TWO independently gated actions in the SAME
  row: the entry link (gated on `journalEntryId`) and a void submit inside a reason-form (gated on
  `status === 'posted'`). A posted collection with a journal entry carries both at once. **That is
  the real conflict.**

**Resolution: stretched link, with the void form as a `relative z-10` sibling.**
⛔ A `<tr>` accepts only `<td>/<th>`, so wrapping the row in `<a>` is invalid HTML — not merely
inadvisable. The row keeps native table semantics (real column-header-per-cell, worth keeping for
financial data) while the existing anchor gains `after:absolute after:inset-0` and the ancestor
`<tr>` gains `relative`. The void form sits **above** the stretched layer as a real sibling, never
nested inside the anchor — a nested interactive element inside a row-wide link is invalid and
behaves differently across browsers. A reason-required action does not belong behind a long-press
nobody discovers. A div/grid row-list was considered and rejected: it would need ARIA
`role="table/row/cell"` to hold the same screen-reader semantics — a bigger diff for strictly less.

**2. The 32px `ACTION_LINK` classes: removed on this page only.** Their whole job is enlarging a
small inline element's own hit box, which is dead weight once the row is the target. The visible
"entry" text also drops its underline — styling it as a separate link is misleading once it is no
longer a separate hit area. ⛔ `ACTION_LINK` itself and its other three call sites are untouched.

**3. Not generalised.** `admin/stores/[id]` and `settings/expense-categories` were measured safe at
44px (28px and 6.4px gaps) and are not touched.

**4. Keyboard and screen reader.** A real `<a>` via the stretched-link technique, never
`<div onClick>`, with a distinguishing per-row `aria-label` rather than "entry" repeated down the
list.

**5. Measured, then re-measured in the running app.** Lane D compiled real CSS with this repo's own
Tailwind binary against the new markup: Charges rows 44.8px, a Collections row with both actions
70.4px, a plain row 44.4px; gaps ~0px; full-width hit area at four x-positions. The orchestrator
then probed the real page at **390 and 1280** — 3 rows, all ≥44px, all `position:relative`, gaps of
**0**, and no boundary probe resolving to a non-adjacent row (`smoke-t257-t258.mjs`).
⚠️ Two harness traps found while verifying, both the orchestrator's own: probing rows from **both
tables as one list** measured the heading between them as a 428.5px "row gap" and produced a
plausible false failure; and the first customer by sort order has **no entry rows at all**, so an
unpinned pass reported SKIPPED and looked clean while measuring nothing. The script now groups by
`tbody` and pins the one customer holding both row shapes.

**The void button was fixed here (DEF-270), and not for convenience.** Dropping `ACTION_LINK` from
both entry links removes the last `ACTION_LINK` on the page, which would break
`action-link-sweep.test.ts`'s `TARGET_FILES` invariant; the alternative — removing the page from
that list — would have a UI task **quietly weakening a guard**. ⛔ The blind spot that hid it is
**DEF-269** and is deliberately NOT fixed here: the sweep matches `text-xs` with a bare `underline`
inside the same `className`, so any control inheriting its text size from an ancestor is invisible
to it, app-wide. Re-censusing is its own task.
