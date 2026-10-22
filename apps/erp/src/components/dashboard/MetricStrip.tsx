import type { ReactNode } from 'react';

/** All figures remain in server output; phones scroll this named region, desktops show a grid. */
export function MetricStrip({ label, children, columns = 2 }: { readonly label: string; readonly children: ReactNode; readonly columns?: 2 | 4 }) {
  return <div className="erp-metric-strip" role="region" aria-label={label} data-columns={columns} tabIndex={0}>{children}</div>;
}
