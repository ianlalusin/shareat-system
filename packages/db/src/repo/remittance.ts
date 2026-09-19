/**
 * The only place SQL is written for remittance. T-143, bible rows 144–147 and **157**.
 *
 * ## ⭐ `endDayReports` is the point of this file
 *
 * > **Ian, 2026-08-27:** *"It must be END DAY REPORT, not sales report. The sales report is PART
 * > of that remittance / end-day report… the composition of all money movement of the day across
 * > transactions, on ERP."*
 *
 * So what a day is owed is **the cashier's net movement for that date**, read from the ledger —
 * not its remittable sales, and not a sum over document types. Row 145 said the same thing about
 * the total; row 157 says it per date. **They are one figure.**
 *
 * ⛔ **No `expected` column exists, and none should.** A query that enumerated document types
 * would be wrong the day a new one appears — silently, and in the safe-looking direction. This one
 * asks the ledger what the cashier actually holds, so a document type nobody has invented yet is
 * already included.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  remittanceAllocations,
  remittanceLines,
  remittanceVariances,
  remittances,
  type VarianceStatus,
} from '../../schema/remittance';

export interface EndDayReport {
  businessDate: string;
  /** ⭐ Everything the cashier touched that date, net. Sales, collections and returns in; expenses
   *  paid from the till, cash requests released and advances out. */
  movement: string;
  /** Already settled by earlier batches — remittance is ADDITIVE (row 146). */
  allocated: string;
  /** `movement − allocated`. What FIFO will try to cover. */
  owed: string;
  salesDayId: string | null;
  salesDayStatus: string | null;
  /** ⚠️ Only a VERIFIED day is remittable — an unverified one has no signed count behind it. */
  remittable: boolean;
}

/**
 * Every date with cashier movement for one store, oldest first.
 *
 * ⚠️ **Transfers are excluded, in BOTH directions, and that is a scoping decision worth naming.**
 * A transfer moves money between the business's own accounts — it is custody, not a transaction of
 * the day. Including them would make the remittance itself reduce the very day it settles, and
 * would sweep an office→cashier float back to the office as if it were takings.
 *
 * ⛔ Whether a standing float should be *excluded from remittance permanently* is T-136 §2's
 * imprest question, and its research pass is still owed. This does not pre-empt it: it only keeps
 * transfers out of the day's takings, which is true regardless of how the float is modelled.
 */
export async function endDayReports(
  tx: Tx,
  orgId: string,
  input: { storeId: string; upTo: string },
): Promise<EndDayReport[]> {
  const rows = await tx.execute(sql`
    with cashier_movement as (
      select je.entry_date::text                          as business_date,
             coalesce(sum(jl.debit - jl.credit), 0)::text as movement
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a        on a.id = jl.account_id
      -- The wallet a 1140 line names, when it names one.
      left join money_accounts ma
        on ma.id::text = jl.party_id and jl.party_type = 'money_account'
      -- Otherwise the custodian the cash code itself implies.
      left join (values ('1110','cashier'), ('1120','staff'), ('1130','office'))
        as ca(code, custodian) on ca.code = a.code
      where je.org_id = ${orgId}
        and je.status <> 'draft'
        and jl.store_id = ${input.storeId}
        and a.code ~ '^11[0-9]{2}$'
        and coalesce(ma.custodian, ca.custodian) = 'cashier'
        -- ⚠️ See the note above: custody movement, not a transaction of the day.
        and je.source_type <> 'transfer'
        and je.entry_date <= ${input.upTo}
      group by je.entry_date
    ),
    settled as (
      select ra.business_date::text as business_date,
             coalesce(sum(ra.amount), 0)::text as allocated
      from remittance_allocations ra
      join remittances r on r.id = ra.remittance_id
      where r.org_id = ${orgId} and r.store_id = ${input.storeId} and r.status = 'posted'
      group by ra.business_date
    )
    select m.business_date,
           m.movement,
           coalesce(s.allocated, '0')                          as allocated,
           (m.movement::numeric - coalesce(s.allocated, '0')::numeric)::text as owed,
           sd.id::text                                         as sales_day_id,
           sd.status                                           as sales_day_status,
           (sd.status = 'verified')                            as remittable
    from cashier_movement m
    left join settled s   on s.business_date = m.business_date
    left join sales_days sd
      on sd.org_id = ${orgId} and sd.store_id = ${input.storeId}
     and sd.business_date::text = m.business_date and sd.status <> 'voided'
    where m.movement::numeric <> 0 or coalesce(s.allocated, '0')::numeric <> 0
    order by m.business_date asc
  `);

  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    businessDate: String(r.business_date ?? r.businessDate),
    movement: String(r.movement),
    allocated: String(r.allocated),
    owed: String(r.owed),
    salesDayId: (r.sales_day_id ?? r.salesDayId ?? null) as string | null,
    salesDayStatus: (r.sales_day_status ?? r.salesDayStatus ?? null) as string | null,
    remittable: Boolean(r.remittable),
  }));
}

/**
 * Movement per cashier money account, restricted to the given (settleable) dates. T-324 §3.4.
 *
 * Reuses `endDayReports`'s own resolution: a `party_type = 'money_account'` line names its
 * account directly (`ma.id` — how a 1140 wallet leg identifies itself, `sales-days/routing.ts
 * :265,284`); otherwise the account is the store's own cashier account whose `gl_account_code`
 * matches the line's GL code (how a 1110 till leg resolves, with no party on it at all).
 *
 * ⛔ **Both the ambiguity guard below AND the fallback join key on `accounts.requires_party`, not
 * on a GL code list.** `journal_lines_check_party_requirement` (migration 0007, still the only
 * trigger on `journal_lines` for this) rejects, on every insert and update, in BOTH directions: a
 * party on a line whose account has `requires_party = false`, and a MISSING party on one whose
 * account has `requires_party = true`. The seed (`db/seed/chart-of-accounts.ts`) never flips 1110
 * (cash — one till per store, `money-accounts/index.ts:88-102` refuses a second) and always sets
 * `requires_party = true` on 1140 (e-wallets — `money-accounts/index.ts:55-65,92`: `glCodeFor`
 * sends every non-cash instrument there, with NO limit on how many, because each wallet
 * self-identifies via its own line's `party_id`). So a party-bearing code can never reach the
 * fallback (its lines always carry a party) and a party-forbidden code can never NOT reach it (its
 * lines never do) — the two paths cannot overlap on any row, for any code, without a database
 * constraint being violated first. Keying on the column rather than a literal '1110'/'1140' list
 * means a tenth code needs nothing added here.
 *
 * ⚠️ Two edges this does not (and need not) close: (1) the trigger only checks that A party is
 * present, not that it is `party_type = 'money_account'` — a 1140 line mistyped as
 * `party_type='supplier'` satisfies the trigger, fails the `ma` join below, and drops out of
 * `resolved` entirely. Not a cap hole: `endDayReports` has the identical blind spot (its own `ma`
 * join is the same shape), so such a line is absent from both `owed` and `movement` alike, and
 * check 1 stays exactly as consistent with check 2 as it already was. (2) `party_id` carries no FK
 * (`schema/journal.ts:47`, deliberate — see migration 0007's own header), so a `party_id` pointing
 * at a deleted account drops the line the same way, on both sides, for the same reason.
 */
export async function cashierMovementByAccount(
  tx: Tx,
  orgId: string,
  storeId: string,
  dates: string[],
): Promise<Map<string, string>> {
  if (dates.length === 0) return new Map();

  // ⚠️ Read as snake_case (`gl_account_code`, `requires_party`), unhedged — no `?? camelCase`
  // fallback like `:231` below or `endDayReports` use. Proven for this exact path by the
  // integration suite rather than assumed: if the driver ever returned camelCase here, every
  // `acct.gl_account_code` read would be `undefined`, every account would collapse into one
  // `undefined` group, `requires_party` would be `undefined` so `!undefined` is `true`, and the
  // ambiguity guard below would fire for ANY store with two active cashier accounts — which
  // `fixtureWithWallet` in `remittance.test.ts` already is. The suite would fail loudly; it
  // passes. The `??` hedges elsewhere in this file are unexplained by the same standard and are
  // filed as DEF-377, not made obsolete by this proof — do not copy this unhedged shape onto them.
  const cashierAccounts = (await tx.execute(sql`
    select ma.id, ma.gl_account_code, ma.name, a.requires_party
    from money_accounts ma
    join accounts a on a.org_id = ma.org_id and a.code = ma.gl_account_code
    where ma.org_id = ${orgId} and ma.store_id = ${storeId} and ma.custodian = 'cashier' and ma.is_active
  `)) as unknown as { id: string; gl_account_code: string; name: string; requires_party: boolean }[];

  const byCode = new Map<string, typeof cashierAccounts>();
  for (const acct of cashierAccounts) {
    const list = byCode.get(acct.gl_account_code) ?? [];
    list.push(acct);
    byCode.set(acct.gl_account_code, list);
  }
  for (const [code, accts] of byCode) {
    // Only a party-FORBIDDEN code is ever resolved through the fallback (see the doc comment
    // above) — a party-bearing code such as 1140 is designed to carry many active cashier
    // accounts, each unambiguous by construction, and must never refuse here.
    //
    // ⚠️ `accts[0]!` — `accts` is non-empty by construction (every `byCode` value starts `?? []`
    // and is pushed to immediately, never stored empty), and `requires_party` is constant across
    // the group because `accounts` is unique on (org_id, code) (`schema/accounts.ts:62`,
    // `accounts_org_id_code_unique`) — one code can never resolve to two `accounts` rows with
    // different flags. Without that constraint a chart-of-accounts duplicate alone could inflate
    // `accts.length` and reintroduce this function's outage in a new shape: a false ambiguity
    // refusal driven by the chart rather than by money accounts.
    if (!accts[0]!.requires_party && accts.length > 1) {
      throw new Error(
        `cashierMovementByAccount: GL account ${code} accepts no party on its own lines, and ` +
          `${accts.length} active cashier accounts share it for this store — ` +
          `${accts.map((a) => `"${a.name}"`).join(', ')}. A line on it cannot say which one moved; ` +
          `deactivate whichever of these is not really in use.`,
      );
    }
  }

  const dateList = sql.join(dates.map((d) => sql`${d}::date`), sql`, `);

  const rows = await tx.execute(sql`
    with cashier_accounts as (
      select ma.id, ma.gl_account_code, ma.name
      from money_accounts ma
      join accounts a on a.org_id = ma.org_id and a.code = ma.gl_account_code
      where ma.org_id = ${orgId} and ma.store_id = ${storeId} and ma.custodian = 'cashier'
        and ma.is_active and a.requires_party = false
    ),
    resolved as (
      select
        case when jl.party_type = 'money_account' then ma.id else fallback.id end as account_id,
        (jl.debit - jl.credit) as delta
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      join accounts a         on a.id = jl.account_id
      -- The wallet a 1140 line names, when it names one — regardless of ITS custodian; the
      -- filter below decides whether the line counts, this join only resolves identity.
      left join money_accounts ma
        on ma.id::text = jl.party_id and jl.party_type = 'money_account'
      -- Whether the fallback GL code is a cashier code at all (endDayReports's own static map).
      left join (values ('1110','cashier'), ('1120','staff'), ('1130','office')) as ca(code, custodian)
        on ca.code = a.code
      -- The store's own cashier account for that code, when the line names no party at all.
      -- cashier_accounts is already restricted to requires_party = false codes (see the CTE
      -- above), so this can only match a line the party-requirement trigger guarantees has no
      -- party — never a 1140 line, so a store's second wallet can never fan one journal line into
      -- two rows here.
      left join cashier_accounts fallback on fallback.gl_account_code = a.code
      where je.org_id = ${orgId}
        and je.status <> 'draft'
        and jl.store_id = ${storeId}
        and a.code ~ '^11[0-9]{2}$'
        and je.source_type <> 'transfer'
        and je.entry_date in (${dateList})
        and coalesce(ma.custodian, ca.custodian) = 'cashier'
    )
    select account_id, coalesce(sum(delta), 0)::text as movement
    from resolved
    where account_id is not null
    group by account_id
  `);

  const movementByAccount = new Map<string, string>();
  for (const row of rows as unknown as Record<string, unknown>[]) {
    movementByAccount.set(String(row.account_id ?? row.accountId), String(row.movement));
  }
  return movementByAccount;
}

// -------------------------------------------------------------------------------------
// Writes
// -------------------------------------------------------------------------------------

export interface InsertRemittanceInput {
  orgId: string;
  storeId: string;
  remittedOn: string;
  reference: string | null;
  notes: string | null;
  acceptedBy: string | null;
  createdBy: string;
}

export async function insertRemittance(
  tx: Tx,
  input: InsertRemittanceInput,
): Promise<{ id: string }> {
  const [row] = await tx.insert(remittances).values(input).returning({ id: remittances.id });
  return row!;
}

export async function insertLine(
  tx: Tx,
  input: {
    remittanceId: string;
    fromMoneyAccountId: string;
    toMoneyAccountId: string;
    amount: string;
    moneyTransferId: string;
    /** ⭐ T-324 §3.5. NULL = never asked; '0.00' = "I declare no overage" — a real answer, not
     *  the same as absence (`packages/core/src/money.ts:15-16`). */
    declaredOverage: string | null;
  },
): Promise<void> {
  await tx.insert(remittanceLines).values(input);
}

export async function insertAllocation(
  tx: Tx,
  input: {
    remittanceId: string;
    businessDate: string;
    salesDayId: string | null;
    amount: string;
  },
): Promise<void> {
  await tx.insert(remittanceAllocations).values(input);
}

export async function insertVariance(
  tx: Tx,
  input: {
    orgId: string;
    remittanceId: string;
    businessDate: string;
    salesDayId: string | null;
    amount: string;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(remittanceVariances)
    .values(input)
    .returning({ id: remittanceVariances.id });
  return row!;
}

export async function getById(tx: Tx, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(remittances)
    .where(and(eq(remittances.id, id), eq(remittances.orgId, orgId)))
    .limit(1);
  return row;
}

export async function linesFor(tx: Tx, remittanceId: string) {
  return tx
    .select()
    .from(remittanceLines)
    .where(eq(remittanceLines.remittanceId, remittanceId))
    .orderBy(asc(remittanceLines.id));
}

export async function allocationsFor(tx: Tx, remittanceId: string) {
  return tx
    .select()
    .from(remittanceAllocations)
    .where(eq(remittanceAllocations.remittanceId, remittanceId))
    .orderBy(asc(remittanceAllocations.businessDate));
}

export async function listRemittances(tx: Tx, orgId: string, storeId?: string) {
  const conditions = [eq(remittances.orgId, orgId)];
  if (storeId) conditions.push(eq(remittances.storeId, storeId));
  return tx
    .select()
    .from(remittances)
    .where(and(...conditions))
    .orderBy(desc(remittances.remittedOn))
    .limit(100);
}

export async function markReversed(
  tx: Tx,
  orgId: string,
  id: string,
  input: { reversedOn: string; reverseReason: string },
): Promise<void> {
  const updated = await tx
    .update(remittances)
    .set({ status: 'reversed', ...input })
    .where(
      and(eq(remittances.id, id), eq(remittances.orgId, orgId), eq(remittances.status, 'posted')),
    )
    .returning({ id: remittances.id });
  if (updated.length === 0) {
    throw new Error(`markReversed: remittance ${id} does not exist in org ${orgId}, or is already reversed`);
  }
}

/** ⭐ Open variances — the list that must not hide (Ian, row 147). */
export async function listVariances(tx: Tx, orgId: string, status?: VarianceStatus) {
  const conditions = [eq(remittanceVariances.orgId, orgId)];
  if (status) conditions.push(eq(remittanceVariances.status, status));
  return tx
    .select()
    .from(remittanceVariances)
    .where(and(...conditions))
    .orderBy(desc(remittanceVariances.businessDate));
}

/**
 * A variance with the store it belongs to.
 *
 * ⚠️ The store comes from the REMITTANCE, not from the variance — `accept_remittance` is
 * store-scoped, and a variance with no store to check would either be ungated or would need a
 * store column that could disagree with its parent.
 */
export async function getVarianceWithStore(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ id: string; storeId: string; status: VarianceStatus } | undefined> {
  const [row] = await tx
    .select({
      id: remittanceVariances.id,
      storeId: remittances.storeId,
      status: remittanceVariances.status,
    })
    .from(remittanceVariances)
    .innerJoin(remittances, eq(remittances.id, remittanceVariances.remittanceId))
    .where(and(eq(remittanceVariances.id, id), eq(remittanceVariances.orgId, orgId)))
    .limit(1);
  return row;
}

export async function resolveVariance(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    status: 'charged' | 'written_off';
    chargedToPersonId: string | null;
    reason: string | null;
    resolvedBy: string;
    resolvedOn: string;
  },
): Promise<void> {
  const updated = await tx
    .update(remittanceVariances)
    .set(input)
    .where(
      and(
        eq(remittanceVariances.id, id),
        eq(remittanceVariances.orgId, orgId),
        eq(remittanceVariances.status, 'open'),
      ),
    )
    .returning({ id: remittanceVariances.id });
  if (updated.length === 0) {
    throw new Error(`resolveVariance: variance ${id} does not exist in org ${orgId}, or is not open`);
  }
}
