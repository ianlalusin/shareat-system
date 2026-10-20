import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '../../../../lib/session';
import { setPriceAction } from '../../actions';
import { getListDetail, peso } from '../../lib';
import { listItems } from '../../../items/lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { Button, FlashBanner, Input, Select } from '@/components/ui';
import { CheckedForm, FieldCheck } from '@/components/forms';
import { PRICE_SET_RULES, nativeAttrs, type FieldRule } from '@shareat/domain/field-rules';

export const metadata = { title: 'Price list — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  error?: string;
  ok?: string;
}

export default async function PriceListPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession(`/customers/price-lists/${id}`);

  const [list, allItems] = await Promise.all([
    getListDetail(actor.orgId, id),
    listItems(actor.orgId, false),
  ]);
  if (!list) notFound();

  return (
    <Page view="detail" sectioned density="table">
      <div>
        <Link href="/customers/price-lists" className="text-sm underline underline-offset-2">
          ← Price lists
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{list.name}</h1>
        {list.description && (
          <PageDescription>{list.description}</PageDescription>
        )}
      </div>

      <FlashBanner flash={sp} />

      {list.items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">Item</th>
                <th className="px-3 py-2 font-medium">Unit</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((i) => (
                <tr
                  key={i.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-xs">{i.itemCode}</span>
                    {i.itemName && (
                      <div className="text-xs text-neutral-400 dark:text-neutral-600">
                        {i.itemName}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{i.unit ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{peso(i.rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Nothing priced yet. ⚠️ A customer on this list has no rate for any item until something is
          added — and an unpriced item is refused rather than assumed free.
        </p>
      )}

      <section className="space-y-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Set a rate</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            ⚠️ Re-quoting an item <strong>replaces</strong> its rate — a list holds one price per
            item, not a history. ⭐ Items come from the item master now (T-145) — pick one rather
            than typing a code, so the same product cannot exist under three spellings.
          </p>
        </div>
        <CheckedForm rules={PRICE_SET_RULES} action={setPriceAction} className="space-y-3">
          <input type="hidden" name="priceListId" value={list.id} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Item" hint="From the item master. No item? Add it under /items first." rule={PRICE_SET_RULES.itemId}>
              <Select {...nativeAttrs(PRICE_SET_RULES.itemId)} defaultValue="" className="w-full">
                <option value="" disabled>
                  {allItems.length === 0 ? 'No items yet' : 'Select…'}
                </option>
                {allItems.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.code}) — priced per {it.baseUnit}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rate" hint="Zero is allowed — a sample is genuinely free." rule={PRICE_SET_RULES.rate}>
              <input {...nativeAttrs(PRICE_SET_RULES.rate)} name="rate" inputMode="decimal" className="w-full min-h-11 rounded-[10px] border border-field-border bg-field px-3 py-2 text-sm text-ink" />
            </Field>
            <Field label="Unit" hint="Optional.">
              <Input name="unit" placeholder="kg" className="w-full" />
            </Field>
          </div>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </CheckedForm>
      </section>
    </Page>
  );
}

function Field({
  label,
  hint,
  rule,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  rule?: FieldRule;
  children: React.ReactNode;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-neutral-500 dark:text-neutral-500">{hint}</span>}
    </>
  );
  // T-440: a ruled field puts its live helper line OUTSIDE the label, so the line never joins the accessible name.
  if (!rule) return <label className="flex flex-col gap-1">{body}</label>;
  return (
    <div>
      <label className="flex flex-col gap-1">{body}</label>
      <FieldCheck rule={rule} />
    </div>
  );
}
