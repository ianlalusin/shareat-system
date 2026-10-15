import Link from 'next/link';
import { toBusinessDate } from '@shareat/core/datetime';
import { requireSession } from '../../../lib/session';
import { saveProductionDraftAction } from './actions';
import { listStores, productionScreenData } from './lib';
import { Page } from '@/components/shell/Page';
import { Badge, Banner, Button, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'Production — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  kind?: string;
  error?: string;
  ok?: string;
}

const KIND_LABEL: Record<string, string> = { slice: 'Slice (slab -> pieces)', cook: 'Cook (recipe batch)', convert: 'Convert (re-cut, no GL impact)' };

const LINE_ROWS = 5;

type Kind = 'slice' | 'cook' | 'convert';
const KINDS: readonly Kind[] = ['slice', 'cook', 'convert'];

export default async function ProductionPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/production');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Production</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const kind: Kind = KINDS.find((k) => k === sp.kind) ?? 'slice';
  const { locations, items, inputItems, recipes, records } = await productionScreenData(actor.orgId, storeId);
  // T-409 R4: the pickers offer only what the server will accept. A slice takes a slab and makes sliced meat; a convert
  // re-cuts sliced meat into sliced meat. (The server refuses anything else too; this only saves the trip.)
  const slabInputs = inputItems.filter((i) => i.kind === 'meat_slab');
  const slicedInputs = inputItems.filter((i) => i.kind === 'meat_sliced');
  const slicedOutputs = items.filter((i) => i.kind === 'meat_sliced');
  const itemName = new Map(items.map((i) => [i.id, i]));

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Production</h1>
          <PageDescription className="mt-1">
            A slicing run or a prep batch posts as ONE stock transaction — inputs out, outputs in,
            cost carried across. A floor worker records the run; a manager posts it.
          </PageDescription>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/inventory/production/recipes" className="inline-flex min-h-11 items-center underline underline-offset-4">
            Recipes
          </Link>
          <Link href={`/inventory?store=${storeId}`} className="text-sm underline underline-offset-4">
            ← Stock on hand
          </Link>
        </div>
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
      </FilterRow>

      {locations.length === 0 ? (
        <Banner tone="warning">
          This store has no active operating room yet — a production run can only be recorded from
          one. Add one under{' '}
          <Link href={`/inventory/locations?store=${storeId}`} className="text-sm underline underline-offset-4">
            Locations
          </Link>
          .
        </Banner>
      ) : (
        <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-sm font-medium">New record</h2>
          <nav className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Kind of record">
            {KINDS.map((k) => (
              <Link
                key={k}
                href={`/inventory/production?store=${storeId}&kind=${k}`}
                aria-current={k === kind ? 'page' : undefined}
                className={k === kind ? 'rounded-md border border-neutral-900 px-3 py-1 font-medium dark:border-neutral-100' : 'rounded-md border border-neutral-200 px-3 py-1 underline-offset-4 hover:underline dark:border-neutral-800'}
              >
                {KIND_LABEL[k]}
              </Link>
            ))}
          </nav>
          {kind === 'cook' && recipes.length === 0 ? (
            <Banner tone="warning" className="mt-3">
              A cook starts from a recipe, and there is no active recipe yet. Ask an admin to add one; recipes can only be added by an admin.
            </Banner>
          ) : (
          <form action={saveProductionDraftAction} className="mt-3 space-y-4">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="kind" value={kind} />
            <FormGrid>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Room</span>} className="text-sm">
                <Select name="locationId" defaultValue={locations[0]?.id} className="w-full">
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Date</span>} className="text-sm">
                <Input type="date" name="producedOn" defaultValue={toBusinessDate()} className="w-full" />
              </Field>
              <Field label={<span className="text-neutral-600 dark:text-neutral-400">Labour cost (optional)</span>} className="text-sm">
                <Input type="text" name="labourCost" placeholder="0.00" className="w-full" />
              </Field>
            </FormGrid>

            {kind === 'cook' ? (
              <FormGrid>
                <Field label={<span className="text-neutral-600 dark:text-neutral-400">Recipe</span>} className="text-sm">
                  <Select name="recipeId" defaultValue={recipes[0]?.id} className="w-full">
                    {recipes.map((r) => {
                      const out = itemName.get(r.outputItemId);
                      return (
                        <option key={r.id} value={r.id}>
                          {r.name} — makes {r.outputQuantity} {out?.baseUnit ?? ''} of {out?.name ?? 'its output'}
                        </option>
                      );
                    })}
                  </Select>
                </Field>
                <Field label={<span className="text-neutral-600 dark:text-neutral-400">Quantity made (in the recipe&apos;s unit)</span>} className="text-sm">
                  <Input name="outputQuantity" placeholder="e.g. 4" className="w-full" />
                </Field>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  The ingredients are worked out from the recipe for the quantity made. You do not type them.
                </p>
              </FormGrid>
            ) : (
              <>
                <LineRows label="Inputs (what goes out)" prefix="input" items={kind === 'slice' ? slabInputs : slicedInputs} />
                <LineRows label="Outputs (what comes in)" prefix="output" items={slicedOutputs} />
              </>
            )}

            <Button type="submit" variant="primary">
              Save draft
            </Button>
          </form>
          )}
        </section>
      )}

      <section>
        <h2 className="text-lg font-medium">Records</h2>
        {records.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Nothing recorded yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Kind</th>
                  <th className="px-3 py-2 font-medium">Revision</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      <Link href={`/inventory/production/${r.id}`} className="underline underline-offset-4">
                        {r.producedOn}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{KIND_LABEL[r.kind] ?? r.kind}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.revision}</td>
                    <td className="px-3 py-2">
                      <Badge status={r.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
}

function LineRows({
  label,
  prefix,
  items,
}: {
  label: string;
  prefix: 'input' | 'output';
  items: { id: string; code: string; name: string; baseUnit: string }[];
}) {
  return (
    <div>
      <span className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
      <div className="mt-2 space-y-2">
        {Array.from({ length: LINE_ROWS }).map((_, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Select name={`${prefix}ItemId`} defaultValue="" className="w-full">
              <option value="">— item —</option>
              {items.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.code} — {it.name}
                </option>
              ))}
            </Select>
            <Input name={`${prefix}Quantity`} placeholder="quantity" className="w-full" />
            <Input name={`${prefix}Unit`} placeholder="unit (kg, g, ...)" className="w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
