import Link from 'next/link';
import { notFound } from 'next/navigation';
import { asc, eq, inArray } from 'drizzle-orm';
import { lowStockRepo, schema, transaction } from '@shareat/db';
import { postMessageAction } from './actions';
import { requireSession } from '../../../../lib/session';

export const metadata = { title: 'Branch order — Shareat System' };
export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  confirmed: 'Submitted',
  dispatched: 'In transit',
  received: 'Received',
  void: 'Void',
};

export default async function BranchOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  await requireSession(`/commissary/orders/${id}`);

  const { order, messages, authors } = await transaction(async (tx) => {
    const detail = await lowStockRepo.branchOrderDetail(tx, id);
    if (!detail) return { order: null, messages: [], authors: new Map<string, string>() };
    const thread = await lowStockRepo.listMessages(tx, id);
    const ids = [...new Set(thread.map((m) => m.authorId))];
    const people = ids.length
      ? await tx
          .select({ id: schema.persons.id, name: schema.persons.displayName })
          .from(schema.persons)
          .where(inArray(schema.persons.id, ids))
          .orderBy(asc(schema.persons.displayName))
      : [];
    return { order: detail, messages: thread, authors: new Map(people.map((p) => [p.id, p.name])) };
  });

  if (!order) notFound();

  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href="/commissary/orders" className="text-sm underline underline-offset-4">
        ← Branch orders
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">
        {order.commissaryName} → {order.branchName ?? '—'}
      </h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        {order.orderDate} · {STATUS_LABEL[order.status] ?? order.status} · ₱{order.totalAmount}
      </p>

      <table className="mt-6 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 text-right font-medium">Asked</th>
            <th className="py-2 pr-4 text-right font-medium">Packed</th>
            <th className="py-2 pr-4 text-right font-medium">Signed for</th>
            <th className="py-2 pr-4 text-right font-medium">Rate</th>
            <th className="py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <tr key={l.id} className="border-b border-neutral-200 dark:border-neutral-800">
              <td className="py-2 pr-4">
                <span className="font-medium">{l.itemName}</span>
                {/* ⭐ A commissary ADDITION is a substitution, and it needs the branch's answer
                    before the order can move. Shown because the branch has to act on it. */}
                {l.origin === 'commissary_added' && (
                  <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                    added by commissary · {l.approval}
                  </span>
                )}
                {l.suggested && (
                  <span className="ml-2 text-xs text-neutral-500">auto-suggested {l.suggested}</span>
                )}
              </td>
              {/*
                ⭐ THREE quantities, and collapsing any two loses the story: what the branch ASKED
                for, what the commissary PACKED, and what the branch SIGNED FOR. The gap between
                the first two is a fulfilment decision; between the last two, a discrepancy.
              */}
              <td className="py-2 pr-4 text-right tabular-nums">{l.requested ?? '—'}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{l.fulfilled ?? '—'}</td>
              <td className="py-2 pr-4 text-right tabular-nums">{l.received ?? '—'}</td>
              <td className="py-2 pr-4 text-right tabular-nums">₱{l.rate}</td>
              <td className="py-2 text-right tabular-nums">₱{l.lineTotal}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 className="mt-10 text-lg font-medium">Thread</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Append-only. In v1 this was a phone call, so the reason a line changed did not survive the
        people who changed it.
      </p>

      {sp.error && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}

      <ul className="mt-4 space-y-3">
        {messages.length === 0 && (
          <li className="text-sm text-neutral-500">Nothing said about this order yet.</li>
        )}
        {messages.map((m) => (
          <li key={m.id} className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <div className="text-xs text-neutral-500">
              {authors.get(m.authorId) ?? 'Someone'} · {new Date(m.createdAt).toLocaleString('en-PH')}
            </div>
            <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ul>

      <form action={postMessageAction} className="mt-4 flex gap-2">
        <input type="hidden" name="orderId" value={order.id} />
        <input
          name="body"
          placeholder="Say something about this order…"
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Post
        </button>
      </form>
    </main>
  );
}
