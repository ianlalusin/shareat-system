/**
 * T-645: the shared list-page search box. Server-renderable, no hooks.
 *
 * Put `<SearchBox>` INSIDE the page's `FilterRow` (or wrap it in one with submitLabel="Search") so
 * `q` and the dropdowns submit together. A param the page uses that is NOT a field of that form
 * (tab, kind, status…) rides along via `<KeepParams>`. The page filters in memory with
 * `matchesQuery` from `@/lib/search`.
 */
import Link from 'next/link';
import { Input } from '@/components/ui';

export function SearchBox({
  q,
  placeholder,
  label = 'Search',
}: {
  readonly q: string;
  readonly placeholder: string;
  readonly label?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 erp-field-long">
      <span className="text-sm text-neutral-600 dark:text-neutral-400">{label}</span>
      <Input type="search" name="q" defaultValue={q} placeholder={placeholder} aria-label={label} className="w-full" />
    </label>
  );
}

/** Hidden inputs so the page's other query params survive a search. Empty values are dropped. */
export function KeepParams({ params }: { readonly params: Record<string, string | undefined> }) {
  return (
    <>
      {Object.entries(params).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
    </>
  );
}

/** "12 of 340" while a search is active; nothing otherwise. */
export function SearchCount({ q, shown, total }: { readonly q: string; readonly shown: number; readonly total: number }) {
  if (!q.trim()) return null;
  return (
    <p className="text-xs text-neutral-500 dark:text-neutral-400" data-search-count>
      {shown} of {total}
    </p>
  );
}

/** The empty state when a search matches nothing. */
export function NoMatches({ q, clearHref }: { readonly q: string; readonly clearHref: string }) {
  return (
    <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
      Nothing matches “{q}”.{' '}
      <Link href={clearHref} className="inline-flex min-h-6 items-center underline">
        Clear search
      </Link>
    </p>
  );
}
