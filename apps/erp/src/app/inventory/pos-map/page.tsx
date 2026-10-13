import Link from 'next/link';
import { authorize, AuthorizationError } from '@shareat/auth';
import { requireSession } from '../../../lib/session';
import { upsertPosItemMapAction, decideMapRequestAction } from './actions';
import { listStores, posMapScreenData, withOrgPrincipal } from './lib';
import { Page } from '@/components/shell/Page';
import { Button, Checkbox, FlashBanner, FormGrid, Field, Input, Select } from '@/components/ui';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'POS item mapping — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
  needsConfirmation?: string;
}

const MODE_LABEL: Record<string, string> = { direct: 'Direct → stock item', recipe: 'Recipe → ingredients', no_stock: 'Sells, no stock consumed' };

export default async function PosMapPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/inventory/pos-map');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">POS item mapping</h1>
        <p className="mt-4 text-sm text-neutral-600">This organisation has no stores yet.</p>
      </Page>
    );
  }

  const { maps, requests, items, recipes, locations } = await posMapScreenData(actor.orgId, storeId);
  // T-403: only admin edits a mapping. The server refusal is the real guard; this hides a form that would always fail.
  const canEditMap = await withOrgPrincipal(actor.orgId, async (tx) => {
    try {
      await authorize(tx, actor, 'manage_pos_map', { storeId });
      return true;
    } catch (err) {
      if (err instanceof AuthorizationError) return false;
      throw err;
    }
  });
  const openRequests = requests.filter((r) => r.status === 'requested');

  return (
    <Page density="table" className="space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">POS item mapping</h1>
          <PageDescription className="mt-1">
            A standing decision: what a POS item means for stock — one item, a recipe, or an
            explicit &ldquo;sells, consumes nothing.&rdquo;
          </PageDescription>
        </div>
        <Link href={`/inventory/pos-usage?store=${storeId}`} className="text-sm underline underline-offset-4">
          Daily usage pull →
        </Link>
      </div>

      <FlashBanner
        flash={
          sp.needsConfirmation && sp.error
            ? { ...sp, error: `${sp.error} Tick "confirm sharing" below and save again if that is intended.` }
            : sp
        }
      />

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

      {openRequests.length > 0 && (
        <section className="rounded-lg border border-warning bg-warning-soft p-4">
          <h2 className="text-sm font-medium">Requests waiting on a decision ({openRequests.length})</h2>
          <div className="mt-3 space-y-3">
            {openRequests.map((r) => (
              <form key={r.id} action={decideMapRequestAction} className="flex flex-wrap items-center gap-2 text-sm">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="requestId" value={r.id} />
                <span className="font-medium">{r.posItemName}</span>
                <span className="text-neutral-500">({r.posItemKey})</span>
                {r.note && <span className="text-neutral-600 dark:text-neutral-400">— {r.note}</span>}
                <Input name="note" placeholder="decision note (optional)" className="flex-1 min-w-[10rem]" />
                <Button type="submit" name="decision" value="approved" variant="secondary">
                  Approve (no stock)
                </Button>
                <Button type="submit" name="decision" value="rejected" variant="secondary">
                  Reject
                </Button>
              </form>
            ))}
          </div>
        </section>
      )}

      {canEditMap && (
      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">New / edit mapping</h2>
        <form action={upsertPosItemMapAction} className="mt-3 space-y-3">
          <input type="hidden" name="storeId" value={storeId} />
          <FormGrid>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">POS item key</span>} className="text-sm">
            <Input name="posItemKey" required className="w-full" />
          </Field>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">POS item name</span>} className="text-sm">
            <Input name="posItemName" required className="w-full" />
          </Field>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Mode</span>} className="text-sm">
            <Select name="mode" className="w-full" defaultValue="direct">
              <option value="direct">Direct → one stock item</option>
              <option value="recipe">Recipe → ingredients</option>
              <option value="no_stock">Sells, consumes no stock</option>
            </Select>
          </Field>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Stock item (direct)</span>} className="text-sm">
            <Select name="itemId" className="w-full">
              <option value="">—</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code} — {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Quantity per sale (direct)</span>} className="text-sm">
            <Input name="quantityPerSale" defaultValue="1" className="w-full" />
          </Field>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Recipe</span>} className="text-sm">
            <Select name="recipeId" className="w-full">
              <option value="">—</option>
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={<span className="text-neutral-600 dark:text-neutral-400">Location override (optional)</span>} className="text-sm">
            <Select name="locationId" className="w-full">
              <option value="">— use the pull&apos;s own location —</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Checkbox name="confirmShared" value="true" label="Confirm sharing this stock item across POS items" />
          </FormGrid>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form>
      </section>
      )}

      <section>
        <h2 className="text-lg font-medium">Active maps ({maps.filter((m) => m.status === 'active').length})</h2>
        <div className="mt-3 overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left dark:border-neutral-800 dark:bg-neutral-900">
                <th className="px-3 py-2 font-medium">POS item</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {maps.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-neutral-600 dark:text-neutral-400">
                    No maps yet.
                  </td>
                </tr>
              ) : (
                maps.map((m) => (
                  <tr key={m.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="px-3 py-2">
                      {m.posItemName} <span className="text-neutral-500">({m.posItemKey})</span>
                    </td>
                    <td className="px-3 py-2">{MODE_LABEL[m.mode] ?? m.mode}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {m.mode === 'direct'
                        ? (items.find((i) => i.id === m.itemId)?.name ?? m.itemId)
                        : m.mode === 'recipe'
                          ? (recipes.find((r) => r.id === m.recipeId)?.name ?? m.recipeId)
                          : '—'}
                    </td>
                    <td className="px-3 py-2">{m.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </Page>
  );
}
