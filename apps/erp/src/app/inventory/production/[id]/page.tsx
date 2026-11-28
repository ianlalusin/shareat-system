import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess } from '../../../../lib/page-access';
import { recordInScope } from '../../../../lib/store-scope';
import { confirmSlicingAction, postProductionAction, unconfirmSlicingAction, updateSliceDraftAction, voidProductionAction } from '../actions';
import { productionRecordDetail } from '../lib';
import { Page, PageHeader } from '@/components/shell/Page';
import { withFlash } from '@/lib/flash';
import { formatBusinessDayLong, toBusinessDate } from '@shareat/core/datetime';
import { Banner, Button, Checkbox, ConfirmDestructive, Field, FlashBanner, Input, Select, statusLabel } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { INVENTORY_PRODUCTION_VOID_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'Production record — Shareat System' };
export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = { slice: 'Slice (slab to pieces)', cook: 'Cook (recipe batch)', convert: 'Convert (re-cut)' };

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
  const { actor, refusal } = await requirePageAccess(`/inventory/production/${id}`);
  if (refusal) return refusal;
  const detail = await productionRecordDetail(actor.orgId, id);
  if (!detail || !(await recordInScope(actor, `/inventory/production/${id}`, detail.record.storeId))) notFound();

  const { record, locationName, lines, slicerName, confirmedByName, slicers } = detail;
  const isSlice = record.kind === 'slice';
  const inputs = lines.filter((l) => l.direction === 'out');
  const outputs = lines.filter((l) => l.direction === 'in');
  const warnings = Array.isArray(record.softWarnings) ? (record.softWarnings as string[]) : [];

  return (
    <Page view="detail" sectioned density="table">
      <PageHeader title={KIND_LABEL[record.kind] ?? record.kind} description={<>
            {formatBusinessDayLong(record.producedOn)} · {locationName} · revision {record.revision} ·{' '}
            <span className="font-medium">{statusLabel(record.status)}</span>
          </>} actions={
        <Link href="/inventory/production" className={NAV_LINK}>
          ← Production
        </Link>
      } />

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
          <LineTable lines={outputs} markUnpaid={isSlice} />
        </div>
      </section>

      {/* T-635: who sliced it, which output lines are paid, and the second person's confirmation. */}
      {isSlice && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">Slicer pay</h2>
          {record.status === 'draft' ? (
            <form action={updateSliceDraftAction} className="space-y-3">
              <input type="hidden" name="recordId" value={record.id} />
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Who sliced</span>} className="text-sm">
                <Select name="performedByPersonId" defaultValue={record.performedByPersonId ?? ''} className="w-full sm:w-72">
                  <option value="">— pick the slicer —</option>
                  {slicers.map((p) => (
                    <option key={p.personId} value={p.personId}>
                      {p.personName}
                    </option>
                  ))}
                </Select>
              </Field>
              <fieldset className="space-y-1">
                <legend className="text-sm text-neutral-600 dark:text-neutral-400">The slicer is paid per kg for the ticked lines</legend>
                {outputs
                  .filter((l) => !l.reversedAt)
                  .map((l) => (
                    <Checkbox key={l.id} name="paidLineId" value={l.id} defaultChecked={l.isPaid} label={`${l.itemName} — ${l.quantity} ${l.unit}`} />
                  ))}
              </fieldset>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </form>
          ) : (
            <dl className="grid gap-x-5 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
              <dt className="text-neutral-500">Slicer</dt>
              <dd>{slicerName ?? <span className="italic text-neutral-500">Not recorded: a manager can edit the record to name the slicer, then it can be paid.</span>}</dd>
              <dt className="text-neutral-500">Checked by</dt>
              <dd>
                {record.confirmedAt
                  ? `${confirmedByName ?? 'Someone'} on ${formatBusinessDayLong(toBusinessDate(record.confirmedAt))}`
                  : <span className="italic text-neutral-500">Not confirmed yet. It is not paid until another staff member confirms it.</span>}
              </dd>
              {record.paidByPayRunId && (
                <>
                  <dt className="text-neutral-500">Paid</dt>
                  <dd>In a pay run. It cannot be edited or voided unless that pay run is voided.</dd>
                </>
              )}
            </dl>
          )}
          {record.status === 'posted' && record.performedByPersonId && !record.paidByPayRunId && (
            <div className="flex flex-wrap gap-3">
              {!record.confirmedAt && record.performedByPersonId !== actor.personId && (
                <form action={confirmSlicingAction}>
                  <input type="hidden" name="recordId" value={record.id} />
                  <Button type="submit" variant="primary">
                    Confirm this slicing
                  </Button>
                </form>
              )}
              {!record.confirmedAt && record.performedByPersonId === actor.personId && (
                <p className="text-sm text-neutral-600 dark:text-neutral-400">You sliced this, so another staff member has to confirm it.</p>
              )}
              {record.confirmedAt && (
                <form action={unconfirmSlicingAction}>
                  <input type="hidden" name="recordId" value={record.id} />
                  <Button type="submit" variant="secondary">
                    Take back confirmation
                  </Button>
                </form>
              )}
            </div>
          )}
        </section>
      )}

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
          <CheckedForm rules={INVENTORY_PRODUCTION_VOID_RULES} action={voidProductionAction} className="flex flex-wrap items-end gap-2 gap-y-2">
            <input type="hidden" name="recordId" value={record.id} />
            <Field label={<span className="text-neutral-600 dark:text-neutral-400">Void reason</span>} className="text-sm" rule={INVENTORY_PRODUCTION_VOID_RULES.reason}>
              <Input {...nativeAttrs(INVENTORY_PRODUCTION_VOID_RULES.reason)} />
            </Field>
            <ConfirmDestructive
              tier="admin-pin"
              label="Void production"
              consequence="Reverses this production record and restores the stock. An administrator must approve with their own PIN."
            />
          </CheckedForm>
        )}
      </section>
    </Page>
  );
}

function LineTable({
  lines,
  markUnpaid = false,
}: {
  lines: { id: string; itemCode: string; itemName: string; quantity: string; unit: string; reversedAt: Date | null; isPaid: boolean }[];
  /** T-635: flag an output line the slicer is not paid for. */
  markUnpaid?: boolean;
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
                {markUnpaid && !l.isPaid && <span className="ml-2 text-xs text-neutral-500">not paid</span>}
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
