import { toBusinessDate } from '@shareat/core/datetime';
import Link from 'next/link';
import { REISSUE_INTERVALS } from '@shareat/db/schema';
import { compare, money, toCentavos, ZERO } from '@shareat/core/money';
import { requireSession } from '../../lib/session';
import { removeBudgetAction, setBudgetAction } from './actions';
import {
  INTERVAL_LABEL,
  currentPeriodKey,
  listBudgets,
  listStores,
  listUncapped,
  periodLabel,
  periodOptions,
  peso,
} from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { typedFor, type TypedView } from '@/lib/keep-typing';
import { BUDGET_CAP_EDIT } from './typed-forms';
import { EditableRecord } from '@/components/forms';
import { FormGrid, Field } from '@/components/ui';

export const metadata = { title: 'Budgets — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-215 — the expense envelope, per store, per category, per period.
 *
 * ⛔ **Nothing here is stored except the cap itself.** Consumed and remaining are a `sum()` over
 * `expenses` every time this page loads. v1 keeps a `consumedAmount` counter and a `remainingAmount`
 * beside it, and needs neither: the first drifts (it is AR's `outstandingAmount` shape, measured
 * wrong on 13.3% of live rows) and the second is arithmetic on the first.
 *
 * ⛔ **And a cap never refuses an expense** — see `/expenses/new`'s hint. Nag whoever can act,
 * never block whoever cannot (T-175).
 */
interface SearchParams {
  store?: string;
  period?: string;
  ok?: string;
  error?: string;
}

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/budgets');
  const orgId = actor.orgId;

  const stores = await listStores(orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : (stores[0]?.id ?? '');
  const periods = periodOptions();
  const periodKey = sp.period && /^\d{6}$/.test(sp.period) ? sp.period : currentPeriodKey();

  const [budgets, uncapped] = storeId
    ? await Promise.all([listBudgets(orgId, storeId, periodKey), listUncapped(orgId, storeId, periodKey)])
    : [[], []];

  const totalCapped = budgets.reduce((t, b) => t + Number(b.amount), 0);
  const totalSpent = budgets.reduce((t, b) => t + Number(b.consumed), 0);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Budgets</h1>
        <PageDescription>
          What a store may spend per category, per period. ⛔ <strong>A cap warns; it never
          blocks</strong> — the figure shows on{' '}
          <Link href="/expenses/new" className="underline underline-offset-2">
            new expense
          </Link>{' '}
          while somebody is deciding, which is the only moment it can change anything.
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

      {stores.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          This org has no store yet, so there is nothing to cap. Create one on{' '}
          <Link href="/admin/stores" className="underline">
            stores
          </Link>
          .
        </p>
      ) : (
        <>
          <section className="flex flex-wrap items-end gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <FilterRow>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Store</span>
                <select name="store" defaultValue={storeId} className={INPUT}>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Period</span>
                <select name="period" defaultValue={periodKey} className={INPUT}>
                  {periods.map((p) => (
                    <option key={p} value={p}>
                      {periodLabel(p)}
                    </option>
                  ))}
                </select>
              </label>
            </FilterRow>
            <div className="ml-auto text-right text-sm">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Capped this period</p>
              <p className="text-lg font-semibold tabular-nums">{peso(totalCapped.toFixed(2))}</p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {peso(totalSpent.toFixed(2))} spent against it
              </p>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="font-medium">Caps for {periodLabel(periodKey)}</h2>
            {budgets.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                Nothing is capped for this period. Set one below.
              </p>
            ) : (
              <div className="space-y-2">
                {budgets.map((b) => {
                  // T-371 C4/R4: the decisions are made on re-minted database values, never a float — `capped` on the
                  // brand, the amber threshold ("past 90%") as consumed × 10 > cap × 9 in exact centavos. `pct` is only
                  // the bar's width.
                  const cap = money(b.amount);
                  const capped = compare(cap, ZERO) > 0;
                  const nearCap = capped && toCentavos(money(b.consumed)) * 10n > toCentavos(cap) * 9n;
                  const pct = capped ? Math.min(100, (Number(b.consumed) / Number(b.amount)) * 100) : 0;
                  return (
                    <div
                      key={b.id}
                      className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium">
                          {b.categoryLabel}
                          <span className="ml-2 text-xs font-normal text-neutral-400">
                            {b.categoryGroup}
                            {b.accountCode ? ` · ${b.accountCode}` : ' · unmapped'}
                          </span>
                        </span>
                        <span className="tabular-nums">
                          {peso(b.consumed)} of {peso(b.amount)} ·{' '}
                          <strong className={b.overBudget ? 'text-red-700 dark:text-red-400' : ''}>
                            {peso(b.remaining)} left
                          </strong>
                        </span>
                      </div>

                      {/* ⚠️ The bar tops out at 100% while the FIGURE above goes negative. A bar
                          that keeps growing off the row tells you less than a number that says
                          −₱750, and the number is the thing anyone acts on. */}
                      <div className="h-2 w-full overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
                        <div
                          className={`h-full ${b.overBudget ? 'bg-red-500' : nearCap ? 'bg-amber-500' : 'bg-emerald-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>

                      {b.overBudget && (
                        <p className="text-xs text-red-700 dark:text-red-400">
                          Over by {peso((Number(b.consumed) - Number(b.amount)).toFixed(2))}. ⚠️ Nothing was
                          refused — expenses still post.
                        </p>
                      )}
                      {b.autoReissue && b.reissueInterval && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          ↻ {INTERVAL_LABEL[b.reissueInterval] ?? b.reissueInterval}
                          {b.lastResetAt && ` · window began ${toBusinessDate(b.lastResetAt)}`}
                          {b.reissuedFromId && ' · created by the reissue job'}
                        </p>
                      )}

                      {/* T-389: a reopened (or too-long-to-keep) cap must be visible, so its <details> opens. */}
                      <details open={typedFor(sp, BUDGET_CAP_EDIT, b.categoryId, actor.personId) !== null}>
                        <summary className="cursor-pointer text-xs text-neutral-500 dark:text-neutral-400">
                          Edit or remove
                        </summary>
                        <div className="mt-2 flex flex-wrap items-start gap-2">
                          <CapForm
                            storeId={storeId}
                            periodKey={periodKey}
                            categoryId={b.categoryId}
                            defaultAmount={b.amount}
                            defaultAutoReissue={b.autoReissue}
                            defaultInterval={b.reissueInterval}
                            typed={typedFor(sp, BUDGET_CAP_EDIT, b.categoryId, actor.personId)}
                          />
                          <form action={removeBudgetAction}>
                            <input type="hidden" name="storeId" value={storeId} />
                            <input type="hidden" name="periodKey" value={periodKey} />
                            <input type="hidden" name="budgetId" value={b.id} />
                            <button
                              type="submit"
                              className="rounded border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
                            >
                              Remove cap
                            </button>
                          </form>
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="font-medium">No cap set</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              ⚠️ <strong>No cap</strong> is not a cap of zero. A category listed here is unlimited;
              a cap of <code>0.00</code> means <em>spend nothing in this category</em>, and both are
              legitimate.
            </p>
            {uncapped.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">Every category has a cap.</p>
            ) : (
              <div className="space-y-1">
                {uncapped.map((c) => (
                  <details key={c.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
                    <summary className="cursor-pointer text-sm">
                      {c.label}
                      <span className="ml-2 text-xs text-neutral-400">{c.group}</span>
                    </summary>
                    <div className="mt-2">
                      <CapForm storeId={storeId} periodKey={periodKey} categoryId={c.id} />
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </Page>
  );
}

const INPUT =
  'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

/**
 * One cap, four fields — which is why there is no detail page.
 *
 * ⚠️ The interval select is always rendered rather than revealed by the checkbox: a server
 * component cannot react to a tick, and hiding it behind JavaScript would make the field invisible
 * to anyone the JS has not loaded for. The ACTION drops the interval when the box is unticked, so
 * the database never sees the combination it refuses.
 */
function CapForm({
  storeId,
  periodKey,
  categoryId,
  defaultAmount,
  defaultAutoReissue,
  defaultInterval,
  typed,
}: {
  storeId: string;
  periodKey: string;
  categoryId: string;
  defaultAmount?: string;
  defaultAutoReissue?: boolean;
  defaultInterval?: string | null;
  /** T-389: the typing of a refused save of THIS cap, or the too-long notice. */
  typed?: TypedView | null;
}) {
  const fields = (
    <FormGrid>
      <Field label="Cap">
        <input
          name="amount"
          required
          inputMode="decimal"
          defaultValue={defaultAmount ?? ''}
          placeholder="0.00"
          className={`${INPUT} w-full text-right`}
        />
      </Field>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="autoReissue" defaultChecked={defaultAutoReissue ?? false} />
        renew automatically
      </label>
      <Field label="How often">
        <select name="reissueInterval" defaultValue={defaultInterval ?? 'monthly'} className={`${INPUT} w-full`}>
          {REISSUE_INTERVALS.map((i) => (
            <option key={i} value={i}>
              {INTERVAL_LABEL[i] ?? i}
            </option>
          ))}
        </select>
      </Field>
    </FormGrid>
  );
  const hidden = { storeId, periodKey, categoryId };
  // An existing cap is locked until Edit (T-384 L1); a category with no cap yet is an add form and ends in Save.
  if (defaultAmount !== undefined) {
    return (
      <EditableRecord action={setBudgetAction} label="cap" hidden={hidden} typed={typed ?? null}>
        {fields}
      </EditableRecord>
    );
  }
  return (
    <form action={setBudgetAction}>
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="periodKey" value={periodKey} />
      <input type="hidden" name="categoryId" value={categoryId} />
      {fields}
      <button
        type="submit"
        className="mt-3 rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        Save
      </button>
    </form>
  );
}
