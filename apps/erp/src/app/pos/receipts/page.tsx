import { posV2Repo } from '@shareat/db';
import { listTodaysSalesReceipts } from '@shareat/domain';
import { add, money, ZERO } from '@shareat/core/money';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { Banner, Table, Td, NumTd, Th } from '@/components/ui';
import { peso } from '@/lib/format';
import { withOrgPrincipal } from '../../expenses/lib';
import { missingSeqs } from '../_till/receipt-gaps';
import { effectiveStore, pairingInOrg, storeRefused } from '../lib';

export const metadata = { title: 'Receipts — Shareat POS' };
export const dynamic = 'force-dynamic';

const pad6 = (n: number) => String(n).padStart(6, '0');

/**
 * T-526 R1: /pos/receipts needs `record_sale`. A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams).
 * T-601 S2: the read-only list of the receipts since the last close (Z), newest first. On a paired tablet only that till's receipts show. No buttons:
 * reprinting an old receipt comes after the soak.
 */
export default async function PosReceiptsPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos/receipts');
  if (refusal) return refusal;
  const { storeId: requested } = await searchParams;
  if (await storeRefused(actor, requested, 'record_sale')) return <StoreNotAvailable />;

  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    const pairing = await pairingInOrg(tx, actor);
    const { storeId } = effectiveStore(pairing, requested);
    if (!storeId) return null;
    const { receipts } = await listTodaysSalesReceipts(tx, actor, { storeId });
    if (!pairing) return { receipts };
    const till = await posV2Repo.getTerminalForPairing(tx, actor.orgId, storeId, pairing.pairingId);
    return { receipts: receipts.filter((r) => r.terminalId === till?.id) };
  });
  if (!data) {
    return (
      <Page density="table">
        <Banner tone="info">Choose a store to see its receipts.</Banner>
      </Page>
    );
  }

  const { receipts } = data;
  const gaps = missingSeqs(receipts);
  const total = receipts.reduce((sum, r) => add(sum, money(r.total)), ZERO);
  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Receipts since the last close</h1>
        <p className="mt-1 text-sm text-muted">
          {receipts.length} {receipts.length === 1 ? 'receipt' : 'receipts'} · total {peso(total)} ·{' '}
          {gaps.length === 0 ? 'Numbers: no gaps' : `Missing numbers: ${gaps.map((g) => pad6(g.seq)).join(', ')} — write these down`}
        </p>
      </div>
      {receipts.length === 0 ? (
        <p className="text-sm text-muted">No receipts yet since the last close.</p>
      ) : (
        <Table label="Receipts since the last close">
          <thead>
            <tr>
              <Th>Receipt no</Th>
              <Th>Time</Th>
              <Th>Table</Th>
              <Th numeric>Total</Th>
              <Th>Paid by</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {receipts.map((r) => (
              <tr key={r.receiptId}>
                <Td className="font-mono">{r.receiptNo}</Td>
                <Td>{formatBusinessDateTime(r.issuedAtDevice, { timeStyle: 'short' })}</Td>
                <Td>{r.table}</Td>
                <NumTd>{peso(r.total)}</NumTd>
                <Td>{r.tenders === '' ? '—' : r.tenders}</Td>
                <Td>{r.offline ? 'Sent while offline' : 'Online'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
