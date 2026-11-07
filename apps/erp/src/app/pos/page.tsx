import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { SlicePlaceholder } from './_shell/SlicePlaceholder';
import { storeRefused } from './lib';

export const metadata = { title: 'Orders — Shareat POS' };
export const dynamic = 'force-dynamic';

/** T-526 R1: /pos needs `record_sale`. A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams). */
export default async function PosOrdersPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos');
  if (refusal) return refusal;
  const { storeId } = await searchParams;
  if (await storeRefused(actor, storeId, 'record_sale')) return <StoreNotAvailable />;
  return (
    <Page density="table">
      <SlicePlaceholder title="Orders" slice="T-527" />
    </Page>
  );
}
