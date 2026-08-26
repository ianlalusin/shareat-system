/**
 * The only place SQL is written for money accounts. ADR-010, bible rows 142–147.
 *
 * ## ⭐ The two functions that are the point of this file
 *
 * `custodianPosition` and `undepositedFunds` are why ADR-010 exists. Both read the LEDGER and
 * join to this table only to learn who holds each place — they never read a stored balance,
 * because there isn't one.
 *
 * ⛔ **Do not add a `balance` column here.** It is the single most tempting change in this file
 * and it would undo the whole design. v1 maintained balances beside its journal and they drifted:
 * AP control ₱669,829.84 against a subledger of ₱1,567,980.87, and 34 of 115 account/store
 * combinations disagreeing with a reconstruction from raw legs. **A number worth showing is worth
 * deriving.**
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { accounts } from '../../schema/accounts';
import { journalEntries, journalLines } from '../../schema/journal';
import {
  moneyAccounts,
  type Custodian,
  type MoneyInstrument,
} from '../../schema/money-accounts';

export interface MoneyAccountRow {
  id: string;
  orgId: string;
  storeId: string;
  name: string;
  instrument: MoneyInstrument;
  glAccountCode: string;
  custodian: Custodian;
  isActive: boolean;
  notes: string | null;
  createdAt: Date;
}

const COLUMNS = {
  id: moneyAccounts.id,
  orgId: moneyAccounts.orgId,
  storeId: moneyAccounts.storeId,
  name: moneyAccounts.name,
  instrument: moneyAccounts.instrument,
  glAccountCode: moneyAccounts.glAccountCode,
  custodian: moneyAccounts.custodian,
  isActive: moneyAccounts.isActive,
  notes: moneyAccounts.notes,
  createdAt: moneyAccounts.createdAt,
} as const;

// -------------------------------------------------------------------------------------
// The register
// -------------------------------------------------------------------------------------

export interface InsertMoneyAccountInput {
  orgId: string;
  storeId: string;
  name: string;
  instrument: MoneyInstrument;
  glAccountCode: string;
  custodian: Custodian;
  notes?: string | null;
}

export async function insertMoneyAccount(
  tx: Tx,
  input: InsertMoneyAccountInput,
): Promise<{ id: string }> {
  const [row] = await tx.insert(moneyAccounts).values(input).returning({ id: moneyAccounts.id });
  return row!;
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<MoneyAccountRow | undefined> {
  const [row] = await tx
    .select(COLUMNS)
    .from(moneyAccounts)
    .where(and(eq(moneyAccounts.id, id), eq(moneyAccounts.orgId, orgId)))
    .limit(1);
  return row as MoneyAccountRow | undefined;
}

export interface ListMoneyAccountsFilter {
  storeId?: string;
  custodian?: Custodian;
  instrument?: MoneyInstrument;
  /** Omitted lists ACTIVE only — a retired wallet should not appear in a payment picker. Pass
   *  `false` explicitly to include retired ones for a report or an audit. */
  activeOnly?: boolean;
}

export async function listMoneyAccounts(
  tx: Tx,
  orgId: string,
  filter: ListMoneyAccountsFilter = {},
): Promise<MoneyAccountRow[]> {
  const conditions = [eq(moneyAccounts.orgId, orgId)];
  if (filter.storeId) conditions.push(eq(moneyAccounts.storeId, filter.storeId));
  if (filter.custodian) conditions.push(eq(moneyAccounts.custodian, filter.custodian));
  if (filter.instrument) conditions.push(eq(moneyAccounts.instrument, filter.instrument));
  if (filter.activeOnly !== false) conditions.push(eq(moneyAccounts.isActive, true));

  const rows = await tx
    .select(COLUMNS)
    .from(moneyAccounts)
    .where(and(...conditions))
    .orderBy(asc(moneyAccounts.custodian), asc(moneyAccounts.name));
  return rows as MoneyAccountRow[];
}

/**
 * Retires a money account. ⛔ There is deliberately no delete.
 *
 * A money account is named by journal lines as their party, and those lines outlive it. Deleting
 * one would orphan them — the DEF-065 class of problem, where the ledger keeps a leg pointing at
 * something that no longer exists. v1's `adminDeleteRecordAction` has exactly this hole for
 * assets and prepaid items: no reversal branch, straight to `ref.delete()`.
 */
export async function retireMoneyAccount(tx: Tx, orgId: string, id: string): Promise<void> {
  const updated = await tx
    .update(moneyAccounts)
    .set({ isActive: false, updatedAt: sql`now()` })
    .where(
      and(
        eq(moneyAccounts.id, id),
        eq(moneyAccounts.orgId, orgId),
        eq(moneyAccounts.isActive, true),
      ),
    )
    .returning({ id: moneyAccounts.id });
  if (updated.length === 0) {
    throw new Error(
      `retireMoneyAccount: money account ${id} does not exist in org ${orgId}, or is already retired`,
    );
  }
}

export async function updateMoneyAccount(
  tx: Tx,
  orgId: string,
  id: string,
  input: { name: string; custodian: Custodian; notes: string | null },
): Promise<void> {
  const updated = await tx
    .update(moneyAccounts)
    .set({ ...input, updatedAt: sql`now()` })
    .where(and(eq(moneyAccounts.id, id), eq(moneyAccounts.orgId, orgId)))
    .returning({ id: moneyAccounts.id });
  if (updated.length === 0) {
    throw new Error(`updateMoneyAccount: money account ${id} does not exist in org ${orgId}`);
  }
}

// -------------------------------------------------------------------------------------
// ⭐ Derived positions — read from the ledger, never from a column
// -------------------------------------------------------------------------------------

export interface CustodianPositionRow {
  custodian: Custodian;
  glAccountCode: string;
  /** Debits less credits. Positive means money is held there. */
  balance: string;
}

/**
 * What each custodian is holding, per GL account, as at `asOf` (inclusive).
 *
 * ⭐ **This is ADR-010's internal view**, and it is one `GROUP BY` over the same lines the trial
 * balance reads. The general view is the same query without the join.
 *
 * ⚠️ **Cash accounts are matched by GL code, not by party.** `1110`/`1120`/`1130` already say who
 * holds them — the code IS the location — so a journal line against `1110` needs no party to be
 * attributable. Only `1140` is ambiguous, because one control account covers every wallet, and
 * that is the case the party resolves. Requiring a party on all four would be ceremony for three
 * of them and would break every posting written before this table existed.
 */
export async function custodianPositions(
  tx: Tx,
  orgId: string,
  input: { asOf: string; storeId?: string },
): Promise<CustodianPositionRow[]> {
  const storeFilter = input.storeId
    ? sql`and ${journalLines.storeId} = ${input.storeId}`
    : sql``;

  const rows = await tx.execute(sql`
    select
      coalesce(ma.custodian, ca.custodian)                       as custodian,
      a.code                                                     as gl_account_code,
      coalesce(sum(jl.debit - jl.credit), 0)::text                as balance
    from ${journalLines} jl
    join ${journalEntries} je on je.id = jl.entry_id
    join ${accounts} a on a.id = jl.account_id
    -- The wallet named by the line, when there is one (1140).
    left join ${moneyAccounts} ma
      on ma.id::text = jl.party_id and jl.party_type = 'money_account'
    -- Otherwise the custodian the GL code itself implies (1110/1120/1130).
    left join (values
      ('1110', 'cashier'), ('1120', 'staff'), ('1130', 'office')
    ) as ca(code, custodian) on ca.code = a.code
    where je.org_id = ${orgId}
      and je.status <> 'draft'
      and je.entry_date <= ${input.asOf}
      and a.code ~ '^11[0-9]{2}$'
      ${storeFilter}
    group by coalesce(ma.custodian, ca.custodian), a.code
    having coalesce(ma.custodian, ca.custodian) is not null
    order by 1, 2
  `);

  return (rows as unknown as CustodianPositionRow[]).map((r) => ({
    custodian: r.custodian,
    glAccountCode: r.glAccountCode ?? (r as unknown as { gl_account_code: string }).gl_account_code,
    balance: r.balance,
  }));
}

/**
 * What ONE money account is holding, as at today — debits less credits on its own lines.
 *
 * ⚠️ Only meaningful for a party-bearing location (`1140`). A cash location shares its GL code
 * with every other location of the same custodian at that store, so its balance is the code's
 * balance — which is why the service refuses a second cash location per custodian in the first
 * place, and why this function takes the account rather than guessing.
 */
export async function balanceOf(
  tx: Tx,
  orgId: string,
  account: { id: string; glAccountCode: string; storeId: string },
): Promise<string> {
  // ⚠️ No leading `and` — these go INSIDE drizzle's `and(...)`, which supplies the operator.
  // Writing one produced `WHERE … AND and …` and a syntax error the retire test caught.
  const partyFilter =
    account.glAccountCode === '1140'
      ? and(
          eq(journalLines.partyType, 'money_account'),
          eq(journalLines.partyId, account.id),
        )
      : eq(journalLines.storeId, account.storeId);

  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)::text` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        ne(journalEntries.status, 'draft'),
        eq(accounts.code, account.glAccountCode),
        partyFilter,
      ),
    );
  return row?.total ?? '0';
}

/**
 * ⭐ **UNDEPOSITED FUNDS** — money that has left the sale but not reached the office.
 *
 * Bible row 143. Rows 127 and 131 both assumed this needed **an account of its own**, because v1
 * has none. That assumption was wrong, and ADR-010's test says why: nobody reconciles "undeposited
 * funds" against an external document — **they reconcile the till**, and the till is `1110`.
 *
 * Money is undeposited precisely while it sits in a cashier-custodian account. So the figure an
 * accountant would want from a dedicated account is this `GROUP BY` instead: no account, no
 * posting, and nothing that can drift from the accounts it summarises.
 *
 * ⚠️ Row 129's peso ceiling watches this same number.
 */
export async function undepositedFunds(
  tx: Tx,
  orgId: string,
  input: { asOf: string; storeId?: string },
): Promise<string> {
  const positions = await custodianPositions(tx, orgId, input);
  const total = positions
    .filter((p) => p.custodian === 'cashier')
    .reduce((sum, p) => sum + Number(p.balance), 0);
  return total.toFixed(2);
}
