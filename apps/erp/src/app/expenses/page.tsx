import { expensesRepo } from '@shareat/db';
import { formatMoney, money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores, listCategoriesGrouped, withOrgPrincipal } from './lib';
import { requireSession } from '../../lib/session';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Button, Select } from '@/components/ui';

export const metadata = { title: 'Expenses — Shareat System' };

// Always dynamic — same reasoning as apps/erp/src/app/reports/trial-balance/page.tsx:
// this reads searchParams and the database on every request, nothing is cached.
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  status?: string;
}

export default async function ExpensesListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  // ⭐ The org comes from the SESSION (T-138), never the URL — a person cannot reach another
  // org's spend by editing a query string, and RLS refuses them underneath in any case.
  const { actor } = await requireSession('/expenses');
  const orgId = actor.orgId;

  const [storeRows, categories] = await Promise.all([listStores(orgId), listCategoriesGrouped(orgId)]);
  const storeId = sp.store && storeRows.some((s) => s.id === sp.store) ? sp.store : undefined;

  const status = sp.status === 'draft' || sp.status === 'posted' || sp.status === 'voided' ? sp.status : undefined;

  const categoryLabelById = new Map(categories.map((c) => [c.id, `${c.group} — ${c.category}`]));
  const storeById = new Map(storeRows.map((s) => [s.id, s]));

  const expenses = await withOrgPrincipal(orgId, (tx) =>
    expensesRepo.listExpenses(tx, { orgId, storeId, status, limit: 100 }),
  );

  const qs = new URLSearchParams();
  if (storeId) qs.set('store', storeId);
  const carry = qs.toString();

  return (
    <Page density="table">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Expenses</h1>
          <PageDescription>
            Non-inventory spend — create · approve · void, posted through the real ledger
            (docs/tasks/122-expenses.md).
          </PageDescription>
        </div>
        <a
          href={`/expenses/new?${carry}`}
          className="inline-flex min-h-11 items-center rounded-[12px] border border-surface-border bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas"
        >
          New expense
        </a>
      </div>

      <form
        method="GET"
        action="/expenses"
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId ?? ''}>
            <option value="">All stores</option>
            {storeRows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Status</span>
          <Select name="status" defaultValue={status ?? ''}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="posted">Posted</option>
            <option value="voided">Voided</option>
          </Select>
        </label>

        <Button type="submit" variant="primary">
          Apply
        </Button>
      </form>

      {expenses.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          No expenses match this filter.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Store</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Particulars</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="px-3 py-2 font-mono text-neutral-500 dark:text-neutral-400">{e.businessDate}</td>
                  <td className="px-3 py-2">{storeById.get(e.storeId)?.code ?? e.storeId}</td>
                  <td className="px-3 py-2">{categoryLabelById.get(e.categoryId) ?? e.categoryId}</td>
                  <td className="px-3 py-2">
                    <a href={`/expenses/${e.id}?${carry}`} className="underline hover:no-underline">
                      {e.particulars}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(money(e.totalAmount))}</td>
                  <td className="px-3 py-2">
                    <Badge status={e.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        {toBusinessDate()} today (Asia/Manila)
      </p>
    </Page>
  );
}
