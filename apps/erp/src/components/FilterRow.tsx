/**
 * The shared filter-row wrapper. T-241 (`docs/tasks/241-filter-row-component.md`), the component
 * DEF-199 named as still owed after T-234 slice 2 fixed the overflow it caused without extracting
 * it: 26 pages each copy-pasted their own `<form method="get">` + submit button.
 *
 * FilterRow owns the row's `<form>`, its flex-wrap layout, and the submit button. It does NOT own
 * field markup — every caller's `<label>`/`<select>`/`<input>` is unchanged from what it rendered
 * before migration, because the row is the duplicated part, not the fields.
 */
import type { ReactNode } from 'react';

/**
 * NOT the majority string — the LARGER of the shapes found among the 26 pre-migration rows,
 * chosen deliberately (orchestrator ruling, T-241 §9, 2026-09-08, superseding an earlier
 * majority-string ruling). Collapsing 26 hand-copied rows into one component means every screen
 * gets the same button regardless of which shape is picked, so the choice is which value is
 * better, not which was more common: `px-4 py-2.5 font-medium` was already in-house on
 * `attendance/lane` and both `settings/*` pages, and phone portrait is this app's canvas
 * (`feedback_design_for_apk_tablet_phone`) — nobody's touch target gets smaller. Every one of the
 * 25 migrated pages therefore gets a very slightly taller, heavier button than it had before,
 * `attendance/lane` additionally gains the hover state it never had, and `attendance/terminals`
 * (previously the smallest, `py-1 text-xs`) changes the most.
 */
const SUBMIT_BTN =
  'rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

export interface FilterRowProps {
  /**
   * The field controls — each an already-labelled `<label>` (or a hidden input), unchanged from
   * the page's own pre-migration markup. FilterRow does not know what a field looks like.
   */
  readonly children: ReactNode;
  /** Default "Show" (24 of 26 rows). `staff/hire` is the one caller passing "Search". */
  readonly submitLabel?: string;
  /**
   * Escape hatch for the rows that carried a leading `mt-6` (or similar outer spacing) before
   * migration — FilterRow does not guess a page's vertical rhythm; the page states it, exactly as
   * it did before migration, so moving a row into this component does not move it on the page.
   */
  readonly className?: string;
}

export function FilterRow({ children, submitLabel = 'Show', className }: FilterRowProps) {
  return (
    <form
      method="get"
      className={`flex flex-wrap items-end gap-3 gap-y-2${className ? ` ${className}` : ''}`}
    >
      {children}
      <button type="submit" className={SUBMIT_BTN}>
        {submitLabel}
      </button>
    </form>
  );
}
