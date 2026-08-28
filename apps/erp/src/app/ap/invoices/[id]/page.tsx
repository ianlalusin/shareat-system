import { notFound } from 'next/navigation';
import { transaction, expensesRepo, apRepo } from '@shareat/db';
import { peso } from '../../../../lib/format';
import { requireSession } from '../../../../lib/session';
import { verifyInvoiceAction, voidInvoiceAction } from '../../actions';
import { createExpenseAction } from '../../../expenses/actions';
import {
  getInvoice,
  getSupplier,
  listCategoriesGrouped,
  listMoneyAccountsForPicker,
} from '../../lib';

export const metadata = { title: 'Supplier invoice — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  warning?: string;
}

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/ap/invoices/${id}`);
  const orgId = actor.orgId;

  const invoice = await getInvoice(orgId, id);
  if (!invoice) notFound();
  const supplier = await getSupplier(orgId, invoice.supplierId);

  const [capacity, linkedExpenses, categories, wallets] = await Promise.all([
    transaction((tx) => apRepo.capacityOf(tx, orgId, id)),
    transaction(async (tx) => {
      const all = await expensesRepo.listExpenses(tx, { orgId, limit: 500 });
      return all.filter((e) => e.supplierInvoiceId === id);
    }),
    listCategoriesGrouped(orgId),
    listMoneyAccountsForPicker(orgId),
  ]);

  const canRecord = invoice.status === 'verified' && Number(capacity?.remaining ?? 0) >= 1;
  const groups: Array<'COGS' | 'OPEX' | 'PERSONAL' | 'CAPEX'> = ['COGS', 'OPEX', 'PERSONAL', 'CAPEX'];

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a href="/ap" className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400">
            ← Accounts payable
          </a>
          <h1 className="mt-1 text-2xl font-semibold">
            {supplier?.name ?? invoice.supplierId} — {invoice.invoiceNo ?? id.slice(0, 8)}
          </h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {invoice.invoiceDate}
            {invoice.dueDate ? ` · due ${invoice.dueDate}` : ''}
          </p>
        </div>
        <div className="text-right">
          <StatusBadge status={invoice.status} />
          <p className="mt-2 text-2xl font-semibold tabular-nums">{peso(invoice.totalAmount)}</p>
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
      {sp.warning && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          ⚠️ {sp.warning}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-3 font-medium">Recording capacity</h2>
          <dl className="space-y-1.5">
            <Row label="Total" value={peso(capacity?.totalAmount ?? invoice.totalAmount)} />
            <Row label="Recorded" value={peso(capacity?.recorded ?? '0.00')} />
            <Row label="Remaining" value={peso(capacity?.remaining ?? invoice.totalAmount)} />
          </dl>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-3 font-medium">Evidence</h2>
          {invoice.receiptPhotoUrl ? (
            <a href={invoice.receiptPhotoUrl} className="underline hover:no-underline">attached</a>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">none — required to verify</span>
          )}
        </div>
      </section>

      {invoice.status === 'pending' && (
        <form action={verifyInvoiceAction}>
          <input type="hidden" name="invoiceId" value={invoice.id} />
          <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900">
            Verify — manager only (Ian, 2026-08-27)
          </button>
        </form>
      )}

      {linkedExpenses.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Expenses recorded against this invoice</h2>
          <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-900 dark:border-neutral-800">
            {linkedExpenses.map((e) => (
              <li key={e.id} className="flex items-center justify-between px-3 py-2">
                <a href={`/expenses/${e.id}`} className="underline hover:no-underline">
                  {e.particulars}
                </a>
                <span className="font-mono tabular-nums">{peso(e.totalAmount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canRecord && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Record an expense against this invoice</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Posts immediately — verification already was the approval (Ian, 2026-08-27).
          </p>
          <form action={createExpenseAction} className="space-y-3">
            <input type="hidden" name="returnTo" value={`/ap/invoices/${invoice.id}`} />
            <input type="hidden" name="supplierId" value={invoice.supplierId} />
            <input type="hidden" name="supplierInvoiceId" value={invoice.id} />
            <input type="hidden" name="storeId" value={invoice.storeId} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <select name="categoryId" required defaultValue="" className={INPUT}>
                  <option value="" disabled>Select…</option>
                  {groups.map((g) => {
                    const rows = categories.filter((c) => c.group === g);
                    if (rows.length === 0) return null;
                    return (
                      <optgroup key={g} label={g}>
                        {rows.map((c) => (
                          <option key={c.id} value={c.id} disabled={!c.accountCode}>{c.category}</option>
                        ))}
                      </optgroup>
                    );
                  })}
                </select>
              </Field>
              <Field label="Particulars">
                <input name="particulars" required className={INPUT} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Method">
                <select name="method_1" defaultValue="credit" className={INPUT}>
                  <option value="cash">Cash</option>
                  <option value="online">Online / e-wallet</option>
                  <option value="credit">Credit (AP)</option>
                </select>
              </Field>
              <Field label="Amount">
                <input name="amount_1" required placeholder="0.00" className={INPUT} />
              </Field>
              <Field label="Paid from (cash/online only)">
                <select name="moneyAccountId_1" defaultValue="" className={INPUT}>
                  <option value="">— not needed for credit —</option>
                  {wallets.filter((w) => w.storeId === invoice.storeId).map((w) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.custodian})</option>
                  ))}
                </select>
              </Field>
            </div>
            <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900">
              Record expense
            </button>
          </form>
        </section>
      )}

      {invoice.status !== 'voided' && (
        <form action={voidInvoiceAction} className="flex items-end gap-3 rounded-lg border border-red-200 p-4 text-sm dark:border-red-900">
          <input type="hidden" name="invoiceId" value={invoice.id} />
          <Field label="Void reason">
            <input name="reason" required className={INPUT} />
          </Field>
          <button type="submit" className="rounded border border-red-300 px-4 py-2 font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
            Void — cascades through every linked expense
          </button>
        </form>
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-right font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'verified'
      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300'
      : status === 'voided'
        ? 'bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400'
        : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300';
  return <span className={`rounded px-2 py-1 text-xs font-medium ${cls}`}>{status}</span>;
}
