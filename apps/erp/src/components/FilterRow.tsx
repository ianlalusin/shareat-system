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
import { Button } from '@/components/ui';

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
      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}
