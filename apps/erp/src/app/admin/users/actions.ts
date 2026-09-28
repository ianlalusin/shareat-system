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
import {
  assignRoleAsActor,
  authorize,
  CAPABILITY_SCOPE,
  capabilityTitle,
  grantCapabilityAsActor,
  linkFirebaseCredential,
  unlinkCredential,
  type Capability,
  type Role,
} from '@shareat/auth';
import { requireRevokeReason, withOrgPrincipal } from './lib';
import { clearSessionCookie, requireActor } from '../../../lib/session';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';
import { isPresentable } from '../../../lib/error-shape';

function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

/** A presentable error (every `authorize()` denial and every `roles.ts`/`recordGone` throw among
 *  them) already carries its own sentence — S2/S2b's, or the better ones S7 moved into `roles.ts`
 *  — and wins first. Otherwise, turn a known refusal into a readable sentence rather than leaking
 *  a function name or a raw Postgres message at the presentation edge. */
function errorMessage(err: unknown): string {
  if (isPresentable(err)) return sharedErrorMessage(err);
  const raw = err instanceof Error ? err.message : String(err);
  // T-237 — the unique index is GLOBAL, not per-organisation, so this also fires when the uid is
  // live in another org. ⛔ The sentence stays vague on purpose: naming the person, or even the
  // organisation, would disclose another franchise's staff to an administrator who cannot see them.
  if (/person_credentials_external_id_unique/.test(raw)) {
    return 'That Firebase account is already linked to somebody. Unlink it there first, then link it here.';
  }
  return sharedErrorMessage(err);
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
    // Say what else the write did, rather than letting a materialisation, an elevation or a
    // revocation be invisible — all three are real rows this person's org now holds differently
    // (§C.2, §B.1, and T-248 / DEF-237). Each clause names its own verb so the sentence stays
    // correct however many of the three fire together.
    const extras: string[] = [];
    if (result.materialisedStoreIds.length > 0) {
      extras.push(`granted store scope for ${result.materialisedStoreIds.length} store(s)`);
    }
    if (result.elevatedGrants.length > 0) {
      extras.push(`granted ${result.elevatedGrants.length} elevated capability grant(s), because this org has no admin`);
    }
    if (result.revokedElevatedGrants.length > 0) {
      const affected = new Set(result.revokedElevatedGrants.map((g) => g.personId)).size;
      extras.push(
        `revoked ${result.revokedElevatedGrants.length} temporary grant(s) from ${affected} ` +
          `manager(s), now that this org has an administrator`,
      );
    }
    message = extras.length > 0 ? `Role updated, and ${extras.join(', and ')}.` : message;
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
        // T-336 SCOPE LIFECYCLE fix, migration 0156 — 'manual' always wins, including over an
        // 'employment' row: a human explicitly ticking this box must survive that hire ending.
        await accessRepo.grantStoreScope(tx, { personId, storeId, grantedBy: actor.personId, source: 'manual' });
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
  /**
   * ⭐ T-283 — `getAll`, not `get`. The grant form submits one `capability` field PER TICKED BOX,
   * so this is a list. `str(formData, 'capability')` read only the first and silently dropped the
   * rest, which is the failure shape a multi-select form must never have.
   *
   * ⚠️ The REVOKE branch below sends no `capability` at all (it sends a `grantId`), so this is
   * empty there and nothing downstream reads it. Kept as one read rather than two so the two
   * branches cannot disagree about the field's name.
   */
  const capabilities = formData
    .getAll('capability')
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '') as Capability[];
  const grantId = str(formData, 'grantId');
  const granted = str(formData, 'granted') === 'true';
  /** T-343 S6b / DEF-431 — only picks the banner's WORDING, never a gate: every grant still runs
   *  `grantCapabilityAsActor` once per capability regardless of what a forged `intent` says. */
  const intent = str(formData, 'intent');
  /** T-349 / DEF-456, S2 — which position row a "hold in their own right" came from. The store the
   *  hold lands at is resolved server-side from THIS row, never a store field on the form (§7.1;
   *  there is no such field to forge). */
  const positionGrantId = str(formData, 'positionGrantId');

  // T-349 §4b item 5 (S2b) — computed inside the branch that holds the result, never through a
  // `holdResult!` non-null assertion (RULES: prefer a guard to `!`).
  let ok = 'Grant revoked.';
  try {
    await withOrgPrincipal(actor.orgId, async (tx) => {
      if (granted) {
        if (capabilities.length === 0) {
          throw new Error('Tick at least one capability to grant.');
        }
        if (intent === 'hold_own_right') {
          // T-349 / DEF-456 §3.4 — exactly one capability AND a non-empty positionGrantId are
          // required, refused BEFORE any write. So `intent` can now only ever *refuse*, never
          // widen: an old cached form (no positionGrantId field) cannot fall back to the old
          // org-wide grant.
          if (capabilities.length !== 1 || !positionGrantId) {
            throw new Error('Reload the page and try again.');
          }
          const holdResult = await grantCapabilityAsActor(tx, actor, {
            personId,
            capability: capabilities[0]!,
            positionGrantId,
          });
          ok = holdResult.wrote
            ? holdResult.storeName === null
              ? `${capabilityTitle(capabilities[0]!)} is now held in their own right.`
              : `${capabilityTitle(capabilities[0]!)} is now held in their own right at ${holdResult.storeName}.`
            : holdResult.heldEverywhere
              ? `${capabilityTitle(capabilities[0]!)} was already held in their own right everywhere.`
              : `${capabilityTitle(capabilities[0]!)} was already held in their own right at ${holdResult.storeName}.`;
          return;
        }
        // ⭐ DEF-223 — the GRANT goes through `grantCapabilityAsActor`, which owns the
        // `authorize()` call, the self-check and the capability-name check. It used to be written
        // here, with no self-check at all: an admin could grant capabilities to themselves, and
        // once T-232 §2.2 taught `assignRoleAsActor` to accept `admin` + the super_admin-only
        // grants, that self-grant became a route to appointing admins. Moved into `packages/auth`
        // for the reason this file's header already gives about role assignment — a rule in one
        // route file is a rule the next route file misses.
        // ⛔ ONE CALL PER CAPABILITY, deliberately — never a batched helper that gates once and
        //    writes many. `grantCapabilityAsActor` owns the authorize(), the self-grant check and
        //    the capability-name check that DEF-223 moved into `packages/auth` for the reason
        //    this file's header gives: a rule in one route file is a rule the next route file
        //    misses. Granting five at once must be five passes through that gate, not one.
        //
        // ⛔ And they share this ONE transaction, so a refusal on the fourth rolls back the first
        //    three. Partial success would leave an administrator reading a success banner over a
        //    half-applied authority change.
        for (const capability of capabilities) {
          await grantCapabilityAsActor(tx, actor, { personId, capability });
        }
        // T-349 S2c item 4 — the picker grant is always person-level (org-wide). For a
        // store-scoped capability that reaches every store, so the banner says so; an
        // org/platform-scoped capability has no store axis to name.
        const phrase = (c: Capability) =>
          CAPABILITY_SCOPE[c] === 'store' ? `${capabilityTitle(c)}, at every store` : capabilityTitle(c);
        ok =
          capabilities.length === 1
            ? `Granted: ${phrase(capabilities[0]!)}.`
            : `Granted ${capabilities.length} capabilities: ${capabilities.map(phrase).join('; ')}.`;
      } else {
        // ⚠️ The revoke branch keeps its own `authorize()` and is deliberately NOT self-checked:
        // revoking your own grant NARROWS your authority, so it cannot escalate, and refusing it
        // would stop someone dropping a capability they no longer want to hold.
        await authorize(tx, actor, 'grant_capability', {});
        // T-256 / DEF-247 — the screen now has a free-text reason field (mirrors
        // `unlinkCredentialAction`'s form one section up), so the real reason is captured
        // instead of a fixed, fabricated sentence.
        const reason = requireRevokeReason(str(formData, 'reason'));
        await accessRepo.revokeGrantById(tx, grantId, reason);
        ok = 'Grant revoked.';
      }
    });
  } catch (err) {
    backToUser(personId, { error: errorMessage(err) });
  }
  backToUser(personId, { ok });
}

/**
 * T-237 / DEF-224 — link a Firebase account to this person.
 *
 * ⛔ The form supplies a **uid**, which is a target's credential, never an actor: the actor is the
 * session's, as everywhere else on this screen. The gate and every rule live in
 * `linkFirebaseCredential`; this is the adapter.
 */
export async function linkFirebaseAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/users');
  const personId = str(formData, 'personId');
  const uid = str(formData, 'uid');

  try {
    await withOrgPrincipal(actor.orgId, (tx) =>
      linkFirebaseCredential(tx, actor, { personId, uid }),
    );
  } catch (err) {
    backToUser(personId, { error: errorMessage(err) });
  }
  backToUser(personId, { ok: 'Email account linked. They can sign in with it now.' });
}

/**
 * T-237 / DEF-224 — unlink a credential and end that person's sessions.
 *
 * ⭐ The count comes back from the domain and is REPORTED, never assumed: "signed out of 2
 * sessions" is the difference between a revocation somebody can trust and one they have to go and
 * check. Bible §15.6.
 */
export async function unlinkCredentialAction(formData: FormData): Promise<void> {
  const actor = await requireActor('/admin/users');
  const personId = str(formData, 'personId');
  const credentialId = str(formData, 'credentialId');
  // T-239 / DEF-229. Trimmed and refused by the domain, so this screen and `/staff`'s revoke form
  // cannot drift apart on what counts as blank.
  const reason = str(formData, 'reason');

  let ended = 0;
  try {
    const result = await withOrgPrincipal(actor.orgId, (tx) =>
      unlinkCredential(tx, actor, { personId, credentialId, reason }),
    );
    ended = result.sessionsEnded;

    // ⭐ Unlinking your own credential ended your own session server-side, so the cookie in this
    // browser is now a dead token. Clearing it makes the next page load a clean redirect to
    // `/sign-in` instead of one that resolves nothing and then redirects anyway — and it is the
    // same discipline `signOutAction` follows: the browser forgetting is not the session ending, so
    // this line is hygiene AFTER the real revocation, never instead of it.
    if (actor.personId === personId) await clearSessionCookie();
  } catch (err) {
    backToUser(personId, { error: errorMessage(err) });
  }
  backToUser(personId, {
    ok:
      ended === 0
        ? 'Unlinked. They had no live session to end.'
        : `Unlinked, and signed out of ${ended} live session${ended === 1 ? '' : 's'}.`,
  });
}
