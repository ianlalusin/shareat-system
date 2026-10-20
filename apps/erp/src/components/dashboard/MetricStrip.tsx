import type { ReactNode } from 'react';

/** All figures remain in server output; phones scroll this named region, desktops show a grid. */
export function MetricStrip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div className="erp-metric-strip" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}
