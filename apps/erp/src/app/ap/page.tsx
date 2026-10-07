import { PhotoInput } from '@/components/PhotoInput';
import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { createSupplierAction, recordInvoiceAction } from './actions';
import { listSuppliersWithPosition, listInvoices, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Accounts payable — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  warning?: string;
}

export default async function ApPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/ap');

  const [suppliers, pending, stores] = await Promise.all([
    listSuppliersWithPosition(actor.orgId),
    listInvoices(actor.orgId, { status: 'pending' }),
    listStores(actor.orgId),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Accounts payable</h1>
        <PageDescription>
          No expense — cash or credit — can be recorded until its supplier invoice is verified
          here. Verification <strong>is</strong> the approval (T-130).
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
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

      {pending.length > 0 && (
        <section className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
          <h2 className="font-medium text-amber-900 dark:text-amber-200">
            {pending.length === 1 ? 'One invoice needs' : `${pending.length} invoices need`} verification
          </h2>
          <ul className="space-y-1">
            {pending.map((inv) => (
              <li key={inv.id}>
                <Link href={`/ap/invoices/${inv.id}`} className="underline underline-offset-2">
                  {supplierName.get(inv.supplierId) ?? inv.supplierId} — {inv.invoiceNo ?? inv.id.slice(0, 8)}
                </Link>{' '}
                — <span className="font-mono tabular-nums">{peso(inv.totalAmount)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Suppliers</h2>
        {suppliers.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[600px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Supplier</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Owed (2110)</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr key={s.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <Link href={`/ap/suppliers/${s.id}`} className="underline underline-offset-2">
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs">{s.status}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(s.controlBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No suppliers recorded yet.</p>
        )}
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Record a supplier</h2>
          <form action={createSupplierAction} className="space-y-3">
            <Field label="Name">
              <input name="name" required placeholder="ABC Meat Supply" className={INPUT} />
            </Field>
            <Field label="Address" hint="Optional.">
              <input name="address" className={INPUT} />
            </Field>
            <Field label="Contact no." hint="Optional.">
              <input name="contactNo" className={INPUT} />
            </Field>
            <Field label="Payment terms">
              <select name="termsMode" defaultValue="cod" className={INPUT}>
                <option value="cod">Cash on delivery (no credit)</option>
                <option value="credit">On credit (AP)</option>
              </select>
            </Field>
            <Field label="Days to pay" hint="Only for On credit. 0 to 365.">
              <input type="number" name="creditTermsDays" min="0" max="365" step="1" className={INPUT} />
            </Field>
            <button type="submit" className={BTN}>Record supplier</button>
          </form>
        </section>

        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Log a supplier invoice</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Pending until verified. No expense can be recorded against it before then.
            </p>
          </div>
          <form action={recordInvoiceAction} className="space-y-3">
            <Field label="Store">
              <select name="storeId" required defaultValue="" className={INPUT}>
                <option value="" disabled>Choose…</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Supplier">
              <select name="supplierId" required defaultValue="" className={INPUT}>
                <option value="" disabled>Choose…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Invoice no." hint="Optional.">
                <input name="invoiceNo" className={INPUT} />
              </Field>
              <Field label="Total amount">
                <input name="totalAmount" required placeholder="0.00" className={INPUT} />
              </Field>
              <Field label="Delivery fee" hint="Optional.">
                <input name="deliveryFee" inputMode="decimal" placeholder="0.00" className={INPUT} />
              </Field>
              <Field label="Other fees" hint="Optional.">
                <input name="otherFees" inputMode="decimal" placeholder="0.00" className={INPUT} />
              </Field>
              <p className="col-span-2 text-xs text-neutral-500 dark:text-neutral-500">
                Part of the total above. Both are added to the items&apos; cost; neither is a line.
              </p>
              <Field label="Invoice date">
                <input type="date" name="invoiceDate" required defaultValue={today()} className={INPUT} />
              </Field>
              <Field label="Due date" hint="Leave blank to use the supplier's terms.">
                <input type="date" name="dueDate" className={INPUT} />
              </Field>
            </div>
            <Field
              label="Photo of the receipt"
              hint="Required before it can be verified. Upload the actual photo — a link or a typed reference is not evidence."
            >
              {/* ⭐ T-296 — compresses a photo to under 1 MB before submit. A PDF passes through.
                  The server's own 1 MB image ceiling is what guarantees it (Ian, 2026-09-12). */}
              <PhotoInput
                name="receiptPhoto"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                className={INPUT}
              />
            </Field>
            <button type="submit" className={BTN}>Log invoice</button>
          </form>
        </section>
      </div>
    </Page>
  );
}

const INPUT =
  'w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}
