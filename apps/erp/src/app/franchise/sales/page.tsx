import { notFound } from 'next/navigation';
import { listFranchisees } from '@shareat/domain';
import { addDays, toBusinessDate, type BusinessDate } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { withActorPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { SalesLookForm } from '../LookForms';

export const metadata = { title: 'Franchise sales — Shareat System' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function FranchiseSalesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/franchise/sales');
  if (refusal) return refusal;

  const asked = one(sp.franchisee);
  if (asked !== undefined && !UUID.test(asked)) notFound();
  const franchisees = await withActorPrincipal(actor.orgId, actor.personId, (tx) => listFranchisees(tx, actor));
  if (asked !== undefined && !franchisees.some((f) => f.franchiseeOrgId === asked)) notFound();
  const chosen = franchisees.find((f) => f.franchiseeOrgId === asked) ?? franchisees[0];

  const today = toBusinessDate();
  let from: string = addDays(today, -6);
  if (chosen && from < chosen.salesVisibleFrom) from = chosen.salesVisibleFrom;
  const qFrom = one(sp.from);
  const qTo = one(sp.to);
  if (qFrom && DATE.test(qFrom)) from = qFrom;
  const to: string = qTo && DATE.test(qTo) ? qTo : (today as BusinessDate);

  return (
    <Page density="table" className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Franchise sales</h1>
        <PageDescription className="mt-1">
          Look at a franchise&apos;s sales day by day. Nothing is shown until you press the button, and each press is recorded in the franchise&apos;s access log.
        </PageDescription>
      </div>
      {chosen ? (
        <SalesLookForm choices={franchisees.map((f) => ({ id: f.franchiseeOrgId, name: f.franchiseeName }))} selected={chosen.franchiseeOrgId} from={from} to={to} />
      ) : (
        <p className="text-sm text-muted">Your company has no franchise to look at.</p>
      )}
    </Page>
  );
}
