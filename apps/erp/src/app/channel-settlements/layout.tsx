import type { ReactNode } from 'react';
import { heldCapabilities } from '@shareat/auth';
import { requireSession } from '../../lib/session';
import { withOrgPrincipal } from './lib';
import { SettlementTabs } from './SettlementTabs';
import { visibleSettlementTabs } from './tabs';

/**
 * T-544 - one sidebar entry, three tabs. The layout is what puts the tabs above `review/page.tsx` without editing it. Which tabs show comes
 * from the capabilities the actor holds; the routes are still gated at their own doors.
 */
export default async function ChannelSettlementsLayout({ children }: { children: ReactNode }) {
  const { actor } = await requireSession('/channel-settlements');
  const held = await withOrgPrincipal(actor.orgId, (tx) => heldCapabilities(tx, actor));
  return (
    <>
      <SettlementTabs items={visibleSettlementTabs(held)} />
      {children}
    </>
  );
}
