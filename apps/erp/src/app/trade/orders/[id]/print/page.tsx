import Link from 'next/link';
import { notFound } from 'next/navigation';
import { add, compare, money, ZERO } from '@shareat/core/money';
import { requireSession } from '../../../../../lib/session';
import { deliveryReceiptData, peso } from '../../lib';
import { ACTION_LINK } from '@/components/action-link';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Delivery receipt — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-433 S2. The paper a driver hands over with the goods: what was delivered, what was paid on this order, what is still
 * due on it, and the buyer's whole account.
 *
 * ⛔ It is titled "Delivery receipt" and says in its footer that it is not an official receipt or a sales invoice. The
 * official invoice is the BIR booklet the business already uses (bible row 75: this system never issues one); the booklet's
 * number, when someone noted it, is printed here for reference only.
 *
 * Anyone without `approve_buyer` or `record_ar_collection` at the order's store, a draft or void order and a branch
 * transfer all get the same 404 (`deliveryReceiptData` returns null for each).
 */
export default async function DeliveryReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor } = await requireSession(`/trade/orders/${id}/print`);
  const data = await deliveryReceiptData(actor, id);
  if (!data) notFound();
  const { detail, paid, balanceDue, accountBalance, printedAt } = data;
  const { order, lines, customer, sellingStore } = detail;
  const goods = add(...lines.map((l) => money(l.lineTotal)));
  const asOf = printedAt.toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Page density="table">
      <style>{`
        @media print {
          nav, header, aside, footer, .no-print { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          @page { size: A4; margin: 14mm; }
        }
      `}</style>

      <div className="no-print">
        <Link href={`/trade/orders/${order.id}`} className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}>
          ← Back to the order
        </Link>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">Print this page (Ctrl+P). Navigation is hidden on paper.</p>
      </div>

      <article className="space-y-4 text-sm">
        <div>
          <h1 className="text-xl font-semibold">Delivery receipt</h1>
          <p>{sellingStore?.name ?? ''}</p>
        </div>

        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <dt className="text-neutral-500">Delivered to</dt>
          <dd className="font-medium">{customer.name}</dd>
          <dt className="text-neutral-500">Date</dt>
          <dd>{order.orderDate}</dd>
          {order.referenceNo && (
            <>
              <dt className="text-neutral-500">Reference</dt>
              <dd>{order.referenceNo}</dd>
            </>
          )}
          {order.birInvoiceNo && (
            <>
              <dt className="text-neutral-500">BIR invoice no.</dt>
              <dd className="font-mono">{order.birInvoiceNo}</dd>
            </>
          )}
        </dl>

        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-neutral-400 text-left">
              <th className="py-1 pr-2">Item</th>
              <th className="py-1 pr-2 text-right">Qty</th>
              <th className="py-1 pr-2">Unit</th>
              <th className="py-1 pr-2 text-right">Unit price</th>
              <th className="py-1 text-right">Line total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className="border-b border-neutral-300">
                <td className="py-1 pr-2">{l.itemName}</td>
                <td className="py-1 pr-2 text-right tabular-nums">{l.quantity}</td>
                <td className="py-1 pr-2">{l.unit}</td>
                <td className="py-1 pr-2 text-right font-mono tabular-nums">{peso(l.rate)}</td>
                <td className="py-1 text-right font-mono tabular-nums">{peso(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1">
          <dt>Goods</dt>
          <dd className="text-right font-mono tabular-nums">{peso(goods)}</dd>
          {compare(money(order.deliveryFee), ZERO) > 0 && (
            <>
              <dt>Delivery fee</dt>
              <dd className="text-right font-mono tabular-nums">{peso(order.deliveryFee)}</dd>
            </>
          )}
          {compare(money(order.otherFees), ZERO) > 0 && (
            <>
              <dt>Other fees</dt>
              <dd className="text-right font-mono tabular-nums">{peso(order.otherFees)}</dd>
            </>
          )}
          <dt className="font-semibold">Total</dt>
          <dd className="text-right font-mono font-semibold tabular-nums">{peso(order.totalAmount)}</dd>
          <dt>Paid on this order</dt>
          <dd className="text-right font-mono tabular-nums">{peso(paid)}</dd>
          <dt className="font-semibold">Balance due on this order</dt>
          <dd className="text-right font-mono font-semibold tabular-nums">{peso(balanceDue)}</dd>
          <dt className="pt-2 text-neutral-600">Account balance (all orders), as of {asOf}</dt>
          <dd className="pt-2 text-right font-mono tabular-nums">{peso(accountBalance)}</dd>
        </dl>

        <p className="border-t border-neutral-300 pt-2 text-xs text-neutral-600">
          This is not an official receipt or sales invoice.
        </p>
      </article>
    </Page>
  );
}
