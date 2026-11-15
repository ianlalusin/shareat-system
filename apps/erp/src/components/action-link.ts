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

/**
 * T-589 B4b. A link that is NAVIGATION (a "Back to ..." link, a sub-page link) rather than a word inside a sentence:
 * a full 44px tap target (`min-h-11`), same quiet underlined look. Do not use it inside a paragraph - `inline-flex`
 * would break the line; keep the bare underlined `<a>` there.
 */
export const NAV_LINK = 'inline-flex min-h-11 items-center text-sm underline underline-offset-4';

/** T-589 B4b. A filter that is a link (the list reloads with `?what=...`): a 44px chip, filled when it is the one in force. */
export const FILTER_CHIP =
  'inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-medium text-ink hover:bg-canvas';
export const FILTER_CHIP_ON =
  'inline-flex min-h-11 items-center rounded-[12px] border border-ink bg-ink px-4 text-sm font-semibold text-canvas';
