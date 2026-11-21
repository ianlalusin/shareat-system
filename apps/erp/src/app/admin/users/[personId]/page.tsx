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
import { Badge, Button, Checkbox, ConfirmDestructive, Field, FlashBanner, Input, SaveBar, Select, Table, Td, Th } from '@/components/ui';
import { CheckedForm } from '@/components/forms';
import {
  ADMIN_ASSIGN_ROLE_RULES,
  ADMIN_GRANT_REVOKE_RULES,
  ADMIN_LINK_FIREBASE_RULES,
  ADMIN_UNLINK_RULES,
  nativeAttrs,
} from '@shareat/domain/field-rules';
import { withFlash } from '@/lib/flash';
import { NAV_LINK } from '@/components/action-link';

export const metadata = { title: 'User access — Shareat System' };
export const dynamic = 'force-dynamic';

/** One bordered card; every block on this screen uses it so they read as one system. */
const SECTION = 'space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800';

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

/** Like the link above: a pointer to another screen inside a grant row, not a row destination (T-411). */
const EMPLOYMENT_LINK = (
  <a href="/staff" className="inline-block py-1 text-xs underline underline-offset-2">
    employment
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

  const { person, stores, grants, credentials, openJobs, pinResetPending } = detail;
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
    <Page view="detail" sectioned density="table">
      <div>
        <a href="/admin/users" className={`${NAV_LINK} text-neutral-500 dark:text-neutral-400`}>
          ← Users and roles
        </a>
        <h1 className="mt-1 text-2xl font-semibold">{person.displayName}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {person.role ? (
            <>
              {ROLE_LABEL[person.role]}
              {person.grantedAt && ` since ${formatBusinessDateTime(person.grantedAt, { dateStyle: 'long' })}`}
            </>
          ) : (
            'No role — authorized for nothing'
          )}{' '}
          · {scopedCount} store{scopedCount === 1 ? '' : 's'} ·{' '}
          {grantSummaryLine(foldedGrants.map((fg) => fg.grant))}
        </p>
        {/* T-612 seam: the account-status row (Inactive / Active / Suspended / Ended) goes here, between the summary line and the staff link. No logic yet. */}
        <p className="mt-1 text-sm">
          {openJobs.length === 0 ? (
            <a href="/staff" className={NAV_LINK}>
              No open staff record. Open Staff
            </a>
          ) : (
            openJobs.map((j) => (
              <a key={j.id} href={`/staff/${j.id}`} className={`${NAV_LINK} mr-4`}>
                Staff record{openJobs.length > 1 ? ` — ${storeNameById.get(j.storeId) ?? 'a store'}` : ''}
              </a>
            ))
          )}
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

      {/* Top: who they are and how they get in. Role + store access on the left, sign-in on the right. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <section className={SECTION}>
            <h2 className="font-medium">Role</h2>
            {isSelf ? (
              <p className="text-sm text-warning-ink">
                This is you. You cannot change your own role — that is what stops one mis-click locking
                the organisation out of user management. Ask another admin.
              </p>
            ) : (
              <>
                <CheckedForm rules={ADMIN_ASSIGN_ROLE_RULES} action={assignRoleAction} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="personId" value={personId} />
                  <Field label="Role" rule={ADMIN_ASSIGN_ROLE_RULES.role} className="flex-1">
                    <Select {...nativeAttrs(ADMIN_ASSIGN_ROLE_RULES.role)} defaultValue={person.role ?? ''} className="w-full">
                      <option value="" disabled>
                        Select
                      </option>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button type="submit" variant="primary">
                    {person.role ? 'Change role' : 'Assign role'}
                  </Button>
                </CheckedForm>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Appointing an <strong>admin</strong> needs the Super admin role, and gives them access to every
                  active store at that moment. A role change keeps the old role on record, so you can
                  still see what their role was in March.
                </p>
              </>
            )}
          </section>

          <section className={SECTION}>
            <h2 className="font-medium">Store access</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              To act at a store, a person needs both the permission and access to that store. Even an
              admin only has the stores listed here.
            </p>
            {stores.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400">This organisation has no stores yet.</p>
            ) : (
              <Table label="Store access" card={{ title: 'Store', keys: ['Access'] }}>
                <thead>
                  <tr>
                    <Th>Store</Th>
                    <Th>Access</Th>
                    <Th className="text-right">
                      <span className="sr-only">Change</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {stores.map((s) => (
                    <tr key={s.id}>
                      <Td>
                        {s.name} <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{s.code}</span>
                      </Td>
                      <Td>{s.inScope ? <Badge tone="success" label="In scope" /> : <Badge tone="closed" label="No access" />}</Td>
                      <Td className="text-right">
                        <form action={setStoreScopeAction} className="inline-block">
                          <input type="hidden" name="personId" value={personId} />
                          <input type="hidden" name="storeId" value={s.id} />
                          <input type="hidden" name="granted" value={s.inScope ? 'false' : 'true'} />
                          {s.inScope ? (
                            <ConfirmDestructive
                              tier="retype"
                              label="Remove"
                              consequence={`Takes ${s.name} out of this person's store scope. They stop seeing that store's records.`}
                              expectedName={person.displayName}
                            />
                          ) : (
                            <Button type="submit" variant="secondary">
                              Add
                            </Button>
                          )}
                        </form>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {person.role !== 'admin' && scopedCount === stores.length && stores.length > 0 && (
              <p className="text-xs text-warning-ink">
                This person still holds scope for every store. If they were recently demoted from admin,
                those rows were deliberately left in place rather than cut silently — remove any they
                should no longer have.
              </p>
            )}
          </section>
        </div>

        {/**
          * T-237 / DEF-224 — the ways this person can sign in.
          *
          * ⭐ Live credentials only. A revoked one is a dead uid or a dead lookup hash: unlike a
          * revoked grant, which records authority somebody once held, there is no decision anyone
          * makes from it, and it would sit on this screen forever.
          */}
        <section className={SECTION}>
          <div>
            <h2 className="font-medium">Sign-in accounts</h2>
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              How this person gets in. Unlinking signs them out everywhere, including terminals, and
              the account can be linked again later.
            </p>
          </div>

          {pinResetPending && (
            <p className="text-sm text-warning-ink">
              PIN reset: set a new PIN. Their role was raised, so the old PIN no longer works.
            </p>
          )}

          {credentials.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              This person has no way to sign in. Link an email account below, or issue a PIN from{' '}
              <a href="/staff" className="underline underline-offset-2">
                Staff
              </a>
              .
            </p>
          ) : (
            <Table label="Sign-in accounts" card={{ title: 'Account' }}>
              <thead>
                <tr>
                  <Th>Account</Th>
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => {
                  const store = c.storeId ? stores.find((s) => s.id === c.storeId) : undefined;
                  return (
                    <tr key={c.id}>
                      <Td>
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
                          added {formatBusinessDateTime(c.createdAt, { dateStyle: 'long' })}
                        </span>
                        {c.kind === 'firebase' && (
                          // ⭐ T-239 / DEF-229 — a revocation records why. Same shape as the revoke form
                          //    on `/staff/[employmentId]/credentials`, so the two read as one system.
                          // ⚠️ `flex-wrap` is load-bearing: on a phone in portrait the input has to drop
                          //    under the account rather than squeeze the uid beside it to nothing.
                          <CheckedForm
                            rules={ADMIN_UNLINK_RULES}
                            action={unlinkCredentialAction}
                            className="mt-3 flex flex-wrap items-end gap-2"
                          >
                            <input type="hidden" name="personId" value={personId} />
                            <input type="hidden" name="credentialId" value={c.id} />
                            <Field label="Reason to unlink" rule={ADMIN_UNLINK_RULES.reason} className="flex-1">
                              <Input
                                {...nativeAttrs(ADMIN_UNLINK_RULES.reason)}
                                placeholder="Reason to unlink"
                                className="w-full"
                              />
                            </Field>
                            <ConfirmDestructive
                              tier="retype"
                              label="Unlink sign-in"
                              consequence="Unlinks this sign-in account and signs the person out of every live session."
                              expectedName={person.displayName}
                            />
                          </CheckedForm>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}

          <CheckedForm rules={ADMIN_LINK_FIREBASE_RULES} action={linkFirebaseAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="personId" value={personId} />
            <Field label="Link an email account" rule={ADMIN_LINK_FIREBASE_RULES.uid} className="flex-1">
              <Input {...nativeAttrs(ADMIN_LINK_FIREBASE_RULES.uid)} placeholder="Account ID" className="w-full font-mono" />
            </Field>
            <Button type="submit" variant="secondary">
              Link
            </Button>
          </CheckedForm>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Paste the account ID from the sign-in system. It is not an email address. The person signs in
            with their own email and password; this only says which person that account belongs to.
          </p>
        </section>
      </div>

      {/* Bottom, full width: what they can do on top of the role. */}
      <section className={SECTION}>
        <h2 className="font-medium">Capability grants</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Additive overrides on top of the role. A grant is never deleted — revoking one keeps the
          row, with its date, so &ldquo;who could do this in March&rdquo; stays answerable.
        </p>

        {foldedGrants.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">No extra grants.</p>
        ) : (
          <Table label="Extra capability grants" card={{ title: 'Capability', keys: ['Where it comes from'] }}>
            <thead>
              <tr>
                <Th>Capability</Th>
                <Th>Where it comes from</Th>
                <Th>
                  <span className="sr-only">Change</span>
                </Th>
              </tr>
            </thead>
            <tbody>
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
                  <tr key={g.id}>
                    <Td>
                      <span>{capabilityTitle(g.grantName)}</span>
                    </Td>
                    <Td className="text-xs text-neutral-600 dark:text-neutral-400">
                      <span>{provenance}</span>
                      {alsoVia.map((source) => (
                        <span key={source.id} className="block">
                          also {positionProvenanceLine(source)}
                        </span>
                      ))}
                    </Td>
                    <Td>
                      {revocable ? (
                        <CheckedForm rules={ADMIN_GRANT_REVOKE_RULES} action={setCapabilityGrantAction} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="personId" value={personId} />
                          <input type="hidden" name="grantId" value={g.id} />
                          <input type="hidden" name="granted" value="false" />
                          <Field label="Reason to revoke" rule={ADMIN_GRANT_REVOKE_RULES.reason} className="flex-1">
                            <Input {...nativeAttrs(ADMIN_GRANT_REVOKE_RULES.reason)} placeholder="Reason to revoke" className="w-full" />
                          </Field>
                          <ConfirmDestructive
                            tier="retype"
                            label="Revoke grant"
                            consequence="Takes this capability away from the person."
                            expectedName={capabilityTitle(g.grantName)}
                          />
                        </CheckedForm>
                      ) : (
                        // T-291 §C2 — a `'position'` row offers no revoke control here: the next
                        // `reconcilePositionGrants` would silently undo it. In its place, the seam to
                        // where this IS actually controlled — the defaults screen, or the person's
                        // own positions.
                        <div className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                          <span>
                            Change this at {ACCESS_DEFAULTS_LINK}, or change their positions on their{' '}
                            {/* T-262 / DEF-269 — an inline text link this small needs its own padding to
                                clear the 24px touch-target floor (`inline-block` so the padding grows the
                                tappable box). */}
                            {EMPLOYMENT_LINK}
                            .
                          </span>
                          {/* T-291 §C3 — Ian's decision 5: a hand-grant of a capability already held via a
                              position creates a SECOND grant row alongside it; the position-sourced row is
                              untouched. ⭐ T-349 / DEF-456 — that second row is STORE-scoped, to THIS row's
                              own store, never org-wide: `positionGrantId` names this exact job row and the
                              store is resolved server-side from it, never from the form (§7.1). Not rendered
                              on the actor's own page — `isSelf` governs every self-write control, and the
                              self-grant refusal in `grantCapabilityAsActor` stays the real gate. */}
                          {!isSelf && (
                            <form action={setCapabilityGrantAction}>
                              <input type="hidden" name="personId" value={personId} />
                              <input type="hidden" name="granted" value="true" />
                              <input type="hidden" name="capability" value={g.grantName} />
                              <input type="hidden" name="intent" value="hold_own_right" />
                              <input type="hidden" name="positionGrantId" value={g.id} />
                              <Button type="submit" variant="secondary">
                                Hold in their own right
                              </Button>
                            </form>
                          )}
                        </div>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {offerable.length > 0 && <GrantPicker personId={personId} offerable={offerable} />}

        {revokedGrants.length > 0 && (
          <details className="text-xs text-neutral-500 dark:text-neutral-400">
            <summary className="cursor-pointer py-2">{revokedGrants.length} revoked {revokedGrants.length === 1 ? 'grant' : 'grants'}</summary>
            <div className="mt-2">
              <Table label="Revoked grants" card={{ title: 'Capability', keys: ['Revoked'] }}>
                <thead>
                  <tr>
                    <Th>Capability</Th>
                    <Th>Where it came from</Th>
                    <Th>Revoked</Th>
                    <Th>Reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {revokedGrants.map((g) => (
                    <tr key={g.id}>
                      <Td>
                        <span>{capabilityTitle(g.grantName)}</span>
                      </Td>
                      <Td>
                        {g.grantSource === 'position'
                          ? positionProvenanceLine(g.positionSource)
                          : g.grantSource === 'grant' && g.storeId
                            ? `hand-granted at ${storeNameById.get(g.storeId) ?? 'an unknown store'}`
                            : grantSourceLabel(g.grantSource)}
                      </Td>
                      <Td>{g.revokedAt ? formatBusinessDateTime(g.revokedAt, { dateStyle: 'long' }) : null}</Td>
                      <Td>{g.revokeReason}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </details>
        )}
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
  store: 'Also needs access to the store (see Store access above).',
  org: 'Works across the whole organization, in every store.',
  platform: 'Works across organizations. Super admin only. Grant with care.',
};

const SCOPE_TITLE: Record<(typeof SCOPE_ORDER)[number], string> = { store: 'Per store', org: 'Whole organization', platform: 'Platform' };

function GrantPicker({ personId, offerable }: { personId: string; offerable: readonly Capability[] }) {
  const byScope = SCOPE_ORDER.map((scope) => ({
    scope,
    items: offerable.filter((c) => CAPABILITY_SCOPE[c] === scope),
  })).filter((g) => g.items.length > 0);

  return (
    <form action={setCapabilityGrantAction} className="space-y-3">
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="granted" value="true" />

      <div>
        <span className="block text-sm text-neutral-600 dark:text-neutral-400">
          Grant capabilities this role does not have
        </span>
        <span className="block text-xs text-neutral-500 dark:text-neutral-400">
          Open a group and tick any number — they are granted together, or not at all if one is refused.{' '}
          {offerable.length} available.
        </span>
      </div>

      {/* Closed groups stay mounted, so a tick inside one is still submitted with the form. */}
      {byScope.map((group) => (
        <details key={group.scope} className="rounded-lg border border-neutral-200 dark:border-neutral-800">
          <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
            <span className="text-xs uppercase tracking-wide">
              {SCOPE_TITLE[group.scope]} <span className="text-neutral-500 dark:text-neutral-400">({group.items.length})</span>
            </span>
            <span className="text-xs font-normal text-neutral-500 dark:text-neutral-400">{SCOPE_NOTE[group.scope]}</span>
          </summary>
          <Table label={`${SCOPE_TITLE[group.scope]} capabilities`} card={{ title: 'Capability' }}>
            <thead>
              <tr>
                <Th>Capability</Th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((c) => (
                <tr key={c}>
                  <Td>
                    {/* No `required`: a checkbox group cannot express "at least one"; the server refuses an empty selection. */}
                    <Checkbox name="capability" value={c} label={capabilityTitle(c)} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      ))}

      {/* Stays at the bottom of the screen while the long list scrolls, so the save is never off-screen. Red = the brand fill (primary). */}
      <SaveBar>
        <Button type="submit" variant="primary">
          Grant selected
        </Button>
      </SaveBar>
    </form>
  );
}
