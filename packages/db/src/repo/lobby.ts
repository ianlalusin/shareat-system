/**
 * The only place SQL is written for the customer lobby (T-455, migration 0215): `lobby_stores`, `lobby_entries`, `lobby_entry_lines`,
 * `lobby_entry_line_options`, `lobby_birthday_requests` (the purge only) and `lobby_discount_claims` (expiry only; S7 owns the rest).
 * docs/tasks/455-customer-lobby.md.
 *
 * Every function takes the caller's transaction and an org id and filters by it explicitly as well as by RLS. No function here opens a
 * transaction, and none deletes: the nightly purge only NULLs personal columns, and an expired claim keeps its row.
 * Times are the DATABASE's clock (`now()`), never the process clock: the 5-minute POS window, the 1-hour network window, the 3-hour
 * entry life and the 24-hour purge all compare against `now()` in SQL.
 */
import { randomInt } from 'node:crypto';
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { lobbyBirthdayRequests, lobbyDiscountClaims, lobbyEntries, lobbyEntryLineOptions, lobbyEntryLines, lobbyStores } from '../../schema/lobby';
import { menuItemVariants, menuOptionValues } from '../../schema/menu';
import { stores } from '../../schema/stores';

export const LIVE_STATUSES = ['waiting', 'called'] as const;
export const CLOSED_STATUSES = ['seated', 'cancelled', 'removed', 'expired'] as const;

/** A random 4-digit booking code, 1000-9999 (never a counter, never a leading zero). */
export function randomBookingCode(): string {
  return String(randomInt(1000, 10000));
}

export interface LobbyStoreRow {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly maxLiveEntries: number;
  /** POS stamped `pos_seen_at` within the window, judged on the database clock. */
  readonly posFresh: boolean;
}

/** The store's lobby switches. `forUpdate` serialises concurrent check-ins of one store so the live cap cannot be overshot. */
export async function getLobbyStore(tx: Tx, orgId: string, storeId: string, posWindowMinutes: number, forUpdate: boolean): Promise<LobbyStoreRow | undefined> {
  const q = tx
    .select({
      enabled: lobbyStores.enabled,
      paused: lobbyStores.paused,
      maxLiveEntries: lobbyStores.maxLiveEntries,
      posFresh: sql<boolean>`coalesce(${lobbyStores.posSeenAt} > now() - make_interval(mins => ${posWindowMinutes}), false)`,
    })
    .from(lobbyStores)
    .where(and(eq(lobbyStores.orgId, orgId), eq(lobbyStores.storeId, storeId)))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  return row;
}

/** T-455 S3: a store's id from its public code (unique per org). undefined when the code names no store of this org. */
export async function getStoreIdByCode(tx: Tx, orgId: string, code: string): Promise<string | undefined> {
  const [row] = await tx.select({ id: stores.id }).from(stores).where(and(eq(stores.orgId, orgId), eq(stores.code, code))).limit(1);
  return row?.id;
}

export async function storeExists(tx: Tx, orgId: string, storeId: string): Promise<boolean> {
  const [row] = await tx.select({ id: stores.id }).from(stores).where(and(eq(stores.orgId, orgId), eq(stores.id, storeId))).limit(1);
  return row !== undefined;
}

export interface EntryRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly source: 'lobby' | 'staff';
  readonly code: string;
  readonly displayName: string | null;
  readonly partySize: number;
  readonly note: string | null;
  readonly phone: string | null;
  readonly status: 'waiting' | 'called' | 'seated' | 'cancelled' | 'removed' | 'expired';
  readonly deviceHash: string | null;
  readonly standLabel: string | null;
  readonly handoffUrl: string | null;
  /** The hand-off link is still inside its life, on the database clock. */
  readonly handoffLive: boolean;
  readonly createdAt: Date;
  readonly calledAt: Date | null;
  /** Older than `ttlHours` at read time, on the database clock. */
  readonly stale: boolean;
}

function entryCols(ttlHours: number) {
  return {
    id: lobbyEntries.id,
    orgId: lobbyEntries.orgId,
    storeId: lobbyEntries.storeId,
    source: lobbyEntries.source,
    code: lobbyEntries.code,
    displayName: lobbyEntries.displayName,
    partySize: lobbyEntries.partySize,
    note: lobbyEntries.note,
    phone: lobbyEntries.phone,
    status: lobbyEntries.status,
    deviceHash: lobbyEntries.deviceHash,
    standLabel: lobbyEntries.standLabel,
    handoffUrl: lobbyEntries.handoffUrl,
    handoffLive: sql<boolean>`coalesce(${lobbyEntries.handoffExpiresAt} > now(), false)`,
    createdAt: lobbyEntries.createdAt,
    calledAt: lobbyEntries.calledAt,
    stale: sql<boolean>`${lobbyEntries.createdAt} < now() - make_interval(hours => ${ttlHours})`,
  };
}

/** The store's LIVE entry (waiting / called) of one phone. At most one exists (partial unique index). */
export async function findLiveByDevice(tx: Tx, orgId: string, storeId: string, deviceHash: string, ttlHours: number): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select(entryCols(ttlHours))
    .from(lobbyEntries)
    .where(
      and(
        eq(lobbyEntries.orgId, orgId),
        eq(lobbyEntries.storeId, storeId),
        eq(lobbyEntries.deviceHash, deviceHash),
        inArray(lobbyEntries.status, [...LIVE_STATUSES]),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/** The phone's most recent entry at the store, live or closed (the screen shows what became of it). Locked: the hand-off link is read once. */
export async function findLatestByDevice(tx: Tx, orgId: string, storeId: string, deviceHash: string, ttlHours: number): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select(entryCols(ttlHours))
    .from(lobbyEntries)
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.storeId, storeId), eq(lobbyEntries.deviceHash, deviceHash)))
    .orderBy(sql`${lobbyEntries.createdAt} desc`, sql`${lobbyEntries.id} desc`)
    .limit(1)
    .for('update');
  return row;
}

/** A replay of this phone's own request id. Matches on the device too: another phone never receives this entry. */
export async function findByClientRequestId(tx: Tx, orgId: string, storeId: string, deviceHash: string, clientRequestId: string, ttlHours: number): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select(entryCols(ttlHours))
    .from(lobbyEntries)
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.storeId, storeId), eq(lobbyEntries.deviceHash, deviceHash), eq(lobbyEntries.clientRequestId, clientRequestId)))
    .limit(1);
  return row;
}

/** One entry of this org by id, locked for the move that follows. */
export async function getEntryForUpdate(tx: Tx, orgId: string, entryId: string, ttlHours: number): Promise<EntryRow | undefined> {
  const [row] = await tx
    .select(entryCols(ttlHours))
    .from(lobbyEntries)
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.id, entryId)))
    .limit(1)
    .for('update');
  return row;
}

/** Check-ins (any status) from one network at one store in the last `minutes`. */
export async function countFromIp(tx: Tx, orgId: string, storeId: string, ipHash: string, minutes: number): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(lobbyEntries)
    .where(
      and(
        eq(lobbyEntries.orgId, orgId),
        eq(lobbyEntries.storeId, storeId),
        eq(lobbyEntries.ipHash, ipHash),
        sql`${lobbyEntries.createdAt} > now() - make_interval(mins => ${minutes})`,
      ),
    );
  return r?.n ?? 0;
}

export async function countLive(tx: Tx, orgId: string, storeId: string): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(lobbyEntries)
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.storeId, storeId), inArray(lobbyEntries.status, [...LIVE_STATUSES])));
  return r?.n ?? 0;
}

/** How many variants of this org exist among `ids` (distinct). */
export async function countVariants(tx: Tx, orgId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(menuItemVariants)
    .where(and(eq(menuItemVariants.orgId, orgId), inArray(menuItemVariants.id, [...ids])));
  return r?.n ?? 0;
}

export async function countOptionValues(tx: Tx, orgId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(menuOptionValues)
    .where(and(eq(menuOptionValues.orgId, orgId), inArray(menuOptionValues.id, [...ids])));
  return r?.n ?? 0;
}

export interface NewEntry {
  readonly orgId: string;
  readonly storeId: string;
  readonly source: 'lobby' | 'staff';
  readonly displayName: string;
  readonly partySize: number;
  readonly note: string | null;
  readonly phone: string | null;
  readonly deviceHash: string | null;
  readonly ipHash: string | null;
  readonly clientRequestId: string | null;
  readonly actedByPersonId: string | null;
}

export type InsertResult =
  | { readonly kind: 'created'; readonly id: string; readonly code: string }
  | { readonly kind: 'exists'; readonly id: string }
  | { readonly kind: 'exhausted' }
  /** The request id is already used at this store by ANOTHER phone: refused, never answered with that phone's entry. */
  | { readonly kind: 'request_taken' };

/**
 * Insert a waiting entry, trying up to `attempts` random codes IN TOTAL. `ON CONFLICT DO NOTHING` skips a unique clash without
 * aborting the transaction (no savepoint needed, the caller's transaction stays usable). When nothing is inserted the reason is
 * looked up: the phone already holds a live entry, or the client request id was already used -> `exists` with that entry; otherwise
 * the code was taken -> try the next one. After `attempts` clashes -> `exhausted`.
 */
export async function insertEntryWithCode(tx: Tx, e: NewEntry, randomCode: () => string, attempts: number): Promise<InsertResult> {
  for (let i = 0; i < attempts; i++) {
    const code = randomCode();
    const [row] = await tx
      .insert(lobbyEntries)
      .values({
        orgId: e.orgId,
        storeId: e.storeId,
        source: e.source,
        code,
        displayName: e.displayName,
        partySize: e.partySize,
        note: e.note,
        phone: e.phone,
        status: 'waiting',
        deviceHash: e.deviceHash,
        ipHash: e.ipHash,
        clientRequestId: e.clientRequestId,
        actedByPersonId: e.actedByPersonId,
      })
      .onConflictDoNothing()
      .returning({ id: lobbyEntries.id });
    if (row) return { kind: 'created', id: row.id, code };
    if (e.deviceHash !== null) {
      const [live] = await tx
        .select({ id: lobbyEntries.id })
        .from(lobbyEntries)
        .where(and(eq(lobbyEntries.orgId, e.orgId), eq(lobbyEntries.storeId, e.storeId), eq(lobbyEntries.deviceHash, e.deviceHash), inArray(lobbyEntries.status, [...LIVE_STATUSES])))
        .limit(1);
      if (live) return { kind: 'exists', id: live.id };
    }
    if (e.clientRequestId !== null) {
      const [same] = await tx
        .select({ id: lobbyEntries.id, deviceHash: lobbyEntries.deviceHash })
        .from(lobbyEntries)
        .where(and(eq(lobbyEntries.orgId, e.orgId), eq(lobbyEntries.storeId, e.storeId), eq(lobbyEntries.clientRequestId, e.clientRequestId)))
        .limit(1);
      if (same) return same.deviceHash === e.deviceHash ? { kind: 'exists', id: same.id } : { kind: 'request_taken' };
    }
  }
  return { kind: 'exhausted' };
}

export interface NewLine {
  readonly variantId: string;
  readonly qty: number;
  readonly lineKind: 'package' | 'a_la_carte';
  readonly optionValueIds: readonly string[];
}

export async function insertLines(tx: Tx, orgId: string, entryId: string, lines: readonly NewLine[]): Promise<void> {
  for (const l of lines) {
    const [row] = await tx
      .insert(lobbyEntryLines)
      .values({ orgId, entryId, variantId: l.variantId, qty: l.qty, lineKind: l.lineKind })
      .returning({ id: lobbyEntryLines.id });
    if (!row || l.optionValueIds.length === 0) continue;
    await tx.insert(lobbyEntryLineOptions).values(l.optionValueIds.map((optionValueId) => ({ orgId, lineId: row.id, optionValueId })));
  }
}

/** Earlier live entries of the SAME store: waiting or called, created before this one (ties broken by the time-ordered id). */
export async function partiesAhead(tx: Tx, orgId: string, entryId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    select count(*)::int as n
      from lobby_entries e
      join lobby_entries me on me.org_id = e.org_id and me.store_id = e.store_id
     where me.org_id = ${orgId} and me.id = ${entryId}
       and e.status in ('waiting', 'called')
       and (e.created_at, e.id) < (me.created_at, me.id)
  `)) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** Live entries of one store, oldest first (the staff list). */
export async function listLive(tx: Tx, orgId: string, storeId: string, ttlHours: number): Promise<EntryRow[]> {
  return tx
    .select(entryCols(ttlHours))
    .from(lobbyEntries)
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.storeId, storeId), inArray(lobbyEntries.status, [...LIVE_STATUSES])))
    .orderBy(asc(lobbyEntries.createdAt), asc(lobbyEntries.id));
}

export async function markCalled(tx: Tx, orgId: string, entryId: string, personId: string): Promise<void> {
  await tx
    .update(lobbyEntries)
    .set({ status: 'called', calledAt: sql`now()`, actedByPersonId: personId })
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.id, entryId)));
}

/** waiting|called -> seated. A seated entry is closed too (the 24 h purge clock runs from `closed_at`). `joinUrl` set only when given. */
export async function markSeated(
  tx: Tx,
  orgId: string,
  entryId: string,
  a: { personId: string; sessionRef: string; standLabel: string; joinUrl: string | null; handoffHours: number },
): Promise<void> {
  await tx
    .update(lobbyEntries)
    .set({
      status: 'seated',
      sessionRef: a.sessionRef,
      standLabel: a.standLabel,
      seatedAt: sql`now()`,
      closedAt: sql`now()`,
      actedByPersonId: a.personId,
      ...(a.joinUrl === null
        ? {}
        : { handoffUrl: a.joinUrl, handoffExpiresAt: sql`now() + make_interval(hours => ${a.handoffHours})` }),
    })
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.id, entryId)));
}

/** waiting|called -> cancelled | removed | expired, with `closed_at`. `personId` is the staffer for `removed`, null otherwise. */
export async function markClosed(tx: Tx, orgId: string, entryId: string, status: 'cancelled' | 'removed' | 'expired', personId: string | null): Promise<void> {
  await tx
    .update(lobbyEntries)
    .set({ status, closedAt: sql`now()`, ...(personId === null ? {} : { actedByPersonId: personId }) })
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.id, entryId)));
}

/** Clear the one-time hand-off link and its expiry together (the pair CHECK). */
export async function clearHandoff(tx: Tx, orgId: string, entryId: string): Promise<void> {
  await tx
    .update(lobbyEntries)
    .set({ handoffUrl: null, handoffExpiresAt: null })
    .where(and(eq(lobbyEntries.orgId, orgId), eq(lobbyEntries.id, entryId)));
}

/** Every PENDING claim of one entry becomes expired; name and ID number go to NULL (the personal-data CHECK). Returns how many. */
export async function expirePendingClaimsOfEntry(tx: Tx, orgId: string, entryId: string): Promise<number> {
  const rows = await tx
    .update(lobbyDiscountClaims)
    .set({ status: 'expired', holderName: null, idNumber: null, decidedAt: sql`now()` })
    .where(and(eq(lobbyDiscountClaims.orgId, orgId), eq(lobbyDiscountClaims.entryId, entryId), eq(lobbyDiscountClaims.status, 'pending')))
    .returning({ id: lobbyDiscountClaims.id });
  return rows.length;
}

/** Live entries older than `ttlHours` -> expired (closed_at set). Returns their ids so the caller can expire their claims. */
export async function expireStaleEntries(tx: Tx, orgId: string, ttlHours: number): Promise<string[]> {
  const rows = await tx
    .update(lobbyEntries)
    .set({ status: 'expired', closedAt: sql`now()` })
    .where(
      and(
        eq(lobbyEntries.orgId, orgId),
        inArray(lobbyEntries.status, [...LIVE_STATUSES]),
        sql`${lobbyEntries.createdAt} < now() - make_interval(hours => ${ttlHours})`,
      ),
    )
    .returning({ id: lobbyEntries.id });
  return rows.map((r) => r.id);
}

/** Pending claims whose entry is closed (any age) or that are themselves older than `maxAgeHours` -> expired, name and ID NULL. */
export async function sweepStalePendingClaims(tx: Tx, orgId: string, maxAgeHours: number): Promise<number> {
  const rows = await tx
    .update(lobbyDiscountClaims)
    .set({ status: 'expired', holderName: null, idNumber: null, decidedAt: sql`now()` })
    .where(
      and(
        eq(lobbyDiscountClaims.orgId, orgId),
        eq(lobbyDiscountClaims.status, 'pending'),
        or(
          sql`${lobbyDiscountClaims.createdAt} < now() - make_interval(hours => ${maxAgeHours})`,
          sql`exists (select 1 from lobby_entries e where e.org_id = ${lobbyDiscountClaims.orgId} and e.id = ${lobbyDiscountClaims.entryId} and e.status in ('seated','cancelled','removed','expired'))`,
        ),
      ),
    )
    .returning({ id: lobbyDiscountClaims.id });
  return rows.length;
}

const closedMoreThan = (afterHours: number) =>
  sql`${lobbyEntries.closedAt} < now() - make_interval(hours => ${afterHours})`;

/**
 * The retention purge (section 4.7): on entries closed more than `afterHours` ago, the personal columns go to NULL. Rows are never
 * deleted and counts, times, codes and outcomes stay. Rows already purged are not touched again (idempotent). Returns the entries changed.
 */
export async function purgeClosedEntries(tx: Tx, orgId: string, afterHours: number): Promise<number> {
  const rows = await tx
    .update(lobbyEntries)
    .set({ displayName: null, phone: null, note: null, deviceHash: null, ipHash: null, handoffUrl: null, handoffExpiresAt: null })
    .where(
      and(
        eq(lobbyEntries.orgId, orgId),
        inArray(lobbyEntries.status, [...CLOSED_STATUSES]),
        isNotNull(lobbyEntries.closedAt),
        closedMoreThan(afterHours),
        or(
          isNotNull(lobbyEntries.displayName),
          isNotNull(lobbyEntries.phone),
          isNotNull(lobbyEntries.note),
          isNotNull(lobbyEntries.deviceHash),
          isNotNull(lobbyEntries.ipHash),
          isNotNull(lobbyEntries.handoffUrl),
          isNotNull(lobbyEntries.handoffExpiresAt),
        ),
      ),
    )
    .returning({ id: lobbyEntries.id });
  return rows.length;
}

/** The celebrant's name on the birthday requests of entries closed more than `afterHours` ago. */
export async function purgeBirthdayNames(tx: Tx, orgId: string, afterHours: number): Promise<number> {
  const rows = await tx
    .update(lobbyBirthdayRequests)
    .set({ celebrantName: null })
    .where(
      and(
        eq(lobbyBirthdayRequests.orgId, orgId),
        isNotNull(lobbyBirthdayRequests.celebrantName),
        sql`exists (select 1 from lobby_entries e where e.org_id = ${lobbyBirthdayRequests.orgId} and e.id = ${lobbyBirthdayRequests.entryId}
              and e.status in ('seated','cancelled','removed','expired') and e.closed_at < now() - make_interval(hours => ${afterHours}))`,
      ),
    )
    .returning({ id: lobbyBirthdayRequests.id });
  return rows.length;
}
