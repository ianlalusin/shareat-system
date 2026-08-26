/**
 * The only place SQL is written for money transfers. T-139.
 *
 * ⛔ **There is no `fee` column and no balance here.** The fee is `amount_out − amount_in`, and
 * what an account holds is `moneyAccountsRepo.balanceOf`, read from the ledger. Both are exposed
 * as derived reads below so no caller is ever tempted to add a column for them.
 */
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { moneyAccounts } from '../../schema/money-accounts';
import { moneyTransfers, type MoneyTransferStatus } from '../../schema/money-transfers';

export interface MoneyTransferRow {
  id: string;
  orgId: string;
  storeId: string;
  fromMoneyAccountId: string;
  toMoneyAccountId: string;
  amountOut: string;
  amountIn: string;
  feeAccountCode: string | null;
  transferDate: string;
  reference: string | null;
  notes: string | null;
  journalEntryId: string | null;
  status: MoneyTransferStatus;
  voidedOn: string | null;
  voidReason: string | null;
  createdBy: string;
  createdAt: Date;
}

/** A row with both ends resolved to names — what a list screen actually needs, in one query
 *  rather than N+1 lookups against the register. */
export interface MoneyTransferListRow extends MoneyTransferRow {
  fromName: string;
  toName: string;
  /** ⭐ DERIVED, never stored: what the movement cost. */
  fee: string;
}

const COLUMNS = {
  id: moneyTransfers.id,
  orgId: moneyTransfers.orgId,
  storeId: moneyTransfers.storeId,
  fromMoneyAccountId: moneyTransfers.fromMoneyAccountId,
  toMoneyAccountId: moneyTransfers.toMoneyAccountId,
  amountOut: moneyTransfers.amountOut,
  amountIn: moneyTransfers.amountIn,
  feeAccountCode: moneyTransfers.feeAccountCode,
  transferDate: moneyTransfers.transferDate,
  reference: moneyTransfers.reference,
  notes: moneyTransfers.notes,
  journalEntryId: moneyTransfers.journalEntryId,
  status: moneyTransfers.status,
  voidedOn: moneyTransfers.voidedOn,
  voidReason: moneyTransfers.voidReason,
  createdBy: moneyTransfers.createdBy,
  createdAt: moneyTransfers.createdAt,
} as const;

export interface InsertMoneyTransferInput {
  orgId: string;
  storeId: string;
  fromMoneyAccountId: string;
  toMoneyAccountId: string;
  amountOut: string;
  amountIn: string;
  feeAccountCode: string | null;
  transferDate: string;
  reference: string | null;
  notes: string | null;
  journalEntryId: string;
  createdBy: string;
}

export async function insertMoneyTransfer(
  tx: Tx,
  input: InsertMoneyTransferInput,
): Promise<{ id: string }> {
  const [row] = await tx.insert(moneyTransfers).values(input).returning({ id: moneyTransfers.id });
  return row!;
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<MoneyTransferRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(moneyTransfers)
    .where(and(eq(moneyTransfers.id, id), eq(moneyTransfers.orgId, orgId)))
    .limit(1);
  return row as MoneyTransferRow | undefined;
}

export interface ListMoneyTransfersFilter {
  storeId?: string;
  from?: string;
  to?: string;
  status?: MoneyTransferStatus;
  limit?: number;
}

export async function listMoneyTransfers(
  tx: Tx,
  orgId: string,
  filter: ListMoneyTransfersFilter = {},
): Promise<MoneyTransferListRow[]> {
  const fromAcct = sql`from_acct`;
  const toAcct = sql`to_acct`;
  const conditions = [eq(moneyTransfers.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(moneyTransfers.storeId, filter.storeId));
  if (filter.from) conditions.push(gte(moneyTransfers.transferDate, filter.from));
  if (filter.to) conditions.push(lte(moneyTransfers.transferDate, filter.to));
  if (filter.status) conditions.push(eq(moneyTransfers.status, filter.status));

  const rows = await tx
    .select({
      ...COLUMNS,
      fromName: sql<string>`${fromAcct}.name`,
      toName: sql<string>`${toAcct}.name`,
      // ⭐ The fee, computed in the query rather than kept in a column.
      fee: sql<string>`(${moneyTransfers.amountOut} - ${moneyTransfers.amountIn})::text`,
    })
    .from(moneyTransfers)
    .innerJoin(
      sql`${moneyAccounts} as ${fromAcct}`,
      sql`${fromAcct}.id = ${moneyTransfers.fromMoneyAccountId}`,
    )
    .innerJoin(
      sql`${moneyAccounts} as ${toAcct}`,
      sql`${toAcct}.id = ${moneyTransfers.toMoneyAccountId}`,
    )
    .where(and(...conditions))
    .orderBy(desc(moneyTransfers.transferDate), desc(moneyTransfers.createdAt))
    .limit(filter.limit ?? 200);

  return rows as MoneyTransferListRow[];
}

/**
 * Marks a transfer voided. ⛔ There is deliberately no delete — the reversal entry and the
 * original both stay in the ledger, and a row that named them must stay too.
 */
export async function markVoided(
  tx: Tx,
  orgId: string,
  id: string,
  input: { voidedOn: string; voidReason: string; voidedBy: string },
): Promise<void> {
  const updated = await tx
    .update(moneyTransfers)
    .set({ status: 'voided', ...input, updatedAt: sql`now()` })
    .where(
      and(
        eq(moneyTransfers.id, id),
        eq(moneyTransfers.orgId, orgId),
        eq(moneyTransfers.status, 'posted'),
      ),
    )
    .returning({ id: moneyTransfers.id });
  if (updated.length === 0) {
    throw new Error(
      `markVoided: money transfer ${id} does not exist in org ${orgId}, or is already voided`,
    );
  }
}
