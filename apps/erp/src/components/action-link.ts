/**
 * DEF-239 / T-249. A small underlined action link or submit button with a REAL tap target and NO
 * visible size change: `py-2` (8px each side) sets the true hit box to 32px; `-my-2` (the same
 * Tailwind step, so it cancels exactly by construction rather than by hand-computed arithmetic)
 * pulls the box back to sit exactly where the bare 16px-tall text sat, so no row grows and no
 * sibling shifts — `getBoundingClientRect` still reports the full padded height, because negative
 * margin repositions a box, it does not shrink it.
 *
 * ⚠️ **32px, not 44px — a measured ruling, not the higher bar.** 44px (`min-h-11 -my-3.5`) was this
 * task's original design and is WRONG: measured to make two adjacent `customers/[customerId]`
 * "entry" links overlap by 3.2px, so a tap in the visual gap between two rows opened the WRONG
 * customer's journal entry — worse than the 16px target it replaced. 32px is the largest size that
 * stays safe in that context without growing the row (orchestrator ruling, 2026-09-09). It clears
 * WCAG 2.5.8 AA (24×24) but NOT the 44px Apple/Material/T-241 bar — giving the customers-table rows
 * more room to reach 44px safely is a layout change, its own future task.
 *
 * Drop this on any future small text action instead of typing `text-xs underline
 * underline-offset-2` by hand — that bare combo is how DEF-239 reached 4 instances, and 5 more
 * (DEF-243) found while building this fix.
 */
export const ACTION_LINK =
  'inline-flex items-center py-2 -my-2 text-xs underline underline-offset-2';
