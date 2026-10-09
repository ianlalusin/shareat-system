import { notFound } from 'next/navigation';
import { peso } from '../../../../lib/format';
import { requireSession } from '../../../../lib/session';
import { editSupplierAction, recordPaymentAction, autoAllocatePaymentAction } from '../../actions';
import { getSupplier, getPosition, listOpenItems, listInvoices, moneyAccountsFor, storesWithOpenItems, today } from '../../lib';
import { SUPPLIER_CLASSIFICATIONS, SUPPLIER_STATUSES, SUPPLIER_VAT_STATUSES } from '@shareat/db';
import { CLASSIFICATION_LABEL, VAT_STATUS_LABEL } from '../../lib';
import { Page } from '@/components/shell/Page';
import { EditableRecord } from '@/components/forms';
import { FormGrid } from '@/components/ui';
import { AutoAllocatePaymentForm } from './AutoAllocatePaymentForm';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { SUPPLIER_EDIT } from '../../typed-forms';

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
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/ap/suppliers/${id}`);
  const orgId = actor.orgId;

  const supplier = await getSupplier(orgId, id);
  if (!supplier) notFound();

  const [balance, invoices, storeOptions] = await Promise.all([
    getPosition(orgId, id),
    listInvoices(orgId, { supplierId: id }),
    storesWithOpenItems(orgId, id),
  ]);
  // T-389: the typing (or the "too long to keep" notice) for THIS supplier's edit record, from the signed flash.
  const typed = typedFor(sp, SUPPLIER_EDIT, supplier.id, actor.personId);
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
    <Page density="table">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a href="/ap/suppliers" className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400">
            ← Suppliers
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

      {/* ---------------------------------------------------------------- T-188: the record itself.
          ⛔ Until 2026-08-30 a supplier could be CREATED and never EDITED — `updateSupplier`
          existed in the repo with no caller — so a typo in a name was permanent. */}
      <details {...(typed ? { open: true } : {})} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <summary className="cursor-pointer text-sm font-medium">Edit this supplier</summary>
        <EditableRecord action={editSupplierAction} label={supplier.name} hidden={{ supplierId: supplier.id }} typed={typed}>
          <div className="mt-4 space-y-4">

          <FormGrid>
            <TextField label="Name" name="name" defaultValue={supplier.name} required />
            <TextField label="Representative" name="representativeName" defaultValue={supplier.representativeName} />
            <TextField label="Contact no." name="contactNo" defaultValue={supplier.contactNo} />
            <TextField label="Email" name="email" type="email" defaultValue={supplier.email} />
            <TextField label="Address" name="address" defaultValue={supplier.address} />
            <TextField label="TIN" name="tin" defaultValue={supplier.tin} />
          </FormGrid>

          <FormGrid>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">VAT status</span>
              <select name="vatStatus" defaultValue={supplier.vatStatus ?? ''} className={INPUT}>
                <option value="">Not stated</option>
                {SUPPLIER_VAT_STATUSES.map((v) => (
                  <option key={v} value={v}>{VAT_STATUS_LABEL[v] ?? v}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              {/* ⚠️ A LABEL, not a rule — nothing branches on it. See T-188 §4.2. */}
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Classification</span>
              <select name="classification" defaultValue={supplier.classification ?? ''} className={INPUT}>
                <option value="">Not stated</option>
                {SUPPLIER_CLASSIFICATIONS.map((c) => (
                  <option key={c} value={c}>{CLASSIFICATION_LABEL[c]}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Status</span>
              <select name="status" defaultValue={supplier.status} className={INPUT}>
                {SUPPLIER_STATUSES.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </label>
          </FormGrid>

          {/* ⭐ The one ported field that actually does work: it DEFAULTS the document type on a
              new invoice. The invoice owns its own copy thereafter and may disagree. */}
          <label className="flex items-start gap-2 text-sm">
            <input type="hidden" name="issuesOfficialReceiptPresent" value="1" />
            <input
              type="checkbox"
              name="issuesOfficialReceipt"
              defaultChecked={supplier.issuesOfficialReceipt}
              className="mt-1"
            />
            <span>
              Issues an <strong>Official Receipt</strong> (BIR)
              <span className="block text-xs text-neutral-500">
                Defaults the document type when an invoice is logged against this supplier. ⚠️
                Changing it does not alter invoices already recorded.
              </span>
            </span>
          </label>

          <fieldset className="grid gap-3 rounded border border-neutral-200 p-3 sm:grid-cols-2 dark:border-neutral-800">
            <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Payment terms
            </legend>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Terms</span>
              <select
                name="termsMode"
                defaultValue={supplier.creditTermsDays === null ? 'cod' : 'credit'}
                className={INPUT}
              >
                <option value="cod">Cash on delivery (no credit)</option>
                <option value="credit">On credit (AP)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Days to pay</span>
              <input
                type="number"
                name="creditTermsDays"
                min="0"
                max="365"
                step="1"
                defaultValue={supplier.creditTermsDays ?? ''}
                className={INPUT}
              />
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                Cash on delivery means Credit (AP) cannot be used. On credit means Credit is allowed, and is
                pre-selected when a bill is recorded against a verified invoice.
              </span>
            </label>
          </fieldset>

          <fieldset className="grid gap-3 rounded border border-neutral-200 p-3 sm:grid-cols-3 dark:border-neutral-800">
            <legend className="px-1 text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Where payment goes
            </legend>
            <TextField label="Bank or e-wallet" name="bankName" defaultValue={supplier.bankName} />
            <TextField label="Account name" name="bankAccountName" defaultValue={supplier.bankAccountName} />
            <TextField label="Account number" name="bankAccountNumber" defaultValue={supplier.bankAccountNumber} />
          </fieldset>

          <TextField label="Notes" name="notes" defaultValue={supplier.notes} />

          </div>
        </EditableRecord>
      </details>

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
            and how much of each, or press &ldquo;Auto-allocate&rdquo; to fill the empty boxes
            most-overdue-first (T-330) and edit from there. Paying more than allocated routes the
            rest to 1240 (advance).
          </p>
          <AutoAllocatePaymentForm
            postAction={recordPaymentAction}
            previewAction={autoAllocatePaymentAction}
            supplierId={id}
            storeId={storeId}
            items={openItems}
            wallets={wallets}
            today={today()}
          />
        </section>
      )}
    </Page>
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

/** A plain labelled input for the T-188 edit form. Reuses this file's existing `INPUT`. */
function TextField({
  label,
  name,
  defaultValue,
  type = 'text',
  required,
}: {
  label: string;
  name: string;
  defaultValue?: string | null;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue ?? ''}
        className={INPUT}
      />
    </label>
  );
}
