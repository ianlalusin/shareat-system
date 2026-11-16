import type { ReactNode } from 'react';

/** All figures remain in server output; a phone shows one or two tiles per row, never a sideways strip (T-589 B4a). */
export function MetricStrip({ label, children, columns = 2 }: { readonly label: string; readonly children: ReactNode; readonly columns?: 2 | 4 }) {
  return <div className="erp-metric-strip" role="region" aria-label={label} data-columns={columns}>{children}</div>;
}
