import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../lib/session';
import { postProductionAction, voidProductionAction } from '../actions';
import { productionRecordDetail } from '../lib';

export const metadata = { title: 'Production record — Shareat System' };
export const dynamic = 'force-dynamic';

const BTN_SM =
  'rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';
const BTN_PRIMARY = 'rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900';
const BTN_DANGER = 'rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950';
const INPUT = 'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

const KIND_LABEL: Record<string, string> = { slice: 'Slice (slab -> pieces)', cook: 'Cook (recipe batch)', convert: 'Convert (re-cut, no GL impact)' };
const STATUS_LABEL: Record<string, string> = { draft: 'Draft', posted: 'Posted', void: 'Void' };

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
  const sp = await searchParams;
  const { actor } = await requireSession(`/inventory/production/${id}`);
  const detail = await productionRecordDetail(actor.orgId, id);
  if (!detail) notFound();

  const { record, locationName, lines } = detail;
  const inputs = lines.filter((l) => l.direction === 'out');
  const outputs = lines.filter((l) => l.direction === 'in');
  const warnings = Array.isArray(record.softWarnings) ? (record.softWarnings as string[]) : [];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{KIND_LABEL[record.kind] ?? record.kind}</h1>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
            {record.producedOn} · {locationName} · revision {record.revision} ·{' '}
            <span className="font-medium">{STATUS_LABEL[record.status] ?? record.status}</span>
          </p>
        </div>
        <Link href="/inventory/production" className="text-sm underline underline-offset-4">
          ← Production
        </Link>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <p className="font-medium">Soft warnings (posted anyway):</p>
          <ul className="mt-1 list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
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
            <button type="submit" className={BTN_PRIMARY}>
              Post
            </button>
          </form>
        )}
        {record.status === 'posted' && (
          <form action={voidProductionAction} className="flex items-end gap-2">
            <input type="hidden" name="recordId" value={record.id} />
            <label className="text-sm">
              <span className="block text-neutral-600 dark:text-neutral-400">Void reason</span>
              <input name="reason" required className={INPUT} />
            </label>
            <button type="submit" className={BTN_DANGER}>
              Void
            </button>
          </form>
        )}
      </section>
    </main>
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
