import { notFound } from 'next/navigation';
import { CAPABILITY_SCOPE, ROLES, type Capability } from '@shareat/auth';
import { requireSession } from '../../../../lib/session';
import {
  assignRoleAction,
  linkFirebaseAction,
  setCapabilityGrantAction,
  setStoreScopeAction,
  unlinkCredentialAction,
} from '../actions';
import { grantableCapabilitiesFor, grantSourceLabel, userDetail } from '../lib';
import { Page } from '@/components/shell/Page';

export const metadata = { title: 'User access — Shareat System' };
export const dynamic = 'force-dynamic';

const INPUT =
  'rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950';
const BTN =
  'rounded-md bg-neutral-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200';
const LINK_BTN =
  'rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900';

const MANILA = { timeZone: 'Asia/Manila' } as const;

export default async function UserAccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ personId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { personId } = await params;
  const sp = await searchParams;
  const { actor } = await requireSession(`/admin/users/${personId}`);
  const detail = await userDetail(actor.orgId, personId);
  if (!detail) notFound();

  const { person, stores, grants, credentials } = detail;
  const isSelf = actor.personId === personId;
  const activeGrants = grants.filter((g) => g.revokedAt === null);
  const revokedGrants = grants.filter((g) => g.revokedAt !== null);
  const heldNames = new Set(activeGrants.map((g) => g.grantName));
  const offerable = grantableCapabilitiesFor(person.role).filter((c) => !heldNames.has(c));
  const scopedCount = stores.filter((s) => s.inScope).length;

  return (
    <Page density="form">
      <div>
        <a href="/admin/users" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Users and roles
        </a>
        <h1 className="mt-1 text-2xl font-semibold">{person.displayName}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {person.role ? (
            <>
              {person.role.replace(/_/g, ' ')}
              {person.grantedAt && ` since ${person.grantedAt.toLocaleDateString('en-PH', MANILA)}`}
            </>
          ) : (
            'No role — authorized for nothing'
          )}{' '}
          · {scopedCount} store{scopedCount === 1 ? '' : 's'} · {activeGrants.length} extra grant
          {activeGrants.length === 1 ? '' : 's'}
        </p>
      </div>

      {sp.error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {sp.error}
        </div>
      )}
      {sp.ok && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-300">
          {sp.ok}
        </div>
      )}

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Role</h2>
        {isSelf ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            This is you. You cannot change your own role — that is what stops one mis-click locking
            the organisation out of user management. Ask another admin.
          </p>
        ) : (
          <>
            <form action={assignRoleAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="personId" value={personId} />
              <label className="text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Role</span>
                <select name="role" required defaultValue={person.role ?? ''} className={INPUT}>
                  <option value="" disabled>
                    Select
                  </option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className={BTN}>
                {person.role ? 'Change role' : 'Assign role'}
              </button>
            </form>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              Appointing an <strong>admin</strong> requires super-admin, and grants them scope for
              every active store at that moment. A role change is recorded as a revoke plus a new
              grant, so &ldquo;what was their role in March&rdquo; stays answerable.
            </p>
          </>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Store scope</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Holding a capability is never enough on its own — a store-scoped action also needs the
          store. Admin has no bypass here; their access is these rows.
        </p>
        {stores.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            This organisation has no stores yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {stores.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {s.name} <span className="font-mono text-xs text-neutral-400">{s.code}</span>
                </span>
                <form action={setStoreScopeAction}>
                  <input type="hidden" name="personId" value={personId} />
                  <input type="hidden" name="storeId" value={s.id} />
                  <input type="hidden" name="granted" value={s.inScope ? 'false' : 'true'} />
                  <button type="submit" className={LINK_BTN}>
                    {s.inScope ? 'In scope — remove' : 'Add'}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {person.role !== 'admin' && scopedCount === stores.length && stores.length > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            This person still holds scope for every store. If they were recently demoted from admin,
            those rows were deliberately left in place rather than cut silently — remove any they
            should no longer have.
          </p>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Extra capability grants</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Additive overrides on top of the role. A grant is never deleted — revoking one keeps the
          row, with its date, so &ldquo;who could do this in March&rdquo; stays answerable.
        </p>

        {activeGrants.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No extra grants.</p>
        ) : (
          <ul className="space-y-2">
            {activeGrants.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span>
                  <span className="font-mono text-xs">{g.grantName}</span>
                  <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {grantSourceLabel(g.grantSource)}
                  </span>
                </span>
                <form action={setCapabilityGrantAction} className="flex items-center gap-2">
                  <input type="hidden" name="personId" value={personId} />
                  <input type="hidden" name="grantId" value={g.id} />
                  <input type="hidden" name="granted" value="false" />
                  <input name="reason" required placeholder="Reason to revoke" className={`${INPUT} w-40`} />
                  <button type="submit" className={LINK_BTN}>
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        {offerable.length > 0 && (
          <GrantPicker personId={personId} offerable={offerable} />
        )}

        {revokedGrants.length > 0 && (
          <details className="text-xs text-neutral-500 dark:text-neutral-400">
            <summary className="cursor-pointer">{revokedGrants.length} revoked grant(s)</summary>
            <ul className="mt-2 space-y-1">
              {revokedGrants.map((g) => (
                <li key={g.id}>
                  <span className="font-mono">{g.grantName}</span> — revoked{' '}
                  {g.revokedAt?.toLocaleDateString('en-PH', MANILA)}
                  <span className="block text-neutral-500 dark:text-neutral-400">
                    {grantSourceLabel(g.grantSource)} · {g.revokeReason}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {/**
        * T-237 / DEF-224 — the ways this person can sign in.
        *
        * ⭐ Live credentials only. A revoked one is a dead uid or a dead lookup hash: unlike a
        * revoked grant, which records authority somebody once held, there is no decision anyone
        * makes from it, and it would sit on this screen forever.
        */}
      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div>
          <h2 className="font-medium">Sign-in accounts</h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            How this person gets in. Unlinking signs them out everywhere, including terminals, and
            the account can be linked again later.
          </p>
        </div>

        {credentials.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            This person has no way to sign in. Link an email account below, or issue a PIN from{' '}
            <a href="/staff" className="underline underline-offset-2">
              Staff
            </a>
            .
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {credentials.map((c) => {
              const store = c.storeId ? stores.find((s) => s.id === c.storeId) : undefined;
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
                >
                  <span className="min-w-0">
                    <span className="font-medium">
                      {c.kind === 'firebase'
                        ? 'Email account'
                        : c.kind === 'pin'
                          ? `PIN${store ? ` — ${store.name}` : ''}`
                          : `Fingerprint${store ? ` — ${store.name}` : ''}`}
                    </span>
                    <span className="block break-all text-xs text-neutral-500 dark:text-neutral-400">
                      {/* ⚠️ A uid is a name, not a secret — showing it is what lets an administrator
                          tell two accounts apart. A PIN's hashes are never on this page. */}
                      {c.externalId ? <span className="font-mono">{c.externalId}</span> : null}
                      {c.externalId ? ' · ' : ''}
                      added {c.createdAt.toLocaleDateString('en-PH', MANILA)}
                    </span>
                  </span>
                  {c.kind === 'firebase' && (
                    // ⭐ T-239 / DEF-229 — a revocation records why. Same shape as the revoke form
                    //    on `/staff/[employmentId]/credentials`, so the two read as one system.
                    // ⚠️ `flex-wrap` is load-bearing: this sits inside a row that already wraps, and
                    //    on a phone in portrait the input has to drop under the account rather than
                    //    squeeze the uid beside it to nothing.
                    <form
                      action={unlinkCredentialAction}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <input type="hidden" name="personId" value={personId} />
                      <input type="hidden" name="credentialId" value={c.id} />
                      <input
                        name="reason"
                        required
                        placeholder="Reason to unlink"
                        className={`${INPUT} w-44`}
                      />
                      <button type="submit" className={LINK_BTN}>
                        Unlink
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form action={linkFirebaseAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="personId" value={personId} />
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
              Link an email account
            </span>
            <input name="uid" required placeholder="Firebase uid" className={`${INPUT} font-mono`} />
          </label>
          <button type="submit" className={BTN}>
            Link
          </button>
        </form>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          From the Firebase console — this is not an email address. The person signs in with their
          own email and password; this only says which person that account is.
        </p>
      </section>
    </Page>
  );
}

/**
 * ⭐ T-283 — Ian: *"capability grant must be multi select."* One submission, many capabilities.
 *
 * ## Why checkboxes and not `<select multiple>`
 *
 * `grantableCapabilitiesFor` returns every capability the role lacks — for a cashier that is most
 * of a **96-entry** catalogue. A native multiple-select is a scroll box that needs ctrl-click to
 * pick a second item, which on the tablet this app is actually used on is not a control at all.
 *
 * ## ⭐ Why grouped by SCOPE, and why that is not decoration
 *
 * This screen already warns, one section up, that *"holding a capability is never enough on its
 * own — a store-scoped action also needs the store in scope."* Grouping by `CAPABILITY_SCOPE`
 * puts that sentence beside exactly the capabilities it applies to, at the moment the grant is
 * being decided, instead of leaving the reader to carry it down the page.
 *
 * ⚠️ **Not a new pattern.** The full-width touch-target row is lifted from
 * `settings/sales-channels/page.tsx`'s `Radio`, whose own note says *"touch targets are
 * full-width rows, not bare dots — phone portrait is the canvas"* (RULES §3: one uniform,
 * reusable pattern set; familiar-but-upgraded, never reinvented).
 *
 * ⛔ **No `required` attribute, and that is deliberate.** A checkbox group cannot express
 * "at least one" in HTML — marking every box required would demand ALL of them. The server
 * refuses an empty selection in `setCapabilityGrantAction`, which is where the rule belongs
 * anyway: the browser is a convenience, never the control.
 */
const SCOPE_ORDER = ['store', 'org', 'platform'] as const;

const SCOPE_NOTE: Record<(typeof SCOPE_ORDER)[number], string> = {
  store: 'Also needs the store in scope above — holding the capability is never sufficient alone.',
  org: 'Applies across the whole organisation. No store scope is consulted.',
  platform: 'Crosses organisations. Super-admin territory — grant with care.',
};

function GrantPicker({ personId, offerable }: { personId: string; offerable: readonly Capability[] }) {
  const byScope = SCOPE_ORDER.map((scope) => ({
    scope,
    items: offerable.filter((c) => CAPABILITY_SCOPE[c] === scope),
  })).filter((g) => g.items.length > 0);

  return (
    <form action={setCapabilityGrantAction} className="space-y-4">
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="granted" value="true" />

      <div>
        <span className="block text-sm text-neutral-600 dark:text-neutral-400">
          Grant capabilities this role does not have
        </span>
        <span className="block text-xs text-neutral-500 dark:text-neutral-400">
          Tick any number — they are granted together, or not at all if one is refused.{' '}
          {offerable.length} available.
        </span>
      </div>

      {byScope.map((group) => (
        <fieldset key={group.scope} className="space-y-2">
          <legend className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {group.scope}-scoped ({group.items.length})
          </legend>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{SCOPE_NOTE[group.scope]}</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {group.items.map((c) => (
              <label
                key={c}
                className="flex cursor-pointer items-start gap-2 rounded border border-neutral-200 p-2 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <input type="checkbox" name="capability" value={c} className="mt-0.5" />
                <span className="font-mono text-xs">{c}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <button type="submit" className={BTN}>
        Grant selected
      </button>
    </form>
  );
}
