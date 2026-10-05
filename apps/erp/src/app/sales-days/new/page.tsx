import { notFound } from 'next/navigation';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores, listChannels, listStoreMoneyAccounts, getStoreLink } from '../lib';
import { requireSession } from '../../../lib/session';
import { createSalesDayAction, importSalesDayAction } from '../actions';
import { SalesDayForm } from '../SalesDayForm';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';

export const metadata = { title: 'New sales day — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
}

const LABEL = 'text-xs font-medium text-neutral-500 dark:text-neutral-400';

export default async function NewSalesDayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;

  const { actor } = await requireSession('/sales-days/new');
  const orgId = actor.orgId;
  const stores = await listStores(orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  // T-375 S3 (R13): the store's link is its switch. Linked: Import from POS, no figure is typed. Unlinked: the typed form.
  const link = storeId ? await getStoreLink(orgId, storeId) : null;

  const channels = storeId && !link ? await listChannels(orgId, storeId) : [];
  const activeChannels = channels.filter((c) => c.isActive);
  // T-369 S3 (DEF-291): store-scoped IN THE QUERY, with the same `storeId` the hidden input and the
  // channel listing use. `create.ts`'s tender resolver still refuses a foreign wallet at save time.
  const wallets = storeId && !link ? await listStoreMoneyAccounts(orgId, storeId) : [];

  const carry = new URLSearchParams();
  if (storeId) carry.set('store', storeId);

  return (
    <Page density="table">
      <div>
        <a
          href={`/sales-days?${carry.toString()}`}
          className="text-sm text-neutral-500 underline hover:no-underline dark:text-neutral-400"
        >
          ← All sales days
        </a>
        <h1 className="mt-1 text-2xl font-semibold">New sales day</h1>
        <PageDescription>
          {link ? (
            <>
              This store&apos;s sales come from POS. <strong>Nothing posts to the ledger until the imported day is
              verified</strong> — and verifying is what recognises the revenue.
            </>
          ) : (
            <>
              Saved as a draft. <strong>Nothing posts to the ledger until it is verified</strong> — and
              verifying is what recognises the revenue.
            </>
          )}
        </PageDescription>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          <strong className="font-medium">Refused:</strong> {sp.error}
        </div>
      )}

      {stores.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          This organisation has no stores yet.
        </p>
      ) : (
        <>
          {stores.length > 1 && (
            <FilterRow submitLabel="Switch store">
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Store</span>
                {/* text-sm is load-bearing: it used to inherit from the POST form's ancestor
                    className; FilterRow hides that ancestry from the touch-target census, so
                    removing this changes the modelled control size. */}
                <select
                  name="store"
                  defaultValue={storeId}
                  className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.code})
                    </option>
                  ))}
                </select>
              </label>
            </FilterRow>
          )}

          {link ? (
            <form action={importSalesDayAction} className="space-y-6 text-sm">
              <input type="hidden" name="storeId" value={storeId} />
              <section className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <span className={LABEL}>Store</span>
                  <p className="rounded border border-neutral-300 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
                    {stores.find((s) => s.id === storeId)?.name} ({stores.find((s) => s.id === storeId)?.code}) · POS:{' '}
                    {link.posStoreName}
                  </p>
                </div>
                <label className="flex flex-col gap-1">
                  <span className={LABEL}>Business date</span>
                  <input
                    type="date"
                    name="businessDate"
                    defaultValue={toBusinessDate()}
                    className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>
              </section>
              <p className="text-neutral-600 dark:text-neutral-400">
                The figures are read from POS, never typed. Importing a date again while it is still open or
                submitted brings in whatever POS says now.
              </p>
              <button
                type="submit"
                className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
              >
                Import from POS
              </button>
            </form>
          ) : (
            <>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">Typed — this store isn&apos;t linked to POS yet.</p>
              <form action={createSalesDayAction} className="space-y-6 text-sm">
                {/* ⭐ No orgId and no "acting as" — both come from the session now (T-138). */}
                <input type="hidden" name="storeId" value={storeId} />
                <SalesDayForm
                  storeLabel={`${stores.find((s) => s.id === storeId)?.name} (${stores.find((s) => s.id === storeId)?.code})`}
                  businessDate={toBusinessDate()}
                  dateEditable
                  channels={activeChannels}
                  wallets={wallets}
                  submitLabel="Save draft"
                />
              </form>
            </>
          )}
        </>
      )}
    </Page>
  );
}
