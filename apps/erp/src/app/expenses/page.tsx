import { transaction, expensesRepo } from '@shareat/db';
import { formatMoney, money } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { listOrgs, listStores, listActingPersons, listCategoriesGrouped } from './lib';

export const metadata = { title: 'Expenses — Shareat System' };

// Always dynamic — same reasoning as apps/erp/src/app/reports/trial-balance/page.tsx:
// this reads searchParams and the database on every request, nothing is cached.
export const dynamic = 'force-dynamic';

interface SearchParams {
  org?: string;
  store?: string;
  as?: string;
  status?: string;
}

const STATUS_LABEL: Record<string, string> = { draft: 'Draft', posted: 'Posted', voided: 'Voided' };

export default async function ExpensesListPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  const orgs = await listOrgs();
  if (orgs.length === 0) {
    return (
      <main className="mx-auto max-w-5xl space-y-6 p-8">
        <h1 className="text-2xl font-semibold">Expenses</h1>
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          No organization exists in this database yet.
        </div>
      </main>
    );
  }

  const orgId = sp.org && orgs.some((o) => o.id === sp.org) ? sp.org : orgs[0]!.id;
  const currentOrg = orgs.find((o) => o.id === orgId)!;

  const [storeRows, persons, categories] = await Promise.all([
    listStores(orgId),
    listActingPersons(orgId),
    listCategoriesGrouped(orgId),
  ]);

  const storeId = sp.store && storeRows.some((s) => s.id === sp.store) ? sp.store : undefined;

  const actingPersonId =
    sp.as && persons.some((p) => p.id === sp.as)
      ? sp.as
      : (persons.find((p) => p.role === 'manager')?.id ?? persons[0]?.id ?? '');

  const status = sp.status === 'draft' || sp.status === 'posted' || sp.status === 'voided' ? sp.status : undefined;

  const categoryLabelById = new Map(categories.map((c) => [c.id, `${c.group} — ${c.category}`]));
  const storeById = new Map(storeRows.map((s) => [s.id, s]));

  const expenses = await transaction((tx) =>
    expensesRepo.listExpenses(tx, { orgId, storeId, status, limit: 100 }),
  );

  const qs = new URLSearchParams();
  qs.set('org', orgId);
  if (storeId) qs.set('store', storeId);
  if (actingPersonId) qs.set('as', actingPersonId);
  const carry = qs.toString();

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Expenses</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Non-inventory spend — create · approve · void, posted through the real ledger
            (docs/tasks/122-expenses.md).
          </p>
        </div>
        <a
          href={`/expenses/new?${carry}`}
          className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          New expense
        </a>
      </div>

      {!actingPersonId && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          No person with an active role exists in this org yet — nothing can be created,
          approved or voided until one does.
        </div>
      )}

      <form
        method="GET"
        action="/expenses"
        className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Organization</span>
          <select
            name="org"
            defaultValue={orgId}
            className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name} ({o.code})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
          <select
            name="store"
            defaultValue={storeId ?? ''}
            className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">All stores</option>
            {storeRows.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Status</span>
          <select
            name="status"
            defaultValue={status ?? ''}
            className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="posted">Posted</option>
            <option value="voided">Voided</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Acting as <span className="italic">(no login yet — see task report)</span>
          </span>
          <select
            name="as"
            defaultValue={actingPersonId}
            className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
          >
            {persons.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.role})
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="rounded bg-neutral-900 px-4 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Apply
        </button>
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
                    <StatusBadge status={e.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-neutral-400 dark:text-neutral-600">
        {currentOrg.name} · {toBusinessDate()} today (Asia/Manila)
      </p>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'posted'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'voided'
        ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
        : 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}
