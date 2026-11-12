import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { Refills } from '../_refills/Refills';
import { storeRefused } from '../lib';

export const metadata = { title: 'Refills — Shareat POS' };
export const dynamic = 'force-dynamic';

/** T-526 R1: /pos/refills needs `request_pos_refill`. A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams). T-529: the screen itself. */
export default async function PosRefillsPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos/refills');
  if (refusal) return refusal;
  const { storeId } = await searchParams;
  if (await storeRefused(actor, storeId, 'request_pos_refill')) return <StoreNotAvailable />;
  return (
    <Page density="table">
      <Refills />
    </Page>
  );
}
