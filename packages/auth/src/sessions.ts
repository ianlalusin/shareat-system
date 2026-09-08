/**
 * signInWithPin · signInWithFirebase · resolveActor · signOut · endShift.
 * docs/tasks/138-identity-and-sessions.md, bible §7.1.
 *
 * ## ⭐ `resolveActor` is the point of the whole task
 *
 * §7.1, binding: *"Acting identity is read from that token, server-side. **No server action ever
 * accepts an actor identity as a parameter.**"* Everything above this line takes a token and
 * returns an `Actor`; nothing takes a `personId` and believes it.
 *
 * Until this existed, T-122's approve and T-123's verify gated on a person the browser named —
 * so *"the person who submits should not be the one who verifies"* was theatre. **This is what
 * makes those two controls real**, and neither module changes to benefit.
 */
import type { Tx } from '@shareat/db';
import { sessionsRepo, transaction } from '@shareat/db';
import type { Actor } from './authorize';
import { AuthenticationError } from './errors';
import {
  hashPin,
  hashesMatch,
  isValidPinFormat,
  newSessionToken,
  pinLookupHash,
  sessionTokenHash,
  verifyPin,
} from './credentials';

/** A terminal is shared and physical, so its session is short. Ian: it ends on a TTL **and** at
 *  shift end — the timer is for the terminal nobody signed out of. */
export const PIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A browser session belongs to one person on one machine, so it can be longer. */
export const BROWSER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** ⚠️ Re-exported, not declared: it moved to the dependency-free `./errors` leaf so a unit test can
 *  import it without pulling `@shareat/db` through this file. Every existing importer is unchanged. */
export { AuthenticationError };

export interface SignInResult {
  /** ⚠️ Returned ONCE and never stored. Only its hash reaches the database. */
  token: string;
  sessionId: string;
  personId: string;
  expiresAt: Date;
}

// -------------------------------------------------------------------------------------
// Sign in
// -------------------------------------------------------------------------------------

/**
 * The shared-terminal path: a 6-digit PIN, scoped to one store.
 *
 * ⚠️ **Every failure returns the SAME message.** "No such PIN" and "wrong PIN" are the same
 * sentence to the caller, because distinguishing them tells an attacker which half to keep
 * guessing. The distinction is worth having in a server log, and nowhere else.
 *
 * ⭐ **Exactly one KDF compare runs**, because the store-scoped lookup hash narrows to at most one
 * row first (T-138 invariant 5). v1 iterates bcrypt over every candidate.
 */
export async function signInWithPin(
  tx: Tx | null,
  input: { storeId: string; pin: string; deviceId?: string },
): Promise<SignInResult> {
  if (tx) return runPinSignIn(tx, input);
  return transaction((trx) => runPinSignIn(trx, input));
}

const BAD_PIN = 'Sign-in failed: that PIN is not valid for this store.';

async function runPinSignIn(
  tx: Tx,
  input: { storeId: string; pin: string; deviceId?: string },
): Promise<SignInResult> {
  if (!isValidPinFormat(input.pin)) {
    // Rejected before the KDF, so a malformed value never costs work — and so "0" and "000000"
    // can never be the same credential.
    throw new AuthenticationError(BAD_PIN);
  }

  const credential = await sessionsRepo.findActiveCredentialByLookupHash(
    tx,
    pinLookupHash(input.storeId, input.pin),
  );

  // ⚠️ Both branches say the same thing. The shape of the check is deliberately flat.
  if (!credential || credential.kind !== 'pin' || !credential.secretHash) {
    throw new AuthenticationError(BAD_PIN);
  }
  if (credential.storeId !== input.storeId) {
    // The lookup hash is store-scoped, so this should be unreachable — which is exactly why it is
    // checked. A credential resolving to the wrong store means the hashing changed underneath us.
    throw new AuthenticationError(BAD_PIN);
  }
  if (!(await verifyPin(input.pin, credential.secretHash))) {
    throw new AuthenticationError(BAD_PIN);
  }

  return issue(tx, {
    personId: credential.personId,
    credentialId: credential.id,
    credentialKind: 'pin',
    storeId: input.storeId,
    deviceId: input.deviceId ?? null,
    ttlMs: PIN_SESSION_TTL_MS,
  });
}

/**
 * The browser path. **The Firebase ID token is verified by the CALLER**, which then passes the
 * verified uid here — this module never takes an unverified assertion.
 *
 * ⚠️ An unknown uid fails rather than auto-provisioning a person. **A login is not an
 * introduction**: someone with a Firebase account but no person row has not been given access to
 * anything, and creating one silently would be exactly that.
 */
export async function signInWithFirebase(
  tx: Tx | null,
  input: { verifiedUid: string },
): Promise<SignInResult> {
  if (tx) return runFirebaseSignIn(tx, input);
  return transaction((trx) => runFirebaseSignIn(trx, input));
}

async function runFirebaseSignIn(tx: Tx, input: { verifiedUid: string }): Promise<SignInResult> {
  const credential = await sessionsRepo.findActiveCredentialByExternalId(tx, input.verifiedUid);
  if (!credential || credential.kind !== 'firebase') {
    throw new AuthenticationError('Sign-in failed: this account is not linked to a person in this system.');
  }
  return issue(tx, {
    personId: credential.personId,
    credentialId: credential.id,
    credentialKind: 'firebase',
    storeId: null,
    deviceId: null,
    ttlMs: BROWSER_SESSION_TTL_MS,
  });
}

async function issue(
  tx: Tx,
  input: {
    personId: string;
    credentialId: string;
    credentialKind: 'pin' | 'firebase' | 'biometric';
    storeId: string | null;
    deviceId: string | null;
    ttlMs: number;
  },
): Promise<SignInResult> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const { id } = await sessionsRepo.insertSession(tx, {
    tokenHash: sessionTokenHash(token),
    personId: input.personId,
    credentialId: input.credentialId,
    credentialKind: input.credentialKind,
    storeId: input.storeId,
    deviceId: input.deviceId,
    expiresAt,
  });
  return { token, sessionId: id, personId: input.personId, expiresAt };
}

// -------------------------------------------------------------------------------------
// Resolve
// -------------------------------------------------------------------------------------

export interface ResolvedSession {
  actor: Actor;
  sessionId: string;
  credentialKind: 'pin' | 'firebase' | 'biometric';
  /** The store a TERMINAL session is bound to. Null for a browser session, which is not. */
  storeId: string | null;
  expiresAt: Date;
}

/**
 * ⭐ **Token in, `Actor` out. The only way an `Actor` is ever produced.**
 *
 * ⚠️ Throws rather than returning null, and the message says **re-authenticate** — ported from
 * v1's own hard-won position: *"a missing cookie now means re-authenticate, not 'trust me'."*
 * An expired session and an absent one are the same answer, because they need the same action.
 */
export async function resolveActor(tx: Tx | null, token: string): Promise<ResolvedSession> {
  if (tx) return runResolve(tx, token);
  return transaction((trx) => runResolve(trx, token));
}

const NO_SESSION = 'Not signed in, or the session has expired. Please sign in again.';

async function runResolve(tx: Tx, token: string): Promise<ResolvedSession> {
  if (!token || token.length < 16) throw new AuthenticationError(NO_SESSION);

  const hash = sessionTokenHash(token);
  const live = await sessionsRepo.findLiveByTokenHash(tx, hash);
  if (!live) throw new AuthenticationError(NO_SESSION);

  // Belt and braces on top of the SQL predicate: the lookup already filtered on the DATABASE's
  // clock (never the app's — two servers with drifting clocks would otherwise disagree about
  // validity, and the one saying yes wins). This constant-time re-check guards the other half:
  // that the row we got back is for the token we asked about.
  if (!hashesMatch(hash, sessionTokenHash(token))) throw new AuthenticationError(NO_SESSION);

  return {
    actor: { personId: live.personId, orgId: live.orgId },
    sessionId: live.id,
    credentialKind: live.credentialKind,
    storeId: live.storeId,
    expiresAt: live.expiresAt,
  };
}

// -------------------------------------------------------------------------------------
// End
// -------------------------------------------------------------------------------------

/** The explicit half of Ian's "both". Idempotent — signing out twice is not an error. */
export async function signOut(tx: Tx | null, token: string): Promise<void> {
  const run = async (trx: Tx) => {
    const live = await sessionsRepo.findLiveByTokenHash(trx, sessionTokenHash(token));
    if (!live) return; // already gone, or never was
    await sessionsRepo.endSession(trx, live.id, 'signed_out');
  };
  if (tx) return run(tx);
  return transaction(run);
}

/**
 * Ends every live session a person holds at a store — the shift handover.
 *
 * ⭐ **Why this exists separately from a TTL:** the timer catches a terminal nobody signed out of,
 * and this closes the session **the moment responsibility actually transfers** rather than up to
 * twelve hours later. Ian asked for both, and they fail differently, which is the argument.
 */
export async function endShift(
  tx: Tx | null,
  input: { personId: string; storeId: string },
): Promise<{ ended: number }> {
  const run = async (trx: Tx) => ({
    ended: await sessionsRepo.endAllForPerson(trx, input.personId, 'shift_end', input.storeId),
  });
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Enrolment
// -------------------------------------------------------------------------------------

/**
 * Sets a person's PIN for a store.
 *
 * ⚠️ **Retires the PIN it replaces, and ends their live sessions at that store.** Both halves, or
 * *"I changed my PIN"* does not mean what the person thinks it means — and until T-237 only the
 * second half was true (**DEF-228**: the old credential stayed live and kept signing them in).
 */
export async function setPin(
  tx: Tx | null,
  input: { personId: string; storeId: string; pin: string },
): Promise<{ credentialId: string }> {
  const run = async (trx: Tx) => {
    if (!isValidPinFormat(input.pin)) {
      throw new AuthenticationError('A PIN must be exactly 6 digits.');
    }
    const lookupHash = pinLookupHash(input.storeId, input.pin);
    // ⛔ The lookup hash is UNIQUE, so a collision means someone in this store already uses this
    // PIN. Refused with a reason the person can act on — an ambiguous credential check that
    // picked the first match is how the wrong person gets attributed.
    const taken = await sessionsRepo.findActiveCredentialByLookupHash(trx, lookupHash);
    if (taken && taken.personId !== input.personId) {
      throw new AuthenticationError('That PIN is already in use at this store. Please choose another.');
    }

    /**
     * ⛔ **DEF-228 — retire the PIN this one replaces, BEFORE writing the new row.** Until T-237 this
     * function inserted a new credential and ended the person's SESSIONS ('superseded' below)
     * without ever revoking the old CREDENTIAL — so the previous PIN went on signing that person in
     * forever. The word "superseded" on the line below is what made it read correct.
     *
     * ⚠️ **Per store, and only `pin`.** A person may hold a live PIN at more than one store — the
     * lookup key is store-scoped by construction (`pinLookupHash(storeId, pin)`) precisely so the
     * same six digits at two stores are two different credentials — so re-issuing at one store must
     * leave the other alone. And a biometric credential for this store is a different credential
     * family (T-185): a new PIN does not retire a fingerprint.
     *
     * ⭐ A loop, not a single revoke, because rows written before this fix may already have left more
     * than one live PIN behind: the first re-issue after this ships cleans them up.
     *
     * ⚠️ `revokedBy` is NULL here deliberately — there is no principal at this layer to name, and
     * `revokeCredential`'s own comment says why naming the person instead would be worse.
     */
    const livePins = (await sessionsRepo.listLiveForPerson(trx, input.personId, input.storeId)).filter(
      (c) => c.kind === 'pin',
    );
    for (const previous of livePins) {
      await sessionsRepo.revokeCredential(trx, previous.id, null);
    }

    const { id } = await sessionsRepo.insertCredential(trx, {
      personId: input.personId,
      kind: 'pin',
      storeId: input.storeId,
      secretHash: await hashPin(input.pin),
      lookupHash,
    });
    await sessionsRepo.endAllForPerson(trx, input.personId, 'superseded', input.storeId);
    return { credentialId: id };
  };
  if (tx) return run(tx);
  return transaction(run);
}
