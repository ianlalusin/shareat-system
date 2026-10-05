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
import type { Money } from '@shareat/core/money';
import type { Tx } from '../client';
import type { SafeInsert } from './numeric-input';
import { recordGone } from './record-gone';
import { accounts } from '../../schema/accounts';
import { stores } from '../../schema/stores';
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
  /** ⭐ One of the five every store must always have (bible row 156). Un-retirable while the
   *  store is active; the NAME is still editable, which is the point of the flag. */
  isFoundation: boolean;
  /** ⭐ How far below zero a CASHIER drawer may go. Positive; office/staff ignore it. */
  overdraftLimit: string;
  /** ⭐ T-153/T-316 — non-null marks the cashier's cash drawer (1110) as carrying a TILL FLOAT: the
   *  configured amount it should always hold. A target on the drawer, not a side pocket; the
   *  drawer is still judged as a cashier drawer (warn within its overdraft). */
  floatTarget: string | null;
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
  isFoundation: moneyAccounts.isFoundation,
  overdraftLimit: moneyAccounts.overdraftLimit,
  floatTarget: moneyAccounts.floatTarget,
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
  /** ⭐ T-153 / T-316 — the float target on the cashier drawer (not a separate pot). See {@link MoneyAccountRow.floatTarget}. */
  floatTarget?: Money | null;
}

export async function insertMoneyAccount(
  tx: Tx,
  input: InsertMoneyAccountInput,
): Promise<{ id: string }> {
  const [row] = await tx.insert(moneyAccounts).values(input satisfies SafeInsert<typeof moneyAccounts>).returning({ id: moneyAccounts.id });
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
    throw recordGone(
      `retireMoneyAccount: money account ${id} does not exist in org ${orgId}, or is already retired`,
      'money account',
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
    throw recordGone(`updateMoneyAccount: money account ${id} does not exist in org ${orgId}`, 'money account');
  }
}

/**
 * ⭐ T-153 — set or clear a till float's configured amount.
 *
 * ⚠️ Deliberately separate from {@link updateMoneyAccount}, which is the register's rename/retire
 * path and is reachable by anyone holding `manage_money_accounts`. The target is a **risk figure**
 * — the number a cash count is judged against — so it moves on its own capability, exactly as
 * T-152's un-remitted ceiling does.
 */
export async function setFloatTarget(
  tx: Tx,
  orgId: string,
  id: string,
  floatTarget: Money | null,
): Promise<void> {
  const updated = await tx
    .update(moneyAccounts)
    .set({ floatTarget, updatedAt: sql`now()` })
    .where(and(eq(moneyAccounts.id, id), eq(moneyAccounts.orgId, orgId)))
    .returning({ id: moneyAccounts.id });
  if (updated.length === 0) {
    throw recordGone(`setFloatTarget: money account ${id} does not exist in org ${orgId}`, 'money account');
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
    ? sql`and jl.store_id = ${input.storeId}`
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
 * ⭐ Every account's balance for one store, in ONE statement — T-266 §9.3.
 *
 * ⚠️ **This replaces an N+1.** `apps/erp/src/app/ap/lib.ts`'s `moneyAccountsFor` maps `balanceOf`
 * over every account, one round trip each. That was tolerable for the one screen that showed
 * balances; T-266 puts a balance on every money picker in the app, so it stops being tolerable.
 *
 * ⭐ The shape is `custodianPositions`' (above), not `balanceOf`'s loop — one `GROUP BY` over the
 * same lines, and the same asymmetry it documents applies here unchanged:
 *
 *   - `1140` is ONE control account for every wallet, so a wallet's balance is its own PARTY's
 *     lines. Two wallets never share a total.
 *   - `1110`/`1120`/`1130` have no party, so a cash account's balance is its GL code's balance at
 *     its store. That is exact because `createMoneyAccount` refuses a second cash location per
 *     custodian per store — which is why that refusal matters beyond tidiness.
 *
 * ⛔ **A staff-float account's total here belongs to NOBODY in particular.** It is the sum of
 * every open float at that store (Ana's ₱1,240 + Ben's ₱380 = ₱1,620). Do not offer that number
 * as a spendable balance — a float is spent per holder, and `cashRequestsRepo.floatsByRequest`
 * is what decomposes it (T-266 §7.3).
 */
export async function balancesFor(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<Map<string, string>> {
  const rows = await tx.execute(sql`
    select ma.id::text as account_id,
      coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from ${moneyAccounts} ma
    left join ${accounts} a
      on a.code = ma.gl_account_code
    left join ${journalLines} jl
      on jl.account_id = a.id
     and jl.store_id = ma.store_id
     -- Only 1140 needs the party to tell two places apart; the others ARE the place.
     and (
       ma.gl_account_code <> '1140'
       or (jl.party_type = 'money_account' and jl.party_id = ma.id::text)
     )
    left join ${journalEntries} je
      on je.id = jl.entry_id
     and je.org_id = ${orgId}
     and je.status <> 'draft'
    where ma.org_id = ${orgId}
      and ma.store_id = ${storeId}
      -- ⚠️ A line only counts once its entry qualifies. Without this, the left join keeps rows
      -- whose entry is a draft or another org's and sums them in.
      and (jl.id is null or je.id is not null)
    group by ma.id
  `);

  const out = new Map<string, string>();
  for (const r of rows as unknown as Record<string, string>[]) {
    out.set(String(r.account_id ?? r.accountId), Number(r.balance ?? 0).toFixed(2));
  }
  return out;
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

/** Is the account's store still trading? The foundation guard turns on this. */
export async function storeIsActive(tx: Tx, storeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ isActive: stores.isActive })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  return row?.isActive ?? false;
}

/**
 * Renames a money account, and nothing else.
 *
 * ⭐ Deliberately narrower than `updateMoneyAccount`. Ian asked for the five to be *"configurable
 * in UI, especially name"* — and the name is the ONLY thing safe to change on a foundation
 * account. Its custodian and instrument decide its GL code, so editing those would move money
 * between accounts by renaming a row.
 */
export async function renameMoneyAccount(
  tx: Tx,
  orgId: string,
  id: string,
  input: { name: string; notes: string | null; overdraftLimit?: Money },
): Promise<void> {
  const updated = await tx
    .update(moneyAccounts)
    .set({ ...input, updatedAt: sql`now()` })
    .where(and(eq(moneyAccounts.id, id), eq(moneyAccounts.orgId, orgId)))
    .returning({ id: moneyAccounts.id });
  if (updated.length === 0) {
    throw recordGone(`renameMoneyAccount: money account ${id} does not exist in org ${orgId}`, 'money account');
  }
}
