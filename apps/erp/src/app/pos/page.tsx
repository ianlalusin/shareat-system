import { redirect } from 'next/navigation';
import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { SlicePlaceholder } from './_shell/SlicePlaceholder';
import { firstOtherPosTab, storeRefused } from './lib';

export const metadata = { title: 'Orders — Shareat POS' };
export const dynamic = 'force-dynamic';

/** T-526 R1: /pos needs `record_sale`. A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams). */
export default async function PosOrdersPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos');
  const { storeId } = await searchParams;
  if (refusal) {
    // T-526b: a kitchen or refill person who lands here is sent to their own tab, not shown the Orders refusal.
    const other = await firstOtherPosTab(actor);
    const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    if (other) redirect(`${other}${query}`);
    return refusal;
  }
  if (await storeRefused(actor, storeId, 'record_sale')) return <StoreNotAvailable />;
  return (
    <Page density="table">
      <SlicePlaceholder title="Orders" message="Orders are coming in the next update." />
    </Page>
  );
}
