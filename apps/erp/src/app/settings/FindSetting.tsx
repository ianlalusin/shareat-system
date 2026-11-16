'use client';

/**
 * T-587 S3 - "Find a setting". Ian kept the box (15 Nov 2026) because it also finds a setting by its OLD name.
 *
 * ⚠️ It filters the rows the server already rendered; it owns no row data. Each row carries `data-settings-row` and each panel
 * `data-settings-section` (settings/page.tsx), so every `href` stays a literal in the page for `nav-route-reachability`. Only the
 * row's visible text matches (title, hint, "Also called"): no synonym list, so nothing is findable that a person cannot read.
 * Without JavaScript the box does nothing and every row stays visible.
 */
import { useState } from 'react';
import { Input } from '@/components/ui';

// Hints use a curly apostrophe; people type a straight one.
const plain = (s: string) => s.replace(/’/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/** True when the row's visible text contains the query. A blank query matches everything. */
export function matchesQuery(text: string, query: string): boolean {
  const q = plain(query);
  return q === '' || plain(text).includes(q);
}

/** Hides rows that do not match and panels left with no visible row. Returns how many rows are showing. */
export function applyFilter(root: ParentNode, query: string): number {
  let shown = 0;
  // The "not set up yet" footnote is not a match: while a query is typed it must not sit under the results as if it were one.
  root.querySelectorAll<HTMLElement>('[data-settings-footnote]').forEach((el) => {
    el.hidden = plain(query) !== '';
  });
  root.querySelectorAll<HTMLElement>('[data-settings-section]').forEach((section) => {
    let any = false;
    section.querySelectorAll<HTMLElement>('[data-settings-row]').forEach((row) => {
      const show = matchesQuery(row.textContent ?? '', query);
      row.hidden = !show;
      if (show) {
        any = true;
        shown += 1;
      }
    });
    section.hidden = !any;
  });
  return shown;
}

export function FindSetting() {
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(0);
  const change = (value: string) => {
    setQuery(value);
    setShown(applyFilter(document, value));
  };
  const typed = query.trim();
  return (
    <div className="mb-4">
      <label htmlFor="find-setting" className="mb-1 block text-sm font-medium">
        Find a setting
      </label>
      <Input
        id="find-setting"
        type="search"
        value={query}
        placeholder="Try VAT, stations or hours"
        autoComplete="off"
        className="w-full sm:max-w-sm"
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query) change('');
        }}
      />
      <p aria-live="polite" className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {typed === '' ? '' : shown === 0 ? `No setting matches "${typed}". Try a shorter word.` : `${shown} ${shown === 1 ? 'setting' : 'settings'}`}
      </p>
    </div>
  );
}
