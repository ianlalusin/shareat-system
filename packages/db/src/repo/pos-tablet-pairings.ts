/**
 * The only place SQL is written for `pos_tablet_pairings` (T-464, migration 0214).
 * docs/tasks/464-pos-tablet-sign-in.md.
 *
 * Every org-principal read is org-scoped explicitly as well as by RLS. Nothing here deletes: a replaced or un-paired tablet is REVOKED.
 * `findLiveByTokenHash` is the exception on purpose: it runs on the auth door BEFORE the org is known (bible row 382), so it takes no org,
 * and it is the only function here that does.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { posTabletPairings } from '../../schema/pos-tablet-pairings';
import { persons } from '../../schema/persons';

/** A pairing unused for this long stops resolving (the tablet left in a drawer goes dead on its own). */
export const PAIRING_IDLE_DAYS = 30;

export interface LivePairing {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly label: string;
}

/**
 * ⭐ The auth-door lookup (bible row 382): token hash -> the live pairing, or nothing.
 * "Live" = not revoked AND used (or paired) within the last 30 days, on the DATABASE's clock. It reads this one table and selects
 * four columns; an unknown hash, a revoked row and a stale row all return undefined.
 */
export async function findLiveByTokenHash(tx: Tx, tokenHash: string): Promise<LivePairing | undefined> {
  const [row] = await tx
    .select({ id: posTabletPairings.id, orgId: posTabletPairings.orgId, storeId: posTabletPairings.storeId, label: posTabletPairings.label })
    .from(posTabletPairings)
    .where(
      and(
        eq(posTabletPairings.cookieDigest, tokenHash),
        isNull(posTabletPairings.revokedAt),
        sql`coalesce(${posTabletPairings.lastUsedAt}, ${posTabletPairings.pairedAt}) > now() - make_interval(days => ${PAIRING_IDLE_DAYS})`,
      ),
    )
    .limit(1);
  return row;
}

export interface PairingRow extends LivePairing {
  readonly pairedBy: string;
  readonly pairedByName: string;
  readonly pairedAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokeReason: string | null;
}

const listCols = {
  id: posTabletPairings.id,
  orgId: posTabletPairings.orgId,
  storeId: posTabletPairings.storeId,
  label: posTabletPairings.label,
  pairedBy: posTabletPairings.pairedBy,
  pairedByName: persons.displayName,
  pairedAt: posTabletPairings.pairedAt,
  lastUsedAt: posTabletPairings.lastUsedAt,
  revokedAt: posTabletPairings.revokedAt,
  revokeReason: posTabletPairings.revokeReason,
};

/** The live pairing of a store, `FOR UPDATE`: pairing a new tablet reads the row it is about to revoke. */
export async function getLiveForStoreForUpdate(tx: Tx, orgId: string, storeId: string): Promise<{ id: string; label: string } | undefined> {
  const [row] = await tx
    .select({ id: posTabletPairings.id, label: posTabletPairings.label })
    .from(posTabletPairings)
    .where(and(eq(posTabletPairings.orgId, orgId), eq(posTabletPairings.storeId, storeId), isNull(posTabletPairings.revokedAt)))
    .limit(1)
    .for('update');
  return row;
}

/** One pairing by id (live or not), for the page's action to check the retyped label against the RECORD'S label. Read-only. */
export async function getById(tx: Tx, orgId: string, id: string): Promise<(LivePairing & { revokedAt: Date | null }) | undefined> {
  const [row] = await tx
    .select({
      id: posTabletPairings.id,
      orgId: posTabletPairings.orgId,
      storeId: posTabletPairings.storeId,
      label: posTabletPairings.label,
      revokedAt: posTabletPairings.revokedAt,
    })
    .from(posTabletPairings)
    .where(and(eq(posTabletPairings.orgId, orgId), eq(posTabletPairings.id, id)))
    .limit(1);
  return row;
}

export async function getByIdForUpdate(tx: Tx, orgId: string, id: string): Promise<(LivePairing & { revokedAt: Date | null }) | undefined> {
  const [row] = await tx
    .select({
      id: posTabletPairings.id,
      orgId: posTabletPairings.orgId,
      storeId: posTabletPairings.storeId,
      label: posTabletPairings.label,
      revokedAt: posTabletPairings.revokedAt,
    })
    .from(posTabletPairings)
    .where(and(eq(posTabletPairings.orgId, orgId), eq(posTabletPairings.id, id)))
    .limit(1)
    .for('update');
  return row;
}

export async function insertPairing(
  tx: Tx,
  input: { orgId: string; storeId: string; label: string; tokenHash: string; pairedBy: string },
): Promise<{ id: string }> {
  const [row] = await tx.insert(posTabletPairings).values({ orgId: input.orgId, storeId: input.storeId, label: input.label, cookieDigest: input.tokenHash, pairedBy: input.pairedBy }).returning({ id: posTabletPairings.id });
  return { id: row!.id }; // ! is safe: a successful insert .returning() always yields its row
}

export async function revoke(tx: Tx, orgId: string, id: string, revokedBy: string, reason: string): Promise<void> {
  await tx
    .update(posTabletPairings)
    .set({ revokedAt: new Date(), revokedBy, revokeReason: reason })
    .where(and(eq(posTabletPairings.orgId, orgId), eq(posTabletPairings.id, id), isNull(posTabletPairings.revokedAt)));
}

/**
 * Stamps `last_used_at` and says whether the pairing was still live. ⚠️ The UPDATE takes the row lock that un-pair and replace also take
 * (they revoke the row BEFORE ending its sessions), so a sign-in racing a revoke either commits first (and the revoke then ends its
 * session) or sees the row revoked here and must refuse — the caller calls this BEFORE `issue()` and throws on `false`.
 */
export async function touchLastUsed(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx
    .update(posTabletPairings)
    .set({ lastUsedAt: sql`now()` })
    .where(and(eq(posTabletPairings.orgId, orgId), eq(posTabletPairings.id, id), isNull(posTabletPairings.revokedAt)))
    .returning({ id: posTabletPairings.id });
  return rows.length === 1;
}

/** Live and past pairings of the given stores, newest first. */
export async function listForStores(tx: Tx, orgId: string, storeIds: readonly string[]): Promise<PairingRow[]> {
  if (storeIds.length === 0) return [];
  const rows = await tx
    .select(listCols)
    .from(posTabletPairings)
    .innerJoin(persons, eq(persons.id, posTabletPairings.pairedBy))
    .where(and(eq(posTabletPairings.orgId, orgId), sql`${posTabletPairings.storeId} in (${sql.join(storeIds.map((s) => sql`${s}::uuid`), sql`, `)})`))
    .orderBy(desc(posTabletPairings.pairedAt));
  return rows as PairingRow[];
}
