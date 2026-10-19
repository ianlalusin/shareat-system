import { PhotoUpload } from '@/components/upload/PhotoUpload';
import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { createSupplierAction, recordInvoiceAction } from './actions';
import { listSuppliersWithPosition, listInvoices, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Input, LinkRow, RowLink, Select, FormGrid, FormSection, type FieldProps } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { SUPPLIER_ADD_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { ACTION_LINK } from '@/components/action-link';

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

      <p className="text-sm">
        <Link href="/ap/vat" className={ACTION_LINK}>Invoices by VAT type and OR (monthly list)</Link>
      </p>

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
          <CheckedForm rules={SUPPLIER_ADD_RULES} action={createSupplierAction} className="space-y-3">
            <FormSection title="Supplier details">
              <FormGrid layout="fields">
                <Field width="name" label="Name" rule={SUPPLIER_ADD_RULES.name}>
                  <Input {...nativeAttrs(SUPPLIER_ADD_RULES.name)} placeholder="ABC Meat Supply" className="w-full" />
                </Field>
                <Field width="long" label="Address" hint="Optional.">
                  <Input name="address" className="w-full" />
                </Field>
                <Field width="code" label="Contact no." hint="Optional.">
                  <Input name="contactNo" className="w-full" />
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection title="Payment terms">
              <FormGrid layout="fields">
                <Field label="Payment terms">
                  <Select name="termsMode" defaultValue="cod" className="w-full">
                    <option value="cod">Cash on delivery (no credit)</option>
                    <option value="credit">On credit (AP)</option>
                  </Select>
                </Field>
                <Field width="short" label="Days to pay" hint="Only for On credit. 0 to 365." rule={SUPPLIER_ADD_RULES.creditTermsDays}>
                  <Input {...nativeAttrs(SUPPLIER_ADD_RULES.creditTermsDays)} className="w-full" />
                </Field>
              </FormGrid>
            </FormSection>
            <SubmitButton variant="secondary">Save</SubmitButton>
          </CheckedForm>
        </section>

        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Log a supplier invoice</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Pending until verified. No expense can be recorded against it before then.
            </p>
          </div>
          <form action={recordInvoiceAction} className="space-y-3">
            <FormSection title="Invoice document">
              <FormGrid layout="fields">
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
                <Field width="code" label="Invoice no." hint="Optional.">
                  <Input name="invoiceNo" className="w-full" />
                </Field>
                <Field width="code" label="Total amount">
                  <Input name="totalAmount" required placeholder="0.00" className="w-full" />
                </Field>
                <Field width="code" label="Delivery fee" hint="Optional.">
                  <Input name="deliveryFee" inputMode="decimal" placeholder="0.00" className="w-full" />
                </Field>
                <Field width="code" label="Other fees" hint="Optional.">
                  <Input name="otherFees" inputMode="decimal" placeholder="0.00" className="w-full" />
                </Field>
                <p className="col-span-2 text-xs text-neutral-500 dark:text-neutral-500">
                  Part of the total above. Both are added to the items&apos; cost; neither is a line.
                </p>
                <Field width="date" label="Invoice date">
                  <Input type="date" name="invoiceDate" required defaultValue={today()} className="w-full" />
                </Field>
                <Field width="date" label="Due date" hint="Leave blank to use the supplier's terms.">
                  <Input type="date" name="dueDate" className="w-full" />
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection title="Tax details">
              <FormGrid layout="fields">
                <Field label="Official receipt?">
                  <Select name="isOfficialReceipt" defaultValue="" className="w-full">
                    <option value="">Supplier&apos;s usual</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </Select>
                </Field>
                <Field label="VAT type">
                  <Select name="vatType" defaultValue="supplier_default" className="w-full">
                    <option value="supplier_default">Supplier&apos;s usual</option>
                    <option value="vatable">Vatable</option>
                    <option value="zero_rated">Zero-rated</option>
                    <option value="exempt">Exempt</option>
                    <option value="non_vat">Non-VAT</option>
                  </Select>
                </Field>
                <Field width="code" label="VAT amount (as printed)" hint="Type the VAT shown on the paper. Only for a vatable bill.">
                  <Input name="vatAmount" inputMode="decimal" placeholder="0.00" className="w-full" />
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection title="Receipt evidence">
              <Field
                label="Photo of the receipt"
                hint="Required before it can be verified. Upload the actual photo — a link or a typed reference is not evidence."
              >
                {/* T-441: one upload control. The photo is shrunk (T-296), sent on pick with real progress, and claimed when the invoice is saved. */}
                <PhotoUpload name="receiptPhoto" purpose="receipt_photo" label="Receipt photo" storeField="storeId" />
              </Field>
            </FormSection>
            <Button type="submit" variant="primary">Log invoice</Button>
          </form>
        </section>
      </div>
    </Page>
  );
}

function Field({ label, hint, rule, width, children }: { label: string; hint?: string; rule?: FieldRule; width?: FieldProps['width']; children: React.ReactNode }) {
  const widthClass = width ? ` erp-field-${width}` : '';
  const body = (
    <>
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </>
  );
  // T-440: a ruled field keeps its label and puts the live helper line OUTSIDE it (so the line never joins the accessible name).
  if (!rule) return <label className={`flex min-w-0 flex-col gap-1${widthClass}`}>{body}</label>;
  return (
    <div className={`min-w-0${widthClass}`}>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}
