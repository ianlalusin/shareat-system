import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../lib/session';
import { postProductionAction, voidProductionAction } from '../actions';
import { productionRecordDetail } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Banner, Button, ConfirmDestructive, FlashBanner, Input, statusLabel } from '@/components/ui';

export const metadata = { title: 'Production record — Shareat System' };
export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = { slice: 'Slice (slab -> pieces)', cook: 'Cook (recipe batch)', convert: 'Convert (re-cut, no GL impact)' };

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function ProductionRecordPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/inventory/production/${id}`);
  const detail = await productionRecordDetail(actor.orgId, id);
  if (!detail) notFound();

  const { record, locationName, lines } = detail;
  const inputs = lines.filter((l) => l.direction === 'out');
  const outputs = lines.filter((l) => l.direction === 'in');
  const warnings = Array.isArray(record.softWarnings) ? (record.softWarnings as string[]) : [];

  return (
    <Page view="detail" sectioned density="table">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{KIND_LABEL[record.kind] ?? record.kind}</h1>
          <PageDescription className="mt-1">
            {record.producedOn} · {locationName} · revision {record.revision} ·{' '}
            <span className="font-medium">{statusLabel(record.status)}</span>
          </PageDescription>
        </div>
        <Link href="/inventory/production" className="text-sm underline underline-offset-4">
          ← Production
        </Link>
      </div>

      <FlashBanner flash={sp} />
      {warnings.length > 0 && (
        <Banner tone="warning">
          <p className="font-medium">Soft warnings (posted anyway):</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Banner>
      )}

      <section className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <div>
          <h2 className="text-sm font-medium">Inputs (out)</h2>
          <LineTable lines={inputs} />
        </div>
        <div>
          <h2 className="text-sm font-medium">Outputs (in)</h2>
          <LineTable lines={outputs} />
        </div>
      </section>

      <section className="flex flex-wrap gap-3">
        {record.status === 'draft' && (
          <form action={postProductionAction}>
            <input type="hidden" name="recordId" value={record.id} />
            <Button type="submit" variant="primary">
              Post
            </Button>
          </form>
        )}
        {record.status === 'posted' && (
          <form action={voidProductionAction} className="flex flex-wrap items-end gap-2 gap-y-2">
            <input type="hidden" name="recordId" value={record.id} />
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Void reason</span>
              <Input name="reason" required />
            </label>
            <ConfirmDestructive
              tier="admin-pin"
              label="Void production"
              consequence="Reverses this production record and restores the stock. An administrator must approve with their own PIN."
            />
          </form>
        )}
      </section>
    </Page>
  );
}

function LineTable({
  lines,
}: {
  lines: { id: string; itemCode: string; itemName: string; quantity: string; unit: string; reversedAt: Date | null }[];
}) {
  if (lines.length === 0) return <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">None.</p>;
  return (
    <div className="mt-2 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Quantity</th>
            <th className="px-3 py-2 font-medium">Unit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr
              key={l.id}
              className={`border-b border-neutral-100 last:border-0 dark:border-neutral-900 ${l.reversedAt ? 'opacity-50 line-through' : ''}`}
            >
              <td className="px-3 py-2">
                {l.itemCode} — {l.itemName}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{l.quantity}</td>
              <td className="px-3 py-2">{l.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
