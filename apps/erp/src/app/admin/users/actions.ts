'use server';

/**
 * Server actions for user/role management. T-219 / DEF-167.
 *
 * Thin adapters, exactly like `apps/erp/src/app/staff/actions.ts`: parse `FormData`, call the
 * gated function, redirect with a message. ⭐ The actor comes from the session, never the form
 * (T-138, `tests/unit/no-client-supplied-actor.test.ts`).
 *
 * ⚠️ **The authorization for role assignment is NOT written here.** It lives in
 * `assignRoleAsActor` (`packages/auth/src/roles.ts`) — the `authorize()` call, the §C.1 authority
 * chain and both lockout guards — precisely so it cannot be skipped by a second caller. This file
 * would be the wrong home for it: a rule in one route file is a rule the next route file misses,
 * which is how DEF-180 happened. Scope and grant writes are gated here because they have no
 * equivalent orchestration layer and `accessRepo` deliberately holds no capability knowledge.
 */
import { redirect } from 'next/navigation';
import { accessRepo } from '@shareat/db';
import { assignRoleAsActor, authorize, CAPABILITIES, type Capability, type Role } from '@shareat/auth';
import { withOrgPrincipal } from './lib';
import { requireActor } from '../../../lib/session';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** Same shape as the staff actions': turn a known refusal into a readable sentence rather than
 *  leaking a function name or a raw Postgres message at the presentation edge. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/may not change their own role/.test(raw)) {
    return 'You cannot change your own role. Ask another admin — this is what stops one mis-click locking the org out.';
  }
  if (/requires super_admin/.test(raw)) {
    return 'Only a super-admin can appoint an admin. An admin may appoint managers and staff (bible row 116).';
  }
  if (/only active admin/.test(raw)) {
    return "This is the org's only active admin. Appoint a second admin first — otherwise nobody is left who can manage users.";
  }
  // DEF-183 — only reachable by a crafted POST, since the screen never offers another org's
  // person. Mapped anyway: a refusal a user cannot act on is worse than no refusal at all.
  if (/does not exist in org/.test(raw)) {
    return 'That person is not part of this organisation.';
  }
  if (/may not 'manage_users'/.test(raw)) {
    return 'Only an admin or super-admin can change roles.';
  }
  if (/may not 'grant_capability'/.test(raw)) {
    return 'Only an admin or super-admin can grant or revoke a capability.';
  }
  if (/does not exist or is already revoked/.test(raw)) {
    return 'That grant was already revoked — reload the page to see the current state.';
  }
  return raw.replace(/^[a-z][A-Za-z0-9_]*:\s*/, '');
}

function backToUser(personId: string, extra: Record<string, string>): never {
  redirect(`/admin/users/${personId}?${new URLSearchParams(extra).toString()}`);
}

/**
 * ⭐ The whole point of T-219. Everything that decides whether this is allowed is inside
 * `assignRoleAsActor`; this function only reports the outcome in words a human can act on.
 */
export async function assignRoleAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/users');
  const personId = str(formData, 'personId');
  const role = str(formData, 'role') as Role;

  let message = 'Role updated.';
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) => assignRoleAsActor(tx, actor, { personId, role }));
    // Say what else the write did, rather than letting a materialisation or an elevation be
    // invisible — both are real rows this person now holds (§C.2 and §B.1).
    const extras: string[] = [];
    if (result.materialisedStoreIds.length > 0) {
      extras.push(`store scope for ${result.materialisedStoreIds.length} store(s)`);
    }
    if (result.elevatedGrants.length > 0) {
      extras.push(`${result.elevatedGrants.length} elevated capability grant(s), because this org has no admin`);
    }
    message = extras.length > 0 ? `Role updated, and granted ${extras.join(' and ')}.` : message;
  } catch (err) {
    backToUser(personId, { error: errorMessage(err) });
  }
  backToUser(personId, { ok: message });
}

export async function setStoreScopeAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/users');
  const personId = str(formData, 'personId');
  const storeId = str(formData, 'storeId');
  const granted = str(formData, 'granted') === 'true';

  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await authorize(tx, actor, 'manage_users', {});
      // Even an org-scoped capability must not write a scope row for another org's store —
      // `accessRepo` has the check already (`storeBelongsToOrg`), used here for the same reason
      // `authorize()` uses it: a storeId arriving from a form is not evidence of anything.
      const inOrg = await accessRepo.storeBelongsToOrg(tx, storeId, actor.orgId);
      if (!inOrg) throw new Error('That store does not belong to this organisation.');

      if (granted) {
        await accessRepo.grantStoreScope(tx, { personId, storeId, grantedBy: actor.personId });
      } else {
        await accessRepo.revokeStoreScope(tx, personId, storeId);
      }
    });
  } catch (err) {
    backToUser(personId, { error: errorMessage(err) });
  }
  backToUser(personId, { ok: granted ? 'Store added to this person’s scope.' : 'Store removed from this person’s scope.' });
}

export async function setCapabilityGrantAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/users');
  const personId = str(formData, 'personId');
  const capability = str(formData, 'capability') as Capability;
  const grantId = str(formData, 'grantId');
  const granted = str(formData, 'granted') === 'true';

  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      await authorize(tx, actor, 'grant_capability', {});
      if (granted) {
        // Never trust a capability name off a form into a row that `authorize()` will later
        // compare against — an unknown string would sit in person_grants forever, matching
        // nothing and looking like a granted permission on this very screen.
        if (!CAPABILITIES.includes(capability)) {
          throw new Error(`'${capability}' is not a known capability.`);
        }
        await accessRepo.grantCapability(tx, { personId, grantName: capability, grantedBy: actor.personId });
      } else {
        await accessRepo.revokeGrantById(tx, grantId);
      }
    });
  } catch (err) {
    backToUser(personId, { error: errorMessage(err) });
  }
  backToUser(personId, { ok: granted ? `Granted ${capability}.` : 'Grant revoked.' });
}
