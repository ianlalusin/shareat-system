import { notFound } from 'next/navigation';
import { transaction, expensesRepo, journalRepo } from '@shareat/db';
import { formatMoney, money } from '@shareat/core/money';
import { listOrgs, listStores, listActingPersons, listCategoriesGrouped } from '../lib';
import { approveExpenseAction, voidExpenseAction, updateDraftAction, deleteDraftAction } from '../actions';

// Derived from the repo function rather than re-declared — the table renders exactly what
// that reader returns, so the two cannot drift.
type EntryLineWithAccountCode = Awaited<ReturnType<typeof journalRepo.findLinesForEntryWithAccountCodes>>[number];

export const metadata = { title: 'Expense — Shareat System' };

// Always dynamic — reads searchParams and the database on every request, same as the list.
export const dynamic = 'force-dynamic';

interface SearchParams {
  org?: string;
  store?: string;
  as?: string;
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
  const sp = await searchParams;

  const orgs = await listOrgs();
  if (orgs.length === 0) notFound();
  const orgId = sp.org && orgs.some((o) => o.id === sp.org) ? sp.org : orgs[0]!.id;

  const expense = await transaction((tx) => expensesRepo.getExpenseById(tx, orgId, id));
  if (!expense) notFound();

  const [payments, stores, persons, categories] = await Promise.all([
    transaction((tx) => expensesRepo.getPaymentsForExpense(tx, expense.id)),
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
    ? await transaction(async (tx) => {
        const original = await journalRepo.findLinesForEntryWithAccountCodes(tx, entryId);
        const reversal = await journalRepo.findReversalOfEntry(tx, orgId, entryId);
        return {
          lines: original,
          reversalId: reversal?.id ?? null,
          reversalLines: reversal ? await journalRepo.findLinesForEntryWithAccountCodes(tx, reversal.id) : [],
        };
      })
    : { lines: [], reversalId: null, reversalLines: [] };

  const actingPersonId =
    sp.as && persons.some((p) => p.id === sp.as)
      ? sp.as
      : (persons.find((p) => p.role === 'manager')?.id ?? persons[0]?.id ?? '');

  const storeById = new Map(stores.map((s) => [s.id, s]));
  const categoryLabel = (() => {
    const c = categories.find((x) => x.id === expense.categoryId);
    return c ? `${c.group} — ${c.category}` : expense.categoryId;
  })();
  const personName = (personId: string | null): string =>
    personId ? (persons.find((p) => p.id === personId)?.displayName ?? personId) : '—';

  const qs = new URLSearchParams();
  qs.set('org', orgId);
  if (sp.store) qs.set('store', sp.store);
  if (actingPersonId) qs.set('as', actingPersonId);
  const carry = qs.toString();

  const isDraft = expense.status === 'draft';
  const isPosted = expense.status === 'posted';

  // A hidden control is not a control (DEF-051) — the domain re-checks every one of these,
  // and these fields only decide what is worth OFFERING.
  const hiddenIds = (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="storeId" value={sp.store ?? ''} />
      <input type="hidden" name="actingPersonId" value={actingPersonId} />
      <input type="hidden" name="expenseId" value={expense.id} />
    </>
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a href={`/expenses?${carry}`} className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400">
            ← All expenses
          </a>
          <h1 className="mt-1 text-2xl font-semibold">{expense.particulars}</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {expense.businessDate} · {storeById.get(expense.storeId)?.name ?? expense.storeId} · {categoryLabel}
          </p>
        </div>
        <div className="text-right">
          <StatusBadge status={expense.status} />
          <p className="mt-2 text-2xl font-semibold tabular-nums">{formatMoney(money(expense.totalAmount))}</p>
        </div>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </div>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-3 font-medium">Trail</h2>
          <dl className="space-y-1.5">
            <Row label="Created by" value={personName(expense.createdBy)} />
            <Row label="Approved by" value={personName(expense.approvedBy)} />
            <Row label="Posted at" value={expense.postedAt ? expense.postedAt.toISOString() : '—'} />
            {expense.status === 'voided' && (
              <>
                <Row label="Voided by" value={personName(expense.voidedBy)} />
                <Row label="Void reason" value={expense.voidReason ?? '—'} />
              </>
            )}
            <Row
              label="Receipt photo"
              value={
                expense.receiptPhotoUrl ? (
                  <a href={expense.receiptPhotoUrl} className="underline hover:no-underline">
                    attached
                  </a>
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">none</span>
                )
              }
            />
          </dl>
        </div>

        <div className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-3 font-medium">Payments</h2>
          <table className="w-full border-collapse">
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                  <td className="py-1.5">{METHOD_LABEL[p.method] ?? p.method}</td>
                  <td className="py-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {p.accountCode === 'office' ? 'office cash' : p.staffId ? personName(p.staffId) : ''}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatMoney(money(p.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

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

      {isDraft && (
        <section className="grid gap-4 md:grid-cols-2">
          <form
            action={updateDraftAction}
            className="space-y-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800"
          >
            {hiddenIds}
            <h2 className="font-medium">Correct this draft</h2>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Category</span>
              <select
                name="categoryId"
                defaultValue={expense.categoryId}
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.group} — {c.category}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Particulars</span>
              <input
                name="particulars"
                defaultValue={expense.particulars}
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Receipt photo URL</span>
              <input
                name="receiptPhotoUrl"
                defaultValue={expense.receiptPhotoUrl ?? ''}
                className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <button
              type="submit"
              className="rounded border border-neutral-300 px-4 py-1.5 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Save draft
            </button>
          </form>

          <form
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
            <button
              type="submit"
              className="rounded bg-neutral-900 px-4 py-1.5 font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Approve &amp; post
            </button>
          </form>
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
          <button
            type="submit"
            className="rounded border border-neutral-300 px-4 py-1.5 font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Delete draft
          </button>
        </form>
      )}

      {isPosted && (
        <form
          action={voidExpenseAction}
          className="space-y-3 rounded-lg border border-red-200 p-4 text-sm dark:border-red-900"
        >
          {hiddenIds}
          <h2 className="font-medium text-red-800 dark:text-red-300">Void</h2>
          <p className="text-neutral-600 dark:text-neutral-400">
            A posted expense is voided by <strong>reversing</strong> its entry — the original stays
            visible, and both sides remain in the ledger. A reason is required.
          </p>
          <div className="flex gap-2">
            <input
              name="reason"
              required
              placeholder="Why is this being voided?"
              className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <button
              type="submit"
              className="rounded border border-red-300 px-4 py-1.5 font-medium text-red-800 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
            >
              Void
            </button>
          </div>
        </form>
      )}
    </main>
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

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'posted'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
      : status === 'voided'
        ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
        : 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';
  const label = status === 'posted' ? 'Posted' : status === 'voided' ? 'Voided' : 'Draft';
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
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
              <td className="px-3 py-2 font-mono">{l.accountCode}</td>
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
