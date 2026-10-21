import { requireSession } from '../../../lib/session';
import { mintTerminalTokenAction, provisionTerminalAction, revokeTerminalAction } from './actions';
import { isReady, listStores, terminalsForStore, type ClockTerminalRow } from './lib';
import { ProvisionForm } from './ProvisionForm';
import { RepairButton } from './RepairButton';
import { Page } from '@/components/shell/Page';
import { FilterRow } from '@/components/FilterRow';
import { PageDescription } from '@/components/shell/PageDescription';
import { withFlash } from '@/lib/flash';
import { ConfirmDestructive, Field, FlashBanner, Input, Select } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import { ATTENDANCE_TERMINAL_REVOKE_RULES, nativeAttrs } from '@shareat/domain/field-rules';

export const metadata = { title: 'Clock terminals — Shareat System' };
export const dynamic = 'force-dynamic';

interface SearchParams {
  store?: string;
  error?: string;
  ok?: string;
}

function fmt(d: Date | null): string {
  if (!d) return '—';
  return d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * ⭐ Invariant 1: "not ready" is stated, not implied. `isReady` is `terminals.ts`'s own function,
 * reused rather than reimplemented (spec §1: "reuse it, do not reimplement the readiness check").
 */
function stateOf(t: ClockTerminalRow): { text: string; ready: boolean } {
  return isReady(t)
    ? { text: `Active — paired ${fmt(t.activatedAt)}`, ready: true }
    : { text: 'Provisioned — not yet paired. Cannot punch.', ready: false };
}

/*
  ⭐ T-203, closing DEF-133. Until this screen existed, `provisionTerminal` / `activateTerminal` /
  `revokeTerminal` / `mintTerminalToken` (T-159) and `createFirestoreTerminalDriver()`
  (`packages/sync-firestore`) had zero callers anywhere in `apps/` — `/clock`'s own pairing screen
  (`apps/erp/src/app/clock/page.tsx:162,292`) already referenced "the provisioning screen" as
  where its token comes from, and that screen simply did not exist.

  ⚠️ `provision_clock_terminal` (admin/super-admin only) gates provisioning, re-pairing and
  revoking; `manage_attendance` (manager and up) gates reading this list — both already decided,
  `packages/auth/src/capabilities.ts:602,596`. This screen adds no capability of its own.
*/
export default async function TerminalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await withFlash(searchParams);
  const { actor } = await requireSession('/attendance/terminals');
  const stores = await listStores(actor.orgId);
  const storeId = sp.store && stores.some((s) => s.id === sp.store) ? sp.store : stores[0]?.id;

  if (!storeId) {
    return (
      <Page density="table" className="">
        <h1 className="text-2xl font-semibold">Clock terminals</h1>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
          This organisation has no stores yet.
        </p>
      </Page>
    );
  }

  const terminals = await terminalsForStore(actor.orgId, actor, storeId);

  return (
    <Page density="table">
      <div>
        <h1 className="text-2xl font-semibold">Clock terminals</h1>
        <PageDescription>
          Provision a device to punch attendance at a store, and see its one-time pairing token —
          as text and as a QR code — while it is still online. ⭐ Provisioning, re-pairing and
          revoking need <strong>admin or super-admin</strong>; everyone with manage-attendance
          (manager and up) can read this list.
        </PageDescription>
      </div>

      <FlashBanner flash={sp} />

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

      <section className="space-y-3 rounded-lg border border-surface-border p-4">
        <h2 className="font-medium">Provision a new terminal</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          The pairing token is shown <strong>once</strong>, right after provisioning — never
          written to a log and never re-fetchable from this screen afterwards. If it is lost before
          pairing finishes, use &ldquo;Re-pair&rdquo; on the terminal&rsquo;s row below rather than
          provisioning a duplicate.
        </p>
        <ProvisionForm storeId={storeId} action={provisionTerminalAction} />
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">
          Terminals at this store <span className="text-sm font-normal text-neutral-500">({terminals.length})</span>
        </h2>
        {terminals.length === 0 ? (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            No terminal provisioned here yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-surface-border">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-canvas text-left">
                  <th className="px-3 py-2 font-medium">Label</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Last seen</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {terminals.map((t) => {
                  const state = stateOf(t);
                  return (
                    <tr
                      key={t.id}
                      className="border-b border-surface-border align-top last:border-0"
                    >
                      <td className="px-3 py-2 font-medium">{t.label}</td>
                      <td
                        className={`px-3 py-2 ${
                          state.ready
                            ? 'text-success'
                            : 'text-warning-ink'
                        }`}
                      >
                        {state.text}
                      </td>
                      <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                        {fmt(t.lastSeenAt)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col items-start gap-2">
                          <RepairButton terminalId={t.id} label={t.label} action={mintTerminalTokenAction} />
                          <CheckedForm rules={ATTENDANCE_TERMINAL_REVOKE_RULES} action={revokeTerminalAction} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="terminalId" value={t.id} />
                            <input type="hidden" name="storeId" value={storeId} />
                            <Field label="Reason to revoke" rule={ATTENDANCE_TERMINAL_REVOKE_RULES.reason}>
                              <Input {...nativeAttrs(ATTENDANCE_TERMINAL_REVOKE_RULES.reason)} placeholder="Reason to revoke" />
                            </Field>
                            <ConfirmDestructive
                              tier="retype"
                              label="Revoke terminal"
                              consequence="Revokes this terminal. It can no longer punch, and it cannot be revived."
                              expectedName={t.label}
                            />
                          </CheckedForm>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          ⚠️ A revoked terminal stops appearing above — it still exists in Postgres, marked revoked
          with its reason, just not in this live list. Provision a new one rather than trying to
          revive it; its history stays intact under its own id.
        </p>
      </section>
    </Page>
  );
}
