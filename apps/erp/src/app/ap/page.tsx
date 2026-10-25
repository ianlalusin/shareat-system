import { PhotoUpload } from '@/components/upload/PhotoUpload';
import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { recordInvoiceAction } from './actions';
import { listSuppliersWithPosition, listInvoices, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Button, Field, FlashBanner, FormGrid, FormModal, FormSection, Input, LinkRow, RowLink, Select } from '@/components/ui';
import { CheckedForm, RuleCheck } from '@/components/forms';
import { buildSupplierFacts } from '@shareat/domain/business-rules';
import { InvoiceNumberCheck } from './InvoiceNumberCheck';
import { SUPPLIER_INVOICE_LOG_RULES, nativeAttrs } from '@shareat/domain/field-rules';
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

  const [suppliers, invoiceRows, stores] = await Promise.all([
    listSuppliersWithPosition(actor.orgId),
    listInvoices(actor.orgId),
    listStores(actor.orgId),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  // T-475: the facts the live business-rule lines read (each supplier's status and vatStatus), built by the SAME function the domain uses; no status or VAT rule is derived here.
  const supplierFacts = buildSupplierFacts(suppliers);
  const supplierNames = Object.fromEntries(supplierName);
  const pending = invoiceRows.filter((i) => i.status === 'pending');
  const invoices = [...invoiceRows].sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">Accounts payable</h1>
          <PageDescription>
            No expense — cash or credit — can be recorded until its supplier invoice is verified
            here. Verification <strong>is</strong> the approval (T-130).
          </PageDescription>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/ap/suppliers" className={ACTION_LINK}>Suppliers →</Link>
          {/* T-448: invoices are logged daily, so the form opens from the header instead of sitting under the list. */}
          <FormModal
            trigger="+ Log invoice"
            title="Log a supplier invoice"
            description="Pending until verified. No expense can be recorded against it before then."
            size="lg"
          >
            <CheckedForm rules={SUPPLIER_INVOICE_LOG_RULES} action={recordInvoiceAction} className="space-y-3">
              <FormSection title="Invoice document">
                <FormGrid layout="fields">
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.storeId} label="Store">
                    <Select {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.storeId)} defaultValue="" className="w-full">
                      <option value="" disabled>Choose…</option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.supplierId} label="Supplier">
                    <Select {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.supplierId)} defaultValue="" className="w-full">
                      <option value="" disabled>Choose…</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field width="code" label="Invoice no." hint="Optional.">
                    <Input name="invoiceNo" className="w-full" />
                  </Field>
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.totalAmount} width="short" label="Total amount">
                    <Input {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.totalAmount)} placeholder="0.00" className="w-full" />
                  </Field>
                </FormGrid>
                <RuleCheck id="ap.invoice.supplierActive" facts={supplierFacts} />
                <InvoiceNumberCheck supplierNames={supplierNames}>
                  <RuleCheck id="ap.invoice.duplicateNumber" />
                </InvoiceNumberCheck>
                <FormGrid layout="fields">
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.deliveryFee} width="short" label="Delivery fee" hint="Optional. Part of the total above, added to the items' cost; not a line.">
                    <Input {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.deliveryFee)} placeholder="0.00" className="w-full" />
                  </Field>
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.otherFees} width="short" label="Other fees" hint="Optional. Part of the total above, added to the items' cost; not a line.">
                    <Input {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.otherFees)} placeholder="0.00" className="w-full" />
                  </Field>
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.invoiceDate} width="date" label="Invoice date">
                    <Input {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.invoiceDate)} type="date" defaultValue={today()} className="w-full" />
                  </Field>
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.dueDate} width="date" label="Due date" hint="Leave blank to use the supplier's terms.">
                    <Input {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.dueDate)} type="date" className="w-full" />
                  </Field>
                </FormGrid>
                <RuleCheck id="ap.invoice.dueNotBeforeInvoice" />
                <RuleCheck id="ap.invoice.feesNotOverTotal" />
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
                  <Field rule={SUPPLIER_INVOICE_LOG_RULES.vatAmount} width="short" label="VAT amount (as printed)" hint="Type the VAT shown on the paper. Only for a vatable bill.">
                    <Input {...nativeAttrs(SUPPLIER_INVOICE_LOG_RULES.vatAmount)} placeholder="0.00" className="w-full" />
                  </Field>
                </FormGrid>
                <RuleCheck id="ap.invoice.vat" facts={supplierFacts} />
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
            </CheckedForm>
          </FormModal>
        </div>
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
        <h2 className="font-medium">Invoices</h2>
        {invoices.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[600px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Supplier</th>
                  <th className="px-3 py-2 font-medium">Invoice no.</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <LinkRow key={inv.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <RowLink
                        href={`/ap/invoices/${inv.id}`}
                        aria-label={`Open invoice ${inv.invoiceNo ?? 'with no number'} of ${inv.invoiceDate}`}
                      >
                        {supplierName.get(inv.supplierId) ?? inv.supplierId}
                      </RowLink>
                    </td>
                    <td className="px-3 py-2">{inv.invoiceNo ?? 'No number'}</td>
                    <td className="px-3 py-2">{inv.invoiceDate}</td>
                    <td className="px-3 py-2">
                      <Badge status={inv.status} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(inv.totalAmount)}</td>
                  </LinkRow>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No invoices logged yet.</p>
        )}
      </section>
    </Page>
  );
}
