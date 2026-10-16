import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { getUnpaidLiabilities, type UnpaidKind, type UnpaidLine, type UnpaidLiabilities } from '@shareat/domain';
import { accountLabel } from '@/lib/account-label';
import { ACTION_LINK } from '@/components/action-link';
import { peso } from '@/lib/format';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Badge, Banner, Card, LinkRow, NumTd, RowLink, Table, Td, Th } from '@/components/ui';
import { reportScope, runReport } from '../../reports/lib';
import { daysWord, isOverdue, leftoverDirection, orderLines } from './lib';

export const metadata = { title: 'Everything unpaid — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
}

const PAYROLL_ONLY = 'Visible to payroll staff only';

export default async function UnpaidPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  // Covered by '/liabilities' -> view_financial_reports (route-capability); store-scoped like AP aging.
  const scope = await reportScope('/liabilities/unpaid', 'view_financial_reports', sp.store);
  const result: UnpaidLiabilities = await runReport(scope.actor.orgId, (tx) =>
    getUnpaidLiabilities(tx, scope.actor, { storeId: scope.storeId }),
  );

  const today = toBusinessDate();
  const storeName = (id: string): string => scope.stores.find((s) => s.id === id)?.name ?? 'Another store';
  const currentStore = scope.storeId ? storeName(scope.storeId) : 'All stores';

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Everything unpaid</h1>
        <PageDescription>
          What the business still owes, grouped by kind, worked out live from the records that own each figure. Nothing
          here is stored or changed by this page.
        </PageDescription>
      </div>

      <nav aria-label="Store" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-muted">{currentStore}</span>
        {scope.coversWholeOrg && (
          <Link href="/liabilities/unpaid" className={ACTION_LINK}>
            All stores
          </Link>
        )}
        {scope.stores.map((s) => (
          <Link key={s.id} href={`/liabilities/unpaid?store=${s.id}`} className={ACTION_LINK}>
            {s.name}
          </Link>
        ))}
      </nav>

      {result.banners.length > 0 && (
        <Banner tone="warning">
          <div className="space-y-1">
            <h2 className="font-medium">The books carry a different amount than the records below</h2>
            <ul className="space-y-1 text-sm">
              {result.banners.map((b) => {
                const d = leftoverDirection(b.amount);
                return (
                  <li key={`${b.accountCode}-${b.storeId}`}>
                    {storeName(b.storeId)}: {accountLabel(b.accountCode)} is{' '}
                    <span className="font-mono tabular-nums">{peso(d.size)}</span> {d.more ? 'more' : 'less'} in the
                    books than the records listed.
                  </li>
                );
              })}
            </ul>
          </div>
        </Banner>
      )}

      {result.kinds.map((k) => (
        <KindSection key={k.id} kind={k} today={today} storeName={storeName} showStore={scope.storeId === undefined} />
      ))}

      <section aria-label="Totals" className="space-y-1 rounded-lg border border-surface-border p-4 text-sm">
        <TotalRow hook="booked" label="Owed in the books" amount={result.totals.booked} />
        <TotalRow hook="not-yet-booked" label="Not yet booked" amount={result.totals.notYetBooked} />
        <TotalRow hook="grand" label="Everything unpaid" amount={result.totals.grand} strong />
        {result.totals.excludesWages && (
          <p className="text-xs text-muted">This total excludes wages: they are {PAYROLL_ONLY.toLowerCase()}.</p>
        )}
        <p className="text-xs text-muted">
          Money one store owes another store (internal) is shown but not added: across all stores it nets to zero.
        </p>
      </section>
    </Page>
  );
}

function TotalRow({ hook, label, amount, strong }: { hook: string; label: string; amount: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-4 ${strong ? 'font-semibold' : ''}`}>
      <span>{label}</span>
      <span data-total={hook} data-amount={amount} className="font-mono tabular-nums">
        {peso(amount)}
      </span>
    </div>
  );
}

/** A ledger line is named in plain words by its account; every other line carries its own name. */
function lineTitle(l: UnpaidLine): string {
  return l.accountCode ? accountLabel(l.accountCode) : l.name;
}

function KindSection({
  kind,
  today,
  storeName,
  showStore,
}: {
  kind: UnpaidKind;
  today: string;
  storeName: (id: string) => string;
  showStore: boolean;
}) {
  const lines = orderLines(kind.lines, today);
  return (
    <section data-kind={kind.id} className="space-y-3">
      <h2 className="text-lg font-semibold">{kind.title}</h2>

      {!kind.visible ? (
        <p className="text-sm text-muted">{PAYROLL_ONLY}</p>
      ) : (
        <>
          {kind.unavailableReason && <p className="text-sm text-warning-ink">{kind.unavailableReason}</p>}
          {(kind.needsReviewDays ?? 0) > 0 && (
            <p className="text-sm text-muted">{daysWord(kind.needsReviewDays ?? 0)} need review, not included.</p>
          )}
          {(kind.unratedDays ?? 0) > 0 && (
            <p className="text-sm text-muted">{daysWord(kind.unratedDays ?? 0)} have no pay rate set, not included.</p>
          )}
          {kind.withheld?.map((w) => (
            <p key={`${w.accountCode}-${w.storeId}`} className="text-sm text-muted">
              {storeName(w.storeId)}: {accountLabel(w.accountCode)}. {PAYROLL_ONLY}.
            </p>
          ))}

          {lines.length === 0 ? (
            <p className="text-sm text-muted">Nothing unpaid</p>
          ) : (
            <>
              <div data-layout="cards" className="space-y-2 sm:hidden">
                {lines.map((l, i) => (
                  <Link
                    key={`${l.href}-${i}`}
                    href={l.href}
                    data-unpaid-line=""
                    data-amount={l.amount}
                    className="block min-h-11 rounded-[14px]"
                  >
                    <Card>
                      <LineSummary line={l} today={today} storeName={storeName} showStore={showStore} />
                    </Card>
                  </Link>
                ))}
              </div>
              <div data-layout="table" className="hidden sm:block">
                <Table>
                  <thead>
                    <tr>
                      <Th>What</Th>
                      <Th>Who</Th>
                      {showStore && <Th>Store</Th>}
                      <Th>Due</Th>
                      <Th numeric>Amount</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <LinkRow key={`${l.href}-${i}`} data-unpaid-line="" data-amount={l.amount}>
                        <Td>
                          <RowLink href={l.href}>{lineTitle(l)}</RowLink>
                          {l.internal && <Badge tone="info" label="Internal" className="ml-2" />}
                          {l.tag && <div className="text-xs text-muted">{l.tag}</div>}
                        </Td>
                        <Td>{l.counterparty ?? ''}</Td>
                        {showStore && <Td>{storeName(l.storeId)}</Td>}
                        <Td>
                          {l.dueOn ?? ''}
                          {isOverdue(l, today) && ' · overdue'}
                        </Td>
                        <NumTd className="font-mono">{peso(l.amount)}</NumTd>
                      </LinkRow>
                    ))}
                  </tbody>
                </Table>
              </div>
            </>
          )}

          {kind.unmatched.map((u) => {
            const d = leftoverDirection(u.amount);
            return (
              <p key={`${u.accountCode}-${u.storeId}`} className="text-sm text-warning-ink">
                Unmatched in the books: {storeName(u.storeId)}, {accountLabel(u.accountCode)},{' '}
                <span className="font-mono tabular-nums">{peso(d.size)}</span> {d.more ? 'more' : 'less'} than the
                records listed.
              </p>
            );
          })}

          {kind.subtotal !== null && (
            <p className="flex items-baseline justify-between gap-4 border-t border-surface-border pt-2 text-sm font-medium">
              <span>Subtotal</span>
              <span data-subtotal={kind.id} data-amount={kind.subtotal} className="font-mono tabular-nums">
                {peso(kind.subtotal)}
              </span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function LineSummary({
  line,
  today,
  storeName,
  showStore,
}: {
  line: UnpaidLine;
  today: string;
  storeName: (id: string) => string;
  showStore: boolean;
}) {
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium underline underline-offset-2">{lineTitle(line)}</span>
        <span className="font-mono tabular-nums">{peso(line.amount)}</span>
      </div>
      {line.internal && <Badge tone="info" label="Internal" />}
      {line.tag && <div className="text-xs text-muted">{line.tag}</div>}
      <div className="text-xs text-muted">
        {[line.counterparty, showStore ? storeName(line.storeId) : null].filter(Boolean).join(' · ')}
      </div>
      {line.dueOn && (
        <div className={`text-xs ${isOverdue(line, today) ? 'text-warning-ink' : 'text-muted'}`}>
          Due {line.dueOn}
          {isOverdue(line, today) && ' · overdue'}
        </div>
      )}
    </div>
  );
}
