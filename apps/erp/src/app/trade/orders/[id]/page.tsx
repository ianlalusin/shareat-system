import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SHORTAGE_REASONS } from '@shareat/db/schema';
import { add, compare, money, ZERO } from '@shareat/core/money';
import { requireSession } from '../../../../lib/session';
import { dispatchOrderAction, receiveOrderAction, voidOrderAction } from '../actions';
import { STATUS_LABEL, orderDetail, peso, today } from '../lib';
import { TREATMENT_LABEL, TREATMENT_TONE } from '../../../customers/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Trade order — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';
const BTN_DANGER =
  'rounded-md border border-red-300 px-4 py-2.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950';

const REASON_LABEL: Record<string, string> = {
  not_received: 'Not received',
  supplier_short: 'Packed short',
  damaged_in_transit: 'Damaged in transit',
  damaged_on_arrival: 'Damaged on arrival',
  quality_reject: 'Quality reject',
  count_correction: 'Count correction',
  other: 'Other',
};

function when(d: Date | null): string {
  return d ? new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) : '—';
}

export default async function TradeOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/trade/orders/${id}`);
  const detail = await orderDetail(actor.orgId, id);
  if (!detail) notFound();
  const { order, lines, customer, treatment, sellingStore, receivingStore } = detail;

  const isInternal = treatment === 'internal';
  const canDispatch = order.status === 'draft' || order.status === 'confirmed';
  const canReceive = order.status === 'dispatched';
  // ⛔ Void after receipt on an INTERNAL transfer needs a two-store reverse-transfer that is not
  // built (T-165) — the domain refuses it, so the button is not offered. A received SALE may
  // still be voided: AR unwinds the charge and the stock comes back.
  const canVoid = order.status !== 'void' && !(order.status === 'received' && isInternal);
  // T-371 C4 — stored figures re-minted and summed/compared in scaled bigint, never as floats.
  const goods = add(...lines.map((l) => money(l.lineTotal)));
  const fees = add(money(order.deliveryFee), money(order.otherFees));

  return (
    <Page density="table">
      <div>
        <Link href={`/trade/orders?store=${order.storeId}`} className="text-sm underline underline-offset-4">
          ← Trade orders
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">
          {sellingStore?.name ?? '—'} → {isInternal ? (receivingStore?.name ?? '—') : customer.name}
        </h1>
        <PageDescription className="mt-1">
          {order.orderDate} · <strong>{STATUS_LABEL[order.status]}</strong> · {peso(order.totalAmount)}
          {order.referenceNo && <> · ref {order.referenceNo}</>}
        </PageDescription>
        <p className={`mt-1 text-xs ${TREATMENT_TONE[treatment] ?? ''}`}>
          {customer.name} · {TREATMENT_LABEL[treatment]}
        </p>
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

      {/*
        ⭐ For a DISPATCHED internal transfer this table is also the receive form: what the branch
        signed for, per line. THREE quantities (T-172) — ordered, packed, signed for — and the gap
        between the last two becomes a transit discrepancy (T-174) the commissary must dispose of.
      */}
      <form action={receiveOrderAction} className="space-y-4">
        <input type="hidden" name="orderId" value={order.id} />
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Ordered</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                {isInternal && <th className="px-3 py-2 text-right font-medium">At cost</th>}
                {isInternal && <th className="px-3 py-2 text-right font-medium">Signed for</th>}
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const packed = l.fulfilledQuantity ?? l.quantity;
                return (
                  <tr key={l.id} className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <Link href={`/items/${l.itemId}`} className="underline underline-offset-4">
                        {l.itemName}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-neutral-500">{l.itemCode}</span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {l.quantity} {l.unit}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(l.rate)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(l.lineTotal)}</td>
                    {isInternal && (
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-500">
                        {l.dispatchCost ? peso(l.dispatchCost) : '—'}
                      </td>
                    )}
                    {isInternal && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {canReceive ? (
                          <div className="flex flex-col items-end gap-1">
                            <input type="hidden" name="lineId" value={l.id} />
                            <input
                              name="receivedQuantity"
                              inputMode="decimal"
                              defaultValue={packed}
                              className={`${INPUT} w-24 text-right tabular-nums`}
                            />
                            <select name="shortageReason" className={`${INPUT} text-xs`} defaultValue="">
                              <option value="">If short: why?</option>
                              {SHORTAGE_REASONS.map((r) => (
                                <option key={r} value={r}>
                                  {REASON_LABEL[r] ?? r}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : (
                          (l.receivedQuantity ?? '—')
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-neutral-200 text-xs text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
                <td className="px-3 py-2" colSpan={3}>
                  Goods {peso(goods)}
                  {compare(fees, ZERO) > 0 && (
                    <>
                      {' '}+ freight {peso(order.deliveryFee)}
                      {compare(money(order.otherFees), ZERO) > 0 && <> + other {peso(order.otherFees)}</>}
                      {' '}<span className="text-neutral-400">(on top of the goods, never into an item&rsquo;s cost)</span>
                    </>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums" colSpan={isInternal ? 3 : 1}>
                  {peso(order.totalAmount)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {canReceive && (
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="grow">
              <h2 className="font-medium">Confirm receipt</h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {isInternal
                  ? 'Who signed for what actually landed. ⭐ This is the event where BOTH stores’ books move — the branch’s stock arrives at the transfer value, the commissary’s in-transit is relieved at cost, and any shortfall opens a transit discrepancy.'
                  : 'Records who signed for the goods, and when. Nothing further posts for a sale — the value moved at dispatch.'}
              </p>
            </div>
            <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              Received on
              <input name="receivedOn" type="date" defaultValue={today()} className={INPUT} />
            </label>
            <button type="submit" className={BTN}>
              Receive
            </button>
          </div>
        )}
      </form>

      {order.notes && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="text-xs uppercase tracking-wide text-neutral-400">Notes</span> · {order.notes}
        </p>
      )}

      {canDispatch && (
        <form
          action={dispatchOrderAction}
          className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input type="hidden" name="orderId" value={order.id} />
          <div className="grow">
            <h2 className="font-medium">Dispatch</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {isInternal
                ? 'The goods leave the commissary: its stock is relieved into in-transit (1340) at real FIFO cost. No revenue, no receivable — a branch is not a customer of its own company.'
                : 'The billing event: the receivable is raised against the customer, wholesale revenue is recognised, and stock is relieved with cost of sales — one act, idempotent.'}
            </p>
          </div>
          {!isInternal && customer.creditLimit !== null && (
            <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              Reason to exceed the {peso(customer.creditLimit)} limit (only if it does)
              <input name="creditOverrideReason" placeholder="say why, on the record" className={`${INPUT} w-full`} />
            </label>
          )}
          <button type="submit" className={BTN}>
            Dispatch
          </button>
        </form>
      )}

      {(order.status === 'dispatched' || order.status === 'received' || order.status === 'void') && (
        <dl className="grid gap-x-6 gap-y-1 text-xs text-neutral-600 sm:grid-cols-2 dark:text-neutral-400">
          <dt className="text-neutral-400">Dispatched</dt>
          <dd>{when(order.dispatchedAt)}</dd>
          <dt className="text-neutral-400">Received</dt>
          <dd>{when(order.receivedAt)}</dd>
          {order.journalEntryId && (
            <>
              <dt className="text-neutral-400">Journal entry</dt>
              <dd className="font-mono">{order.journalEntryId}</dd>
            </>
          )}
          {order.arChargeId && (
            <>
              <dt className="text-neutral-400">Receivable</dt>
              <dd className="font-mono">{order.arChargeId}</dd>
            </>
          )}
          {order.creditOverrideReason && (
            <>
              <dt className="text-neutral-400">Credit limit exceeded because</dt>
              <dd>{order.creditOverrideReason}</dd>
            </>
          )}
          {order.status === 'void' && (
            <>
              <dt className="text-neutral-400">Voided</dt>
              <dd>
                {when(order.voidedAt)} — {order.voidReason}
              </dd>
            </>
          )}
        </dl>
      )}

      {canVoid && (
        <form action={voidOrderAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="orderId" value={order.id} />
          <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            Void — say why
            <input name="reason" required placeholder="reason" className={`${INPUT} w-full`} />
          </label>
          <button type="submit" className={BTN_DANGER}>
            Void order
          </button>
          {order.status !== 'draft' && order.status !== 'confirmed' && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              The posting is <strong>reversed</strong>, never deleted; the ledger keeps both halves.
            </span>
          )}
        </form>
      )}
    </Page>
  );
}
