import { notFound } from 'next/navigation';
import { pinAttemptsRepo } from '@shareat/db';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import { logger } from '@shareat/core/logger';
import { CAPABILITY_SCOPE, ROLES, ROLE_LABEL, capabilityTitle, type Capability } from '@shareat/auth';
import { requirePageAccess } from '../../../../lib/page-access';
import {
  assignRoleAction,
  linkFirebaseAction,
  resetApprovalPinCapAction,
  setCapabilityGrantAction,
  setStoreScopeAction,
  unlinkCredentialAction,
} from '../actions';
import {
  canRevokeHere,
  foldActiveGrants,
  grantableCapabilitiesFor,
  grantSourceLabel,
  grantSummaryLine,
  positionProvenanceLine,
  userDetail,
  withOrgPrincipal,
} from '../lib';
import { Page } from '@/components/shell/Page';
import { Button, ConfirmDestructive, FlashBanner, Input, Select } from '@/components/ui';
import { withFlash } from '@/lib/flash';

export const metadata = { title: 'User access — Shareat System' };
export const dynamic = 'force-dynamic';

const MANILA = { timeZone: 'Asia/Manila' } as const;

/**
 * T-291 §C2 / spec T2 — the seam to T-290's screen. Rendered as plain text while T-290 was not
 * yet on main (a page-to-page link is not covered by `nav-route-reachability`'s direction-A check,
 * so it would have been a live 404 with no guard); T-290's commit flipped it to the anchor in the
 * same sha that adds the page, so no sha ever carried a dead link.
 */
const ACCESS_DEFAULTS_LINK = (
  <a href="/admin/access-defaults" className="inline-block py-1 text-xs underline underline-offset-2">
    Position access defaults
  </a>
);

export default async function UserAccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ personId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { personId } = await params;
  const sp = await withFlash(searchParams);
  const { actor, refusal } = await requirePageAccess(`/admin/users/${personId}`);
  // ⭐ T-288 — the READ gate. Ian, 2026-09-12: "do both hide the menu and gate the reads."
  if (refusal) return refusal;
  const detail = await userDetail(actor.orgId, personId);
  if (!detail) notFound();

  const { person, stores, grants, credentials } = detail;
  // T-416: is this person's administrator-PIN approval bucket capped right now (auto-lift applied)?
  // Informational banner only: if the status read fails the page still renders, just without the banner.
  const approvalCap = await withOrgPrincipal(actor.orgId, (tx) => pinAttemptsRepo.statusForActor(tx, actor.orgId, personId)).catch((err: unknown): { capped: boolean; cappedAt: Date | null } => {
    logger.warn({ err }, 'admin/users: could not read the approval-PIN cap status; rendering without the banner');
    return { capped: false, cappedAt: null };
  });
  const isSelf = actor.personId === personId;
  const activeGrants = grants.filter((g) => g.revokedAt === null);
  const revokedGrants = grants.filter((g) => g.revokedAt !== null);
  // T-349 §4b item 3 (S2b) — excludes only an ORG-WIDE hold (an active row with `storeId === null`).
  // A store-scoped hold or a bare 'position' row does not exhaust the org-wide picker slot; the
  // picker still lets an admin grant the capability org-wide on top of it.
  const heldNames = new Set(activeGrants.filter((g) => g.storeId === null).map((g) => g.grantName));
  const offerable = grantableCapabilitiesFor(person.role).filter((c) => !heldNames.has(c));
  const scopedCount = stores.filter((s) => s.inScope).length;
  // T-349 / DEF-456 §3.4 — one line per capability and store; a covered 'position' row folds into
  // its covering 'grant'/'owner' row's line instead of listing on its own.
  const foldedGrants = foldActiveGrants(activeGrants);
  const storeNameById = new Map(stores.map((s) => [s.id, s.name]));

  return (
    <Page density="table">
      <div>
        <a href="/admin/users" className="text-sm text-neutral-500 underline underline-offset-2 dark:text-neutral-400">
          ← Users and roles
        </a>
        <h1 className="mt-1 text-2xl font-semibold">{person.displayName}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {person.role ? (
            <>
              {ROLE_LABEL[person.role]}
              {person.grantedAt && ` since ${person.grantedAt.toLocaleDateString('en-PH', MANILA)}`}
            </>
          ) : (
            'No role — authorized for nothing'
          )}{' '}
          · {scopedCount} store{scopedCount === 1 ? '' : 's'} ·{' '}
          {grantSummaryLine(foldedGrants.map((fg) => fg.grant))}
        </p>
      </div>

      <FlashBanner flash={sp} />

      {approvalCap.capped && (
        <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="font-medium">Administrator-PIN approvals</h2>
          <p className="text-sm text-warning-ink">
            Capped since {approvalCap.cappedAt ? formatBusinessDateTime(approvalCap.cappedAt) : 'earlier today'}. Too many wrong
            administrator PINs. It lifts by itself after 24 hours.
          </p>
          {isSelf ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">Another administrator must clear this.</p>
          ) : (
            <form action={resetApprovalPinCapAction}>
              <input type="hidden" name="personId" value={personId} />
              <Button type="submit" variant="secondary">
                Clear the approval-PIN cap
              </Button>
            </form>
          )}
        </section>
      )}

      <section className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="font-medium">Role</h2>
        {isSelf ? (
          <p className="text-sm text-warning-ink">
            This is you. You cannot change your own role — that is what stops one mis-click locking
            the organisation out of user management. Ask another admin.
          </p>
        ) : (
          <>
            <form action={assignRoleAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="personId" value={personId} />
              <label className="min-w-0 flex-1 text-sm">
                <span className="block text-neutral-600 dark:text-neutral-400">Role</span>
                <Select name="role" required defaultValue={person.role ?? ''} className="w-full">
                  <option value="" disabled>
                    Select
                  </option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" variant="primary">
                {person.role ? 'Change role' : 'Assign role'}
              </Button>
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
                  {s.inScope ? (
                    <ConfirmDestructive
                      tier="retype"
                      label="In scope — remove"
                      consequence={`Takes ${s.name} out of this person's store scope. They stop seeing that store's records.`}
                      expectedName={person.displayName}
                    />
                  ) : (
                    <Button type="submit" variant="secondary">
                      Add
                    </Button>
                  )}
                </form>
              </li>
            ))}
          </ul>
        )}
        {person.role !== 'admin' && scopedCount === stores.length && stores.length > 0 && (
          <p className="text-xs text-warning-ink">
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

        {foldedGrants.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No extra grants.</p>
        ) : (
          <ul className="space-y-2">
            {foldedGrants.map(({ grant: g, alsoVia }) => {
              const revocable = canRevokeHere(g);
              // T-349 / DEF-456 §3.4 — a store-scoped 'grant' row names its store; every other
              // revocable source keeps its plain grantSourceLabel.
              const provenance =
                revocable && g.grantSource === 'grant' && g.storeId
                  ? `hand-granted at ${storeNameById.get(g.storeId) ?? 'an unknown store'}`
                  : revocable
                    ? grantSourceLabel(g.grantSource)
                    : positionProvenanceLine(g.positionSource);
              return (
                <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 text-sm">
                  <span>
                    <span>{capabilityTitle(g.grantName)}</span>
                    <span className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">{provenance}</span>
                    {alsoVia.map((source) => (
                      <span key={source.id} className="ml-2 text-xs text-neutral-500 dark:text-neutral-400">
                        also {positionProvenanceLine(source)}
                      </span>
                    ))}
                    <span className="block font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                      {g.grantName}
                    </span>
                  </span>
                  {revocable ? (
                    <form action={setCapabilityGrantAction} className="flex items-center gap-2">
                      <input type="hidden" name="personId" value={personId} />
                      <input type="hidden" name="grantId" value={g.id} />
                      <input type="hidden" name="granted" value="false" />
                      <Input name="reason" required placeholder="Reason to revoke" className="min-w-0 flex-1" />
                      <ConfirmDestructive
                        tier="retype"
                        label="Revoke grant"
                        consequence="Takes this capability away from the person."
                        expectedName={capabilityTitle(g.grantName)}
                      />
                    </form>
                  ) : (
                    // T-291 §C2 — a `'position'` row offers no revoke control here: the next
                    // `reconcilePositionGrants` would silently undo it. In its place, the seam to
                    // where this IS actually controlled — the defaults screen, or the person's
                    // own positions.
                    <div className="flex flex-col items-end gap-1 text-right text-xs text-neutral-500 dark:text-neutral-400">
                      <span>
                        Change this at {ACCESS_DEFAULTS_LINK}, or change their positions on their{' '}
                        {/* T-262 / DEF-269 — an inline text link this small needs its own padding to
                            clear the 24px touch-target floor (`inline-block` so the padding actually
                            grows the tappable box, not just the background). `text-xs` matches the
                            surrounding sentence rather than inheriting it, so the model — and a
                            reviewer — can see the box is authored, not left to guesswork. */}
                        <a
                          href="/staff"
                          className="inline-block py-1 text-xs underline underline-offset-2"
                        >
                          employment
                        </a>
                        .
                      </span>
                      {/* T-291 §C3 — Ian's decision 5: a hand-grant of a capability already held
                          via a position creates a SECOND grant row alongside it — the
                          position-sourced (store-scoped) row is untouched (migration 0159;
                          `access.ts`'s position branch only matches/upgrades an existing
                          store-NULL row, so a position row never qualifies).
                          ⭐ T-349 / DEF-456 (2026-09-27) — that second row is now STORE-scoped, to
                          THIS row's own store, never org-wide: `positionGrantId` below names this
                          exact job row, `grantCapabilityAsActor` reads its store from
                          `activePositionGrantForPerson`, never the form (§7.1), and
                          `accessRepo.grantCapability`'s store-grant branch writes `store_id` to
                          that store, `source_ref` always NULL. Revoking the hand grant leaves this
                          job row, and the access it gives at this store, untouched.
                          One submission of
                          `setCapabilityGrantAction` the picker cannot reach on its own, because
                          `grantableCapabilitiesFor` already removed every held capability from it
                          (page.tsx `offerable`, `lib.ts`'s own comment on that function). Not
                          rendered on the actor's own page — `isSelf` already governs every other
                          self-write control on this screen, and the self-grant refusal in
                          `grantCapabilityAsActor` stays the real gate either way. */}
                      {!isSelf && (
                        <form action={setCapabilityGrantAction} className="flex flex-col items-end gap-1">
                          <input type="hidden" name="personId" value={personId} />
                          <input type="hidden" name="granted" value="true" />
                          <input type="hidden" name="capability" value={g.grantName} />
                          <input type="hidden" name="intent" value="hold_own_right" />
                          {/* T-349 / DEF-456 §3.4 — the store the hold lands at is resolved
                              server-side from THIS row (`activePositionGrantForPerson`), never a
                              store field on the form (§7.1). Every folded 'position' line reaching
                              this branch is, by construction, uncovered — `g.id` names exactly the
                              job row the hold is made from. */}
                          <input type="hidden" name="positionGrantId" value={g.id} />
                          <Button type="submit" variant="secondary">
                            Hold in their own right
                          </Button>
                        </form>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
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
                  <span>
                    {capabilityTitle(g.grantName)} — revoked{' '}
                    {g.revokedAt?.toLocaleDateString('en-PH', MANILA)}
                  </span>
                  <span className="block font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                    {g.grantName}
                  </span>
                  <span className="block text-neutral-500 dark:text-neutral-400">
                    {g.grantSource === 'position'
                      ? positionProvenanceLine(g.positionSource)
                      : g.grantSource === 'grant' && g.storeId
                        ? `hand-granted at ${storeNameById.get(g.storeId) ?? 'an unknown store'}`
                        : grantSourceLabel(g.grantSource)}{' '}
                    · {g.revokeReason}
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
                      <Input
                        name="reason"
                        required
                        placeholder="Reason to unlink"
                        className="min-w-0 flex-1"
                      />
                      <ConfirmDestructive
                        tier="retype"
                        label="Unlink sign-in"
                        consequence="Unlinks this sign-in account and signs the person out of every live session."
                        expectedName={person.displayName}
                      />
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
            <Input name="uid" required placeholder="Firebase uid" className="font-mono" />
          </label>
          <Button type="submit" variant="secondary">
            Link
          </Button>
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
                <span>
                  <span>{capabilityTitle(c)}</span>
                  <span className="block font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{c}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <Button type="submit" variant="secondary">
        Grant selected
      </Button>
    </form>
  );
}
