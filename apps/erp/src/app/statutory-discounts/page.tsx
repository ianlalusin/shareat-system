import { requirePageAccess } from '../../../lib/page-access';
import { listStatutoryDiscounts } from './lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Statutory Discounts — Shareat System' };
export const dynamic = 'force-dynamic';

/** T-244 — statutory-discounts page. */
export default async function StatutoryDiscountsPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/statutory-discounts');
  if (refusal) return refusal;
  const discounts = await listStatutoryDiscounts(actor.orgId);

  return (
    <Page density="table" title="Statutory Discounts" description="View and set statutory discounts applicable to branch transactions. Each entry shows the discount type and rate."> 
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* h1 and PageDescription replaced by PageHeader props */}
        </div>
      </div>
    </Page>
  );
}
