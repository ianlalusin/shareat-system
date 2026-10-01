import { notFound } from 'next/navigation';
import { authorize, AuthorizationError, heldCapabilities } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core/datetime';
import { expensesRepo, apRepo } from '@shareat/db';
import { canViewPhoto } from '../../../../lib/photo-link';
import { peso } from '../../../../lib/format';
import { requireSession } from '../../../../lib/session';
import { verifyInvoiceAction, voidInvoiceAction, setInvoiceLinesAction, voidPaymentAction } from '../../actions';
import { recordExpenseForInvoiceAction } from '../../../expenses/actions';
import { getInvoice, getSupplier, listCategoriesGrouped, itemPickerFor, invoiceLines, INVOICE_LINE_ROWS } from '../../lib';
import { withOrgPrincipal } from '../../../expenses/lib';
import { loadMoneyLines } from '@/lib/money-lines/load';
import { MoneyLines } from '@/components/money/MoneyLines';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';

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

  const [capacity, linkedExpenses, categories, moneyLines] = await Promise.all([
    withOrgPrincipal(orgId, (tx) => apRepo.capacityOf(tx, orgId, id)),
    withOrgPrincipal(orgId, async (tx) => {
      const all = await expensesRepo.listExpenses(tx, { orgId, limit: 500 });
      return all.filter((e) => e.supplierInvoiceId === id);
    }),
    listCategoriesGrouped(orgId),
    loadMoneyLines(orgId, invoice.storeId),
  ]);

  // ⚠️ `remaining >= 1` is load-bearing for C1 below, not just a display gate: a fully paid
  // invoice (remaining 0.00) would seed a Credit initialLine of 0.00, and T-353 marks an initial
  // line touched immediately, so "An amount has to be above zero." would paint on first render —
  // DEF-484's shape, reintroduced by this form's own default.
  const canRecord = invoice.status === 'verified' && Number(capacity?.remaining ?? 0) >= 1;
  const groups: Array<'COGS' | 'OPEX' | 'PERSONAL' | 'CAPEX'> = ['COGS', 'OPEX', 'PERSONAL', 'CAPEX'];
  // C1 (Ian, bible row 247) — a supplier WITH terms defaults to one credit line pre-filled with
  // the remaining amount, so the common case (bill on terms) needs no method click and no empty
  // amount box painted (T-353: an initial line starts touched and is judged at once). A
  // cash-on-delivery supplier gets no initialLines at all — MoneyLines' own blank line is cash.
  const initialLines =
    supplier?.creditTermsDays != null
      ? [{ method: 'credit' as const, amount: capacity?.remaining ?? invoice.totalAmount }]
      : undefined;

  // ⭐ T-196 §6 — what verifying is about to POST. Oldest first, matching verifyInvoice's own
  // posting order (apRepo.liveExpensesForInvoice) exactly, so the running total on screen is the
  // running total the cascade will actually produce.
  const draftExpenses = linkedExpenses
    .filter((e) => e.status === 'draft')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  // T-369 S0 (DEF-550) - the payments that paid this bill, and where the viewer may void them. The
  // domain re-checks everything on submit; this only decides what is OFFERED (bible row 262: a
  // money control renders only where it can be used). `heldCapabilities` is store-blind, so each
  // store is probed with the real `authorize()`: `record_ap_payment` at the payment's store, and
  // `transfer_funds` at the money account's store when that is a different one.
  const payments = await withOrgPrincipal(orgId, (tx) => apRepo.paymentsForInvoice(tx, orgId, id));
  const postedPayments = payments.filter((p) => p.status === 'posted');
  const canVoid = await withOrgPrincipal(orgId, async (tx) => {
    const ok = new Set<string>();
    if (postedPayments.length === 0) return ok;
    const held = await heldCapabilities(tx, actor);
    if (!held.has('record_ap_payment')) return ok;
    const probe = async (capability: 'record_ap_payment' | 'transfer_funds', storeId: string) => {
      try {
        await authorize(tx, actor, capability, { storeId });
        return true;
      } catch (err) {
        if (err instanceof AuthorizationError) return false;
        throw err;
      }
    };
    for (const p of postedPayments) {
      if (!(await probe('record_ap_payment', p.storeId))) continue;
      if (p.moneyAccountStoreId !== p.storeId && !(await probe('transfer_funds', p.moneyAccountStoreId))) continue;
      ok.add(p.paymentId);
    }
    return ok;
  });
  // The photo link is drawn only for someone who can actually open it (the same check the route makes).
  const canViewReceipt = await canViewPhoto(actor, invoice.receiptFileId);
  const today = toBusinessDate();
  const billName = (b: { invoiceId: string; invoiceNo: string | null }) => b.invoiceNo ?? b.invoiceId.slice(0, 8);

  
  // ⭐ T-147: what this supplier has billed before comes first in the picker.
  const picker = await itemPickerFor(orgId, invoice.supplierId);
  const existingLines = await invoiceLines(orgId, invoice.id);

return (
    <Page density="table">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a href="/ap" className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400">
            ← Accounts payable
          </a>
          <h1 className="mt-1 text-2xl font-semibold">
            {supplier?.name ?? invoice.supplierId} — {invoice.invoiceNo ?? id.slice(0, 8)}
          </h1>
          <PageDescription>
            {invoice.invoiceDate}
            {invoice.dueDate ? ` · due ${invoice.dueDate}` : ''}
          </PageDescription>
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
          {invoice.receiptFileId ? (
            <span className="text-green-700 dark:text-green-400">
              photo attached &mdash; uploaded, not typed{' '}
              {canViewReceipt && (
                <a href={`/files/${invoice.receiptFileId}`} target="_blank" rel="noopener noreferrer" className={ACTION_LINK}>
                  View photo
                </a>
              )}
            </span>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">none &mdash; required to verify</span>
          )}
        </div>
      </section>


      {invoice.status === 'pending' && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">What was on this bill</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Itemise it before verifying &mdash; ticking &ldquo;right items, right price&rdquo; only
            means something if the items are on the record. Lines must add up to{' '}
            <strong>{peso(invoice.totalAmount)}</strong>. Leave them blank for a bill with no
            itemised detail (a utility bill), and the invoice still works.
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            ⚠️ <strong>Quantity and unit price are in the unit the supplier billed.</strong> If they
            sell by the case, enter cases &mdash; then set &ldquo;per unit&rdquo; to how many of the
            item&rsquo;s own unit are in one, so ₱/kg stays comparable across suppliers.
          </p>
          <form action={setInvoiceLinesAction} className="space-y-2">
            <input type="hidden" name="invoiceId" value={invoice.id} />
            {Array.from({ length: INVOICE_LINE_ROWS }, (_, n) => n + 1).map((i) => {
              const prior = existingLines[i - 1];
              return (
                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                  <select
                    name={`line${i}_itemId`}
                    defaultValue={prior?.itemId ?? ''}
                    className={`${INPUT} col-span-2`}
                  >
                    <option value="">&mdash;</option>
                    {picker.known.length > 0 && (
                      <optgroup label="Billed by this supplier before">
                        {picker.known.map((k) => (
                          <option key={k.itemId} value={k.itemId}>
                            {k.itemName} ({k.baseUnit})
                            {k.source === 'observed' ? ` · ${k.timesBilled}×` : ' · declared'}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Everything else">
                      {picker.others.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} ({o.baseUnit})
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <input
                    name={`line${i}_quantity`}
                    inputMode="decimal"
                    placeholder="qty"
                    defaultValue={prior?.quantity ?? ''}
                    className={INPUT}
                  />
                  <select name={`line${i}_purchaseUnit`} defaultValue={prior?.purchaseUnit ?? 'pcs'} className={INPUT}>
                    {['pcs', 'kg', 'g', 'ltr', 'ml', 'roll', 'box', 'pack', 'case', 'sack', 'tray', 'dozen'].map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                  <input
                    name={`line${i}_conversionFactor`}
                    inputMode="decimal"
                    placeholder="per unit"
                    defaultValue={prior?.conversionFactor ?? '1'}
                    className={INPUT}
                  />
                  <input
                    name={`line${i}_unitPrice`}
                    inputMode="decimal"
                    placeholder="₱ each"
                    defaultValue={prior?.unitPrice ?? ''}
                    className={INPUT}
                  />
                </div>
              );
            })}
            <button type="submit" className="rounded border border-neutral-300 px-4 py-1.5 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900">
              Save lines
            </button>
          </form>
        </section>
      )}

      {existingLines.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Lines</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Item</th>
                  <th className="px-3 py-2 font-medium">Billed</th>
                  <th className="px-3 py-2 text-right font-medium">Per base unit</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {existingLines.map((l) => (
                  <tr key={l.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <a href={`/items/${l.itemId}`} className="underline hover:no-underline">{l.itemName}</a>
                    </td>
                    <td className="px-3 py-2 text-neutral-500 dark:text-neutral-400">
                      {l.quantity} {l.purchaseUnit} @ {peso(l.unitPrice)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(Number(l.basePrice).toFixed(2))}/{l.baseUnit}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {invoice.status === 'pending' && draftExpenses.length > 0 && (
        <section className="space-y-2 rounded-lg border border-amber-200 p-4 dark:border-amber-900">
          <h2 className="font-medium">What verifying will post</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            The four checks below attest the DOCUMENT is genuine. Posting attests the CODING is
            right — 5100 COGS vs. 6500 Supplies vs. 3200 owner&rsquo;s drawings drives the tax
            treatment, and one click is about to make both assertions. These drafts post the
            instant you verify (T-196).
          </p>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 font-medium">Particulars</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Running total</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  let running = 0;
                  return draftExpenses.map((e) => {
                    const cat = categoryById.get(e.categoryId);
                    running += Number(e.totalAmount);
                    return (
                      <tr key={e.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                        <td className="px-3 py-2">{cat?.category ?? e.categoryId}</td>
                        <td className="px-3 py-2 font-mono text-xs text-neutral-500 dark:text-neutral-400">
                          {cat?.accountCode ?? <span className="text-red-600 dark:text-red-400">unmapped — will block</span>}
                        </td>
                        <td className="px-3 py-2">
                          <a href={`/expenses/${e.id}`} className="underline hover:no-underline">{e.particulars}</a>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(e.totalAmount)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(running.toFixed(2))}</td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {invoice.status === 'pending' && (
        <form
          action={verifyInvoiceAction}
          className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input type="hidden" name="invoiceId" value={invoice.id} />
          <h2 className="font-medium">Verify this invoice</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Check the paper against what was entered, and confirm each part. Verifying is the
            approval &mdash; expenses can be recorded against it the moment you do.
            <strong className="ml-1">You cannot verify an invoice you logged yourself.</strong>
          </p>
          <div className="space-y-2 text-sm">
            {[
              ['attestSupplier', 'The bill is from the supplier it names'],
              ['attestInvoice', 'Invoice number, date and total match the paper'],
              ['attestItems', 'The items listed are the items received'],
              ['attestPrice', 'The prices charged are the prices agreed'],
            ].map(([name, label]) => (
              <label key={name} className="flex items-start gap-3">
                <input type="checkbox" name={name} className="mt-0.5" />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <button
            type="submit"
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
          >
            Verify &mdash; all four must be checked
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

      {payments.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Payments against this bill</h2>
          <ul className="space-y-3">
            {payments.map((p) => (
              <li key={p.paymentId} className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-medium">{p.businessDate}</span>
                  <span className="font-mono tabular-nums">{peso(p.amount)}</span>
                </div>
                <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-xs text-neutral-500 sm:grid-cols-2 dark:text-neutral-400">
                  <div>Applied to this bill: <span className="font-mono tabular-nums">{peso(p.appliedHere)}</span></div>
                  <div>From: {p.moneyAccountName}</div>
                  {p.referenceNo && <div>Reference: {p.referenceNo}</div>}
                  <div>
                    {p.status === 'voided'
                      ? `Voided — ${p.voidReason ?? 'no reason recorded'}`
                      : p.status === 'posted'
                        ? 'Posted'
                        : p.status}
                  </div>
                </dl>
                {p.otherBills.length > 0 && (
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    Also pays{' '}
                    {p.otherBills.map((b, i) => (
                      <span key={b.invoiceId}>
                        {i > 0 && ', '}
                        <a href={`/ap/invoices/${b.invoiceId}`} className={ACTION_LINK}>{billName(b)}</a>
                      </span>
                    ))}
                  </p>
                )}
                {p.status === 'posted' && canVoid.has(p.paymentId) && (
                  <details className="mt-2">
                    <summary className="inline-flex min-h-[44px] cursor-pointer items-center px-1 text-sm font-medium">
                      Void this payment
                    </summary>
                    <form action={voidPaymentAction} className="mt-2 space-y-3">
                      <input type="hidden" name="paymentId" value={p.paymentId} />
                      <input type="hidden" name="supplierId" value={p.supplierId} />
                      <input type="hidden" name="invoiceId" value={invoice.id} />
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        The payment is reversed, not deleted, and the bills it paid are owed again.
                        {p.otherBills.length > 0 && ` This also re-opens ${p.otherBills.map(billName).join(', ')}.`}
                      </p>
                      <Field label="Reason">
                        <input name="reason" required className={INPUT} />
                      </Field>
                      {!p.periodOpen && (
                        <Field
                          label="Reversal date"
                          hint="This payment is in a closed month. The reversal is dated in an open month."
                        >
                          <input name="voidOn" type="date" required defaultValue={today} className={INPUT} />
                        </Field>
                      )}
                      <button
                        type="submit"
                        className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
                      >
                        Void payment
                      </button>
                    </form>
                  </details>
                )}
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
          <form action={recordExpenseForInvoiceAction} className="space-y-3">
            <input type="hidden" name="returnTo" value={`/ap/invoices/${invoice.id}`} />
            <input type="hidden" name="supplierId" value={invoice.supplierId} />
            <input type="hidden" name="supplierInvoiceId" value={invoice.id} />
            <input type="hidden" name="storeId" value={invoice.storeId} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <select name="categoryId" required defaultValue="" className={INPUT}>
                  <option value="" disabled>Select…</option>
                  {/* ⭐ T-229 slice 2 — active only: this select adds a NEW line. The same
                      `categories` list still labels the EXISTING lines above, retired ones
                      included. */}
                  {groups.map((g) => {
                    const rows = categories.filter((c) => c.group === g && c.isActive);
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
            <div>
              <h2 className="mb-2 text-sm font-medium">
                Payments — add a line for each place the money came from.
              </h2>
              <MoneyLines
                direction="out"
                sources={moneyLines.sources}
                staff={moneyLines.staff}
                supplierId={invoice.supplierId}
                supplierName={supplier?.name ?? null}
                supplierCreditTermsDays={supplier?.creditTermsDays ?? null}
                initialLines={initialLines}
              />
            </div>
            <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900">
              Record expense
            </button>
          </form>
        </section>
      )}

      {invoice.status !== 'voided' && (
        <form action={voidInvoiceAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-red-200 p-4 text-sm dark:border-red-900 gap-y-2">
          <input type="hidden" name="invoiceId" value={invoice.id} />
          <Field label="Void reason">
            <input name="reason" required className={INPUT} />
          </Field>
          <button type="submit" className="rounded border border-red-300 px-4 py-2 font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
            Void — cascades through every linked expense
          </button>
        </form>
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
