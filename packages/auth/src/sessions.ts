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
// `transaction` remains for endShift / credential supersede — NOT auth-door work: both take a
// person already resolved, and no caller passes null, so the fallback is unreached today.
import { sessionsRepo, pinAttemptsRepo, authTransaction, transaction, withOrgPrincipal } from '@shareat/db';
import { formatBusinessDateTime } from '@shareat/core/datetime';
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
/**
 * ⭐ T-303/T-304 — the throttle wraps the credential lookup; it does not share its connection.
 *
 * By the time a PIN is typed, layer 1 has already resolved the terminal's `orgId`/`storeId`
 * (`resolveTerminalIdentity`, below), so the throttle is an ORDINARY org-scoped table now —
 * checked and updated under a real `withOrgPrincipal(orgId, …)`, never the auth door. The auth
 * door stays scoped to exactly the four lookups row 194 named; folding an unrelated table's
 * reads and writes onto that same elevated connection would widen what it silently does, even
 * though nothing would fail the closed-caller-list guard by name.
 *
 * ⚠️ **Cost, said out loud rather than left to a profiler**: the throttle check is now a second
 * round trip on EVERY PIN submission, not once per sign-in — that is the price of keeping it off
 * the auth door, and it is cheap (one indexed read when not locked).
 *
 * When `tx` is already supplied (tests, or any future caller with its own open, principal'd
 * transaction) everything — throttle included — runs on that one transaction; the two-connection
 * split above only applies to the production, `tx === null` path.
 */
export async function signInWithPin(
  tx: Tx | null,
  input: { orgId: string; storeId: string; pin: string; deviceId?: string },
): Promise<SignInResult> {
  if (tx) return runPinSignInWithThrottle(tx, tx, input);

  const cooldown = await withOrgPrincipal(input.orgId, (ptx) =>
    pinAttemptsRepo.checkThrottle(ptx, input.storeId),
  );
  if (cooldown.locked) throw new AuthenticationError(cooldownMessage(cooldown.lockedUntil!));

  let result: SignInResult;
  try {
    // DEF-288: the credential lookup precedes knowing the org, so it cannot carry a principal.
    result = await authTransaction((trx) => runPinSignIn(trx, input));
  } catch (err) {
    if (err instanceof AuthenticationError) {
      // Advances identically for an unknown PIN and a wrong-person PIN — T-303 invariant 2.
      await withOrgPrincipal(input.orgId, (ptx) => pinAttemptsRepo.recordMiss(ptx, input.orgId, input.storeId));
    }
    throw err;
  }
  await withOrgPrincipal(input.orgId, (ptx) => pinAttemptsRepo.clearOnSuccess(ptx, input.storeId));
  return result;
}

/** Shared by the `tx`-supplied path: throttle and credential lookup on the same transaction. */
async function runPinSignInWithThrottle(
  throttleTx: Tx,
  credentialTx: Tx,
  input: { orgId: string; storeId: string; pin: string; deviceId?: string },
): Promise<SignInResult> {
  const cooldown = await pinAttemptsRepo.checkThrottle(throttleTx, input.storeId);
  if (cooldown.locked) throw new AuthenticationError(cooldownMessage(cooldown.lockedUntil!));
  try {
    const result = await runPinSignIn(credentialTx, input);
    await pinAttemptsRepo.clearOnSuccess(throttleTx, input.storeId);
    return result;
  } catch (err) {
    if (err instanceof AuthenticationError) {
      await pinAttemptsRepo.recordMiss(throttleTx, input.orgId, input.storeId);
    }
    throw err;
  }
}

/** T-303 §Q3.B — names the clock time rather than a duration, so nobody has to do arithmetic
 *  two minutes into a five-minute wait. Says "terminal", never "device": the counter is per
 *  STORE, so every tablet at that branch is paused together (T-303 §Q3).
 *
 * ⛔ **`formatBusinessDateTime`, never a bare `toLocale*`** — `datetime.ts`'s own §12 landmine 7
 * warning, named for exactly this call: the server runs UTC, so a raw `toLocaleTimeString` would
 * tell a Manila cashier a time eight hours off her own clock — at a shift change, precisely the
 * moment this message exists for. */
function cooldownMessage(lockedUntil: Date): string {
  const clock = formatBusinessDateTime(lockedUntil, { timeStyle: 'short' });
  return `Too many wrong PINs. This terminal is paused until ${clock}. A manager can still sign in with their own email and password.`;
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
  // DEF-288, as above.
  return authTransaction((trx) => runFirebaseSignIn(trx, input));
}

const NOT_LINKED = 'Sign-in failed: this account is not linked to a person in this system.';

async function runFirebaseSignIn(tx: Tx, input: { verifiedUid: string }): Promise<SignInResult> {
  const credential = await sessionsRepo.findActiveCredentialByExternalId(tx, input.verifiedUid);
  if (!credential || credential.kind !== 'firebase') {
    throw new AuthenticationError(NOT_LINKED);
  }
  // ⛔⛔ T-304 invariant 8 — FULL STOP, not "only when called from the admin form."
  // `signInWithFirebase` is reused for BOTH the admin email form and (before this check existed)
  // would have been reusable for a terminal's shared credential. A refusal that depended on which
  // caller invoked this function would be one convention away from being bypassed — the exact
  // hazard the spec names: a store's shared password, typed into the ordinary admin form, must
  // never yield a session. The SAME flat sentence as an unlinked account — this is not a new,
  // distinguishing message, because "you used the wrong form" is not information layer 2 needs to
  // withhold, but neither does it need advertising that terminal credentials exist at all.
  if (credential.personKind === 'terminal') {
    throw new AuthenticationError(NOT_LINKED);
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

/** T-304 §Q1 — layer 1's own flat sentence. Distinct from `NOT_LINKED`: this box is never shown
 *  to a person signing in as themselves, so there is no "wrong form" ambiguity to preserve, and
 *  a store's own name in the message would cost nothing an attacker could not already see on the
 *  sign-in screen (T-304 §Q2's store-listing removal did not make the store's EXISTENCE secret,
 *  only the pre-auth database read that used to prove it). */
const NOT_A_TERMINAL = 'Sign-in failed: this account is not registered as a store terminal.';

export interface TerminalIdentity {
  readonly orgId: string;
  readonly storeId: string;
  /** The terminal's own `persons.id` (option (a)) — stable across Firebase token refreshes, one
   *  per shared credential. Used as `sessions.device_id` when layer 2 issues the real session,
   *  and as `endAllForDevice`'s key for the lost-tablet runbook. */
  readonly deviceId: string;
}

/**
 * ⭐ T-304 layer 1 — resolves a verified Firebase uid to the store terminal it belongs to, or
 * refuses. Mints **no session** (invariant 2): a terminal has not identified a person yet, and a
 * `sessions` row asserts exactly that.
 *
 * ⛔ **Re-resolved on every PIN submission, not cached across the two steps** — orchestrator's
 * carrier ruling, 2026-09-13. A signed cookie asserting "I am the terminal at store X" would keep
 * working after the credential behind it was revoked, which breaks the lost-tablet runbook (its
 * step 2 is "unlink the terminal credential → no future layer-1 sign-in resolves"). Re-checking
 * here on every attempt is what makes that true — see `endAllForDevice` for the other half (the
 * session already live on a stolen tablet, which unlinking alone does not touch).
 *
 * Reuses `findActiveCredentialByExternalId` — the door's existing lookup #2 — rather than adding
 * a caller: the four-lookup auth door gains no fifth entry.
 */
export async function resolveTerminalIdentity(tx: Tx | null, verifiedUid: string): Promise<TerminalIdentity> {
  const run = async (trx: Tx): Promise<TerminalIdentity> => {
    const credential = await sessionsRepo.findActiveCredentialByExternalId(trx, verifiedUid);
    if (!credential || credential.kind !== 'firebase' || credential.personKind !== 'terminal') {
      throw new AuthenticationError(NOT_A_TERMINAL);
    }
    if (!credential.storeId) {
      // Unreachable by construction if `provision-terminal` is the only writer — checked anyway,
      // the same discipline `runPinSignIn`'s "should be unreachable" store check already follows.
      throw new AuthenticationError(NOT_A_TERMINAL);
    }
    return { orgId: credential.personOrgId, storeId: credential.storeId, deviceId: credential.personId };
  };
  if (tx) return run(tx);
  return authTransaction(run);
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
  // DEF-288. This one runs on EVERY authenticated request: without the auth door a tightened
  // role makes `findLiveByTokenHash` return zero rows and every request reports "Not signed in".
  return authTransaction((trx) => runResolve(trx, token));
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
    // ⛔ "Already gone, or never was" — and until DEF-288 there was a THIRD meaning this
    // could not tell apart: PRESENT BUT INVISIBLE. Read without a principal, an existing live
    // session returns zero rows and no error, so this returned here, `ended_at` was never
    // written, and sign-out reported success having done nothing. The auth door is what keeps
    // those two cases two rather than three.
    if (!live) return;
    await sessionsRepo.endSession(trx, live.id, 'signed_out');
  };
  if (tx) return run(tx);
  // DEF-288: reads the session by token hash, which is org-scoped via `persons` — same gap.
  return authTransaction(run);
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

/**
 * ⭐ T-304 — the lost-tablet runbook's actual remote sign-out. Unlinking the terminal credential
 * (revoking its `person_credentials` row) only stops FUTURE layer-1 authentication —
 * `resolveTerminalIdentity` re-checks it on every PIN submission. It does nothing to a session
 * ALREADY live on the device, because that session belongs to whichever real person last entered
 * a PIN there, not to the terminal (the terminal holds no session at all — invariant 2). This is
 * the other half: end whatever is live on the device itself, `device_id` being the only column
 * that carries it.
 */
export async function endAllForDevice(
  tx: Tx | null,
  input: { deviceId: string },
): Promise<{ ended: number }> {
  const run = async (trx: Tx) => ({
    ended: await sessionsRepo.endAllForDevice(trx, input.deviceId, 'revoked'),
  });
  if (tx) return run(tx);
  return transaction(run);
}

// -------------------------------------------------------------------------------------
// Enrolment
// -------------------------------------------------------------------------------------

/**
 * ⭐ T-239 / DEF-229 — the reason a SUPERSEDE writes, since there is no human to attribute it to.
 *
 * Exported so the assertion in `sessions.test.ts` matches the sentence the code writes rather than
 * a copy of it: a test carrying its own duplicate of this string would go on passing after somebody
 * changed one of the two.
 */
export const PIN_SUPERSEDED_REASON = 'Superseded by a newly issued PIN for this store.';

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
      await sessionsRepo.revokeCredential(trx, {
        id: previous.id,
        by: null,
        // ⭐ T-239 / DEF-229 — no principal to name, so it names the ACT. `enrolFingerprint` does
        //    the same one table over. A revocation nobody can explain is not an audit trail, and
        //    "the system did it, for this reason" is a better record than a fabricated person.
        reason: PIN_SUPERSEDED_REASON,
      });
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
