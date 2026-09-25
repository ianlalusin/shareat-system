/**
 * The only place SQL is written for credentials and sessions.
 * docs/tasks/138-identity-and-sessions.md.
 *
 * ⚠️ **`findLiveByTokenHash` is the hot path for every authenticated request**, so it is one
 * indexed lookup on a unique column and nothing more. Anything that makes it a join over roles or
 * scopes will be felt on every page.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { personCredentials, sessions } from '../../schema/sessions';
import { persons } from '../../schema/persons';
import { recordGone } from './record-gone';

export type CredentialKind = 'pin' | 'firebase' | 'biometric';
export type SessionEndReason = 'signed_out' | 'shift_end' | 'revoked' | 'superseded';

export interface CredentialRow {
  id: string;
  personId: string;
  kind: CredentialKind;
  storeId: string | null;
  secretHash: string | null;
  lookupHash: string | null;
  externalId: string | null;
  revokedAt: Date | null;
}

/**
 * ⭐ The PIN path: at most ONE row, found by its unique store-scoped lookup hash.
 *
 * This is what makes T-138 invariant 5 achievable — the caller then runs exactly one KDF compare.
 * v1's equivalent iterates bcrypt over every candidate (`matchLegacyPasscode`), which is O(n)
 * hashing per attempt and leaks timing proportional to the match's position in the list.
 *
 * Revoked credentials are excluded here rather than by the caller: a revoked credential that a
 * caller forgets to filter is a live credential.
 */
export async function findActiveCredentialByLookupHash(
  tx: Tx,
  lookupHash: string,
): Promise<CredentialRow | undefined> {
  const [row] = await tx
    .select({
      id: personCredentials.id,
      personId: personCredentials.personId,
      kind: personCredentials.kind,
      storeId: personCredentials.storeId,
      secretHash: personCredentials.secretHash,
      lookupHash: personCredentials.lookupHash,
      externalId: personCredentials.externalId,
      revokedAt: personCredentials.revokedAt,
    })
    .from(personCredentials)
    .where(and(eq(personCredentials.lookupHash, lookupHash), isNull(personCredentials.revokedAt)))
    .limit(1);
  return row;
}

/** `findActiveCredentialByExternalId`'s row, plus the ONE additional fact T-304 needs from the
 *  person it belongs to: is this a real person or a terminal's own row (option (a))? Kept as a
 *  separate, wider type rather than widening `CredentialRow` itself, because `personKind` and
 *  `personOrgId` have no meaning for the PIN path's `findActiveCredentialByLookupHash`. */
export interface ExternalCredentialRow extends CredentialRow {
  personKind: 'person' | 'terminal';
  personOrgId: string;
}

/**
 * The browser path: a Firebase uid resolves to at most one active credential.
 *
 * ⭐ T-304 — joins `persons` for `kind`/`org_id` so both `signInWithFirebase` (which must REFUSE a
 * terminal-kind person, invariant 8) and `resolveTerminalIdentity` (which requires exactly the
 * opposite) can decide from the one call, rather than each doing its own follow-up read. This is
 * the "already lookup #2 on row 194's door" the spec names — the door itself gains two columns,
 * not a second caller.
 */
export async function findActiveCredentialByExternalId(
  tx: Tx,
  externalId: string,
): Promise<ExternalCredentialRow | undefined> {
  const [row] = await tx
    .select({
      id: personCredentials.id,
      personId: personCredentials.personId,
      kind: personCredentials.kind,
      storeId: personCredentials.storeId,
      secretHash: personCredentials.secretHash,
      lookupHash: personCredentials.lookupHash,
      externalId: personCredentials.externalId,
      revokedAt: personCredentials.revokedAt,
      personKind: persons.kind,
      personOrgId: persons.orgId,
    })
    .from(personCredentials)
    .innerJoin(persons, eq(persons.id, personCredentials.personId))
    .where(and(eq(personCredentials.externalId, externalId), isNull(personCredentials.revokedAt)))
    .limit(1);
  return row as ExternalCredentialRow | undefined;
}

export interface InsertCredentialInput {
  personId: string;
  kind: CredentialKind;
  storeId?: string | null;
  secretHash?: string | null;
  lookupHash?: string | null;
  externalId?: string | null;
}

/** Live (non-revoked) credentials for one person, optionally narrowed to one store — what an
 *  "is this person able to sign in" screen needs. Mirrors `attendance-credentials.ts`'s
 *  `listLiveForEmployment` shape; a different table because a PIN and a card/fingerprint are
 *  different credential families (T-185's own comment: card and fingerprint, never a PIN). */
export async function listLiveForPerson(
  tx: Tx,
  personId: string,
  storeId?: string,
): Promise<(CredentialRow & { createdAt: Date })[]> {
  const conditions = [eq(personCredentials.personId, personId), isNull(personCredentials.revokedAt)];
  if (storeId) conditions.push(eq(personCredentials.storeId, storeId));
  const rows = await tx
    .select({
      id: personCredentials.id,
      personId: personCredentials.personId,
      kind: personCredentials.kind,
      storeId: personCredentials.storeId,
      secretHash: personCredentials.secretHash,
      lookupHash: personCredentials.lookupHash,
      externalId: personCredentials.externalId,
      revokedAt: personCredentials.revokedAt,
      createdAt: personCredentials.createdAt,
    })
    .from(personCredentials)
    .where(and(...conditions))
    .orderBy(personCredentials.createdAt);
  return rows as (CredentialRow & { createdAt: Date })[];
}

export async function insertCredential(tx: Tx, input: InsertCredentialInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(personCredentials)
    .values({
      personId: input.personId,
      kind: input.kind,
      storeId: input.storeId ?? null,
      secretHash: input.secretHash ?? null,
      lookupHash: input.lookupHash ?? null,
      externalId: input.externalId ?? null,
    })
    .returning({ id: personCredentials.id });
  return row!;
}

export interface RevokeCredentialInput {
  readonly id: string;
  /** ⚠️ `null` means *"no principal, by construction"* — see this function's comment. */
  readonly by: string | null;
  /** ⛔ Required. The table refuses a revocation without one (`person_credentials_revoke_check`). */
  readonly reason: string;
}

/**
 * Revocation is a timestamp, never a delete — a credential that once existed is part of the
 * audit trail for everything it authorised.
 *
 * ⚠️ **`by` accepts `null`, and that is a choice — T-237 / DEF-228.** `setPin` retires the
 * PIN it replaces and has no `Actor` to name: it sits below the domain beside `signInWithPin`, and
 * the administrator who clicked "issue PIN" stops at the action. NULL there means *"no principal, by
 * construction"* — the same meaning `person_roles.granted_by` NULL carries for an organisation's
 * first admin. ⛔ The alternative, naming the person themselves, would record that the staffer
 * revoked their own credential when an administrator re-issued it, and a fabricated attribution is
 * worse than an absent one because it reads as evidence.
 *
 * ⭐ **`reason` is NOT optional, and it does not follow `by` into nullability — T-239 / DEF-229.**
 * *Who* is unanswerable on the supersede path; *why* never is. A caller with no `Actor` names the
 * ACT (*"Superseded by a newly issued PIN for this store."*) exactly as `enrolFingerprint` does one
 * table over. The database enforces this, not this function — `person_credentials_revoke_check`.
 *
 * ⚠️ **An object, not four positional arguments — T-239.** `(tx, id, revokedBy, reason)` would put
 * three strings in a row, two of them nullable-looking, and that is how the wrong one gets passed
 * with a green typecheck. It also matches `attendanceCredentialsRepo.revokeCredential`'s shape.
 */
export async function revokeCredential(tx: Tx, input: RevokeCredentialInput): Promise<void> {
  const updated = await tx
    .update(personCredentials)
    .set({
      revokedAt: sql`now()`,
      revokedBy: input.by,
      revokeReason: input.reason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(personCredentials.id, input.id), isNull(personCredentials.revokedAt)))
    .returning({ id: personCredentials.id });
  if (updated.length === 0) {
    throw recordGone(`revokeCredential: credential ${input.id} does not exist or is already revoked`, 'credential');
  }
}

// -------------------------------------------------------------------------------------
// Sessions
// -------------------------------------------------------------------------------------

export interface LiveSession {
  id: string;
  personId: string;
  orgId: string;
  credentialId: string;
  credentialKind: CredentialKind;
  storeId: string | null;
  deviceId: string | null;
  issuedAt: Date;
  expiresAt: Date;
}

export interface InsertSessionInput {
  tokenHash: string;
  personId: string;
  credentialId: string;
  credentialKind: CredentialKind;
  storeId?: string | null;
  deviceId?: string | null;
  expiresAt: Date;
}

export async function insertSession(tx: Tx, input: InsertSessionInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(sessions)
    .values({
      tokenHash: input.tokenHash,
      personId: input.personId,
      credentialId: input.credentialId,
      credentialKind: input.credentialKind,
      storeId: input.storeId ?? null,
      deviceId: input.deviceId ?? null,
      expiresAt: input.expiresAt,
    })
    .returning({ id: sessions.id });
  return row!;
}

/**
 * ⭐ **The hot path.** One indexed lookup on a unique column, joined to `persons` only because
 * `orgId` lives there and every `Actor` needs it.
 *
 * ⚠️ **Liveness is decided HERE, in SQL, against the database's clock** — not by comparing to a
 * `new Date()` in the application. Two servers with drifting clocks would otherwise disagree about
 * whether a session is still valid, and the one that says yes wins.
 */
export async function findLiveByTokenHash(tx: Tx, tokenHash: string): Promise<LiveSession | undefined> {
  const [row] = await tx
    .select({
      id: sessions.id,
      personId: sessions.personId,
      orgId: persons.orgId,
      credentialId: sessions.credentialId,
      credentialKind: sessions.credentialKind,
      storeId: sessions.storeId,
      deviceId: sessions.deviceId,
      issuedAt: sessions.issuedAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(persons, eq(persons.id, sessions.personId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        isNull(sessions.endedAt),
        sql`${sessions.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return row;
}

/**
 * Ends a session, with a reason. ⚠️ Ending an already-ended session is a NO-OP rather than an
 * error: a cashier who signs out and then closes a stale tab has done nothing wrong, and turning
 * that into a failure teaches people to ignore failures.
 */
export async function endSession(tx: Tx, id: string, reason: SessionEndReason): Promise<void> {
  await tx
    .update(sessions)
    .set({ endedAt: sql`now()`, endedReason: reason })
    .where(and(eq(sessions.id, id), isNull(sessions.endedAt)));
}

/**
 * Ends every live session for a person, optionally limited to one store.
 *
 * The shift-end path, and the revoke-a-credential path. **Returns the count** so a caller can say
 * *"3 sessions ended"* rather than hoping.
 */
export async function endAllForPerson(
  tx: Tx,
  personId: string,
  reason: SessionEndReason,
  storeId?: string,
): Promise<number> {
  const filters = [eq(sessions.personId, personId), isNull(sessions.endedAt)];
  if (storeId) filters.push(eq(sessions.storeId, storeId));
  const ended = await tx
    .update(sessions)
    .set({ endedAt: sql`now()`, endedReason: reason })
    .where(and(...filters))
    .returning({ id: sessions.id });
  return ended.length;
}

/**
 * ⭐ T-304 — the lost-tablet runbook's actual remote sign-out. Unlinking a terminal credential
 * only stops FUTURE layer-1 authentication (`resolveTerminalIdentity` re-checks it on every PIN
 * submission); it does nothing to a session already live on the device, because that session
 * belongs to whichever real PERSON last entered a PIN there, not to the terminal (the terminal
 * holds no session at all — layer 1 mints none). `device_id` is the only column that carries the
 * terminal, and until now nothing filtered on it.
 *
 * ⛔ Scoped to the device ONLY, deliberately — not a person-or-device overload. Ending "every
 * session this device has ever issued" is exactly what a stolen-tablet response needs and nothing
 * broader; folding it into `endAllForPerson` would risk a caller passing both and getting a wider
 * blast radius than they asked for.
 */
/** `scripts/provision-terminal.ts` test 9 — refuses a second live terminal credential for a store
 *  that already has one, rather than silently minting two shared passwords for one tablet. */
export async function hasLiveTerminalCredentialForStore(tx: Tx, storeId: string): Promise<boolean> {
  // ⛔ Joins `persons` for `kind = 'terminal'` rather than inferring it from `storeId is not
  // null` on a `kind = 'firebase'` row — the exact proxy T-304's spec forbids, the same
  // direction the admin-form refusal is forbidden to go. An admin's own firebase credential can
  // legitimately carry a `store_id` (nothing stops one being set) and must not false-positive
  // this check into refusing to provision a real terminal for that store.
  const [row] = await tx
    .select({ id: personCredentials.id })
    .from(personCredentials)
    .innerJoin(persons, eq(persons.id, personCredentials.personId))
    .where(
      and(
        eq(personCredentials.storeId, storeId),
        eq(personCredentials.kind, 'firebase'),
        eq(persons.kind, 'terminal'),
        isNull(personCredentials.revokedAt),
      ),
    )
    .limit(1);
  return !!row;
}

export async function endAllForDevice(tx: Tx, deviceId: string, reason: SessionEndReason): Promise<number> {
  const ended = await tx
    .update(sessions)
    .set({ endedAt: sql`now()`, endedReason: reason })
    .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.endedAt)))
    .returning({ id: sessions.id });
  return ended.length;
}
