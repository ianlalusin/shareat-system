/**
 * The only place SQL is written for `pos_terminal_links` (T-424 S5, migration 0202).
 * docs/tasks/424-pos-v2-server-approvals.md Ruling 5.
 *
 * Every read is org-scoped explicitly as well as by RLS. Nothing here deletes: a replaced link is REVOKED (revoked_at / revoked_by).
 */
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Tx } from '../client';
import { personCredentials } from '../../schema/sessions';
import { persons } from '../../schema/persons';
import { posTerminalLinks } from '../../schema/pos-terminal-links';
import { posV1StoreLinks } from '../../schema/pos-v1';

export interface PosTerminalLinkRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly posV1StoreLinkId: string;
  readonly terminalNo: number;
  readonly deviceId: string;
  readonly terminalPersonId: string;
}

const cols = {
  id: posTerminalLinks.id,
  orgId: posTerminalLinks.orgId,
  storeId: posTerminalLinks.storeId,
  posV1StoreLinkId: posTerminalLinks.posV1StoreLinkId,
  terminalNo: posTerminalLinks.terminalNo,
  deviceId: posTerminalLinks.deviceId,
  terminalPersonId: posTerminalLinks.terminalPersonId,
};

/**
 * The ACTIVE link that answers "this device id, at this POS (Firestore) store": the store comes from a LIVE `pos_v1_store_links` row
 * for `posStoreId`, never from the device's own link row, so a device id registered at another store resolves to nothing here.
 */
export async function getActiveLinkForDevice(
  tx: Tx,
  orgId: string,
  posStoreId: string,
  deviceId: string,
): Promise<PosTerminalLinkRow | undefined> {
  const [row] = await tx
    .select(cols)
    .from(posTerminalLinks)
    .innerJoin(
      posV1StoreLinks,
      and(eq(posV1StoreLinks.orgId, posTerminalLinks.orgId), eq(posV1StoreLinks.storeId, posTerminalLinks.storeId)),
    )
    .where(
      and(
        eq(posTerminalLinks.orgId, orgId),
        eq(posV1StoreLinks.posStoreId, posStoreId),
        isNull(posV1StoreLinks.unlinkedAt),
        eq(posTerminalLinks.deviceId, deviceId),
        isNull(posTerminalLinks.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

/** The store's active link, `FOR UPDATE`: a re-provision reads the row it is about to revoke. */
export async function getActiveLinkForStoreForUpdate(tx: Tx, orgId: string, storeId: string): Promise<PosTerminalLinkRow | undefined> {
  const [row] = await tx
    .select(cols)
    .from(posTerminalLinks)
    .where(and(eq(posTerminalLinks.orgId, orgId), eq(posTerminalLinks.storeId, storeId), isNull(posTerminalLinks.revokedAt)))
    .limit(1)
    .for('update');
  return row;
}

export async function revokeLink(tx: Tx, orgId: string, linkId: string, revokedBy: string): Promise<void> {
  await tx
    .update(posTerminalLinks)
    .set({ revokedAt: new Date(), revokedBy })
    .where(and(eq(posTerminalLinks.orgId, orgId), eq(posTerminalLinks.id, linkId), isNull(posTerminalLinks.revokedAt)));
}

export interface InsertPosTerminalLinkInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly posV1StoreLinkId: string;
  readonly terminalNo: number;
  readonly deviceId: string;
  readonly terminalPersonId: string;
  readonly createdBy: string;
}

export async function insertLink(tx: Tx, input: InsertPosTerminalLinkInput): Promise<{ id: string }> {
  const [row] = await tx.insert(posTerminalLinks).values(input).returning({ id: posTerminalLinks.id });
  return { id: row!.id }; // ! is safe: a successful insert .returning() always yields its row
}

/** Whether `personId` is a terminal person (persons.kind 'terminal') with a live Firebase credential at `storeId`. */
export async function terminalIsCredentialedToStore(tx: Tx, orgId: string, personId: string, storeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: personCredentials.id })
    .from(personCredentials)
    .innerJoin(persons, eq(persons.id, personCredentials.personId))
    .where(
      and(
        eq(persons.orgId, orgId),
        eq(persons.id, personId),
        eq(persons.kind, 'terminal'),
        eq(personCredentials.kind, 'firebase'),
        eq(personCredentials.storeId, storeId),
        isNull(personCredentials.revokedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** One link by id (active or not), `FOR UPDATE`: a revoke reads the row it is about to change. */
export async function getLinkByIdForUpdate(tx: Tx, orgId: string, linkId: string): Promise<(PosTerminalLinkRow & { revokedAt: Date | null }) | undefined> {
  const [row] = await tx
    .select({ ...cols, revokedAt: posTerminalLinks.revokedAt })
    .from(posTerminalLinks)
    .where(and(eq(posTerminalLinks.orgId, orgId), eq(posTerminalLinks.id, linkId)))
    .limit(1)
    .for('update');
  return row;
}

/** The ACTIVE link of a device id in this org (any store), for the revoke script. */
export async function getActiveLinkByDevice(tx: Tx, orgId: string, deviceId: string): Promise<PosTerminalLinkRow | undefined> {
  const [row] = await tx
    .select(cols)
    .from(posTerminalLinks)
    .where(and(eq(posTerminalLinks.orgId, orgId), eq(posTerminalLinks.deviceId, deviceId), isNull(posTerminalLinks.revokedAt)))
    .limit(1);
  return row;
}

/** One tablet link as the POS tablets screen shows it (T-505): names joined in, so the page never looks a person up itself. */
export interface PosTabletLinkView {
  readonly id: string;
  readonly terminalNo: number;
  readonly deviceId: string;
  readonly terminalPersonId: string;
  readonly terminalPersonName: string;
  readonly createdAt: Date;
  readonly createdByName: string | null;
  readonly revokedAt: Date | null;
  readonly revokedByName: string | null;
}

/**
 * T-505: a store's ACTIVE tablet link (at most one, by the partial unique index) and its last `revokedLimit` revoked links, newest
 * revocation first. A read only; the authorisation gate is the caller's (the page's lib), same as every other read in this repo.
 */
export async function listForStore(
  tx: Tx,
  orgId: string,
  storeId: string,
  opts: { revokedLimit: number },
): Promise<{ active: PosTabletLinkView | null; revoked: PosTabletLinkView[] }> {
  const terminal = alias(persons, 'terminal_person');
  const creator = alias(persons, 'creator_person');
  const revoker = alias(persons, 'revoker_person');
  const select = () =>
    tx
      .select({
        id: posTerminalLinks.id,
        terminalNo: posTerminalLinks.terminalNo,
        deviceId: posTerminalLinks.deviceId,
        terminalPersonId: posTerminalLinks.terminalPersonId,
        terminalPersonName: terminal.displayName,
        createdAt: posTerminalLinks.createdAt,
        createdByName: creator.displayName,
        revokedAt: posTerminalLinks.revokedAt,
        revokedByName: revoker.displayName,
      })
      .from(posTerminalLinks)
      .innerJoin(terminal, eq(terminal.id, posTerminalLinks.terminalPersonId))
      .leftJoin(creator, eq(creator.id, posTerminalLinks.createdBy))
      .leftJoin(revoker, eq(revoker.id, posTerminalLinks.revokedBy));
  const scope = and(eq(posTerminalLinks.orgId, orgId), eq(posTerminalLinks.storeId, storeId));
  const [active] = await select().where(and(scope, isNull(posTerminalLinks.revokedAt))).limit(1);
  const revoked = await select()
    .where(and(scope, isNotNull(posTerminalLinks.revokedAt)))
    .orderBy(desc(posTerminalLinks.revokedAt), desc(posTerminalLinks.id))
    .limit(opts.revokedLimit);
  return { active: active ?? null, revoked };
}
