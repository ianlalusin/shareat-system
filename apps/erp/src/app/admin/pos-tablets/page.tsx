import { formatBusinessDateTime } from '@shareat/core/datetime';
import { requirePageAccess } from '../../../lib/page-access';
import { withFlash } from '../../../lib/flash';
import { staffStoresFor } from '../../staff/lib';
import { clearLockAction, registerTabletAction, revokeTabletAction } from './actions';
import { deviceTail, loadPosTablets, revokeConfirmName, type PosTabletLinkView } from './lib';
import { Page } from '@/components/shell/Page';
import { PageDescription } from '@/components/shell/PageDescription';
import { FilterRow } from '@/components/FilterRow';
import { CheckedForm } from '@/components/forms';
import { POS_TABLET_REGISTER_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import { Banner, Button, ConfirmDestructive, Field, FlashBanner, FormGrid, Input, Select } from '@/components/ui';

export const metadata = { title: 'POS tablets — Shareat System' };
export const dynamic = 'force-dynamic';

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

/**
 * `/admin/pos-tablets`. T-505 (Ian, 1 Nov 2026), docs/tasks/505-erp-pos-tablet-links.md.
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

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">POS tablets</h1>
        <PageDescription>
          Register a store&apos;s POS tablet so it can ask a manager for a refund approval. Admin or super admin only. This is not the clock-in
          terminal (Setup, Clock terminals).
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

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
        <h2 className="font-medium">Linked tablets</h2>
        {active ? (
          <div className="space-y-2 text-sm">
            <p data-active-link>
              <LinkLine link={active} />
            </p>
            <form action={revokeTabletAction} className="space-y-2">
              <input type="hidden" name="linkId" value={active.id} />
              <input type="hidden" name="storeId" value={store.id} />
              <ConfirmDestructive
                tier="retype"
                label="Revoke tablet link"
                consequence="Refund approvals on this tablet stop until a tablet is registered again. Nothing is deleted."
                expectedName={revokeConfirmName(active.terminalNo)}
              />
            </form>
          </div>
        ) : (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No tablet is linked to {store.name} yet.</p>
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

      <section className="space-y-3 rounded-lg border border-surface-border p-4">
        <h2 className="font-medium">Register a tablet</h2>
        {terminals.length === 0 ? (
          <p data-no-terminal className="text-sm text-neutral-600 dark:text-neutral-400">
            {store.name} has no tablet login yet. Create the store&apos;s tablet login in the Firebase console first, then run the
            provision-terminal command with that login&apos;s uid. After that it appears here.
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
              <Field label="Device id" width="long" rule={POS_TABLET_REGISTER_RULES.deviceId}>
                <Input {...nativeAttrs(POS_TABLET_REGISTER_RULES.deviceId)} placeholder="Paste from the tablet: Settings, Terminal, Copy" autoComplete="off" />
              </Field>
              <Field label="Terminal number (1 to 99)" width="short" rule={POS_TABLET_REGISTER_RULES.terminalNo}>
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
            <Button type="submit" variant="primary">
              Register tablet
            </Button>
          </CheckedForm>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-surface-border p-4">
        <h2 className="font-medium">Approval lock</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Five wrong manager PINs in a day lock the tablet&apos;s refund approvals. The lock lifts by itself after 24 hours.
        </p>
        {terminals.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">No tablet login at this store.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {terminals.map((t) => (
              <li key={t.personId} className="flex flex-wrap items-center gap-3">
                <span className="font-medium">{t.displayName}</span>
                {t.capped ? (
                  <>
                    <span data-locked>Locked since {when(t.cappedAt)}. It lifts by itself after 24 hours.</span>
                    <form action={clearLockAction}>
                      <input type="hidden" name="personId" value={t.personId} />
                      <input type="hidden" name="storeId" value={store.id} />
                      <Button type="submit" variant="primary">
                        Clear the lock
                      </Button>
                    </form>
                  </>
                ) : (
                  <span className="text-neutral-600 dark:text-neutral-400">Not locked.</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}
