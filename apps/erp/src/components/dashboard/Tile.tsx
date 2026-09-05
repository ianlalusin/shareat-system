import Link from 'next/link';

/**
 * T-211. One KPI tile — a figure, its basis, and where to see the full report. Never a counter:
 * every figure a caller passes here already came from a live query this render, same as the
 * report page it links to.
 */
export function Tile({
  label,
  value,
  basis,
  href,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  basis: string;
  href?: string;
  tone?: 'neutral' | 'ok' | 'warn';
}) {
  const valueColor =
    tone === 'ok'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-700 dark:text-amber-400'
        : 'text-neutral-900 dark:text-neutral-100';

  const className =
    'flex h-full flex-col justify-between gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800' +
    (href ? ' transition hover:border-neutral-400 dark:hover:border-neutral-600' : '');

  const content = (
    <>
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {label}
        </div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${valueColor}`}>{value}</div>
      </div>
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{basis}</div>
    </>
  );

  if (!href) return <div className={className}>{content}</div>;
  return (
    <Link href={href} className={className}>
      {content}
    </Link>
  );
}
