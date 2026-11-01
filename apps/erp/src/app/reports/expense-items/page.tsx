import { expenseItemLines, expenseItemsReport, unitemisedExpenses, UNITEMISED_NAME } from '@shareat/domain';
import { formatMoney } from '@shareat/core/money';
import { toBusinessDate } from '@shareat/core/datetime';
import { reportScope, runReport } from '../lib';
import { EmptyState } from '@/components/reports/EmptyState';
import { CsvExportLink } from '@/components/reports/CsvExportLink';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { Button, Field, FormGrid, Input, LinkRow, NumTd, RowLink, Select, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Spending by Item — Shareat System' };

// Same reason as the other reports: it reads the live ledger under the viewer's scope on every request.
export const dynamic = 'force-dynamic';

const GROUP_LABEL: Record<string, string> = {
  COGS: 'Cost of goods (COGS)',
  OPEX: 'Operating expenses (OPEX)',
  PERSONAL: 'Personal (owner drawings)',
  CAPEX: 'Capital purchases (CAPEX)',
};

interface SearchParams {
  from?: string;
  to?: string;
  store?: string;
  item?: string;
  unitemised?: string;
}

function firstOfMonth(businessDate: string): string {
  return `${businessDate.slice(0, 7)}-01`;
}

const pct = (n: number) => `${n.toFixed(1)}%`;
const cell = 'px-3 py-2 text-right tabular-nums';
const rule = 'border-t border-neutral-200 dark:border-neutral-800';

export default async function ExpenseItemsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const scope = await reportScope('/reports/expense-items', 'view_financial_reports', sp.store);
  const today = toBusinessDate();
  const from = sp.from ?? firstOfMonth(today);
  const to = sp.to ?? today;
  const storeId = scope.storeId ?? null;
  const input = { from, to, storeId };

  const { report, lines, loose } = await runReport(scope.actor.orgId, async (tx) => {
    const report = await expenseItemsReport(tx, scope.actor, input);
    const lines = sp.item ? await expenseItemLines(tx, scope.actor, { ...input, itemId: sp.item }) : null;
    const loose = sp.unitemised ? await unitemisedExpenses(tx, scope.actor, { ...input, categoryId: sp.unitemised }) : null;
    return { report, lines, loose };
  });

  const storeName = new Map(scope.stores.map((s) => [s.id, s.name]));
  // The store-vs-store columns show when more than one store is in view.
  const storeCols = storeId === null && scope.stores.length > 1 ? scope.stores : [];
  const base = { from, to, ...(storeId ? { store: storeId } : {}) };
  const link = (extra: Record<string, string>) => `/reports/expense-items?${new URLSearchParams({ ...base, ...extra }).toString()}`;
  const exportHref = `/reports/expense-items/export?${new URLSearchParams(base).toString()}`;
  const spanRest = 2 + storeCols.length;

  return (
    <Page density="wide">
      <div>
        <h1 className="text-2xl font-semibold">Spending by Item</h1>
        <PageDescription>
          What was spent, by group, category, sub-category and item, from posted expenses only. Each expense is split over the items on
          its bill; money that matches no item is shown as {UNITEMISED_NAME}.
        </PageDescription>
      </div>

      <form
        method="GET"
        action="/reports/expense-items"
        className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
      >
        <FormGrid layout="fields" className="[&.erp-form-fields]:items-end">
          <Field label="Store" width="name">
            <Select name="store" defaultValue={storeId ?? ''} className="w-full">
              {scope.coversWholeOrg || scope.stores.length > 1 ? <option value="">All stores</option> : null}
              {scope.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" width="date">
            <Input type="date" name="from" defaultValue={from} className="w-full" />
          </Field>
          <Field label="To" width="date">
            <Input type="date" name="to" defaultValue={to} className="w-full" />
          </Field>
          <div style={{ flex: 'none' }}>
            <Button type="submit" variant="primary">
              Apply
            </Button>
          </div>
        </FormGrid>
      </form>

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-medium text-neutral-800 dark:text-neutral-200">
            {scope.orgName} ({scope.orgCode})
          </span>
          {' · '}
          {from} to {to}
          {' · '}
          Total {formatMoney(report.total)}
        </p>
        <CsvExportLink href={exportHref} />
      </div>

      {lines !== null ? (
        <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-2 text-base font-semibold">Bill lines behind this item</h2>
          {lines.length === 0 ? (
            <p>No bill lines in this range.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Store</Th>
                  <Th numeric>Quantity</Th>
                  <Th numeric>Line total</Th>
                  <Th numeric>Counted here</Th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <LinkRow key={`${l.invoiceId}-${l.lineNo}`}>
                    <Td>
                      <RowLink href={`/ap/invoices/${l.invoiceId}`}>{l.invoiceDate}</RowLink>
                    </Td>
                    <Td>{storeName.get(l.storeId) ?? 'Store'}</Td>
                    <NumTd>
                      {l.quantity} {l.unit}
                    </NumTd>
                    <NumTd>{formatMoney(l.lineTotal)}</NumTd>
                    <NumTd>{formatMoney(l.attributed)}</NumTd>
                  </LinkRow>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      ) : null}

      {loose !== null ? (
        <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="mb-2 text-base font-semibold">Expenses with money not matched to an item</h2>
          {loose.length === 0 ? (
            <p>None in this range.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Store</Th>
                  <Th numeric>Amount</Th>
                  <Th>Particulars</Th>
                </tr>
              </thead>
              <tbody>
                {loose.map((e) => (
                  <LinkRow key={e.expenseId}>
                    <Td>
                      <RowLink href={`/ap/invoices/${e.invoiceId}`}>{e.businessDate}</RowLink>
                    </Td>
                    <Td>{storeName.get(e.storeId) ?? 'Store'}</Td>
                    <NumTd>{formatMoney(e.amount)}</NumTd>
                    <Td>{e.particulars}</Td>
                  </LinkRow>
                ))}
              </tbody>
            </Table>
          )}
        </section>
      ) : null}

      {report.groups.length === 0 ? (
        <EmptyState message="No posted expenses in this range." />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Group / category / item</Th>
              <Th numeric>Spent</Th>
              <Th numeric>% of total</Th>
              <Th numeric>Times bought</Th>
              <Th numeric>Average price</Th>
              {storeCols.map((st) => (
                <Th key={st.id} numeric>
                  {st.name}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.groups.flatMap((g) => [
              <tr key={g.group} className="bg-canvas font-semibold">
                <Td>{GROUP_LABEL[g.group] ?? g.group}</Td>
                <NumTd>{formatMoney(g.total)}</NumTd>
                <NumTd>{pct(g.pct)}</NumTd>
                <Td colSpan={spanRest} />
              </tr>,
              ...g.categories.flatMap((c) => [
                <tr key={c.categoryId} className="font-medium">
                  <Td className="pl-6">{c.category}</Td>
                  <NumTd>{formatMoney(c.total)}</NumTd>
                  <NumTd>{pct(c.pct)}</NumTd>
                  <Td colSpan={spanRest} />
                </tr>,
                ...c.subcategories.flatMap((sc) => [
                  <tr key={`${c.categoryId}-${sc.subcategoryId ?? 'none'}`} className="text-muted">
                    <Td className="pl-10 italic">{sc.name}</Td>
                    <NumTd>{formatMoney(sc.total)}</NumTd>
                    <NumTd>{pct(sc.pct)}</NumTd>
                    <Td colSpan={spanRest} />
                  </tr>,
                  ...sc.items.map((i) => (
                    <LinkRow key={`${c.categoryId}-${sc.subcategoryId ?? 'none'}-${i.itemId ?? 'loose'}`}>
                      <Td className="pl-14">
                        <RowLink href={i.itemId ? link({ item: i.itemId }) : link({ unitemised: c.categoryId })}>{i.name}</RowLink>
                      </Td>
                      <NumTd>{formatMoney(i.total)}</NumTd>
                      <NumTd>{pct(i.pct)}</NumTd>
                      <NumTd>{i.itemId ? i.timesBought : ''}</NumTd>
                      <NumTd>{i.avgUnitPrice ? `${formatMoney(i.avgUnitPrice)}${i.baseUnit ? ` / ${i.baseUnit}` : ''}` : ''}</NumTd>
                      {storeCols.map((st) => {
                        const b = i.byStore.find((x) => x.storeId === st.id);
                        return <NumTd key={st.id}>{b ? `${formatMoney(b.total)}${i.itemId ? ` (${b.timesBought}x)` : ''}` : '-'}</NumTd>;
                      })}
                    </LinkRow>
                  )),
                ]),
              ]),
            ])}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
