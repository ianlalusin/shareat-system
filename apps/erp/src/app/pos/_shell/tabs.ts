/** T-526 R1/R3 - which tabs a person sees, and the live count on Kitchen and Refills. Pure. */
import { navHrefAllowed } from '@/lib/route-capability';
import type { PosStateBody } from './pos-state';

export type PosTabKey = 'orders' | 'kitchen' | 'refills' | 'receipts' | 'till';
export interface PosTab {
  key: PosTabKey;
  label: string;
  href: string;
}

const TABS: readonly PosTab[] = [
  { key: 'orders', label: 'Orders', href: '/pos' },
  { key: 'kitchen', label: 'Kitchen', href: '/pos/kitchen' },
  { key: 'refills', label: 'Refills', href: '/pos/refills' },
  { key: 'receipts', label: 'Receipts', href: '/pos/receipts' },
  { key: 'till', label: 'Till', href: '/pos/till' },
];

/** One declaration: the tab is shown exactly when the page behind it would let the person in (ROUTE_CAPABILITY). */
export function visibleTabs(held: ReadonlySet<string>): PosTab[] {
  return TABS.filter((t) => navHrefAllowed(t.href, held));
}

/** null when the person may not read that list (the server sends null) or nothing has arrived yet. */
export function tabCount(key: PosTabKey, body: PosStateBody | null): number | null {
  const list = key === 'kitchen' ? body?.kitchenQueue : key === 'refills' ? body?.refillQueue : null;
  return list ? list.length : null;
}
