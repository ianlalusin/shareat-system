import Link from 'next/link';

/**
 * T-387 S5. A big outlined count that fills with the brand colour on hover or focus. The number is real text
 * (transparent fill, ink stroke), so it is in the SSR output and readable by assistive tech.
 */
export function OutlineCount({
  href,
  count,
  label,
  hint,
}: {
  href: string;
  count: number;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="outline-count flex min-h-11 min-w-0 flex-col gap-1.5 border-r border-surface-border py-3 pr-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-4 focus-visible:ring-offset-canvas"
    >
      <span className="outline-count-num break-words font-display text-4xl font-extrabold leading-tight">{count}</span>
      <span className="text-[15px] font-semibold">{label} →</span>
      <span className="text-[13px] text-muted">{hint}</span>
    </Link>
  );
}
