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
