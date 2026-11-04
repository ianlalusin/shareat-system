import { requirePageAccess, StoreNotAvailable } from '../../lib/page-access';
import { withFlash } from '../../lib/flash';
import { typedFor } from '../../lib/keep-typing';
import { staffStoresFor } from '../staff/lib';
import { kitchenForStore } from '../admin/stores/lib';
import { KITCHEN_ROUTING, KITCHEN_STATION_EDIT } from '../admin/stores/typed-forms';
import { KitchenSections } from './KitchenSections';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { Banner, FlashBanner, Select } from '@/components/ui';

export const metadata = { title: 'Kitchen setup — Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * `/kitchen`. T-508 S2b, spec R10: kitchen stations and routing for ONE store, chosen by `?store=<id>` from the stores where the
 * actor holds `manage_store_settings` (a store manager's own store; an admin's every store). One store goes straight to it.
 * A store the actor does not hold gets the one-sentence refusal, never another store's screen.
 */
export default async function KitchenPage({ searchParams }: { searchParams: Promise<{ store?: string; ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/kitchen');
  if (refusal) return refusal;

  const stores = await staffStoresFor(actor, ['manage_store_settings']);
  if (stores.length === 0) {
    return (
      <Page density="table">
        <h1 className="text-2xl font-semibold">Kitchen setup</h1>
        <Banner tone="warning">You do not manage any store&apos;s settings, so there is no kitchen for you to set up.</Banner>
      </Page>
    );
  }
  const store = sp.store ? stores.find((s) => s.id === sp.store) : stores[0];
  if (!store) return <StoreNotAvailable />;
  const setup = await kitchenForStore(actor, store.id);
  if (!setup) return <StoreNotAvailable />;

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Kitchen setup</h1>
        <PageDescription>
          Choose which kitchen station cooks each item sold at {store.name}. An item with no station stays off the POS.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

      {stores.length > 1 && (
        <FilterRow>
          <label className="text-sm">
            <span className="block text-neutral-600 dark:text-neutral-400">Store</span>
            <Select name="store" defaultValue={store.id}>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </label>
        </FilterRow>
      )}

      <KitchenSections
        storeId={store.id}
        setup={setup}
        typedStations={Object.fromEntries(setup.stations.map((s) => [s.id, typedFor(sp, KITCHEN_STATION_EDIT, s.id, actor.personId)]))}
        typedRouting={typedFor(sp, KITCHEN_ROUTING, store.id, actor.personId)}
      />
    </Page>
  );
}
