import type { SectionTabItem } from '@/components/ui';

/**
 * T-544 - the tabs of the channel-settlements section, and who is shown which. Presentation only: each route is still refused at its own
 * door (`ROUTE_CAPABILITY`) and by the domain, so a hidden tab is never the control. The words match `ROUTE_CAPABILITY`'s entries.
 */
export const OVERVIEW_HREF = '/channel-settlements';
export const RECORD_HREF = '/channel-settlements/record';

export const SETTLEMENT_TABS: readonly (SectionTabItem & { readonly capability?: string })[] = [
  { href: OVERVIEW_HREF, label: 'Overview' },
  { href: '/channel-settlements/upload', label: 'Upload files', capability: 'upload_settlement_files' },
  { href: '/channel-settlements/review', label: 'Review days', capability: 'record_ar_collection' },
];

export function visibleSettlementTabs(held: ReadonlySet<string>): SectionTabItem[] {
  return SETTLEMENT_TABS.filter((t) => t.capability === undefined || held.has(t.capability)).map(({ href, label }) => ({ href, label }));
}
