import { can } from '@shareat/auth';
import { getReviewDayDetail, listReviewDays, type ReviewDayDetail, type SettlementReviewRow } from '@shareat/domain';
import { requirePageAccess } from '../../../lib/page-access';
import { ACTION_LINK } from '@/components/action-link';
import { SubmitButton } from '@/components/feedback/SubmitButton';
import { Page } from '@/components/shell/Page';
import { Badge, Banner, Button, Checkbox, Field, FlashBanner, Input, LinkRow, NumTd, RowAction, RowLink, Select, Table, Td, Th } from '@/components/ui';
import { withFlash } from '@/lib/flash';
import { peso } from '@/lib/format';
import { listActiveLoans, withOrgPrincipal, type LoanOption } from '../lib';
import { DayDetail, FilterFields, type DayDetailAccess } from './DayDetail';
import { reopenDayAction } from './actions';
import { listMissingFileDays, listReviewStores } from './lib';
import { attentionWords, differenceShort, isNonZero, listLoanWord, listStateWord, pageNumber, pageSlice, paidWord, platformWord, reviewHref, shortDate, type ReviewFilterValues } from './words';

export const metadata = { title: 'Review settlement days — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
  day?: string;
  store?: string;
  platform?: string;
  period?: string;
  needs?: string;
  page?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD = /^\d{4}-\d{2}$/;

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * T-511 S5b - the review screen: every staged Grab and Foodpanda day with what the file says, what staff recorded, the difference and what stops it. A manager reads
 * it on a phone or a desktop. Nothing is booked from here; rejecting is the only decision (booking comes in slice 7). The route is gated by `record_ar_collection`
 * (ROUTE_CAPABILITY) and the domain narrows every list and every day to the stores the person may review.
 */
export default async function ReviewSettlementDaysPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/channel-settlements/review');
  if (refusal) return refusal;

  const storeParam = one(sp.store);
  const platformParam = one(sp.platform);
  const periodParam = one(sp.period);
  const filters: { store?: string; platform?: 'grab' | 'foodpanda'; period?: string; needs: boolean } = {
    store: storeParam && UUID.test(storeParam) ? storeParam : undefined,
    platform: platformParam === 'grab' || platformParam === 'foodpanda' ? platformParam : undefined,
    period: periodParam && PERIOD.test(periodParam) ? periodParam : undefined,
    needs: sp.needs === '1',
  };
  const dayParam = one(sp.day);

  const stores = await listReviewStores(actor);
  const missing = await listMissingFileDays(actor);
  const data = await withOrgPrincipal(actor.orgId, async (tx) => {
    const list = await listReviewDays(tx, actor, { needsAttention: filters.needs, storeId: filters.store, platform: filters.platform, period: filters.period });
    const isAdminReopen = await can(tx, actor, 'override_period_lock');
    let detail: ReviewDayDetail | null = null;
    let access: DayDetailAccess = { canReject: false, canReopen: false, canOverrideLoans: false };
    if (dayParam && UUID.test(dayParam)) {
      detail = await getReviewDayDetail(tx, actor, { lineId: dayParam });
      if (detail) {
        access = {
          canReject: await can(tx, actor, 'record_ar_collection', { storeId: detail.storeId }),
          canReopen: isAdminReopen,
          canOverrideLoans: await can(tx, actor, 'edit_loan_repayment_amount', { storeId: detail.storeId }),
        };
      }
    }
    return { list, isAdminReopen, detail, access };
  });
  const loans: LoanOption[] = data.access.canOverrideLoans ? await listActiveLoans(actor.orgId) : [];

  const slice = pageSlice(data.list.days, pageNumber(one(sp.page)));
  const pageFilters: ReviewFilterValues = { ...filters, page: slice.page };
  const listHref = reviewHref(pageFilters);
  // The Actions column exists only when someone can use it: an administrator, and a rejected day somewhere in the list (an empty column costs every row width).
  const showActions = data.isAdminReopen && data.list.days.some((r) => r.reviewState === 'rejected');
  const columnCount = showActions ? 9 : 8;
  const filtered = filters.store !== undefined || filters.platform !== undefined || filters.period !== undefined || filters.needs;

  return (
    <Page
      density="table"
      title="Review settlement days"
      description={
        'Each row is one store, one platform and one sales day, read from the Grab and Foodpanda files. ' +
        'Check the file against what staff recorded. Nothing is booked from this screen yet.'
      }
    >
      <FlashBanner flash={sp} />

      {dayParam && !data.detail ? <Banner tone="warning">That day was not found, or it belongs to a store you cannot review. Pick a day from the list.</Banner> : null}
      {data.detail ? <DayDetail detail={data.detail} access={data.access} loans={loans} backHref={listHref} filters={filters} /> : null}

      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filter the days">
        <Field label="Store">
          <Select name="store" defaultValue={filters.store ?? ''} className="w-full">
            <option value="">All stores</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Platform">
          <Select name="platform" defaultValue={filters.platform ?? ''} className="w-full">
            <option value="">Grab and Foodpanda</option>
            <option value="grab">Grab</option>
            <option value="foodpanda">Foodpanda</option>
          </Select>
        </Field>
        <Field label="Month of the sales day">
          <Input name="period" type="month" defaultValue={filters.period ?? ''} className="w-full" />
        </Field>
        <Checkbox name="needs" value="1" defaultChecked={filters.needs} label="Only days that need attention" />
        <Button type="submit" variant="secondary">
          Show
        </Button>
        {filtered ? (
          <a href="/channel-settlements/review" className={ACTION_LINK}>
            Clear the filters
          </a>
        ) : null}
      </form>

      <section className="space-y-2" aria-label="Settlement days">
        <h2 className="text-lg font-semibold">Days from the files</h2>
        {data.list.days.length === 0 ? (
          <p className="text-sm">{filtered ? 'No day matches these filters.' : 'No file has been uploaded yet. Upload the Grab and Foodpanda files first.'}</p>
        ) : (
          <>
            <p className="text-sm">
              Showing {slice.from} to {slice.to} of {slice.total} days.
            </p>
            {/* md:px-2 on every cell: 8 columns must fit the 895px of a 1024 screen without a scroll box of their own (phone cards keep their own spacing) */}
            <Table card={{ title: 'Store', subtitle: 'Sales day', keys: ['Difference', 'State'] }} className="md:[&_td]:px-2 md:[&_th]:px-2">
              <thead>
                <tr>
                  <Th>Store</Th>
                  <Th>Sales day</Th>
                  <Th numeric>File figure</Th>
                  <Th numeric>Staff figure</Th>
                  <Th numeric>Difference</Th>
                  <Th>State</Th>
                  <Th>Loan check</Th>
                  <Th>What needs attention</Th>
                  {showActions ? <Th aria-label="Actions" /> : null}
                </tr>
              </thead>
              <tbody>
                {slice.items.map((r, i) => (
                  <DayRows key={r.lineId} row={r} previous={slice.items[i - 1]} filters={pageFilters} canReopen={data.isAdminReopen} showActions={showActions} columnCount={columnCount} />
                ))}
              </tbody>
            </Table>
            {slice.pages > 1 ? (
              <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label="Pages of days">
                {slice.page > 1 ? (
                  <a href={reviewHref({ ...filters, page: slice.page - 1 })} className={ACTION_LINK}>
                    Previous page
                  </a>
                ) : null}
                <span>
                  Page {slice.page} of {slice.pages}
                </span>
                {slice.page < slice.pages ? (
                  <a href={reviewHref({ ...filters, page: slice.page + 1 })} className={ACTION_LINK}>
                    Next page
                  </a>
                ) : null}
              </nav>
            ) : null}
          </>
        )}
      </section>

      {data.list.pandagoOnly.length > 0 ? (
        <section className="space-y-2" aria-label="PandaGO only invoices">
          <h2 className="text-lg font-semibold">Foodpanda invoices with PandaGO only</h2>
          <ul className="space-y-3">
            {data.list.pandagoOnly.map((p) => (
              <li key={p.uploadId} className="space-y-1 rounded-[20px] border border-surface-border p-4 text-sm">
                <p className="font-medium">
                  {p.unreadable ? p.storeName : `${p.storeName}, invoice ${p.invoiceNumber ?? 'with no number'}`}
                </p>
                <p>{p.sentence}</p>
                {p.unreadable ? null : <p>{p.dateNote}</p>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2" aria-label="Days with sales and no file yet">
        <h2 className="text-lg font-semibold">Days with sales and no file yet</h2>
        {missing.days.length === 0 ? (
          <p className="text-sm">Every day with recorded sales has a file.</p>
        ) : (
          <>
            <Table card={{ title: 'Store', subtitle: 'Sales day', keys: ['Channel'] }}>
              <thead>
                <tr>
                  <Th>Store</Th>
                  <Th>Channel</Th>
                  <Th>Sales day</Th>
                  <Th>What is missing</Th>
                </tr>
              </thead>
              <tbody>
                {missing.days.map((d) => (
                  <tr key={`${d.storeName}-${d.channelName}-${d.salesDate}`}>
                    <Td>{d.storeName}</Td>
                    <Td>{d.channelName}</Td>
                    <Td className="whitespace-nowrap">{shortDate(d.salesDate)}</Td>
                    <Td>{d.sentence}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {missing.more > 0 ? <p className="text-sm">{missing.more} more days have no file. Upload the files to clear the oldest first.</p> : null}
          </>
        )}
      </section>
    </Page>
  );
}

/** One day's row; a Foodpanda day that opens a new invoice gets a heading row first, so the days of one invoice read together. */
function DayRows({
  row,
  previous,
  filters,
  canReopen,
  showActions,
  columnCount,
}: {
  readonly row: SettlementReviewRow;
  readonly previous: SettlementReviewRow | undefined;
  readonly filters: ReviewFilterValues;
  readonly canReopen: boolean;
  readonly showActions: boolean;
  readonly columnCount: number;
}) {
  const newInvoice = row.invoiceNumber !== null && (previous === undefined || previous.invoiceNumber !== row.invoiceNumber || previous.storeId !== row.storeId);
  const state = listStateWord(row.reviewState);
  const loan = row.loanCheck ? listLoanWord(row.loanCheck.status) : null;
  const differs = isNonZero(row.difference);
  const attention = attentionWords(row);
  return (
    <>
      {newInvoice ? (
        <tr>
          <td colSpan={columnCount} data-card-span="full" className="border-t border-surface-border bg-canvas px-3 py-2 text-xs font-semibold">
            Foodpanda invoice {row.invoiceNumber}, {row.storeName}
          </td>
        </tr>
      ) : null}
      <LinkRow>
        <Td>
          {/* whitespace-normal: the phone card's title cell is nowrap, and a long store name must wrap instead of being clipped */}
          <RowLink
            href={reviewHref(filters, row.lineId)}
            className="inline-flex min-h-11 items-center whitespace-normal"
            aria-label={`Open ${row.storeName}, ${platformWord(row.platform)}, ${shortDate(row.salesDate)}`}
          >
            {row.storeName}
          </RowLink>
        </Td>
        <Td className="whitespace-nowrap">
          <span className="block">{shortDate(row.salesDate)}</span>
          <span className="block text-xs text-muted">{platformWord(row.platform)}</span>
        </Td>
        <NumTd className="whitespace-nowrap">{peso(row.fileFigure)}</NumTd>
        <NumTd className="whitespace-nowrap">{row.staffFigure === null ? 'Not recorded' : peso(row.staffFigure)}</NumTd>
        <NumTd className="whitespace-nowrap">
          {row.difference === null ? 'Unknown' : peso(row.difference)}
          {differs ? <div className="text-xs">{differenceShort(row.difference)}</div> : null}
        </NumTd>
        <Td>
          <Badge tone={state.tone} label={state.label} className="whitespace-nowrap" />
          <div className="mt-1 whitespace-nowrap text-xs text-muted">{paidWord(row.paidState)}</div>
        </Td>
        <Td>{loan ? <Badge tone={loan.tone} label={loan.label} /> : 'Not used'}</Td>
        <Td>
          {attention.length === 0 ? (
            'Nothing'
          ) : (
            <ul className="space-y-0.5">
              {attention.slice(0, 2).map((w) => (
                <li key={w} className="whitespace-nowrap">
                  {w}
                </li>
              ))}
              {attention.length > 2 ? <li className="whitespace-nowrap text-xs text-muted">and {attention.length - 2} more</li> : null}
            </ul>
          )}
        </Td>
        {showActions ? (
          canReopen && row.reviewState === 'rejected' ? (
            <Td>
              <RowAction>
                <form action={reopenDayAction}>
                  <input type="hidden" name="lineId" value={row.lineId} />
                  <FilterFields filters={filters} />
                  <SubmitButton variant="secondary" pendingLabel="Reopening…">
                    Reopen day
                  </SubmitButton>
                </form>
              </RowAction>
            </Td>
          ) : (
            // an empty cell would open as a lone "Actions" label in a phone card
            <Td className="max-md:hidden" />
          )
        ) : null}
      </LinkRow>
    </>
  );
}
