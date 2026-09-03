/**
 * Customer returns' SQL — T-179. The domain module (`packages/domain/src/trade/returns.ts`)
 * owns the rules; this file only reads rows and writes what the domain decided.
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  customerReturnLines,
  customerReturns,
  type CustomerReturnSettlement,
  type CustomerReturnStatus,
  type CustomerReturnTreatment,
} from '../../schema/customer-returns';
import type { Tx } from '../client';

/**
 * Mint the id the new return WILL have, before inserting it — same reason T-170's
 * `nextReturnId` does: the journal entry that must reference this return has to be postable
 * BEFORE the row exists, so the id is minted first and both are created with it already fixed.
 */
export async function nextReturnId(tx: Tx): Promise<string> {
  const r = await tx.execute<{ id: string }>(sql`select uuidv7() as id`);
  return String((r as unknown as { id: string }[])[0]!.id);
}

export interface ReturnLineInput {
  readonly lineNo: string;
  readonly tradeOrderLineId: string;
  readonly quantity: string;
  readonly saleable: boolean;
  readonly amount: string;
  readonly cost: string;
  readonly itemId: string;
  readonly movementId: string;
}

export interface CreateReturnInput {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly tradeOrderId: string;
  readonly customerId: string;
  readonly treatment: CustomerReturnTreatment;
  readonly returnedOn: string;
  readonly reason: string;
  readonly settlement: CustomerReturnSettlement;
  readonly journalEntryId: string;
  readonly createdBy: string;
  readonly lines: readonly ReturnLineInput[];
}

export async function createReturn(tx: Tx, input: CreateReturnInput): Promise<{ id: string }> {
  await tx.insert(customerReturns).values({
    id: input.id,
    orgId: input.orgId,
    storeId: input.storeId,
    tradeOrderId: input.tradeOrderId,
    customerId: input.customerId,
    treatment: input.treatment,
    returnedOn: input.returnedOn,
    reason: input.reason,
    settlement: input.settlement,
    journalEntryId: input.journalEntryId,
    createdBy: input.createdBy,
  });

  for (const line of input.lines) {
    await tx.insert(customerReturnLines).values({
      returnId: input.id,
      lineNo: line.lineNo,
      tradeOrderLineId: line.tradeOrderLineId,
      quantity: line.quantity,
      saleable: line.saleable,
      amount: line.amount,
      cost: line.cost,
      itemId: line.itemId,
      movementId: line.movementId,
    });
  }

  return { id: input.id };
}

export interface CustomerReturnRow {
  readonly id: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly tradeOrderId: string;
  readonly customerId: string;
  readonly treatment: CustomerReturnTreatment;
  readonly settlement: CustomerReturnSettlement;
  readonly status: CustomerReturnStatus;
  readonly journalEntryId: string;
}

export async function getReturn(tx: Tx, id: string): Promise<CustomerReturnRow | undefined> {
  const [row] = await tx
    .select({
      id: customerReturns.id,
      orgId: customerReturns.orgId,
      storeId: customerReturns.storeId,
      tradeOrderId: customerReturns.tradeOrderId,
      customerId: customerReturns.customerId,
      treatment: customerReturns.treatment,
      settlement: customerReturns.settlement,
      status: customerReturns.status,
      journalEntryId: customerReturns.journalEntryId,
    })
    .from(customerReturns)
    .where(eq(customerReturns.id, id));
  return row as CustomerReturnRow | undefined;
}

export interface ReturnLineRow {
  readonly id: string;
  readonly tradeOrderLineId: string;
  readonly quantity: string;
  readonly saleable: boolean;
  readonly amount: string;
  readonly cost: string;
  readonly itemId: string;
  readonly movementId: string;
}

export async function getReturnLines(tx: Tx, returnId: string): Promise<ReturnLineRow[]> {
  return tx
    .select({
      id: customerReturnLines.id,
      tradeOrderLineId: customerReturnLines.tradeOrderLineId,
      quantity: customerReturnLines.quantity,
      saleable: customerReturnLines.saleable,
      amount: customerReturnLines.amount,
      cost: customerReturnLines.cost,
      itemId: customerReturnLines.itemId,
      movementId: customerReturnLines.movementId,
    })
    .from(customerReturnLines)
    .where(eq(customerReturnLines.returnId, returnId));
}

/** Σ already-returned quantity for a trade order line, across every POSTED return — invariant 1's cap. */
export async function returnedQuantityForOrderLine(tx: Tx, tradeOrderLineId: string): Promise<string> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${customerReturnLines.quantity}), 0)::text` })
    .from(customerReturnLines)
    .innerJoin(customerReturns, eq(customerReturns.id, customerReturnLines.returnId))
    .where(and(eq(customerReturnLines.tradeOrderLineId, tradeOrderLineId), eq(customerReturns.status, 'posted')));
  return row?.total ?? '0';
}

export async function markVoid(tx: Tx, id: string, voidedBy: string, reason: string, at: Date): Promise<void> {
  await tx
    .update(customerReturns)
    .set({ status: 'void', voidedAt: at, voidedBy, voidReason: reason })
    .where(eq(customerReturns.id, id));
}
