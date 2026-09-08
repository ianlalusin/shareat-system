/**
 * Administering somebody else's sign-in credentials — T-237, closing **DEF-224**.
 * `docs/tasks/237-def-224-firebase-credential-lifecycle.md` §4-§5.
 *
 * ## ⭐ Why this is a new file rather than more of `sessions.ts`
 *
 * Everything in `sessions.ts` is either unauthenticated by nature (`signInWithPin`,
 * `signInWithFirebase`, `resolveActor` — the functions that *produce* an actor and so cannot demand
 * one) or actor-less by design (`setPin`, which sits below the domain). These two are the first
 * credential functions that take an `Actor` and call `authorize`. Putting a gated function beside
 * the sign-in primitives that deliberately have no gate is how the next reader learns the wrong
 * rule about the file.
 *
 * ## ⛔ What was broken, and what "unlink" has to mean
 *
 * Before this, a Firebase account could be linked and never unlinked: `revokeCredential` existed in
 * the repo with **no production caller**, no screen reached it, and revoking it by hand left every
 * session it had already minted alive for up to seven days (`BROWSER_SESSION_TTL_MS`). Meanwhile the
 * unique index on `external_id` covered revoked rows, so a uid that HAD been revoked could never be
 * linked again — which made T-232's own sentence, *"ask an administrator to link it"*, advice nobody
 * could follow. Migration `0137` fixed the index; this file is the other half.
 *
 * **So unlinking does two things in one transaction, or neither**: it revokes the credential and it
 * ends that person's live sessions. A revoked row beside a live session is the same defect wearing
 * different clothes.
 */
import { sessionsRepo, accessRepo, personsRepo, type Tx } from '@shareat/db';
import { authorize, type Actor } from './authorize';
import { AuthorizationError } from './errors';

/**
 * ⛔ **The target person must belong to the actor's org, checked HERE and not only by the database.**
 *
 * `person_credentials` derives its org through the person, so RLS's `WITH CHECK` does refuse a
 * cross-org write — but bible §15.11 (DEF-210) is that no layer may be the ONLY layer, and the
 * failure mode is the argument: the policy's refusal arrives as `42501 new row violates row-level
 * security policy`, which `/admin/users`' error mapper prints to the screen verbatim. A refusal
 * nobody can act on is worse than no refusal. Same shape and the same sentence as
 * `assignRoleAsActor`'s check (`roles.ts:262`), whose wording `/does not exist in org/` the app
 * already maps to *"That person is not part of this organisation."*
 */
async function requirePersonInOrg(tx: Tx, actor: Actor, personId: string): Promise<void> {
  const target = await personsRepo.getPersonById(tx, actor.orgId, personId);
  if (!target) {
    throw new AuthorizationError(
      `person ${personId} does not exist in org ${actor.orgId}`,
      'manage_users',
    );
  }
}

/**
 * A Firebase uid, as far as this system can tell without asking Firebase.
 *
 * ⚠️ **Every rule here is about a value that would otherwise fail LATER and worse.** A uid is
 * ≤ 128 characters in Firebase and contains no whitespace; past roughly 2.7 KB the btree index
 * raises *"index row size exceeds maximum"* — a raw Postgres error on an admin screen for what is
 * always a paste accident. And rejecting `@` is §5.3's *"this is not an email address"* enforced
 * rather than merely printed: pasting the email is the mistake this field invites, and a linked
 * email-shaped uid would be a credential that silently never signs anybody in.
 *
 * ⛔ It cannot check that the uid EXISTS — that needs the Admin SDK credential this path is built to
 * avoid. These rules catch the shape, never the truth.
 */
function validUid(raw: string): string {
  const uid = raw.trim();
  if (!uid) throw new Error('Paste the Firebase uid for the account to link.');
  if (uid.includes('@')) {
    throw new Error(
      'That looks like an email address. Paste the account\'s Firebase uid from the console — the ' +
        'person still signs in with their email and password.',
    );
  }
  if (/\s/.test(uid)) {
    throw new Error('A Firebase uid contains no spaces. Copy just the uid from the console.');
  }
  if (uid.length > 128) {
    throw new Error('That is too long to be a Firebase uid (the longest is 128 characters).');
  }
  return uid;
}

export interface LinkFirebaseCredentialInput {
  /** The person the account signs in as. ⚠️ A target, never an actor — the actor is the caller. */
  readonly personId: string;
  /**
   * The Firebase **uid**, copied from the console.
   *
   * ⛔ Not an email address, and this is a decision rather than an omission. Resolving an email to
   * a uid needs `getUserByEmail`, an authenticated Admin SDK call, which would put a service-account
   * credential on the identity path that T-232 decision 2 deliberately keeps credential-free —
   * `verifyIdToken` needs only a project id. A uid is one copy-paste and costs the deployment
   * nothing.
   */
  readonly uid: string;
}

export interface UnlinkCredentialInput {
  /** ⭐ Both, on purpose. The pair is VERIFIED below: a credential id that does not belong to this
   *  person is refused, so a hand-crafted request cannot revoke one person's credential while
   *  ending another person's sessions. */
  readonly personId: string;
  readonly credentialId: string;
}

export interface UnlinkCredentialResult {
  readonly credentialId: string;
  readonly kind: 'pin' | 'firebase' | 'biometric';
  /** ⭐ Reported, never silent (bible §15.6): the screen says "signed out of 3 sessions". */
  readonly sessionsEnded: number;
}

/**
 * Links a verified-elsewhere Firebase account to a person.
 *
 * ⚠️ **This function does not verify that the uid exists in Firebase, and cannot.** Checking would
 * need the Admin SDK credential this path is built to avoid (see `uid` above). A wrong uid is
 * therefore a *typo that never signs anybody in* — visible the first time the person tries, and
 * fixed by unlinking and re-linking, which is now possible. That failure direction is the reason
 * the trade is acceptable: it cannot grant access to the wrong account, only fail to grant it.
 *
 * ⛔ **A cross-org `personId` is refused HERE and by the database, deliberately twice.** The first
 * version of this function left it to RLS alone, reasoning from `grantCapabilityAsActor`'s ruling
 * that *"one layer here is the database's, and it is the right one"*. The Opus second read was right
 * that this case is different: bible §15.11 / DEF-210 says no layer may be the ONLY layer, and the
 * policy's refusal reaches the screen as `42501 new row violates row-level security policy`, which
 * nobody can act on. See `requirePersonInOrg`.
 */
export async function linkFirebaseCredential(
  tx: Tx,
  actor: Actor,
  input: LinkFirebaseCredentialInput,
): Promise<{ credentialId: string }> {
  // ⛔ `manage_users`, not `enrol_staff`. Both can issue a way in, but `enrol_staff` is store-scoped
  // and matrix-true for a MANAGER — and an email account is not scoped to a store: it signs in to
  // the whole organisation's books. Linking one is an org-level act and gates like one.
  await authorize(tx, actor, 'manage_users', {});
  await requirePersonInOrg(tx, actor, input.personId);

  // Plain Errors: a typo in a form field is not a question of authority.
  const uid = validUid(input.uid);

  const { id } = await sessionsRepo.insertCredential(tx, {
    personId: input.personId,
    kind: 'firebase',
    externalId: uid,
  });
  return { credentialId: id };
}

/**
 * Revokes a credential **and ends that person's live sessions**, in the caller's transaction.
 *
 * ⭐ **It reuses `endAllForPerson`, which was written for this and never called.** Its own comment
 * says *"the shift-end path, and the revoke-a-credential path"*, and `'revoked'` has been in
 * `SessionEndReason` since T-138 with no writer. This is the first one — a new caller, not a second
 * way to end a session.
 *
 * ⚠️ **The blast radius is the PERSON, not the credential.** `endAllForPerson` takes no credential
 * filter, so unlinking an email account also ends a PIN session that person holds at a terminal.
 * That is the right radius for the situation this exists for — *"they have left"* or *"the account is
 * compromised"* — and narrowing it would mean a second repo function and a second meaning for
 * revocation. The screen says so in words rather than surprising anyone.
 *
 * ⚠️ **Kind-agnostic on purpose.** Nothing here is Firebase-specific: retiring a terminal PIN is the
 * same act with the same consequences, and a check for `kind === 'firebase'` would only have to be
 * removed the first time somebody needs it.
 */
export async function unlinkCredential(
  tx: Tx,
  actor: Actor,
  input: UnlinkCredentialInput,
): Promise<UnlinkCredentialResult> {
  await authorize(tx, actor, 'manage_users', {});
  await requirePersonInOrg(tx, actor, input.personId);

  /**
   * ⛔ **Taken BEFORE the guard reads, because the guard is a read-then-write.** Two administrators
   * unlinking each other's last credential at the same moment would each see *"someone else can
   * still get in"* under READ COMMITTED, and both would commit — leaving nobody. There is no single
   * row to lock: the answer is derived from `person_roles` and `person_credentials` together. So it
   * is an advisory lock — `lockFirstRun`'s approach for the same reason — keyed on the ORG rather
   * than on a fixed constant, so two organisations never wait on each other.
   */
  await accessRepo.lockOrgAccess(tx, actor.orgId);

  /**
   * ⭐ One read does two jobs: it proves the credential belongs to this person, and it counts what
   * would be left behind.
   */
  const live = await sessionsRepo.listLiveForPerson(tx, input.personId);
  const target = live.find((c) => c.id === input.credentialId);
  if (!target) {
    throw new Error('That sign-in account is not linked to this person, or it has already been unlinked.');
  }

  await refuseIfLastWayIn(tx, actor, input.personId, live.length);

  await sessionsRepo.revokeCredential(tx, target.id, actor.personId);
  const sessionsEnded = await sessionsRepo.endAllForPerson(tx, input.personId, 'revoked');

  return { credentialId: target.id, kind: target.kind, sessionsEnded };
}

/**
 * ⛔ **The one guard, and the reason it is only one.**
 *
 * Unlinking your own credential is ALLOWED. It narrows your own authority, and `roles.ts` already
 * ruled on that shape for grants: *"revoking your own grant is self-demotion: it narrows authority,
 * so it cannot escalate, and refusing it would stop someone dropping a capability they no longer
 * want to hold."* You are signed out immediately, which is honest.
 *
 * But one case is not self-demotion — it is an organisation losing its only door. If this is the
 * person's LAST live credential and they are the only person left holding an administrative role,
 * nobody can sign in at all afterwards, and the recovery is a shell on the droplet plus
 * `scripts/bootstrap-org.ts`' database posture. Everything else this function does NOT guard —
 * unlinking a non-last credential, or the last credential of a person who is not the last
 * administrator — is recoverable from the screen by somebody who is still signed in, and a guard
 * that fires on recoverable cases is one people learn to route around.
 *
 * ⚠️ It counts `super_admin` as well as `admin` (`hasOtherActiveAdminWhoCanSignIn`), because every
 * other admin-counting helper in `accessRepo` filters the literal `'admin'` and a super_admin-only
 * organisation would otherwise be refused its own unlink for no reason.
 */
async function refuseIfLastWayIn(
  tx: Tx,
  actor: Actor,
  personId: string,
  liveCredentialCount: number,
): Promise<void> {
  if (liveCredentialCount > 1) return;

  const role = await accessRepo.activeRoleForPerson(tx, personId, actor.orgId);
  if (role?.role !== 'admin' && role?.role !== 'super_admin') return;

  // ⛔ "Another way in" is a person with the ROLE **and** a live credential — not a role row. An
  // admin who cannot sign in leaves the organisation just as locked out, and the first version of
  // this guard counted them (Opus second read, T-237 §12.6).
  const someoneElse = await accessRepo.hasOtherActiveAdminWhoCanSignIn(tx, actor.orgId, personId);
  if (someoneElse) return;

  // The same shape, and the same capability, as `assignRoleAsActor`'s refusal to demote an org's
  // only admin — one lockout rule, two doors it can come through.
  throw new AuthorizationError(
    'This is the last way into this organisation. Give someone else an admin role, or issue this ' +
      'person a PIN, before unlinking it.',
    'manage_users',
  );
}
