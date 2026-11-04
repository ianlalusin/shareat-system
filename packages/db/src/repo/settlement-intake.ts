/**
 * The only place SQL is written for the settlement upload staging tables. T-511 S4 (docs/tasks/511-settlement-upload-s4-spec.md).
 *
 * The four tables (migration 0228) are append-style: a re-upload inserts a new version and retires the old one, nothing is deleted
 * and no money column is ever updated (the app role has UPDATE only on `superseded_by`, `is_current` and the review columns).
 * Every function takes the org and filters by it; RLS backstops (bible section 15.11). Nothing here posts to the books.
 */
import { and, desc, eq, getTableColumns, gte, isNull, lte, sql } from 'drizzle-orm';
import { money, type Money } from '@shareat/core/money';
import type { Tx } from '../client';
import {
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
  await tx.insert(settlementOtherLines).values(lines.map((l) => ({ ...l, orgId, uploadId, dayLineId })));
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

/** The "no file yet" list: verified days with sales on a channel that hold no current staged line, oldest first. */
export async function daysWithRecordedSalesAndNoLine(tx: Tx, orgId: string, channelId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select sd.business_date::text as business_date
      from sales_day_channels sdc
      join sales_days sd on sd.id = sdc.sales_day_id
     where sd.org_id = ${orgId} and sdc.channel_id = ${channelId}
       and sd.status = 'verified' and sdc.no_sales = false and sdc.amount > 0
       and not exists (
         select 1 from settlement_day_lines l
          where l.org_id = sd.org_id and l.channel_id = sdc.channel_id and l.sales_date = sd.business_date and l.is_current
       )
     order by sd.business_date
  `)) as unknown as { business_date: string }[];
  return rows.map((r) => r.business_date);
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
