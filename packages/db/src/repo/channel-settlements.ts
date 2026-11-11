/**
 * The only place SQL is written for channel settlement. T-150.
 *
 * ⛔ **Nothing is stored that the ledger can answer.** What a channel still owes is a query over
 * `1220` by party, exactly as AP and AR do it — the same discipline that found v1's 13.3% drift in
 * a maintained `outstandingAmount`.
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
// ⛔ T-218 — Manila, never bare current_date (DEF-172).
import { MANILA_TODAY } from './sql-time';
import type { Tx } from '../client';
import type { Money } from '@shareat/core/money';
import type { SafeInsert } from './numeric-input';
import {
  channelSettlementLoanLegs,
  channelSettlements,
  type ChannelSettlementStatus,
} from '../../schema/channel-settlements';
import { channelPeriodCharges, channelSettlementChargeLinks } from '../../schema/settlement-intake';

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

/**
 * T-511 S6a: one loan a settlement docked. `ownerStoreId` is never null: a same-store leg carries the paying store's own id.
 * The legs add up to the settlement's `loanDeduction` (a deferred trigger holds that at commit).
 */
export interface SettlementLoanLegRow {
  loanId: string;
  ownerStoreId: string;
  amount: string;
}

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
  /** The loans this payout repaid, oldest first as written; empty when it deducted none. They add up to `loanDeduction`. */
  loanLegs: SettlementLoanLegRow[];
  /** Why a person accepted a difference past tolerance (either sign); null when none was needed. */
  differenceReason: string | null;
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
  | 'differenceReason'
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

export type NewLoanLeg = { loanId: string; ownerStoreId: string; amount: Money };

/** Writes a settlement's legs, one per (loan, owner store), in one statement. Called in the same transaction as the header: a deferred trigger checks the sum at commit. */
export async function insertLoanLegs(tx: Tx, orgId: string, settlementId: string, legs: readonly NewLoanLeg[]): Promise<void> {
  if (legs.length === 0) return;
  // One statement, so the id order is the order of `legs`.
  await tx
    .insert(channelSettlementLoanLegs)
    .values(legs.map((l) => ({ orgId, settlementId, loanId: l.loanId, ownerStoreId: l.ownerStoreId, amount: l.amount })));
}

/** The legs of these settlements, in the order they were written. ⚠️ `id` is uuidv7, so ordering by it is the order of insertion; a leg is never updated. */
async function legsOf(tx: Tx, orgId: string, settlementIds: readonly string[]): Promise<Map<string, SettlementLoanLegRow[]>> {
  const out = new Map<string, SettlementLoanLegRow[]>();
  if (settlementIds.length === 0) return out;
  const rows = await tx
    .select({
      settlementId: channelSettlementLoanLegs.settlementId,
      loanId: channelSettlementLoanLegs.loanId,
      ownerStoreId: channelSettlementLoanLegs.ownerStoreId,
      amount: channelSettlementLoanLegs.amount,
    })
    .from(channelSettlementLoanLegs)
    .where(and(eq(channelSettlementLoanLegs.orgId, orgId), inArray(channelSettlementLoanLegs.settlementId, [...settlementIds])))
    .orderBy(asc(channelSettlementLoanLegs.id));
  for (const r of rows) {
    const list = out.get(r.settlementId) ?? [];
    list.push({ loanId: r.loanId, ownerStoreId: r.ownerStoreId, amount: r.amount });
    out.set(r.settlementId, list);
  }
  return out;
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
  if (!row) return undefined;
  const legs = await legsOf(tx, orgId, [id]);
  return { ...row, loanLegs: legs.get(id) ?? [] } as ChannelSettlementRow;
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
): Promise<boolean> {
  // Guarded in the WHERE (status = 'posted'), not read-then-write: two voids racing must not both write, and the first reason and voider are never overwritten.
  const rows = await tx
    .update(channelSettlements)
    .set({
      status: 'voided',
      voidedBy: values.voidedBy,
      voidedAt: sql`now()`,
      voidReason: values.voidReason,
      updatedAt: sql`now()`,
    })
    .where(and(eq(channelSettlements.orgId, orgId), eq(channelSettlements.id, id), eq(channelSettlements.status, 'posted')))
    .returning({ id: channelSettlements.id });
  return rows.length > 0;
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
  /** The loans this payout repaid (same shape as `ChannelSettlementRow.loanLegs`); empty when it deducted none. */
  loanLegs: SettlementLoanLegRow[];
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

  const legs = await legsOf(tx, orgId, rows.map((r) => String(r.id)));
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
    loanLegs: legs.get(String(r.id)) ?? [],
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

// -------------------------------------------------------------------------------------
// T-511 S6c: platform charges booked with no sales day (`postPlatformCharge`), and the payouts that net them. Both tables are append-only: insert and read, never update,
// and NEVER `FOR UPDATE` (the guard trigger and the lock would fight): serialisation is the advisory locks.
// -------------------------------------------------------------------------------------

export type PeriodChargeRow = typeof channelPeriodCharges.$inferSelect;
/** The three figures are `Money` brands (numeric(14,2)), spelled out so the T-371 write guard can see their shape. */
export interface InsertPeriodChargeInput {
  id: string;
  orgId: string;
  storeId: string;
  channelId: string;
  otherLineId: string;
  uploadId: string;
  chargeDate: string;
  netAmount: Money;
  vatAmount: Money;
  totalAmount: Money;
  entryDate: string;
  journalEntryId: string;
  description: string | null;
  postedBy: string;
}

/** The charge already booked for this staged other line, or null. */
export async function chargeForOtherLine(tx: Tx, orgId: string, otherLineId: string): Promise<PeriodChargeRow | null> {
  const [row] = await tx
    .select()
    .from(channelPeriodCharges)
    .where(and(eq(channelPeriodCharges.orgId, orgId), eq(channelPeriodCharges.otherLineId, otherLineId)))
    .limit(1);
  return row ?? null;
}

/**
 * A charge already booked for a DIFFERENT staged line that looks like the same one (same store, channel, date, net amount and description): the copy a re-uploaded,
 * changed file stages again. Ingest supersedes the old upload but never retires its period lines, so this is the only guard once the first copy is booked.
 */
export async function bookedCopyOfCharge(
  tx: Tx,
  orgId: string,
  c: { otherLineId: string; storeId: string; channelId: string; chargeDate: string; netAmount: string; description: string | null },
): Promise<PeriodChargeRow | null> {
  const [row] = await tx
    .select()
    .from(channelPeriodCharges)
    .where(
      and(
        eq(channelPeriodCharges.orgId, orgId),
        eq(channelPeriodCharges.storeId, c.storeId),
        eq(channelPeriodCharges.channelId, c.channelId),
        eq(channelPeriodCharges.chargeDate, c.chargeDate),
        eq(channelPeriodCharges.netAmount, c.netAmount),
        sql`${channelPeriodCharges.description} is not distinct from ${c.description}`,
        ne(channelPeriodCharges.otherLineId, c.otherLineId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function insertPeriodCharge(tx: Tx, input: InsertPeriodChargeInput): Promise<void> {
  // `posted_at` is the statement's own clock, as every other append-only posting document here.
  await tx.insert(channelPeriodCharges).values({ ...input, postedAt: sql`clock_timestamp()` });
}

/** A booked charge as a payout sees it: its channel, store and total, and the live settlement (not voided) that already netted it, if any. */
export interface NettableChargeRow {
  id: string;
  channelId: string;
  storeId: string;
  totalAmount: string;
  chargeDate: string;
  nettedBySettlementId: string | null;
}

/** The booked charges among `ids` in this org (an unknown id, a staged line's id and another org's id are simply absent). A link counts only through a settlement that is not voided. */
export async function chargesForNetting(tx: Tx, orgId: string, ids: readonly string[]): Promise<NettableChargeRow[]> {
  if (ids.length === 0) return [];
  const charges = await tx
    .select({
      id: channelPeriodCharges.id,
      channelId: channelPeriodCharges.channelId,
      storeId: channelPeriodCharges.storeId,
      totalAmount: channelPeriodCharges.totalAmount,
      chargeDate: channelPeriodCharges.chargeDate,
    })
    .from(channelPeriodCharges)
    .where(and(eq(channelPeriodCharges.orgId, orgId), inArray(channelPeriodCharges.id, [...ids])));
  if (charges.length === 0) return [];
  const live = await tx
    .select({ chargeId: channelSettlementChargeLinks.chargeId, settlementId: channelSettlementChargeLinks.settlementId })
    .from(channelSettlementChargeLinks)
    .innerJoin(
      channelSettlements,
      and(eq(channelSettlements.orgId, channelSettlementChargeLinks.orgId), eq(channelSettlements.id, channelSettlementChargeLinks.settlementId)),
    )
    .where(and(eq(channelSettlementChargeLinks.orgId, orgId), inArray(channelSettlementChargeLinks.chargeId, charges.map((c) => c.id)), ne(channelSettlements.status, 'voided')));
  const by = new Map(live.map((l) => [l.chargeId, l.settlementId]));
  return charges.map((c) => ({ ...c, nettedBySettlementId: by.get(c.id) ?? null }));
}

/** Writes the links of a settlement to the charges it netted, in one statement. Called in the same transaction as the settlement. */
export async function insertChargeLinks(tx: Tx, orgId: string, settlementId: string, chargeIds: readonly string[]): Promise<void> {
  if (chargeIds.length === 0) return;
  await tx.insert(channelSettlementChargeLinks).values(chargeIds.map((chargeId) => ({ orgId, settlementId, chargeId })));
}
