import { formatBusinessDateTime } from '@shareat/core/datetime';
import type { BusinessDate } from '@shareat/core/datetime';
import { humanDate } from '@shareat/domain/refusal-leaf';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash, type FlashFields } from '../../../lib/flash';
import { typedFor, type TypedView } from '../../../lib/keep-typing';
import { listStores } from '../../expenses/lib';
import { createTenderAction, linkStoreToPosAction, setTenderActiveAction, unlinkStoreFromPosAction, updateTenderAction } from './actions';
import { POS_LINK_EDIT, TENDER_EDIT } from './typed-forms';
import { canUnlink, posLinkRows, posStoreOptions, storeTenders, tenderMapping, type PosLinkStoreRow, type StoreTenders, type TenderAdminRow } from './lib';
import { Page } from '@/components/shell/Page';
import { EditableRecord } from '@/components/forms';
import { Field, FormGrid } from '@/components/ui';
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

  // R7: feedback shows on the card of the store it is about; the top banner only when no card matches.
  const cardShowsFeedback = !!sp.store && rows.some((r) => r.storeId === sp.store);

  return (
    <Page density="table">
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

      {!cardShowsFeedback && sp.error && <Banner tone="error">{sp.error}</Banner>}
      {!cardShowsFeedback && sp.ok && <Banner tone="ok">{sp.ok}</Banner>}

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
            feedback={sp.store === r.storeId ? { error: sp.error, ok: sp.ok } : null}
            flash={sp}
            actorId={actor.personId}
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
  feedback,
  flash,
  actorId,
}: {
  row: PosLinkStoreRow;
  options: { id: string; name: string }[] | null;
  tenders: StoreTenders;
  canUnlink: boolean;
  feedback: { error?: string; ok?: string } | null;
  /** T-389: the typed slot of the signed flash. `typedFor` picks the one record whose Save was refused. */
  flash: FlashFields;
  actorId: string;
}) {
  const link = row.link;
  return (
    <section id={`store-${row.storeId}`} className="scroll-mt-4 space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
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

      <div className="space-y-3 text-sm">
        <h3 className="font-medium">Link to POS</h3>
        {link ? (
          // A linked store's link is a saved record: locked until Edit (A0 L1).
          <EditableRecord
            action={linkStoreToPosAction}
            label={row.storeName}
            hidden={{ storeId: row.storeId, storeName: row.storeName }}
            typed={typedFor(flash, POS_LINK_EDIT, row.storeId, actorId)}
          >
            <LinkFields row={row} options={options} />
          </EditableRecord>
        ) : (
          // An unlinked store's link form is an add form: it ends in Save (A0 L4).
          <form action={linkStoreToPosAction} className="space-y-3">
            <input type="hidden" name="storeId" value={row.storeId} />
            <input type="hidden" name="storeName" value={row.storeName} />
            <LinkFields row={row} options={options} />
            <button type="submit" className={BTN}>
              Save
            </button>
          </form>
        )}
      </div>

      {row.unlinked && !link && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Unlinked {formatBusinessDateTime(row.unlinked.at, { dateStyle: 'medium' })} by {row.unlinked.byName ?? 'someone'}: {row.unlinked.reason}
        </p>
      )}

      {link && canUnlink && <UnlinkSection row={row} posStoreName={link.posStoreName} />}

      {feedback?.error && <Banner tone="error">{feedback.error}</Banner>}
      {feedback?.ok && <Banner tone="ok">{feedback.ok}</Banner>}

      <TendersSection storeId={row.storeId} storeName={row.storeName} linked={!!link} t={tenders} flash={flash} actorId={actorId} />
    </section>
  );
}

/** The link form's fields, shared by the locked record (linked) and the add form (unlinked). */
function LinkFields({ row, options }: { row: PosLinkStoreRow; options: { id: string; name: string }[] | null }) {
  const link = row.link;
  return (
    <FormGrid>
      {options ? (
        <Field label="POS store">
          <select name="posStoreId" required defaultValue={link?.posStoreId ?? ''} className={FIELD}>
            <option value="" disabled>
              Choose a POS store
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name || o.id}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <Field label="POS store id">
            <input name="posStoreId" required defaultValue={link?.posStoreId ?? ''} className={FIELD} />
          </Field>
          <Field label="POS store name">
            <input name="posStoreName" required defaultValue={link?.posStoreName ?? ''} className={FIELD} />
          </Field>
        </>
      )}

      <Field
        label="Sales channel POS's sales land in"
        hint="Only channels whose money is remitted daily are offered: POS's sales are paid at the till."
      >
        <select name="salesChannelId" required defaultValue={link?.salesChannelId ?? ''} className={FIELD}>
          <option value="" disabled>
            Choose a channel
          </option>
          {row.channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Tax type, as set in the POS store">
        <select name="posTaxType" required defaultValue={link?.posTaxType ?? ''} className={FIELD}>
          <option value="" disabled>
            Choose a tax type
          </option>
          <option value="vat_inclusive">VAT inclusive</option>
          <option value="non_vat">Non-VAT</option>
          <option value="vat_exclusive">VAT exclusive (not importable yet)</option>
        </select>
      </Field>
    </FormGrid>
  );
}

/**
 * T-382 R13: the guarded unlink, shown to a super admin on a LINKED store. When R3 would refuse (an imported day still
 * open or submitted) it shows that sentence instead of the form. The action and `unlinkStoreFromPos` authorize again.
 * Unlink is a command (A0 L5): it keeps its own verb.
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
          <FormGrid>
            <Field label={`Why is ${store} being unlinked?`} span="full">
              <textarea name="reason" required maxLength={500} rows={3} className={FIELD} />
            </Field>
          </FormGrid>
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

const POS_NAME_HINT =
  'Exactly what POS shows for this payment method. Leave it blank if POS has no matching method: this tender then answers to no POS method.';
const ACCOUNT_HINT =
  'Leave it blank for cash. Two wallets may pay into the same account — for example Bank Transfer and QRPH into one bank account.';

function TendersSection({
  storeId,
  storeName,
  linked,
  t,
  flash,
  actorId,
}: {
  storeId: string;
  storeName: string;
  linked: boolean;
  t: StoreTenders;
  flash: FlashFields;
  actorId: string;
}) {
  const active = t.tenders.filter((x) => x.isActive);
  const retired = t.tenders.filter((x) => !x.isActive);
  const mapping = tenderMapping(t.methods, t.tenders, t.accounts);
  return (
    <div className="space-y-3 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
      <h3 className="font-medium">Tenders</h3>

      {t.accounts.length === 0 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {storeName} has no bank or e-wallet account yet. Add one under{' '}
          <a href="/money-accounts" className={ACTION_LINK}>
            Money accounts
          </a>{' '}
          first.
        </p>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-medium text-neutral-700 dark:text-neutral-300">How POS&apos;s payment methods land</h4>
        {!linked && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            POS&apos;s payment methods are listed here once {storeName} is linked. Make each tender&apos;s POS name exactly what POS shows.
          </p>
        )}
        {linked && t.methods === null && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            POS&apos;s payment methods can&apos;t be listed right now (POS isn&apos;t connected), so unmapped methods aren&apos;t shown.
          </p>
        )}
        {mapping.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-neutral-200 text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="py-1 pr-3 font-medium">POS method</th>
                  <th className="py-1 pr-3 font-medium">Tender</th>
                  <th className="py-1 pr-3 font-medium">Kind</th>
                  <th className="py-1 pr-3 font-medium">Money account</th>
                  <th className="py-1 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {mapping.map((m, i) => (
                  <tr key={`${m.posMethod ?? ''}:${m.tenderId ?? ''}:${i}`} className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="py-1 pr-3">{m.posMethod ?? '—'}</td>
                    <td className="py-1 pr-3">{m.tenderName ?? '—'}</td>
                    <td className="py-1 pr-3">{m.kind === 'cash' ? 'Cash' : m.kind === 'wallet' ? 'Wallet' : '—'}</td>
                    <td className="py-1 pr-3">{m.moneyAccountName ?? '—'}</td>
                    <td className={m.status === 'mapped' ? 'py-1' : 'py-1 text-amber-800 dark:text-amber-300'}>{m.statusText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {t.tenders.length === 0 && <p className="text-xs text-neutral-500 dark:text-neutral-400">No tenders yet.</p>}

      {active.map((x) => (
        <TenderRecord key={`${x.id}:${x.version}`} storeId={storeId} x={x} t={t} typed={typedFor(flash, TENDER_EDIT, x.id, actorId)} />
      ))}

      {retired.length > 0 && (
        <details className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
          <summary className="cursor-pointer py-1 text-neutral-700 dark:text-neutral-300">Retired tenders ({retired.length})</summary>
          <div className="mt-3 space-y-2">
            {retired.map((x) => (
              <form key={x.id} action={setTenderActiveAction} className="flex flex-wrap items-center gap-3 opacity-70">
                <input type="hidden" name="storeId" value={storeId} />
                <input type="hidden" name="tenderId" value={x.id} />
                <input type="hidden" name="version" value={x.version} />
                <input type="hidden" name="isActive" value="true" />
                <span>
                  {x.name} ({x.kind})
                </span>
                <button type="submit" className={BTN}>
                  Restore
                </button>
              </form>
            ))}
          </div>
        </details>
      )}

      <div className="space-y-3 rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h4 className="font-medium">Add a tender</h4>
        <form action={createTenderAction} autoComplete="off" className="space-y-3">
          <input type="hidden" name="storeId" value={storeId} />
          <FormGrid>
            <Field label="Name">
              <input name="name" required placeholder="e.g. GCash" autoComplete="off" className={FIELD} />
            </Field>
            <Field label="Kind">
              <select name="kind" required defaultValue="" className={FIELD}>
                <option value="">Choose cash or wallet</option>
                <option value="cash">Cash</option>
                <option value="wallet">Wallet</option>
              </select>
            </Field>
            <Field label="Money account (wallets only)" hint={ACCOUNT_HINT}>
              <select name="moneyAccountId" defaultValue="" className={FIELD}>
                <option value="">None</option>
                {t.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="POS name" hint={POS_NAME_HINT}>
              <input name="posV1Alias" autoComplete="off" className={FIELD} />
            </Field>
          </FormGrid>
          <button type="submit" className={BTN}>
            Save
          </button>
        </form>
      </div>
    </div>
  );
}

/**
 * One saved tender: a locked EditableRecord (A0). Retire is its `extra`, shown only while editing. After a refused Save
 * (`typed`), the record reopens in edit mode with the user's typing (DEF-617, T-389). The fields below always draw the
 * STORED values; the browser applies the typing, so Cancel restores what is saved.
 */
function TenderRecord({ storeId, x, t, typed }: { storeId: string; x: TenderAdminRow; t: StoreTenders; typed: TypedView | null }) {
  return (
    <EditableRecord
      action={updateTenderAction}
      label={x.name}
      hidden={{ storeId, tenderId: x.id, version: x.version }}
      typed={typed}
      extra={
        <form action={setTenderActiveAction} className="mt-2">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="tenderId" value={x.id} />
          <input type="hidden" name="version" value={x.version} />
          <input type="hidden" name="isActive" value="false" />
          <button type="submit" className={BTN}>
            Retire
          </button>
        </form>
      }
    >
      <FormGrid>
        <Field label="Name">
          <input name="name" required defaultValue={x.name} autoComplete="off" className={FIELD} />
        </Field>
        <Field label="Kind">
          <select name="kind" required defaultValue={x.kind} className={FIELD}>
            <option value="cash">Cash</option>
            <option value="wallet">Wallet</option>
          </select>
        </Field>
        <Field label="Money account (wallets only)" hint={ACCOUNT_HINT}>
          <select name="moneyAccountId" defaultValue={x.moneyAccountId ?? ''} className={FIELD}>
            <option value="">None</option>
            {x.moneyAccountId && !t.accounts.some((a) => a.id === x.moneyAccountId) && (
              <option value={x.moneyAccountId}>{x.moneyAccountName ?? 'Retired account'}</option>
            )}
            {t.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="POS name" hint={POS_NAME_HINT}>
          <input name="posV1Alias" defaultValue={x.posV1Alias ?? ''} autoComplete="off" className={FIELD} />
        </Field>
      </FormGrid>
    </EditableRecord>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'ok'; children: React.ReactNode }) {
  const cls =
    tone === 'error'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300';
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-lg border p-4 text-sm ${cls}`}>
      {children}
    </div>
  );
}

const FIELD = 'mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900';
