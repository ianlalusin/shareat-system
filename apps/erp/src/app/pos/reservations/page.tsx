import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { Reservations } from '../_reservations/Reservations';
import { storeRefused } from '../lib';

export const metadata = { title: 'Reservations — Shareat POS' };
export const dynamic = 'force-dynamic';

/**
 * T-628: /pos/reservations needs `record_sale` (it rides on '/pos' by prefix). A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams).
 * The list comes from the tablet's cached snapshot plus its outbox (so it works offline); the manager's refund / keep / close are online API calls made by the client.
 */
export default async function PosReservationsPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos/reservations');
  if (refusal) return refusal;
  const { storeId } = await searchParams;
  if (await storeRefused(actor, storeId, 'record_sale')) return <StoreNotAvailable />;
  return (
    <Page density="table">
      <Reservations />
    </Page>
  );
}
