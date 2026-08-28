import { notFound } from 'next/navigation';
import { peso } from '../../../../lib/format';
import { requireSession } from '../../../../lib/session';
import { recordPaymentAction } from '../../actions';
import { getSupplier, getPosition, listOpenItems, listInvoices, moneyAccountsFor, storesWithOpenItems, today } from '../../lib';

export const metadata = { title: 'Supplier — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  /** Which store's payables are being settled. AP is store-scoped (Ian, 2026-08-28). */
  store?: string;
}

export default async function SupplierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/ap/suppliers/${id}`);
  const orgId = actor.orgId;

  const supplier = await getSupplier(orgId, id);
  if (!supplier) notFound();

  const [balance, invoices, storeOptions] = await Promise.all([
    getPosition(orgId, id),
    listInvoices(orgId, { supplierId: id }),
    storesWithOpenItems(orgId, id),
  ]);
  const invoiceById = new Map(invoices.map((inv) => [inv.id, inv]));

  // ⭐ AP is store-scoped. The store is CHOSEN, never inferred from whichever open item happened
  // to sort first — that older behaviour silently booked every leg of a payment at one store even
  // when the supplier was owed money at two, so one store's 2110 went negative and the other's
  // never cleared.
  const storeId = sp.store && storeOptions.some((s) => s.storeId === sp.store)
    ? sp.store
    : (storeOptions[0]?.storeId ?? '');
  const openItems = storeId ? await listOpenItems(orgId, id, storeId) : [];
  const storeBalance = storeId ? await getPosition(orgId, id, storeId) : '0.00';
  const wallets = storeId ? await moneyAccountsFor(orgId, storeId) : [];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a href="/ap" className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400">
            ← Accounts payable
          </a>
          <h1 className="mt-1 text-2xl font-semibold">{supplier.name}</h1>
        </div>
        <div className="text-right">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">Owed (2110)</p>
          <p className="text-2xl font-semibold tabular-nums">{peso(balance)}</p>
        </div>
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

      {storeOptions.length > 1 && (
        <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Which store&rsquo;s payables?</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            This supplier is owed money by more than one store. A payment settles ONE store&rsquo;s
            open items and is funded from that store&rsquo;s own account &mdash; paying across
            stores would clear a liability the paying store never carried.
          </p>
          <div className="flex flex-wrap gap-2">
            {storeOptions.map((s) => (
              <a
                key={s.storeId}
                href={`/ap/suppliers/${id}?store=${s.storeId}`}
                className={
                  s.storeId === storeId
                    ? 'rounded-lg border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                    : 'rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900'
                }
              >
                {s.storeName} &mdash; {peso(s.outstanding)}{' '}
                <span className="opacity-60">({s.count})</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">
          Open items
          {storeId && (
            <span className="ml-2 text-sm font-normal text-neutral-500 dark:text-neutral-400">
              {storeOptions.find((s) => s.storeId === storeId)?.storeName} &middot; {peso(storeBalance)} owed by this store
            </span>
          )}
        </h2>
        {openItems.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Expense</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {openItems.map((i) => (
                  <tr key={i.expenseId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <a href={`/expenses/${i.expenseId}`} className="underline hover:no-underline">{i.particulars}</a>
                    </td>
                    <td className="px-3 py-2">{i.businessDate}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Nothing open — fully paid.</p>
        )}
      </section>

      {openItems.length > 0 && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Record a payment</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Name the open items this settles (bible §16.10) — check the ones this payment covers
            and how much of each. Paying more than allocated routes the rest to 1240 (advance).
          </p>
          <form action={recordPaymentAction} className="space-y-3">
            <input type="hidden" name="supplierId" value={id} />
            <input type="hidden" name="storeId" value={storeId} />
            <div className="space-y-1">
              {openItems.map((i) => (
                <label key={i.expenseId} className="flex items-center gap-3 text-sm">
                  <input type="checkbox" name="allocateExpenseId" value={i.expenseId} defaultChecked />
                  <span className="flex-1">{i.particulars} — owed {peso(i.outstanding)}</span>
                  <input
                    type="text"
                    name={`allocateAmount_${i.expenseId}`}
                    defaultValue={i.outstanding}
                    className="w-28 rounded border border-neutral-300 bg-white px-2 py-1 text-right dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Total handed over">
                <input name="amount" required placeholder="0.00" className={INPUT} />
              </Field>
              <Field label="From account">
                <select name="moneyAccountId" required defaultValue="" className={INPUT}>
                  <option value="" disabled>Choose…</option>
                  {wallets.map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.custodian}) — {peso(w.balance)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Date">
                <input type="date" name="businessDate" required defaultValue={today()} className={INPUT} />
              </Field>
            </div>
            <Field label="Reference no." hint="Optional.">
              <input name="referenceNo" className={INPUT} />
            </Field>
            <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900">
              Record payment
            </button>
          </form>
        </section>
      )}
    </main>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}
