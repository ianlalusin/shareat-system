import Link from 'next/link';
import { requirePageAccess } from '../../../lib/page-access';
import { recordCountAction } from '../actions';
import { countedValueFor, listStores, loadMergedLines, loadRoomCountSheet, loadRooms, peso } from '../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { typedFor } from '@/lib/keep-typing';
import { CUTOVER_COUNT } from './typed-forms';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { CUTOVER_COUNT_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Button, FlashBanner, FormGrid, Field } from '@/components/ui';

export const metadata = { title: 'Opening count — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  room?: string;
  error?: string;
}

export default async function CountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/cutover/count');
  if (refusal) return refusal;
  const stores = await listStores(actor.orgId);

  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;
  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Opening count</h1>
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
        <h1 className="text-2xl font-semibold">Opening count</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">This store has no stock room to count in yet.</p>
      </Page>
    );
  }
  const roomId = room.id;

  const [rows, countedValue, merged] = await Promise.all([
    loadRoomCountSheet(actor.orgId, storeId, roomId),
    countedValueFor(actor.orgId, storeId),
    loadMergedLines(actor.orgId, storeId),
  ]);
  const store = stores.find((s) => s.id === storeId)!;
  const missing = rows.filter((r) => r.quantity === null);
  const countedN = rows.length - missing.length;

  return (
    <Page density="table">
      <div>
        <Link
          href="/cutover"
          className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}
        >
          ← Back to the conversion
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Opening count — {store.name}, {room.name}</h1>
        <PageDescription>
          What is physically on the shelf on 31 December, and what it cost. This becomes the
          opening inventory figure, so a guess here is a wrong number in every month that follows.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {/* Switching stores. ⭐ Four stores, four counts — a single tick would hide the one nobody
          visited, so each is entered and shown on its own. */}
      {stores.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {stores.map((s) => (
            <Link
              key={s.id}
              href={`/cutover/count?store=${s.id}`}
              className={`rounded border px-3 py-2 text-sm ${
                s.id === storeId
                  ? 'border-ink bg-ink text-surface'
                  : 'border-surface-border'
              }`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}

      {/* A count belongs to a ROOM. Each room is counted and edited on its own: a store total is never a form. */}
      {rooms.length > 1 && (
        <nav aria-label="Rooms" className="flex flex-wrap gap-2">
          {rooms.map((r) => (
            <Link
              key={r.id}
              href={`/cutover/count?store=${storeId}&room=${r.id}`}
              aria-current={r.id === roomId ? 'page' : undefined}
              className={`rounded border px-3 py-2 text-sm ${
                r.id === roomId
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                  : 'border-neutral-300 dark:border-neutral-700'
              }`}
            >
              {r.name}
            </Link>
          ))}
        </nav>
      )}

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Counted {countedN} of {rows.length} items in {room.name}.{' '}
        <Link href={`/cutover/count/sheet?store=${storeId}&room=${roomId}`} className={ACTION_LINK}>
          Print the count sheet
        </Link>
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <span className="text-neutral-600 dark:text-neutral-400">Counted so far in the whole store (all rooms), at cost</span>
        <span className="font-mono text-lg font-medium tabular-nums">{peso(Number(countedValue))}</span>
      </div>

      {/*
        ⭐ AN ITEM SILENTLY ABSENT IS NOT AN ITEM COUNTED AS ZERO.

        The two look identical on a sheet of paper, and that is how stock quietly goes missing from
        an opening balance. So an uncounted item shows as "not counted" — a blank, not a zero — and
        a real zero has to be typed on purpose.
      */}
      {missing.length > 0 ? (
        <Banner tone="warning">
          <strong className="font-medium">
            {missing.length} item{missing.length === 1 ? '' : 's'} not counted yet in {room.name}.
          </strong>
          <p className="mt-1 text-xs">
            If the shelf is genuinely empty, enter <span className="font-mono">0</span> — that is a
            real answer and a different one from never having looked.
          </p>
        </Banner>
      ) : (
        <Banner tone="success">Every active item has a count in this room.</Banner>
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

      <div className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.itemId}
            className={`rounded-lg border p-3 ${
              r.quantity === null
                ? 'border-warning-ink'
                : 'border-neutral-200 dark:border-neutral-800'
            }`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{r.name}</span>
              <span className="text-xs text-neutral-500 dark:text-neutral-500">
                {r.quantity === null
                  ? 'Not counted'
                  : `Counted ${r.quantity} ${r.baseUnit}${r.costSource ? ` · cost ${r.costSource}` : ''}`}
              </span>
            </div>

            {/* T-384 A0: a row with no saved count is an ADD: open, ending in Save. A saved count is locked until Edit
                (keyed on the stored figures so a save comes back locked and showing them). */}
            <div className="mt-2">
              {r.quantity === null ? (
                <CheckedForm rules={CUTOVER_COUNT_RULES} action={recordCountAction}>
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="locationId" value={roomId} />
                  <input type="hidden" name="itemId" value={r.itemId} />
                  <FormGrid>
                    <Field label={<span className="sr-only">Quantity in {r.baseUnit}</span>} rule={CUTOVER_COUNT_RULES.quantity}>
                      <input
                        {...nativeAttrs(CUTOVER_COUNT_RULES.quantity)}
                        placeholder={`Quantity (${r.baseUnit})`}
                        className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                      />
                    </Field>
                    <Field label={<span className="sr-only">Cost per {r.baseUnit}</span>} rule={CUTOVER_COUNT_RULES.unitCost}>
                      <input
                        {...nativeAttrs(CUTOVER_COUNT_RULES.unitCost)}
                        inputMode="decimal"
                        placeholder={`Cost per ${r.baseUnit}`}
                        className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                      />
                    </Field>
                  </FormGrid>
                  <Button type="submit" variant="secondary" className="mt-3">
                    Save
                  </Button>
                </CheckedForm>
              ) : (
                <EditableRecord
                  key={`${r.itemId}:${roomId}:${r.quantity}:${r.unitCost ?? ''}`}
                  action={recordCountAction}
                  rules={CUTOVER_COUNT_RULES}
                  label={r.name}
                  hidden={{ storeId, locationId: roomId, itemId: r.itemId }}
                  typed={typedFor(sp, CUTOVER_COUNT, `${r.itemId}:${roomId}`, actor.personId)}
                >
                  <FormGrid>
                    <Field label={<span className="sr-only">Quantity in {r.baseUnit}</span>} rule={CUTOVER_COUNT_RULES.quantity}>
                      <input
                        {...nativeAttrs(CUTOVER_COUNT_RULES.quantity)}
                        defaultValue={r.quantity}
                        placeholder={`Quantity (${r.baseUnit})`}
                        className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                      />
                    </Field>
                    <Field label={<span className="sr-only">Cost per {r.baseUnit}</span>} rule={CUTOVER_COUNT_RULES.unitCost}>
                      <input
                        {...nativeAttrs(CUTOVER_COUNT_RULES.unitCost)}
                        inputMode="decimal"
                        defaultValue={r.unitCost ?? ''}
                        placeholder={`Cost per ${r.baseUnit}`}
                        className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                      />
                    </Field>
                  </FormGrid>
                </EditableRecord>
              )}
            </div>
          </div>
        ))}
      </div>

      {rows.length === 0 && (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          There are no active items to count. Import the item master first.
        </p>
      )}
    </Page>
  );
}
