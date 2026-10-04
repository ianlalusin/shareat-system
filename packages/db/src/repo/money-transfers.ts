/**
 * The only place SQL is written for money transfers. T-139.
 *
 * ⛔ **There is no `fee` column and no balance here.** The fee is `amount_out − amount_in`, and
 * what an account holds is `moneyAccountsRepo.balanceOf`, read from the ledger. Both are exposed
 * as derived reads below so no caller is ever tempted to add a column for them.
 */
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { moneyAccounts } from '../../schema/money-accounts';
import { stores } from '../../schema/stores';
import { moneyTransfers, type MoneyTransferStatus } from '../../schema/money-transfers';
import { refuse } from '../refusal';
import { recordGone } from './record-gone';
import type { Money } from '@shareat/core/money';
import type { SafeInsert } from './numeric-input';

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
  /** ⭐ T-369 S9 (DEF-557), DERIVED: this movement cleared what the source store owed the destination store - its
   *  entry DEBITS 2150 at the source. An ordinary cross-store transfer credits 2150 at the destination instead. */
  settles: boolean;
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

/** T-371 C2 — `amountOut` / `amountIn` are `Money` brands ((14,2)), minted by `decimal()`. Both are NOT NULL, no default. */
export type InsertMoneyTransferInput = Pick<
  SafeInsert<typeof moneyTransfers>,
  'orgId' | 'storeId' | 'fromMoneyAccountId' | 'toMoneyAccountId' | 'transferDate' | 'createdBy'
> & {
  amountOut: Money;
  amountIn: Money;
  feeAccountCode: string | null;
  reference: string | null;
  notes: string | null;
  journalEntryId: string;
  /** T-369 S9: a settlement's row id IS its `settlementId`, so the primary key backstops a racing double click. */
  id?: string;
};

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
      // ⭐ T-369 S9: derived from the entry's own lines, no column.
      settles: sql<boolean>`exists (
        select 1 from journal_lines jl join accounts a on a.id = jl.account_id
        where jl.entry_id = ${moneyTransfers.journalEntryId} and a.code = '2150'
          and jl.debit > 0 and jl.store_id = ${moneyTransfers.storeId}
      )`,
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
    throw recordGone(
      `markVoided: money transfer ${id} does not exist in org ${orgId}, or is already voided`,
      'money transfer',
    );
  }
}

/**
 * Store id → store CODE, for the two ends of a cross-store transfer.
 *
 * ⚠️ **A `party_type='store'` line carries the other store's CODE, not its database id**
 * (POSTING-PATTERNS §Commissary: *"there is no party FK yet (DEF-040) and store codes are stable,
 * human-chosen identifiers"*). Matching the convention the commissary legs already use is what
 * lets one reciprocal check cover both.
 */
export async function storeCodes(
  tx: Tx,
  orgId: string,
  storeIds: string[],
): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: stores.id, code: stores.code })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), inArray(stores.id, storeIds)));
  return new Map(rows.map((r) => [r.id, r.code]));
}

/**
 * ⭐ T-369 S9 (DEF-557) — what `debtor` owes `creditor`, read from BOTH stores' books. Non-draft entries only, like
 * `reciprocalDrift` (`repo/findings.ts`). Computed in SQL `numeric` and returned as strings, never a float compare.
 *
 *   per the DEBTOR's books:   Σ at D of 2150 party C (credit − debit)  −  Σ at D of 1250 party C (debit − credit)
 *   per the CREDITOR's books: Σ at C of 1250 party D (debit − credit)  −  Σ at C of 2150 party D (credit − debit)
 *
 * which fold to one signed sum each. Every writer posts the pair together, so the two readings agree; a caller that
 * sees them differ must refuse rather than clear against one side's number. A NEGATIVE figure reads as the reverse
 * debt (the creditor owes the debtor).
 */
export async function interStorePosition(
  tx: Tx,
  orgId: string,
  debtorStoreId: string,
  creditorStoreId: string,
): Promise<{ owedPerDebtor: string; owedPerCreditor: string }> {
  const codes = await storeCodes(tx, orgId, [debtorStoreId, creditorStoreId]);
  const debtorCode = codes.get(debtorStoreId);
  const creditorCode = codes.get(creditorStoreId);
  // A store with no code cannot be matched to the party column, so "nothing owed" would be a lie: refuse loudly.
  if (!debtorCode || !creditorCode) {
    throw refuse(
      `interStorePosition: store ${debtorCode ? creditorStoreId : debtorStoreId} has no code in org ${orgId}.`,
      "A store has no code, so what the stores owe each other can't be worked out. Ask the accountant to check the store setup.",
    );
  }
  const [row] = (await tx.execute(sql`
    select
      coalesce(sum(case when jl.store_id = ${debtorStoreId} and jl.party_id = ${creditorCode} then jl.credit - jl.debit end), 0)::numeric(14,2)::text as per_debtor,
      coalesce(sum(case when jl.store_id = ${creditorStoreId} and jl.party_id = ${debtorCode} then jl.debit - jl.credit end), 0)::numeric(14,2)::text as per_creditor
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.code in ('1250', '2150') and jl.party_type = 'store'
  `)) as unknown as { per_debtor: string; per_creditor: string }[];
  return { owedPerDebtor: row?.per_debtor ?? '0.00', owedPerCreditor: row?.per_creditor ?? '0.00' };
}

/**
 * ⭐ T-369 S9 — every ORDERED pair among `storeIds` where the first owes the second a positive net, per the debtor's
 * books, for the "Settle between stores" panel. A pair that nets to zero (or the reverse) is absent.
 */
export async function interStorePositions(
  tx: Tx,
  orgId: string,
  storeIds: string[],
): Promise<{ debtorStoreId: string; creditorStoreId: string; owed: string }[]> {
  if (storeIds.length < 2) return [];
  const ids = sql.join(storeIds.map((id) => sql`${id}`), sql`, `);
  const rows = (await tx.execute(sql`
    select jl.store_id as debtor_store_id, cs.id as creditor_store_id,
           sum(jl.credit - jl.debit)::numeric(14,2)::text as owed
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    join stores cs on cs.org_id = je.org_id and cs.code = jl.party_id
    where je.org_id = ${orgId} and je.status <> 'draft'
      and a.code in ('1250', '2150') and jl.party_type = 'store'
      and jl.store_id in (${ids}) and cs.id in (${ids}) and cs.id <> jl.store_id
    group by jl.store_id, cs.id
    having sum(jl.credit - jl.debit) > 0
    order by sum(jl.credit - jl.debit) desc, jl.store_id, cs.id
  `)) as unknown as { debtor_store_id: string; creditor_store_id: string; owed: string }[];
  return rows.map((r) => ({ debtorStoreId: r.debtor_store_id, creditorStoreId: r.creditor_store_id, owed: r.owed }));
}
