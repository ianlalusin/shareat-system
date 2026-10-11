/** T-387 S5. Series colours for the store bars and the channel donut: palette tokens only, no hex. */
export const SERIES_COLORS = [
  'var(--brand-ink)',
  'var(--progress)',
  'var(--info)',
  'var(--success)',
  'var(--warning-ink)',
  'var(--closed)',
] as const;

export const seriesColor = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length]!;
