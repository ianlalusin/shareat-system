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

/** The browser path: a Firebase uid resolves to at most one active credential. */
export async function findActiveCredentialByExternalId(
  tx: Tx,
  externalId: string,
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
    .where(and(eq(personCredentials.externalId, externalId), isNull(personCredentials.revokedAt)))
    .limit(1);
  return row;
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

/** Revocation is a timestamp, never a delete — a credential that once existed is part of the
 *  audit trail for everything it authorised. */
export async function revokeCredential(tx: Tx, id: string, revokedBy: string): Promise<void> {
  const updated = await tx
    .update(personCredentials)
    .set({ revokedAt: sql`now()`, revokedBy, updatedAt: sql`now()` })
    .where(and(eq(personCredentials.id, id), isNull(personCredentials.revokedAt)))
    .returning({ id: personCredentials.id });
  if (updated.length === 0) {
    throw new Error(`revokeCredential: credential ${id} does not exist or is already revoked`);
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
