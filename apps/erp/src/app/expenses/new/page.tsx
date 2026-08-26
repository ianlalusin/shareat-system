import { toBusinessDate } from '@shareat/core/datetime';
import { listStores, listCategoriesGrouped, PAYMENT_ROWS } from '../lib';
import { requireSession } from '../../../lib/session';
import { createExpenseAction } from '../actions';

export const metadata = { title: 'New expense — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}


export default async function NewExpensePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  const { actor } = await requireSession('/expenses/new');
  const orgId = actor.orgId;

  const [storeRows, categories] = await Promise.all([listStores(orgId), listCategoriesGrouped(orgId)]);
  const storeId = sp.store && storeRows.some((s) => s.id === sp.store) ? sp.store : (storeRows[0]?.id ?? '');

  const groups: Array<'COGS' | 'OPEX' | 'PERSONAL' | 'CAPEX'> = ['COGS', 'OPEX', 'PERSONAL', 'CAPEX'];

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">New expense</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Saved as a draft first. Nothing posts to the ledger until it is approved (and it
          needs a receipt photo to be approvable — invariant 11, DEF-055).
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {decodeURIComponent(sp.error)}
        </div>
      )}

      {!storeId ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          This org needs at least one store before an expense can be created. Go back to the{' '}
          <a className="underline" href="/expenses">expenses list</a>.
        </div>
      ) : (
        <form action={createExpenseAction} className="space-y-6">
          {/* ⭐ No orgId, no "acting as" — the session supplies both (T-138). */}
          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
              <select
                name="storeId"
                defaultValue={storeId}
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              >
                {storeRows.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </label>


            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Business date</span>
              <input
                type="date"
                name="businessDate"
                defaultValue={toBusinessDate()}
                required
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Category</span>
              <select
                name="categoryId"
                required
                defaultValue=""
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="" disabled>
                  Select a category
                </option>
                {groups.map((g) => {
                  const rows = categories.filter((c) => c.group === g);
                  if (rows.length === 0) return null;
                  return (
                    <optgroup key={g} label={g}>
                      {rows.map((c) => (
                        <option key={c.id} value={c.id} disabled={!c.accountCode}>
                          {c.category}
                          {!c.accountCode ? ' (unmapped — cannot post)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Particulars — what this was actually for</span>
            <input
              type="text"
              name="particulars"
              required
              className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Receipt photo URL <span className="italic">(required before it can post)</span>
              </span>
              <input
                type="text"
                name="receiptPhotoUrl"
                placeholder="https://…"
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Supplier <span className="italic">(only for a "credit" payment row below)</span>
              </span>
              <input
                type="text"
                name="supplierId"
                placeholder="Supplier reference"
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
          </div>

          <div>
            <h2 className="mb-2 text-sm font-medium">
              Payments — fill in as many rows as needed. A split expense posts as ONE
              entry with one credit line per row (invariant 2).
            </h2>
            <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                    <th className="px-3 py-2 font-medium">Method</th>
                    <th className="px-3 py-2 font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">Staff (reimbursable)</th>
                    <th className="px-3 py-2 font-medium">Cash request (optional)</th>
                    <th className="px-3 py-2 font-medium">Office drawer</th>
                  </tr>
                </thead>
                <tbody>
                  {PAYMENT_ROWS.map((i) => (
                    <tr key={i} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                      <td className="px-3 py-2">
                        <select
                          name={`method_${i}`}
                          defaultValue=""
                          className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                        >
                          <option value="">— not used —</option>
                          <option value="cash">Cash</option>
                          <option value="online">Online / e-wallet</option>
                          <option value="credit">Credit (AP)</option>
                          <option value="reimbursable">Reimbursable (staff paid)</option>
                          <option value="other">Other (DEF-054 — blocks posting)</option>
                          <option value="ar_collection">AR collection (DEF-054 — blocks posting)</option>
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          name={`amount_${i}`}
                          placeholder="0.00"
                          className="w-28 rounded border border-neutral-300 bg-white px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-950"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          name={`staffId_${i}`}
                          placeholder="Staff person id"
                          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          name={`cashRequestId_${i}`}
                          placeholder="cash_request id"
                          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input type="checkbox" name={`office_${i}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Save draft
          </button>
        </form>
      )}
    </main>
  );
}
