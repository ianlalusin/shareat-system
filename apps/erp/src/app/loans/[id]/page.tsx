import Link from 'next/link';
import { notFound } from 'next/navigation';
import { compare, money, subtract, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../lib/page-access';
import { disburseLoanAction, recordPaymentAction, reverseEntryAction } from '../actions';
import { METHOD_LABEL, getDetail, moneyAccounts, peso, today } from '../lib';
import { DetailLayout } from '@/components/shell/DetailLayout';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, ConfirmDestructive, FlashBanner, FormModal, Input, Select, statusLabel } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { LOAN_DRAW_RULES, LOAN_PAYMENT_RULES, LOAN_REVERSE_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';

export const metadata = { title: 'Loan — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function LoanPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/loans/${id}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;

  const loan = await getDetail(actor.orgId, id);
  if (!loan) notFound();
  // T-488: minted per render and submitted back, so a double click is a replay of ONE posting and a second genuine
  // transaction on the same day carries its own id (the entry is keyed on it, never on the figures).
  const requestId = crypto.randomUUID();

  const accounts = await moneyAccounts(actor.orgId, loan.storeId);
  // T-371 R4/C4: re-minted database values, ordered in exact centavos — no float tolerance needed.
  const undrawn = subtract(money(loan.principalAmount), money(loan.position.disbursed));
  const owes = compare(money(loan.position.outstanding), ZERO) > 0;

  return (
    <Page view="detail" density="table">
      <div>
        <Link href="/loans" className="text-sm underline underline-offset-2">
          ← Loans
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{loan.name}</h1>
        <PageDescription>
          {loan.lenderName} · {statusLabel(loan.status)} · {Number(loan.interestRate)}% per{' '}
          {loan.ratePeriod} · {METHOD_LABEL[loan.interestMethod]}
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      <DetailLayout
        summary={
          /* ── The figures ────────────────────────────────────────────────────────────── */
          <section className="space-y-3">
            {/* ⚠️ `min-[1440px]:grid-cols-1`: `sm` is a VIEWPORT query, so without it these four
                tiles stay four-across inside a 320px rail — 74px each, nothing overflowing, every
                DOM assertion green. T-240 §3.5. */}
            <div className="grid gap-3 sm:grid-cols-4 min-[1440px]:grid-cols-1">
              <Figure label="Agreed" value={peso(loan.principalAmount)} />
              <Figure label="Drawn" value={peso(loan.position.disbursed)} />
              <Figure label="Principal repaid" value={peso(loan.position.principalPaid)} />
              <Figure label="Outstanding" value={peso(loan.position.outstanding)} emphasis />
            </div>
            {/* ⛔ v1 stored all four of these on the loan row and they drifted so far that both live
                Grab loans were unusable. Here they are one query over the ledger. */}
            <p className="text-xs text-neutral-400 dark:text-neutral-600">
              Interest paid to date: <strong>{peso(loan.position.interestPaid)}</strong>. Every
              figure is summed from the ledger on load, never stored — so none of them can disagree
              with the books.
            </p>
          </section>
        }
      >
      {/* ── Draw it ──────────────────────────────────────────────────────────────────── */}
      {compare(undrawn, ZERO) > 0 && accounts.length > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Draw the money</h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {peso(undrawn)} of this agreement is still undrawn. Anything beyond it is a separate
              loan with its own terms, not a bigger version of this one.
            </p>
          </div>
          <FormModal trigger="Draw the money" title="Draw the money from this loan" size="md">
            <CheckedForm rules={LOAN_DRAW_RULES} action={disburseLoanAction} className="grid gap-4 sm:grid-cols-3">
              <input type="hidden" name="loanId" value={loan.id} />
              <input type="hidden" name="requestId" value={requestId} />
              <Field label="Amount" rule={LOAN_DRAW_RULES.amount}>
                <input
                  {...nativeAttrs(LOAN_DRAW_RULES.amount)}
                  name="amount"
                  inputMode="decimal"
                  defaultValue={undrawn}
                  className={INPUT}
                />
              </Field>
              <Field label="Into" rule={LOAN_DRAW_RULES.intoMoneyAccountId}>
                <Select {...nativeAttrs(LOAN_DRAW_RULES.intoMoneyAccountId)} defaultValue={accounts[0]?.id} className="w-full">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="On" rule={LOAN_DRAW_RULES.on}>
                <Input type="date" {...nativeAttrs(LOAN_DRAW_RULES.on)} defaultValue={today()} className="w-full" />
              </Field>
              <div className="sm:col-span-3">
                <Button type="submit" variant="secondary">
                  Record the draw
                </Button>
              </div>
            </CheckedForm>
          </FormModal>
        </section>
      )}

      {/* ── Pay it ───────────────────────────────────────────────────────────────────── */}
      {owes && accounts.length > 0 && (
        <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div>
            <h2 className="font-medium">Record a payment</h2>
            {/*
              ⭐ THE SPLIT IS NOT AN INPUT, AND THAT IS THE POINT.

              v1 asks the person to type how much of the payment is interest and how much is
              principal — the number deciding how fast the debt retires, hand-entered. Here you say
              what was paid, and the split follows from the loan's own terms.
            */}
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Enter what was paid. Interest is taken first, principal second — you do not split it
              yourself, because the loan&apos;s own terms already decide it.
            </p>
          </div>

          <div className="rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
            <span className="text-neutral-600 dark:text-neutral-400">
              Interest built up since {loan.lastPaymentOn ?? loan.startDate}
            </span>{' '}
            <span className="font-mono font-medium tabular-nums">{peso(loan.accruedNow)}</span>
            <div className="mt-1 text-xs text-neutral-400 dark:text-neutral-600">
              A payment of {peso(loan.instalment)} is one scheduled instalment. ⚠️ Paying less is
              normal and is handled — it simply retires less principal, or none.
            </div>
          </div>

          <FormModal trigger="Record a payment" title="Record a payment on this loan" size="md">
            <CheckedForm rules={LOAN_PAYMENT_RULES} action={recordPaymentAction} className="grid gap-4 sm:grid-cols-3">
              <input type="hidden" name="loanId" value={loan.id} />
              <Field label="Amount paid" rule={LOAN_PAYMENT_RULES.amount}>
                <input
                  {...nativeAttrs(LOAN_PAYMENT_RULES.amount)}
                  name="amount"
                  inputMode="decimal"
                  placeholder={loan.instalment}
                  className={INPUT}
                />
              </Field>
              <Field label="From" rule={LOAN_PAYMENT_RULES.fromMoneyAccountId}>
                <Select {...nativeAttrs(LOAN_PAYMENT_RULES.fromMoneyAccountId)} defaultValue={accounts[0]?.id} className="w-full">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {peso(a.balance)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="On" rule={LOAN_PAYMENT_RULES.on}>
                <Input type="date" {...nativeAttrs(LOAN_PAYMENT_RULES.on)} defaultValue={today()} className="w-full" />
              </Field>
              <div className="sm:col-span-3">
                <Button type="submit" variant="primary">
                  Record payment
                </Button>
              </div>
            </CheckedForm>
          </FormModal>
        </section>
      )}

      {/* ── History ──────────────────────────────────────────────────────────────────── */}
      {loan.payments.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Payments</h2>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Interest</th>
                  <th className="px-3 py-2 text-right font-medium">Principal</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {loan.payments.map((p) => (
                  <tr
                    key={p.entryId}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                  >
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{p.paidOn}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(p.interest)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {peso(p.principal)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(p.total)}</td>
                    <td className="px-3 py-2 text-right">
                      <CheckedForm rules={LOAN_REVERSE_RULES} action={reverseEntryAction} className="flex justify-end gap-1">
                        <input type="hidden" name="loanId" value={loan.id} />
                        <input type="hidden" name="entryId" value={p.entryId} />
                        <Field label={<span className="sr-only">Reason for reversing this entry</span>} rule={LOAN_REVERSE_RULES.reason}>
                          <Input {...nativeAttrs(LOAN_REVERSE_RULES.reason)} placeholder="Reason…" className="w-28" />
                        </Field>
                        <ConfirmDestructive
                          tier="admin-pin"
                          label="Reverse loan entry"
                          consequence="Reverses this entry; the debt goes back to what it was. An administrator must approve with their own PIN."
                        />
                      </CheckedForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* ⚠️ A reversed payment disappears from this list rather than sitting beside its own
              undo — netting is right for a figure and wrong for a history. */}
          <p className="text-xs text-neutral-400 dark:text-neutral-600">
            Reversing writes the opposite entry; the two net to nothing and the debt returns to what
            it was. A reversed payment leaves this list — it never happened as far as the loan is
            concerned, and both entries stay in the ledger.
          </p>
        </section>
      )}
      </DetailLayout>
    </Page>
  );
}

const INPUT =
  'w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink';

function Figure({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className={`font-mono tabular-nums ${emphasis ? 'text-lg font-medium' : 'text-lg'}`}>
        {value}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  rule,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  rule?: FieldRule;
  children: React.ReactNode;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </>
  );
  // T-440: a ruled field puts its live helper line OUTSIDE the label, so the line never joins the accessible name.
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}
