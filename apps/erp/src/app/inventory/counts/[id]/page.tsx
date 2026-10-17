import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compareQuantity, quantity, ZERO_QUANTITY } from '@shareat/domain';
import { getCountSessionDetail, type SheetLine } from '../lib';
import { advanceCountAction, cancelCountAction, commitCountAction, recordCountAction } from '../actions';
import { requireSession } from '../../../../lib/session';
import { Page } from '@/components/shell/Page';
import { Button, FlashBanner, FormGrid, Field, Input, Select } from '@/components/ui';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { INVENTORY_COUNT_LINE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { typedFor, type TypedView } from '@/lib/keep-typing';
import { COUNT_LINE } from '../typed-forms';

export const metadata = { title: 'Count sheet — Shareat System' };
export const dynamic = 'force-dynamic';

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
function SheetRow({ line, sessionId, editable, typed }: { line: SheetLine; sessionId: string; editable: boolean; typed: TypedView | null }) {
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
        {line.ledgerQuantity !== null ? `${line.ledgerQuantity} ${line.baseUnit}` : <span className="text-warning-ink">not expected</span>}
      </td>
      <td className="py-2 pr-4">
        {editable ? (
          line.countedQuantity === null ? (
            <CheckedForm rules={INVENTORY_COUNT_LINE_RULES} action={recordCountAction} className="flex items-center gap-2">
              <input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="itemId" value={line.itemId} />
              <input type="hidden" name="locationId" value={line.locationId} />
              <Field label={<span className="sr-only">Counted quantity</span>} rule={INVENTORY_COUNT_LINE_RULES.countedQuantity}>
                <Input
                  {...nativeAttrs(INVENTORY_COUNT_LINE_RULES.countedQuantity)}
                  placeholder="0.000"
                  defaultValue={line.countedQuantity ?? ''}
                  className="w-24 tabular-nums"
                />
              </Field>
              <span className="text-xs text-neutral-500">{line.baseUnit}</span>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </CheckedForm>
          ) : (
            <EditableRecord
              key={`${line.itemId}:${line.locationId}:${line.countedQuantity}`}
              action={recordCountAction}
              rules={INVENTORY_COUNT_LINE_RULES}
              label={line.itemName}
              hidden={{ sessionId, itemId: line.itemId, locationId: line.locationId }}
              typed={typed}
            >
              <div className="flex items-center gap-2">
                <Field label={<span className="sr-only">Counted quantity</span>} rule={INVENTORY_COUNT_LINE_RULES.countedQuantity}>
                  <Input
                    {...nativeAttrs(INVENTORY_COUNT_LINE_RULES.countedQuantity)}
                    placeholder="0.000"
                    defaultValue={line.countedQuantity}
                    className="w-24 tabular-nums"
                  />
                </Field>
                <span className="text-xs text-neutral-500">{line.baseUnit}</span>
              </div>
            </EditableRecord>
          )
        ) : (
          <span className="tabular-nums">{line.countedQuantity !== null ? `${line.countedQuantity} ${line.baseUnit}` : '—'}</span>
        )}
      </td>
      <td className="py-2 pr-4 tabular-nums">{line.expectedQuantity ?? '—'}</td>
      <td className="py-2 pr-4 tabular-nums">
        {line.variance !== null ? (
          <span className={varianceSign === -1 ? 'text-danger' : varianceSign === 1 ? 'text-success' : ''}>
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
  const sp = await withFlash(searchParams);
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
          <p className="mt-1 text-xs text-warning-ink">
            ⛔ Frozen — {detail.locations.map((l) => l.name).join(', ')} refuse every other stock post until
            this count is committed or cancelled.
          </p>
        )}
      </div>

      <FlashBanner flash={sp} />

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
                <SheetRow
                  key={`${line.itemId}:${line.locationId}`}
                  line={line}
                  sessionId={detail.id}
                  editable={editable}
                  typed={line.id ? typedFor(sp, COUNT_LINE, line.id, actor.personId) : null}
                />
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
          <CheckedForm rules={INVENTORY_COUNT_LINE_RULES} action={recordCountAction} className="mt-3 space-y-3">
            <input type="hidden" name="sessionId" value={detail.id} />
            <FormGrid>
              <Field label="Item" rule={INVENTORY_COUNT_LINE_RULES.itemId}>
                <Select {...nativeAttrs(INVENTORY_COUNT_LINE_RULES.itemId)} defaultValue="" className="mt-1 block w-full tabular-nums">
                  <option value="" disabled>
                    — pick —
                  </option>
                  {detail.addableItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name} ({i.baseUnit})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Room" rule={INVENTORY_COUNT_LINE_RULES.locationId}>
                <Select {...nativeAttrs(INVENTORY_COUNT_LINE_RULES.locationId)} defaultValue={detail.locations[0]?.id ?? ''} className="mt-1 block w-full tabular-nums">
                  {detail.locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity" rule={INVENTORY_COUNT_LINE_RULES.countedQuantity}>
                <Input {...nativeAttrs(INVENTORY_COUNT_LINE_RULES.countedQuantity)} placeholder="0.000" className="mt-1 block w-full tabular-nums" />
              </Field>
            </FormGrid>
            <Button type="submit" variant="secondary">
              Save
            </Button>
          </CheckedForm>
        </section>
      )}

      {(canAdvance || canCommit || canCancel) && (
        <section className="flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          {canAdvance && (
            <form action={advanceCountAction}>
              <input type="hidden" name="sessionId" value={detail.id} />
              <Button type="submit" variant="secondary">
                → Move to reviewing
              </Button>
            </form>
          )}
          {canCommit && (
            <form action={commitCountAction}>
              <input type="hidden" name="sessionId" value={detail.id} />
              <Button type="submit" variant="primary">
                Commit
              </Button>
            </form>
          )}
          {canCommit && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Manager only. The variance posts to <strong>stock count differences</strong> at FIFO cost and the room unfreezes.
            </span>
          )}
          {canCancel && (
            <form action={cancelCountAction} className="ml-auto">
              <input type="hidden" name="sessionId" value={detail.id} />
              <Button type="submit" variant="danger">
                Cancel count
              </Button>
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
