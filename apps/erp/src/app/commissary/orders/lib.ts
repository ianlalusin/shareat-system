/**
 * Server-only reads for the branch-order screens — T-172, built 2026-09-03 (DEF-136).
 *
 * ⭐ Until this file existed the eight functions T-172's contract names did not exist either, and
 * the only thing `/commissary/orders` could do was read a machine-drafted order and talk about it.
 * These helpers only read; every rule they surface lives in `packages/domain` and is enforced
 * there — the screen decides what to SHOW, never what is allowed.
 */
import { eq, inArray } from 'drizzle-orm';
import {
  commissaryRepo,
  itemsRepo,
  lowStockRepo,
  schema,
  stockLocationsRepo,
  tradeRepo,
  type TradeOrderLineRow,
  type TradeOrderRow,
} from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  BRANCH_ORDER_STAGE_LABEL,
  branchOrderStage,
  orderableCatalogue,
  type BranchOrderStage,
  type CatalogueLine,
} from '@shareat/domain';
import { toBusinessDate } from '@shareat/core/datetime';
import { listStores, withOrgPrincipal, type StoreOption } from '../../expenses/lib';
import { errorMessage as sharedErrorMessage } from '@/lib/constraint-messages';

export { peso } from '../../../lib/format';
export { listStores, withOrgPrincipal, BRANCH_ORDER_STAGE_LABEL, branchOrderStage };
export type { StoreOption, BranchOrderStage, CatalogueLine };

/** Today in Asia/Manila — never the server's UTC date. */
export function today(): string {
  return toBusinessDate();
}

/**
 * T-343 S5.1c — DEF-445/DEF-446. Both the row-5 (`roleMayNot`/S2b's `jobIsElsewhere`) and row-2
 * (`notAssignedToStore`) `AuthorizationError`s already carry a `userMessage`; this used to
 * regex-match their raw diagnostic and answer with a generic sentence of its own BEFORE
 * `sharedErrorMessage` ever got a chance to prefer the real one (S1's gate). Deleted, not
 * bypassed: `sharedErrorMessage` is the one place `userMessage` is preferred.
 * ⚠️ Here and not in an actions file: a `'use server'` module may export only async functions.
 */
export function errorMessageOf(err: unknown): string {
  return sharedErrorMessage(err);
}

/**
 * ⚠️ The stores this person may act for, read from the DATABASE — never from the form. It decides
 * which side's controls the page shows; the domain re-checks the same fact on every action.
 */
export async function actorStoreIds(actor: Actor): Promise<string[]> {
  return withOrgPrincipal(actor.orgId, async (tx) => {
    const rows = await tx
      .select({ storeId: schema.personStoreScope.storeId })
      .from(schema.personStoreScope)
      .where(eq(schema.personStoreScope.personId, actor.personId));
    return rows.map((r) => r.storeId);
  });
}

export interface CommissaryChoice {
  id: string;
  code: string;
  name: string;
  catalogue: CatalogueLine[];
  /** The one open order with this commissary, if any — the register offers it instead of a form. */
  openOrderId: string | null;
  openOrderStage: BranchOrderStage | null;
}

/** Everything the "New order" panel needs for a BRANCH store: its commissaries, each with its catalogue. */
export async function newOrderPanelData(orgId: string, branchStoreId: string): Promise<CommissaryChoice[]> {
  return withOrgPrincipal(orgId, async (tx) => {
    const commissaries = await commissaryRepo.listCommissariesFor(tx, orgId, branchStoreId);
    const out: CommissaryChoice[] = [];
    for (const c of commissaries) {
      // ⚠️ Filtered in TS because the openness predicate is `status in (draft, confirmed, dispatched)`
      // AND store = this commissary — the same predicate as the domain's `openOrderFor` and the
      // partial unique index, without taking that function's FOR UPDATE lock on a page read.
      const openRows = await tx
        .select({
          id: schema.tradeOrders.id,
          status: schema.tradeOrders.status,
          acceptedAt: schema.tradeOrders.acceptedAt,
          readyAt: schema.tradeOrders.readyAt,
          rejectedAt: schema.tradeOrders.rejectedAt,
          storeId: schema.tradeOrders.storeId,
        })
        .from(schema.tradeOrders)
        .where(eq(schema.tradeOrders.requestedByStoreId, branchStoreId));
      const openHere = openRows.find(
        (o) => o.storeId === c.id && (o.status === 'draft' || o.status === 'confirmed' || o.status === 'dispatched'),
      );
      out.push({
        id: c.id,
        code: c.code,
        name: c.name,
        catalogue: await orderableCatalogue(tx, orgId, c.id, branchStoreId),
        openOrderId: openHere?.id ?? null,
        openOrderStage: openHere ? branchOrderStage(openHere) : null,
      });
    }
    return out;
  });
}

export interface LineView extends TradeOrderLineRow {
  itemName: string;
  itemCode: string;
  roomName: string | null;
}

export interface OrderView {
  order: TradeOrderRow & { requestedByStoreId: string };
  stage: BranchOrderStage;
  lines: LineView[];
  commissary: StoreOption;
  branch: StoreOption;
  /** The commissary's active rooms — the fulfilment source-room picker. */
  rooms: { id: string; code: string; name: string; isDefault: boolean }[];
  /** What the branch may still add (draft) — this commissary's catalogue for this branch. */
  catalogue: CatalogueLine[];
  /** What the commissary may propose — every active item. */
  items: { id: string; code: string; name: string; baseUnit: string }[];
  messages: { id: string; body: string; authorId: string; createdAt: Date }[];
  authors: Map<string, string>;
  pendingCount: number;
}

export async function orderView(orgId: string, id: string): Promise<OrderView | null> {
  const stores = await listStores(orgId);
  return withOrgPrincipal(orgId, async (tx) => {
    const order = await tradeRepo.getOrderById(tx, orgId, id);
    if (!order || !order.requestedByStoreId) return null;
    const commissary = stores.find((s) => s.id === order.storeId);
    const branch = stores.find((s) => s.id === order.requestedByStoreId);
    if (!commissary || !branch) return null;

    const rawLines = await tradeRepo.linesFor(tx, orgId, order.id);
    const rooms = await stockLocationsRepo.listActiveLocations(tx, order.storeId);
    const roomName = new Map(rooms.map((r) => [r.id, r.name]));
    const lines: LineView[] = [];
    for (const l of rawLines) {
      const item = await itemsRepo.getItemById(tx, orgId, l.itemId);
      lines.push({
        ...l,
        itemName: item?.name ?? l.itemId,
        itemCode: item?.code ?? '',
        roomName: l.sourceLocationId ? (roomName.get(l.sourceLocationId) ?? null) : null,
      });
    }
    // The branch's own lines first, in the order they were added; proposals after.
    lines.sort((a, b) =>
      a.origin === b.origin ? a.createdAt.getTime() - b.createdAt.getTime() : a.origin === 'requested' ? -1 : 1,
    );

    const thread = await lowStockRepo.listMessages(tx, order.id);
    const ids = [...new Set(thread.map((m) => m.authorId))];
    const people = ids.length
      ? await tx
          .select({ id: schema.persons.id, name: schema.persons.displayName })
          .from(schema.persons)
          .where(inArray(schema.persons.id, ids))
      : [];

    const stage = branchOrderStage(order);
    return {
      order: order as OrderView['order'],
      stage,
      lines,
      commissary,
      branch,
      rooms,
      catalogue: stage === 'draft' ? await orderableCatalogue(tx, orgId, order.storeId, order.requestedByStoreId) : [],
      items:
        stage === 'accepted' || stage === 'ready'
          ? (await itemsRepo.listItems(tx, orgId)).map((i) => ({ id: i.id, code: i.code, name: i.name, baseUnit: i.baseUnit }))
          : [],
      messages: thread,
      authors: new Map(people.map((p) => [p.id, p.name])),
      pendingCount: lines.filter((l) => l.approval === 'pending').length,
    };
  });
}
