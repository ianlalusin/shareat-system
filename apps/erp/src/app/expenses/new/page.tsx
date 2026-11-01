import { listStores, listActiveCategoriesGrouped } from '../lib';
import { loadMoneyLines } from '@/lib/money-lines/load';
import { listOpenInvoicesForPicker, peso } from '../../ap/lib';
import { requireSession } from '../../../lib/session';
import { createExpenseAction } from '../actions';
import { budgetsRepo } from '@shareat/db';
import { withOrgPrincipal } from '../lib';
import { BudgetHint } from './BudgetHint';
import { InvoicePartsPicker } from '@/components/expenses/InvoicePartsPicker';
import { invoicePartsView } from '../parts-view';
import { CheckedForm, FieldCheck, RuleCheck } from '@/components/forms';
import { buildNewExpenseFacts } from '@shareat/domain/business-rules';
import { EXPENSE_CREATE_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { Banner, FlashBanner, FormGrid, Select } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';

export const metadata = { title: 'New expense — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}


export default async function NewExpensePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);

  const { actor } = await requireSession('/expenses/new');
  const orgId = actor.orgId;

  const [storeRows, categories] = await Promise.all([listStores(orgId), listActiveCategoriesGrouped(orgId)]);
  const storeId = sp.store && storeRows.some((s) => s.id === sp.store) ? sp.store : (storeRows[0]?.id ?? '');
  // T-414 (ruling 2): the invoice list follows the store, as the action already requires (it refuses another store's invoice).
  const invoices = await listOpenInvoicesForPicker(orgId, storeId || undefined);
  // T-475 E1-E3 (R8): the facts the live lines read come from the same builder the domain uses; C2: the picked invoice's supplier feeds Credit.
  const invoiceFacts = buildNewExpenseFacts(invoices);
  const invoiceSuppliers = Object.fromEntries(
    invoices.map((inv) => [inv.id, { supplierId: inv.supplierId, supplierName: inv.supplierName, creditTermsDays: inv.creditTermsDays }]),
  );

  // ⭐ T-266 — accounts with their LEDGER balances plus every open float at this store, flattened
  // into one list. Scoped to the store (DEF-291); the picker used to offer every account in the
  // org to everyone.
  const moneyLines = await loadMoneyLines(orgId, storeId, actor);

  // T-215 §5 — the caps for THIS store and THIS period, so the person spending sees what is left
  // before they commit. ⚠️ Read only: `manage_expense_budgets` is needed to SET a cap and must not
  // be needed to SEE one, or the number is hidden from the only person it is for.
  const periodKey = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7).replace('-', '');
  const caps = storeId
    ? await withOrgPrincipal(orgId, (tx) => budgetsRepo.listForStorePeriod(tx, orgId, storeId, periodKey))
    : [];

  // T-502 section 12: each pickable invoice's parts (its lines grouped by category, plus Uncategorised and Fees), with what is left.
  const partsByInvoice = Object.fromEntries(
    await Promise.all(invoices.map(async (inv) => [inv.id, await invoicePartsView(orgId, inv.id, categories)] as const)),
  );

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">New expense</h1>
        <PageDescription>
          Saves as a <strong>draft</strong> against the supplier invoice you pick — verified or
          still pending. No manager and no verification wait: verifying the invoice later posts
          this automatically, or approve it yourself from the expense once you can (T-196). No
          invoice to pick from?{' '}
          <a href="/ap" className="underline">Log one first</a>. <strong>Pick the store first</strong> —
          the invoices and the cash requests offered are that store&apos;s, and switching store starts the form over.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} fieldLabels={{ store: 'Store' }} />

      {!storeId ? (
        <Banner tone="warning">
          This org needs at least one store before an expense can be created. Go back to the{' '}
          <a className="text-sm underline" href="/expenses">expenses list</a>.
        </Banner>
      ) : (
        <>
        {/* ⭐ T-414 (ruling 1): the store is the FIRST decision, a GET filter row (the app's standing pattern). The
            expense form below carries it as a hidden input, so the page, the action and the lists all read one store.
            Nothing typed travels in this URL (T-380); switching store reloads and clears the form. */}
        <FilterRow submitLabel="Use this store">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Store</span>
            <Select id="store" name="store" defaultValue={storeId} invalid={sp.field === 'store'}>
              {storeRows.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </label>
        </FilterRow>
        <CheckedForm rules={EXPENSE_CREATE_RULES} action={createExpenseAction} className="space-y-6">
          <input type="hidden" name="storeId" value={storeId} />
          {/* ⭐ T-215. The cap matters at the moment of spending — a report at month end is a
              post-mortem. Renders nothing until a capped category is picked. */}
          {caps.length > 0 && (
            <BudgetHint
              periodKey={periodKey}
              caps={caps.map((c) => ({
                categoryId: c.categoryId,
                label: c.categoryLabel,
                amount: c.amount,
                consumed: c.consumed,
                remaining: c.remaining,
              }))}
            />
          )}
          {/* ⭐ No orgId, no "acting as" — the session supplies both (T-138). */}
          <FormGrid>
            <Field
              label={
                <>
                  Supplier invoice <span className="italic">(sets the date and the supplier)</span>
                </>
              }
              rule={EXPENSE_CREATE_RULES.supplierInvoiceId}
            >
              <Select {...nativeAttrs(EXPENSE_CREATE_RULES.supplierInvoiceId)} defaultValue="">
                <option value="" disabled>
                  {invoices.length === 0 ? 'No open invoices yet' : 'Select…'}
                </option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {/* One string (not several text nodes), so the mark reads as one label everywhere. F5: an inactive supplier's invoice is listed but marked. */}
                    {`${inv.supplierName} — ${inv.invoiceNo ?? inv.id.slice(0, 8)} (${inv.invoiceDate}) — ${peso(inv.remaining)} left${inv.status === 'pending' ? ' — pending' : ' — verified'}${inv.supplierStatus === 'active' ? '' : ' — supplier inactive'}`}
                  </option>
                ))}
              </Select>
            </Field>

          </FormGrid>

          {/* ⭐ T-502 section 12: the expense follows the bill's items. "Which part of this bill?" replaces the free Category select;
              it pre-fills Particulars and the first payment, and a bill with no lines gets a panel (Save stays off). */}
          <InvoicePartsPicker
            views={partsByInvoice}
            categories={categories}
            particularsRule={EXPENSE_CREATE_RULES.particulars}
            payments={{
              moneyLines: {
                sources: moneyLines.sources,
                otherStoreSources: moneyLines.otherStoreSources,
                storeNames: moneyLines.storeNames,
                staff: moneyLines.staff,
              },
              invoices: invoiceSuppliers,
            }}
          />

          {/* T-475 E1-E3: the business rules, live. Each prints its own sentence (the same one the server refuses with) and turns Save off. */}
          <RuleCheck id="expense.new.amountWithinRemaining" facts={invoiceFacts} />
          <RuleCheck id="expense.new.creditNeedsTerms" facts={invoiceFacts} />
          <RuleCheck id="expense.new.supplierActive" facts={invoiceFacts} />

          <SubmitButton pendingLabel="Saving…">Save draft</SubmitButton>
        </CheckedForm>
        </>
      )}
    </Page>
  );
}

function Field({ label, rule, className, children }: { label: React.ReactNode; rule: FieldRule; className?: string; children: React.ReactNode }) {
  // T-440: the label keeps its look; the live helper line sits OUTSIDE it (never part of the accessible name).
  return (
    <div className={className}>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{label}</span>
        {children}
      </label>
      <FieldCheck rule={rule} />
    </div>
  );
}
