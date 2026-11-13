import Link from 'next/link';
import { WASTAGE_REASONS, WASTAGE_REASON_LABEL, wastageReasonLabel } from '@shareat/domain';
import { addDays, toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { saveUsageDraftAction } from './actions';
import { listStores, usageQueueData, usageScreenData } from './lib';
import { NewUsageForm } from './NewUsageForm';
import { ACTION_LINK } from '@/components/action-link';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Badge, Banner, EmptyState, FlashBanner, FormModal, Input, LinkRow, NumTd, RowLink, Select, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Usage & wastage — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  date?: string;
  error?: string;
  ok?: string;
}

const KIND_LABEL: Record<string, string> = { usage: 'Usage', wastage: 'Wastage', adjustment: 'Adjustment', opening: 'Opening' };

/** A stored `numeric` for display: no trailing zeros ('10.000' -> '10', '10.500' -> '10.5'). */
function plainQty(q: string): string {
  return q.includes('.') ? q.replace(/0+$/, '').replace(/\.$/, '') : q;
}

/** '0.1000' -> '10%', '0.0250' -> '2.5%'. Exact (decimal string arithmetic, no floats). */
function pctOf(tolerance: string): string {
  const [whole = '0', frac = ''] = tolerance.split('.');
  const padded = frac.padEnd(4, '0');
  const pct = BigInt(whole) * 100n + BigInt(padded.slice(0, 2));
  const rest = padded.slice(2).replace(/0+$/, '');
  return `${pct}${rest ? `.${rest}` : ''}%`;
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/usage');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { locations, departments, items, records } = await usageScreenData(actor.orgId, storeId);
  // The band table is for one business date: the one asked for, else yesterday (the day a manager is expected to have posted).
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : addDays(toBusinessDate(), -1);
  const queue = await usageQueueData(actor.orgId, actor, storeId, date);

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Usage &amp; wastage</h1>
          <PageDescription className="mt-1">
            A floor worker records what was consumed or spoiled; a manager posts it. Posting is the
            only step that moves stock and hits the books.
          </PageDescription>
        </div>
        <Link href={`/inventory?store=${storeId}`} className="text-sm underline underline-offset-4">
          ← Stock on hand
        </Link>
      </div>

      <FlashBanner flash={sp} />

      <FilterRow>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
          <Select name="store" defaultValue={storeId}>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </label>
        <label className="text-sm">
          <span className="block text-neutral-600 dark:text-neutral-400">Check date</span>
          <Input type="date" name="date" defaultValue={date} />
        </label>
      </FilterRow>

      {/* T-401 S6: the check. Per item the POS plan covers on that day: what the plan expects, what staff recorded, inside or outside the band. */}
      <section>
        <h2 className="text-lg font-medium">Usage check for {date}</h2>
        {queue.variances.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            Nothing to check for this date: no POS plan covers an item that day.
          </p>
        ) : (
          <Table card={{ title: 'Item', keys: ['Expected', 'Recorded'] }}>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th numeric>Expected</Th>
                <Th numeric>Recorded</Th>
                <Th numeric>Used in cooking</Th>
                <Th>Check</Th>
              </tr>
            </thead>
            <tbody>
              {queue.variances.map((v) => (
                <tr key={v.itemId}>
                  <Td>{v.itemName}</Td>
                  <NumTd>{plainQty(v.expected)}</NumTd>
                  <NumTd>{plainQty(v.actual)}</NumTd>
                  <NumTd>{v.cooked && plainQty(v.cooked) !== '0' ? plainQty(v.cooked) : ''}</NumTd>
                  <Td className={v.withinBand ? 'text-success' : 'text-danger'}>
                    {v.withinBand ? `Within ${pctOf(v.tolerance)}` : `Outside ${pctOf(v.tolerance)}`}
                    {!v.withinBand && plainQty(v.actual) === '0' ? ' (nothing recorded yet)' : ''}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {/* T-419: display only. Cooking from a recipe took these out of stock when it was posted; they are not recorded or posted from here. */}
      <section>
        <h2 className="text-lg font-medium">Used in cooking on {date}</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Taken from stock when the cooking was posted. Drafts have not taken anything yet. Shown for the full picture; not posted again from here.
        </p>
        {queue.cooked.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No cooking from a recipe was recorded for this date.</p>
        ) : (
          <Table card={{ title: 'Item', subtitle: 'From', keys: ['Quantity'] }}>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th numeric>Quantity</Th>
                <Th>From</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {queue.cooked.map((c, i) => (
                <LinkRow key={`${c.recordId}-${c.itemId}-${i}`}>
                  <Td>{c.itemName}</Td>
                  <NumTd className={c.isDraft ? 'text-muted' : ''}>
                    {plainQty(c.quantity)} {c.unit}
                  </NumTd>
                  <Td>
                    <RowLink href={`/inventory/production/${c.recordId}`}>
                      Recipe: {c.recipeName}
                    </RowLink>
                  </Td>
                  <Td>
                    {c.isDraft ? <span className="text-xs text-warning-ink">Draft — not posted yet</span> : 'Posted'}
                  </Td>
                </LinkRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section>
        <h2 className="text-lg font-medium">Drafts waiting for a manager</h2>
        {queue.drafts.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">No usage drafts are waiting.</p>
        ) : (
          <Table card={{ title: 'Room', subtitle: 'Date', keys: ['Status'] }}>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Room</Th>
                <Th>Written by</Th>
                <Th>Lines</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {queue.drafts.map((d) => (
                <LinkRow key={d.id}>
                  <Td>
                    <RowLink href={`/inventory/usage/${d.id}`}>
                      {d.usedOn}
                    </RowLink>
                  </Td>
                  <Td>{d.locationName}</Td>
                  <Td>{d.createdByName}</Td>
                  <Td className="text-muted">
                    {d.lines.map((l) => `${l.itemName} ${plainQty(l.quantity)} ${l.unit}`).join('; ')}
                  </Td>
                  <Td>
                    <Badge status={d.status} />
                    {d.pullVoided && (
                      <span className="ml-2 text-xs text-warning-ink">Pull voided — check this draft against what was really used.</span>
                    )}
                  </Td>
                </LinkRow>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {locations.length === 0 ? (
        <Banner tone="warning">
          This store has no active operating room yet — a usage can only be recorded from one. Add
          one under{' '}
          <Link href={`/inventory/locations?store=${storeId}`} className="text-sm underline underline-offset-4">
            Locations
          </Link>
          .
        </Banner>
      ) : null}

      <section>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium">Records</h2>
          {/* T-448: the new-record form opens from a button. */}
          {locations.length > 0 ? (
            <FormModal trigger="+ New record" title="New record" size="lg">
              <NewUsageForm
                action={saveUsageDraftAction}
                storeId={storeId}
                locations={locations}
                departments={departments}
                items={items}
                reasons={WASTAGE_REASONS.map((value) => ({ value, label: WASTAGE_REASON_LABEL[value] }))}
                today={toBusinessDate()}
              />
            </FormModal>
          ) : null}
        </div>
        {records.length === 0 ? (
          <EmptyState
            illustration="truck"
            title="Nothing recorded yet"
            body="A draft records what was consumed or spoiled. Posting is the step that moves stock."
          />
        ) : (
          <Table card={{ title: 'Kind', subtitle: 'Date', keys: ['Status'] }}>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Kind</Th>
                <Th>Room</Th>
                <Th>Reason</Th>
                <Th numeric>Lines</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <LinkRow key={r.id}>
                  <Td>
                    <RowLink href={`/inventory/usage/${r.id}`}>
                      {r.usedOn}
                    </RowLink>
                  </Td>
                  <Td>{KIND_LABEL[r.kind] ?? r.kind}</Td>
                  <Td>{r.locationName}</Td>
                  <Td className="text-muted">{r.reasonCode ? wastageReasonLabel(r.reasonCode) : '—'}</Td>
                  <NumTd>{r.lineCount}</NumTd>
                  <Td>
                    <Badge status={r.status} />
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
