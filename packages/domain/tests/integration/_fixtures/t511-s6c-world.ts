/**
 * T-511 S6c (TESTER) - the world the platform-charge tests run in (NOT a test file). It builds on `t511-s6b-world.ts` (read-only: Lipa with a Foodpanda channel on 1220
 * and a bank account, Malvar, an admin, a manager of each, a submitter, the chart, Oct and Nov 2026 open, one VERIFIED sales day on 12 Oct) and adds:
 *  - a second verified sales day (13 Oct) so a payout can settle one day while another stays owed,
 *  - a raw staged OTHER line (the period charge with no sales day, and the lines that must be refused) written through stored_files + settlement_uploads,
 *  - a second channel (Grab) of the same store,
 *  - the two functions under test, loaded lazily so only the legs that call them fail on a tree without them,
 *  - read-backs for the charge rows and the netting links.
 */
import type postgres from 'postgres';
import type { Actor } from '@shareat/auth';
import { createSalesDay } from '@shareat/domain';
import type { Tx } from '@shareat/db';
import { submitThenVerify } from './sales-day-flow';
import { DATE, TODAY, asOrg, fx, uid, type Fx } from './t511-s6b-world';

export {
  DATE, NEXT_OPEN, TODAY, UUID_RE, asOrg, auditRows, entriesOf, linesOf, lineText, netDebit, sentenceOf, type EntryRow, type LineRow,
} from './t511-s6b-world';

/** The second sales day, and the date a payout is booked on (both in October, which is open). */
export const DATE2 = '2026-10-13';
export const SETTLED = '2026-10-20';
/** The date printed on the period charge. */
export const CHARGE_DATE = '2026-10-14';

export interface World extends Fx {
  /** the second verified sales day (DATE2), present when `staff2` was given */
  day2Id: string | null;
}

/** staff = what staff typed for 12 Oct; staff2 = the same for 13 Oct (omit for a one-day world). The file figure of the S6b line equals `staff` (no S6b correction here). */
export async function world(sql: postgres.Sql, hint: string, o: { staff?: string; staff2?: string; receivable?: string } = {}): Promise<World> {
  const staff = o.staff ?? '10000.00';
  const f = await fx(sql, `s6c-${hint}`, { staff, file: staff, ...(o.receivable ? { receivable: o.receivable } : {}) });
  let day2Id: string | null = null;
  if (o.staff2) {
    const d = await asOrg(f.orgId, (tx) =>
      createSalesDay(tx, f.submitter, {
        storeId: f.storeA, businessDate: DATE2, totalSales: o.staff2!, unliSales: '0.00', alaCarteSales: o.staff2!, cashCollected: '0.00',
        channels: [{ channelId: f.channelId, amount: o.staff2! }],
      }),
    );
    await asOrg(f.orgId, (tx) => submitThenVerify(tx, f.admin, d.id, f.submitter));
    day2Id = d.id;
  }
  return { ...f, day2Id };
}

/** A second channel of Lipa (Grab, receivable 1220), banking into the same account. */
export async function addGrabChannel(sql: postgres.Sql, f: Fx): Promise<string> {
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code, platform, platform_store_code, destination_money_account_id)
    values (${f.orgId}, ${f.storeA}, ${uid('Grab')}, false, '1220', 'grab', ${uid('GR')}, ${f.bankId}) returning id`;
  return ch!.id;
}

export interface RawOtherOpts {
  orgId: string;
  storeId: string;
  channelId: string;
  personId: string;
  platform?: 'grab' | 'foodpanda';
  /** printed Net Total of the charge (what staging stores as `amount`) */
  net: string;
  /** the staged VAT; null leaves vat_amount NULL (a line staged before S6c) */
  vat: string | null;
  lineDate?: string | null;
  kind?: string;
  bookedAs?: 'none' | 'platformFee' | 'marketing';
  /** set for a line that belongs to a day (the S6c function must refuse it) */
  dayLineId?: string | null;
  isCurrent?: boolean;
  description?: string | null;
}

/** A staged other line (and the stored file and upload it needs) written raw. Default: a current weekly-fee period charge dated CHARGE_DATE. */
export async function rawOtherLine(sql: postgres.Sql, o: RawOtherOpts): Promise<string> {
  const platform = o.platform ?? 'foodpanda';
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${o.orgId}, ${o.storeId}, 'memo_document', ${`orgs/${o.orgId}/stores/${o.storeId}/memo_document/${uid('f')}.pdf`}, 'application/pdf', 10, 'abc', ${o.personId}) returning id`;
  const [up] = await sql<{ id: string }[]>`
    insert into settlement_uploads (org_id, channel_id, store_id, platform, file_kind, file_id, fingerprint, reader_version, period_from, period_to, uploaded_by)
    values (${o.orgId}, ${o.channelId}, ${o.storeId}, ${platform}, ${platform === 'grab' ? 'grab_transactions' : 'foodpanda_invoice'}, ${file!.id}, ${uid('fp')}, '1', '2026-10-08', '2026-10-15', ${o.personId}) returning id`;
  const [line] = await sql<{ id: string }[]>`
    insert into settlement_other_lines (org_id, upload_id, day_line_id, kind, booked_as, amount, line_date, description, is_current, vat_amount)
    values (${o.orgId}, ${up!.id}, ${o.dayLineId ?? null}, ${o.kind ?? 'period_charge'}, ${o.bookedAs ?? 'none'}, ${o.net}, ${o.lineDate === undefined ? CHARGE_DATE : o.lineDate}, ${o.description === undefined ? 'Platform Fee' : o.description},
            ${o.isCurrent ?? true}, ${o.vat}) returning id`;
  return line!.id;
}

/** The default period charge of the netting tests: net 100.00 + VAT 12.00 (total 112.00) on the world's Foodpanda channel. */
export const periodCharge = (sql: postgres.Sql, f: Fx, over: Partial<RawOtherOpts> = {}): Promise<string> =>
  rawOtherLine(sql, { orgId: f.orgId, storeId: f.storeA, channelId: f.channelId, personId: f.admin.personId, net: '100.00', vat: '12.00', ...over });

/* ------------------------------------------------------------------ the function under test */

export interface PostChargeResult {
  posted: boolean;
  chargeId?: string;
  journalEntryId?: string;
}
interface ChargeModule {
  postPlatformCharge: (tx: Tx, actor: Actor, input: Record<string, unknown>) => Promise<PostChargeResult>;
  postPlatformChargeOnClock: (tx: Tx, actor: Actor, input: Record<string, unknown>, today?: string) => Promise<PostChargeResult>;
}
const loadModule = async (): Promise<ChargeModule> => (await import('../../../src/channel-settlements/charge')) as unknown as ChargeModule;

/** The function under test through the test seam (the clock is `today`, default TODAY), loaded lazily. */
export async function postCharge(f: { orgId: string }, who: Actor, otherLineId: string, today: string = TODAY): Promise<PostChargeResult> {
  const m = await loadModule();
  return asOrg(f.orgId, (tx) => m.postPlatformChargeOnClock(tx, who, { otherLineId }, today));
}
/** The PRODUCTION entry point; a `today` in `over` is smuggled in to prove it is ignored. */
export async function postChargeProd(f: { orgId: string }, who: Actor, otherLineId: string, over: Record<string, unknown> = {}): Promise<PostChargeResult> {
  const m = await loadModule();
  return asOrg(f.orgId, (tx) => m.postPlatformCharge(tx, who, { otherLineId, ...over }));
}

/* ------------------------------------------------------------------ read-backs on the raw connection */

export interface ChargeRow {
  id: string; org_id: string; store_id: string; channel_id: string; other_line_id: string; upload_id: string; charge_date: string; net_amount: string; vat_amount: string;
  total_amount: string; entry_date: string; journal_entry_id: string; description: string | null; posted_by: string;
}
export const charges = (sql: postgres.Sql, orgId: string): Promise<ChargeRow[]> => sql<ChargeRow[]>`
  select id::text, org_id::text, store_id::text, channel_id::text, other_line_id::text, upload_id::text, to_char(charge_date, 'YYYY-MM-DD') as charge_date,
         net_amount::text, vat_amount::text, total_amount::text, to_char(entry_date, 'YYYY-MM-DD') as entry_date, journal_entry_id::text, description, posted_by::text
    from channel_period_charges where org_id = ${orgId} order by posted_at, id`;

export const links = (sql: postgres.Sql, orgId: string) => sql<{ settlement_id: string; charge_id: string }[]>`
  select settlement_id::text, charge_id::text from channel_settlement_charge_links where org_id = ${orgId} order by settlement_id, charge_id`;

export interface SettlementRow {
  id: string; status: string; gross_amount: string; outstanding_cleared: string; platform_fee: string; net_deposited: string; variance: string; settlement_gain: string;
  difference_reason: string | null; journal_entry_id: string | null;
}
export const settlements = (sql: postgres.Sql, orgId: string): Promise<SettlementRow[]> => sql<SettlementRow[]>`
  select id::text, status, gross_amount::text, outstanding_cleared::text, platform_fee::text, net_deposited::text, variance::text, settlement_gain::text, difference_reason,
         journal_entry_id::text
    from channel_settlements where org_id = ${orgId} order by created_at, id`;

export const entryCount = async (sql: postgres.Sql, orgId: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${orgId}`)[0]!.n;
