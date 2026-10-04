/**
 * The only place SQL is written for channel settlement. T-150.
 *
 * ⛔ **Nothing is stored that the ledger can answer.** What a channel still owes is a query over
 * `1220` by party, exactly as AP and AR do it — the same discipline that found v1's 13.3% drift in
 * a maintained `outstandingAmount`.
 */
import { and, eq, sql } from 'drizzle-orm';
// ⛔ T-218 — Manila, never bare current_date (DEF-172).
import { MANILA_TODAY } from './sql-time';
import type { Tx } from '../client';
import type { Money } from '@shareat/core/money';
import type { SafeInsert } from './numeric-input';
import {
  channelSettlements,
  type ChannelSettlementStatus,
} from '../../schema/channel-settlements';

export const CHANNEL_RECEIVABLE_CODE = '1220';
export const PLATFORM_FEE_CODE = '6400';
export const ONLINE_ORDER_EXPENSE_CODE = '6410';
export const SETTLEMENT_VARIANCE_CODE = '6420';
export const MARKETING_CODE = '6650';
export const TAXES_CODE = '6800';
export const SETTLEMENT_GAIN_CODE = '7100';
export const LOANS_PAYABLE_CODE = '2400';
export const DUE_FROM_STORE_CODE = '1250';
export const DUE_TO_STORE_CODE = '2150';
export const PARTY_TYPE = 'channel';

export interface ChannelSettlementRow {
  id: string;
  orgId: string;
  storeId: string;
  channelId: string;
  salesDayId: string;
  businessDate: string;
  grossAmount: string;
  outstandingCleared: string;
  commission: string;
  marketing: string;
  platformFee: string;
  vatOnFees: string;
  withholdingTax: string;
  penalty: string;
  variance: string;
  settlementGain: string;
  loanDeduction: string;
  loanId: string | null;
  loanOwnerStoreId: string | null;
  netDeposited: string;
  destinationMoneyAccountId: string;
  reference: string | null;
  settledOn: string;
  /**
   * ⛔ DEF-146. This column existed and this type did not name it, so `recordChannelSettlement`'s
   * insert — cast `as never` — dropped the 2307 the caller supplied, silently. The cast is gone
   * and the field is here; the schema's own comment already said it is *"the one document that
   * cannot be obtained retroactively."*
   */
  withholdingCertificateFileId: string | null;
  status: ChannelSettlementStatus;
  journalEntryId: string | null;
  createdBy: string;
}

/**
 * ⭐ T-371 C2 — every money column is a branded `Decimal`; an unparsed string cannot reach this insert. The fee,
 * variance, gain and loan columns are NOT NULL DEFAULT 0, so they are optional here (R13): a blank is omitted and the
 * column's own default writes the zero.
 */
export type InsertSettlementInput = Pick<
  SafeInsert<typeof channelSettlements>,
  | 'orgId'
  | 'storeId'
  | 'channelId'
  | 'salesDayId'
  | 'businessDate'
  | 'loanId'
  | 'loanOwnerStoreId'
  | 'destinationMoneyAccountId'
  | 'reference'
  | 'settledOn'
  | 'withholdingCertificateFileId'
  | 'createdBy'
> & {
  grossAmount: Money;
  outstandingCleared: Money;
  netDeposited: Money;
  /** NOT NULL DEFAULT 0 — omit a blank and the column default applies (R13). */
  commission?: Money;
  marketing?: Money;
  platformFee?: Money;
  vatOnFees?: Money;
  withholdingTax?: Money;
  penalty?: Money;
  variance?: Money;
  settlementGain?: Money;
  loanDeduction?: Money;
};

export async function insertSettlement(
  tx: Tx,
  input: InsertSettlementInput,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(channelSettlements)
    .values(input)
    .returning({ id: channelSettlements.id });
  return { id: row!.id };
}

export async function getById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ChannelSettlementRow | undefined> {
  const [row] = await tx
    .select()
    .from(channelSettlements)
    .where(and(eq(channelSettlements.orgId, orgId), eq(channelSettlements.id, id)))
    .limit(1);
  return row as ChannelSettlementRow | undefined;
}

export async function markPosted(
  tx: Tx,
  orgId: string,
  id: string,
  values: { journalEntryId: string; postedBy: string },
): Promise<void> {
  await tx
    .update(channelSettlements)
    .set({
      status: 'posted',
      journalEntryId: values.journalEntryId,
      postedBy: values.postedBy,
      postedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(channelSettlements.orgId, orgId), eq(channelSettlements.id, id)));
}

export async function markVoided(
  tx: Tx,
  orgId: string,
  id: string,
  values: { voidedBy: string; voidReason: string },
): Promise<void> {
  await tx
    .update(channelSettlements)
    .set({
      status: 'voided',
      voidedBy: values.voidedBy,
      voidedAt: sql`now()`,
      voidReason: values.voidReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(channelSettlements.orgId, orgId), eq(channelSettlements.id, id)));
}

/**
 * ⭐ What this channel still has outstanding — **derived from the ledger**, never stored.
 *
 * `1220` carries `party_type = 'channel'`, so this is the subledger side of invariant 6's
 * control-account reconciliation and it ages per channel for free.
 */
export async function outstandingFor(
  tx: Tx,
  orgId: string,
  channelId: string,
): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(sum(jl.debit - jl.credit), 0)::text as balance
    from journal_lines jl
    join journal_entries je on je.id = jl.entry_id
    join accounts a on a.id = jl.account_id
    where je.org_id = ${orgId}
      and jl.party_type = ${PARTY_TYPE}
      and jl.party_id = ${channelId}
      and a.code = ${CHANNEL_RECEIVABLE_CODE}
      and je.status <> 'draft'
  `)) as unknown as Record<string, string>[];
  return Number(row?.balance ?? 0).toFixed(2);
}

/** Is there already a POSTED settlement for this channel-day? A second is refused, not duplicated. */
export async function postedSettlementFor(
  tx: Tx,
  orgId: string,
  channelId: string,
  businessDate: string,
): Promise<{ id: string } | undefined> {
  const [row] = (await tx.execute(sql`
    select id from channel_settlements
    where org_id = ${orgId} and channel_id = ${channelId}
      and business_date = ${businessDate} and status = 'posted'
    limit 1
  `)) as unknown as Record<string, string>[];
  return row ? { id: String(row.id) } : undefined;
}

/** Per-channel settlement configuration — where the payout lands, and how tax is treated. */
export async function channelConfig(
  tx: Tx,
  orgId: string,
  channelId: string,
): Promise<{ name: string; storeId: string; destinationMoneyAccountId: string | null; taxTreatment: string } | undefined> {
  const [row] = (await tx.execute(sql`
    select name, store_id, destination_money_account_id, tax_treatment
    from sales_channels where org_id = ${orgId} and id = ${channelId}
  `)) as unknown as Record<string, string | null>[];
  if (!row) return undefined;
  return {
    name: String(row.name),
    storeId: String(row.store_id),
    destinationMoneyAccountId: row.destination_money_account_id ?? null,
    taxTreatment: String(row.tax_treatment ?? 'expense'),
  };
}

// -------------------------------------------------------------------------------------
// ⭐ The screen's read models — DEF-137. Nothing here is stored; every figure is a query.
// -------------------------------------------------------------------------------------

export interface SettlementChannelRow {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  storeCode: string;
  isActive: boolean;
  destinationMoneyAccountId: string | null;
  destinationAccountName: string | null;
  taxTreatment: string;
  /** ⭐ What `1220` says this channel is owed, right now. Derived — there is no balance column. */
  outstanding: string;
}

/**
 * Every channel that can raise a receivable, with what it is currently owed.
 *
 * ⚠️ **Remitted-daily channels are excluded and that is not a filter for tidiness.** A remitted
 * channel's money reaches the till on the day; it never raises a `1220` receivable, so there is
 * nothing for a settlement to clear and offering one would invite a posting the domain refuses.
 */
export async function listSettlementChannels(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string } = {},
): Promise<SettlementChannelRow[]> {
  const rows = (await tx.execute(sql`
    select c.id::text, c.name, c.store_id::text, s.name as store_name, s.code as store_code,
           c.is_active, c.destination_money_account_id::text, ma.name as destination_account_name,
           c.tax_treatment,
           coalesce((
             select sum(jl.debit - jl.credit)
             from journal_lines jl
             join journal_entries je on je.id = jl.entry_id
             join accounts a on a.id = jl.account_id
             where je.org_id = c.org_id
               and jl.party_type = ${PARTY_TYPE}
               and jl.party_id = c.id::text
               and a.code = ${CHANNEL_RECEIVABLE_CODE}
               and je.status <> 'draft'
           ), 0)::text as outstanding
    from sales_channels c
    join stores s on s.id = c.store_id
    left join money_accounts ma on ma.id = c.destination_money_account_id
    where c.org_id = ${orgId}
      and c.is_remitted_daily = false
      ${filter.storeId ? sql`and c.store_id = ${filter.storeId}` : sql``}
    order by s.name asc, c.name asc
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    storeId: String(r.store_id),
    storeName: String(r.store_name),
    storeCode: String(r.store_code),
    isActive: Boolean(r.is_active),
    destinationMoneyAccountId: (r.destination_money_account_id ?? null) as string | null,
    destinationAccountName: (r.destination_account_name ?? null) as string | null,
    taxTreatment: String(r.tax_treatment ?? 'expense'),
    outstanding: Number(r.outstanding ?? 0).toFixed(2),
  }));
}

export interface SettleableChannelDayRow {
  salesDayId: string;
  businessDate: string;
  storeId: string;
  storeName: string;
  channelId: string;
  channelName: string;
  /** What the verified sales day said this channel sold — the settlement's gross default. */
  reportedAmount: string;
  destinationMoneyAccountId: string | null;
  /** Days since the business date. ⭐ Age, not just amount — bible row 147. */
  ageDays: number;
}

/**
 * ⭐ **The queue: verified channel-days that no posted settlement has cleared.**
 *
 * ⚠️ `status = 'verified'` is the whole gate, and it is not a convenience. An unverified day has
 * posted nothing (bible row 126), so it has raised no receivable — settling it would clear a
 * balance that does not exist. `no_sales` rows and zero amounts are excluded for the same reason.
 */
export async function listSettleableChannelDays(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string; limit?: number } = {},
): Promise<SettleableChannelDayRow[]> {
  const rows = (await tx.execute(sql`
    select sd.id::text        as sales_day_id,
           sd.business_date::text,
           sd.store_id::text,
           st.name            as store_name,
           c.id::text         as channel_id,
           c.name             as channel_name,
           sdc.amount::text   as reported_amount,
           c.destination_money_account_id::text,
           -- ⛔ T-218 / DEF-172. Manila, never bare current_date — this age drives an amber
           -- badge at 14 days, so a day of drift moves a threshold a person acts on.
           (${MANILA_TODAY} - sd.business_date) as age_days
    from sales_day_channels sdc
    join sales_days sd on sd.id = sdc.sales_day_id
    join sales_channels c on c.id = sdc.channel_id
    join stores st on st.id = sd.store_id
    where sd.org_id = ${orgId}
      and sd.status = 'verified'
      and c.is_remitted_daily = false
      and sdc.no_sales = false
      and sdc.amount > 0
      ${filter.storeId ? sql`and sd.store_id = ${filter.storeId}` : sql``}
      and not exists (
        select 1 from channel_settlements cs
        where cs.channel_id = c.id
          and cs.business_date = sd.business_date
          and cs.status = 'posted'
      )
    order by sd.business_date asc, st.name asc, c.name asc
    limit ${filter.limit ?? 100}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    salesDayId: String(r.sales_day_id),
    businessDate: String(r.business_date),
    storeId: String(r.store_id),
    storeName: String(r.store_name),
    channelId: String(r.channel_id),
    channelName: String(r.channel_name),
    reportedAmount: Number(r.reported_amount ?? 0).toFixed(2),
    destinationMoneyAccountId: (r.destination_money_account_id ?? null) as string | null,
    ageDays: Number(r.age_days ?? 0),
  }));
}

export interface SettlementListRow {
  id: string;
  businessDate: string;
  settledOn: string;
  storeName: string;
  channelName: string;
  grossAmount: string;
  outstandingCleared: string;
  feesTotal: string;
  loanDeduction: string;
  variance: string;
  settlementGain: string;
  netDeposited: string;
  destinationAccountName: string | null;
  reference: string | null;
  status: ChannelSettlementStatus;
  voidReason: string | null;
  journalEntryId: string | null;
}

/** Recent settlements, posted and voided alike — a void stays visible, it is not a delete. */
export async function listSettlements(
  tx: Tx,
  orgId: string,
  filter: { storeId?: string; limit?: number } = {},
): Promise<SettlementListRow[]> {
  const rows = (await tx.execute(sql`
    select cs.id::text, cs.business_date::text, cs.settled_on::text,
           st.name as store_name, c.name as channel_name,
           cs.gross_amount::text, cs.outstanding_cleared::text,
           (cs.commission + cs.marketing + cs.platform_fee + cs.vat_on_fees
            + cs.withholding_tax + cs.penalty)::text as fees_total,
           cs.loan_deduction::text, cs.variance::text, cs.settlement_gain::text,
           cs.net_deposited::text, ma.name as destination_account_name,
           cs.reference, cs.status, cs.void_reason, cs.journal_entry_id::text
    from channel_settlements cs
    join stores st on st.id = cs.store_id
    join sales_channels c on c.id = cs.channel_id
    left join money_accounts ma on ma.id = cs.destination_money_account_id
    where cs.org_id = ${orgId}
      ${filter.storeId ? sql`and cs.store_id = ${filter.storeId}` : sql``}
    order by cs.settled_on desc, cs.created_at desc
    limit ${filter.limit ?? 50}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    businessDate: String(r.business_date),
    settledOn: String(r.settled_on),
    storeName: String(r.store_name),
    channelName: String(r.channel_name),
    grossAmount: String(r.gross_amount),
    outstandingCleared: String(r.outstanding_cleared),
    feesTotal: String(r.fees_total),
    loanDeduction: String(r.loan_deduction),
    variance: String(r.variance),
    settlementGain: String(r.settlement_gain),
    netDeposited: String(r.net_deposited),
    destinationAccountName: (r.destination_account_name ?? null) as string | null,
    reference: (r.reference ?? null) as string | null,
    status: String(r.status) as ChannelSettlementStatus,
    voidReason: (r.void_reason ?? null) as string | null,
    journalEntryId: (r.journal_entry_id ?? null) as string | null,
  }));
}

/**
 * Point a channel at the account its payouts land in.
 *
 * ⚠️ The only writer of `sales_channels.destination_money_account_id` anywhere. Until DEF-137 the
 * column had **no writer at all** outside a test fixture, which is why no real channel could ever
 * be settled: the domain refuses a channel with nowhere to bank.
 */
export async function setDestinationAccount(
  tx: Tx,
  orgId: string,
  channelId: string,
  moneyAccountId: string,
): Promise<void> {
  await tx.execute(sql`
    update sales_channels
    set destination_money_account_id = ${moneyAccountId}, updated_at = now()
    where org_id = ${orgId} and id = ${channelId}
  `);
}

/**
 * Does this account demand a party on every line?
 *
 * ⚠️ Asked of the CHART rather than hard-coded. A platform payout lands wherever the channel is
 * configured to bank it, and `1140 E-wallet / online channels` requires a `money_account` party
 * while `1130 Cash on hand — office` does not. Hard-coding one would break the first time a
 * channel is pointed at the other.
 */
export async function accountRequiresParty(tx: Tx, orgId: string, code: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select requires_party from accounts where org_id = ${orgId} and code = ${code}
  `)) as unknown as Record<string, boolean>[];
  return Boolean(row?.requires_party);
}
