/**
 * The only place SQL is written for order/channel wastage — T-178.
 *
 * ⭐ Mirrors `trade-discrepancies.ts` (T-174) deliberately: `findById` locks `FOR UPDATE` so two
 * managers resolving the same wastage at the same moment cannot both post, and the backstop's own
 * query (`pastBackstop`) is the SAME predicate the screen's "open" list uses, just filtered by age
 * — one source of truth for what is still outstanding, never two that can disagree.
 */
import { and, asc, eq, lt, ne, or, sql } from 'drizzle-orm';
import { orderWastageAllocations, orderWastages } from '../../schema/order-wastage';
import { stores } from '../../schema/stores';
import type { Tx } from '../client';

export interface OrderWastageRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly salesDayId: string;
  /** ⭐ T-230 — the pointer. `channel` below is the name AS RECORDED, for memo and display. */
  readonly channelId: string;
  readonly channel: string;
  readonly orderRef: string | null;
  readonly typeMode: 'instant' | 'tracked';
  readonly amount: string;
  readonly reason: string;
  readonly status: 'open' | 'disputed' | 'resolved';
  readonly disposition: 'platform_paid' | 'absorbed' | 'charged' | null;
  readonly autoCharged: boolean;
  readonly settlementId: string | null;
  readonly journalEntryId: string | null;
  readonly openedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly createdBy: string;
}

export interface AllocationRow {
  readonly id: string;
  readonly wastageId: string;
  readonly personId: string;
  readonly percent: string;
}

const COLUMNS = {
  id: orderWastages.id,
  orgId: orderWastages.orgId,
  storeId: orderWastages.storeId,
  salesDayId: orderWastages.salesDayId,
  channelId: orderWastages.channelId,
  channel: orderWastages.channel,
  orderRef: orderWastages.orderRef,
  typeMode: orderWastages.typeMode,
  amount: orderWastages.amount,
  reason: orderWastages.reason,
  status: orderWastages.status,
  disposition: orderWastages.disposition,
  autoCharged: orderWastages.autoCharged,
  settlementId: orderWastages.settlementId,
  journalEntryId: orderWastages.journalEntryId,
  openedAt: orderWastages.openedAt,
  resolvedAt: orderWastages.resolvedAt,
  resolvedBy: orderWastages.resolvedBy,
  createdBy: orderWastages.createdBy,
} as const;

export interface CreateOrderWastageInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly salesDayId: string;
  readonly channelId: string;
  readonly channel: string;
  readonly orderRef: string | null;
  readonly typeMode: 'instant' | 'tracked';
  readonly amount: string;
  readonly reason: string;
  readonly createdBy: string;
}

/**
 * ⭐ ALWAYS inserts `open`, even for `instant` — the domain layer (`wastage/orders.ts`) then
 * calls `resolve()` in the SAME transaction for an instant wastage, mirroring how
 * `channel-settlements` inserts a settlement `draft` before it posts (insert -> post ->
 * mark-posted). Nothing outside the transaction ever observes the intermediate `open` row.
 */
export async function create(tx: Tx, input: CreateOrderWastageInput): Promise<{ id: string }> {
  const [row] = await tx
    .insert(orderWastages)
    .values({
      orgId: input.orgId,
      storeId: input.storeId,
      salesDayId: input.salesDayId,
      channelId: input.channelId,
      channel: input.channel,
      orderRef: input.orderRef,
      typeMode: input.typeMode,
      amount: input.amount,
      reason: input.reason,
      createdBy: input.createdBy,
    })
    .returning({ id: orderWastages.id });
  return row!;
}

export async function findById(tx: Tx, orgId: string, id: string): Promise<OrderWastageRow | null> {
  const [row] = await tx
    .select(COLUMNS)
    .from(orderWastages)
    .where(and(eq(orderWastages.orgId, orgId), eq(orderWastages.id, id)))
    .for('update');
  return (row as OrderWastageRow) ?? null;
}

export async function listAllocations(tx: Tx, wastageId: string): Promise<AllocationRow[]> {
  return tx
    .select()
    .from(orderWastageAllocations)
    .where(eq(orderWastageAllocations.wastageId, wastageId)) as unknown as Promise<AllocationRow[]>;
}

/**
 * ⭐ Replace ALL allocations for one wastage in one statement pair — never a partial edit. The
 * sum-to-100 check is a DEFERRABLE constraint trigger (migration 0126), so delete-then-insert
 * inside one transaction never sees a spurious mid-way failure.
 */
export async function replaceAllocations(
  tx: Tx,
  wastageId: string,
  allocations: { personId: string; percent: string }[],
): Promise<void> {
  await tx.delete(orderWastageAllocations).where(eq(orderWastageAllocations.wastageId, wastageId));
  if (allocations.length === 0) return;
  await tx.insert(orderWastageAllocations).values(
    allocations.map((a) => ({ wastageId, personId: a.personId, percent: a.percent })),
  );
}

export async function markDisputed(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx
    .update(orderWastages)
    .set({ status: 'disputed', updatedAt: sql`now()` })
    .where(and(eq(orderWastages.orgId, orgId), eq(orderWastages.id, id)));
}

export interface ResolveInput {
  readonly id: string;
  readonly disposition: 'platform_paid' | 'absorbed' | 'charged';
  readonly journalEntryId: string | null;
  /** ⚠️ Required — the caller (domain layer, which already read the row) decides whether this is
   *  a fresh match or the row's existing value carried forward. No self-referential SQL here. */
  readonly settlementId: string | null;
  readonly autoCharged?: boolean;
  /** `null` for the backstop's own system-triggered resolutions — nullable on the row itself. */
  readonly resolvedBy: string | null;
}

export async function resolve(tx: Tx, input: ResolveInput): Promise<void> {
  await tx
    .update(orderWastages)
    .set({
      status: 'resolved',
      disposition: input.disposition,
      journalEntryId: input.journalEntryId,
      settlementId: input.settlementId,
      autoCharged: input.autoCharged ?? false,
      resolvedAt: sql`now()`,
      resolvedBy: input.resolvedBy,
      updatedAt: sql`now()`,
    })
    .where(eq(orderWastages.id, input.id));
}

/**
 * ⭐ Invariant 6 — undo an auto-charge as a reversal plus a NEW resolution, never an edit. Puts
 * the row back to `open` with every resolution field cleared, so `resolve()` above is the only
 * path back to `resolved` — there is no separate "un-resolve" shape to drift from it.
 */
export async function reopenAfterReversal(tx: Tx, id: string): Promise<void> {
  await tx
    .update(orderWastages)
    .set({
      status: 'open',
      disposition: null,
      journalEntryId: null,
      autoCharged: false,
      resolvedAt: null,
      resolvedBy: null,
      updatedAt: sql`now()`,
    })
    .where(eq(orderWastages.id, id));
}

/**
 * ⭐ Everything the 15-day backstop must decide on, across every store in the org — invariant 4:
 * DISPUTED rows are included, uniformly with `open` ones. The clock runs from `opened_at`.
 */
export async function pastBackstop(tx: Tx, orgId: string, cutoff: Date): Promise<OrderWastageRow[]> {
  return (await tx
    .select(COLUMNS)
    .from(orderWastages)
    .where(
      and(
        eq(orderWastages.orgId, orgId),
        eq(orderWastages.typeMode, 'tracked'),
        or(eq(orderWastages.status, 'open'), eq(orderWastages.status, 'disputed')),
        lt(orderWastages.openedAt, cutoff),
      ),
    )
    .orderBy(asc(orderWastages.openedAt))) as unknown as OrderWastageRow[];
}

/** The screen's list: every unresolved tracked wastage for one store, oldest first. */
export async function listOpen(tx: Tx, orgId: string, storeId: string): Promise<OrderWastageRow[]> {
  return (await tx
    .select(COLUMNS)
    .from(orderWastages)
    .where(
      and(
        eq(orderWastages.orgId, orgId),
        eq(orderWastages.storeId, storeId),
        ne(orderWastages.status, 'resolved'),
      ),
    )
    .orderBy(asc(orderWastages.openedAt))) as unknown as OrderWastageRow[];
}

/** Recent history for one store, resolved rows included — the screen's "all" view. */
export async function listRecent(tx: Tx, orgId: string, storeId: string, limit = 100): Promise<OrderWastageRow[]> {
  return (await tx
    .select(COLUMNS)
    .from(orderWastages)
    .where(and(eq(orderWastages.orgId, orgId), eq(orderWastages.storeId, storeId)))
    .orderBy(sql`${orderWastages.openedAt} desc`)
    .limit(limit)) as unknown as OrderWastageRow[];
}

/** The store's configured Wastage Monitor, if any — invariant 2's default owner. */
export async function wastageMonitorFor(tx: Tx, orgId: string, storeId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: stores.wastageMonitorPersonId })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.id, storeId)));
  return row?.id ?? null;
}

/**
 * A real `sales_channels` row for this store, resolved by NAME (case-insensitive).
 *
 * ⭐ **T-230: this runs at CREATION, and only there.** It turns what the recorder picked into a
 * `channel_id`, and carries back the two facts creation needs — whether the channel is still
 * active, and the wastage policy the row's `type_mode` is derived from (bible §13 row 180). The
 * posting path uses `channelById`; nothing looks a channel up by name after the row exists.
 *
 * ⛔ **It does NOT filter on `is_active`, deliberately.** A wastage opened before a channel was
 * retired must still post — the `1220` leg needs that channel as its party whatever its current
 * status. Refusing a NEW wastage against a retired channel is the domain's call, at creation.
 */
export interface WastageChannelRow {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly wastageTypeMode: 'tracked' | 'instant';
}

export async function findChannelByName(
  tx: Tx,
  orgId: string,
  storeId: string,
  channel: string,
): Promise<WastageChannelRow | null> {
  const [row] = (await tx.execute(sql`
    select id, name, is_active, wastage_type_mode from sales_channels
    where org_id = ${orgId} and store_id = ${storeId}
      and lower(trim(name)) = lower(trim(${channel}))
    limit 1
  `)) as unknown as Record<string, unknown>[];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    isActive: Boolean(row.is_active),
    wastageTypeMode: String(row.wastage_type_mode) as 'tracked' | 'instant',
  };
}

/**
 * ⭐ T-230. The posting path's resolution — **by id**, so a rename cannot strand an open wastage.
 * Before T-230 `postDisposition` re-looked-up by name at posting time, which meant renaming a
 * channel left every open wastage against it unresolvable by a human AND by the 15-day backstop.
 */
export async function channelById(
  tx: Tx,
  orgId: string,
  channelId: string,
): Promise<WastageChannelRow | null> {
  const [row] = (await tx.execute(sql`
    select id, name, is_active, wastage_type_mode from sales_channels
    where org_id = ${orgId} and id = ${channelId}
    limit 1
  `)) as unknown as Record<string, unknown>[];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    isActive: Boolean(row.is_active),
    wastageTypeMode: String(row.wastage_type_mode) as 'tracked' | 'instant',
  };
}

