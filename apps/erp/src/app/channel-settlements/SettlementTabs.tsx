'use client';

import { usePathname } from 'next/navigation';
import { SectionTabs, type SectionTabItem } from '@/components/ui';
import { activeHref } from '@/components/shell/sidebar-state';
import { RECORD_HREF } from './tabs';

/**
 * T-544 - the tab strip for every /channel-settlements screen. A layout does not re-render on navigation, so the current tab is read from
 * the address here. It draws nothing on the record page, which is a task of its own with a back link rather than a tab.
 */
export function SettlementTabs({ items }: { items: SectionTabItem[] }) {
  const pathname = usePathname();
  if (pathname === RECORD_HREF || pathname.startsWith(`${RECORD_HREF}/`)) return null;
  return (
    <div className="px-4 pt-4 md:px-6 md:pt-6 xl:pt-4">
      <SectionTabs label="Channel settlements sections" items={items} current={activeHref(pathname, items.map((i) => i.href))} />
    </div>
  );
}
