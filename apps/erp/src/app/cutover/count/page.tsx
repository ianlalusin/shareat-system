import Link from 'next/link';
import { requireSession } from '../../../lib/session';
import { recordCountAction } from '../actions';
import { countedValueFor, listStores, loadCountSheet, peso } from '../lib';
import { Page } from '@/components/shell/Page';
import { ACTION_LINK } from '@/components/action-link';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { EditableRecord } from '@/components/forms';
import { Banner, Button, FlashBanner, FormGrid, Field } from '@/components/ui';

export const metadata = { title: 'Opening count — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

export default async function CountPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/cutover/count');
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

  const [rows, countedValue] = await Promise.all([
    loadCountSheet(actor.orgId, storeId),
    countedValueFor(actor.orgId, storeId),
  ]);
  const store = stores.find((s) => s.id === storeId)!;
  const missing = rows.filter((r) => r.quantity === null);

  return (
    <Page density="table">
      <div>
        <Link
          href="/cutover"
          className={`${ACTION_LINK} text-neutral-500 dark:text-neutral-400`}
        >
          ← Back to the conversion
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Opening count — {store.name}</h1>
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

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <span className="text-neutral-600 dark:text-neutral-400">Counted so far, at cost</span>
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
            {missing.length} item{missing.length === 1 ? '' : 's'} not counted yet.
          </strong>
          <p className="mt-1 text-xs">
            If the shelf is genuinely empty, enter <span className="font-mono">0</span> — that is a
            real answer and a different one from never having looked.
          </p>
        </Banner>
      ) : (
        <Banner tone="success">Every active item has a count at this store.</Banner>
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
                {r.quantity === null ? 'Not counted' : `Counted ${r.quantity} ${r.baseUnit}`}
              </span>
            </div>

            {/* T-384 A0: a row with no saved count is an ADD: open, ending in Save. A saved count is locked until Edit
                (keyed on the stored figures so a save comes back locked and showing them). */}
            <div className="mt-2">
              {r.quantity === null ? (
                <form action={recordCountAction}>
                  <input type="hidden" name="storeId" value={storeId} />
                  <input type="hidden" name="itemId" value={r.itemId} />
                  <FormGrid>
                    <Field label={<span className="sr-only">Quantity in {r.baseUnit}</span>}>
                      <input
                        name="quantity"
                        required
                        placeholder={`Quantity (${r.baseUnit})`}
                        inputMode="decimal"
                        className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                      />
                    </Field>
                    <Field label={<span className="sr-only">Cost per {r.baseUnit}</span>}>
                      <input
                        name="unitCost"
                        placeholder={`Cost per ${r.baseUnit}`}
                        inputMode="decimal"
                        className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                      />
                    </Field>
                  </FormGrid>
                  <Button type="submit" variant="secondary" className="mt-3">
                    Save
                  </Button>
                </form>
              ) : (
                <EditableRecord
                  key={`${r.itemId}:${r.quantity}:${r.unitCost ?? ''}`}
                  action={recordCountAction}
                  label={r.name}
                  hidden={{ storeId, itemId: r.itemId }}
                >
                  <FormGrid>
                    <Field label={<span className="sr-only">Quantity in {r.baseUnit}</span>}>
                      <input
                        name="quantity"
                        required
                        defaultValue={r.quantity}
                        placeholder={`Quantity (${r.baseUnit})`}
                        inputMode="decimal"
                        className="w-full rounded-[10px] border border-field-border bg-field px-3 py-2 min-h-11 text-sm"
                      />
                    </Field>
                    <Field label={<span className="sr-only">Cost per {r.baseUnit}</span>}>
                      <input
                        name="unitCost"
                        defaultValue={r.unitCost ?? ''}
                        placeholder={`Cost per ${r.baseUnit}`}
                        inputMode="decimal"
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
