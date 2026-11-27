/**
 * T-645: the one text matcher for list-page search boxes.
 *
 * Every whitespace-separated word of `q` must appear (case-insensitive) in at least one of the
 * fields, so "pork belly" finds "Belly, Pork". An empty or blank `q` matches everything.
 *
 * shortcut: pages filter in memory after the existing load; move `q` into the repo query when a
 * list passes ~2,000 rows.
 */
export function matchesQuery(q: string, ...fields: (string | null | undefined)[]): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.map((f) => (f ?? '').toLowerCase());
  return words.every((w) => hay.some((f) => f.includes(w)));
}

/** `?q=a&q=b` arrives as an array: take the first value, trimmed. Every search page reads q through this. */
export function readQ(v: string | string[] | undefined): string {
  const first = Array.isArray(v) ? v[0] : v;
  return (first ?? '').trim();
}

/** The page's own URL without `q` (every other non-empty param kept), for the "Clear search" link. */
export function clearSearchHref(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (k !== 'q' && v) qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}
