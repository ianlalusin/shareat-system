/**
 * The only place SQL is written for channel settlement. T-150.
 *
 * ⛔ **Nothing is stored that the ledger can answer.** What a channel still owes is a query over
 * `1220` by party, exactly as AP and AR do it — the same discipline that found v1's 13.3% drift in
 * a maintained `outstandingAmount`.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
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
  status: ChannelSettlementStatus;
  journalEntryId: string | null;
  createdBy: string;
}

export async function insertSettlement(
  tx: Tx,
  input: Omit<ChannelSettlementRow, 'id' | 'status' | 'journalEntryId'>,
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
