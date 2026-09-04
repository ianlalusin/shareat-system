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
 * A real `sales_channels` row for this store, resolved by NAME (case-insensitive) — the party the
 * `1220` leg needs. §6: "1220 is the credit in every case" a wastage posts against, and 1220 is a
 * `requires_party` control account, so a wastage against a channel this store never configured
 * has nowhere to post and is refused by name rather than silently.
 */
export async function findChannelByName(
  tx: Tx,
  orgId: string,
  storeId: string,
  channel: string,
): Promise<{ id: string } | null> {
  const [row] = (await tx.execute(sql`
    select id from sales_channels
    where org_id = ${orgId} and store_id = ${storeId} and lower(name) = lower(${channel})
    limit 1
  `)) as unknown as { id: string }[];
  return row ? { id: row.id } : null;
}

