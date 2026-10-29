import Link from 'next/link';
import { notFound } from 'next/navigation';
import { add, formatMoney, money } from '@shareat/core/money';
import { requirePageAccess } from '../../../../lib/page-access';
import { voidStatutoryPaymentAction } from '../actions';
import { agencyLabel, moneyAccountNameFor, monthWords, paymentFor, storeNamesFor } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { ACTION_LINK } from '@/components/action-link';
import { Badge, Banner, ConfirmDestructive, FlashBanner, Input, NumTd, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Government payment — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  ok?: string;
  error?: string;
}

const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

/**
 * `/payroll/statutory-payments/[id]`. T-193 S5.
 *
 * One payment to an agency: the receipt number, what it cleared store by store, the penalty, the ledger entry it made, and, while it
 * stands, the way to void it. A voided payment is final and shows why; a fresh payment is a fresh form.
 */
export default async function StatutoryPaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/payroll/statutory-payments/${id}`);
  if (refusal) return refusal;

  const payment = await paymentFor(actor, id);
  if (!payment) notFound();

  const [storeNames, accountName] = await Promise.all([storeNamesFor(actor), moneyAccountNameFor(actor, payment.moneyAccountId)]);
  const month = String(payment.month).slice(0, 10);
  const voided = payment.status === 'voided';
  const total = add(...payment.lines.map((l) => money(l.amount)));

  return (
    <Page view="detail" sectioned density="table">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/payroll/statutory-payments" className={ACTION_LINK}>
            ← All government payments
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">
            {agencyLabel(payment.agency)} payment, {payment.referenceNo}
          </h1>
          <PageDescription>
            For {monthWords(month)}, paid on {String(payment.paidOn).slice(0, 10)} from {accountName || 'a money account'}.
          </PageDescription>
        </div>
        <Badge status={payment.status} />
      </div>

      <FlashBanner flash={sp} />

      {voided && (
        <Banner tone="warning">
          This payment was voided{payment.voidReason ? `: ${payment.voidReason}` : '.'} Its ledger entry is reversed and the month is owed again.
        </Banner>
      )}

      <section className="space-y-3">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Agency">{agencyLabel(payment.agency)}</Fact>
          <Fact label="Receipt number">{payment.referenceNo}</Fact>
          <Fact label="Month">{monthWords(month)}</Fact>
          <Fact label="Penalty or surcharge">{formatMoney(money(payment.penalty))}</Fact>
          {payment.notes ? <Fact label="Notes">{payment.notes}</Fact> : null}
          {payment.journalEntryId ? (
            <Fact label="Ledger entry">
              <Link href={`/reports/journal-lines?entry=${payment.journalEntryId}`} className={ACTION_LINK}>
                See the journal entry
              </Link>
            </Fact>
          ) : null}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">What it paid, store by store</h2>
        <Table card={{ title: 'Store', keys: ['Amount'] }}>
          <thead>
            <tr>
              <Th>Store</Th>
              <Th numeric>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {payment.lines.map((l) => (
              <tr key={l.storeId}>
                <Td>{storeNames.get(l.storeId) ?? 'A store'}</Td>
                <NumTd>{formatMoney(money(l.amount))}</NumTd>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{payment.lines.length} store(s). Together {formatMoney(total)} before any penalty.</p>
      </section>

      {!voided && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">Void this payment</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Use this if the payment was recorded by mistake. Its ledger entry is reversed and the month is owed again. A voided payment cannot be
            brought back; record a new one instead.
          </p>
          <form action={voidStatutoryPaymentAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="paymentId" value={payment.id} />
            <label className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
              <span className={LABEL}>Why is it being voided?</span>
              <Input name="reason" className="w-full" />
            </label>
            <label className="flex min-w-0 basis-40 flex-col gap-1">
              <span className={LABEL}>Void on (only if that month is closed)</span>
              <Input name="on" placeholder="2026-12-05" className="w-full" />
            </label>
            <ConfirmDestructive
              tier="admin-pin"
              label="Void payment"
              consequence="Voids this payment, reverses its ledger entry and makes the month owed again. An administrator must approve with their own PIN."
            />
          </form>
        </section>
      )}
    </Page>
  );
}
