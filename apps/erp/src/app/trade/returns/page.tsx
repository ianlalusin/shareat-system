import Link from 'next/link';
import { and, desc, eq, sql as dsql } from 'drizzle-orm';
import { schema } from '@shareat/db';
import { customerCreditBalance } from '@shareat/domain';
import { listStores } from '../../inventory/lib';
import { recordReturnAction, voidReturnAction } from './actions';
import { requireSession } from '../../../lib/session';
import { withOrgPrincipal } from '../../expenses/lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'Customer returns — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
}

export default async function CustomerReturnsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor } = await requireSession('/trade/returns');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Customer returns</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { returnableLines, customers, credits, recent, moneyAccountId } = await withOrgPrincipal(actor.orgId, async (tx) => {
    // ⭐ Returnable = sold − already returned (posted only) — invariant 1's cap. Internal orders
    // cap at receivedQuantity (what the branch actually signed for, T-165's confirmReceipt);
    // external orders have no separate per-line receiving step from our side, so the cap is what
    // was fulfilled/sold.
    const lines = await tx.execute(dsql`
      select ol.id as line_id, o.id as order_id, o.customer_id, c.name as customer_name,
             c.counterparty_store_id, i.id as item_id, i.name as item_name, i.base_unit,
             ol.quantity, ol.rate, ol.fulfilled_quantity, ol.received_quantity,
             coalesce((
               select sum(rl.quantity) from customer_return_lines rl
               join customer_returns r on r.id = rl.return_id
               where rl.trade_order_line_id = ol.id and r.status = 'posted'
             ), 0) as already_returned
      from trade_order_lines ol
      join trade_orders o on o.id = ol.order_id
      join customers c on c.id = o.customer_id
      join items i on i.id = ol.item_id
      where o.store_id = ${storeId} and o.status in ('dispatched', 'received')
      order by o.order_date desc
    `) as unknown as {
      line_id: string; order_id: string; customer_id: string; customer_name: string;
      counterparty_store_id: string | null; item_id: string; item_name: string; base_unit: string;
      quantity: string; rate: string; fulfilled_quantity: string | null; received_quantity: string | null;
      already_returned: string;
    }[];

    const returnable = lines
      .map((l) => {
        const basis = l.counterparty_store_id
          ? Number(l.received_quantity ?? 0)
          : Number(l.fulfilled_quantity ?? l.quantity);
        const cap = (basis - Number(l.already_returned)).toFixed(3);
        return { ...l, cap, isInternal: l.counterparty_store_id !== null };
      })
      .filter((l) => Number(l.cap) > 0);

    const customerRows = await tx
      .select({ id: schema.customers.id, name: schema.customers.name })
      .from(schema.customers)
      .where(eq(schema.customers.orgId, actor.orgId));

    const creditByCustomer = new Map<string, string>();
    for (const c of customerRows) {
      const bal = await customerCreditBalance(tx, actor.orgId, c.id);
      if (Number(bal) > 0) creditByCustomer.set(c.id, bal);
    }

    const recentReturns = await tx
      .select({
        id: schema.customerReturns.id,
        status: schema.customerReturns.status,
        treatment: schema.customerReturns.treatment,
        settlement: schema.customerReturns.settlement,
        reason: schema.customerReturns.reason,
        returnedOn: schema.customerReturns.returnedOn,
        customerId: schema.customerReturns.customerId,
      })
      .from(schema.customerReturns)
      .where(eq(schema.customerReturns.storeId, storeId))
      .orderBy(desc(schema.customerReturns.createdAt))
      .limit(15);

    const [money] = await tx
      .select({ id: schema.moneyAccounts.id })
      .from(schema.moneyAccounts)
      .where(and(eq(schema.moneyAccounts.storeId, storeId), eq(schema.moneyAccounts.instrument, 'cash')))
      .limit(1);

    return {
      returnableLines: returnable, customers: customerRows, credits: creditByCustomer,
      recent: recentReturns, moneyAccountId: money?.id,
    };
  });

  const customerName = new Map(customers.map((c) => [c.id, c.name]));

  return (
    <Page density="table" className="">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Customer returns</h1>
        <Link href="/inventory" className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        The goods come back, and the customer holds a credit — or takes cash. ⭐ An internal
        (branch → commissary) return is not a credit at all — T-173 backwards, derived, never a
        choice.
      </p>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 gap-y-2">
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <select
            name="store"
            defaultValue={storeId}
            className="mt-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
          Show
        </button>
      </form>

      {credits.size > 0 && (
        <section className="mt-8 rounded-lg border border-amber-400 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950">
          <h2 className="text-sm font-medium">Spendable customer credit</h2>
          <ul className="mt-2 text-sm">
            {[...credits.entries()].map(([customerId, balance]) => (
              <li key={customerId} className="py-1">
                {customerName.get(customerId) ?? customerId}: ₱{balance}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">
            Applied against a specific trade order below — pick the order to spend it on when
            recording the next one, or use the "Apply credit" action on that order directly.
          </p>
        </section>
      )}

      <h2 className="mt-10 text-lg font-medium">Returnable lines</h2>
      {returnableLines.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          Nothing dispatched at this store has any quantity left to return.
        </p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Customer</th>
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 text-right font-medium">Returnable</th>
              <th className="py-2 font-medium">Record</th>
            </tr>
          </thead>
          <tbody>
            {returnableLines.map((l) => (
              <tr key={l.line_id} className="border-b border-neutral-200 align-top dark:border-neutral-800">
                <td className="py-2 pr-4">
                  {l.customer_name} {l.isInternal && <span className="text-xs text-neutral-500">(internal)</span>}
                </td>
                <td className="py-2 pr-4">
                  {l.item_name} <span className="text-xs text-neutral-500">({l.base_unit})</span>
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{l.cap}</td>
                <td className="py-2">
                  <form action={recordReturnAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="tradeOrderId" value={l.order_id} />
                    <input type="hidden" name="tradeOrderLineId" value={l.line_id} />
                    <input
                      name="quantity"
                      placeholder={`up to ${l.cap}`}
                      inputMode="decimal"
                      required
                      className="w-24 rounded-md border border-neutral-300 px-2 py-1 text-xs tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    <input
                      name="reason"
                      placeholder="reason"
                      required
                      className="w-32 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                    />
                    {!l.isInternal && (
                      <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                        <input type="checkbox" name="saleable" value="false" /> unsellable
                      </label>
                    )}
                    {!l.isInternal && moneyAccountId && (
                      <label className="flex items-center gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                        <input type="checkbox" name="refund" value="true" /> cash refund
                        <input type="hidden" name="moneyAccountId" value={moneyAccountId} />
                      </label>
                    )}
                    <button type="submit" className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
                      Return
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-10 text-lg font-medium">Recent</h2>
      {recent.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No returns recorded yet at this store.</p>
      ) : (
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Date</th>
              <th className="py-2 pr-4 font-medium">Customer</th>
              <th className="py-2 pr-4 font-medium">Treatment</th>
              <th className="py-2 pr-4 font-medium">Settlement</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.id} className="border-b border-neutral-200 dark:border-neutral-800">
                <td className="py-2 pr-4">{r.returnedOn}</td>
                <td className="py-2 pr-4">{customerName.get(r.customerId) ?? r.customerId}</td>
                <td className="py-2 pr-4">{r.treatment}</td>
                <td className="py-2 pr-4">{r.settlement}</td>
                <td className="py-2 pr-4">{r.status}</td>
                <td className="py-2">
                  {r.status === 'posted' && (
                    <form action={voidReturnAction} className="flex items-center gap-1">
                      <input type="hidden" name="returnId" value={r.id} />
                      <input
                        name="reason"
                        placeholder="void reason"
                        required
                        className="w-28 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                      />
                      <button type="submit" className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
                        Void
                      </button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
