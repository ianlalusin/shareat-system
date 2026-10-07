import { requirePageAccess } from '../../../lib/page-access';
import {
  createCategoryAction,
  renameCategoryAction,
  setCategoryAccountAction,
  setCategoryActiveAction,
} from './actions';
import { categoriesForAdmin, mappableAccounts } from './lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Expense categories — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  ok?: string;
  error?: string;
}

/**
 * `/settings/expense-categories`. T-229 slice 1 — **DEF-193's remedy.**
 *
 * ⭐ The screen exists because a detector had nowhere to send anyone. T-213's
 * `expenseCategoryUnpostable` reports a draft expense stuck behind a category with no mapped
 * account and ends *"cannot post until one is"* — and until today the only writer
 * `expense_categories` had ever had was its seed file, so the instruction named an action nobody
 * could take.
 *
 * ⭐ **Unmapped rows sort first and say what they are holding up.** A list ordered by name would
 * bury the two rows that need a decision among thirty-eight that do not.
 *
 * ⛔ **Mapping only — no create, no rename, no retire.** Those wait for slice 2's migration,
 * because `unique (org_id, category)` is case- and whitespace-sensitive today and bible §4.4
 * rule 3 wants `lower(trim(...))`. Shipping creation first would re-open the duplicated-Rent
 * defect that rule exists to close.
 */
export default async function ExpenseCategoriesSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/settings/expense-categories');
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const [categories, accounts] = await Promise.all([
    categoriesForAdmin(actor.orgId),
    mappableAccounts(actor.orgId),
  ]);

  const unmapped = categories.filter((c) => c.accountCode === null);
  const blockedTotal = unmapped.reduce((n, c) => n + c.blockedDraftCount, 0);

  return (
    <Page density="table">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className="underline">
            Settings
          </a>{' '}
          / Expense categories
        </p>
        <h1 className="text-2xl font-semibold">Expense categories</h1>
        <PageDescription>
          Which account each kind of spend debits. A category with{' '}
          <strong>no account mapped blocks posting</strong> rather than guessing — nothing here
          ever falls back to a catch-all account, so an unmapped category is a decision waiting,
          not a default.
        </PageDescription>
      </div>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

      <p className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        {unmapped.length === 0 ? (
          <>
            All {categories.length} categories are mapped. Nothing is blocked on this screen.
          </>
        ) : (
          <>
            <strong>
              {unmapped.length} of {categories.length}
            </strong>{' '}
            {unmapped.length === 1 ? 'category has' : 'categories have'} no account, holding up{' '}
            <strong>{blockedTotal}</strong> draft {blockedTotal === 1 ? 'expense' : 'expenses'}.
            They are listed first.
          </>
        )}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left dark:border-neutral-800">
              <th className="py-2 pr-3 font-medium">Category</th>
              <th className="py-2 pr-3 font-medium">Group</th>
              <th className="py-2 pr-3 font-medium">Blocking</th>
              <th className="py-2 font-medium">Posts to</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => {
              const isUnmapped = c.accountCode === null;
              return (
                <tr
                  key={c.id}
                  className={`border-b border-neutral-100 align-middle dark:border-neutral-900 ${
                    !c.isActive ? 'opacity-60' : isUnmapped ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
                  }`}
                >
                  <td className="py-2 pr-3">
                    {/* ⛔ A SEEDED row cannot be renamed — the seed owns its name (bible §4.4
                        rule 5), and renaming it here would have the next seed re-create the
                        original beside it. It can still be retired, which is rule 2's own wording
                        and what makes a 38-row seed survivable for a business that uses 20. */}
                    {c.isSystem ? (
                      c.category
                    ) : (
                      <form action={renameCategoryAction} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="categoryId" value={c.id} />
                        <input
                          name="category"
                          defaultValue={c.category}
                          required
                          aria-label={`Name of ${c.category}`}
                          className={`${FIELD} w-44 py-1`}
                        />
                        <button type="submit" className={ACTION_LINK}>
                          Rename
                        </button>
                      </form>
                    )}
                    {isUnmapped && (
                      <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
                        unmapped
                      </span>
                    )}
                    {c.isSystem && (
                      <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                        seeded
                      </span>
                    )}
                    {!c.isActive && (
                      <span className="ml-2 rounded bg-neutral-200 px-1.5 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                        retired
                      </span>
                    )}
                    <form action={setCategoryActiveAction} className="mt-1">
                      <input type="hidden" name="categoryId" value={c.id} />
                      <input type="hidden" name="categoryLabel" value={c.category} />
                      <input type="hidden" name="isActive" value={c.isActive ? 'false' : 'true'} />
                      <button
                        type="submit"
                        className={`${ACTION_LINK} text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200`}
                      >
                        {c.isActive ? 'Retire' : 'Reinstate'}
                      </button>
                    </form>
                  </td>
                  <td className="py-2 pr-3 text-neutral-500 dark:text-neutral-400">{c.group}</td>
                  <td className="py-2 pr-3 text-neutral-500 dark:text-neutral-400">
                    {c.blockedDraftCount === 0 ? (
                      '—'
                    ) : (
                      <span className="font-medium text-amber-800 dark:text-amber-300">
                        {c.blockedDraftCount} draft{c.blockedDraftCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    <form action={setCategoryAccountAction} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="categoryId" value={c.id} />
                      <input type="hidden" name="categoryLabel" value={c.category} />
                      <select
                        name="accountCode"
                        defaultValue={c.accountCode ?? ''}
                        className={`${FIELD} max-w-[22rem]`}
                        aria-label={`Account for ${c.category}`}
                      >
                        {/* ⭐ A real choice, not a placeholder: picking it CLEARS the mapping.
                            `account_code` is nullable on purpose so a wrong mapping is
                            removable — a wrong account posts silently, an absent one refuses. */}
                        <option value="">— none (blocks posting) —</option>
                        {accounts.map((a) => (
                          <option key={a.code} value={a.code}>
                            {a.code} · {a.name}
                          </option>
                        ))}
                      </select>
                      <button type="submit" className={BTN}>
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ⭐ T-229 slice 2. The database change this paragraph used to promise is migration 0134:
          uniqueness moved to `lower(trim(category))`, so a hand-typed name can no longer collide
          with a seeded one by case or spacing — bible §4.4 rule 3, DEF-205. */}
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Add a category</h2>
        <form action={createCategoryAction} className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-neutral-600 dark:text-neutral-400">Name</span>
            <input name="category" required placeholder="Scooter rental" className={`${FIELD} w-56`} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-600 dark:text-neutral-400">Group</span>
            <select name="group" defaultValue="OPEX" className={FIELD}>
              <option value="OPEX">OPEX — running cost</option>
              <option value="COGS">COGS — cost of goods sold</option>
              <option value="CAPEX">CAPEX — equipment</option>
              <option value="PERSONAL">PERSONAL — owner&apos;s drawings</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-neutral-600 dark:text-neutral-400">Posts to</span>
            <select name="accountCode" defaultValue="" className={`${FIELD} max-w-[22rem]`}>
              <option value="">— none (blocks posting) —</option>
              {accounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} · {a.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={BTN}>
            Add category
          </button>
        </form>
        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          Names are compared ignoring case and spacing, so <code>Rent</code> and{' '}
          <code>rent&nbsp;</code> are the same category and the second is refused by the database.
          A category is <strong>retired, never deleted</strong> — everything already recorded in it
          keeps working.
        </p>
      </section>

      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Stuck drafts appear on{' '}
        <a href="/findings" className="underline">
          /findings
        </a>{' '}
        once they are three days old.
      </p>
    </Page>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const FIELD =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
