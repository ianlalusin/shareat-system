import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SHORTAGE_REASONS } from '@shareat/db/schema';
import { canViewPhoto } from '../../../../lib/photo-link';
import { requireSession } from '../../../../lib/session';
import { peso } from '../../../../lib/format';
import { receiveDeliveryAction } from '../actions';
import { deliveryDetail } from '../lib';
import { Page } from '@/components/shell/Page';
import {
  Button,
  FlashBanner,
  Input,
  LinkRow,
  RowAction,
  RowLink,
  Select,
  StatusHero,
  deliverySteps,
  simpleStepIndexFor,
  statusLabel,
  type StatusIconKind,
  type Tone,
} from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Delivery — Shareat System' };
export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = { supplier: 'Supplier delivery', purchase: 'Cash purchase', commissary: 'Commissary delivery' };
/** ⭐ `not_received` is auto-set by the server on a zero-received line — a system conclusion,
 *  never an operator's picker choice (T-166's own design). */
const PICKABLE_REASONS = SHORTAGE_REASONS.filter((r) => r !== 'not_received');
const REASON_LABEL: Record<string, string> = {
  not_received: 'Not received',
  supplier_short: 'Supplier packed short',
  damaged_in_transit: 'Damaged in transit',
  damaged_on_arrival: 'Damaged on arrival',
  quality_reject: 'Quality reject',
  count_correction: 'Count correction',
  other: 'Other',
};

/** Delivery statuses -> hero. `void` is the exit (danger). */
const DELIVERY_HERO: Record<string, { kind: StatusIconKind; tone: Tone; line: string }> = {
  draft: { kind: 'counting', tone: 'info', line: 'Count what landed, line by line, then receive the delivery.' },
  received: { kind: 'received', tone: 'success', line: 'Received. The stock is in and the value is posted.' },
  void: { kind: 'void', tone: 'danger', line: 'This delivery was voided.' },
};

function when(d: Date | null): string {
  return d ? new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '—';
}

export default async function DeliveryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string; warning?: string }>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/inventory/deliveries/${id}`);
  const detail = await deliveryDetail(actor.orgId, id);
  if (!detail) notFound();
  const { doc, locations } = detail;

  const canViewProof = await canViewPhoto(actor, doc.proofFileId);
  const canReceive = doc.status === 'draft';
  const hero = DELIVERY_HERO[doc.status];
  if (!hero) throw new Error(`DeliveryPage: no hero for status ${doc.status}`);
  // `void` is an exit and maps to the first step (the delivery has no step-level timestamps beyond receivedAt).
  const heroStep = simpleStepIndexFor('delivery', doc.status);
  const goods = doc.lines.reduce((n, l) => n + Number(l.orderedQuantity) * Number(l.unitCost), 0);

  return (
    <Page view="detail" sectioned density="table">
      <div>
        <Link href={`/inventory/deliveries?store=${doc.storeId}`} className="text-sm underline underline-offset-4">
          ← Deliveries
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {KIND_LABEL[doc.kind] ?? doc.kind}
          {doc.supplierName && <> — {doc.supplierName}</>}
        </h1>
        <PageDescription className="mt-1">
          {doc.deliveredOn}
          {doc.referenceNo && <> · ref {doc.referenceNo}</>}
        </PageDescription>
        {doc.proofFileId && canViewProof && (
          <a href={`/files/${doc.proofFileId}`} target="_blank" rel="noopener noreferrer" className={ACTION_LINK}>
            View photo
          </a>
        )}
      </div>

      <FlashBanner flash={sp} />

      <StatusHero kind={hero.kind} word={statusLabel(doc.status)} step={heroStep} steps={deliverySteps} line={hero.line} tone={hero.tone}>
        {canReceive && (
          <Button type="submit" form="receive-delivery-form" variant="primary">
            Receive
          </Button>
        )}
      </StatusHero>

      <form id="receive-delivery-form" action={receiveDeliveryAction} className="space-y-4">
        <input type="hidden" name="deliveryId" value={doc.id} />
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Ordered</th>
                <th className="px-3 py-2 text-right font-medium">Unit cost</th>
                {canReceive ? (
                  <>
                    <th className="px-3 py-2 text-right font-medium">Received</th>
                    <th className="px-3 py-2 font-medium">If short: why</th>
                    <th className="px-3 py-2 font-medium">Room</th>
                  </>
                ) : (
                  <>
                    <th className="px-3 py-2 text-right font-medium">Received</th>
                    <th className="px-3 py-2 font-medium">Shortage reason</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                <LinkRow key={l.id} className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2">
                    <RowLink href={`/items/${l.itemId}`}>
                      {l.itemName}
                    </RowLink>
                    <span className="ml-2 font-mono text-xs text-neutral-500">{l.itemCode}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {l.orderedQuantity} {l.purchaseUnit}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(l.unitCost)}</td>
                  {canReceive ? (
                    <>
                      <td className="px-3 py-2 text-right tabular-nums">
                        <RowAction>
                          <input type="hidden" name="lineId" value={l.id} />
                          <Input
                            name="receivedQuantity"
                            inputMode="decimal"
                            defaultValue={l.orderedQuantity}
                            className="w-24 text-right tabular-nums"
                          />
                        </RowAction>
                      </td>
                      <td className="px-3 py-2">
                        <RowAction>
                          <Select name="shortageReason" defaultValue="" className="text-xs">
                            <option value="">— only if short —</option>
                            {PICKABLE_REASONS.map((r) => (
                              <option key={r} value={r}>
                                {REASON_LABEL[r] ?? r}
                              </option>
                            ))}
                          </Select>
                        </RowAction>
                      </td>
                      <td className="px-3 py-2">
                        <RowAction>
                          <Select name="locationId" defaultValue="" className="text-xs">
                            <option value="">— keep as drafted —</option>
                            {locations.map((loc) => (
                              <option key={loc.id} value={loc.id}>
                                {loc.name}
                              </option>
                            ))}
                          </Select>
                        </RowAction>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {l.receivedQuantity !== null ? `${l.receivedQuantity} ${l.purchaseUnit}` : '—'}
                      </td>
                      <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                        {l.shortageReason ? (REASON_LABEL[l.shortageReason] ?? l.shortageReason) : '—'}
                        {l.overReceiptAllowed && <span className="ml-1 text-warning-ink">(over-receipt approved)</span>}
                      </td>
                    </>
                  )}
                </LinkRow>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-200 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
                <td className="px-3 py-2" colSpan={2}>
                  As ordered
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums" colSpan={canReceive ? 4 : 3}>
                  {peso(goods.toFixed(2))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {canReceive && (
          <div className="flex flex-wrap items-start gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="grow">
              <h2 className="font-medium">Receive</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                ⭐ This is the event: quantity moves, cost is layered FIFO, and the value posts to
                the books — the stock accounts (raw materials, supplies, prepared goods) go up and goods received, bill not yet in, goes up by the same amount, in one transaction. A line left short needs a
                reason above; a line answered 0 is treated as not received.
              </p>
              <label className="mt-2 flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300">
                <input type="checkbox" name="overReceiptOk" />
                Allow receiving over what was ordered
                <span className="text-neutral-500">(needs a manager or admin — a cashier ticking this is refused)</span>
              </label>
            </div>
          </div>
        )}
      </form>

      {(doc.status === 'received' || doc.status === 'void') && (
        <dl className="grid gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-2 dark:text-neutral-400">
          <dt className="text-neutral-400">Received</dt>
          <dd>{when(doc.receivedAt)}</dd>
          {doc.status === 'void' && (
            <>
              <dt className="text-neutral-400">Voided</dt>
              <dd>
                {when(doc.voidedAt)} — {doc.voidReason}
              </dd>
            </>
          )}
        </dl>
      )}

      <Link href={`/inventory?store=${doc.storeId}`} className="inline-block text-sm underline underline-offset-4">
        View stock on hand →
      </Link>
    </Page>
  );
}
