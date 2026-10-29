import Link from 'next/link';
import { compare, formatMoney, money, ZERO } from '@shareat/core/money';
import { requirePageAccess } from '../../../lib/page-access';
import { AGENCIES, agencyLabel, isAgency, mismatches, monthWords, monthsFor, reconciliationFor, storeNamesFor } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { ACTION_LINK } from '@/components/action-link';
import { Banner, Button, FlashBanner, LinkRow, RowAction, RowLink, Select, Table, Td, NumTd, Th } from '@/components/ui';

export const metadata = { title: 'Government payments — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  agency?: string;
  year?: string;
  store?: string;
  ok?: string;
  error?: string;
}

const LABEL = 'text-xs font-medium text-neutral-600 dark:text-neutral-400';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/payroll/statutory-payments`. T-193 S5.
 *
 * What payroll owes SSS, PhilHealth, Pag-IBIG and BIR, month by month and store by store, what has been paid, and what is
 * still outstanding. Owed is summed live from posted pay runs; nothing here is stored or cached. Oldest unpaid month first.
 */
export default async function StatutoryPaymentsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/payroll/statutory-payments');
  if (refusal) return refusal;

  const agency = isAgency(sp.agency) ? sp.agency : undefined;
  const year = /^\d{4}$/.test(sp.year ?? '') ? sp.year : undefined;
  const storeId = sp.store && UUID.test(sp.store) ? sp.store : undefined;

  const [rows, reconciliation, storeNames] = await Promise.all([
    monthsFor(actor, { ...(agency ? { agency } : {}), ...(year ? { year } : {}), ...(storeId ? { storeId } : {}) }),
    reconciliationFor(actor),
    storeNamesFor(actor),
  ]);
  const off = mismatches(reconciliation);
  const nameOf = (id: string) => storeNames.get(id) ?? 'A store';

  return (
    <Page density="table" className="space-y-6">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">Payroll / Government payments</p>
        <h1 className="text-2xl font-semibold">Government payments</h1>
        <PageDescription>
          What payroll withheld and owes to SSS, PhilHealth, Pag-IBIG and BIR, and what has been paid to them. Each row is one agency,
          one month and one store. The oldest unpaid month is first.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {off.length > 0 && (
        <Banner tone="error">
          The payroll figures and the ledger do not match (mismatch):{' '}
          {off.map((r) => `${agencyLabel(r.agency)} at ${nameOf(r.storeId)} owes ${formatMoney(money(r.outstanding))} by payroll but the ledger shows ${formatMoney(money(r.glBalance))}`).join('; ')}
          . Someone has posted to the payable account outside payroll, or a payment was entered by hand. Ask your accountant before paying.
        </Banner>
      )}

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
          <span className={LABEL}>Agency</span>
          <Select name="agency" defaultValue={agency ?? ''} className="w-full">
            <option value="">All agencies</option>
            {AGENCIES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex min-w-0 flex-1 basis-32 flex-col gap-1">
          <span className={LABEL}>Year</span>
          <input name="year" type="number" step={1} defaultValue={year ?? ''} placeholder="All years" className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm text-ink" />
        </label>
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <span className={LABEL}>Store</span>
          <Select name="store" defaultValue={storeId ?? ''} className="w-full">
            <option value="">All stores</option>
            {[...storeNames].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        <Link href="/payroll/statutory-payments/new" className={ACTION_LINK}>
          Record a payment →
        </Link>
      </form>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Nothing is owed to the agencies yet. Post a pay run and its contributions and withholding tax appear here.
        </p>
      ) : (
        <Table card={{ title: 'Month', subtitle: 'Agency', keys: ['Store', 'Owed', 'Paid', 'Outstanding'] }}>
          <thead>
            <tr>
              <Th>Month</Th>
              <Th>Agency</Th>
              <Th>Store</Th>
              <Th numeric>Owed</Th>
              <Th numeric>Paid</Th>
              <Th numeric>Outstanding</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = compare(money(r.outstanding), ZERO) > 0;
              const key = `${r.agency}-${r.month}-${r.storeId}`;
              const cells = (
                <>
                  <Td>{open ? (
                    <RowLink
                      href={`/payroll/statutory-payments/new?agency=${r.agency}&month=${r.month}`}
                      aria-label={`Record a ${agencyLabel(r.agency)} payment for ${monthWords(r.month)}`}
                    >
                      {monthWords(r.month)}
                    </RowLink>
                  ) : monthWords(r.month)}</Td>
                  <Td>
                    <RowAction>
                      <Link
                        href={`/payroll/statutory-payments/month?agency=${r.agency}&month=${r.month}`}
                        className={ACTION_LINK}
                        aria-label={`Payslips and payments behind ${agencyLabel(r.agency)} for ${monthWords(r.month)}`}
                      >
                        {agencyLabel(r.agency)}
                      </Link>
                    </RowAction>
                  </Td>
                  <Td>{nameOf(r.storeId)}</Td>
                  <NumTd>{formatMoney(money(r.owed))}</NumTd>
                  <NumTd>{formatMoney(money(r.paid))}</NumTd>
                  <NumTd className={open ? 'font-semibold' : 'text-muted'}>{formatMoney(money(r.outstanding))}</NumTd>
                </>
              );
              return open ? <LinkRow key={key}>{cells}</LinkRow> : <tr key={key}>{cells}</tr>;
            })}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
