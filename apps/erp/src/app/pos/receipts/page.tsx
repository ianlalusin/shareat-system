import type { ComponentProps } from 'react';
import { organizationsRepo, posV2Repo, storesRepo } from '@shareat/db';
import { findSalesReceiptByNo, listTodaysSalesReceipts, receiptIdentityOf, readReceiptLookupDays } from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { add, money, ZERO } from '@shareat/core/money';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { Page } from '@/components/shell/Page';
import { Banner, Table, Td, NumTd, Th } from '@/components/ui';
import { peso } from '@/lib/format';
import { withOrgPrincipal } from '../../expenses/lib';
import { missingSeqs } from '../_till/receipt-gaps';
import { effectiveStore, pairingInOrg, storeRefused } from '../lib';
import { printSettingsOf } from '../_payment/logic';
import { CorrectPayment } from './CorrectPayment';
import { FindReceipt } from './FindReceipt';
import { RefundReceipt } from './RefundReceipt';

export const metadata = { title: 'Receipts — Shareat POS' };
export const dynamic = 'force-dynamic';

const pad6 = (n: number) => String(n).padStart(6, '0');

/**
 * T-526 R1: /pos/receipts needs `record_sale`. A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams).
 * T-601 S2: the list of the receipts since the last close (Z), newest first. On a paired tablet only that till's receipts show. Reprinting an old receipt comes after the soak.
 * T-534 S3: a receipt not yet in a Z has "Wrong payment method"; its "Paid by" shows the corrected method with a small "corrected" note.
 * T-534 S4: every receipt with something left to refund has "Refund" (before or after its Z); a refunded receipt shows "Refunded ₱x" under its status.
 * T-613 D4: "Find a receipt" - `?find=<receipt number>` looks one up among the store's last 30 days (an earlier day has no row in the list above) and shows it with the same buttons.
 */
export default async function PosReceiptsPage({ searchParams }: { searchParams: Promise<{ storeId?: string; find?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos/receipts');
  if (refusal) return refusal;
  const { storeId: requested, find } = await searchParams;
  const findText = (find ?? '').trim().slice(0, 40);
  if (await storeRefused(actor, requested, 'record_sale')) return <StoreNotAvailable />;

  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    const pairing = await pairingInOrg(tx, actor);
    const { storeId } = effectiveStore(pairing, requested);
    if (!storeId) return null;
    const { receipts, tenders, canApprove } = await listTodaysSalesReceipts(tx, actor, { storeId });
    const found = findText === '' ? null : (await findSalesReceiptByNo(tx, actor, { storeId, receiptNo: findText })).receipts;
    // T-614 S2: the look-up window is the business rule pos.receipt_lookup_days.
    const lookupDays = await readReceiptLookupDays(tx, actor.orgId, toBusinessDate());
    if (!pairing) return { receipts, tenders, canApprove, paired: false, slip: null, found, lookupDays };
    const till = await posV2Repo.getTerminalForPairing(tx, actor.orgId, storeId, pairing.pairingId);
    // T-534 S4: what the refund slip needs: the issuer header (T-585) and the till's paper.
    const store = await storesRepo.getById(tx, actor.orgId, storeId);
    const org = await organizationsRepo.identityOf(tx, actor.orgId);
    const slip = {
      context: { storeName: store?.name ?? 'Store', vatRegistered: (await posV2Repo.getOrgTaxType(tx, actor.orgId)) === 'vat', identity: org && store ? receiptIdentityOf(org, store) : undefined, mode: (await posV2Repo.getPosStore(tx, actor.orgId, storeId))?.mode },
      layout: printSettingsOf({ receiptPaperMm: till?.receiptPaperMm === 80 ? 80 : 58, receiptCopies: 1 }).layout,
    };
    return { receipts: receipts.filter((r) => r.terminalId === till?.id), tenders, canApprove, paired: true, slip, found, lookupDays };
  });
  if (!data) {
    return (
      <Page density="table">
        <Banner tone="info">Choose a store to see its receipts.</Banner>
      </Page>
    );
  }

  const { receipts, tenders, canApprove, paired, slip, found, lookupDays } = data;
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
      <FindReceipt value={findText} storeId={requested} days={lookupDays} />
      {found === null ? null : found.length === 0 ? (
        <Banner tone="info">No receipt numbered {findText} at this store in the last {lookupDays} days. Check the number on the printed receipt.</Banner>
      ) : (
        <ReceiptTable label="Receipt found" showDate rows={found} paired={paired} tenders={tenders} canApprove={canApprove} slip={slip} />
      )}
      {receipts.length === 0 ? (
        <p className="text-sm text-muted">No receipts yet since the last close.</p>
      ) : (
        <ReceiptTable label="Receipts since the last close" rows={receipts} paired={paired} tenders={tenders} canApprove={canApprove} slip={slip} />
      )}
    </Page>
  );
}

type ListData = NonNullable<Awaited<ReturnType<typeof listTodaysSalesReceipts>>>;
function ReceiptTable({ label, rows, paired, tenders, canApprove, slip, showDate }: {
  label: string;
  /** An earlier day's receipt shows its date with its time. */
  showDate?: boolean;
  rows: ListData['receipts'];
  paired: boolean;
  tenders: ListData['tenders'];
  canApprove: boolean;
  slip: { context: ComponentProps<typeof RefundReceipt>['slipContext']; layout: ComponentProps<typeof RefundReceipt>['layout'] } | null;
}) {
  return (
    <Table label={label}>
      <thead>
        <tr>
          <Th>Receipt no</Th>
          <Th>Time</Th>
          <Th>Table</Th>
          <Th numeric>Total</Th>
          <Th>Paid by</Th>
          <Th>Status</Th>
          {paired ? <Th>Fix</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.receiptId}>
            <Td className="font-mono">{r.receiptNo}</Td>
            <Td>{formatBusinessDateTime(r.issuedAtDevice, showDate ? { dateStyle: 'medium', timeStyle: 'short' } : { timeStyle: 'short' })}</Td>
            <Td>{r.table}</Td>
            <NumTd>{peso(r.total)}</NumTd>
            <Td>
              {r.tenders === '' ? '—' : r.tenders}
              {r.corrected ? <span className="ml-2 text-xs text-muted">corrected</span> : null}
            </Td>
            <Td>
              {r.offline ? 'Sent while offline' : 'Online'}
              {r.refunds.length > 0 ? <p className="text-xs text-muted">Refunded {peso(r.refundedTotal)}</p> : null}
            </Td>
            {paired ? (
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  {r.canCorrect ? <CorrectPayment receiptId={r.receiptId} receiptNo={r.receiptNo} payments={r.payments} tenders={tenders} canApprove={canApprove} /> : null}
                  {slip ? <RefundReceipt receiptId={r.receiptId} receiptNo={r.receiptNo} lines={r.lines} payments={r.refundPayments} canApprove={canApprove} slipContext={slip.context} layout={slip.layout} /> : null}
                </div>
              </Td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
