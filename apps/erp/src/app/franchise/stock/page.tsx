import { notFound } from 'next/navigation';
import { listFranchisees } from '@shareat/domain';
import { requirePageAccess } from '../../../lib/page-access';
import { withActorPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { StockLookForm } from '../LookForms';

export const metadata = { title: 'Franchise stock — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function FranchiseStockPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/franchise/stock');
  if (refusal) return refusal;

  const asked = one(sp.franchisee);
  const store = one(sp.store);
  if (asked !== undefined && !UUID.test(asked)) notFound();
  if (store !== undefined && !UUID.test(store)) notFound();
  const franchisees = await withActorPrincipal(actor.orgId, actor.personId, (tx) => listFranchisees(tx, actor));
  if (asked !== undefined && !franchisees.some((f) => f.franchiseeOrgId === asked)) notFound();
  const chosen = franchisees.find((f) => f.franchiseeOrgId === asked) ?? franchisees[0];

  return (
    <Page density="table" className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Franchise stock</h1>
        <PageDescription className="mt-1">
          Look at what a franchise has on hand today and which items are low. Read only. Nothing is shown until you press the button, and each press is recorded in the
          franchise&apos;s access log.
        </PageDescription>
      </div>
      {chosen ? (
        <StockLookForm choices={franchisees.map((f) => ({ id: f.franchiseeOrgId, name: f.franchiseeName }))} selected={chosen.franchiseeOrgId} />
      ) : (
        <p className="text-sm text-muted">Your company has no franchise to look at.</p>
      )}
    </Page>
  );
}
