import { PhotoUpload } from '@/components/upload/PhotoUpload';
import Link from 'next/link';
import { requireSession } from '../../lib/session';
import { recordInvoiceAction } from './actions';
import { listSuppliersWithPosition, listInvoicesWithStanding, standingPills, listStores, peso, today } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Button, Field, FlashBanner, FormGrid, FormModal, FormSection, Input, LinkRow, NumTd, RowLink, Select, Table, Td, Th } from '@/components/ui';
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
  /** T-475 S3: `1` lists only invoices verified by the person who logged them. A flag; nothing typed in the URL. */
  selfVerified?: string;
  /** T-520: `pending` lists only invoices not verified yet. A flag; nothing typed in the URL. */
  status?: string;
}

export default async function ApPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/ap');

  const onlySelfVerified = sp.selfVerified === '1';
  const onlyPending = sp.status === 'pending';
  const [suppliers, allInvoices, stores] = await Promise.all([
    listSuppliersWithPosition(actor.orgId),
    listInvoicesWithStanding(actor.orgId),
    listStores(actor.orgId),
  ]);
  const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));
  // T-475: the facts the live business-rule lines read (each supplier's status and vatStatus), built by the SAME function the domain uses; no status or VAT rule is derived here.
  const supplierFacts = buildSupplierFacts(suppliers);
  const supplierNames = Object.fromEntries(supplierName);
  // One load; both filters and the Not verified count read these same rows (newest first, as the repo orders them).
  const pendingCount = allInvoices.filter((i) => i.status === 'pending').length;
  const invoices = allInvoices.filter((i) => (onlySelfVerified ? i.selfVerified : onlyPending ? i.status === 'pending' : true));

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

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Invoices</h2>
          {/* Plain GET links: each filter is a flag, so no typing is read from the URL. */}
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {onlySelfVerified || onlyPending ? (
              <Link href="/ap" className={ACTION_LINK}>Show all invoices →</Link>
            ) : (
              <>
                {pendingCount > 0 && <Link href="/ap?status=pending" className={ACTION_LINK}>Not verified ({pendingCount}) →</Link>}
                <Link href="/ap?selfVerified=1" className={ACTION_LINK}>Self-verified only →</Link>
              </>
            )}
          </span>
        </div>
        {invoices.length > 0 ? (
          <Table card={{ title: 'Supplier', subtitle: 'Date', keys: ['Verified', 'Recorded', 'Paid', 'Total'] }}>
            <caption className="sr-only">Supplier invoices</caption>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Supplier</Th>
                <Th>Invoice no.</Th>
                <Th>Verified</Th>
                <Th>Recorded</Th>
                <Th>Paid</Th>
                <Th numeric>Total</Th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const { recorded, paid } = standingPills(inv);
                const dash = <span className="text-muted" aria-label="Not applicable">—</span>;
                return (
                  <LinkRow key={inv.id}>
                    <Td className="tabular-nums">{inv.invoiceDate}</Td>
                    <Td>
                      <RowLink
                        href={`/ap/invoices/${inv.id}`}
                        aria-label={`Open invoice ${inv.invoiceNo ?? 'with no number'} of ${inv.invoiceDate}`}
                      >
                        {supplierName.get(inv.supplierId) ?? inv.supplierId}
                      </RowLink>
                    </Td>
                    <Td>{inv.invoiceNo ?? 'No number'}</Td>
                    <Td>
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {inv.status === 'voided' ? (
                          <Badge tone="closed" label="Voided" />
                        ) : inv.status === 'pending' ? (
                          <Badge tone="warning" label="Not verified" />
                        ) : (
                          <Badge tone="success" label="Verified" />
                        )}
                        {inv.selfVerified && inv.status !== 'voided' && <Badge tone="warning" label="Self-verified" />}
                      </span>
                    </Td>
                    <Td>{recorded ? <Badge tone={recorded.tone} label={recorded.label} /> : dash}</Td>
                    <Td>{paid ? <Badge tone={paid.tone} label={paid.label} /> : dash}</Td>
                    <NumTd>{peso(inv.totalAmount)}</NumTd>
                  </LinkRow>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-muted">{onlySelfVerified ? 'No invoice has been self-verified.' : onlyPending ? 'Every invoice has been verified.' : 'No invoices logged yet.'}</p>
        )}
      </section>
    </Page>
  );
}
