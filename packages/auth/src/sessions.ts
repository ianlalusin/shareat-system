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
import { sessionsRepo, pinAttemptsRepo, accessRepo, auditLogRepo, authzDenialCountsRepo, authTransaction, refuse, transaction, withOrgPrincipal } from '@shareat/db';
import { logger } from '@shareat/core/logger';
import { formatBusinessDateTime } from '@shareat/core/datetime';
import type { Actor } from './authorize';
import { AuthenticationError } from './errors';
import {
  enqueueFirebaseSignedIn,
  enqueuePinPaused,
  enqueuePinStoppedForDay,
  enqueueSessionEnded,
  enqueueSigninRefused,
} from './security-events';
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
 * The shared-terminal path: a 6-digit PIN which, since T-302, identifies one person across every
 * branch of one organisation.
 *
 * ⚠️ **Every failure returns the SAME message.** "No such PIN", "wrong PIN" and "a real person who
 * does not work at this branch" are one sentence to the caller, because distinguishing them tells
 * an attacker which half to keep guessing. The distinction is worth having in a server log, and
 * nowhere else.
 *
 * ⭐ **Exactly one KDF compare runs on every path**, because the org-scoped lookup hash narrows to
 * at most one row first (T-138 invariant 5) — and because the no-row path burns one against
 * `DUMMY_SCRYPT_HASH` so the two cost the same. v1 iterates bcrypt over every candidate.
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

  // ⭐ T-395 R14 / DEF-626 - charge BEFORE the lookup, in its own principal'd transaction that
  // COMMITS before `runPinSignIn` starts. The charge locks the store's throttle row, refuses if
  // stopped or paused, and otherwise writes the miss and the tier-1 increment, so attempts are
  // serialised before any scrypt runs and the guess bound is exact under a parallel burst.
  const charge = await withOrgPrincipal(input.orgId, (ptx) =>
    pinAttemptsRepo.chargeAttempt(ptx, {
      orgId: input.orgId,
      storeId: input.storeId,
      deviceId: input.deviceId ?? null,
    }),
  );
  noteRefusedCharge(null, charge, input);
  refuseIfCharged(charge);

  // ⭐ T-302 / B1 - **under a real principal, not the auth door.** This line read
  // `authTransaction((trx) => …)` under the comment *"DEF-288: the credential lookup precedes
  // knowing the org, so it cannot carry a principal."* That sentence was true of PIN-FIRST
  // sign-in and stopped being true the moment T-304 landed: `input.orgId` is a parameter,
  // resolved from the terminal's own credential by `resolveTerminalIdentity` BEFORE this runs.
  // T-304 §Q4 and its invariant 3 both say this lookup leaves the door; the move is what makes
  // that true of the code rather than only of the document.
  //
  // ⛔ **And T-302 is what makes it necessary, not merely tidy.** Once the lookup key is
  // `orgId:pin`, the org prefix inside the HMAC is the only thing keeping a PIN inside its
  // organisation - one layer, for a tenancy risk. Bible §15.11 / RULES §6 item 3: no layer may
  // be the only one. Under `withOrgPrincipal` the `person_credentials_via_person` RLS policy
  // (`p.org_id = app_current_org()`) refuses a foreign-org row independently of the hash, so a
  // key-derivation mistake cannot by itself cross a tenant boundary.
  //
  // On any failure nothing more is written: the charge already counted it.
  let result: SignInResult;
  try {
    result = await withOrgPrincipal(input.orgId, (trx) => runPinSignIn(trx, input));
  } catch (err) {
    notePauseStarted(null, charge, input);
    throw err;
  }
  await withOrgPrincipal(input.orgId, (ptx) => pinAttemptsRepo.refundOnSuccess(ptx, input.storeId, charge));
  return result;
}

/** Shared by the `tx`-supplied path: throttle and credential lookup on the same transaction. */
async function runPinSignInWithThrottle(
  throttleTx: Tx,
  credentialTx: Tx,
  input: { orgId: string; storeId: string; pin: string; deviceId?: string },
): Promise<SignInResult> {
  const charge = await pinAttemptsRepo.chargeAttempt(throttleTx, {
    orgId: input.orgId,
    storeId: input.storeId,
    deviceId: input.deviceId ?? null,
  });
  await noteRefusedCharge(throttleTx, charge, input);
  refuseIfCharged(charge);
  let result: SignInResult;
  try {
    result = await runPinSignIn(credentialTx, input);
  } catch (err) {
    await notePauseStarted(throttleTx, charge, input);
    throw err;
  }
  await pinAttemptsRepo.refundOnSuccess(throttleTx, input.storeId, charge);
  return result;
}

/** T-395 R7: tier 2's sentence. Same text whoever types and whatever was typed (no enumeration);
 *  it names the way out, as T-303 §Q3 requires. */
const STOPPED_MESSAGE =
  'PIN sign-in is stopped at this store after too many wrong PINs today. A manager can reopen it: sign in with email and password, then open Staff.';

type PinInput = { orgId: string; storeId: string; deviceId?: string };
type AnyCharge = Awaited<ReturnType<typeof pinAttemptsRepo.chargeAttempt>>;

/**
 * T-402 S2 (A6): an event lives where its charge lives. With a caller transaction (`throttleTx`) the stop is written IN it,
 * so a rollback removes the charge and the event together; with `null` the charge already committed on its own, so the
 * event goes to the outbox. The attempt that TRIPPED the daily budget writes `auth.pin_stopped_for_day`; an already-stopped
 * store writes nothing more.
 */
function noteRefusedCharge(throttleTx: null, charge: AnyCharge, input: PinInput): void;
function noteRefusedCharge(throttleTx: Tx, charge: AnyCharge, input: PinInput): Promise<void>;
function noteRefusedCharge(throttleTx: Tx | null, charge: AnyCharge, input: PinInput): Promise<void> | void {
  if (!(charge.refused === 'stopped' && charge.newlyStopped)) return throttleTx ? Promise.resolve() : undefined;
  if (!throttleTx) return enqueuePinStoppedForDay(input.orgId, input.storeId, input.deviceId ?? null);
  return auditLogRepo
    .appendSystem(throttleTx, input.orgId, {
      action: 'auth.pin_stopped_for_day',
      storeId: input.storeId,
      entityId: input.storeId,
      before: null,
      after: { storeId: input.storeId, dailyMissBudget: pinAttemptsRepo.DAILY_MISS_BUDGET },
      source: 'web',
      deviceId: input.deviceId ?? null,
    })
    .then(() => undefined);
}

/** As above for the tier-1 pause: the attempt that STARTED it, once it has failed. A paused terminal's refused attempts write nothing. */
function notePauseStarted(throttleTx: null, charge: AnyCharge, input: PinInput): void;
function notePauseStarted(throttleTx: Tx, charge: AnyCharge, input: PinInput): Promise<void>;
function notePauseStarted(throttleTx: Tx | null, charge: AnyCharge, input: PinInput): Promise<void> | void {
  if (!(charge.refused === null && charge.startedPause)) return throttleTx ? Promise.resolve() : undefined;
  if (!throttleTx) return enqueuePinPaused(input.orgId, input.storeId, input.deviceId ?? null);
  return auditLogRepo
    .appendSystem(throttleTx, input.orgId, {
      action: 'auth.pin_paused',
      storeId: input.storeId,
      entityId: input.storeId,
      before: null,
      after: {
        storeId: input.storeId,
        missThreshold: pinAttemptsRepo.MISS_THRESHOLD,
        windowSeconds: pinAttemptsRepo.MISS_WINDOW_SECONDS,
        cooldownSeconds: pinAttemptsRepo.LOCK_COOLDOWN_SECONDS,
      },
      source: 'web',
      deviceId: input.deviceId ?? null,
    })
    .then(() => undefined);
}

/** Narrows a `Charge` to the charged variant, throwing the refusal sentence otherwise. */
function refuseIfCharged(
  charge: Awaited<ReturnType<typeof pinAttemptsRepo.chargeAttempt>>,
): asserts charge is Extract<typeof charge, { refused: null }> {
  if (charge.refused === 'stopped') throw new AuthenticationError(STOPPED_MESSAGE);
  if (charge.refused === 'locked') throw new AuthenticationError(cooldownMessage(charge.until!)); // 'locked' always carries locked_until
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

/** ⭐ T-302 — one flat sentence for EVERY failure, and it no longer says "for this store", because
 *  after T-302 a PIN is not scoped to one. Unknown PIN, wrong PIN and "real person who does not
 *  work here" are the same sentence to the caller; the distinction is worth having in a server log
 *  and nowhere else. ⛔ A distinguishable "valid, but not at this branch" would be a cross-store
 *  oracle telling anyone at any terminal whether six guessed digits are live somewhere in the
 *  business — precisely the disclosure `orgId:pin` exists to close. */
const BAD_PIN = 'Sign-in failed: that PIN is not valid.';

/**
 * ⛔ T-302 §"a constant-cost failure path". A fixed, well-formed scrypt hash of nothing, burned on
 * the no-row path so that "these six digits belong to nobody" costs the same as "they belong to
 * somebody". Without it the matched path pays one scrypt and the unmatched path pays none —
 * **measured on this machine: 2.4 µs vs 35.0 ms, a flat +35 ms**, far above network jitter and
 * trivially observable from a terminal. That is a timing oracle for *"these six digits belong to
 * someone in this organisation"*, and T-302 is what makes it reachable.
 *
 * ⚠️ **Random bytes, not the hash of any PIN.** It is never compared against a real secret and
 * must never match one; its only job is to cost one KDF. A literal rather than a computed value so
 * there is no async module initialisation and no startup cost.
 *
 * ⛔ **Exported ONLY so a test can assert it is well-formed, and that is not fussiness.**
 * `verifyPin` returns `false` from four places, and three of them return **before** reaching
 * `scrypt`: a value that is not `scrypt$salt$key`, or whose key is not `SCRYPT_KEY_BYTES` long,
 * is rejected by a string check costing nothing. So a single mistyped character here would delete
 * the constant-cost property **while leaving this file looking exactly as if it had it** — the
 * failure would be invisible in review, invisible in a green suite, and observable only as the
 * timing oracle coming back. `global-pin.test.ts` asserts the KDF is actually reached.
 */
export const DUMMY_SCRYPT_HASH =
  'scrypt$25a577ac8242ebd8bb04c51179e2cf6b$6ab9126744ad6ac63983a36311508d1bf72ca0c1db82e7028de01d7b181708d2fc8f9d751bbfb12c90d9b22090239ef85bbd7baff48c05463e68cfecb69f5601';

async function runPinSignIn(
  tx: Tx,
  input: { orgId: string; storeId: string; pin: string; deviceId?: string },
): Promise<SignInResult> {
  if (!isValidPinFormat(input.pin)) {
    // Rejected before the KDF, so a malformed value never costs work — and so "0" and "000000"
    // can never be the same credential. ⚠️ Deliberately NOT constant-cost with the paths below:
    // "six digits or not" is public knowledge (`isValidPinFormat` is the rule), so the cheapness
    // here discloses nothing a reader of this file does not already have.
    throw new AuthenticationError(BAD_PIN);
  }

  // ⭐ T-302 — ORG-scoped, so the same six digits identify the same person at every branch.
  const credential = await sessionsRepo.findActiveCredentialByLookupHash(
    tx,
    pinLookupHash(input.orgId, input.pin),
  );

  // ⚠️ Both branches say the same thing. The shape of the check is deliberately flat.
  if (!credential || credential.kind !== 'pin' || !credential.secretHash) {
    await verifyPin(input.pin, DUMMY_SCRYPT_HASH);
    throw new AuthenticationError(BAD_PIN);
  }

  // ⛔ **Both of these run, always, whatever the first one answers** — that is the point, not an
  // oversight. Short-circuiting on `verified` would make "correct PIN, wrong branch" cost one more
  // indexed read than "wrong PIN", re-opening a smaller version of the oracle the dummy KDF above
  // closes. So the matched path is exactly one scrypt plus one indexed read on every outcome.
  //
  // ⚠️ **The residual, stated rather than waved at:** the matched path still pays one indexed read
  // the unmatched path does not — sub-millisecond against 35 ms of KDF, which is inside the noise
  // the dummy hash exists to hide behind. It is not closed, and closing it would mean querying
  // access rows for a person who does not exist.
  const verified = await verifyPin(input.pin, credential.secretHash);
  // ⭐ T-302 — replaces `credential.storeId !== input.storeId`. That check compared the store the
  // PIN was ISSUED at against the terminal's store; under org-scoped hashing those legitimately
  // differ every time a person works at a second branch, which is the entire feature. The correct
  // question is whether they work HERE — see `personMaySignInAtStore` for why it is employment OR
  // scope and not scope alone.
  //
  // ⚠️ `credential.storeId` survives on the row and still means something — **where this PIN was
  // last issued**, never where it works. Do not read it as the latter; nothing enforces that
  // reading any more.
  const allowed = await accessRepo.personMaySignInAtStore(tx, credential.personId, input.storeId);
  if (!verified || !allowed) {
    throw new AuthenticationError(BAD_PIN);
  }

  const signedIn = await issue(tx, {
    personId: credential.personId,
    credentialId: credential.id,
    credentialKind: 'pin',
    storeId: input.storeId,
    deviceId: input.deviceId ?? null,
    ttlMs: PIN_SESSION_TTL_MS,
  });
  // T-402 S2: a success is written in the SAME transaction as the session (it rolls back with it). Individual PIN
  // misses are not copied into audit_log: `sign_in_attempts` already is that log.
  await auditLogRepo.append(tx, input.orgId, {
    actorPersonId: signedIn.personId,
    action: 'auth.pin_signin_succeeded',
    storeId: input.storeId,
    entityId: signedIn.personId,
    before: null,
    after: { sessionId: signedIn.sessionId, credentialKind: 'pin' },
    source: 'web',
    deviceId: input.deviceId ?? null,
  });
  return signedIn;
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
  if (tx) {
    const signedIn = await runFirebaseSignIn(tx, input);
    await appendFirebaseSignIn(tx, signedIn.orgId, signedIn.result);
    return signedIn.result;
  }
  // DEF-288, as above. The success event goes to the outbox once the session has committed (A5): the auth door has no
  // org principal, so it cannot insert into the org-scoped audit_log, and the caller must never wait on or fail for it.
  const signedIn = await authTransaction((trx) => runFirebaseSignIn(trx, input));
  enqueueFirebaseSignedIn(signedIn.orgId, signedIn.result);
  return signedIn.result;
}

async function appendFirebaseSignIn(tx: Tx, orgId: string, result: SignInResult): Promise<void> {
  await auditLogRepo.append(tx, orgId, {
    actorPersonId: result.personId,
    action: 'auth.signin_succeeded',
    storeId: null,
    entityId: result.personId,
    before: null,
    after: { sessionId: result.sessionId, credentialKind: 'firebase' },
    source: 'web',
  });
}

const NOT_LINKED = 'Sign-in failed: this account is not linked to a person in this system.';

async function runFirebaseSignIn(tx: Tx, input: { verifiedUid: string }): Promise<{ result: SignInResult; orgId: string }> {
  const credential = await sessionsRepo.findActiveCredentialByExternalId(tx, input.verifiedUid);
  if (!credential) {
    // T-402 R11 / Invariant 16: an identifier that belongs to no account has no org to file an event under (a row
    // with a null org would be an unauthenticated write amplifier), so it is one logger line and nothing in audit_log.
    logger.warn({ event: 'signin.unknown_identifier' }, 'signin.unknown_identifier');
    throw new AuthenticationError(NOT_LINKED);
  }
  if (credential.kind !== 'firebase') {
    enqueueSigninRefused(credential.personOrgId, credential.personId, 'not_a_firebase_credential');
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
    enqueueSigninRefused(credential.personOrgId, credential.personId, 'terminal_credential');
    throw new AuthenticationError(NOT_LINKED);
  }
  const result = await issue(tx, {
    personId: credential.personId,
    credentialId: credential.id,
    credentialKind: 'firebase',
    storeId: null,
    deviceId: null,
    ttlMs: BROWSER_SESSION_TTL_MS,
  });
  return { result, orgId: credential.personOrgId };
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
const UNRECORDABLE = 'That change could not be recorded in the activity log, so it was not made. Please tell the developers.';

type EndedSession = { id: string; personId: string; orgId: string; credentialKind: string };

export async function signOut(tx: Tx | null, token: string): Promise<void> {
  const run = async (trx: Tx): Promise<EndedSession | undefined> => {
    const live = await sessionsRepo.findLiveByTokenHash(trx, sessionTokenHash(token));
    // ⛔ "Already gone, or never was" — and until DEF-288 there was a THIRD meaning this
    // could not tell apart: PRESENT BUT INVISIBLE. Read without a principal, an existing live
    // session returns zero rows and no error, so this returned here, `ended_at` was never
    // written, and sign-out reported success having done nothing. The auth door is what keeps
    // those two cases two rather than three.
    if (!live) return undefined;
    await sessionsRepo.endSession(trx, live.id, 'signed_out');
    return live;
  };
  // T-402 S2: one `session.ended` when a live session was actually ended (a repeat or a junk token writes nothing).
  const record = (trx: Tx, live: EndedSession) =>
    auditLogRepo.append(trx, live.orgId, {
      actorPersonId: live.personId,
      action: 'session.ended',
      storeId: null,
      entityId: live.id,
      before: null,
      after: { reason: 'signed_out', credentialKind: live.credentialKind },
      source: 'web',
    });
  if (tx) {
    const live = await run(tx);
    if (live) await record(tx, live);
    return;
  }
  // DEF-288: reads the session by token hash, which is org-scoped via `persons` — same gap.
  const live = await authTransaction(run);
  if (live) enqueueSessionEnded(live.orgId, live);
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
  const run = async (trx: Tx) => {
    const ended = await sessionsRepo.endAllForPerson(trx, input.personId, 'shift_end', input.storeId);
    if (ended > 0) {
      const orgId = await authzDenialCountsRepo.orgIdOfPerson(trx, input.personId);
      if (!orgId) throw refuse(UNRECORDABLE, UNRECORDABLE); // A4: an unrecorded change is refused, not skipped
      {
        // T-402 S2: one `session.ended` for the shift hand-over (not one per session, and never an ended_all).
        // The person is the entity id: `endAllForPerson` returns a count, not the session ids.
        await auditLogRepo.append(trx, orgId, {
          actorPersonId: input.personId,
          action: 'session.ended',
          storeId: null,
          entityId: input.personId,
          before: null,
          after: { reason: 'shift_end', atStoreId: input.storeId, ended },
          source: 'web',
        });
      }
    }
    return { ended };
  };
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
  input: { deviceId: string; /** Who revoked it, when a person did (T-402 S2); omitted, the event has no actor. */ actorPersonId?: string },
): Promise<{ ended: number }> {
  const run = async (trx: Tx) => {
    const ended = await sessionsRepo.endAllForDevice(trx, input.deviceId, 'revoked');
    if (ended > 0) {
      const orgId = await authzDenialCountsRepo.orgIdOfPerson(trx, input.deviceId);
      if (!orgId) throw refuse(UNRECORDABLE, UNRECORDABLE); // A4: an unrecorded change is refused, not skipped
      {
        // T-402 S2: one `session.ended_all` for the call (high), not one row per session.
        const after = { reason: 'revoked', deviceId: input.deviceId, ended };
        if (input.actorPersonId) {
          await auditLogRepo.append(trx, orgId, {
            actorPersonId: input.actorPersonId,
            action: 'session.ended_all',
            storeId: null,
            entityId: input.deviceId,
            before: null,
            after,
            source: 'web',
          });
        } else {
          await auditLogRepo.appendSystem(trx, orgId, {
            action: 'session.ended_all',
            storeId: null,
            entityId: input.deviceId,
            before: null,
            after,
            source: 'web',
          });
        }
      }
    }
    return { ended };
  };
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
export const PIN_SUPERSEDED_REASON = 'Superseded by a newly issued PIN.';

/**
 * Sets a person's PIN. ⭐ **Since T-302 a person has ONE PIN, for the whole organisation** — the
 * `storeId` argument says where it is being issued and is stamped on the row; it no longer scopes
 * what the PIN opens.
 *
 * ⚠️ **Retires the PIN it replaces, and ends their live sessions.** Both halves, or *"I changed my
 * PIN"* does not mean what the person thinks it means — and until T-237 only the second half was
 * true (**DEF-228**: the old credential stayed live and kept signing them in).
 *
 * ⛔⛔ **THE OPERATIONAL CONSEQUENCE, because it is not visible from this signature:** issuing a
 * PIN to someone who also works at another branch **changes their PIN at that branch too**. There
 * is one credential now, so there is one set of six digits. The caller is responsible for saying
 * so BEFORE the write — `apps/erp/src/app/staff/[employmentId]/page.tsx` does, and a confirmation
 * after the fact would not be a control.
 */
export async function setPin(
  tx: Tx | null,
  input: {
    orgId: string;
    personId: string;
    storeId: string;
    pin: string;
    /** T-402 S2: who issued it. Given, one `credential.pin_set` is written for that actor; omitted (seed scripts, first-run setup), nothing is. */
    actorPersonId?: string;
  },
): Promise<{ credentialId: string }> {
  const run = async (trx: Tx) => {
    if (!isValidPinFormat(input.pin)) {
      throw new AuthenticationError('A PIN must be exactly 6 digits.');
    }
    const lookupHash = pinLookupHash(input.orgId, input.pin);
    // ⛔ The lookup hash is UNIQUE and now ORG-scoped, so a collision means someone **in this
    // organisation** already uses this PIN — at any branch, not only this one. Refused with a
    // reason the person can act on: an ambiguous credential check that picked the first match is
    // how the wrong person gets attributed, and under a global key that misattribution would now
    // cross branches.
    const taken = await sessionsRepo.findActiveCredentialByLookupHash(trx, lookupHash);
    if (taken && taken.personId !== input.personId) {
      throw new AuthenticationError('That PIN is already in use. Please choose another.');
    }

    /**
     * ⛔ **DEF-228 — retire the PIN this one replaces, BEFORE writing the new row.** Until T-237 this
     * function inserted a new credential and ended the person's SESSIONS ('superseded' below)
     * without ever revoking the old CREDENTIAL — so the previous PIN went on signing that person in
     * forever. The word "superseded" on the line below is what made it read correct.
     *
     * ⭐ **T-302 — ORG-WIDE, and only `pin`. The `storeId` argument is deliberately NOT passed.**
     * This read was `listLiveForPerson(trx, personId, input.storeId)`, which was right while the
     * key was store-scoped: the same six digits at two stores were two different credentials, so
     * re-issuing at one had to leave the other alone. Under `pinLookupHash(orgId, pin)` they are
     * **one** credential, so a store-scoped retire would leave the person's PIN at their other
     * branch live, the insert below would hit `person_credentials_lookup_hash_unique`, and
     * `staff/actions.ts` would map 23505 to *"that PIN was just taken"* — about the person's own
     * PIN. Dropping the third argument is the whole fix.
     *
     * ⚠️ A biometric credential is a different credential family (T-185): a new PIN does not
     * retire a fingerprint. That is what the `kind === 'pin'` filter is for and it is unchanged.
     *
     * ⭐ A loop, not a single revoke, because rows written before this fix may already have left more
     * than one live PIN behind: the first re-issue after this ships cleans them up. ⭐ **Under
     * T-302 that is no longer a historical nicety — every person with PINs at two branches has
     * exactly that shape today**, and migration `0148` revokes them at deploy rather than leaving
     * the cleanup to whenever somebody happens to re-issue.
     *
     * ⚠️ `revokedBy` is NULL here deliberately — there is no principal at this layer to name, and
     * `revokeCredential`'s own comment says why naming the person instead would be worse.
     */
    const livePins = (await sessionsRepo.listLiveForPerson(trx, input.personId)).filter(
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
    // ⭐ **T-302 — ORG-WIDE too, and the spec missed this one.** Fix #2 named the retire loop's
    // `storeId` and stopped there; this line has the identical shape and the identical staleness.
    // A person now holds ONE PIN, so re-issuing it must end the sessions it could sign into
    // **everywhere**. Left store-scoped, a cashier re-issued at branch B would keep a live session
    // at branch A that was opened with the credential this call just revoked — DEF-228's own
    // lesson ("I changed my PIN" not meaning what the person thinks) reproduced one table over.
    await sessionsRepo.endAllForPerson(trx, input.personId, 'superseded');
    if (input.actorPersonId) {
      // No PIN, hash or lookup hash in the payload: only that one was set, where, and what it replaced.
      await auditLogRepo.append(trx, input.orgId, {
        actorPersonId: input.actorPersonId,
        action: 'credential.pin_set',
        storeId: null,
        entityId: input.personId,
        before: null,
        after: { credentialId: id, kind: 'pin', issuedAtStoreId: input.storeId, replacedCredentials: livePins.length },
        source: 'web',
      });
    }
    return { credentialId: id };
  };
  if (tx) return run(tx);
  return transaction(run);
}
