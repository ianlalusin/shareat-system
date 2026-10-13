/**
 * dual-run-reads - T-392 S5. The reads behind `/reports/dual-run`: the current report version per store-week, every
 * version of one store-week, the disposition history, the per-report line statistics and the display names of keys.
 * docs/tasks/392-dual-run-comparator.md "S5 spec (refinements)".
 *
 * Every function takes `tx` first and runs under the caller's principal (RLS is the backstop). Nothing here writes.
 * "Current" = the newest `(created_at, id)` of a store-week (R8). The versions are small (stores x weeks), so the
 * newest-first list is read once and reduced in code: no date or timestamp is compared as a string.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { dualRunDispositions, dualRunLines, dualRunReports, type DualRunKind, type DualRunVerdict } from '../../schema/dual-run';
import { moneyAccounts } from '../../schema/money-accounts';
import { expenseCategories } from '../../schema/expenses';
import { salesChannels } from '../../schema/sales-days';
import { stores } from '../../schema/stores';
import { suppliers } from '../../schema/suppliers';

export interface ReportVersionRow {
  id: string;
  storeId: string;
  storeCode: string;
  storeName: string;
  weekStart: string;
  through: string;
  v1Fingerprint: string;
  v2Fingerprint: string;
  keysSha: string;
  v1SnapshotSha: string;
  v1ExtractedAt: Date;
  verdict: DualRunVerdict;
  comparedDays: number;
  createdBy: string;
  createdAt: Date;
}

export interface CurrentReportRow extends ReportVersionRow {
  versionCount: number;
}

export interface DispositionHistoryRow {
  id: string;
  storeId: string;
  weekStart: string;
  kind: DualRunKind;
  lineKey: string;
  deltaAt: string;
  class: 'V1_DEFECT' | 'V2_DEFECT';
  ref: string;
  note: string;
  createdBy: string;
  createdAt: Date;
}

const versionColumns = {
  id: dualRunReports.id,
  storeId: dualRunReports.storeId,
  storeCode: stores.code,
  storeName: stores.name,
  weekStart: dualRunReports.weekStart,
  through: dualRunReports.through,
  v1Fingerprint: dualRunReports.v1Fingerprint,
  v2Fingerprint: dualRunReports.v2Fingerprint,
  keysSha: dualRunReports.keysSha,
  v1SnapshotSha: dualRunReports.v1SnapshotSha,
  v1ExtractedAt: dualRunReports.v1ExtractedAt,
  verdict: dualRunReports.verdict,
  comparedDays: dualRunReports.comparedDays,
  createdBy: dualRunReports.createdBy,
  createdAt: dualRunReports.createdAt,
};

/** Every version of every store-week in range, newest first within a store-week. */
async function versionsInRange(
  tx: Tx,
  orgId: string,
  input: { storeIds?: readonly string[]; fromWeek: string; toWeek: string },
): Promise<ReportVersionRow[]> {
  if (input.storeIds && input.storeIds.length === 0) return [];
  const where = and(
    eq(dualRunReports.orgId, orgId),
    gte(dualRunReports.weekStart, input.fromWeek),
    lte(dualRunReports.weekStart, input.toWeek),
    ...(input.storeIds ? [inArray(dualRunReports.storeId, [...input.storeIds])] : []),
  );
  return tx
    .select(versionColumns)
    .from(dualRunReports)
    .innerJoin(stores, eq(stores.id, dualRunReports.storeId))
    .where(where)
    .orderBy(asc(stores.name), asc(dualRunReports.storeId), asc(dualRunReports.weekStart), desc(dualRunReports.createdAt), desc(dualRunReports.id));
}

/** The newest version of each store-week in range, with how many versions the store-week holds. */
export async function currentReports(
  tx: Tx,
  orgId: string,
  input: { storeIds?: readonly string[]; fromWeek: string; toWeek: string },
): Promise<CurrentReportRow[]> {
  const all = await versionsInRange(tx, orgId, input);
  const out: CurrentReportRow[] = [];
  const index = new Map<string, number>();
  for (const r of all) {
    const k = `${r.storeId}|${r.weekStart}`;
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, out.length);
      out.push({ ...r, versionCount: 1 });
    } else {
      out[at]!.versionCount += 1;
    }
  }
  return out;
}

/** Every version of one store-week, newest first. */
export async function reportVersions(tx: Tx, orgId: string, storeId: string, weekStart: string): Promise<ReportVersionRow[]> {
  return versionsInRange(tx, orgId, { storeIds: [storeId], fromWeek: weekStart, toWeek: weekStart });
}

const dispositionColumns = {
  id: dualRunDispositions.id,
  storeId: dualRunDispositions.storeId,
  weekStart: dualRunDispositions.weekStart,
  kind: dualRunDispositions.kind,
  lineKey: dualRunDispositions.lineKey,
  deltaAt: dualRunDispositions.deltaAt,
  class: dualRunDispositions.class,
  ref: dualRunDispositions.ref,
  note: dualRunDispositions.note,
  createdBy: dualRunDispositions.createdBy,
  createdAt: dualRunDispositions.createdAt,
};

/** Every disposition of one store-week, oldest first (ties on created_at broken by id). */
export async function dispositionHistory(tx: Tx, orgId: string, storeId: string, weekStart: string): Promise<DispositionHistoryRow[]> {
  return tx
    .select(dispositionColumns)
    .from(dualRunDispositions)
    .where(and(eq(dualRunDispositions.orgId, orgId), eq(dualRunDispositions.storeId, storeId), eq(dualRunDispositions.weekStart, weekStart)))
    .orderBy(asc(dualRunDispositions.createdAt), asc(dualRunDispositions.id));
}

/** Every disposition of the given stores in a week range (the pack), oldest first. */
export async function dispositionsInRange(
  tx: Tx,
  orgId: string,
  input: { storeIds: readonly string[]; fromWeek: string; toWeek: string },
): Promise<DispositionHistoryRow[]> {
  if (input.storeIds.length === 0) return [];
  return tx
    .select(dispositionColumns)
    .from(dualRunDispositions)
    .where(
      and(
        eq(dualRunDispositions.orgId, orgId),
        inArray(dualRunDispositions.storeId, [...input.storeIds]),
        gte(dualRunDispositions.weekStart, input.fromWeek),
        lte(dualRunDispositions.weekStart, input.toWeek),
      ),
    )
    .orderBy(asc(dualRunDispositions.createdAt), asc(dualRunDispositions.id));
}

export interface LineStatRow {
  reportId: string;
  class: string;
  lines: number;
  /** Sum of |delta|, 2dp. */
  absDelta: string;
}

/** Per report and class: the lines whose delta is not zero. */
export async function nonZeroLineStats(tx: Tx, reportIds: readonly string[]): Promise<LineStatRow[]> {
  if (reportIds.length === 0) return [];
  const rows = await tx
    .select({
      reportId: dualRunLines.reportId,
      class: dualRunLines.class,
      lines: sql<number>`count(*)::int`,
      absDelta: sql<string>`coalesce(sum(abs(${dualRunLines.delta})), 0)::numeric(14,2)::text`,
    })
    .from(dualRunLines)
    .where(and(inArray(dualRunLines.reportId, [...reportIds]), sql`${dualRunLines.delta} <> 0`))
    .groupBy(dualRunLines.reportId, dualRunLines.class);
  return rows.map((r) => ({ reportId: r.reportId, class: r.class, lines: Number(r.lines), absDelta: r.absDelta }));
}

export interface StoreRow {
  id: string;
  code: string;
  name: string;
}

/** The org's active stores (the pack must be authorised for every one of them). */
export async function activeStores(tx: Tx, orgId: string): Promise<StoreRow[]> {
  return tx
    .select({ id: stores.id, code: stores.code, name: stores.name })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), eq(stores.isActive, true)))
    .orderBy(asc(stores.name), asc(stores.id));
}

/** Names of the stores with these ids (RLS keeps another org's invisible). */
export async function storesByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<StoreRow[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: stores.id, code: stores.code, name: stores.name })
    .from(stores)
    .where(and(eq(stores.orgId, orgId), inArray(stores.id, [...ids])));
}

const UUID_IN_KEY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Display names for line keys. A key is a supplier / money-account / expense-category / sales-channel UUID, optionally
 * as `channel:<uuid>` or `1240:<uuid>`. An unknown key, or a key that carries no UUID, maps to itself.
 */
export async function keyLabels(tx: Tx, orgId: string, keys: readonly string[]): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const k of keys) {
    const m = UUID_IN_KEY.exec(k);
    if (m) ids.set(k, m[0].toLowerCase());
  }
  const names = new Map<string, string>();
  const wanted = [...new Set(ids.values())];
  if (wanted.length > 0) {
    for (const r of await tx.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(and(eq(suppliers.orgId, orgId), inArray(suppliers.id, wanted)))) names.set(r.id, r.name);
    for (const r of await tx.select({ id: moneyAccounts.id, name: moneyAccounts.name }).from(moneyAccounts).where(and(eq(moneyAccounts.orgId, orgId), inArray(moneyAccounts.id, wanted)))) names.set(r.id, r.name);
    for (const r of await tx.select({ id: expenseCategories.id, name: expenseCategories.category }).from(expenseCategories).where(and(eq(expenseCategories.orgId, orgId), inArray(expenseCategories.id, wanted)))) names.set(r.id, r.name);
    for (const r of await tx.select({ id: salesChannels.id, name: salesChannels.name }).from(salesChannels).where(and(eq(salesChannels.orgId, orgId), inArray(salesChannels.id, wanted)))) names.set(r.id, r.name);
  }
  const out = new Map<string, string>();
  for (const k of keys) {
    const id = ids.get(k);
    const name = id ? names.get(id) : undefined;
    if (!name) {
      out.set(k, k);
    } else if (k.startsWith('channel:')) {
      out.set(k, `Channel ${name}`);
    } else if (k.startsWith('1240:')) {
      out.set(k, `Advance ${name}`);
    } else {
      out.set(k, name);
    }
  }
  return out;
}
