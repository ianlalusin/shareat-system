import { PhotoInput } from '@/components/PhotoInput';
import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { createSupplierAction, recordInvoiceAction } from './actions';
import { listSuppliersWithPosition, listInvoices, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Input, LinkRow, RowLink, Select } from '@/components/ui';

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

      <FlashBanner flash={sp} />

      {pending.length > 0 && (
        <section className="space-y-2 rounded-lg border border-warning bg-warning-soft p-4 text-sm">
          <h2 className="font-medium text-warning-ink">
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
                  <th className="px-3 py-2 text-right font-medium">Owed</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <LinkRow key={s.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <RowLink href={`/ap/suppliers/${s.id}`}>
                        {s.name}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2 text-xs">{s.status}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(s.controlBalance)}</td>
                  </LinkRow>
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
              <Input name="name" required placeholder="ABC Meat Supply" className="w-full" />
            </Field>
            <Field label="Address" hint="Optional.">
              <Input name="address" className="w-full" />
            </Field>
            <Field label="Contact no." hint="Optional.">
              <Input name="contactNo" className="w-full" />
            </Field>
            <Field label="Payment terms">
              <Select name="termsMode" defaultValue="cod" className="w-full">
                <option value="cod">Cash on delivery (no credit)</option>
                <option value="credit">On credit (AP)</option>
              </Select>
            </Field>
            <Field label="Days to pay" hint="Only for On credit. 0 to 365.">
              <Input type="number" name="creditTermsDays" min="0" max="365" step="1" className="w-full" />
            </Field>
            <Button type="submit" variant="secondary">Save</Button>
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
              <Select name="storeId" required defaultValue="" className="w-full">
                <option value="" disabled>Choose…</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Supplier">
              <Select name="supplierId" required defaultValue="" className="w-full">
                <option value="" disabled>Choose…</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Invoice no." hint="Optional.">
                <Input name="invoiceNo" className="w-full" />
              </Field>
              <Field label="Total amount">
                <Input name="totalAmount" required placeholder="0.00" className="w-full" />
              </Field>
              <Field label="Delivery fee" hint="Optional.">
                <Input name="deliveryFee" inputMode="decimal" placeholder="0.00" className="w-full" />
              </Field>
              <Field label="Other fees" hint="Optional.">
                <Input name="otherFees" inputMode="decimal" placeholder="0.00" className="w-full" />
              </Field>
              <p className="col-span-2 text-xs text-neutral-500 dark:text-neutral-500">
                Part of the total above. Both are added to the items&apos; cost; neither is a line.
              </p>
              <Field label="Invoice date">
                <Input type="date" name="invoiceDate" required defaultValue={today()} className="w-full" />
              </Field>
              <Field label="Due date" hint="Leave blank to use the supplier's terms.">
                <Input type="date" name="dueDate" className="w-full" />
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
                className={FILE_INPUT}
              />
            </Field>
            <Button type="submit" variant="primary">Log invoice</Button>
          </form>
        </section>
      </div>
    </Page>
  );
}

// PhotoInput is a file input, which the kit does not wrap; it takes the field tokens directly.
const FILE_INPUT = 'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 text-sm text-ink';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}
