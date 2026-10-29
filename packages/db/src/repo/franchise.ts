/**
 * The franchisor's view of a franchisee - T-398 S6 (migration 0220). The only place this SQL is written.
 *
 * ## The one door
 *
 * A franchisor (Ian's company) reads a franchisee's (Padre Garcia's) sales and stock ONLY through the SECURITY DEFINER functions below. They check who is asking,
 * write the access-log row in the same statement as the read, and return a narrow, fixed set of columns. There is no table read of the franchisee's rows from the
 * franchisor's side (no cross-org policy exists on any business table). Every function here must run in a transaction that carries `app.org_id` AND
 * `app.person_id` (`withActorPrincipal`): the database refuses 42501, in words, without them.
 *
 * - Franchisor functions: {@link listFranchisees}, {@link salesDaily}, {@link stockLevels}.
 * - Franchisee-side functions: {@link listAccessLog} (a plain read of the franchisee's OWN log rows, `org_id = orgId`), {@link logBreakGlassApproval}
 *   (called by the PIN-approval verifiers, in their own transaction).
 *
 * Money and quantities are decimal strings straight from `numeric`, never `Number`.
 */
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { franchiseAccessLog, type FranchiseLogKind } from '../../schema/franchise';
import type { Tx } from '../client';

/** The person the transaction's principal carries (`app.person_id`, set by `withActorPrincipal`), or null. Used by the domain to refuse an actor that is not that person. */
export async function principalPersonId(tx: Tx): Promise<string | null> {
  const rows = (await tx.execute(sql`select nullif(current_setting('app.person_id', true), '') as person_id`)) as unknown as { person_id: string | null }[];
  return rows[0]?.person_id ?? null;
}

export interface FranchiseeRow {
  readonly franchiseeOrgId: string;
  readonly franchiseeName: string;
  /** YYYY-MM-DD: the first date the franchisor may see. */
  readonly salesVisibleFrom: string;
}

/** FRANCHISOR: `franchise_franchisees()` - the franchisees this organisation holds an agreement with. Person-checked by the database, not logged. */
export async function listFranchisees(tx: Tx): Promise<FranchiseeRow[]> {
  const rows = (await tx.execute(
    sql`select franchisee_org_id, franchisee_name, sales_visible_from::text as sales_visible_from from franchise_franchisees()`,
  )) as unknown as { franchisee_org_id: string; franchisee_name: string; sales_visible_from: string }[];
  return rows.map((r) => ({ franchiseeOrgId: r.franchisee_org_id, franchiseeName: r.franchisee_name, salesVisibleFrom: r.sales_visible_from }));
}

/** One row of `franchise_sales_daily`: a `day` row carries the day's money; a `channel` row carries only the channel name and amount. */
export interface FranchiseSalesRow {
  readonly rowKind: 'day' | 'channel';
  readonly storeId: string;
  readonly storeName: string;
  /** YYYY-MM-DD. */
  readonly businessDate: string;
  /** open / submitted / verified. Never voided (a voided day is not returned). */
  readonly dayStatus: string;
  readonly grossSales: string | null;
  readonly discounts: string | null;
  readonly comps: string | null;
  readonly refunds: string | null;
  readonly netSales: string | null;
  readonly cashCollected: string | null;
  readonly onlineCollected: string | null;
  readonly creditSales: string | null;
  readonly channelName: string | null;
  readonly channelAmount: string | null;
}

export interface SalesDailyInput {
  readonly franchiseeOrgId: string;
  /** YYYY-MM-DD, not before the agreement's sales_visible_from. */
  readonly from: string;
  /** YYYY-MM-DD, at most 366 days after `from`. */
  readonly to: string;
  readonly reason?: string | null;
}

/**
 * FRANCHISOR: `franchise_sales_daily`. ONE call is ONE access-log row (written by the database before the rows come back). A range before the agreement's
 * visible-from date, an end before the start, or more than 366 days is refused in words and logs nothing.
 */
export async function salesDaily(tx: Tx, input: SalesDailyInput): Promise<FranchiseSalesRow[]> {
  const rows = (await tx.execute(sql`
    select row_kind, store_id, store_name, business_date::text as business_date, day_status,
           gross_sales::text as gross_sales, discounts::text as discounts, comps::text as comps, refunds::text as refunds, net_sales::text as net_sales,
           cash_collected::text as cash_collected, online_collected::text as online_collected, credit_sales::text as credit_sales,
           channel_name, channel_amount::text as channel_amount
    from franchise_sales_daily(${input.franchiseeOrgId}::uuid, ${input.from}::date, ${input.to}::date, ${input.reason ?? null}::text)`)) as unknown as {
    row_kind: 'day' | 'channel';
    store_id: string;
    store_name: string;
    business_date: string;
    day_status: string;
    gross_sales: string | null;
    discounts: string | null;
    comps: string | null;
    refunds: string | null;
    net_sales: string | null;
    cash_collected: string | null;
    online_collected: string | null;
    credit_sales: string | null;
    channel_name: string | null;
    channel_amount: string | null;
  }[];
  return rows.map((r) => ({
    rowKind: r.row_kind,
    storeId: r.store_id,
    storeName: r.store_name,
    businessDate: r.business_date,
    dayStatus: r.day_status,
    grossSales: r.gross_sales,
    discounts: r.discounts,
    comps: r.comps,
    refunds: r.refunds,
    netSales: r.net_sales,
    cashCollected: r.cash_collected,
    onlineCollected: r.online_collected,
    creditSales: r.credit_sales,
    channelName: r.channel_name,
    channelAmount: r.channel_amount,
  }));
}

export interface FranchiseStockRow {
  readonly storeId: string;
  readonly storeName: string;
  readonly itemName: string;
  readonly baseUnit: string;
  /** Sum of the store's stock movements over all locations (numeric(14,3) as text). */
  readonly onHand: string;
  /** The franchisee's own low-stock line; null when it has none. */
  readonly threshold: string | null;
  /** At or below the line (never true without a line). */
  readonly belowThreshold: boolean;
  readonly asOf: Date;
}

export interface StockLevelsInput {
  readonly franchiseeOrgId: string;
  /** One franchisee store; omitted / null = every store. A store that is not the franchisee's is refused. */
  readonly storeId?: string | null;
  readonly reason?: string | null;
}

/** FRANCHISOR: `franchise_stock_levels`. ONE call is ONE access-log row. Active items with stock or a low-stock line; no cost, value, supplier or movement. */
export async function stockLevels(tx: Tx, input: StockLevelsInput): Promise<FranchiseStockRow[]> {
  const rows = (await tx.execute(sql`
    select store_id, store_name, item_name, base_unit, on_hand::text as on_hand, threshold::text as threshold, below_threshold, as_of
    from franchise_stock_levels(${input.franchiseeOrgId}::uuid, ${input.storeId ?? null}::uuid, ${input.reason ?? null}::text)`)) as unknown as {
    store_id: string;
    store_name: string;
    item_name: string;
    base_unit: string;
    on_hand: string;
    threshold: string | null;
    below_threshold: boolean;
    as_of: Date | string;
  }[];
  return rows.map((r) => ({
    storeId: r.store_id,
    storeName: r.store_name,
    itemName: r.item_name,
    baseUnit: r.base_unit,
    onHand: r.on_hand,
    threshold: r.threshold,
    belowThreshold: r.below_threshold,
    asOf: r.as_of instanceof Date ? r.as_of : new Date(r.as_of),
  }));
}

/**
 * FRANCHISEE side, in the approval's own transaction: `log_break_glass_approval`. Adds one `break_glass_approval` row iff `personId` is an agreement's franchisor
 * person (and the caller's organisation is that franchisee); otherwise a no-op. Returns whether a row was added. Forging it can only ADD a row.
 */
export async function logBreakGlassApproval(tx: Tx, personId: string, capability: string, storeId: string | null): Promise<boolean> {
  const rows = (await tx.execute(
    sql`select log_break_glass_approval(${personId}::uuid, ${capability}::text, ${storeId}::uuid) as logged`,
  )) as unknown as { logged: boolean }[];
  return rows[0]?.logged === true;
}

/**
 * The approval verifiers' entry point. `log_break_glass_approval` refuses 42501 unless `app.person_id` is the approver himself, and the verifier's lookup
 * transaction carries the org only. So this sets the person to the PIN's OWNER, calls the logger, and puts back whatever `app.person_id` held before -
 * the setting is transaction-local and is restored, so the rest of the caller's transaction runs as the same person it did before. Returns whether a row was added.
 */
export async function logBreakGlassApprovalAsApprover(tx: Tx, approverPersonId: string, capability: string, storeId: string | null): Promise<boolean> {
  const prior = (await tx.execute(sql`select coalesce(current_setting('app.person_id', true), '') as p`)) as unknown as { p: string }[];
  await tx.execute(sql`select set_config('app.person_id', ${approverPersonId}, true)`);
  const logged = await logBreakGlassApproval(tx, approverPersonId, capability, storeId);
  await tx.execute(sql`select set_config('app.person_id', ${prior[0]?.p ?? ''}, true)`);
  return logged;
}

export interface AccessLogRow {
  readonly id: string;
  readonly what: FranchiseLogKind;
  readonly personName: string;
  readonly readerPersonId: string | null;
  readonly franchiseePersonId: string | null;
  readonly rangeFrom: string | null;
  readonly rangeTo: string | null;
  readonly storeId: string | null;
  readonly sessionId: string | null;
  readonly credentialKind: string | null;
  readonly capability: string | null;
  readonly rowsReturned: number | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export interface AccessLogFilter {
  /** Inclusive lower bound on occurred_at. */
  readonly from?: Date;
  /** Exclusive upper bound on occurred_at. */
  readonly to?: Date;
  readonly what?: FranchiseLogKind;
  /** Default 200, at most 500. */
  readonly limit?: number;
}

/** FRANCHISEE: its OWN log rows (`org_id = orgId`), newest first. The filter names the organisation explicitly; RLS is the backstop, not the filter. */
export async function listAccessLog(tx: Tx, orgId: string, filter: AccessLogFilter = {}): Promise<AccessLogRow[]> {
  const t = franchiseAccessLog;
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  const rows = await tx
    .select({
      id: t.id,
      what: t.what,
      personName: t.personName,
      readerPersonId: t.readerPersonId,
      franchiseePersonId: t.franchiseePersonId,
      rangeFrom: t.rangeFrom,
      rangeTo: t.rangeTo,
      storeId: t.storeId,
      sessionId: t.sessionId,
      credentialKind: t.credentialKind,
      capability: t.capability,
      rowsReturned: t.rowsReturned,
      reason: t.reason,
      occurredAt: t.occurredAt,
    })
    .from(t)
    .where(
      and(
        eq(t.orgId, orgId),
        filter.from ? gte(t.occurredAt, filter.from) : undefined,
        filter.to ? lt(t.occurredAt, filter.to) : undefined,
        filter.what ? eq(t.what, filter.what) : undefined,
      ),
    )
    .orderBy(desc(t.occurredAt), desc(t.id))
    .limit(limit);
  return rows;
}

/**
 * T-398 S7b: the franchise agreement row, written by the onboarding CLI's owner transaction ONLY. The app role has SELECT and nothing more (migration 0220);
 * nothing a request can reach calls this.
 */
export async function insertAgreement(
  tx: Tx,
  input: { franchiseeOrgId: string; franchisorOrgId: string; franchisorPersonId: string; salesVisibleFrom: string },
): Promise<{ id: string }> {
  const rows = (await tx.execute(sql`
    insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from)
    values (${input.franchiseeOrgId}, ${input.franchisorOrgId}, ${input.franchisorPersonId}, ${input.salesVisibleFrom})
    returning id
  `)) as unknown as { id: string }[];
  return { id: String(rows[0]!.id) };
}

/** The franchisee's agreement (id, franchisor org, the franchisor's own person in the franchisee), or undefined: the onboarding re-run check and the way to find that person. */
export async function getAgreement(
  tx: Tx,
  franchiseeOrgId: string,
): Promise<{ id: string; franchisorOrgId: string; franchisorPersonId: string } | undefined> {
  const rows = (await tx.execute(sql`
    select id, franchisor_org_id, franchisor_person_id from franchise_agreements where org_id = ${franchiseeOrgId} limit 1
  `)) as unknown as { id: string; franchisor_org_id: string; franchisor_person_id: string }[];
  const r = rows[0];
  return r ? { id: String(r.id), franchisorOrgId: String(r.franchisor_org_id), franchisorPersonId: String(r.franchisor_person_id) } : undefined;
}
