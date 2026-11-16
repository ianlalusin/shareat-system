import Link from 'next/link';
import { requirePageAccess } from '../../../lib/page-access';
import { recordCountAction } from '../actions';
import { countedValueFor, listStores, loadMergedLines, loadOpeningPosted, loadRoomCountSheet, loadRooms, peso } from '../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { CUTOVER_COUNT } from './typed-forms';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { CUTOVER_COUNT_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { decimal, multiplyToMoney } from '@shareat/core/money';
import { formatBusinessDayLong } from '@shareat/core/datetime';
import { Banner, Button, FlashBanner, FormGrid, Field, Input, NumTd, SectionTabs, Table, Td, Th } from '@/components/ui';

export const metadata = { title: 'Opening stock count — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  room?: string;
  /** `uncounted` = only the items with no count yet. */
  show?: string;
  /** Item search, a few words of the name. */
  q?: string;
  error?: string;
}

export default async function CountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/opening-balances/stock-count');
  if (refusal) return refusal;
  const stores = await listStores(actor.orgId);

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Opening stock count</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          There are no stores to count yet.
        </p>
      </Page>
    );
  }

  // T-390 DEF-630: one ROOM at a time. No `room` (or one that is not this store's) = the store's default room.
  const rooms = await loadRooms(actor.orgId, storeId);
  const room = rooms.find((r) => r.id === sp.room) ?? rooms.find((r) => r.isDefault) ?? rooms[0];
  if (!room) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Opening stock count</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">This store has no stock room to count in yet.</p>
      </Page>
    );
  }
  const roomId = room.id;

  const [allRows, countedValue, merged, opened] = await Promise.all([
    loadRoomCountSheet(actor.orgId, storeId, roomId),
    countedValueFor(actor.orgId, storeId),
    loadMergedLines(actor.orgId, storeId),
    loadOpeningPosted(actor.orgId),
  ]);
  const store = stores.find((s) => s.id === storeId)!;
  // T-591 B: once the books are open the page shows the counts and takes none (a save would only refuse).
  const readOnly = opened.posted;
  const missing = allRows.filter((r) => r.quantity === null);
  const countedN = allRows.length - missing.length;
  // Server-rendered filter and search, in the address: `show=uncounted`, `q=<words>`. No client state.
  const onlyMissing = sp.show === 'uncounted';
  const q = (sp.q ?? '').trim().slice(0, 80);
  const rows = allRows
    .filter((r) => !onlyMissing || r.quantity === null)
    .filter((r) => q === '' || r.name.toLowerCase().includes(q.toLowerCase()));

  const roomHref = `/opening-balances/stock-count?store=${storeId}&room=${roomId}`;
  const filterHref = (uncounted: boolean) => `${roomHref}${uncounted ? '&show=uncounted' : ''}`;

  return (
    <Page density="table">
      <div>
        <Link
          href="/opening-balances"
          className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}
        >
          ← Back to opening balances
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Opening stock count — {store.name}, {room.name}</h1>
        <PageDescription>
          A one-time count for the stores moving to this system on 1 January 2027: what is on the shelf, and what it cost.
          This becomes the opening inventory figure, so a guess here is a wrong number in every month that follows. A new
          store starts at zero and records stock through deliveries, transfers and its first normal stock count.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {readOnly && (
        <Banner tone="info">
          <strong className="font-medium">
            The books were opened on {opened.entryDate ? formatBusinessDayLong(opened.entryDate) : 'an earlier date'}.
          </strong>{' '}
          These counts are read-only. A correction is now a reversal or an ordinary stock document.
        </Banner>
      )}

      {/* Switching stores. ⭐ Four stores, four counts — a single tick would hide the one nobody
          visited, so each is entered and shown on its own. */}
      {stores.length > 1 && (
        <SectionTabs
          label="Stores"
          current={`/opening-balances/stock-count?store=${storeId}`}
          items={stores.map((s) => ({ href: `/opening-balances/stock-count?store=${s.id}`, label: s.name }))}
        />
      )}

      {/* A count belongs to a ROOM. Each room is counted and edited on its own: a store total is never a form. */}
      {rooms.length > 1 && (
        <SectionTabs
          label="Rooms"
          current={roomHref}
          items={rooms.map((r) => ({ href: `/opening-balances/stock-count?store=${storeId}&room=${r.id}`, label: r.name }))}
        />
      )}

      {/* Stays in view while the list scrolls. A phone has its own sticky top bar (h-14); from md the page owns the top edge. */}
      <div className="sticky top-14 z-20 -mx-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-surface-border bg-canvas px-4 py-2 text-sm md:top-0 md:-mx-6 md:px-6">
        <p className="text-ink">
          <span className="font-semibold">Counted {countedN} of {allRows.length} items in {room.name}.</span>{' '}
          <Link href={`/opening-balances/stock-count/sheet?store=${storeId}&room=${roomId}`} className={ACTION_LINK}>
            Print the count sheet
          </Link>
        </p>
        <p className="text-muted">
          Whole store (all rooms), at cost:{' '}
          <span className="font-mono text-base font-semibold tabular-nums text-ink">{peso(Number(countedValue))}</span>
        </p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <SectionTabs
          label="Items shown"
          current={filterHref(onlyMissing)}
          items={[
            { href: filterHref(false), label: `All items (${allRows.length})` },
            { href: filterHref(true), label: `Not counted yet (${missing.length})` },
          ]}
        />
        <FilterRow submitLabel="Search">
          <input type="hidden" name="store" value={storeId} />
          <input type="hidden" name="room" value={roomId} />
          {onlyMissing && <input type="hidden" name="show" value="uncounted" />}
          <label className="min-w-48 flex-1 text-sm">
            <span className="block font-medium">Search items</span>
            <Input name="q" type="search" defaultValue={q} className="mt-1 w-full" />
          </label>
        </FilterRow>
      </div>

      {/*
        ⭐ AN ITEM SILENTLY ABSENT IS NOT AN ITEM COUNTED AS ZERO.

        The two look identical on a sheet of paper, and that is how stock quietly goes missing from
        an opening balance. So an uncounted item shows as "not counted" — a blank, not a zero — and
        a real zero has to be typed on purpose.
      */}
      {!readOnly && (
        <p className="text-sm text-muted">
          {missing.length > 0 ? (
            <>
              If the shelf is genuinely empty, enter <span className="font-mono">0</span>: that is a real answer, and a different one from never
              having looked.
            </>
          ) : (
            'Every active item has a count in this room.'
          )}
        </p>
      )}

      {/* DEF-630: an item counted in more than one room is shown here ONCE, as a total, READ-ONLY. It has no form: editing a
          total would write it into one room and count the other room twice. Edit each room's own line. */}
      {merged.length > 0 && (
        <section className="rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <h2 className="font-medium">Counted in more than one room (read-only)</h2>
          <ul className="mt-2 space-y-1 text-neutral-600 dark:text-neutral-400">
            {merged.map((m) => (
              <li key={m.itemId}>
                {m.name}: {m.total} {m.baseUnit} in all ({m.parts.map((p) => `${p.room} ${p.quantity}`).join(', ')})
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-neutral-500">To change a figure, open that room and edit its own line.</p>
        </section>
      )}

      {rows.length > 0 && (
        <Table label={`Opening stock count, ${room.name}`} card={{ title: 'Item', keys: ['Quantity', 'Value'] }}>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th>Unit</Th>
              <Th numeric>Quantity</Th>
              <Th numeric>Cost per unit</Th>
              <Th numeric>Value</Th>
              {!readOnly && (
                <Th>
                  <span className="sr-only">Count</span>
                </Th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const head = (
                <>
                  <Td className="font-medium">
                    {r.name}
                    {r.quantity === null && <span className="block text-xs font-normal text-warning-ink">Not counted</span>}
                  </Td>
                  <Td className="text-muted">{r.baseUnit}</Td>
                </>
              );
              if (r.quantity === null) {
                // ⭐ Uncounted: never a zero. Read-only says so in the cells; otherwise the row IS the add form.
                if (readOnly) {
                  return (
                    <tr key={r.itemId} className={onlyMissing ? undefined : 'bg-warning-soft'}>
                      {head}
                      <NumTd className="text-warning-ink">Not counted</NumTd>
                      <NumTd className="text-muted">—</NumTd>
                      <NumTd className="text-muted">—</NumTd>
                    </tr>
                  );
                }
                return (
                  <tr key={r.itemId} className={onlyMissing ? undefined : 'bg-warning-soft'}>
                    {head}
                    {/* T-384 A0: a row with no saved count is an ADD: open, ending in Save. */}
                    <Td colSpan={4}>
                      <CheckedForm rules={CUTOVER_COUNT_RULES} action={recordCountAction}>
                        <input type="hidden" name="storeId" value={storeId} />
                        <input type="hidden" name="locationId" value={roomId} />
                        <input type="hidden" name="itemId" value={r.itemId} />
                        {onlyMissing && <input type="hidden" name="show" value="uncounted" />}
                        <div className="flex flex-wrap items-end gap-3">
                          <FormGrid className="flex-1">
                            <Field label={`Quantity (${r.baseUnit})`} rule={CUTOVER_COUNT_RULES.quantity}>
                              <input
                                {...nativeAttrs(CUTOVER_COUNT_RULES.quantity)}
                                className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                              />
                            </Field>
                            <Field label={`Cost per ${r.baseUnit}`} rule={CUTOVER_COUNT_RULES.unitCost}>
                              <input
                                {...nativeAttrs(CUTOVER_COUNT_RULES.unitCost)}
                                inputMode="decimal"
                                className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                              />
                            </Field>
                          </FormGrid>
                          <Button type="submit" variant="secondary">
                            Save
                          </Button>
                        </div>
                      </CheckedForm>
                    </Td>
                  </tr>
                );
              }
              // A counted line: the figures are plain cells; the form lives behind Edit (locked until then).
              const value = r.unitCost === null ? null : multiplyToMoney(decimal(r.quantity, '14,3'), decimal(r.unitCost, '14,4'));
              return (
                <tr key={r.itemId}>
                  {head}
                  <NumTd>{r.quantity}</NumTd>
                  <NumTd>
                    {r.unitCost ?? '—'}
                    {r.costSource && r.costSource !== 'typed' && <span className="block text-xs text-muted">{r.costSource}</span>}
                  </NumTd>
                  <NumTd>{value === null ? '—' : peso(value)}</NumTd>
                  {!readOnly && (
                    <Td>
                      {/* Keyed on the stored figures so a save comes back locked and showing them. */}
                      <EditableRecord
                        key={`${r.itemId}:${roomId}:${r.quantity}:${r.unitCost ?? ''}`}
                        action={recordCountAction}
                        rules={CUTOVER_COUNT_RULES}
                        label={r.name}
                        hidden={{ storeId, locationId: roomId, itemId: r.itemId, ...(onlyMissing ? { show: 'uncounted' } : {}) }}
                        typed={typedFor(sp, CUTOVER_COUNT, `${r.itemId}:${roomId}`, actor.personId)}
                      >
                        <FormGrid>
                          <Field label={`Quantity (${r.baseUnit})`} rule={CUTOVER_COUNT_RULES.quantity}>
                            <input
                              {...nativeAttrs(CUTOVER_COUNT_RULES.quantity)}
                              defaultValue={r.quantity}
                              className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                            />
                          </Field>
                          <Field label={`Cost per ${r.baseUnit}`} rule={CUTOVER_COUNT_RULES.unitCost}>
                            <input
                              {...nativeAttrs(CUTOVER_COUNT_RULES.unitCost)}
                              inputMode="decimal"
                              defaultValue={r.unitCost ?? ''}
                              className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                            />
                          </Field>
                        </FormGrid>
                      </EditableRecord>
                    </Td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {allRows.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          There are no active items to count. Import the item master first.
        </p>
      ) : (
        rows.length === 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {q !== '' ? `No items match "${q}".` : 'Every item in this room has a count.'}{' '}
            <Link href={roomHref} className={ACTION_LINK}>
              Show all items
            </Link>
          </p>
        )
      )}
    </Page>
  );
}
