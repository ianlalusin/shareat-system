/**
 * SectionTabs - T-544: one screen family under one sidebar entry, as a strip of plain links.
 * No `'use client'`, no hooks (the caller works out `current`; see `activeHref` in shell/sidebar-state.ts).
 * Tokens only. The current tab has a 2px brand underline and ink text; the others are muted and turn ink on hover.
 * Touch screens get a 44px target; a phone scrolls the strip sideways and never wraps it.
 */
import Link from 'next/link';

export interface SectionTabItem {
  readonly href: string;
  readonly label: string;
}

export interface SectionTabsProps {
  readonly items: readonly SectionTabItem[];
  /** The `href` of the current tab, or undefined when none is current. */
  readonly current: string | undefined;
  /** Names the landmark for a screen reader, e.g. "Channel settlements sections". */
  readonly label: string;
}

// Two whole string literals, not a base plus a suffix: the touch-target census only resolves a named constant whose initializer is a literal.
const TAB_CURRENT = 'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 border-brand px-4 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink';
const TAB_OTHER = 'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 border-transparent px-4 text-sm font-semibold text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ink';

export function SectionTabs({ items, current, label }: SectionTabsProps) {
  return (
    <nav aria-label={label} className="flex overflow-x-auto border-b border-surface-border">
      {items.map((item) => {
        const isCurrent = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isCurrent ? 'page' : undefined}
            className={isCurrent ? TAB_CURRENT : TAB_OTHER}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
