import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SHORTAGE_REASONS } from '@shareat/db/schema';
import { add, compare, money, ZERO } from '@shareat/core/money';
import { requireSession } from '../../../../lib/session';
import { dispatchOrderAction, receiveOrderAction, setBirInvoiceNoAction, voidOrderAction } from '../actions';
import { canSeeCreditLimit, creditPreview, orderDetail, peso, storeMoneyAccounts, today } from '../lib';
import { ACTION_LINK } from '@/components/action-link';
import { PhotoInput } from '@/components/PhotoInput';
import { TREATMENT_LABEL, TREATMENT_TONE } from '../../../customers/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Button, ConfirmDestructive, exitStepFromTimestamps, FlashBanner, Input, LinkRow, RowAction, RowLink, Select, simpleStepIndexFor, StatusHero, statusLabel, tradeOrderSteps, type StatusIconKind, type Tone } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Trade order — Shareat System' };
export const dynamic = 'force-dynamic';

const REASON_LABEL: Record<string, string> = {
  not_received: 'Not received',
  supplier_short: 'Packed short',
  damaged_in_transit: 'Damaged in transit',
  damaged_on_arrival: 'Damaged on arrival',
  quality_reject: 'Quality reject',
  count_correction: 'Count correction',
  other: 'Other',
};

/** Trade-order statuses -> hero. `void` is the exit (danger). No `submitted` step: there is no submittedAt (L10). */
const TRADE_HERO: Record<string, { kind: StatusIconKind; tone: Tone }> = {
  draft: { kind: 'draft', tone: 'info' },
  confirmed: { kind: 'ready', tone: 'success' },
  dispatched: { kind: 'dispatched', tone: 'progress' },
  received: { kind: 'received', tone: 'success' },
  void: { kind: 'void', tone: 'danger' },
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
  const detail = await orderDetail(actor, id);
  if (!detail) notFound();
  const { order, lines, treatment, sellingStore, receivingStore } = detail;
  // T-435 / bible row 353 - the buyer's credit limit is shown only to someone who can approve_buyer or override_credit_limit at
  // THIS order's store. For everyone else it is dropped here, before anything below can print it.
  const limitVisible = await canSeeCreditLimit(actor, detail.order.storeId);
  const customer = limitVisible ? detail.customer : { ...detail.customer, creditLimit: null };

  const isInternal = treatment === 'internal';
  const canDispatch = order.status === 'draft' || order.status === 'confirmed';
  const canReceive = order.status === 'dispatched';
  // ⛔ Void after receipt on an INTERNAL transfer needs a two-store reverse-transfer that is not
  // built (T-165) — the domain refuses it, so the button is not offered. A received SALE may
  // still be voided: AR unwinds the charge and the stock comes back.
  const canVoid = order.status !== 'void' && !(order.status === 'received' && isInternal);
  // T-371 C4 — stored figures re-minted and summed/compared in scaled bigint, never as floats.
  const goods = add(...lines.map((l) => money(l.lineTotal)));
  const hero = TRADE_HERO[order.status];
  if (!hero) throw new Error(`TradeOrderPage: no hero for status ${order.status}`);
  const heroStep =
    order.status === 'void'
      ? exitStepFromTimestamps('trade', { dispatchedAt: order.dispatchedAt, receivedAt: order.receivedAt }, simpleStepIndexFor('trade', 'void'))
      : simpleStepIndexFor('trade', order.status);
  const heroLine = (() => {
    switch (order.status) {
      case 'draft':
        return 'Check the lines, then dispatch the order.';
      case 'confirmed':
        return 'Confirmed. Dispatch the order when the goods leave.';
      case 'dispatched':
        return isInternal ? 'On its way. The receiving store signs for what landed.' : 'Dispatched. Record who signed for the goods.';
      case 'received':
        return 'Received. This order is complete.';
      default:
        return 'This order was voided. The posting, if any, was reversed.';
    }
  })();
  const fees = add(money(order.deliveryFee), money(order.otherFees));

  // T-433. Pay at the door, and the credit-limit warning BEFORE the button is pressed (the server still decides).
  const payAtDispatch = canDispatch && !isInternal;
  const accounts = payAtDispatch ? await storeMoneyAccounts(actor.orgId, order.storeId) : [];
  const preview =
    payAtDispatch && customer.creditLimit !== null
      ? await creditPreview(actor, { customerId: customer.id, storeId: order.storeId, total: order.totalAmount })
      : null;
  const isSale = (order.status === 'dispatched' || order.status === 'received') && !isInternal;

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
          {order.orderDate} · {peso(order.totalAmount)}
          {order.referenceNo && <> · ref {order.referenceNo}</>}
        </PageDescription>
        <p className={`mt-1 text-xs ${TREATMENT_TONE[treatment] ?? ''}`}>
          {customer.name} · {TREATMENT_LABEL[treatment]}
        </p>
      </div>

      <FlashBanner flash={sp} />

      <StatusHero kind={hero.kind} word={statusLabel(order.status)} step={heroStep} steps={tradeOrderSteps} line={heroLine} tone={hero.tone}>
        {canDispatch && (
          <form
            action={dispatchOrderAction}
            className="flex flex-wrap items-end gap-3"
          >
            <input type="hidden" name="orderId" value={order.id} />
            {preview?.over && (
              <p role="alert" className="w-full rounded-md border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-100">
                Owes {peso(preview.owed)}. This order takes them to {peso(preview.after)} against a {peso(preview.limit ?? '0')} limit.
                Dispatch is refused unless a manager says why below, or they pay enough now to stay within the limit.
              </p>
            )}
            {payAtDispatch && (
              <fieldset className="flex w-full flex-wrap items-end gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
                <legend className="px-1 text-xs text-neutral-500 dark:text-neutral-400">Paid on the spot? (optional)</legend>
                <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                  Paid now (₱)
                  <Input name="payNowAmount" inputMode="decimal" placeholder="0.00" className="w-32 text-right tabular-nums" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                  Into account
                  <Select name="moneyAccountId" defaultValue="">
                    <option value="">Choose…</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.custodian})
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                  Proof of payment (required for GCash or bank)
                  <PhotoInput name="receiptPhoto" className="text-sm" />
                </label>
              </fieldset>
            )}
            {!isInternal && customer.creditLimit !== null && (
              <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                Reason to exceed the {peso(customer.creditLimit)} limit (only if it does)
                <Input name="creditOverrideReason" placeholder="say why, on the record" className="w-full" />
              </label>
            )}
            <Button type="submit" variant="primary">
              Dispatch
            </Button>
          </form>
        )}
        {canReceive && (
          <Button type="submit" form="receive-trade-order-form" variant="primary">
            Receive
          </Button>
        )}
      </StatusHero>

      {/*
        ⭐ For a DISPATCHED internal transfer this table is also the receive form: what the branch
        signed for, per line. THREE quantities (T-172) — ordered, packed, signed for — and the gap
        between the last two becomes a transit discrepancy (T-174) the commissary must dispose of.
      */}
      <form id="receive-trade-order-form" action={receiveOrderAction} className="space-y-4">
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
                  <LinkRow key={l.id} className="border-b border-neutral-100 align-top last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <RowLink href={`/items/${l.itemId}`}>
                        {l.itemName}
                      </RowLink>
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
                          <RowAction>
                            <div className="flex flex-col items-end gap-1">
                              <input type="hidden" name="lineId" value={l.id} />
                              <Input
                                name="receivedQuantity"
                                inputMode="decimal"
                                defaultValue={packed}
                                className="w-24 text-right tabular-nums"
                              />
                              <Select name="shortageReason" className="text-xs" defaultValue="">
                                <option value="">If short: why?</option>
                                {SHORTAGE_REASONS.map((r) => (
                                  <option key={r} value={r}>
                                    {REASON_LABEL[r] ?? r}
                                  </option>
                                ))}
                              </Select>
                            </div>
                          </RowAction>
                        ) : (
                          (l.receivedQuantity ?? '—')
                        )}
                      </td>
                    )}
                  </LinkRow>
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
              <Input name="receivedOn" type="date" defaultValue={today()} />
            </label>
          </div>
        )}
      </form>

      {order.notes && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="text-xs uppercase tracking-wide text-neutral-400">Notes</span> · {order.notes}
        </p>
      )}

      {canDispatch && (
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Dispatch</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {isInternal
              ? 'The goods leave the commissary: its stock is relieved into in-transit at real FIFO cost. No revenue, no receivable — a branch is not a customer of its own company.'
              : 'The billing event: the receivable is raised against the customer, wholesale revenue is recognised, and stock is relieved with cost of sales — one act, idempotent.'}
          </p>
        </div>
      )}

      {isSale && (
        <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">Delivery receipt</h2>
            <Link href={`/trade/orders/${order.id}/print`} className={ACTION_LINK}>
              Print delivery receipt
            </Link>
          </div>
          <form action={setBirInvoiceNoAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="orderId" value={order.id} />
            <label className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
              BIR invoice no. (booklet)
              <Input name="birInvoiceNo" defaultValue={order.birInvoiceNo ?? ''} placeholder="from the pre-printed booklet" className="w-56" />
            </label>
            <Button type="submit">Save invoice no.</Button>
          </form>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            The official invoice is the booklet you already use; this only notes its number so it prints on the receipt. Leave it blank and save to clear it.
          </p>
        </div>
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
            <Input name="reason" required placeholder="reason" className="w-full" />
          </label>
          <ConfirmDestructive
            tier="admin-pin"
            label="Void trade order"
            consequence="Voids this order and reverses any posting. An administrator must approve with their own PIN."
          />
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
