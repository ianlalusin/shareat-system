import Link from 'next/link';
import { notFound } from 'next/navigation';
import { add, formatMoney, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../../lib/page-access';
import { agencyLabel, isAgency, isMonthStart, monthDetailFor, monthWords, storeNamesFor } from '../lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';
import { Badge, Banner, LinkRow, NumTd, RowLink, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Government payments by month — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  agency?: string;
  month?: string;
}

/**
 * `/payroll/statutory-payments/month?agency=sss&month=2026-10-01`. T-193 S6.
 *
 * One agency and one month: the payslip behind every peso owed, the payments made for it (posted and voided), and where it stands
 * against its due date. Personal data (government numbers), so the loader checks `remit_statutory` itself. The penalty is an
 * estimate to read, never an entry in the books.
 */
export default async function StatutoryMonthPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/payroll/statutory-payments/month');
  if (refusal) return refusal;
  if (!isAgency(sp.agency) || !isMonthStart(sp.month)) notFound();
  const agency = sp.agency;
  const month = sp.month;

  const [detail, storeNames] = await Promise.all([monthDetailFor(actor, { agency, month }), storeNamesFor(actor)]);
  const nameOf = (id: string) => storeNames.get(id) ?? 'A store';
  const label = agencyLabel(agency);
  const total = add(ZERO, ...detail.rows.map((r) => money(r.total)));
  const csv = `/payroll/statutory-payments/month/export?${new URLSearchParams({ agency, month }).toString()}`;

  return (
    <Page density="table" className="space-y-6">
      <div>
        <Link href="/payroll/statutory-payments" className={ACTION_LINK}>
          ← All government payments
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          {label}, {monthWords(month)}
        </h1>
        <PageDescription>
          Every payslip behind what is owed to {label} for {monthWords(month)}, and the payments made for it. A person whose {label} was
          not deducted stays on the list at 0.00.
        </PageDescription>
      </div>

      {detail.dueDate === null ? (
        <Banner tone="info">No due day is set for {label} yet, so no due date is shown. An accountant can set it under Payroll rates, Employer numbers.</Banner>
      ) : detail.daysLate > 0 ? (
        <Banner tone="error">
          {detail.fullyPaid ? `Paid ${detail.daysLate} ${detail.daysLate === 1 ? 'day' : 'days'} late (due ${detail.dueDate}). ` : `Due ${detail.dueDate}. ${detail.daysLate} ${detail.daysLate === 1 ? 'day' : 'days'} late. `}
          {detail.estimatedPenalty === null
            ? detail.fullyPaid
              ? 'Estimated penalty: not calculated because the agency’s rate is not on file.'
              : 'Estimated penalty: not calculated because the agency’s rate is not on file. Enter the real penalty when you record the payment.'
            : `Estimated penalty (an estimate only, not posted): ${formatMoney(money(detail.estimatedPenalty))}.`}
        </Banner>
      ) : detail.dueSoon ? (
        <Banner tone="warning">Due {detail.dueDate}. That is within 5 days.</Banner>
      ) : (
        <p className="text-sm text-muted">Due {detail.dueDate}.</p>
      )}

      <div>
        <a href={csv} className={ACTION_LINK}>
          Download as CSV
        </a>
      </div>

      {detail.rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No payslip of a posted pay run falls in {monthWords(month)}.
        </p>
      ) : (
        <Table card={{ title: 'Person', subtitle: 'Store', keys: ['Government number', 'Employee', 'Employer', 'EC', 'Total'] }}>
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Store</Th>
              <Th>Government number</Th>
              <Th numeric>Employee</Th>
              <Th numeric>Employer</Th>
              <Th numeric>EC</Th>
              <Th numeric>Total</Th>
            </tr>
          </thead>
          <tbody>
            {detail.rows.map((r) => (
              <tr key={r.payslipId}>
                <Td>{r.personName}</Td>
                <Td>{nameOf(r.storeId)}</Td>
                <Td>
                  {r.govNo ?? <span className="text-muted">none on file</span>}
                  {r.notDeducted && <span className="ml-2 text-xs text-muted">not deducted</span>}
                </Td>
                <NumTd>{formatMoney(money(r.ee))}</NumTd>
                <NumTd>{formatMoney(money(r.er))}</NumTd>
                <NumTd>{formatMoney(money(r.ec))}</NumTd>
                <NumTd>{formatMoney(money(r.total))}</NumTd>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td className="font-semibold">All payslips</Td>
              <Td />
              <Td />
              <Td />
              <Td />
              <Td />
              <NumTd className="font-semibold">{formatMoney(total)}</NumTd>
            </tr>
          </tfoot>
        </Table>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Payments for {monthWords(month)}</h2>
        {detail.payments.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing has been paid to {label} for this month yet.</p>
        ) : (
          <Table card={{ title: 'Receipt', subtitle: 'Paid on', keys: ['Amount', 'Status'] }}>
            <thead>
              <tr>
                <Th>Receipt no.</Th>
                <Th>Paid on</Th>
                <Th numeric>Amount</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {detail.payments.map((p) => (
                <LinkRow key={p.id}>
                  <Td>
                    <RowLink href={`/payroll/statutory-payments/${p.id}`} aria-label={`Open ${label} payment ${p.referenceNo}`}>
                      {p.referenceNo}
                    </RowLink>
                  </Td>
                  <Td>{String(p.paidOn).slice(0, 10)}</Td>
                  <NumTd>{formatMoney(add(ZERO, ...p.lines.map((l) => money(l.amount))))}</NumTd>
                  <Td>
                    <Badge status={p.status} />
                  </Td>
                </LinkRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </Page>
  );
}
