import { notFound } from 'next/navigation';
import { expensesRepo, journalRepo } from '@shareat/db';
import { formatMoney, money } from '@shareat/core/money';
import { previewExpenseApproval } from '@shareat/domain';
import { buildCategoryFacts } from '@shareat/domain/business-rules';
import { listStores, listActingPersons, listCategoriesGrouped } from '../lib';
import { requireSession } from '../../../lib/session';
import { approveExpenseAction, voidExpenseAction, updateDraftAction, deleteDraftAction } from '../actions';
import { withOrgPrincipal } from '../lib';
import { canOverrideClosedMonth } from '../reimbursements/lib';
import { closedMonthOf, closedMonths } from '../../../lib/period-override';
import { ClosedMonthOverride } from '@/components/ClosedMonthOverride';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { personName } from '@/lib/person-name';
import { typedFor } from '@/lib/keep-typing';
import { EXPENSE_APPROVE, EXPENSE_DRAFT_EDIT } from '../typed-forms';
import { CheckedForm, EditableRecord, RuleCheck } from '@/components/forms';
import { EXPENSE_APPROVE_RULES, EXPENSE_DRAFT_EDIT_RULES, EXPENSE_VOID_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { accountCodeAndName } from '@/lib/account-label';
import { Badge, Button, CardGrid, ConfirmDestructive, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';

// Derived from the repo function rather than re-declared — the table renders exactly what
// that reader returns, so the two cannot drift.
type EntryLineWithAccountCode = Awaited<ReturnType<typeof journalRepo.findLinesForEntryWithAccountCodes>>[number];

export const metadata = { title: 'Expense — Shareat System' };

// Always dynamic — reads searchParams and the database on every request, same as the list.
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  online: 'Online / e-wallet',
  credit: 'On credit (AP)',
  reimbursable: 'Reimbursable to staff',
  other: 'Other',
  ar_collection: 'AR collection',
};

export default async function ExpenseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);

  const { actor } = await requireSession(`/expenses/${id}`);
  const orgId = actor.orgId;

  const expense = await withOrgPrincipal(orgId, (tx) => expensesRepo.getExpenseById(tx, orgId, id));
  if (!expense) notFound();

  const [payments, stores, persons, categories] = await Promise.all([
    withOrgPrincipal(orgId, (tx) => expensesRepo.getPaymentsForExpense(tx, expense.id)),
    listStores(orgId),
    listActingPersons(orgId),
    listCategoriesGrouped(orgId),
  ]);

  // The posted ledger entry, read only when there is one. **This is the whole point of the
  // screen**: an expense that claims to be posted but shows no balanced entry is exactly the
  // failure T-122's invariants exist to make impossible, so the proof belongs on the page
  // rather than in a test nobody re-runs while looking at real data.
  //
  // ⚠️ Shown whenever an entry EXISTS — not only while the expense is posted. A void is a
  // REVERSAL, not a delete: the original stays in the ledger and so must stay on the page.
  // Hiding it on void would make the screen contradict its own void copy, and would quietly
  // teach the reader that voiding erases something.
  const entryId = expense.journalEntryId;
  const { lines, reversalId, reversalLines } = entryId
    ? await withOrgPrincipal(orgId, async (tx) => {
        const original = await journalRepo.findLinesForEntryWithAccountCodes(tx, entryId);
        const reversal = await journalRepo.findReversalOfEntry(tx, orgId, entryId);
        return {
          lines: original,
          reversalId: reversal?.id ?? null,
          reversalLines: reversal ? await journalRepo.findLinesForEntryWithAccountCodes(tx, reversal.id) : [],
        };
      })
    : { lines: [], reversalId: null, reversalLines: [] };


  const storeById = new Map(stores.map((s) => [s.id, s]));
  const categoryLabel = (() => {
    const c = categories.find((x) => x.id === expense.categoryId);
    return c ? `${c.group} — ${c.category}` : expense.categoryId;
  })();

  const qs = new URLSearchParams();
  if (sp.store) qs.set('store', sp.store);
  const carry = qs.toString();

  const isDraft = expense.status === 'draft';
  const isPosted = expense.status === 'posted';

  // T-369 S5b: the closed-month control is offered only to a holder of `override_period_lock`, and only for a draft
  // whose own date is in a closed month. T-475 F7: whether the viewer holds it is asked of everyone (can(), no denial row),
  // because the month's status below is shown to EVERY viewer, not just to the holder.
  const canOverride = isDraft ? await canOverrideClosedMonth(actor) : false;
  const closedMonth = isDraft && canOverride ? closedMonthOf(await closedMonths(orgId), expense.businessDate) : undefined;

  // T-475 P1-P3 (R8, R9, R10): what Approve & post would say, from the SAME evaluator the real approval runs (see
  // previewExpenseApproval). It asks can(), never authorize(): a page view writes no denial row. A preview that cannot be read
  // gives NO verdict (the server re-checks every approval); it never takes the page down.
  const approveFacts = isDraft ? await withOrgPrincipal(orgId, (tx) => previewExpenseApproval(tx, actor, expense.id, { canOverride })) : null;
  // T-475 E4: the draft's category facts (the draft's own current category always stays allowed).
  const categoryFacts = buildCategoryFacts(
    expense.categoryId,
    categories.map((c) => ({ id: c.id, accountCode: c.accountCode })),
  );
  // T-475 R14: a refused approval reopens with the closed-month override reason and note still in place.
  const typedApprove = typedFor(sp, EXPENSE_APPROVE, expense.id, actor.personId);
  const typedApproveField = (name: string): string | undefined => {
    const v = typedApprove?.kind === 'typed' ? typedApprove.fields[name] : undefined;
    return Array.isArray(v) ? v[0] : v;
  };

  // A hidden control is not a control (DEF-051) — the domain re-checks every one of these,
  // and these fields only decide what is worth OFFERING.
  const hiddenIds = (
    <>
      <input type="hidden" name="storeId" value={sp.store ?? ''} />
      <input type="hidden" name="expenseId" value={expense.id} />
    </>
  );

  return (
    <Page view="detail" sectioned density="table">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a href={`/expenses?${carry}`} className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400">
            ← All expenses
          </a>
          <h1 className="mt-1 text-2xl font-semibold">{expense.particulars}</h1>
          <PageDescription>
            {expense.businessDate} · {storeById.get(expense.storeId)?.name ?? expense.storeId} · {categoryLabel}
          </PageDescription>
        </div>
        <div className="text-right">
          <Badge status={expense.status} />
          <p className="mt-2 text-2xl font-semibold tabular-nums">{formatMoney(money(expense.totalAmount))}</p>
        </div>
      </div>

      <FlashBanner flash={sp} />

      {/* T-448: the short cards (Trail, Payments, and for a draft Correct + Approve) share rows. */}
      <CardGrid>
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-3 font-medium">Trail</h2>
          <dl className="space-y-1.5">
            <Row label="Created by" value={personName(persons, expense.createdBy)} />
            <Row label="Approved by" value={personName(persons, expense.approvedBy)} />
            <Row label="Posted at" value={expense.postedAt ? expense.postedAt.toISOString() : '—'} />
            {expense.status === 'voided' && (
              <>
                <Row label="Voided by" value={personName(persons, expense.voidedBy)} />
                <Row label="Void reason" value={expense.voidReason ?? '—'} />
              </>
            )}
            <Row
              label="Supplier invoice"
              value={
                <a href={`/ap/invoices/${expense.supplierInvoiceId}`} className="underline hover:no-underline">
                  view — the evidence lives there now (T-130)
                </a>
              }
            />
          </dl>
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-3 font-medium">Payments</h2>
          <table data-card-columns="Payment method|Paid from|Amount" className="w-full border-collapse">
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="py-1.5">{METHOD_LABEL[p.method] ?? p.method}</td>
                  <td className="py-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {p.accountCode === 'office' ? 'office cash' : p.staffId ? personName(persons, p.staffId) : ''}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoney(money(p.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isDraft && (
          <>
            <div className="space-y-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
              <h2 className="font-medium">Correct this draft</h2>
              <p className="text-neutral-600 dark:text-neutral-400">Change the category or particulars.</p>
              <EditableRecord
                rules={EXPENSE_DRAFT_EDIT_RULES}
                action={updateDraftAction}
                label="draft"
                hidden={{ storeId: sp.store ?? '', expenseId: expense.id }}
                saveLabel="Save draft"
                typed={typedFor(sp, EXPENSE_DRAFT_EDIT, expense.id, actor.personId)}
              >
                <FormGrid layout="fields">
                  <Field label="Category" width="name">
                    <Select name="categoryId" defaultValue={expense.categoryId} className="w-full">
                      {/* ⭐ T-229 slice 2 — retired categories are hidden UNLESS this expense already
                          carries one. Filtering them out unconditionally would silently re-point the
                          expense at whatever option happened to be first when the form was saved. */}
                      {categories
                        .filter((c) => c.isActive || c.id === expense.categoryId)
                        .map((c) => (
                          // T-475 E4 / F4: a category with no ledger account is offered but disabled, as on the new-expense form -
                          // except the one this draft already sits on (R12), which stays selectable so a re-save keeps it.
                          <option key={c.id} value={c.id} disabled={!c.accountCode && c.id !== expense.categoryId}>
                            {c.group} — {c.category}
                            {c.isActive ? '' : ' (retired)'}
                            {!c.accountCode ? ' (unmapped — cannot post)' : ''}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field label="Particulars" width="long">
                    <Input name="particulars" defaultValue={expense.particulars} className="w-full" />
                  </Field>
                </FormGrid>
                <RuleCheck id="expense.edit.categoryMapped" facts={categoryFacts} />
              </EditableRecord>
            </div>

            <CheckedForm
              rules={EXPENSE_APPROVE_RULES}
              action={approveExpenseAction}
              className="flex flex-col justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800"
            >
              {hiddenIds}
              <div>
                <h2 className="font-medium">Approve &amp; post</h2>
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                  Posts the balanced entry to the ledger. <strong>Irreversible except by a void</strong>,
                  which reverses rather than deletes.
                </p>
              </div>
              {closedMonth && (
                <>
                  <input type="hidden" name="expenseDate" value={expense.businessDate} />
                  <ClosedMonthOverride
                    closedMonths={[closedMonth]}
                    dateFieldName="expenseDate"
                    initialDate={expense.businessDate}
                    defaults={{ confirm: typedApproveField('periodOverrideConfirm') === 'on', reason: typedApproveField('periodOverrideReason'), note: typedApproveField('periodOverrideNote') }}
                  />
                </>
              )}
              {/* T-475 P1-P3: the business rules, live. Each prints its own sentence (the same one the server refuses with) and turns Save off. */}
              <RuleCheck id="expense.approve.invoiceVerified" facts={approveFacts?.invoice} />
              <RuleCheck id="expense.approve.wouldPost" facts={approveFacts?.wouldPost} />
              <RuleCheck id="expense.approve.periodOpen" facts={approveFacts?.period} />
              <Button type="submit" variant="primary">
                Approve &amp; post
              </Button>
            </CheckedForm>
          </>
        )}
      </CardGrid>

      {entryId && (
        <section className="space-y-4">
          <div className="space-y-2">
            <h2 className="font-medium">
              Ledger entry{' '}
              <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{entryId}</span>
            </h2>
            <LedgerTable lines={lines} />
          </div>

          {reversalId && (
            <div className="space-y-2">
              <h2 className="font-medium">
                Reversing entry{' '}
                <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{reversalId}</span>
              </h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                The void posted this. <strong>Both entries stand</strong> — the ledger records what
                happened and what undid it, and neither is removed.
              </p>
              <LedgerTable lines={reversalLines} />
            </div>
          )}
        </section>
      )}

      {/* ⭐ The two endings, and they are deliberately NOT the same control.
          A draft is DELETED — it is not a financial record, so nothing needs to survive it.
          A posted expense is VOIDED, which reverses and leaves both entries standing.
          Each is offered only in the state where it is legal, so neither button can produce
          a guaranteed error, and the wording of each says which kind of ending it is. */}
      {isDraft && (
        <form
          action={deleteDraftAction}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800"
        >
          {hiddenIds}
          <p className="text-neutral-600 dark:text-neutral-400">
            <strong className="text-neutral-900 dark:text-neutral-100">Delete this draft.</strong> Nothing
            has posted, so there is nothing to reverse — it is removed outright.
          </p>
          <Button type="submit" variant="danger">
            Delete draft
          </Button>
        </form>
      )}

      {isPosted && (
        <CheckedForm
          rules={EXPENSE_VOID_RULES}
          action={voidExpenseAction}
          className="space-y-3 rounded-lg border border-danger p-4 text-sm"
        >
          {hiddenIds}
          <h2 className="font-medium text-danger">Void</h2>
          <p className="text-neutral-600 dark:text-neutral-400">
            A posted expense is voided by <strong>reversing</strong> its entry — the original stays
            visible, and both sides remain in the ledger. A reason is required.
          </p>
          <div className="flex gap-2">
            <Field label={<span className="sr-only">Reason</span>} rule={EXPENSE_VOID_RULES.reason} className="flex-1">
              <Input {...nativeAttrs(EXPENSE_VOID_RULES.reason)} placeholder="Why is this being voided?" />
            </Field>
            <ConfirmDestructive
              tier="admin-pin"
              label="Void expense"
              consequence="Reverses this posted expense. An administrator must approve with their own PIN."
            />
          </div>
        </CheckedForm>
      )}
    </Page>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function LedgerTable({ lines }: { lines: EntryLineWithAccountCode[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Account</th>
            <th className="px-3 py-2 font-medium">Party</th>
            <th className="px-3 py-2 text-right font-medium">Debit</th>
            <th className="px-3 py-2 text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineNo} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
              <td className="px-3 py-2 text-neutral-400">{l.lineNo}</td>
              <td className="px-3 py-2">{accountCodeAndName(l.accountCode)}</td>
              <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                {l.partyType ? `${l.partyType}:${l.partyId}` : '—'}
              </td>
              {/* Blank, not ₱0.00 — a ledger reads by the shape of its two columns, and a zero
                  on every line destroys that. Compared NUMERICALLY: Postgres returns
                  numeric(14,2) as "0.00", so a string test against '0' never matches and every
                  cell prints. Found by looking at the rendered page, not by reading the code. */}
              <td className="px-3 py-2 text-right tabular-nums">
                {Number(l.debit) === 0 ? '' : formatMoney(money(l.debit))}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">
                {Number(l.credit) === 0 ? '' : formatMoney(money(l.credit))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
