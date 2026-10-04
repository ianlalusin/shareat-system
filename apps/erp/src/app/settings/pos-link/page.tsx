import { requirePageAccess } from '../../../lib/page-access';
import { listStores } from '../../expenses/lib';
import { linkStoreToPosAction } from './actions';
import { posLinkRows, posStoreOptions, type PosLinkStoreRow } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { ACTION_LINK } from '@/components/action-link';

export const metadata = { title: 'POS link — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  ok?: string;
  error?: string;
  store?: string;
}

/**
 * `/settings/pos-link`. T-375 S1 (bible row 270, DEF-586).
 *
 * A store's link row IS its switch: linked, its sales days are imported from POS and never typed; unlinked, it keeps
 * the typed path, labelled "Typed — store not linked to POS". Linking is the go-live act for a store, done by an
 * admin, store by store (`manage_chart_of_accounts`: where money is booked is not a manager's setting).
 *
 * The write refuses in words: a channel of another store, a channel whose money is not remitted daily, a POS store
 * already linked elsewhere, and a store that still has typed sales days that are not verified.
 */
export default async function PosLinkSettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const { actor, refusal } = await requirePageAccess('/settings/pos-link');
  if (refusal) return refusal;
  const stores = await listStores(actor.orgId);
  const [rows, options] = await Promise.all([posLinkRows(actor, stores), posStoreOptions()]);

  return (
    <Page density="form">
      <div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          <a href="/settings" className={ACTION_LINK}>
            Settings
          </a>{' '}
          / POS link
        </p>
        <h1 className="text-2xl font-semibold">POS link</h1>
        <PageDescription>
          Which POS store each branch sells under. A linked branch&apos;s sales days come from POS and cannot be typed;
          a branch that is not linked keeps typing them in.
        </PageDescription>
      </div>

      {sp.error && <Banner tone="error">{sp.error}</Banner>}
      {sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

      {options === null && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          POS isn&apos;t connected to this system yet, so its stores can&apos;t be listed. Type the POS store&apos;s id
          and name instead.
        </div>
      )}

      {rows.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">This organisation has no stores yet. Create one under Stores first.</p>
      )}

      {rows.map((r) => (
        <StoreCard key={r.storeId} row={r} options={options} />
      ))}
    </Page>
  );
}

function StoreCard({ row, options }: { row: PosLinkStoreRow; options: { id: string; name: string }[] | null }) {
  const link = row.link;
  return (
    <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{row.storeName}</h2>
        {link ? (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100">
            Linked to {link.posStoreName}
          </span>
        ) : (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
            Not linked — sales are typed
          </span>
        )}
      </div>

      <form action={linkStoreToPosAction} className="space-y-3 text-sm">
        <input type="hidden" name="storeId" value={row.storeId} />
        <input type="hidden" name="storeName" value={row.storeName} />

        {options ? (
          <label className="block">
            <span className="block text-neutral-600 dark:text-neutral-400">POS store</span>
            <select name="posStoreId" required defaultValue={link?.posStoreId ?? ''} className={`${FIELD} mt-1 w-full max-w-sm`}>
              <option value="" disabled>
                Choose a POS store
              </option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || o.id}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="block">
              <span className="block text-neutral-600 dark:text-neutral-400">POS store id</span>
              <input name="posStoreId" required defaultValue={link?.posStoreId ?? ''} className={`${FIELD} mt-1 w-full max-w-sm`} />
            </label>
            <label className="block">
              <span className="block text-neutral-600 dark:text-neutral-400">POS store name</span>
              <input name="posStoreName" required defaultValue={link?.posStoreName ?? ''} className={`${FIELD} mt-1 w-full max-w-sm`} />
            </label>
          </>
        )}

        <label className="block">
          <span className="block text-neutral-600 dark:text-neutral-400">Sales channel POS&apos;s sales land in</span>
          <select name="salesChannelId" required defaultValue={link?.salesChannelId ?? ''} className={`${FIELD} mt-1 w-full max-w-sm`}>
            <option value="" disabled>
              Choose a channel
            </option>
            {row.channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-neutral-500 dark:text-neutral-400">
            Only channels whose money is remitted daily are offered: POS&apos;s sales are paid at the till.
          </span>
        </label>

        <label className="block">
          <span className="block text-neutral-600 dark:text-neutral-400">Tax type, as set in the POS store</span>
          <select name="posTaxType" required defaultValue={link?.posTaxType ?? ''} className={`${FIELD} mt-1 w-full max-w-sm`}>
            <option value="" disabled>
              Choose a tax type
            </option>
            <option value="vat_inclusive">VAT inclusive</option>
            <option value="non_vat">Non-VAT</option>
            <option value="vat_exclusive">VAT exclusive (not importable yet)</option>
          </select>
        </label>

        <button type="submit" className={BTN}>
          {link ? 'Save link' : 'Link store'}
        </button>
      </form>
    </section>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return <div className={`rounded-lg border p-4 text-sm ${cls}`}>{children}</div>;
}

const FIELD = 'rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
