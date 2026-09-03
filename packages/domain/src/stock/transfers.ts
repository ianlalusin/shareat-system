/**
 * Stock transfers between two rooms of one store — T-167.
 *
 * ⭐ **Posts nothing.** A FIFO layer is per store (T-162 invariant 6), so a transfer moves
 * quantity only: two signed `stock_movements` rows, no layer consumption, no journal entry.
 * `transfer_out`/`transfer_in` are deliberately absent from `VALUE_MOVING_KINDS`.
 *
 * ⚠️ **A frozen location refuses both legs**, and that is not code here — it is
 * `stock_movements_check_not_frozen_trg` (T-169, migration 0068), the same trigger every other
 * writer to `stock_movements` already goes through. A caller that hits a frozen location sees the
 * trigger's raised exception surface as a rejected promise, same as any other DB-level refusal in
 * this codebase (bible row 104: name the statement the database rejects).
 *
 * ⚠️ **Period lock has no `postEntry` to inherit it from here** — this is the first Phase 3 module
 * with zero journal entries. `assertPeriodOpen` below is the direct equivalent, called explicitly.
 */
import { authorize, type Actor } from '@shareat/auth';
import { journalRepo, stockLedgerRepo, stockTransfersRepo, type Tx } from '@shareat/db';
import { toBusinessDate } from '@shareat/core/datetime';
import { compareQuantity, quantity, type Quantity } from './quantity';
import {
  DEFAULT_STUCK_TRANSFER_THRESHOLD_DAYS,
  validateTransferRequest,
} from './transfer-rules';

export interface TransferLineInput {
  readonly itemId: string;
  readonly quantity: Quantity;
}

export interface CreateTransferInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLineInput[];
  readonly note?: string | null;
  readonly actor: Actor;
}

export type TransferOutcome =
  | { readonly ok: true; readonly transferId: string }
  | { readonly ok: false; readonly reason: string };

async function assertPeriodOpen(tx: Tx, orgId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const businessDate = toBusinessDate();
  const period = await journalRepo.findPeriodForDate(tx, orgId, businessDate);
  if (!period) {
    return { ok: false, reason: `no fiscal period covers ${businessDate}` };
  }
  if (period.status !== 'open') {
    return {
      ok: false,
      reason: `fiscal period ${period.id} (${period.startsOn}..${period.endsOn}) is ${period.status} — cannot move stock dated ${businessDate}`,
    };
  }
  return { ok: true };
}

function negate(q: Quantity): Quantity {
  return (q.startsWith('-') ? q.slice(1) : `-${q}`) as Quantity;
}

/** ⭐ Locks and checks EVERY line before writing anything — so a shortfall on line 3 never leaves
 *  lines 1–2 half-dispatched. Same "lock, then plan, then write" shape as `consume()` (T-162). */
async function checkSufficiency(
  tx: Tx,
  storeId: string,
  fromLocationId: string,
  lines: readonly { itemId: string; quantity: string }[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (const line of lines) {
    const onHand = await stockLedgerRepo.onHandForUpdate(tx, line.itemId, fromLocationId);
    if (compareQuantity(quantity(onHand), quantity(line.quantity)) < 0) {
      return {
        ok: false,
        reason: `only ${onHand} of item ${line.itemId} is on hand at the source location — cannot move ${line.quantity}`,
      };
    }
  }
  return { ok: true };
}

/**
 * ⭐ One-step "transfer now" — room-to-room in a commissary is instantaneous. Create, dispatch and
 * receive commit in ONE transaction; `in_transit` is never persisted (invariant 4).
 */
export async function transferNow(tx: Tx, input: CreateTransferInput): Promise<TransferOutcome> {
  await authorize(tx, input.actor, 'transfer_stock', { storeId: input.storeId });

  const validation = validateTransferRequest(input);
  if (!validation.ok) return validation;

  const period = await assertPeriodOpen(tx, input.orgId);
  if (!period.ok) return period;

  const sufficiency = await checkSufficiency(tx, input.storeId, input.fromLocationId, input.lines);
  if (!sufficiency.ok) return sufficiency;

  const now = new Date();

  // ⭐ Header, movements and lines all agree on `now` from the start — `received` with its
  // dispatched/received timestamps set in this ONE insert, never a later update. The shape
  // checks (`stock_transfers_dispatched_when_in_transit_check` etc.) require the timestamp the
  // MOMENT status says `received`; there is no valid intermediate row a two-step create-then-
  // update could pass through.
  const { id: transferId } = await stockTransfersRepo.createTransfer(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    mode: 'immediate',
    status: 'received',
    dispatchedAt: now,
    dispatchedBy: input.actor.personId,
    receivedAt: now,
    receivedBy: input.actor.personId,
    note: input.note ?? null,
    createdBy: input.actor.personId,
    lines: input.lines.map((l, i) => ({ lineNo: String(i + 1), itemId: l.itemId, quantity: l.quantity })),
  });

  const lines = await stockTransfersRepo.getTransferLines(tx, transferId);

  for (const line of lines) {
    const outMovement = await stockLedgerRepo.insertMovement(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.fromLocationId,
      itemId: line.itemId,
      movedAt: now,
      quantity: negate(quantity(line.quantity)),
      kind: 'transfer_out',
      sourceType: 'stock_transfer',
      sourceId: transferId,
      createdBy: input.actor.personId,
    });
    await stockTransfersRepo.setLineOutMovement(tx, line.id, outMovement.id);

    const inMovement = await stockLedgerRepo.insertMovement(tx, {
      orgId: input.orgId,
      storeId: input.storeId,
      locationId: input.toLocationId,
      itemId: line.itemId,
      movedAt: now,
      quantity: quantity(line.quantity),
      kind: 'transfer_in',
      sourceType: 'stock_transfer',
      sourceId: transferId,
      createdBy: input.actor.personId,
    });
    await stockTransfersRepo.setLineInMovement(tx, line.id, inMovement.id);
  }

  return { ok: true, transferId };
}

/** For goods that genuinely spend time in a truck. Nothing moves until `dispatch`. */
export async function saveDraft(tx: Tx, input: CreateTransferInput): Promise<TransferOutcome> {
  await authorize(tx, input.actor, 'transfer_stock', { storeId: input.storeId });

  const validation = validateTransferRequest(input);
  if (!validation.ok) return validation;

  const { id: transferId } = await stockTransfersRepo.createTransfer(tx, {
    orgId: input.orgId,
    storeId: input.storeId,
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    mode: 'two_step',
    status: 'draft',
    note: input.note ?? null,
    createdBy: input.actor.personId,
    lines: input.lines.map((l, i) => ({ lineNo: String(i + 1), itemId: l.itemId, quantity: l.quantity })),
  });
  return { ok: true, transferId };
}

/** Writes the OUT leg and reserves the quantity at the destination. */
export async function dispatch(tx: Tx, actor: Actor, transferId: string): Promise<TransferOutcome> {
  const transfer = await stockTransfersRepo.getTransfer(tx, transferId);
  if (!transfer) return { ok: false, reason: `transfer ${transferId} does not exist` };
  await authorize(tx, actor, 'transfer_stock', { storeId: transfer.storeId });

  if (transfer.status !== 'draft') {
    return { ok: false, reason: `transfer ${transferId} is ${transfer.status}, not draft` };
  }

  const period = await assertPeriodOpen(tx, transfer.orgId);
  if (!period.ok) return period;

  const lines = await stockTransfersRepo.getTransferLines(tx, transferId);
  const sufficiency = await checkSufficiency(tx, transfer.storeId, transfer.fromLocationId, lines);
  if (!sufficiency.ok) return sufficiency;

  const now = new Date();
  for (const line of lines) {
    const movement = await stockLedgerRepo.insertMovement(tx, {
      orgId: transfer.orgId,
      storeId: transfer.storeId,
      locationId: transfer.fromLocationId,
      itemId: line.itemId,
      movedAt: now,
      quantity: negate(quantity(line.quantity)),
      kind: 'transfer_out',
      sourceType: 'stock_transfer',
      sourceId: transferId,
      createdBy: actor.personId,
    });
    await stockTransfersRepo.setLineOutMovement(tx, line.id, movement.id);
    await stockTransfersRepo.createReservation(tx, {
      orgId: transfer.orgId,
      storeId: transfer.storeId,
      locationId: transfer.toLocationId,
      itemId: line.itemId,
      quantity: line.quantity,
      transferId,
    });
  }

  await stockTransfersRepo.markDispatched(tx, transferId, actor.personId, now);
  return { ok: true, transferId };
}

/** Writes the IN leg and resolves the destination reservation. */
export async function receiveTransfer(tx: Tx, actor: Actor, transferId: string): Promise<TransferOutcome> {
  const transfer = await stockTransfersRepo.getTransfer(tx, transferId);
  if (!transfer) return { ok: false, reason: `transfer ${transferId} does not exist` };
  await authorize(tx, actor, 'transfer_stock', { storeId: transfer.storeId });

  if (transfer.status !== 'in_transit') {
    return { ok: false, reason: `transfer ${transferId} is ${transfer.status}, not in transit` };
  }

  const period = await assertPeriodOpen(tx, transfer.orgId);
  if (!period.ok) return period;

  const lines = await stockTransfersRepo.getTransferLines(tx, transferId);
  const now = new Date();

  for (const line of lines) {
    const movement = await stockLedgerRepo.insertMovement(tx, {
      orgId: transfer.orgId,
      storeId: transfer.storeId,
      locationId: transfer.toLocationId,
      itemId: line.itemId,
      movedAt: now,
      quantity: quantity(line.quantity),
      kind: 'transfer_in',
      sourceType: 'stock_transfer',
      sourceId: transferId,
      createdBy: actor.personId,
    });
    await stockTransfersRepo.setLineInMovement(tx, line.id, movement.id);
    // ⭐ Invariant 5. Resolves the reservation dispatch created; never double-releases (repo's
    // conditional UPDATE — see stock-transfers.ts).
    await stockTransfersRepo.releaseReservation(tx, transferId, line.itemId, now);
  }

  await stockTransfersRepo.markReceived(tx, transferId, actor.personId, now);
  return { ok: true, transferId };
}

/**
 * ⭐ Void reverses whatever the transfer actually did, branching on its status — never guesses,
 * never invents a leg. A `draft` has no stock effect at all. `in_transit` has an OUT leg and a
 * live reservation. `received` (two-step OR immediate) has both legs and, for two-step, an
 * ALREADY-released reservation that must not be released again (invariant 5, tested explicitly).
 */
export async function voidTransfer(
  tx: Tx,
  actor: Actor,
  transferId: string,
  reason: string,
): Promise<TransferOutcome> {
  const transfer = await stockTransfersRepo.getTransfer(tx, transferId);
  if (!transfer) return { ok: false, reason: `transfer ${transferId} does not exist` };
  await authorize(tx, actor, 'void_transfer', { storeId: transfer.storeId });

  if (transfer.status === 'void') {
    return { ok: false, reason: `transfer ${transferId} is already void` };
  }
  if (!reason.trim()) {
    return { ok: false, reason: 'a void needs a reason' };
  }

  const period = await assertPeriodOpen(tx, transfer.orgId);
  if (!period.ok) return period;

  const lines = await stockTransfersRepo.getTransferLines(tx, transferId);
  const now = new Date();

  if (transfer.status === 'in_transit' || transfer.status === 'received') {
    for (const line of lines) {
      if (line.outMovementId) {
        await stockLedgerRepo.insertMovement(tx, {
          orgId: transfer.orgId,
          storeId: transfer.storeId,
          locationId: transfer.fromLocationId,
          itemId: line.itemId,
          movedAt: now,
          quantity: quantity(line.quantity),
          kind: 'transfer_out',
          sourceType: 'stock_transfer_void',
          sourceId: transferId,
          journalEntryId: null,
          reversalOfId: line.outMovementId,
          createdBy: actor.personId,
        });
      }
      if (line.inMovementId) {
        await stockLedgerRepo.insertMovement(tx, {
          orgId: transfer.orgId,
          storeId: transfer.storeId,
          locationId: transfer.toLocationId,
          itemId: line.itemId,
          movedAt: now,
          quantity: negate(quantity(line.quantity)),
          kind: 'transfer_in',
          sourceType: 'stock_transfer_void',
          sourceId: transferId,
          journalEntryId: null,
          reversalOfId: line.inMovementId,
          createdBy: actor.personId,
        });
      }
      // ⭐ No-op when receive already resolved it (invariant 5's double-release guard). Only a
      // still-in-transit void actually releases anything here.
      await stockTransfersRepo.releaseReservation(tx, transferId, line.itemId, now);
    }
  }

  await stockTransfersRepo.markVoid(tx, transferId, actor.personId, reason.trim(), now);
  return { ok: true, transferId };
}

export interface StuckTransfer {
  readonly id: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly dispatchedAt: Date;
}

/** Per-store — v1's own default of 3 days, never a cross-store scan. */
export async function stuckTransfers(
  tx: Tx,
  storeId: string,
  thresholdDays: number = DEFAULT_STUCK_TRANSFER_THRESHOLD_DAYS,
): Promise<StuckTransfer[]> {
  const rows = await stockTransfersRepo.stuckTransfers(tx, storeId, thresholdDays);
  return rows.map((r) => ({
    id: r.id,
    fromLocationId: r.fromLocationId,
    toLocationId: r.toLocationId,
    dispatchedAt: r.dispatchedAt,
  }));
}
