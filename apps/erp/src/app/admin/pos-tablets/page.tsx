import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { staffStoresFor } from '../../staff/lib';
import { clearLockAction, registerTabletAction, revokeTabletAction } from './actions';
import { deviceTail, loadChargeOptions, loadCopyStores, loadDiscounts, loadPosTablets, loadStoreCharges, loadTills, revokeConfirmName, type PosTabletLinkView, type TerminalLockView } from './lib';
import { TillsSection } from './TillsSection';
import { ChargesSection } from './ChargesSection';
import { ChargeOptionsSection } from './ChargeOptionsSection';
import { CHARGE_OPTION_EDIT } from './typed-forms';
import { typedFor } from '@/lib/keep-typing';
import { DiscountsSection } from './DiscountsSection';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { CheckedForm } from '@/components/forms';
import { POS_TABLET_REGISTER_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Badge, Banner, Button, ConfirmDestructive, DialogActions, Field, FlashBanner, FormGrid, FormModal, Input, Select } from '@/components/ui';
import { ActionIcon } from '@/components/ui/action-icons';

export const metadata = { title: 'POS tablets — Shareat System' };
export const dynamic = 'force-dynamic';

const RETURN_TO = '/admin/pos-tablets';
const CARD = 'flex flex-col gap-3 rounded-[20px] border border-surface-border bg-surface p-4';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

const when = (d: Date | null): string => (d ? formatBusinessDateTime(d) : 'never');

function LinkLine({ link }: { link: PosTabletLinkView }) {
  return (
    <>
      Terminal {link.terminalNo}, tablet ending <span title={link.deviceId} className="font-mono">{deviceTail(link.deviceId)}</span>, signs in
      as {link.terminalPersonName}. Linked on {when(link.createdAt)} by {link.createdByName ?? 'unknown'}.
    </>
  );
}

/** T-582: the approval lock as a pill. A word and, when locked, a padlock: never colour alone. */
function LockPill({ locked }: { locked: boolean }) {
  if (!locked) return <Badge tone="success" label="Approvals ready" className="whitespace-nowrap shrink-0" />;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-danger-surface px-2.5 py-0.5 text-xs font-semibold text-danger">
      <ActionIcon name="lock" size={12} />
      Approvals locked
    </span>
  );
}

/** T-582: the lock line and its Clear the lock form, inside the card of the login that is locked (every login keeps it). */
function LockBlock({ lock, storeId }: { lock: TerminalLockView; storeId: string }) {
  if (!lock.capped) return null;
  return (
    <div className="space-y-2">
      <p data-locked className="text-sm text-danger">
        Locked since {when(lock.cappedAt)}. It lifts by itself after 24 hours.
      </p>
      <form action={clearLockAction}>
        <input type="hidden" name="personId" value={lock.personId} />
        <input type="hidden" name="storeId" value={storeId} />
        <Button type="submit" variant="primary">
          Clear the lock
        </Button>
      </form>
    </div>
  );
}

/**
 * `/admin/pos-tablets`. T-505 (Ian, 1 Nov 2026), docs/tasks/505-erp-pos-tablet-links.md. T-582 (Ian, 15 Nov 2026), docs/tasks/582-pos-tablets-cards.md:
 * one card per tablet login (the linked tablet's card carries its device, who it signs in as and Revoke), Register a tablet is behind a header
 * button, and the approval lock lives on each card instead of in a section of its own. No behaviour changed.
 *
 * A POS v2 tablet approves refunds only once an admin links its device id to the store's terminal person. Until this screen that was a
 * command on the server. Admin and super admin only (`provision_clock_terminal`, store-scoped, the capability the writes check). This is
 * NOT the clock-in terminal screen (`/attendance/terminals`): a different table and a different job.
 */
export default async function PosTabletsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess('/admin/pos-tablets');
  if (refusal) return refusal;

  const stores = await staffStoresFor(actor, ['provision_clock_terminal']);
  const store = stores.find((s) => s.id === sp.store) ?? stores[0];

  if (!store) {
    return (
      <Page density="table">
        <h1 className="text-2xl font-semibold">POS tablets</h1>
        <Banner tone="warning">You do not administer any store, so there is no tablet here for you to register.</Banner>
      </Page>
    );
  }

  const { active, revoked, terminals } = await loadPosTablets(actor, store.id);
  const tills = await loadTills(actor, store.id);
  // T-622: the store's named discounts. T-611 S3: the Copy button sits in that section, for an administrator only (presentation; the domain and a PIN gate the write).
  const discounts = await loadDiscounts(actor, store.id);
  // T-634: the charges are ONE org list (manage_menu, org) at the top; this store only switches each on or off (manage_store_settings at the store).
  const chargeOptions = await loadChargeOptions(actor);
  const charges = await loadStoreCharges(actor, store.id);
  // T-389: a refused Edit of a charge reopens it with what was typed.
  const chargeTyped = Object.fromEntries(chargeOptions.options.map((o) => [o.id, typedFor(sp, CHARGE_OPTION_EDIT, o.id, actor.personId)]));
  const copyStores = discounts.canManage ? await loadCopyStores(actor, store.id) : null;
  const activeLock = active ? terminals.find((t) => t.personId === active.terminalPersonId) : undefined;
  const otherLogins = terminals.filter((t) => t.personId !== active?.terminalPersonId);

  return (
    <Page density="table">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-[16rem]">
          <h1 className="text-2xl font-semibold">POS tablets</h1>
          <PageDescription>
            Register a store&apos;s POS tablet so it can ask a manager for a refund approval. Admin or super admin only. This is not the clock-in
            terminal (Setup, Clock terminals).
          </PageDescription>
        </div>
        <FormModal trigger="+ Register tablet" title="Register a tablet" size="md">
          {terminals.length === 0 ? (
            <p data-no-terminal className="text-sm text-neutral-600 dark:text-neutral-400">
              {store.name} has no tablet login yet. Ask the system administrator to set one up for this store. It will appear here
              afterwards.
            </p>
          ) : (
            <CheckedForm rules={POS_TABLET_REGISTER_RULES} action={registerTabletAction} className="space-y-3 text-sm">
              <input type="hidden" name="storeId" value={store.id} />
              {active && (
                <Banner tone="warning">
                  This replaces the tablet ending {deviceTail(active.deviceId)}. That tablet stops working for approvals.
                </Banner>
              )}
              <FormGrid layout="fields">
                <Field label="Device id" width="full" span="full" rule={POS_TABLET_REGISTER_RULES.deviceId}>
                  <Input {...nativeAttrs(POS_TABLET_REGISTER_RULES.deviceId)} className="w-full" placeholder="Paste from the tablet: Settings, Terminal, Copy" autoComplete="off" />
                </Field>
                <Field label="Terminal number (1 to 99)" width="name" rule={POS_TABLET_REGISTER_RULES.terminalNo}>
                  <Input {...nativeAttrs(POS_TABLET_REGISTER_RULES.terminalNo)} defaultValue="1" />
                </Field>
                <Field label="Tablet login" width="name">
                  <Select name="terminalPersonId">
                    {terminals.map((t) => (
                      <option key={t.personId} value={t.personId}>
                        {t.displayName}
                      </option>
                    ))}
                  </Select>
                </Field>
              </FormGrid>
              <DialogActions>
                <Button type="submit" variant="primary">
                  Register tablet
                </Button>
              </DialogActions>
            </CheckedForm>
          )}
        </FormModal>
      </div>

      <FlashBanner flash={sp} />

      {/* T-634: the org's one list of charges, above the store picker because it is the same for every store. */}
      <ChargeOptionsSection options={chargeOptions.options} canManage={chargeOptions.canManage} storeId={store.id} typedOf={chargeTyped} />

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

      <section className="space-y-3 rounded-lg border border-surface-border p-4">
        <h2 className="font-medium">Tablets</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Five wrong manager PINs in a day lock a tablet&apos;s refund approvals. The lock lifts by itself after 24 hours.
        </p>
        {!active && terminals.length > 0 && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No tablet is linked to {store.name} yet.</p>
        )}
        {!active && terminals.length === 0 ? (
          <div className={CARD}>
            <p data-no-terminal className="text-sm text-neutral-600 dark:text-neutral-400">
              {store.name} has no tablet login yet. Ask the system administrator to set one up for this store. It will appear here
              afterwards.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {active && (
              <li data-active-link className={CARD}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-ink">Terminal {active.terminalNo}</h3>
                  <LockPill locked={!!activeLock?.capped} />
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">Tablet</dt>
                  <dd title={active.deviceId} className="font-mono">
                    {deviceTail(active.deviceId)}
                  </dd>
                  <dt className="text-muted">Signs in as</dt>
                  <dd>{active.terminalPersonName}</dd>
                  <dt className="text-muted">Linked</dt>
                  <dd>
                    {when(active.createdAt)} by {active.createdByName ?? 'unknown'}
                  </dd>
                </dl>
                {activeLock && <LockBlock lock={activeLock} storeId={store.id} />}
                <form action={revokeTabletAction} className="space-y-2 border-t border-surface-border pt-3">
                  <input type="hidden" name="linkId" value={active.id} />
                  <input type="hidden" name="storeId" value={store.id} />
                  <ConfirmDestructive
                    tier="retype"
                    label="Revoke tablet link"
                    consequence="Refund approvals on this tablet stop until a tablet is registered again. Nothing is deleted."
                    expectedName={revokeConfirmName(active.terminalNo)}
                  />
                </form>
              </li>
            )}
            {otherLogins.map((t) => (
              <li key={t.personId} className={CARD}>
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-base font-semibold text-ink">{t.displayName}</h3>
                  <LockPill locked={t.capped} />
                </div>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">No tablet is linked to this login.</p>
                <LockBlock lock={t} storeId={store.id} />
              </li>
            ))}
          </ul>
        )}
        {revoked.length > 0 && (
          <details className="text-xs text-neutral-500 dark:text-neutral-400">
            <summary className="inline-flex min-h-6 cursor-pointer items-center">Earlier tablets ({revoked.length})</summary>
            <ul className="mt-2 space-y-1">
              {revoked.map((r) => (
                <li key={r.id}>
                  <LinkLine link={r} /> Ended {when(r.revokedAt)} by {r.revokedByName ?? 'unknown'}.
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <DiscountsSection store={store} presets={discounts.presets} canManage={discounts.canManage} copyStores={copyStores} />
      <ChargesSection store={store} rows={charges.rows} canManage={charges.canManage} />

      <TillsSection store={store} tills={tills} returnTo={RETURN_TO} />
    </Page>
  );
}
