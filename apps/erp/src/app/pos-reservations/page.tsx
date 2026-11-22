import { formatBusinessDateTime } from '@shareat/core/datetime';
import { add, money } from '@shareat/core/money';
import { listReservationsForOffice } from '@shareat/domain';
import { peso } from '../../lib/format';
import { listStores, withOrgPrincipal } from '../expenses/lib';
import { requirePageAccess } from '../../lib/page-access';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Banner, Button, NumTd, Select, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'POS reservations — Shareat System' };
export const dynamic = 'force-dynamic';

/** T-628: the office's read-only view of the POS table reservations and the deposits held per store. Editing stays on the POS (Reservations tab). `approve_pos_correction` at the store. */
export default async function PosReservationsPage({ searchParams }: { searchParams: Promise<{ store?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos-reservations');
  if (refusal) return refusal;
  const sp = await searchParams;
  const stores = await listStores(actor.orgId);
  const store = stores.find((s) => s.id === sp.store) ?? stores[0];
  const rows = store ? (await withOrgPrincipal(actor.orgId, (tx) => listReservationsForOffice(tx, actor, { storeId: store.id }))).reservations : [];
  const held = rows.reduce((a, r) => add(a, money(r.held)), money('0'));
  return (
    <Page density="table">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">POS reservations</h1>
        <PageDescription>Tables held for customers and the deposits held for them, per store. Read-only: reservations are taken, seated and settled on the POS tablet.</PageDescription>
      </header>
      <form method="get" className="flex items-center gap-2">
        <label className="text-sm" htmlFor="store">Store</label>
        <Select id="store" name="store" defaultValue={store?.id ?? ''}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
        <Button type="submit">Show</Button>
      </form>
      {rows.length === 0 ? <Banner tone="info">No reservations in the last 30 days or coming up.</Banner> : null}
      {rows.length > 0 ? (
        <>
          <p className="text-sm text-muted">Deposits held now: <strong>{peso(held)}</strong></p>
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Guests</Th>
                <Th>When</Th>
                <Th>Status</Th>
                <Th align="right">Deposit held</Th>
                <Th>Booked by</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td>{r.customerName}</Td>
                  <Td>{r.partySize}</Td>
                  <Td>{formatBusinessDateTime(new Date(r.reservedFor))}</Td>
                  <Td>{r.status.replace('_', '-')}</Td>
                  <NumTd>{peso(r.held)}</NumTd>
                  <Td>{r.createdByName}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      ) : null}
    </Page>
  );
}
