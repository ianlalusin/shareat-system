import { formatBusinessDateTime } from '@shareat/core/datetime';
import type { BusinessDate } from '@shareat/core/datetime';
import { humanDate } from '@shareat/domain/refusal-leaf';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash, type FlashFields } from '../../../lib/flash';
import { typedFor, type TypedView } from '../../../lib/keep-typing';
import { listStores } from '../../expenses/lib';
import {
  createPaymentOptionAction,
  linkStoreToPosAction,
  setPaymentOptionStatusAction,
  setTenderActiveAction,
  switchOnPaymentOptionAction,
  unlinkStoreFromPosAction,
  updatePaymentOptionAction,
  updateTenderAction,
} from './actions';
import { PAYMENT_OPTION_EDIT, POS_LINK_EDIT, TENDER_EDIT } from './typed-forms';
import {
  canUnlink,
  paymentOptionRows,
  posLinkRows,
  posStoreOptions,
  storeTenders,
  tenderMapping,
  type PaymentOptionAdminRow,
  type PosLinkStoreRow,
  type StoreTenders,
  type TenderAdminRow,
} from './lib';
import { Page } from '@/components/shell/Page';
import { ChevronIcon } from '@/components/shell/icons';
import { CheckedForm, EditableRecord } from '@/components/forms';
import { SETTINGS_POS_LINK_RULES, SETTINGS_PAYMENT_OPTION_RULES, SETTINGS_POS_UNLINK_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Button, ConfirmDestructive, DialogActions, Field, FlashBanner, FormGrid, FormModal, Input, Select, Textarea } from '@/components/ui';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'Link to POS store — Shareat System' };
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
  const [rows, options, mayUnlink, payOptions] = await Promise.all([posLinkRows(actor, stores), posStoreOptions(), canUnlink(actor), paymentOptionRows(actor)]);

  // R7: feedback shows on the card of the store it is about; the top banner only when no card matches.
  const cardShowsFeedback = !!sp.store && rows.some((r) => r.storeId === sp.store);

  return (
    <Page
      density="table"
      crumb={<><a href="/settings" className={NAV_LINK}>Settings</a> / Link to POS store</>}
      title="Link to POS store"
      description={
        <>
          Which POS store each store sells under. A linked store&apos;s sales days come from POS and cannot be typed;
          a store that is not linked keeps typing them in.
        </>
      }
    >

      {!cardShowsFeedback && <FlashBanner flash={sp} />}

      {options === null && (
        <Banner tone="warning">
          POS isn&apos;t connected to this system yet, so its stores can&apos;t be listed. Enter the POS store&apos;s id
          and name below; ask whoever set up POS if you don&apos;t have them.
        </Banner>
      )}

      <PaymentOptionsSection options={payOptions} flash={sp} actorId={actor.personId} />

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
            payOptions={payOptions}
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
  payOptions,
  canUnlink,
  feedback,
  flash,
  actorId,
}: {
  row: PosLinkStoreRow;
  options: { id: string; name: string }[] | null;
  tenders: StoreTenders;
  payOptions: readonly PaymentOptionAdminRow[];
  canUnlink: boolean;
  feedback: { error?: string; ok?: string } | null;
  /** T-389: the typed slot of the signed flash. `typedFor` picks the one record whose Save was refused. */
  flash: FlashFields;
  actorId: string;
}) {
  const link = row.link;
  return (
    <details
      id={`store-${row.storeId}`}
      open={feedback ? true : undefined}
      className="group scroll-mt-4 rounded-[20px] border border-surface-border bg-surface"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="font-medium">{row.storeName}</span>
        <span className="flex items-center gap-2">
          {link ? (
            <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
              Linked to {link.posStoreName}
            </span>
          ) : (
            <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning-ink">
              Not linked — sales are typed
            </span>
          )}
          <ChevronIcon className="size-4 text-muted transition group-open:rotate-180" />
        </span>
      </summary>

      <div className="space-y-3 border-t border-surface-border px-4 py-4 text-sm">
        <h3 className="font-medium">Link to POS</h3>
        {link ? (
          // A linked store's link is a saved record: locked until Edit (A0 L1).
          <EditableRecord
            action={linkStoreToPosAction}
            label={row.storeName}
            hidden={{ storeId: row.storeId, storeName: row.storeName }}
            typed={typedFor(flash, POS_LINK_EDIT, row.storeId, actorId)}
            rules={SETTINGS_POS_LINK_RULES}
          >
            <FormGrid>
            {options ? (
              <>
                <Field label="POS store" rule={SETTINGS_POS_LINK_RULES.posStoreId}>
                  <Select {...nativeAttrs(SETTINGS_POS_LINK_RULES.posStoreId)} defaultValue={link?.posStoreId ?? ''} className="mt-1 w-full">
                    <option value="" disabled>
                      Choose a POS store
                    </option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name || o.id}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/* Picker mode: the stored name is POS's own, taken from the list by the action. The box exists only so the one rule set holds in both modes. */}
                <input type="hidden" name="posStoreName" value={link?.posStoreName ?? 'POS store'} />
              </>
            ) : (
              <>
                <Field label="POS store id" rule={SETTINGS_POS_LINK_RULES.posStoreId}>
                  <Input {...nativeAttrs(SETTINGS_POS_LINK_RULES.posStoreId)} defaultValue={link?.posStoreId ?? ''} className="mt-1 w-full" />
                </Field>
                <Field label="POS store name" rule={SETTINGS_POS_LINK_RULES.posStoreName}>
                  <Input {...nativeAttrs(SETTINGS_POS_LINK_RULES.posStoreName)} defaultValue={link?.posStoreName ?? ''} className="mt-1 w-full" />
                </Field>
              </>
            )}

            <Field
              label="Sales channel POS's sales land in"
              hint="Only channels whose money is remitted daily are offered: POS's sales are paid at the till."
              rule={SETTINGS_POS_LINK_RULES.salesChannelId}
            >
              <Select {...nativeAttrs(SETTINGS_POS_LINK_RULES.salesChannelId)} defaultValue={link?.salesChannelId ?? ''} className="mt-1 w-full">
                <option value="" disabled>
                  Choose a channel
                </option>
                {row.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Tax type, as set in the POS store" rule={SETTINGS_POS_LINK_RULES.posTaxType}>
              <Select {...nativeAttrs(SETTINGS_POS_LINK_RULES.posTaxType)} defaultValue={link?.posTaxType ?? ''} className="mt-1 w-full">
                <option value="" disabled>
                  Choose a tax type
                </option>
                <option value="vat_inclusive">VAT inclusive</option>
                <option value="non_vat">Non-VAT</option>
                <option value="vat_exclusive">VAT exclusive (not importable yet)</option>
              </Select>
            </Field>
            </FormGrid>
          </EditableRecord>
        ) : (
          // An unlinked store's link form is an add form: it ends in Save (A0 L4). T-448: it opens in a dialog.
          <div>
          <FormModal trigger="Link to POS" title={`Link ${row.storeName} to POS`} size="md">
          <CheckedForm rules={SETTINGS_POS_LINK_RULES} action={linkStoreToPosAction} className="space-y-3">
            <input type="hidden" name="storeId" value={row.storeId} />
            <input type="hidden" name="storeName" value={row.storeName} />
            <FormGrid>
            {options ? (
              <>
                <Field label="POS store" rule={SETTINGS_POS_LINK_RULES.posStoreId}>
                  <Select {...nativeAttrs(SETTINGS_POS_LINK_RULES.posStoreId)} defaultValue={''} className="mt-1 w-full">
                    <option value="" disabled>
                      Choose a POS store
                    </option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name || o.id}
                      </option>
                    ))}
                  </Select>
                </Field>
                {/* Picker mode: the stored name is POS's own, taken from the list by the action. The box exists only so the one rule set holds in both modes. */}
                <input type="hidden" name="posStoreName" value={'POS store'} />
              </>
            ) : (
              <>
                <Field label="POS store id" rule={SETTINGS_POS_LINK_RULES.posStoreId}>
                  <Input {...nativeAttrs(SETTINGS_POS_LINK_RULES.posStoreId)} defaultValue={''} className="mt-1 w-full" />
                </Field>
                <Field label="POS store name" rule={SETTINGS_POS_LINK_RULES.posStoreName}>
                  <Input {...nativeAttrs(SETTINGS_POS_LINK_RULES.posStoreName)} defaultValue={''} className="mt-1 w-full" />
                </Field>
              </>
            )}

            <Field
              label="Sales channel POS's sales land in"
              hint="Only channels whose money is remitted daily are offered: POS's sales are paid at the till."
              rule={SETTINGS_POS_LINK_RULES.salesChannelId}
            >
              <Select {...nativeAttrs(SETTINGS_POS_LINK_RULES.salesChannelId)} defaultValue={''} className="mt-1 w-full">
                <option value="" disabled>
                  Choose a channel
                </option>
                {row.channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Tax type, as set in the POS store" rule={SETTINGS_POS_LINK_RULES.posTaxType}>
              <Select {...nativeAttrs(SETTINGS_POS_LINK_RULES.posTaxType)} defaultValue={''} className="mt-1 w-full">
                <option value="" disabled>
                  Choose a tax type
                </option>
                <option value="vat_inclusive">VAT inclusive</option>
                <option value="non_vat">Non-VAT</option>
                <option value="vat_exclusive">VAT exclusive (not importable yet)</option>
              </Select>
            </Field>
            </FormGrid>
            <DialogActions>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </DialogActions>
          </CheckedForm>
          </FormModal>
          </div>
        )}

      {row.unlinked && !link && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Unlinked on {formatBusinessDateTime(row.unlinked.at, { dateStyle: 'long' })} by {row.unlinked.byName ?? 'someone'}: {row.unlinked.reason}
        </p>
      )}

      {link && canUnlink && <UnlinkSection row={row} posStoreName={link.posStoreName} />}

      {/* Kept: t384-s1-pos-link-web W3b pins the ok sentence, with role=status, on the card. */}
      {feedback && <FlashBanner flash={flash} />}
      {feedback?.ok && <Banner tone="success">{feedback.ok}</Banner>}

      <TendersSection storeId={row.storeId} storeName={row.storeName} linked={!!link} t={tenders} options={payOptions} flash={flash} actorId={actorId} />
      </div>
    </details>
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
    <div className="space-y-3 rounded border border-danger p-3 text-sm">
      <h3 className="font-medium">Unlink from POS</h3>
      {blocked.length > 0 ? (
        <p className="text-neutral-700 dark:text-neutral-300">
          {store} has imported sales days that aren&apos;t verified yet ({blocked.map((d) => humanDate(d as BusinessDate)).join(', ')}). Verify or
          withdraw them before unlinking it.
        </p>
      ) : (
        <CheckedForm rules={SETTINGS_POS_UNLINK_RULES} action={unlinkStoreFromPosAction} className="space-y-3">
          <input type="hidden" name="storeId" value={row.storeId} />
          <p className="text-neutral-700 dark:text-neutral-300">
            Unlinking {store} from POS store {posStoreName}: from the next sales day you type in, {store}&apos;s sales are typed, not imported. The{' '}
            {row.importedDays} days already imported from POS stay exactly as they are. They can&apos;t be edited, re-imported or corrected from POS. A
            manager can still withdraw an imported day and type it again. An admin can link the store again later.
          </p>
          <FormGrid>
            <Field label={`Why is ${store} being unlinked?`} span="full" rule={SETTINGS_POS_UNLINK_RULES.reason}>
              <Textarea {...nativeAttrs(SETTINGS_POS_UNLINK_RULES.reason)} rows={3} className="mt-1 w-full" />
            </Field>
          </FormGrid>
          <ConfirmDestructive
            tier="retype"
            label="Unlink store from POS"
            consequence="Unlinks this store from POS. Its sales days are typed from now on."
            expectedName={store}
          />
        </CheckedForm>
      )}
    </div>
  );
}

const POS_NAME_HINT =
  'Exactly what POS shows for this payment method. Leave it blank if POS has no matching method: this tender then answers to no POS method.';
const ACCOUNT_HINT =
  'The bank or e-wallet account this store is paid into. Two options may pay into the same account, for example QRPH and a card machine into one bank account.';

const KIND_TEXT = { cash: 'Cash', wallet: 'Wallet' } as const;

/**
 * T-629: the org's MASTER LIST of payment options, above the store cards. One list for every store (a store switches an option on in its own card below);
 * the option owns the name and the kind. Same page, same capability (`manage_chart_of_accounts`) as the store tenders, so no new route.
 */
function PaymentOptionsSection({ options, flash, actorId }: { options: readonly PaymentOptionAdminRow[]; flash: FlashFields; actorId: string }) {
  const active = options.filter((o) => o.status === 'active');
  const retired = options.filter((o) => o.status === 'retired');
  const hasCash = options.some((o) => o.kind === 'cash');
  return (
    <details id="payment-options" open className="group scroll-mt-4 rounded-[20px] border border-surface-border bg-surface">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="font-medium">Payment options (all stores)</span>
        <span className="flex items-center gap-2">
          <span className="rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">{active.length} in use</span>
          <ChevronIcon className="size-4 text-muted transition group-open:rotate-180" />
        </span>
      </summary>
      <div className="space-y-3 border-t border-surface-border px-4 py-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-prose text-xs text-neutral-600 dark:text-neutral-400">
            One list for the whole company, so &quot;GCash&quot; is the same payment option at every store. Each store switches the ones it takes below, in its own card.
          </p>
          <FormModal trigger="+ Add payment option" title="Add a payment option" size="md">
            <CheckedForm rules={SETTINGS_PAYMENT_OPTION_RULES} action={createPaymentOptionAction} autoComplete="off" className="space-y-3">
              <FormGrid>
                <Field label="Name" rule={SETTINGS_PAYMENT_OPTION_RULES.name}>
                  <Input {...nativeAttrs(SETTINGS_PAYMENT_OPTION_RULES.name)} placeholder="e.g. Maya" autoComplete="off" className="mt-1 w-full" />
                </Field>
                <Field
                  label="Kind"
                  hint={hasCash ? 'There is already a cash option; a company has one.' : 'Cash is the till. A wallet pays into a bank or e-wallet account, cards included.'}
                  rule={SETTINGS_PAYMENT_OPTION_RULES.kind}
                >
                  <Select {...nativeAttrs(SETTINGS_PAYMENT_OPTION_RULES.kind)} defaultValue="" className="mt-1 w-full">
                    <option value="">Choose cash or wallet</option>
                    {!hasCash && <option value="cash">Cash</option>}
                    <option value="wallet">Wallet</option>
                  </Select>
                </Field>
              </FormGrid>
              <DialogActions>
                <Button type="submit" variant="secondary">
                  Save
                </Button>
              </DialogActions>
            </CheckedForm>
          </FormModal>
        </div>

        {active.length === 0 && <p className="text-xs text-neutral-500 dark:text-neutral-400">No payment options yet.</p>}

        {active.map((o) => (
          <EditableRecord
            key={o.id}
            action={updatePaymentOptionAction}
            label={o.name}
            hidden={{ paymentOptionId: o.id }}
            typed={typedFor(flash, PAYMENT_OPTION_EDIT, o.id, actorId)}
            rules={SETTINGS_PAYMENT_OPTION_RULES}
            summary={[
              { label: 'Payment option', value: `${o.name}: ${KIND_TEXT[o.kind].toLowerCase()}, switched on at ${o.storesOn} ${o.storesOn === 1 ? 'store' : 'stores'}` },
            ]}
            extra={
              <form action={setPaymentOptionStatusAction} className="mt-2">
                <input type="hidden" name="paymentOptionId" value={o.id} />
                <input type="hidden" name="status" value="retired" />
                <ConfirmDestructive
                  tier="confirm"
                  quiet
                  label="Retire payment option"
                  consequence={
                    o.storesOn > 0
                      ? `${o.name} is switched on at ${o.storesOn} ${o.storesOn === 1 ? 'store' : 'stores'}: switch it off there first, or this is refused.`
                      : `${o.name} can no longer be switched on at a store. You can bring it back later.`
                  }
                />
              </form>
            }
          >
            <FormGrid>
              <Field label="Name" rule={SETTINGS_PAYMENT_OPTION_RULES.name}>
                <Input {...nativeAttrs(SETTINGS_PAYMENT_OPTION_RULES.name)} defaultValue={o.name} autoComplete="off" className="mt-1 w-full" />
              </Field>
              {o.storesTotal > 0 ? (
                <>
                  <input type="hidden" name="kind" value={o.kind} />
                  <p className="text-xs text-neutral-500 dark:text-neutral-400">A store uses this option, so it stays {KIND_TEXT[o.kind].toLowerCase()}.</p>
                </>
              ) : (
                <Field label="Kind" rule={SETTINGS_PAYMENT_OPTION_RULES.kind}>
                  <Select {...nativeAttrs(SETTINGS_PAYMENT_OPTION_RULES.kind)} defaultValue={o.kind} className="mt-1 w-full">
                    <option value="cash" disabled={hasCash && o.kind !== 'cash'}>
                      Cash
                    </option>
                    <option value="wallet">Wallet</option>
                  </Select>
                </Field>
              )}
            </FormGrid>
          </EditableRecord>
        ))}

        {retired.length > 0 && (
          <details className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <summary className="cursor-pointer py-1 text-neutral-700 dark:text-neutral-300">Retired payment options ({retired.length})</summary>
            <div className="mt-3 space-y-2">
              {retired.map((o) => (
                <form key={o.id} action={setPaymentOptionStatusAction} className="flex flex-wrap items-center gap-3 opacity-70">
                  <input type="hidden" name="paymentOptionId" value={o.id} />
                  <input type="hidden" name="status" value="active" />
                  <span>
                    {o.name} ({KIND_TEXT[o.kind].toLowerCase()})
                  </span>
                  <Button type="submit" variant="secondary">
                    Restore
                  </Button>
                </form>
              ))}
            </div>
          </details>
        )}
      </div>
    </details>
  );
}

/**
 * T-629: a store's side of the master list. Every ACTIVE payment option is a row: ON (its tender, with the store's money account and POS name, editable,
 * and a switch-off) or OFF (a Switch on button that asks for the money account when the option is a wallet).
 */
function TendersSection({
  storeId,
  storeName,
  linked,
  t,
  options,
  flash,
  actorId,
}: {
  storeId: string;
  storeName: string;
  linked: boolean;
  t: StoreTenders;
  options: readonly PaymentOptionAdminRow[];
  flash: FlashFields;
  actorId: string;
}) {
  const mapping = tenderMapping(t.methods, t.tenders, t.accounts);
  const rows = options
    .filter((o) => o.status === 'active')
    .map((o) => ({ option: o, tender: t.tenders.find((x) => x.paymentOptionId === o.id) }));
  return (
    <div className="space-y-3 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800">
      <h3 className="font-medium">Payment options at this store</h3>

      {t.accounts.length === 0 && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {storeName} has no bank or e-wallet account yet. Add one under{' '}
          <a href="/money-accounts" className={NAV_LINK}>
            Money accounts
          </a>{' '}
          first. A wallet option can&apos;t be switched on without one.
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
                    <td className={m.status === 'mapped' ? 'py-1' : 'py-1 text-warning-ink'}>{m.statusText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rows.length === 0 && <p className="text-xs text-neutral-500 dark:text-neutral-400">No payment options yet. Add them in the list above.</p>}

      {rows.map(({ option, tender }) =>
        tender?.isActive ? (
          <TenderRecord key={`${tender.id}:${tender.version}`} storeId={storeId} x={tender} t={t} typed={typedFor(flash, TENDER_EDIT, tender.id, actorId)} />
        ) : (
          <div key={option.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <span className="text-neutral-600 dark:text-neutral-400">
              {option.name} ({KIND_TEXT[option.kind].toLowerCase()}) <span className="text-xs">off at this store</span>
            </span>
            <SwitchOnForm
              storeId={storeId}
              storeName={storeName}
              option={option}
              accounts={t.accounts}
              defaultAccountId={tender?.moneyAccountId ?? ''}
              defaultAlias={tender?.posV1Alias ?? ''}
            />
          </div>
        ),
      )}
    </div>
  );
}

/**
 * One switched-on payment option at this store: a locked EditableRecord (A0). Its name and kind are the option's (shown, never edited here); the store edits its money
 * account (a wallet's) and its POS name. Switch off is its `extra`, shown only while editing. After a refused Save (`typed`), the record reopens in edit mode with the
 * user's typing (DEF-617, T-389). The fields below always draw the STORED values; the browser applies the typing, so Cancel restores what is saved.
 */
function TenderRecord({ storeId, x, t, typed }: { storeId: string; x: TenderAdminRow; t: StoreTenders; typed: TypedView | null }) {
  return (
    <EditableRecord
      action={updateTenderAction}
      label={x.name}
      hidden={{ storeId, tenderId: x.id, version: x.version }}
      typed={typed}
      summary={[
        { label: 'Payment option', value: x.kind === 'cash' ? `${x.name}: cash, switched on` : `${x.name}: wallet, pays into ${x.moneyAccountName ?? 'no account'}` },
        { label: 'POS name', value: x.posV1Alias },
      ]}
      extra={
        <form action={setTenderActiveAction} className="mt-2">
          <input type="hidden" name="storeId" value={storeId} />
          <input type="hidden" name="tenderId" value={x.id} />
          <input type="hidden" name="version" value={x.version} />
          <input type="hidden" name="isActive" value="false" />
          <ConfirmDestructive
            tier="retype"
            label="Switch off payment option"
            consequence="Switches this payment option off at this store. Receipts already taken with it stay as they are."
            expectedName={x.name}
          />
        </form>
      }
    >
      <FormGrid>
        {x.kind === 'wallet' && (
          <Field label="Money account" hint={ACCOUNT_HINT}>
            <Select name="moneyAccountId" defaultValue={x.moneyAccountId ?? ''} className="mt-1 w-full">
              {x.moneyAccountId && !t.accounts.some((a) => a.id === x.moneyAccountId) && (
                <option value={x.moneyAccountId}>{x.moneyAccountName ?? 'Retired account'}</option>
              )}
              {t.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="POS name" hint={POS_NAME_HINT}>
          <Input name="posV1Alias" defaultValue={x.posV1Alias ?? ''} autoComplete="off" className="mt-1 w-full" />
        </Field>
      </FormGrid>
    </EditableRecord>
  );
}

/**
 * T-629: the dialog that switches an OFF payment option on. A wallet asks for the store's money account; a cash option asks only for the POS name.
 * A wallet with no account chosen is refused by the domain in words (it lands on the store card). It is an add form, so it ends in Save (A0 L4). The defaults carry what a switched-off tender kept (its account and POS name), so switching back on is one click.
 */
function SwitchOnForm({
  storeId,
  storeName,
  option,
  accounts,
  defaultAccountId,
  defaultAlias,
}: {
  storeId: string;
  storeName: string;
  option: PaymentOptionAdminRow;
  accounts: readonly { id: string; name: string }[];
  defaultAccountId: string;
  defaultAlias: string;
}) {
  const fields = (
    <>
      <input type="hidden" name="storeId" value={storeId} />
      <input type="hidden" name="paymentOptionId" value={option.id} />
      <FormGrid>
        {option.kind === 'wallet' && (
          <Field label="Money account" hint={ACCOUNT_HINT}>
            <Select name="moneyAccountId" defaultValue={defaultAccountId} className="mt-1 w-full">
              <option value="" disabled>
                Choose the account it pays into
              </option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="POS name" hint={POS_NAME_HINT}>
          <Input name="posV1Alias" defaultValue={defaultAlias} autoComplete="off" className="mt-1 w-full" />
        </Field>
      </FormGrid>
    </>
  );
  return (
    <FormModal trigger="Switch on" triggerVariant="secondary" title={`Switch on ${option.name} — ${storeName}`} size="md">
      <form action={switchOnPaymentOptionAction} autoComplete="off" className="space-y-3">
        {fields}
        <DialogActions>
          <Button type="submit" variant="secondary">
            Save
          </Button>
        </DialogActions>
      </form>
    </FormModal>
  );
}
