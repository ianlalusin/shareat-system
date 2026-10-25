/**
 * The only place SQL is written for the nightly POS receipt bridge. T-472 S2 (tables: migration 0216),
 * `docs/tasks/472-pos-nightly-receipt-bridge.md` Rulings 3-7.
 *
 * Every function takes a `tx` opened by `withOrgPrincipal`: RLS fails closed without `app.org_id`, and a write with no
 * principal is refused 42501. The grants are SELECT+INSERT on the receipt tables (a version is never updated or deleted) and
 * SELECT+INSERT+UPDATE on `pos_bridge_day_checks` (recomputed nightly, in place).
 *
 * - A receipt VERSION is inserted only when the latest version's hash differs. The unique key
 *   `(org_id, pos_store_id, firestore_doc_id, version)` arbitrates a concurrent run: the loser's `ON CONFLICT DO NOTHING`
 *   inserts nothing and the answer is `raced` (a skip, never an error). A genuine `23505` out of the savepoint is the same.
 * - The DATABASE does not check that a child's `pos_calendar_date` equals its header's: this module sets every child's
 *   `org_id` and `pos_calendar_date` from the header it just wrote.
 * - Postgres errors are SANITISED before they leave: the driver's message quotes the failing row (receipt numbers, hashes,
 *   amounts), and the job puts failure text on a screen. Only the SQLSTATE, the constraint and the table survive.
 * - NO personal data is ever a parameter here (Ruling 7): the job strips it before it calls in, and there is no column for it.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { moneyFromLegacyFloat, toCentavos as moneyToCentavos, type Decimal } from '@shareat/core/money';
import type { Tx } from '../client';
import { POS_V1_SALES_FIELDS } from '../pos-v1/wire';
import {
  posBridgeDayChecks,
  posBridgeReceiptLines,
  posBridgeReceiptTenders,
  posBridgeReceipts,
  type PosBridgeCheckResult,
  type PosBridgeReceiptKind,
  type PosBridgeReceiptStatus,
} from '../../schema/pos-bridge';
import { latestForDay } from './pos-v1';

// ---------------------------------------------------------------------------------------------
// sanitised database errors
// ---------------------------------------------------------------------------------------------

/** A database refusal with NOTHING from the failing row in it: the SQLSTATE, the constraint and the table only. */
export class PosBridgeDbError extends Error {
  constructor(
    readonly code: string,
    readonly constraint: string | null,
    readonly table: string | null,
  ) {
    super(
      `the database refused the copy (error ${code}${constraint ? `, constraint ${constraint}` : ''}${table ? `, table ${table}` : ''})`,
    );
    this.name = 'PosBridgeDbError';
  }
}

function pgFields(e: unknown): { code: string; constraint: string | null; table: string | null } | null {
  for (let cur: unknown = e, i = 0; cur != null && i < 8; cur = (cur as { cause?: unknown }).cause, i++) {
    const o = cur as { code?: unknown; constraint_name?: unknown; table_name?: unknown };
    if (typeof o.code === 'string' && /^[0-9A-Z]{5}$/.test(o.code)) {
      return {
        code: o.code,
        constraint: typeof o.constraint_name === 'string' ? o.constraint_name : null,
        table: typeof o.table_name === 'string' ? o.table_name : null,
      };
    }
  }
  return null;
}

function isUnique(e: unknown): boolean {
  return pgFields(e)?.code === '23505';
}

/** Re-throws any database failure as a `PosBridgeDbError` (no row values); a non-database fault keeps its own message. */
function sanitise(e: unknown): never {
  const f = pgFields(e);
  if (f) throw new PosBridgeDbError(f.code, f.constraint, f.table);
  // Not a database refusal (a programming fault): keep its message unless it quotes a query, which carries the row's values.
  if (e instanceof Error && !/Failed query|params:/i.test(e.message)) throw e;
  throw new PosBridgeDbError('XX000', null, null);
}

// ---------------------------------------------------------------------------------------------
// versions
// ---------------------------------------------------------------------------------------------

export interface BridgeHeaderInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly posStoreId: string;
  readonly firestoreDocId: string;
  readonly kind: PosBridgeReceiptKind;
  readonly status: PosBridgeReceiptStatus;
  readonly receiptNumber: string | null;
  readonly terminalNo: string | null;
  readonly parentDocId: string | null;
  readonly clientAt: Date | null;
  readonly posCalendarDate: string;
  readonly subtotalCentavos: number;
  readonly discountCentavos: number;
  readonly totalCentavos: number;
  readonly moneyFlag: boolean;
  readonly raw: Record<string, unknown>;
  readonly docHash: string;
}

export interface BridgeLineInput {
  readonly lineNo: number;
  readonly posItemId: string | null;
  readonly itemName: string;
  /** Decimal text with three places (`'2.000'`), minted by `decimal(x, '14,3')`. Not money. */
  readonly quantity: Decimal<'14,3'>;
  readonly unitPriceCentavos: number;
  readonly discountCentavos: number;
  readonly lineTotalCentavos: number;
  readonly moneyFlag: boolean;
}

export interface BridgeTenderInput {
  readonly seq: number;
  readonly methodAlias: string;
  readonly tenderId: string | null;
  readonly amountCentavos: number;
  readonly moneyFlag: boolean;
}

export interface LatestVersion {
  readonly version: number;
  readonly docHash: string;
  readonly status: PosBridgeReceiptStatus;
}

/** The newest version of one document, or undefined when it has never been copied. */
export async function latestVersion(tx: Tx, orgId: string, posStoreId: string, firestoreDocId: string): Promise<LatestVersion | undefined> {
  try {
    const [row] = await tx
      .select({ version: posBridgeReceipts.version, docHash: posBridgeReceipts.docHash, status: posBridgeReceipts.status })
      .from(posBridgeReceipts)
      .where(
        and(
          eq(posBridgeReceipts.orgId, orgId),
          eq(posBridgeReceipts.posStoreId, posStoreId),
          eq(posBridgeReceipts.firestoreDocId, firestoreDocId),
        ),
      )
      .orderBy(desc(posBridgeReceipts.version))
      .limit(1);
    return row;
  } catch (e) {
    return sanitise(e);
  }
}

/**
 * Inserts version `version` of a document with its lines and tenders, children carrying the header's org and calendar date.
 * `raced` = another transaction already holds that version (the unique key decided); nothing of ours was kept.
 */
export async function insertVersion(
  tx: Tx,
  header: BridgeHeaderInput,
  lines: readonly BridgeLineInput[],
  tenders: readonly BridgeTenderInput[],
  version: number,
): Promise<'written' | 'raced'> {
  try {
    return await tx.transaction(async (sp) => {
      const [row] = await sp
        .insert(posBridgeReceipts)
        .values({ ...header, version })
        .onConflictDoNothing({
          target: [posBridgeReceipts.orgId, posBridgeReceipts.posStoreId, posBridgeReceipts.firestoreDocId, posBridgeReceipts.version],
        })
        .returning({ id: posBridgeReceipts.id });
      if (!row) return 'raced' as const;
      if (lines.length > 0) {
        await sp
          .insert(posBridgeReceiptLines)
          .values(lines.map((l) => ({ ...l, orgId: header.orgId, receiptId: row.id, posCalendarDate: header.posCalendarDate })));
      }
      if (tenders.length > 0) {
        await sp
          .insert(posBridgeReceiptTenders)
          .values(tenders.map((t) => ({ ...t, orgId: header.orgId, receiptId: row.id, posCalendarDate: header.posCalendarDate })));
      }
      return 'written' as const;
    });
  } catch (e) {
    if (isUnique(e)) return 'raced';
    return sanitise(e);
  }
}

/** Would `writeVersion` write? (the dry run asks this and writes nothing). */
export async function wouldWrite(tx: Tx, header: BridgeHeaderInput): Promise<boolean> {
  const latest = await latestVersion(tx, header.orgId, header.posStoreId, header.firestoreDocId);
  return !latest || latest.docHash !== header.docHash;
}

/**
 * Insert-where-latest-differs (Ruling 3): a new version only when the latest version's hash is not this one's.
 * `unchanged` = same hash, nothing written.
 */
export async function writeVersion(
  tx: Tx,
  header: BridgeHeaderInput,
  lines: readonly BridgeLineInput[],
  tenders: readonly BridgeTenderInput[],
): Promise<'written' | 'unchanged' | 'raced'> {
  const latest = await latestVersion(tx, header.orgId, header.posStoreId, header.firestoreDocId);
  if (latest && latest.docHash === header.docHash) return 'unchanged';
  return insertVersion(tx, header, lines, tenders, (latest?.version ?? 0) + 1);
}

/** The hash a `gone` version carries (the column wants 64 hex): a function of the document id, so repeating it mints nothing. */
export function goneHash(firestoreDocId: string): string {
  return createHash('sha256').update(`gone:${firestoreDocId}`, 'utf8').digest('hex');
}

/**
 * Mints a `gone` version for every document whose latest version is on this store-day, is not already gone, and is not in
 * `seenDocIds` (everything this run read, from any query). Returns how many. The `gone` row copies the previous header
 * (so it stays on the same day) and carries no lines or tenders.
 */
export async function markGone(
  tx: Tx,
  o: { orgId: string; storeId: string; posStoreId: string; posCalendarDate: string; seenDocIds: ReadonlySet<string> },
): Promise<number> {
  let rows: {
    firestore_doc_id: string; version: number; kind: PosBridgeReceiptKind; receipt_number: string | null; terminal_no: string | null;
    parent_doc_id: string | null; client_at: string | Date | null; subtotal_centavos: string; discount_centavos: string; total_centavos: string;
    money_flag: boolean; raw: Record<string, unknown>; doc_hash: string;
  }[];
  try {
    rows = (await tx.execute(sql`
      select firestore_doc_id, version, kind, receipt_number, terminal_no, parent_doc_id, client_at, subtotal_centavos::text,
             discount_centavos::text, total_centavos::text, money_flag, raw, doc_hash
        from pos_bridge_receipts_current
       where org_id = ${o.orgId} and store_id = ${o.storeId} and pos_store_id = ${o.posStoreId}
         and pos_calendar_date = ${o.posCalendarDate} and status <> 'gone'
       order by firestore_doc_id`)) as unknown as typeof rows;
  } catch (e) {
    return sanitise(e);
  }
  let minted = 0;
  for (const r of rows) {
    if (o.seenDocIds.has(r.firestore_doc_id)) continue;
    const res = await insertVersion(
      tx,
      {
        orgId: o.orgId,
        storeId: o.storeId,
        posStoreId: o.posStoreId,
        firestoreDocId: r.firestore_doc_id,
        kind: r.kind,
        status: 'gone',
        receiptNumber: r.receipt_number,
        terminalNo: r.terminal_no,
        parentDocId: r.parent_doc_id,
        clientAt: r.client_at === null ? null : new Date(r.client_at),
        posCalendarDate: o.posCalendarDate,
        subtotalCentavos: Number(r.subtotal_centavos),
        discountCentavos: Number(r.discount_centavos),
        totalCentavos: Number(r.total_centavos),
        moneyFlag: r.money_flag,
        raw: r.raw,
        docHash: goneHash(r.firestore_doc_id),
      },
      [],
      [],
      r.version + 1,
    );
    if (res === 'written') minted += 1;
  }
  return minted;
}

// ---------------------------------------------------------------------------------------------
// tenders
// ---------------------------------------------------------------------------------------------

/** The store's ACTIVE tenders by normalised POS alias (lowercase, a-z0-9 only): the same identity `resolvePosV1Methods` uses. */
export async function activeTenderIdsByAlias(tx: Tx, orgId: string, storeId: string): Promise<Map<string, string>> {
  try {
    const rows = (await tx.execute(sql`
      select id::text as id, regexp_replace(lower(pos_v1_alias), '[^a-z0-9]', '', 'g') as alias
        from tenders
       where org_id = ${orgId} and store_id = ${storeId} and is_active and pos_v1_alias is not null
       order by id`)) as unknown as { id: string; alias: string }[];
    const out = new Map<string, string>();
    for (const r of rows) if (r.alias && !out.has(r.alias)) out.set(r.alias, r.id);
    return out;
  } catch (e) {
    return sanitise(e);
  }
}

// ---------------------------------------------------------------------------------------------
// day checks (Ruling 6)
// ---------------------------------------------------------------------------------------------

/** The store's calendar dates in [from, to] that already have a day check (the bridge reads a day again only when it has none). */
export async function datesWithChecks(tx: Tx, orgId: string, storeId: string, from: string, to: string): Promise<Set<string>> {
  try {
    const rows = await tx
      .select({ d: sql<string>`${posBridgeDayChecks.posCalendarDate}::text` })
      .from(posBridgeDayChecks)
      .where(
        and(
          eq(posBridgeDayChecks.orgId, orgId),
          eq(posBridgeDayChecks.storeId, storeId),
          sql`${posBridgeDayChecks.posCalendarDate} >= ${from}::date and ${posBridgeDayChecks.posCalendarDate} <= ${to}::date`,
        ),
      );
    return new Set(rows.map((r) => r.d));
  } catch (e) {
    return sanitise(e);
  }
}

export interface MismatchRow {
  readonly storeId: string;
  readonly posCalendarDate: string;
  /** Receipts minus the day total, in centavos. */
  readonly differenceCentavos: number;
}

/** Day checks that are a mismatch on or after `fromDate`, newest first (the Sales days note). */
export async function recentMismatches(tx: Tx, orgId: string, fromDate: string): Promise<MismatchRow[]> {
  try {
    const rows = await tx
      .select({
        storeId: posBridgeDayChecks.storeId,
        posCalendarDate: sql<string>`${posBridgeDayChecks.posCalendarDate}::text`,
        differenceCentavos: posBridgeDayChecks.differenceCentavos,
      })
      .from(posBridgeDayChecks)
      .where(
        and(
          eq(posBridgeDayChecks.orgId, orgId),
          eq(posBridgeDayChecks.result, 'mismatch'),
          sql`${posBridgeDayChecks.posCalendarDate} >= ${fromDate}::date`,
        ),
      )
      .orderBy(desc(posBridgeDayChecks.posCalendarDate), posBridgeDayChecks.storeId);
    return rows.map((r) => ({ storeId: r.storeId, posCalendarDate: r.posCalendarDate, differenceCentavos: r.differenceCentavos ?? 0 }));
  } catch (e) {
    return sanitise(e);
  }
}

export interface DayNet {
  readonly receiptCount: number;
  readonly netSalesCentavos: number;
}

/** Latest-version FINAL receipts of the store-day: how many, and sales minus refunds (a refund counts negative whatever its sign). */
export async function dayNet(tx: Tx, orgId: string, storeId: string, posCalendarDate: string): Promise<DayNet> {
  try {
    const [r] = (await tx.execute(sql`
      select count(*)::int as n,
             coalesce(sum(case when kind = 'refund' then -abs(total_centavos) else total_centavos end), 0)::text as net
        from pos_bridge_receipts_current
       where org_id = ${orgId} and store_id = ${storeId} and pos_calendar_date = ${posCalendarDate} and status = 'final'`)) as unknown as {
      n: number;
      net: string;
    }[];
    return { receiptCount: Number(r!.n), netSalesCentavos: Number(r!.net) };
  } catch (e) {
    return sanitise(e);
  }
}

/**
 * The paid total (centavos) of the store-day's latest `sales` feed, or null when there is no feed or POS said `found: false`.
 * Read through the v2-named wire keys, never a POS spelling.
 */
export async function dayFeedTotalCentavos(tx: Tx, orgId: string, storeId: string, businessDate: string): Promise<number | null> {
  try {
    const feed = await latestForDay(tx, orgId, storeId, businessDate, 'sales');
    if (!feed) return null;
    const p = feed.payload as Record<string, unknown> | null;
    if (!p || p[POS_V1_SALES_FIELDS.found] === false) return null;
    const paid = p[POS_V1_SALES_FIELDS.paidTotal];
    if (typeof paid !== 'number' || !Number.isFinite(paid)) return null;
    return Number(moneyToCentavos(moneyFromLegacyFloat(paid).value));
  } catch (e) {
    return sanitise(e);
  }
}

export interface DayCheckInput {
  readonly orgId: string;
  readonly storeId: string;
  readonly posStoreId: string;
  readonly posCalendarDate: string;
  readonly receiptCount: number;
  readonly netSalesCentavos: number;
  readonly feedTotalCentavos: number | null;
  readonly differenceCentavos: number | null;
  readonly result: PosBridgeCheckResult;
}

/** One row per store-day, recomputed nightly: inserted the first time, updated in place after. */
export async function upsertDayCheck(tx: Tx, input: DayCheckInput): Promise<void> {
  try {
    await tx
      .insert(posBridgeDayChecks)
      .values(input)
      .onConflictDoUpdate({
        target: [posBridgeDayChecks.orgId, posBridgeDayChecks.storeId, posBridgeDayChecks.posCalendarDate],
        set: {
          posStoreId: input.posStoreId,
          receiptCount: input.receiptCount,
          netSalesCentavos: input.netSalesCentavos,
          feedTotalCentavos: input.feedTotalCentavos,
          differenceCentavos: input.differenceCentavos,
          result: input.result,
          checkedAt: sql`now()`,
        },
      });
  } catch (e) {
    sanitise(e);
  }
}
