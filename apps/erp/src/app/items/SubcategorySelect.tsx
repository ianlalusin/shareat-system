'use client';

/**
 * T-502 section 11. The sub-category select of an item form: shows only the sub-categories of whichever expense category the form's
 * category select currently has (a cashier never sees it; admins do). The server still refuses a mismatch in words; this only saves the trip.
 */
import { useEffect, useRef, useState } from 'react';

export interface SubcategoryOption {
  id: string;
  categoryId: string;
  name: string;
}

export function SubcategorySelect({
  options,
  defaultCategoryId,
  defaultValue,
}: {
  options: SubcategoryOption[];
  defaultCategoryId: string;
  defaultValue: string;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const [categoryId, setCategoryId] = useState(defaultCategoryId);
  useEffect(() => {
    const category = ref.current?.form?.elements.namedItem('expenseCategoryId');
    if (!(category instanceof HTMLSelectElement)) return;
    const onChange = () => setCategoryId(category.value);
    onChange();
    category.addEventListener('change', onChange);
    return () => category.removeEventListener('change', onChange);
  }, []);
  const shown = options.filter((o) => o.categoryId === categoryId);
  return (
    <select ref={ref} name="expenseSubcategoryId" defaultValue={shown.some((o) => o.id === defaultValue) ? defaultValue : ''} key={categoryId} className="mt-1 block w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink">
      <option value="">{shown.length > 0 ? 'Choose a sub-category…' : '(this category has none)'}</option>
      {shown.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  );
}
