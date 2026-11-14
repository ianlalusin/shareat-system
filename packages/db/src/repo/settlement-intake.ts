/**
 * The only place SQL is written for the settlement upload staging tables. T-511 S4 (docs/tasks/511-settlement-upload-s4-spec.md).
 *
 * The four tables (migration 0228) are append-style: a re-upload inserts a new version and retires the old one, nothing is deleted
 * and no money column is ever updated (the app role has UPDATE only on `superseded_by`, `is_current` and the review columns).
 * Every function takes the org and filters by it; RLS backstops (bible section 15.11). Nothing here posts to the books.
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { money, type Money } from '@shareat/core/money';
import type { Tx } from '../client';
import {
  salesDayPlatformCorrections,
  settlementDayLines,
  settlementLoanLines,
  settlementOtherLines,
  settlementUploads,
  type SettlementFileKind,
  type SettlementLoanLineKind,
  type SettlementOtherBookedAs,
  type SettlementOtherLineKind,
  type SettlementPaidState,
  type SettlementPlatform,
} from '../../schema/settlement-intake';

/** Reused, not re-written: the one lookup of a channel by the code a platform file carries. */
export { channelByPlatformCode } from './sales-days';

/** `uploadedOn` is the Manila date of `uploaded_at`, worked out in SQL so no caller touches the process clock. */
const UPLOAD_COLUMNS = {
  ...getTableColumns(settlementUploads),
  uploadedOn: sql<string>`(${settlementUploads.uploadedAt} at time zone 'Asia/Manila')::date::text`,
};
export type UploadRow = typeof settlementUploads.$inferSelect & { uploadedOn: string };
export type DayLineRow = typeof settlementDayLines.$inferSelect;
export type LoanLineRow = typeof settlementLoanLines.$inferSelect;
export type OtherLineRow = typeof settlementOtherLines.$inferSelect;

export interface InsertUploadInput {
  channelId: string;
  storeId: string;
  platform: SettlementPlatform;
  fileKind: SettlementFileKind;
  fileId: string;
  pdfFileId: string | null;
  fingerprint: string;
  readerVersion: string;
  matchedCode: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  invoiceNumber: string | null;
  ordersRead: number;
  loanRowsRead: number;
  otherRowsRead: number;
  uploadedBy: string;
}

export interface InsertDayLineInput {
  channelId: string;
  storeId: string;
  platform: SettlementPlatform;
  salesDate: string;
  version: number;
  sourceUploadId: string;
  payoutUploadId: string | null;
  orderValue: Money;
  grossInfo: Money;
  commission: Money;
  marketing: Money;
  platformFee: Money;
  vendorDiscount: Money;
  loanDeduction: Money;
  loanDisbursal: Money;
  netPayout: Money;
  unexplained: Money;
  recordedFigure: Money | null;
  difference: Money | null;
  payoutReference: string | null;
  payoutDate: string | null;
  paymentArrivalDate: string | null;
  paidState: SettlementPaidState;
  feeMonthNote: string | null;
  changedSinceBooked: boolean;
}

export interface InsertLoanLineInput {
  kind: SettlementLoanLineKind;
  amount: Money;
  rowOrdinal: number;
}

export interface InsertOtherLineInput {
  kind: SettlementOtherLineKind;
  bookedAs: SettlementOtherBookedAs;
  amount: Money;
  lineDate: string | null;
  description: string | null;
  /** T-511 S6c: the staged VAT of a `period_charge` line; absent or null is stored NULL. */
  vat?: Money | null;
}

async function uploadById(tx: Tx, orgId: string, id: string): Promise<UploadRow> {
  const [row] = await tx
    .select(UPLOAD_COLUMNS)
    .from(settlementUploads)
    .where(and(eq(settlementUploads.orgId, orgId), eq(settlementUploads.id, id)))
    .limit(1);
  return row!;
}

/** The earlier upload of exactly these bytes in the org, or null. */
export async function findUploadByFingerprint(tx: Tx, orgId: string, fingerprint: string): Promise<UploadRow | null> {
  const [row] = await tx
    .select(UPLOAD_COLUMNS)
    .from(settlementUploads)
    .where(and(eq(settlementUploads.orgId, orgId), eq(settlementUploads.fingerprint, fingerprint)))
    .limit(1);
  return row ?? null;
}

/** A repeat fingerprint in the org returns the EARLIER row with `created` false and writes nothing (the unique `(org_id, fingerprint)` decides). */
export async function insertUpload(tx: Tx, orgId: string, input: InsertUploadInput): Promise<{ row: UploadRow; created: boolean }> {
  const [inserted] = await tx
    .insert(settlementUploads)
    .values({ ...input, orgId })
    .onConflictDoNothing({ target: [settlementUploads.orgId, settlementUploads.fingerprint] })
    .returning({ id: settlementUploads.id });
  if (inserted) return { row: await uploadById(tx, orgId, inserted.id), created: true };
  return { row: (await findUploadByFingerprint(tx, orgId, input.fingerprint))!, created: false };
}

/** The not-yet-superseded uploads of one channel and kind, newest first. */
export async function findCurrentUploads(tx: Tx, orgId: string, channelId: string, fileKind: SettlementFileKind): Promise<UploadRow[]> {
  return tx
    .select(UPLOAD_COLUMNS)
    .from(settlementUploads)
    .where(
      and(
        eq(settlementUploads.orgId, orgId),
        eq(settlementUploads.channelId, channelId),
        eq(settlementUploads.fileKind, fileKind),
        isNull(settlementUploads.supersededBy),
      ),
    )
    .orderBy(desc(settlementUploads.uploadedAt), desc(settlementUploads.id));
}

/** `superseded_by` is the only updatable upload column. */
export async function markSuperseded(tx: Tx, orgId: string, uploadId: string, supersededBy: string): Promise<void> {
  await tx
    .update(settlementUploads)
    .set({ supersededBy })
    .where(and(eq(settlementUploads.orgId, orgId), eq(settlementUploads.id, uploadId)));
}

/** The one current line of a channel on a sales date, or null. */
export async function currentLine(tx: Tx, orgId: string, channelId: string, salesDate: string): Promise<DayLineRow | null> {
  const [row] = await tx
    .select()
    .from(settlementDayLines)
    .where(
      and(
        eq(settlementDayLines.orgId, orgId),
        eq(settlementDayLines.channelId, channelId),
        eq(settlementDayLines.salesDate, salesDate),
        eq(settlementDayLines.isCurrent, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** How many sales dates of one channel hold a current line inside a period (the days a replacing file is measured against). */
export async function countCurrentDaysInPeriod(tx: Tx, orgId: string, channelId: string, from: string, to: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(settlementDayLines)
    .where(
      and(
        eq(settlementDayLines.orgId, orgId),
        eq(settlementDayLines.channelId, channelId),
        eq(settlementDayLines.isCurrent, true),
        gte(settlementDayLines.salesDate, from),
        lte(settlementDayLines.salesDate, to),
      ),
    );
  return row?.n ?? 0;
}

/** A new version of a day. The caller retires the old current line first (the unique current index refuses two). */
export async function insertDayLineVersion(tx: Tx, orgId: string, input: InsertDayLineInput): Promise<DayLineRow> {
  const [row] = await tx
    .insert(settlementDayLines)
    .values({ ...input, orgId })
    .returning();
  return row!;
}

/** Flips `is_current` only; every figure of the retired version stays as it was. */
export async function retireCurrentLine(tx: Tx, orgId: string, lineId: string): Promise<void> {
  await tx
    .update(settlementDayLines)
    .set({ isCurrent: false })
    .where(and(eq(settlementDayLines.orgId, orgId), eq(settlementDayLines.id, lineId)));
}

/** Loan legs of a day, stored unallocated (`loan_id` stays null; slice 5 allocates). */
export async function insertLoanLines(tx: Tx, orgId: string, dayLineId: string, lines: readonly InsertLoanLineInput[]): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(settlementLoanLines).values(lines.map((l) => ({ ...l, orgId, dayLineId })));
}

/** Adjustments, charges and the like; `dayLineId` null is a period-level line (PandaGO). */
export async function insertOtherLines(
  tx: Tx,
  orgId: string,
  uploadId: string,
  dayLineId: string | null,
  lines: readonly InsertOtherLineInput[],
): Promise<void> {
  if (lines.length === 0) return;
  await tx.insert(settlementOtherLines).values(
    lines.map(({ vat, ...l }) => ({ ...l, vatAmount: vat ?? null, orgId, uploadId, dayLineId })),
  );
}

/**
 * What staff recorded for a channel and date: the channel amount of a VERIFIED day that is not no-sales, else null. `verified` and `noSales`
 * say why a figure is missing (an open or missing day is waiting for verification; a no-sales day is a confirmed zero).
 */
export async function salesDayFigure(
  tx: Tx,
  orgId: string,
  channelId: string,
  salesDate: string,
): Promise<{ recorded: Money | null; verified: boolean; noSales: boolean }> {
  const rows = (await tx.execute(sql`
    select sd.status, sdc.no_sales, sdc.amount::text as amount
      from sales_day_channels sdc
      join sales_days sd on sd.id = sdc.sales_day_id
     where sd.org_id = ${orgId} and sdc.channel_id = ${channelId} and sd.business_date = ${salesDate}
     limit 1
  `)) as unknown as { status: string; no_sales: boolean; amount: string }[];
  const r = rows[0];
  if (!r) return { recorded: null, verified: false, noSales: false };
  const verified = r.status === 'verified';
  return { recorded: verified && !r.no_sales ? money(r.amount) : null, verified, noSales: r.no_sales };
}

/** The sales-day figures of many (channel, date) pairs in one read, keyed `${channelId}|${date}`; a pair with no row is missing from the map (read it as `salesDayFigure` of no day). */
export async function salesDayFiguresMany(
  tx: Tx,
  orgId: string,
  pairs: readonly { channelId: string; salesDate: string }[],
): Promise<Map<string, { recorded: Money | null; verified: boolean; noSales: boolean; unposted: boolean }>> {
  const out = new Map<string, { recorded: Money | null; verified: boolean; noSales: boolean; unposted: boolean }>();
  if (pairs.length === 0) return out;
  const channels = [...new Set(pairs.map((p) => p.channelId))];
  const dates = pairs.map((p) => p.salesDate).sort();
  const rows = (await tx.execute(sql`
    select sdc.channel_id::text as channel_id, sd.business_date::text as business_date, sd.status, sdc.no_sales, sdc.amount::text as amount, (sd.journal_entry_id is null) as no_entry
      from sales_day_channels sdc
      join sales_days sd on sd.id = sdc.sales_day_id
     where sd.org_id = ${orgId} and sdc.channel_id in (${sql.join(channels.map((id) => sql`${id}`), sql`, `)})
       and sd.business_date >= ${dates[0]!} and sd.business_date <= ${dates[dates.length - 1]!}
  `)) as unknown as { channel_id: string; business_date: string; status: string; no_sales: boolean; amount: string; no_entry: boolean }[];
  for (const r of rows) {
    const key = `${r.channel_id}|${r.business_date}`;
    if (out.has(key)) continue; // salesDayFigure takes the first row it finds; so does this
    const verified = r.status === 'verified';
    // `unposted` (T-511 S7a): a verified day with no journal entry, so a platform correction has nothing to replace
    out.set(key, { recorded: verified && !r.no_sales ? money(r.amount) : null, verified, noSales: r.no_sales, unposted: verified && r.no_entry });
  }
  return out;
}

/** The one rule of "staff recorded sales that day": a VERIFIED sales day, not no-sales, channel amount above zero. The "no file yet" list and the loan check's "who is waited on" both use it. */
const RECORDED_SALES = sql`sd.status = 'verified' and sdc.no_sales = false and sdc.amount > 0`;

/** The "no file yet" list of several channels at once: verified days with sales that hold no current staged line, oldest first. */
export async function daysWithRecordedSalesAndNoLineMany(tx: Tx, orgId: string, channelIds: readonly string[]): Promise<{ channelId: string; date: string }[]> {
  if (channelIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    select sdc.channel_id::text as channel_id, sd.business_date::text as business_date
      from sales_day_channels sdc
      join sales_days sd on sd.id = sdc.sales_day_id
     where sd.org_id = ${orgId} and sdc.channel_id in (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})
       and ${RECORDED_SALES}
       and not exists (
         select 1 from settlement_day_lines l
          where l.org_id = sd.org_id and l.channel_id = sdc.channel_id and l.sales_date = sd.business_date and l.is_current
       )
     order by sd.business_date
  `)) as unknown as { channel_id: string; business_date: string }[];
  return rows.map((r) => ({ channelId: r.channel_id, date: r.business_date }));
}

/** The "no file yet" list: verified days with sales on a channel that hold no current staged line, oldest first. */
export async function daysWithRecordedSalesAndNoLine(tx: Tx, orgId: string, channelId: string): Promise<string[]> {
  return (await daysWithRecordedSalesAndNoLineMany(tx, orgId, [channelId])).map((r) => r.date);
}

export interface PlatformChannelRow {
  id: string;
  name: string;
  storeId: string;
  storeName: string;
  platform: SettlementPlatform;
}

/** The active channels that carry a Grab or Foodpanda code (the ones a settlement file can belong to), by store then channel name. */
export async function listPlatformChannels(tx: Tx, orgId: string): Promise<PlatformChannelRow[]> {
  const rows = (await tx.execute(sql`
    select c.id::text as id, c.name, c.store_id::text as store_id, s.name as store_name, c.platform
      from sales_channels c
      join stores s on s.org_id = c.org_id and s.id = c.store_id
     where c.org_id = ${orgId} and c.is_active and c.platform is not null
     order by s.name, c.name
  `)) as unknown as { id: string; name: string; store_id: string; store_name: string; platform: SettlementPlatform }[];
  return rows.map((r) => ({ id: r.id, name: r.name, storeId: r.store_id, storeName: r.store_name, platform: r.platform }));
}

/* ------------------------------------------------------------------ T-511 S5b: the review stage (reads, the decision writes, the loan check's inputs) */

/** One upload by id, or null (another org's id is null too). */
export async function findUploadById(tx: Tx, orgId: string, id: string): Promise<UploadRow | null> {
  const [row] = await tx
    .select(UPLOAD_COLUMNS)
    .from(settlementUploads)
    .where(and(eq(settlementUploads.orgId, orgId), eq(settlementUploads.id, id)))
    .limit(1);
  return row ?? null;
}

/** One day line by id (current or not), or null. `forUpdate` takes the row lock so a second writer waits and re-reads. */
export async function dayLineById(tx: Tx, orgId: string, id: string, opts: { forUpdate?: boolean } = {}): Promise<DayLineRow | null> {
  const q = tx
    .select()
    .from(settlementDayLines)
    .where(and(eq(settlementDayLines.orgId, orgId), eq(settlementDayLines.id, id)))
    .limit(1);
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export interface ReviewListFilter {
  storeIds: readonly string[];
  platform?: SettlementPlatform;
  /** YYYY-MM, the month of the sales date */
  period?: string;
}

/** The current line of every day in the given stores, oldest sales date first. Superseded versions are never returned. */
export async function currentLinesForReview(tx: Tx, orgId: string, filter: ReviewListFilter): Promise<DayLineRow[]> {
  if (filter.storeIds.length === 0) return [];
  const conditions = [
    eq(settlementDayLines.orgId, orgId),
    eq(settlementDayLines.isCurrent, true),
    inArray(settlementDayLines.storeId, [...filter.storeIds]),
  ];
  if (filter.platform) conditions.push(eq(settlementDayLines.platform, filter.platform));
  if (filter.period) conditions.push(sql`to_char(${settlementDayLines.salesDate}, 'YYYY-MM') = ${filter.period}`);
  return tx
    .select()
    .from(settlementDayLines)
    .where(and(...conditions))
    .orderBy(asc(settlementDayLines.salesDate), asc(settlementDayLines.id));
}

export async function loanLinesOf(tx: Tx, orgId: string, dayLineId: string, opts: { activeOnly?: boolean } = {}): Promise<LoanLineRow[]> {
  const conditions = [eq(settlementLoanLines.orgId, orgId), eq(settlementLoanLines.dayLineId, dayLineId)];
  if (opts.activeOnly) conditions.push(eq(settlementLoanLines.isActive, true));
  return tx.select().from(settlementLoanLines).where(and(...conditions)).orderBy(asc(settlementLoanLines.rowOrdinal), asc(settlementLoanLines.id));
}

export async function otherLinesOf(tx: Tx, orgId: string, dayLineId: string): Promise<OtherLineRow[]> {
  return tx
    .select()
    .from(settlementOtherLines)
    .where(and(eq(settlementOtherLines.orgId, orgId), eq(settlementOtherLines.dayLineId, dayLineId)))
    .orderBy(asc(settlementOtherLines.id));
}

export interface DeductionRowRecord {
  /** the loan line's id: unique per row, the key the loan check allocates */
  key: string;
  dayLineId: string;
  storeId: string;
  salesDate: string;
  reviewState: 'pending' | 'booked' | 'rejected';
  amount: Money;
  /** set only by an admin override; an automatic line has no loan yet */
  loanId: string | null;
}

/** Every ACTIVE deduction loan line of every CURRENT Grab day line of the org with a sales date up to `throughDate`: the loan check's rows, all stores. */
export async function activeDeductionRows(tx: Tx, orgId: string, throughDate: string): Promise<DeductionRowRecord[]> {
  const rows = (await tx.execute(sql`
    select ll.id::text as key, l.id::text as day_line_id, l.store_id::text as store_id, l.sales_date::text as sales_date, l.review_state,
           ll.amount::text as amount, ll.loan_id::text as loan_id, ll.allocation_source
      from settlement_loan_lines ll
      join settlement_day_lines l on l.org_id = ll.org_id and l.id = ll.day_line_id
     where ll.org_id = ${orgId} and ll.is_active and ll.kind = 'deduction'
       and l.is_current and l.platform = 'grab' and l.sales_date <= ${throughDate}
     order by l.sales_date, l.store_id, ll.row_ordinal, ll.id
  `)) as unknown as { key: string; day_line_id: string; store_id: string; sales_date: string; review_state: DeductionRowRecord['reviewState']; amount: string; loan_id: string | null; allocation_source: string }[];
  return rows.map((r) => ({
    key: r.key, dayLineId: r.day_line_id, storeId: r.store_id, salesDate: r.sales_date, reviewState: r.review_state, amount: money(r.amount),
    loanId: r.allocation_source === 'admin' ? r.loan_id : null,
  }));
}

export interface GrabStoreCoverage {
  storeId: string;
  storeName: string;
  /** a current Grab upload of this store covers the date */
  covered: boolean;
  /** the store holds a current day line for the date */
  hasLine: boolean;
  /** staff recorded Grab sales that day (the rule of the "no file yet" list). A store with none was closed or not open yet, and is never waited on. */
  hasSales: boolean;
}

/** For each store with an active Grab channel and each date: does a current Grab file cover it, is there a current day line, did staff record sales. One read for all the dates. */
export async function grabStoreCoverageForDates(tx: Tx, orgId: string, salesDates: readonly string[]): Promise<Map<string, GrabStoreCoverage[]>> {
  const out = new Map<string, GrabStoreCoverage[]>();
  const dates = [...new Set(salesDates)];
  if (dates.length === 0) return out;
  const rows = (await tx.execute(sql`
    select v.d::text as sales_date, c.store_id::text as store_id, s.name as store_name,
           exists (select 1 from settlement_uploads u
                    where u.org_id = c.org_id and u.channel_id = c.id and u.superseded_by is null
                      and u.file_kind in ('grab_transactions', 'grab_transfers')
                      and u.period_from <= v.d and u.period_to >= v.d) as covered,
           exists (select 1 from settlement_day_lines l
                    where l.org_id = c.org_id and l.channel_id = c.id and l.sales_date = v.d and l.is_current) as has_line,
           exists (select 1 from sales_day_channels sdc join sales_days sd on sd.id = sdc.sales_day_id
                    where sd.org_id = c.org_id and sdc.channel_id = c.id and sd.business_date = v.d and ${RECORDED_SALES}) as has_sales
      from (values ${sql.join(dates.map((d) => sql`(${d}::date)`), sql`, `)}) as v(d)
      cross join sales_channels c
      join stores s on s.org_id = c.org_id and s.id = c.store_id
     where c.org_id = ${orgId} and c.is_active and c.platform = 'grab'
     order by v.d, s.name, c.id
  `)) as unknown as { sales_date: string; store_id: string; store_name: string; covered: boolean; has_line: boolean; has_sales: boolean }[];
  for (const r of rows) {
    const list = out.get(r.sales_date) ?? [];
    list.push({ storeId: r.store_id, storeName: r.store_name, covered: r.covered, hasLine: r.has_line, hasSales: r.has_sales });
    out.set(r.sales_date, list);
  }
  return out;
}

/** For each store with an active Grab channel: does a current Grab file cover the date, is there a current day line for it, did staff record sales. */
export async function grabStoreCoverage(tx: Tx, orgId: string, salesDate: string): Promise<GrabStoreCoverage[]> {
  return (await grabStoreCoverageForDates(tx, orgId, [salesDate])).get(salesDate) ?? [];
}

/** Several uploads by id in one read (an id of another org is simply missing). */
export async function findUploadsByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<Map<string, UploadRow>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select(UPLOAD_COLUMNS)
    .from(settlementUploads)
    .where(and(eq(settlementUploads.orgId, orgId), inArray(settlementUploads.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The (channel, date) pairs among these channels and dates that hold a POSTED channel settlement, keyed `${channelId}|${date}` (what `postedSettlementFor` asks, for many days at once). */
export async function postedSettlementKeys(tx: Tx, orgId: string, channelIds: readonly string[], dates: readonly string[]): Promise<Set<string>> {
  if (channelIds.length === 0 || dates.length === 0) return new Set();
  const sorted = [...dates].sort();
  const rows = (await tx.execute(sql`
    select channel_id::text as channel_id, business_date::text as business_date from channel_settlements
     where org_id = ${orgId} and status = 'posted' and channel_id in (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})
       and business_date >= ${sorted[0]!} and business_date <= ${sorted[sorted.length - 1]!}
  `)) as unknown as { channel_id: string; business_date: string }[];
  return new Set(rows.map((r) => `${r.channel_id}|${r.business_date}`));
}

export interface ChannelFacts {
  storeId: string;
  name: string;
  platform: SettlementPlatform | null;
  platformStoreCode: string | null;
}

/** A channel's store and CURRENT platform code (what the "store matched" check compares the file's code to), or null. */
export async function channelFacts(tx: Tx, orgId: string, channelId: string): Promise<ChannelFacts | null> {
  const rows = (await tx.execute(sql`
    select store_id::text as store_id, name, platform, platform_store_code from sales_channels where org_id = ${orgId} and id = ${channelId} limit 1
  `)) as unknown as { store_id: string; name: string; platform: SettlementPlatform | null; platform_store_code: string | null }[];
  const r = rows[0];
  return r ? { storeId: r.store_id, name: r.name, platform: r.platform, platformStoreCode: r.platform_store_code } : null;
}

/** `channelFacts` of many channels in one read, plus each channel's destination account (null = none set). */
export async function channelFactsMany(tx: Tx, orgId: string, channelIds: readonly string[]): Promise<Map<string, ChannelFacts & { destinationMoneyAccountId: string | null }>> {
  if (channelIds.length === 0) return new Map();
  const rows = (await tx.execute(sql`
    select id::text as id, store_id::text as store_id, name, platform, platform_store_code, destination_money_account_id::text as destination_money_account_id
      from sales_channels where org_id = ${orgId} and id in (${sql.join(channelIds.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { id: string; store_id: string; name: string; platform: SettlementPlatform | null; platform_store_code: string | null; destination_money_account_id: string | null }[];
  return new Map(
    rows.map((r) => [r.id, { storeId: r.store_id, name: r.name, platform: r.platform, platformStoreCode: r.platform_store_code, destinationMoneyAccountId: r.destination_money_account_id }]),
  );
}

/** What the "earlier day open" rule needs of one channel: its first staged day, its pending current lines, and the dates staff recorded sales that no current line covers. */
export interface EarlierOpenInputs {
  firstStaged: string | null;
  pendingDates: string[];
  gapDates: string[];
}

/** The inputs of the "earlier day open" rule for several channels, in two reads. */
export async function earlierOpenInputs(tx: Tx, orgId: string, channelIds: readonly string[]): Promise<Map<string, EarlierOpenInputs>> {
  const out = new Map<string, EarlierOpenInputs>(channelIds.map((id) => [id, { firstStaged: null, pendingDates: [], gapDates: [] }]));
  if (channelIds.length === 0) return out;
  const lines = await tx
    .select({ channelId: settlementDayLines.channelId, salesDate: sql<string>`${settlementDayLines.salesDate}::text`, reviewState: settlementDayLines.reviewState })
    .from(settlementDayLines)
    .where(and(eq(settlementDayLines.orgId, orgId), eq(settlementDayLines.isCurrent, true), inArray(settlementDayLines.channelId, [...channelIds])));
  for (const l of lines) {
    const i = out.get(l.channelId)!;
    if (i.firstStaged === null || l.salesDate.localeCompare(i.firstStaged) < 0) i.firstStaged = l.salesDate;
    if (l.reviewState === 'pending') i.pendingDates.push(l.salesDate);
  }
  for (const g of await daysWithRecordedSalesAndNoLineMany(tx, orgId, channelIds)) out.get(g.channelId)?.gapDates.push(g.date);
  return out;
}

/** The pure rule: pending current lines before the date, plus recorded-sales dates no file covers, counted from the channel's FIRST staged day (a day before any file is not a gap). */
export function countEarlierOpen(i: EarlierOpenInputs, beforeDate: string): number {
  if (i.firstStaged === null || i.firstStaged.localeCompare(beforeDate) >= 0) return 0;
  const first = i.firstStaged;
  return i.pendingDates.filter((d) => d.localeCompare(beforeDate) < 0).length + i.gapDates.filter((d) => d.localeCompare(first) >= 0 && d.localeCompare(beforeDate) < 0).length;
}

/**
 * Earlier days of a channel that are neither booked nor rejected: pending current lines before the date, plus dates staff recorded sales on that no file
 * covers, counted from the channel's FIRST staged day (a day before any file is not a gap).
 */
export async function countEarlierOpenDays(tx: Tx, orgId: string, channelId: string, beforeDate: string): Promise<number> {
  return countEarlierOpen((await earlierOpenInputs(tx, orgId, [channelId])).get(channelId)!, beforeDate);
}

/** Compare-and-set: only a CURRENT line that is still pending is rejected. false = someone else decided or replaced it first. */
export async function markRejected(tx: Tx, orgId: string, lineId: string, o: { reason: string; decidedBy: string }): Promise<boolean> {
  const rows = await tx
    .update(settlementDayLines)
    .set({ reviewState: 'rejected', decisionReason: o.reason, decidedBy: o.decidedBy, decidedAt: sql`now()` })
    .where(and(eq(settlementDayLines.orgId, orgId), eq(settlementDayLines.id, lineId), eq(settlementDayLines.isCurrent, true), eq(settlementDayLines.reviewState, 'pending')))
    .returning({ id: settlementDayLines.id });
  return rows.length === 1;
}

/** Compare-and-set: only a CURRENT rejected line goes back to pending, its decision columns cleared (the review-shape CHECK). */
export async function markReopened(tx: Tx, orgId: string, lineId: string): Promise<boolean> {
  const rows = await tx
    .update(settlementDayLines)
    .set({ reviewState: 'pending', decisionReason: null, decidedBy: null, decidedAt: null })
    .where(and(eq(settlementDayLines.orgId, orgId), eq(settlementDayLines.id, lineId), eq(settlementDayLines.isCurrent, true), eq(settlementDayLines.reviewState, 'rejected')))
    .returning({ id: settlementDayLines.id });
  return rows.length === 1;
}

/**
 * T-511 S7a. Compare-and-set: only a CURRENT line that is still pending is booked; `decided_by`, `decided_at` and `settlement_id` are set together (the review-shape
 * CHECK). false = someone decided first, a newer file replaced it, or it is not pending. Called by `approveDay` only.
 */
export async function markBooked(tx: Tx, orgId: string, lineId: string, o: { decidedBy: string; settlementId: string }): Promise<boolean> {
  const rows = await tx
    .update(settlementDayLines)
    .set({ reviewState: 'booked', decidedBy: o.decidedBy, decidedAt: sql`now()`, settlementId: o.settlementId })
    .where(and(eq(settlementDayLines.orgId, orgId), eq(settlementDayLines.id, lineId), eq(settlementDayLines.isCurrent, true), eq(settlementDayLines.reviewState, 'pending')))
    .returning({ id: settlementDayLines.id });
  return rows.length === 1;
}

/**
 * T-511 S7a. The CURRENT line booked by this settlement goes back to pending, its decision columns cleared (the review-shape CHECK); a line that is no longer current stays
 * booked as history. Returns the line returned, or null. Called by the void of a channel settlement only.
 */
export async function markUnbooked(tx: Tx, orgId: string, settlementId: string): Promise<DayLineRow | null> {
  const rows = await tx
    .update(settlementDayLines)
    .set({ reviewState: 'pending', decisionReason: null, decidedBy: null, decidedAt: null, settlementId: null })
    .where(and(eq(settlementDayLines.orgId, orgId), eq(settlementDayLines.settlementId, settlementId), eq(settlementDayLines.isCurrent, true), eq(settlementDayLines.reviewState, 'booked')))
    .returning();
  return rows[0] ?? null;
}

/** T-511 S7a. The people who uploaded the line's source upload and its payout upload (Grab has both, Foodpanda only the invoice), distinct. The uploader rule reads this and nothing else. */
export async function uploaderIdsOfLine(tx: Tx, orgId: string, lineId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select distinct u.uploaded_by::text as person_id
      from settlement_day_lines l
      join settlement_uploads u on u.org_id = l.org_id and (u.id = l.source_upload_id or u.id = l.payout_upload_id)
     where l.org_id = ${orgId} and l.id = ${lineId}
  `)) as unknown as { person_id: string }[];
  return rows.map((r) => r.person_id);
}

/** The key of one Foodpanda invoice across every upload of it: the channel and the invoice number the staged days carry as their payout reference. */
export const invoiceKey = (channelId: string, invoiceNumber: string): string => `${channelId}|${invoiceNumber}`;

/**
 * What the carrier rule (Foodpanda, Ruling 6) reads of one INVOICE (a channel and an invoice number, whichever upload brought each day):
 * the latest current sales date of its days, and its period charges: every charge BOOKED from any upload of the invoice (with whether a live settlement netted it), and one
 * entry with `chargeId` null per charge still staged and not booked. A staged charge is not "unbooked" when its upload was replaced by a newer one (it can never be booked
 * from there) or when a booked copy of it exists (same store, channel, date, net amount and description: the copy a re-uploaded file stages again).
 */
export interface InvoiceCarrierFacts {
  /** the latest sales date among the CURRENT day lines of the invoice (any review state); null when it has none */
  carrierDate: string | null;
  charges: { chargeId: string | null; totalAmount: string | null; nettedBySettlementId: string | null }[];
}

/** T-511 S7a. Read only, three reads however many invoices; an invoice with no line and no charge is present with `carrierDate` null. A charge counts as netted only through a settlement that is not voided. */
export async function invoiceCarrierFactsMany(tx: Tx, orgId: string, invoices: readonly { channelId: string; invoiceNumber: string }[]): Promise<Map<string, InvoiceCarrierFacts>> {
  const out = new Map<string, InvoiceCarrierFacts>(invoices.map((i) => [invoiceKey(i.channelId, i.invoiceNumber), { carrierDate: null, charges: [] }]));
  if (invoices.length === 0) return out;
  const pairs = sql.join(invoices.map((i) => sql`(${i.channelId}::uuid, ${i.invoiceNumber})`), sql`, `);
  const latest = (await tx.execute(sql`
    select channel_id::text as channel_id, payout_reference, max(sales_date)::text as d
      from settlement_day_lines
     where org_id = ${orgId} and is_current and platform = 'foodpanda' and (channel_id, payout_reference) in (${pairs})
     group by channel_id, payout_reference
  `)) as unknown as { channel_id: string; payout_reference: string; d: string }[];
  for (const r of latest) out.get(invoiceKey(r.channel_id, r.payout_reference))!.carrierDate = r.d;
  const booked = (await tx.execute(sql`
    select u.channel_id::text as channel_id, u.invoice_number, c.id::text as charge_id, c.total_amount::text as total_amount,
           (select k.settlement_id::text
              from channel_settlement_charge_links k
              join channel_settlements st on st.org_id = k.org_id and st.id = k.settlement_id
             where k.org_id = c.org_id and k.charge_id = c.id and st.status <> 'voided'
             limit 1) as netted_by
      from channel_period_charges c
      join settlement_uploads u on u.org_id = c.org_id and u.id = c.upload_id
     where c.org_id = ${orgId} and (u.channel_id, u.invoice_number) in (${pairs})
     order by c.id
  `)) as unknown as { channel_id: string; invoice_number: string; charge_id: string; total_amount: string; netted_by: string | null }[];
  for (const r of booked) out.get(invoiceKey(r.channel_id, r.invoice_number))!.charges.push({ chargeId: r.charge_id, totalAmount: r.total_amount, nettedBySettlementId: r.netted_by });
  const staged = (await tx.execute(sql`
    select u.channel_id::text as channel_id, u.invoice_number
      from settlement_other_lines ol
      join settlement_uploads u on u.org_id = ol.org_id and u.id = ol.upload_id
     where ol.org_id = ${orgId} and ol.kind = 'period_charge' and ol.day_line_id is null and ol.is_current
       and u.superseded_by is null and (u.channel_id, u.invoice_number) in (${pairs})
       and not exists (select 1 from channel_period_charges c where c.org_id = ol.org_id and c.other_line_id = ol.id)
       and not exists (
         select 1 from channel_period_charges c2
          where c2.org_id = ol.org_id and c2.store_id = u.store_id and c2.channel_id = u.channel_id and c2.charge_date = ol.line_date
            and c2.net_amount = ol.amount and c2.description is not distinct from ol.description)
     order by ol.id
  `)) as unknown as { channel_id: string; invoice_number: string }[];
  for (const r of staged) out.get(invoiceKey(r.channel_id, r.invoice_number))!.charges.push({ chargeId: null, totalAmount: null, nettedBySettlementId: null });
  return out;
}

/** An override flips the day's active DEDUCTION lines inactive (`is_active` is the only updatable column); disbursals are never touched. */
export async function deactivateDeductionLines(tx: Tx, orgId: string, dayLineId: string): Promise<void> {
  await tx
    .update(settlementLoanLines)
    .set({ isActive: false })
    .where(
      and(eq(settlementLoanLines.orgId, orgId), eq(settlementLoanLines.dayLineId, dayLineId), eq(settlementLoanLines.kind, 'deduction'), eq(settlementLoanLines.isActive, true)),
    );
}

/** The new active deduction lines of an override: loan set, source `admin`, row ordinals after every existing line of the day. */
export async function insertAdminDeductionLines(tx: Tx, orgId: string, dayLineId: string, lines: readonly { loanId: string; amount: Money }[]): Promise<void> {
  if (lines.length === 0) return;
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${settlementLoanLines.rowOrdinal}), 0)::int` })
    .from(settlementLoanLines)
    .where(and(eq(settlementLoanLines.orgId, orgId), eq(settlementLoanLines.dayLineId, dayLineId)));
  const start = (max?.n ?? 0) + 1;
  await tx
    .insert(settlementLoanLines)
    .values(lines.map((l, i) => ({ orgId, dayLineId, kind: 'deduction' as const, amount: l.amount, rowOrdinal: start + i, loanId: l.loanId, allocationSource: 'admin' as const })));
}

export interface PandagoOnlyUpload {
  uploadId: string;
  storeId: string;
  storeName: string;
}

/** Current Foodpanda invoices that read no order at all (Appendix B only): no sales day and no row, listed apart. Limited to the given stores. */
export async function pandagoOnlyUploads(tx: Tx, orgId: string, storeIds: readonly string[]): Promise<PandagoOnlyUpload[]> {
  if (storeIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    select u.id::text as upload_id, u.store_id::text as store_id, s.name as store_name
      from settlement_uploads u
      join stores s on s.org_id = u.org_id and s.id = u.store_id
     where u.org_id = ${orgId} and u.platform = 'foodpanda' and u.file_kind = 'foodpanda_invoice' and u.orders_read = 0 and u.superseded_by is null
       and u.store_id in (${sql.join(storeIds.map((id) => sql`${id}`), sql`, `)})
     order by u.uploaded_at, u.id
  `)) as unknown as { upload_id: string; store_id: string; store_name: string }[];
  return rows.map((r) => ({ uploadId: r.upload_id, storeId: r.store_id, storeName: r.store_name }));
}

// ---------------------------------------------------------------------------------------------
// T-511 S6b: platform sales corrections (`correctPlatformSales`; the platform-corrections migration). Append-only: insert and read, never update.
// ---------------------------------------------------------------------------------------------
export type PlatformCorrectionRow = typeof salesDayPlatformCorrections.$inferSelect;
/** The two figures are `Money` brands (numeric(14,2)), spelled out so the T-371 write guard can see their shape. */
export interface InsertPlatformCorrectionInput {
  id: string;
  orgId: string;
  storeId: string;
  salesDayId: string;
  channelId: string;
  dayLineId: string;
  fromAmount: Money;
  toAmount: Money;
  entryDate: string;
  journalEntryId: string;
  reason: string;
  postedBy: string;
}

/** The correction already posted for this staged day line ON THIS SALES DAY, or null (a voided day re-entered on the same date is a new sales day: the old day's row is not this one's). */
export async function platformCorrectionForLine(tx: Tx, orgId: string, salesDayId: string, dayLineId: string): Promise<PlatformCorrectionRow | null> {
  const [row] = await tx
    .select()
    .from(salesDayPlatformCorrections)
    .where(and(eq(salesDayPlatformCorrections.orgId, orgId), eq(salesDayPlatformCorrections.salesDayId, salesDayId), eq(salesDayPlatformCorrections.dayLineId, dayLineId)))
    .limit(1);
  return row ?? null;
}

/** Every platform correction of a sales day, oldest first (the order they were written: `posted_at` is the statement clock). */
export async function listPlatformCorrectionsForDay(tx: Tx, orgId: string, salesDayId: string): Promise<PlatformCorrectionRow[]> {
  return tx
    .select()
    .from(salesDayPlatformCorrections)
    .where(and(eq(salesDayPlatformCorrections.orgId, orgId), eq(salesDayPlatformCorrections.salesDayId, salesDayId)))
    .orderBy(asc(salesDayPlatformCorrections.postedAt), asc(salesDayPlatformCorrections.id));
}

export async function insertPlatformCorrection(tx: Tx, input: InsertPlatformCorrectionInput): Promise<void> {
  // `posted_at` is the statement's own clock (as `posV1Repo.insertCorrection`), so corrections order exactly by when they were written.
  await tx.insert(salesDayPlatformCorrections).values({ ...input, postedAt: sql`clock_timestamp()` });
}

// ---------------------------------------------------------------------------------------------
// T-511 S6c: one staged other line with the channel and store of its upload (`postPlatformCharge`). Read only.
// ---------------------------------------------------------------------------------------------
export interface OtherLineWithUpload {
  id: string;
  uploadId: string;
  channelId: string;
  storeId: string;
  kind: string;
  bookedAs: string;
  dayLineId: string | null;
  isCurrent: boolean;
  amount: string;
  vatAmount: string | null;
  lineDate: string | null;
  description: string | null;
  /** the line's upload was replaced by a newer one (ingest sets this for the same channel, kind and period) */
  uploadSupersededBy: string | null;
}

/** One staged other line by id, with its upload's channel and store, or null (another org's id is null too). */
export async function otherLineWithUpload(tx: Tx, orgId: string, id: string): Promise<OtherLineWithUpload | null> {
  const [row] = await tx
    .select({
      id: settlementOtherLines.id,
      uploadId: settlementOtherLines.uploadId,
      channelId: settlementUploads.channelId,
      storeId: settlementUploads.storeId,
      kind: settlementOtherLines.kind,
      bookedAs: settlementOtherLines.bookedAs,
      dayLineId: settlementOtherLines.dayLineId,
      isCurrent: settlementOtherLines.isCurrent,
      amount: settlementOtherLines.amount,
      vatAmount: settlementOtherLines.vatAmount,
      lineDate: settlementOtherLines.lineDate,
      description: settlementOtherLines.description,
      uploadSupersededBy: settlementUploads.supersededBy,
    })
    .from(settlementOtherLines)
    .innerJoin(settlementUploads, and(eq(settlementUploads.orgId, settlementOtherLines.orgId), eq(settlementUploads.id, settlementOtherLines.uploadId)))
    .where(and(eq(settlementOtherLines.orgId, orgId), eq(settlementOtherLines.id, id)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------
// T-511 S7b: the period charges (staged, no sales day) the review screen lists and the invoice panel shows. Read only.
// ---------------------------------------------------------------------------------------------
export interface PeriodChargeFact {
  otherLineId: string;
  storeId: string;
  channelId: string;
  invoiceNumber: string | null;
  lineDate: string | null;
  description: string | null;
  net: string;
  vat: string | null;
  isCurrent: boolean;
  /** the line's upload was replaced by a newer one */
  uploadReplaced: boolean;
  /** who uploaded the file; the uploader rule reads it and it never leaves the server */
  uploadedBy: string;
  /** the booked charge of THIS line, when there is one */
  booked: { totalAmount: string } | null;
  /** another booked charge with the same store, channel, date, net amount and description (the copy a re-uploaded file stages again) */
  copy: { totalAmount: string; chargeDate: string } | null;
}

/**
 * Every staged period charge (kind period_charge, no day) of the given stores, or of the given invoices (channel + invoice number, whichever upload brought them), at most
 * `limit`: the ones still waiting to be booked first (so an old unbooked charge never falls off the cap), then the rest, each group newest first. Posted or not. One statement.
 */
export async function periodChargeFacts(
  tx: Tx,
  orgId: string,
  filter: { storeIds?: readonly string[]; invoices?: readonly { channelId: string; invoiceNumber: string }[]; limit?: number },
): Promise<PeriodChargeFact[]> {
  if ((filter.storeIds && filter.storeIds.length === 0) || (filter.invoices && filter.invoices.length === 0)) return [];
  const where = [sql`ol.org_id = ${orgId}`, sql`ol.kind = 'period_charge'`, sql`ol.day_line_id is null`];
  if (filter.storeIds) where.push(sql`u.store_id in (${sql.join(filter.storeIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  if (filter.invoices) where.push(sql`(u.channel_id, u.invoice_number) in (${sql.join(filter.invoices.map((i) => sql`(${i.channelId}::uuid, ${i.invoiceNumber})`), sql`, `)})`);
  const rows = (await tx.execute(sql`
    select ol.id::text as other_line_id, u.store_id::text as store_id, u.channel_id::text as channel_id, u.invoice_number, ol.line_date::text as line_date,
           ol.description, ol.amount::text as net, ol.vat_amount::text as vat, ol.is_current, (u.superseded_by is not null) as upload_replaced,
           u.uploaded_by::text as uploaded_by, c.total_amount::text as booked_total, cp.total_amount::text as copy_total, cp.charge_date::text as copy_date
      from settlement_other_lines ol
      join settlement_uploads u on u.org_id = ol.org_id and u.id = ol.upload_id
      left join channel_period_charges c on c.org_id = ol.org_id and c.other_line_id = ol.id
      left join lateral (
        select c2.total_amount, c2.charge_date from channel_period_charges c2
         where c2.org_id = ol.org_id and c2.store_id = u.store_id and c2.channel_id = u.channel_id and c2.charge_date = ol.line_date
           and c2.net_amount = ol.amount and c2.description is not distinct from ol.description and c2.other_line_id <> ol.id
         limit 1) cp on true
     where ${sql.join(where, sql` and `)}
     order by (c.id is null and ol.is_current and u.superseded_by is null and cp.total_amount is null) desc, ol.line_date desc nulls last, ol.id desc
     limit ${filter.limit ?? 200}
  `)) as unknown as {
    other_line_id: string; store_id: string; channel_id: string; invoice_number: string | null; line_date: string | null; description: string | null; net: string; vat: string | null;
    is_current: boolean; upload_replaced: boolean; uploaded_by: string; booked_total: string | null; copy_total: string | null; copy_date: string | null;
  }[];
  return rows.map((r) => ({
    otherLineId: r.other_line_id,
    storeId: r.store_id,
    channelId: r.channel_id,
    invoiceNumber: r.invoice_number,
    lineDate: r.line_date,
    description: r.description,
    net: r.net,
    vat: r.vat,
    isCurrent: r.is_current,
    uploadReplaced: r.upload_replaced,
    uploadedBy: r.uploaded_by,
    booked: r.booked_total === null ? null : { totalAmount: r.booked_total },
    copy: r.copy_total === null || r.copy_date === null ? null : { totalAmount: r.copy_total, chargeDate: r.copy_date },
  }));
}
