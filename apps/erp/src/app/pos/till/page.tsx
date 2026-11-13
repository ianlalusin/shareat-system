import { can, isStoreManagerOrAbove } from '@shareat/auth';
import { accessRepo, personsRepo, posV2Repo, storesRepo } from '@shareat/db';
import { listDayCloses, xReading } from '@shareat/domain';
import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { formatZSlip } from '@/lib/pos-print';
import { Banner } from '@/components/ui';
import { Page } from '@/components/shell/Page';
import { withOrgPrincipal } from '../../expenses/lib';
import { printSettingsOf } from '../_payment/logic';
import { TillView } from '../_till/TillView';
import { zSlipView, type ReadingJson } from '../_till/slips';
import { effectiveStore, pairingInOrg, storeRefused } from '../lib';

export const metadata = { title: 'Till — Shareat POS' };
export const dynamic = 'force-dynamic';

/**
 * T-531 R6: /pos/till needs `record_sale`. A requested `?storeId` must be a store this person holds it at (a layout cannot read searchParams).
 * The reading, the recent Zs and their v1 status are read here (server); the Close day (Z), Close day by day and Resend doors are online API calls made by TillView.
 * Only the store's own paired tablet has a till, so a phone sees the sentence instead of a reading. The drawer count stays on the ERP till screen (row 319).
 */
export default async function PosTillPage({ searchParams }: { searchParams: Promise<{ storeId?: string }> }) {
  const { actor, refusal } = await requirePageAccess('/pos/till');
  if (refusal) return refusal;
  const { storeId: requested } = await searchParams;
  if (await storeRefused(actor, requested, 'record_sale')) return <StoreNotAvailable />;

  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    const pairing = await pairingInOrg(tx, actor);
    const { storeId } = effectiveStore(pairing, requested);
    if (!pairing || !storeId) return null;
    const at = { storeId };
    const reading = await xReading(tx, actor, { storeId, pairingId: pairing.pairingId });
    const { closes } = await listDayCloses(tx, actor, at);
    const store = await storesRepo.getById(tx, actor.orgId, storeId);
    const me = await personsRepo.getPersonById(tx, actor.orgId, actor.personId);
    const isManager = isStoreManagerOrAbove((await accessRepo.activeRoleForPerson(tx, actor.personId, actor.orgId))?.role) && (await can(tx, actor, 'approve_pos_correction', at));
    const taxType = await posV2Repo.getOrgTaxType(tx, actor.orgId);
    const till = await posV2Repo.getTerminalForPairing(tx, actor.orgId, storeId, pairing.pairingId);
    return { storeId, reading, closes, receiptPaperMm: till?.receiptPaperMm === 80 ? (80 as const) : (58 as const), receiptCopies: till?.receiptCopies ?? 1, storeName: store?.name ?? 'Store', vatRegistered: taxType === 'vat', cashierName: me?.displayName?.trim() || 'Signed in', isManager };
  });
  if (!data) {
    return (
      <Page density="table">
        <Banner tone="info">The Till is on the store tablet. Open this tab there to read the day and close it.</Banner>
      </Page>
    );
  }

  const print = printSettingsOf({ receiptPaperMm: data.receiptPaperMm, receiptCopies: data.receiptCopies });
  const ctx = { storeName: data.storeName, vatRegistered: data.vatRegistered, printedBy: data.cashierName };
  const history = data.closes.map((c) => ({
    id: c.id,
    zNo: c.zNo,
    businessDate: c.businessDate,
    grossTotal: c.grossTotal,
    tenders: c.byTender.map((t) => ({ name: t.name, amount: t.amount })),
    v1Status: c.v1Status,
    slip: formatZSlip(zSlipView(JSON.parse(JSON.stringify(c.reading)) as ReadingJson, { ...ctx, printedBy: c.closedByName }, { zNo: c.zNo, businessDate: c.businessDate, approvedBy: c.approvedByName, reprint: true }), print.layout),
  }));
  return (
    <Page density="table">
      <TillView
        reading={JSON.parse(JSON.stringify(data.reading)) as ReadingJson}
        history={history}
        isManager={data.isManager}
        store={{ name: data.storeName, vatRegistered: data.vatRegistered, receiptPaperMm: data.receiptPaperMm, receiptCopies: data.receiptCopies }}
        cashierName={data.cashierName}
        tillCountsHref={`/till?store=${encodeURIComponent(data.storeId)}`}
      />
    </Page>
  );
}
