import { formatBusinessDateTime } from '@shareat/core/datetime';
import type { BusinessDate } from '@shareat/core/datetime';
import { humanDate } from '@shareat/domain/refusal-leaf';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { listStores } from '../../expenses/lib';
import { createTenderAction, linkStoreToPosAction, setTenderActiveAction, unlinkStoreFromPosAction, updateTenderAction } from './actions';
import { canUnlink, posLinkRows, posStoreOptions, storeTenders, type PosLinkStoreRow, type StoreTenders } from './lib';
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
  const sp = await withFlash(searchParams); // T-380: the banner arrives in the flash cookie, never the address
  const { actor, refusal } = await requirePageAccess('/settings/pos-link');
  if (refusal) return refusal;
  const stores = await listStores(actor.orgId);
  const [rows, options, mayUnlink] = await Promise.all([posLinkRows(actor, stores), posStoreOptions(), canUnlink(actor)]);

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

      {await Promise.all(
        rows.map(async (r) => (
          <StoreCard
            key={r.storeId}
            row={r}
            options={options}
            canUnlink={mayUnlink}
            tenders={await storeTenders(actor, r.storeId, r.link?.posStoreId ?? null)}
          />
        )),
      )}
    </Page>
  );
}

function StoreCard({
  row,
  options,
  tenders,
  canUnlink,
}: {
  row: PosLinkStoreRow;
  options: { id: string; name: string }[] | null;
  tenders: StoreTenders;
  canUnlink: boolean;
}) {
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

      {row.unlinked && !link && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Unlinked {formatBusinessDateTime(row.unlinked.at, { dateStyle: 'medium' })} by {row.unlinked.byName ?? 'someone'}: {row.unlinked.reason}
        </p>
      )}

      {link && canUnlink && <UnlinkSection row={row} posStoreName={link.posStoreName} />}

      <TendersSection storeId={row.storeId} linked={!!link} t={tenders} />
    </section>
  );
}

/**
 * T-382 R13: the guarded unlink, shown to a super admin on a LINKED store. When R3 would refuse (an imported day still
 * open or submitted) it shows that sentence instead of the form. The action and `unlinkStoreFromPos` authorize again.
 */
function UnlinkSection({ row, posStoreName }: { row: PosLinkStoreRow; posStoreName: string }) {
  const store = row.storeName;
  const blocked = row.unverifiedImportedDates;
  return (
    <div className="space-y-3 rounded border border-red-200 p-3 text-sm dark:border-red-900">
      <h3 className="font-medium">Unlink from POS</h3>
      {blocked.length > 0 ? (
        <p className="text-neutral-700 dark:text-neutral-300">
          {store} has imported sales days that aren&apos;t verified yet ({blocked.map((d) => humanDate(d as BusinessDate)).join(', ')}). Verify or
          withdraw them before unlinking it.
        </p>
      ) : (
        <form action={unlinkStoreFromPosAction} className="space-y-3">
          <input type="hidden" name="storeId" value={row.storeId} />
          <p className="text-neutral-700 dark:text-neutral-300">
            Unlinking {store} from POS store {posStoreName}: from the next sales day you type in, {store}&apos;s sales are typed, not imported. The{' '}
            {row.importedDays} days already imported from POS stay exactly as they are. They can&apos;t be edited, re-imported or corrected from POS. A
            manager can still withdraw an imported day and type it again. An admin can link the store again later.
          </p>
          <label className="block">
            <span className="block text-neutral-600 dark:text-neutral-400">Why is {store} being unlinked?</span>
            <textarea name="reason" required maxLength={500} rows={3} className={`${FIELD} mt-1 w-full max-w-md`} />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" name="confirm" required className="mt-1" />
            <span>I understand: {store}&apos;s sales will be typed from now on.</span>
          </label>
          <button type="submit" className={BTN}>
            Unlink {store}
          </button>
        </form>
      )}
    </div>
  );
}

function TendersSection({ storeId, linked, t }: { storeId: string; linked: boolean; t: StoreTenders }) {
  const label = 'block text-xs text-neutral-600 dark:text-neutral-400';
  return (
    <div className="space-y-3 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
      <h3 className="font-medium">Tenders</h3>
      {linked && t.unmapped === null && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          POS&apos;s payment methods can&apos;t be listed right now (POS isn&apos;t connected), so unmapped methods aren&apos;t shown.
        </p>
      )}
      {linked && t.unmapped && t.unmapped.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
          POS methods not mapped yet: {t.unmapped.map((m) => `"${m}"`).join(', ')}. A day that used one of them cannot be
          imported until a tender answers to it.
        </div>
      )}
      {t.tenders.length === 0 && <p className="text-xs text-neutral-500 dark:text-neutral-400">No tenders yet.</p>}
      {t.tenders.map((x) => (
        <div key={x.id} className={`flex flex-wrap items-end gap-2 ${x.isActive ? '' : 'opacity-60'}`}>
          <form action={updateTenderAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="tenderId" value={x.id} />
            <label className="block">
              <span className={label}>Name ({x.kind})</span>
              <input name="name" required defaultValue={x.name} className={`${FIELD} mt-1 w-40`} />
            </label>
            <label className="block">
              <span className={label}>POS name</span>
              <input name="posV1Alias" defaultValue={x.posV1Alias ?? ''} className={`${FIELD} mt-1 w-40`} />
            </label>
            {x.kind === 'wallet' && (
              <label className="block">
                <span className={label}>Money account</span>
                <select name="moneyAccountId" defaultValue={x.moneyAccountId ?? ''} className={`${FIELD} mt-1`}>
                  {x.moneyAccountId && !t.accounts.some((a) => a.id === x.moneyAccountId) && (
                    <option value={x.moneyAccountId}>{x.moneyAccountName ?? 'Retired account'}</option>
                  )}
                  {t.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit" className={BTN}>
              Save
            </button>
          </form>
          <form action={setTenderActiveAction}>
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="tenderId" value={x.id} />
            <input type="hidden" name="isActive" value={x.isActive ? 'false' : 'true'} />
            <button type="submit" className={BTN}>
              {x.isActive ? 'Retire' : 'Restore'}
            </button>
          </form>
        </div>
      ))}
      <form action={createTenderAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="storeId" value={storeId} />
        <label className="block">
          <span className={label}>New tender</span>
          <input name="name" required placeholder="e.g. GCash" className={`${FIELD} mt-1 w-40`} />
        </label>
        <label className="block">
          <span className={label}>Kind</span>
          <select name="kind" defaultValue="cash" className={`${FIELD} mt-1`}>
            <option value="cash">Cash</option>
            <option value="wallet">Wallet</option>
          </select>
        </label>
        <label className="block">
          <span className={label}>Money account (wallet)</span>
          <select name="moneyAccountId" defaultValue="" className={`${FIELD} mt-1`}>
            <option value="">None</option>
            {t.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={label}>POS name</span>
          <input name="posV1Alias" className={`${FIELD} mt-1 w-40`} />
        </label>
        <button type="submit" className={BTN}>
          Add tender
        </button>
      </form>
    </div>
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
