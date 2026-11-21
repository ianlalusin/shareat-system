import { requirePageAccess, StoreNotAvailable } from '@/lib/page-access';
import { withFlash } from '@/lib/flash';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { Banner, FlashBanner, Select } from '@/components/ui';
import { staffStoresFor } from '../../staff/lib';
import { daypartsForStore } from '../../admin/stores/lib';
import { DaypartsSection } from '../DaypartsSection';
import { CopyFromStoreDialog } from '../../copy-from-store/CopyFromStoreDialog';
import { copyChoicesFor } from '../../copy-from-store/lib';
import { withOrgPrincipal } from '../lib';

export const metadata = { title: 'Menu hours - Shareat System' };
export const dynamic = 'force-dynamic';

/**
 * `/menu/hours`. T-510 S3: a store manager's door to the lunch and dinner hours (the admin store page is admin-only). One store at a time,
 * chosen by `?store=<id>` from the stores where the actor holds `manage_store_settings` (the same picker rule as /kitchen); a store the
 * actor does not hold gets the one-sentence refusal, never another store's screen. The domain gates every write again.
 */
export default async function MenuHoursPage({ searchParams }: { searchParams: Promise<{ store?: string; ok?: string; error?: string }> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/menu/hours');
  if (refusal) return refusal;

  const stores = await staffStoresFor(actor, ['manage_store_settings']);
  if (stores.length === 0) {
    return (
      <Page density="table">
        <h1 className="text-2xl font-semibold">Menu hours</h1>
        <Banner tone="warning">You do not manage any store&apos;s settings, so there are no hours for you to set.</Banner>
      </Page>
    );
  }
  const store = sp.store ? stores.find((s) => s.id === sp.store) : stores[0];
  if (!store) return <StoreNotAvailable />;
  const hours = await daypartsForStore(actor, store.id);
  // T-611 S1: the copy button, for an administrator only (the domain and a PIN gate the write; this is presentation).
  const copyStores = await withOrgPrincipal(actor.orgId, (tx) => copyChoicesFor(tx, actor, store.id));

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Menu hours</h1>
        <PageDescription>The hours a price can follow at {store.name}, like Lunch from 8:00 AM to 5:00 PM.</PageDescription>
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

      {copyStores && <CopyFromStoreDialog kind="hours" currentStoreId={store.id} stores={copyStores} />}

      <DaypartsSection storeId={store.id} dayparts={hours.dayparts} canManage={hours.canManage} from="hours" />
    </Page>
  );
}
