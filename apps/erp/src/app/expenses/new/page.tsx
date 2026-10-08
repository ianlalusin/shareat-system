import { listStores, listActiveCategoriesGrouped } from '../lib';
import { loadMoneyLines } from '@/lib/money-lines/load';
import { MoneyLines } from '@/components/money/MoneyLines';
import { listOpenInvoicesForPicker, peso } from '../../ap/lib';
import { requireSession } from '../../../lib/session';
import { createExpenseAction } from '../actions';
import { budgetsRepo } from '@shareat/db';
import { withOrgPrincipal } from '../lib';
import { BudgetHint } from './BudgetHint';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { FormGrid } from '@/components/ui';

export const metadata = { title: 'New expense — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}


export default async function NewExpensePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);

  const { actor } = await requireSession('/expenses/new');
  const orgId = actor.orgId;

  const [storeRows, categories, invoices] = await Promise.all([
    listStores(orgId),
    listActiveCategoriesGrouped(orgId),
    listOpenInvoicesForPicker(orgId),
  ]);
  const storeId = sp.store && storeRows.some((s) => s.id === sp.store) ? sp.store : (storeRows[0]?.id ?? '');

  // ⭐ T-266 — accounts with their LEDGER balances plus every open float at this store, flattened
  // into one list. Scoped to the store (DEF-291); the picker used to offer every account in the
  // org to everyone.
  const moneyLines = await loadMoneyLines(orgId, storeId, actor);

  // T-215 §5 — the caps for THIS store and THIS period, so the person spending sees what is left
  // before they commit. ⚠️ Read only: `manage_expense_budgets` is needed to SET a cap and must not
  // be needed to SEE one, or the number is hidden from the only person it is for.
  const periodKey = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7).replace('-', '');
  const caps = storeId
    ? await withOrgPrincipal(orgId, (tx) => budgetsRepo.listForStorePeriod(tx, orgId, storeId, periodKey))
    : [];

  const groups: Array<'COGS' | 'OPEX' | 'PERSONAL' | 'CAPEX'> = ['COGS', 'OPEX', 'PERSONAL', 'CAPEX'];

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">New expense</h1>
        <PageDescription>
          Saves as a <strong>draft</strong> against the supplier invoice you pick — verified or
          still pending. No manager and no verification wait: verifying the invoice later posts
          this automatically, or approve it yourself from the expense once you can (T-196). No
          invoice to pick from?{' '}
          <a href="/ap" className="underline">Log one first</a>.
        </PageDescription>
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
          {/* ⭐ T-215. The cap matters at the moment of spending — a report at month end is a
              post-mortem. Renders nothing until a capped category is picked. */}
          {caps.length > 0 && (
            <BudgetHint
              periodKey={periodKey}
              caps={caps.map((c) => ({
                categoryId: c.categoryId,
                label: c.categoryLabel,
                amount: c.amount,
                consumed: c.consumed,
                remaining: c.remaining,
              }))}
            />
          )}
          {/* ⭐ No orgId, no "acting as" — the session supplies both (T-138). */}
          <FormGrid>
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
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                Supplier invoice <span className="italic">(sets the date and the supplier)</span>
              </span>
              <select
                name="supplierInvoiceId"
                required
                defaultValue=""
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              >
                <option value="" disabled>
                  {invoices.length === 0 ? 'No open invoices yet' : 'Select…'}
                </option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.supplierName} — {inv.invoiceNo ?? inv.id.slice(0, 8)} ({inv.invoiceDate}) — {peso(inv.remaining)} left
                    {inv.status === 'pending' ? ' — pending' : ' — verified'}
                  </option>
                ))}
              </select>
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
          </FormGrid>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Particulars — what this was actually for</span>
            <input
              type="text"
              name="particulars"
              required
              className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>

          <div>
            <h2 className="mb-2 text-sm font-medium">
              Payments — add a line for each place the money came from. A split expense posts as
              ONE entry with one credit line per row (invariant 2).
            </h2>
            <MoneyLines
              direction="out"
              sources={moneyLines.sources}
              otherStoreSources={moneyLines.otherStoreSources}
              storeNames={moneyLines.storeNames}
              staff={moneyLines.staff}
              supplierId={null}
              supplierCreditTermsDays={null}
            />
          </div>

          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            Save draft
          </button>
        </form>
      )}
    </Page>
  );
}
