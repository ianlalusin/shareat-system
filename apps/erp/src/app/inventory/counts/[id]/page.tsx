import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compareQuantity, quantity, ZERO_QUANTITY } from '@shareat/domain';
import { getCountSessionDetail, type SheetLine } from '../lib';
import { advanceCountAction, cancelCountAction, commitCountAction, recordCountAction } from '../actions';
import { requireSession } from '../../../../lib/session';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'Count sheet — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'w-24 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';
const BTN_SECONDARY =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';
const BTN_DANGER =
  'rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950';

const STATUS_LABEL: Record<string, string> = {
  open: 'Open — no lines counted yet',
  counting: 'Counting',
  reviewing: 'Reviewing',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

function when(d: Date | null): string {
  return d ? new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '—';
}

/** One row of the count sheet — its own `<form>`, per T-172's `LineCard` pattern: the phone-portrait
 *  canvas (a stockroom, held in one hand) cannot host a table cell that is also a form. */
function SheetRow({ line, sessionId, editable }: { line: SheetLine; sessionId: string; editable: boolean }) {
  // T-371 C4: the variance's sign in scaled bigint on the minted (14,3) value, never `Number(...) < 0`.
  const varianceSign = line.variance !== null ? compareQuantity(quantity(line.variance), ZERO_QUANTITY) : 0;
  return (
    <tr className="border-b border-neutral-200 align-top dark:border-neutral-800">
      <td className="py-2 pr-4">
        <div className="font-medium">{line.itemName}</div>
        <div className="font-mono text-xs text-neutral-500">{line.itemCode}</div>
      </td>
      <td className="py-2 pr-4">{line.locationName}</td>
      <td className="py-2 pr-4 tabular-nums text-neutral-500">
        {line.ledgerQuantity !== null ? `${line.ledgerQuantity} ${line.baseUnit}` : <span className="text-amber-700 dark:text-amber-400">not expected</span>}
      </td>
      <td className="py-2 pr-4">
        {editable ? (
          <form action={recordCountAction} className="flex items-center gap-2">
            <input type="hidden" name="sessionId" value={sessionId} />
            <input type="hidden" name="itemId" value={line.itemId} />
            <input type="hidden" name="locationId" value={line.locationId} />
            <input
              name="countedQuantity"
              required
              inputMode="decimal"
              placeholder="0.000"
              defaultValue={line.countedQuantity ?? ''}
              className={INPUT}
            />
            <span className="text-xs text-neutral-500">{line.baseUnit}</span>
            <button type="submit" className={BTN_SECONDARY}>
              Save
            </button>
          </form>
        ) : (
          <span className="tabular-nums">{line.countedQuantity !== null ? `${line.countedQuantity} ${line.baseUnit}` : '—'}</span>
        )}
      </td>
      <td className="py-2 pr-4 tabular-nums">{line.expectedQuantity ?? '—'}</td>
      <td className="py-2 pr-4 tabular-nums">
        {line.variance !== null ? (
          <span className={varianceSign === -1 ? 'text-red-700 dark:text-red-400' : varianceSign === 1 ? 'text-green-700 dark:text-green-400' : ''}>
            {line.variance}
          </span>
        ) : (
          '—'
        )}
      </td>
      <td className="py-2 font-mono text-xs text-neutral-500">{line.movementId ?? '—'}</td>
    </tr>
  );
}

export default async function CountSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/inventory/counts/${id}`);
  const detail = await getCountSessionDetail(actor.orgId, id);
  if (!detail) notFound();

  const editable = detail.status === 'open' || detail.status === 'counting' || detail.status === 'reviewing';
  const canAdvance = detail.status === 'counting';
  const canCommit = detail.status === 'counting' || detail.status === 'reviewing';
  const canCancel = detail.status !== 'closed' && detail.status !== 'cancelled';
  const rows = [...detail.sheet, ...detail.extras];

  return (
    <Page density="table">
      <div>
        <Link href={`/inventory/counts?store=${detail.storeId}`} className="text-sm underline underline-offset-4">
          ← Physical counts
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {detail.storeName} — {detail.locations.map((l) => l.name).join(', ')}
        </h1>
        <PageDescription className="mt-1">
          Counted on {detail.countedOn} · <strong>{STATUS_LABEL[detail.status] ?? detail.status}</strong>
          {detail.note && <> · {detail.note}</>}
        </PageDescription>
        {editable && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            ⛔ Frozen — {detail.locations.map((l) => l.name).join(', ')} refuse every other stock post until
            this count is committed or cancelled.
          </p>
        )}
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

      <section className="overflow-x-auto">
        <h2 className="font-medium">
          Count sheet
          <span className="ml-2 text-xs font-normal text-neutral-500 dark:text-neutral-400">
            The ledger&rsquo;s expected quantity is shown beside the input — an informed count, same as v1.
          </span>
        </h2>
        {rows.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">This room currently holds no tracked stock.</p>
        ) : (
          <table className="mt-3 w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 pr-4 font-medium">Room</th>
                <th className="py-2 pr-4 font-medium">Ledger (now)</th>
                <th className="py-2 pr-4 font-medium">Counted</th>
                <th className="py-2 pr-4 font-medium">Expected (at commit)</th>
                <th className="py-2 pr-4 font-medium">Variance</th>
                <th className="py-2 font-medium">Movement</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((line) => (
                <SheetRow key={`${line.itemId}:${line.locationId}`} line={line} sessionId={detail.id} editable={editable} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {editable && detail.addableItems.length > 0 && (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">This is here but wasn&rsquo;t expected</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            Found something the ledger has no record of in this room? Add it — it will still show its
            true count against a ledger balance of zero, and post as counted LONG at commit.
          </p>
          <form action={recordCountAction} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="sessionId" value={detail.id} />
            <label className="text-xs text-neutral-600 dark:text-neutral-400">
              Item
              <select name="itemId" required defaultValue="" className={`${INPUT} w-56`}>
                <option value="" disabled>
                  — pick —
                </option>
                {detail.addableItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name} ({i.baseUnit})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-600 dark:text-neutral-400">
              Room
              <select name="locationId" required defaultValue={detail.locations[0]?.id ?? ''} className={INPUT}>
                {detail.locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-neutral-600 dark:text-neutral-400">
              Quantity
              <input name="countedQuantity" required inputMode="decimal" placeholder="0.000" className={INPUT} />
            </label>
            <button type="submit" className={BTN_SECONDARY}>
              Add
            </button>
          </form>
        </section>
      )}

      {(canAdvance || canCommit || canCancel) && (
        <section className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          {canAdvance && (
            <form action={advanceCountAction}>
              <input type="hidden" name="sessionId" value={detail.id} />
              <button type="submit" className={BTN_SECONDARY}>
                → Move to reviewing
              </button>
            </form>
          )}
          {canCommit && (
            <form action={commitCountAction}>
              <input type="hidden" name="sessionId" value={detail.id} />
              <button type="submit" className={BTN}>
                Commit
              </button>
            </form>
          )}
          {canCommit && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Manager only. The variance posts to <strong>5400</strong> at FIFO cost and the room unfreezes.
            </span>
          )}
          {canCancel && (
            <form action={cancelCountAction} className="ml-auto">
              <input type="hidden" name="sessionId" value={detail.id} />
              <button type="submit" className={BTN_DANGER}>
                Cancel count
              </button>
            </form>
          )}
        </section>
      )}

      {(detail.status === 'closed' || detail.status === 'cancelled') && (
        <dl className="grid gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-2 dark:text-neutral-400">
          <dt className="text-neutral-400">Opened by</dt>
          <dd>
            {detail.openedByName} · {when(detail.openedAt)}
          </dd>
          <dt className="text-neutral-400">{detail.status === 'closed' ? 'Committed' : 'Cancelled'}</dt>
          <dd>
            {detail.closedByName} · {when(detail.closedAt)}
          </dd>
          {detail.journalEntryId && (
            <>
              <dt className="text-neutral-400">Journal entry</dt>
              <dd className="font-mono">{detail.journalEntryId}</dd>
            </>
          )}
        </dl>
      )}

      {detail.status === 'closed' && (
        <p className="text-sm">
          <Link href={`/inventory?store=${detail.storeId}`} className="underline underline-offset-4">
            See stock on hand →
          </Link>
        </p>
      )}
    </Page>
  );
}
