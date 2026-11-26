import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { Lobby } from '../_lobby/Lobby';
import { storeRefused } from '../lib';

export const metadata = { title: 'Lobby — Shareat POS' };
export const dynamic = 'force-dynamic';

/**
 * T-644 S1: /pos/lobby needs `record_sale` (it rides on '/pos' by prefix). A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams).
 * The list is polled by the shell (every tab, so diners can check in) and handed down through the POS context; every move is a Server Action behind `record_sale`.
 */
export default async function PosLobbyPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos/lobby');
  if (refusal) return refusal;
  const { storeId } = await searchParams;
  if (await storeRefused(actor, storeId, 'record_sale')) return <StoreNotAvailable />;
  return (
    <Page density="table">
      <Lobby />
    </Page>
  );
}
