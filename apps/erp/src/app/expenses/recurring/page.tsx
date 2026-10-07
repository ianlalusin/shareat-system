import Link from 'next/link';
import { RECURRING_INTERVALS } from '@shareat/db/schema';
import { requireSession } from '../../../lib/session';
import {
  createTemplateAction,
  deleteTemplateAction,
  setTemplateStatusAction,
  updateTemplateAction,
} from './actions';
import {
  INTERVAL_LABEL,
  WEEKDAYS,
  accountsFor,
  anchorLabel,
  periodsBehind,
  suppliersFor,
  categories,
  listStores,
  listTemplates,
  peso,
  today,
} from './lib';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { Input } from '@/components/ui';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Recurring expenses — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * T-216 — the fixed bills that should not depend on somebody remembering them.
 *
 * ⭐ **The job is built** (T-216 Part 2). Ian answered the open question on 6-7 Sep 2026: a due
 * template DRAFTS, it never auto-pays. Every morning the job records a PENDING supplier invoice and
 * a DRAFT expense for each due template, and stops — nothing reaches the ledger until a person
 * attaches the real bill, verifies the invoice and approves the expense.
 *
 * ⚠️ **The banner this screen used to carry said the job did not exist**, and it was right at the
 * time. What replaces it is the remaining honest caveat, not silence: a template with NO SUPPLIER
 * cannot draft, and the screen names those templates rather than letting them fail nightly in a log
 * nobody reads. A feature that quietly does nothing is the defect class this project keeps hitting
 * (DEF-190 and the eight before it).
 */
interface SearchParams {
  store?: string;
  ok?: string;
  error?: string;
}

export default async function RecurringExpensesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/expenses/recurring');
  const orgId = actor.orgId;

  const stores = await listStores(orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : (stores[0]?.id ?? '');
  const [templates, cats, accounts, suppliers] = storeId
    ? await Promise.all([
        listTemplates(orgId, storeId),
        categories(orgId),
        accountsFor(orgId, storeId),
        suppliersFor(orgId),
      ])
    : [[], [], [], []];

  const now = today();
  // ⛔ The job refuses these, loudly, every night. Saying so here is the difference between a
  // configuration fault somebody can fix and a bill that quietly stopped being drafted.
  const unsetSupplier = templates.filter((t) => t.status === 'active' && !t.supplierId);

  return (
    <Page density="table">
      <div>
        <Link href="/expenses" className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400">
          ← Expenses
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Recurring expenses</h1>
        <PageDescription>
          The fixed bills — rent, internet, utilities, subscriptions, leases. A branch that forgets
          rent does not fail to pay it; it pays it late, off-book, and the month closes wrong.
        </PageDescription>
      </div>

      {/* ⛔ The banner that said "the job is not built" is gone because the job is built. What
          stays is the one thing that still silently does nothing: a template with no supplier. It
          is named here rather than failing nightly into a log nobody opens (T-229's TIN shape). */}
      {/* ⚠️ A workflow consequence, not a bug, and worth saying before somebody hits it: the job
          logs the invoice as the template's creator, and `verifyInvoice` refuses whoever logged an
          invoice ("verification is a second pair of eyes"). Keeping that control is deliberate — a
          system actor would have made every recurring invoice self-verifiable by anyone. */}
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        A bill drafted from a template must be verified by someone other than the person who set the
        template up — the job logs the invoice in their name.
      </p>

      {unsetSupplier.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          <strong className="font-medium">
            {unsetSupplier.length === 1
              ? '1 template cannot draft yet.'
              : `${unsetSupplier.length} templates cannot draft yet.`}
          </strong>{' '}
          A bill has to name who it comes from — the landlord, the utility, the ISP — because the
          job records an invoice against them on the due date. Until then these are recorded
          intentions and the nightly run refuses them by name:{' '}
          <strong>{unsetSupplier.map((t) => t.name).join(', ')}</strong>. Edit each one and choose a
          supplier.
        </div>
      )}

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

      {stores.length === 0 ? (
        <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
          This org has no store yet.
        </p>
      ) : (
        <>
          <FilterRow>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Store</span>
              <select name="store" defaultValue={storeId} className={INPUT}>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </FilterRow>

          <section className="space-y-2">
            <h2 className="font-medium">Templates</h2>
            {templates.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">
                None yet. Add the store&rsquo;s fixed bills below.
              </p>
            ) : (
              <div className="space-y-2">
                {templates.map((t) => {
                  const overdue = t.status === 'active' && t.nextDueDate <= now;
                  return (
                    <div
                      key={t.id}
                      className={`space-y-2 rounded-lg border p-3 dark:border-neutral-800 ${
                        t.status === 'paused'
                          ? 'border-neutral-200 opacity-60'
                          : 'border-neutral-200'
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium">
                          {t.name}
                          <span className="ml-2 text-xs font-normal text-neutral-400">
                            {INTERVAL_LABEL[t.interval] ?? t.interval} · {anchorLabel(t.interval, t.anchorDay)}
                          </span>
                        </span>
                        <span className="tabular-nums">
                          {peso(t.defaultAmount)}{' '}
                          <span className="text-xs text-neutral-400">default</span>
                        </span>
                      </div>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400">
                        next due <strong>{t.nextDueDate}</strong>
                        {overdue && <span className="ml-1 text-amber-700 dark:text-amber-400">· due now</span>}
                        {/* ⭐ The job catches up ONE period per nightly run, deliberately — three
                            drafts on one morning is noise. Saying how far behind a template is
                            stops a normal catch-up being read as a stuck job. */}
                        {periodsBehind(t.interval, t.anchorDay, t.nextDueDate, now) > 1 && (
                          <span className="ml-1 text-amber-700 dark:text-amber-400">
                            · {periodsBehind(t.interval, t.anchorDay, t.nextDueDate, now)} periods behind,
                            catching up one per night
                          </span>
                        )}
                        {!t.supplierId && (
                          <span className="ml-1 text-amber-700 dark:text-amber-400">
                            · no supplier, so it cannot draft
                          </span>
                        )}
                        {t.status === 'paused' && <span className="ml-1">· paused</span>}
                        {t.tillIsDeliberate && (
                          // ⚠️ Called out on the row, because it is the one setting v1 built a whole
                          // routing module to prevent happening by accident.
                          <span className="ml-1 text-amber-700 dark:text-amber-400">
                            · pays from the CASHIER TILL, deliberately
                          </span>
                        )}
                        {t.lastDraftedExpenseId ? (
                          <>
                            {' '}
                            · last drafted{' '}
                            <Link href={`/expenses/${t.lastDraftedExpenseId}`} className="underline underline-offset-2">
                              that expense
                            </Link>
                          </>
                        ) : (
                          ' · has never produced anything'
                        )}
                      </p>

                      <details>
                        <summary className="cursor-pointer text-xs text-neutral-500 dark:text-neutral-400">
                          Edit, pause or remove
                        </summary>
                        <div className="mt-2 space-y-2">
                          <TemplateForm
                            action={updateTemplateAction}
                            storeId={storeId}
                            templateId={t.id}
                            cats={cats}
                            accounts={accounts}
                            suppliers={suppliers}
                            defaults={t}
                            submitLabel="Save changes"
                          />
                          <div className="flex flex-wrap gap-2">
                            <form action={setTemplateStatusAction}>
                              <input type="hidden" name="storeId" value={storeId} />
                              <input type="hidden" name="templateId" value={t.id} />
                              <input
                                type="hidden"
                                name="status"
                                value={t.status === 'active' ? 'paused' : 'active'}
                              />
                              <button type="submit" className={BTN}>
                                {t.status === 'active' ? 'Pause' : 'Resume'}
                              </button>
                            </form>
                            {/* ⛔ Offered only while it has never produced anything. Once it has, it
                                is history and the answer is Pause — deleting it would strand the
                                explanation for an expense that still exists. */}
                            {t.lastDraftedExpenseId === null && (
                              <form action={deleteTemplateAction}>
                                <input type="hidden" name="storeId" value={storeId} />
                                <input type="hidden" name="templateId" value={t.id} />
                                <button type="submit" className={BTN}>
                                  Delete
                                </button>
                              </form>
                            )}
                          </div>
                        </div>
                      </details>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="space-y-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <h2 className="font-medium">Add a template</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              ⚠️ The amount is a <strong>default</strong>, not the bill. Rent is fixed; electricity is
              not — whatever this produces is edited against the real invoice before anyone posts it.
              ⛔ <strong>No payroll templates.</strong> Payroll posts its own salaries and its own
              statutory liabilities; a remittance debits a liability and is not an expense.
            </p>
            <TemplateForm
              action={createTemplateAction}
              storeId={storeId}
              cats={cats}
              accounts={accounts}
              suppliers={suppliers}
              submitLabel="Add template"
            />
          </section>
        </>
      )}
    </Page>
  );
}

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';

interface TemplateDefaults {
  name: string;
  categoryId: string;
  defaultAmount: string;
  defaultMoneyAccountId: string | null;
  supplierId: string | null;
  interval: string;
  anchorDay: number;
  tillIsDeliberate: boolean;
}

function TemplateForm({
  action,
  storeId,
  templateId,
  cats,
  accounts,
  suppliers,
  defaults,
  submitLabel,
}: {
  action: (formData: FormData) => Promise<void>;
  storeId: string;
  templateId?: string;
  cats: { id: string; category: string; group: string; accountCode: string | null }[];
  accounts: { id: string; name: string; custodian: string }[];
  suppliers: { id: string; name: string }[];
  defaults?: TemplateDefaults;
  submitLabel: string;
}) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="storeId" value={storeId} />
      {templateId && <input type="hidden" name="templateId" value={templateId} />}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint="What a person calls it — “Lipa branch rent”.">
          <Input name="name" required defaultValue={defaults?.name ?? ''} className="w-full" />
        </Field>
        <Field
          label="Supplier"
          hint="Who the bill comes from. The job records an invoice against them on the due date, so a template without one cannot draft."
        >
          <select name="supplierId" required defaultValue={defaults?.supplierId ?? ''} className={`${INPUT} w-full`}>
            <option value="" disabled>
              Choose…
            </option>
            {suppliers.map((sup) => (
              <option key={sup.id} value={sup.id}>
                {sup.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Category">
          <select name="categoryId" required defaultValue={defaults?.categoryId ?? ''} className={`${INPUT} w-full`}>
            <option value="" disabled>
              Choose…
            </option>
            {cats.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.accountCode}>
                {c.group} — {c.category}
                {!c.accountCode ? ' (unmapped — cannot post)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Default amount">
          <Input
            name="defaultAmount"
            required
            inputMode="decimal"
            defaultValue={defaults?.defaultAmount ?? ''}
            placeholder="0.00"
            className="w-full text-right"
          />
        </Field>
        <Field label="How often">
          <select name="interval" defaultValue={defaults?.interval ?? 'monthly'} className={`${INPUT} w-full`}>
            {RECURRING_INTERVALS.map((i) => (
              <option key={i} value={i}>
                {INTERVAL_LABEL[i] ?? i}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="On which day"
          hint="Day of the month (1–31) — or day of the week (0 = Sunday) for weekly and fortnightly. 29–31 clamp to the month end."
        >
          <Input
            name="anchorDay"
            required
            inputMode="numeric"
            defaultValue={defaults?.anchorDay ?? 1}
            className="w-full text-right"
          />
        </Field>
      </div>

      <Field label="Paid from" hint="Optional — whatever this produces can name a different account.">
        <select
          name="defaultMoneyAccountId"
          defaultValue={defaults?.defaultMoneyAccountId ?? ''}
          className={`${INPUT} w-full`}
        >
          <option value="">Not stated</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.custodian})
            </option>
          ))}
        </select>
      </Field>

      {/* ⛔ v1's `payment-routing.ts` exists because a scheduled payment could drift onto the till:
          "a recurring/scheduled payment must never silently draw from the cashier till." Here it
          cannot drift — it can only be chosen, on purpose, with this box. */}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="tillIsDeliberate" defaultChecked={defaults?.tillIsDeliberate ?? false} className="mt-1" />
        <span>
          Yes, really pay this from the <strong>cashier till</strong>
          <span className="block text-xs text-neutral-500">
            The till is the day&rsquo;s operating drawer. A bill that comes out of it leaves the day
            short with nothing on the sales report naming why — so it needs saying out loud, and it
            is recorded that somebody did.
          </span>
        </span>
      </label>

      <button
        type="submit"
        className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
      >
        {submitLabel}
      </button>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </label>
  );
}
