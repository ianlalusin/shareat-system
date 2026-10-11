import { toBusinessDate } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { payReimbursementAction } from './actions';
import { canOverrideClosedMonth, listOwedAtStore, listPayFromAccounts, listPayableStores, peso } from './lib';
import { closedMonths } from '../../../lib/period-override';
import { ClosedMonthOverride } from '@/components/ClosedMonthOverride';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { Button, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Reimbursements — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-369 S1 (DEF-198) — paying staff back what they spent out of pocket.
 *
 * What is owed is the ledger's `2130` balance per person AT the chosen store, derived on every
 * load. Nothing here decides who may pay: the page lists only stores where the viewer holds
 * `record_ap_payment` (the read gate is `requirePageAccess`), and `payReimbursement` re-checks
 * everything on submit.
 */
interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
  warning?: string;
}

export default async function ReimbursementsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/expenses/reimbursements');
  if (refusal) return refusal;

  const stores = await listPayableStores(actor);
  const store = stores.find((s) => s.id === sp.store) ?? stores[0];

  const [owed, accounts] = store
    ? await Promise.all([listOwedAtStore(actor.orgId, store.id), listPayFromAccounts(actor.orgId, store.id)])
    : [[], []];
  const today = toBusinessDate();
  // The override control is offered only to someone who holds `override_period_lock`, and only when
  // some month is actually closed.
  const closed = store && (await canOverrideClosedMonth(actor)) ? await closedMonths(actor.orgId) : [];

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Reimbursements</h1>
        <PageDescription>
          What this store owes people who paid for something out of their own pocket. Paying one back
          takes the money from a store account and clears what is owed; it never pays more than is owed.
        </PageDescription>
      </div>

      {/* A warning is not an error: the payout posted. FlashBanner draws it as a warning; the Toaster shows ok. */}
      <FlashBanner flash={sp} />

      {!store ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          You can&apos;t pay reimbursements at any store.
        </p>
      ) : (
        <>
          <FilterRow>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Store</span>
              <Select name="store" defaultValue={store.id}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
          </FilterRow>

          {owed.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Nobody is owed a reimbursement at this store.
            </p>
          ) : (
            <ul className="space-y-3">
              {owed.map((row) => (
                <li
                  key={row.employeeId}
                  className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{row.displayName}</span>
                    <span className="text-sm">
                      <span className="text-neutral-500 dark:text-neutral-400">Owed </span>
                      <span className="font-mono tabular-nums">{peso(row.outstanding)}</span>
                    </span>
                  </div>

                  {accounts.length === 0 ? (
                    <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                      This store has no account to pay from.
                    </p>
                  ) : (
                    <details className="mt-2">
                      <summary className="inline-flex min-h-[44px] cursor-pointer items-center px-1 text-sm font-medium">
                        Pay
                      </summary>
                      <form action={payReimbursementAction} className="mt-2">
                        <input type="hidden" name="storeId" value={store.id} />
                        <input type="hidden" name="employeeId" value={row.employeeId} />
                        {/* Minted per render, so a double click or a replayed POST posts once. */}
                        <input type="hidden" name="payoutId" value={crypto.randomUUID()} />
                        <FormGrid>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Amount</span>
                          <Input name="amount" required inputMode="decimal" defaultValue={row.outstanding} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Date</span>
                          <Input name="on" type="date" required defaultValue={today} />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Pay from</span>
                          <Select name="fromMoneyAccountId" required>
                            {accounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </Select>
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Memo (optional)</span>
                          <Input name="memo" />
                        </label>
                        {closed.length > 0 && (
                          <ClosedMonthOverride closedMonths={closed} dateFieldName="on" initialDate={today} />
                        )}
                        <div className="col-span-full">
                          <Button type="submit" variant="primary">
                            Pay {row.displayName}
                          </Button>
                        </div>
                        </FormGrid>
                      </form>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Page>
  );
}
