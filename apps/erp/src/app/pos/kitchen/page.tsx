import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { Kitchen } from '../_kitchen/Kitchen';
import { storeRefused } from '../lib';

export const metadata = { title: 'Kitchen — Shareat POS' };
export const dynamic = 'force-dynamic';

/** T-526 R1: /pos/kitchen needs `serve_pos_ticket`. A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams). T-529: the screen itself. */
export default async function PosKitchenPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos/kitchen');
  if (refusal) return refusal;
  const { storeId } = await searchParams;
  if (await storeRefused(actor, storeId, 'serve_pos_ticket')) return <StoreNotAvailable />;
  return (
    <Page density="table">
      <Kitchen />
    </Page>
  );
}
