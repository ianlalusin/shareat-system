/**
 * The dual-run screens' reads - T-392 S5 (invariants 49-51). docs/tasks/392-dual-run-comparator.md "S5 spec (refinements)".
 *
 *  - `dualRunOverview`: the current version of each store-week, with its non-zero lines counted by class family.
 *  - `dualRunWeekView`: one store-week (current version, or an older one read-only) with its lines, labels, per-day states,
 *    dispositions, the "re-check" flag and the version history ("v1 changed" / "v2 changed" / "keys changed").
 *  - `dualRunPack`: the go/no-go pack for the 15 Nov sign-off.
 *
 * Every read authorizes `view_financial_reports` for the stores it shows. The pack authorizes EVERY active store of the
 * org, so a partly-scoped actor is refused here, in the domain, and not only by the page: a pack over a subset of
 * stores must never read `signable`.
 *
 * The comparator is the only writer of reports; nothing here writes. Money is centavos in code, 2dp strings out.
 * The class catalogue and the key order are read from the pure ETL files by relative path, as `dual-run/index.ts` does
 * (`@shareat/etl` depends on `@shareat/domain`, so the package import would be a cycle).
 */
import { authorize, type Actor } from '@shareat/auth';
import { fromCentavos, money, toCentavos } from '@shareat/core/money';
import { dualRunReadsRepo, dualRunRepo, type Tx } from '@shareat/db';
import { CLASS_CATALOGUE, type ClassFamily } from '../../../etl/src/dual-run/classes';
import { isDispositionableLine } from './dispositions';

type Row<T extends keyof typeof dualRunReadsRepo> = (typeof dualRunReadsRepo)[T] extends (...a: never[]) => Promise<infer R> ? R : never;
type DispositionRow = Row<'dispositionHistory'>[number];
type VersionRow = Row<'reportVersions'>[number];

const MIN_TOTAL_DAYS = 15;
const MIN_STORE_DAYS = 10;

const KIND_ORDER = ['cash_bank', 'staff_cash', 'sales_tender', 'expense_category', 'ap_supplier', 'inventory_basis', 'unassigned_store'] as const;
const FAMILY_ORDER: readonly ClassFamily[] = ['tie', 'policy', 'timing', 'encoder', 'defect', 'scope', 'open'];

const KIND_RANK = new Map<string, number>(KIND_ORDER.map((k, i) => [k, i]));
const cents = (v: string): bigint => toCentavos(money(v));
/** Orders two ASCII strings with no relational operator on strings (T-371 G2). */
const cmp = (a: string, b: string): number => a.localeCompare(b, 'en');

function familyOf(cls: string): ClassFamily {
  const entry = (CLASS_CATALOGUE as Record<string, { family: ClassFamily } | undefined>)[cls];
  return entry ? entry.family : 'open';
}
function meaningOf(cls: string): string {
  const entry = (CLASS_CATALOGUE as Record<string, { meaning: string } | undefined>)[cls];
  return entry ? entry.meaning : cls;
}

/** The disposition the comparator read for a line when it made `version`: the latest created at or before it. */
function appliedDisposition(all: readonly DispositionRow[], kind: string, lineKey: string, createdAt: Date): DispositionRow | undefined {
  const mine = all
    .filter((d) => d.kind === kind && d.lineKey === lineKey && d.createdAt.getTime() <= createdAt.getTime())
    .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || cmp(x.class, y.class) || cmp(x.ref, y.ref));
  return mine[mine.length - 1];
}

// ---------------------------------------------------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------------------------------------------------

export interface DualRunOverviewRow {
  storeId: string;
  storeCode: string;
  storeName: string;
  weekStart: string;
  through: string;
  reportId: string;
  verdict: string;
  comparedDays: number;
  versionCount: number;
  /** Count of non-zero-delta lines per class family. */
  families: Partial<Record<ClassFamily, number>>;
}

export async function dualRunOverview(
  tx: Tx,
  actor: Actor,
  input: { storeIds?: readonly string[]; fromWeek?: string; toWeek?: string } = {},
): Promise<DualRunOverviewRow[]> {
  const storeIds = input.storeIds ?? (await dualRunReadsRepo.activeStores(tx, actor.orgId)).map((s) => s.id);
  for (const storeId of storeIds) await authorize(tx, actor, 'view_financial_reports', { storeId });
  const current = await dualRunReadsRepo.currentReports(tx, actor.orgId, {
    storeIds,
    fromWeek: input.fromWeek ?? '2000-01-01',
    toWeek: input.toWeek ?? '2999-12-31',
  });
  const stats = await dualRunReadsRepo.nonZeroLineStats(tx, current.map((c) => c.id));
  const byReport = new Map<string, Partial<Record<ClassFamily, number>>>();
  for (const s of stats) {
    const fam = familyOf(s.class);
    const m = byReport.get(s.reportId) ?? {};
    m[fam] = (m[fam] ?? 0) + s.lines;
    byReport.set(s.reportId, m);
  }
  return current
    .map((c) => ({
      storeId: c.storeId,
      storeCode: c.storeCode,
      storeName: c.storeName,
      weekStart: c.weekStart,
      through: c.through,
      reportId: c.id,
      verdict: c.verdict,
      comparedDays: c.comparedDays,
      versionCount: c.versionCount,
      families: byReport.get(c.id) ?? {},
    }))
    .sort((a, b) => cmp(b.weekStart, a.weekStart) || cmp(a.storeName, b.storeName));
}

// ---------------------------------------------------------------------------------------------------------------------
// week view
// ---------------------------------------------------------------------------------------------------------------------

export interface WeekDispositionView {
  id: string;
  ref: string;
  class: string;
  deltaAt: string;
  note: string;
  createdBy: string;
  createdAt: Date;
}

export interface WeekLineView {
  kind: string;
  lineKey: string;
  /** The key's name when it resolves (supplier, account, category, channel), else the label the comparator stored. */
  label: string;
  v1: string;
  v2: string;
  delta: string;
  class: string;
  family: ClassFamily;
  meaning: string;
  autoReason: string | null;
  paired: boolean;
  perDay: { date: string; v1: string; v2: string; delta: string; state: string }[];
  /** The latest disposition of this line whose delta no longer matches: the comparator will not apply it. */
  reCheck: boolean;
  /** The latest disposition recorded for this line, whenever it was recorded. */
  latestDisposition: { ref: string; class: string; deltaAt: string; note: string; createdAt: Date } | null;
  /** Dispositions recorded after this version was made: they apply from the next compare run. */
  pending: WeekDispositionView[];
  /** A form may be offered for this line (the writer re-checks). */
  dispositionable: boolean;
}

export interface WeekVersionView {
  id: string;
  createdAt: Date;
  verdict: string;
  comparedDays: number;
  isCurrent: boolean;
  /** Against the next older version; empty for the oldest. */
  changes: ('v1 changed' | 'v2 changed' | 'keys changed')[];
}

export interface DualRunWeekView {
  store: { id: string; code: string; name: string };
  report: {
    id: string;
    weekStart: string;
    through: string;
    verdict: string;
    comparedDays: number;
    createdAt: Date;
    v1ExtractedAt: Date;
    isCurrent: boolean;
  };
  lines: WeekLineView[];
  versions: WeekVersionView[];
}

/** Null when the store-week has no report (or `versionId` is not one of its versions). */
export async function dualRunWeekView(
  tx: Tx,
  actor: Actor,
  input: { storeId: string; weekStart: string; versionId?: string },
): Promise<DualRunWeekView | null> {
  await authorize(tx, actor, 'view_financial_reports', { storeId: input.storeId });
  const versions = await dualRunReadsRepo.reportVersions(tx, actor.orgId, input.storeId, input.weekStart);
  const current = versions[0];
  if (!current) return null;
  const shown: VersionRow | undefined = input.versionId ? versions.find((v) => v.id === input.versionId) : current;
  if (!shown) return null;

  const rawLines = await dualRunRepo.linesOf(tx, shown.id);
  const dispositions = await dualRunReadsRepo.dispositionHistory(tx, actor.orgId, input.storeId, input.weekStart);
  const labels = await dualRunReadsRepo.keyLabels(tx, actor.orgId, rawLines.map((l) => l.lineKey));

  const lines: WeekLineView[] = rawLines.map((l) => {
    const mine = dispositions.filter((d) => d.kind === l.kind && d.lineKey === l.lineKey);
    const latest = mine[mine.length - 1];
    const applied = appliedDisposition(dispositions, l.kind, l.lineKey, shown.createdAt);
    const actionable = isDispositionableLine(l);
    const resolved = labels.get(l.lineKey);
    return {
      kind: l.kind,
      lineKey: l.lineKey,
      label: resolved !== undefined && resolved !== l.lineKey ? resolved : l.label,
      v1: l.v1Amount,
      v2: l.v2Amount,
      delta: l.delta,
      class: l.class,
      family: familyOf(l.class),
      meaning: meaningOf(l.class),
      autoReason: l.autoReason,
      paired: l.paired,
      perDay: l.perDay,
      reCheck: actionable && applied !== undefined && cents(applied.deltaAt) !== cents(l.delta),
      latestDisposition: latest
        ? { ref: latest.ref, class: latest.class, deltaAt: latest.deltaAt, note: latest.note, createdAt: latest.createdAt }
        : null,
      pending: mine
        .filter((d) => d.createdAt.getTime() > shown.createdAt.getTime())
        .map((d) => ({ id: d.id, ref: d.ref, class: d.class, deltaAt: d.deltaAt, note: d.note, createdBy: d.createdBy, createdAt: d.createdAt })),
      dispositionable: actionable,
    };
  });
  lines.sort((a, b) => (KIND_RANK.get(a.kind) ?? 99) - (KIND_RANK.get(b.kind) ?? 99) || cmp(a.lineKey, b.lineKey));

  const versionViews: WeekVersionView[] = versions.map((v, i) => {
    const older = versions[i + 1];
    const changes: WeekVersionView['changes'] = [];
    if (older) {
      if (older.v1Fingerprint !== v.v1Fingerprint) changes.push('v1 changed');
      if (older.v2Fingerprint !== v.v2Fingerprint) changes.push('v2 changed');
      if (older.keysSha !== v.keysSha) changes.push('keys changed');
    }
    return { id: v.id, createdAt: v.createdAt, verdict: v.verdict, comparedDays: v.comparedDays, isCurrent: v.id === current.id, changes };
  });

  return {
    store: { id: shown.storeId, code: shown.storeCode, name: shown.storeName },
    report: {
      id: shown.id,
      weekStart: shown.weekStart,
      through: shown.through,
      verdict: shown.verdict,
      comparedDays: shown.comparedDays,
      createdAt: shown.createdAt,
      v1ExtractedAt: shown.v1ExtractedAt,
      isCurrent: shown.id === current.id,
    },
    lines,
    versions: versionViews,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// the go/no-go pack
// ---------------------------------------------------------------------------------------------------------------------

export interface DualRunPack {
  fromWeek: string;
  toWeek: string;
  minTotalDays: number;
  minStoreDays: number;
  signable: boolean;
  /** One entry per failed criterion. A per-store shortfall reads `${store name} ${days} < ${MIN_STORE_DAYS}`. */
  reasons: string[];
  /** Compared days over COUNTED weeks of CURRENT versions only. */
  totalDays: number;
  /** Current versions whose verdict is not no_data. */
  countedWeeks: number;
  stores: { storeId: string; name: string; code: string; days: number }[];
  weeks: { storeId: string; weekStart: string; verdict: string; comparedDays: number; versionCount: number }[];
  noData: { storeId: string; weekStart: string }[];
  stale: { storeId: string; weekStart: string }[];
  classTotals: { class: string; family: ClassFamily; lines: number; absDelta: string }[];
  defects: { storeId: string; weekStart: string; kind: string; lineKey: string; label: string; class: string; ref: string }[];
}

export async function dualRunPack(tx: Tx, actor: Actor, input: { fromWeek: string; toWeek: string }): Promise<DualRunPack> {
  const orgId = actor.orgId;
  // Every active store of the org, whether or not it has a report.
  const active = await dualRunReadsRepo.activeStores(tx, orgId);
  for (const s of active) await authorize(tx, actor, 'view_financial_reports', { storeId: s.id });
  if (active.length === 0) await authorize(tx, actor, 'view_financial_reports', {});

  const current = await dualRunReadsRepo.currentReports(tx, orgId, { fromWeek: input.fromWeek, toWeek: input.toWeek });
  // A store with reports that is no longer active is still part of the evidence: authorize it too.
  const activeIds = new Set(active.map((s) => s.id));
  for (const id of new Set(current.map((c) => c.storeId))) {
    if (!activeIds.has(id)) await authorize(tx, actor, 'view_financial_reports', { storeId: id });
  }

  const counted = current.filter((c) => c.verdict !== 'no_data');
  const noData = current.filter((c) => c.verdict === 'no_data').map((c) => ({ storeId: c.storeId, weekStart: c.weekStart }));
  const totalDays = counted.reduce((n, c) => n + c.comparedDays, 0);

  const storeMap = new Map<string, { storeId: string; name: string; code: string; days: number }>();
  // Every active store dual-runs (a franchise is another org, a test store is inactive): no report in range = 0 days.
  for (const a of active) storeMap.set(a.id, { storeId: a.id, name: a.name, code: a.code, days: 0 });
  for (const c of current) {
    const s = storeMap.get(c.storeId) ?? { storeId: c.storeId, name: c.storeName, code: c.storeCode, days: 0 };
    if (c.verdict !== 'no_data') s.days += c.comparedDays;
    storeMap.set(c.storeId, s);
  }
  const stores = [...storeMap.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.storeId, b.storeId));

  const dispositions = await dualRunReadsRepo.dispositionsInRange(tx, orgId, {
    storeIds: [...storeMap.keys()],
    fromWeek: input.fromWeek,
    toWeek: input.toWeek,
  });
  const dispositionsOf = new Map<string, DispositionRow[]>();
  for (const d of dispositions) {
    const k = `${d.storeId}|${d.weekStart}`;
    const list = dispositionsOf.get(k) ?? [];
    list.push(d);
    dispositionsOf.set(k, list);
  }

  const stale: { storeId: string; weekStart: string }[] = [];
  for (const c of current) {
    const mine = dispositionsOf.get(`${c.storeId}|${c.weekStart}`) ?? [];
    if (mine.some((d) => d.createdAt.getTime() > c.createdAt.getTime())) stale.push({ storeId: c.storeId, weekStart: c.weekStart });
  }

  // Class totals over counted weeks (non-zero deltas, sum of |delta|); the defect list over every current version.
  const stats = await dualRunReadsRepo.nonZeroLineStats(tx, counted.map((c) => c.id));
  const totals = new Map<string, { lines: number; cents: bigint }>();
  for (const s of stats) {
    const t = totals.get(s.class) ?? { lines: 0, cents: 0n };
    t.lines += s.lines;
    t.cents += cents(s.absDelta);
    totals.set(s.class, t);
  }
  const classTotals = [...totals.entries()]
    .map(([cls, t]) => ({ class: cls, family: familyOf(cls), lines: t.lines, absDelta: fromCentavos(t.cents) as string }))
    .sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || cmp(a.class, b.class));

  const defects: DualRunPack['defects'] = [];
  const defectLines: { c: (typeof current)[number]; kind: string; lineKey: string; class: string }[] = [];
  for (const c of current) {
    for (const l of await dualRunRepo.linesOf(tx, c.id)) {
      if (l.class === 'V1_DEFECT' || l.class === 'V2_DEFECT') defectLines.push({ c, kind: l.kind, lineKey: l.lineKey, class: l.class });
    }
  }
  const labels = await dualRunReadsRepo.keyLabels(tx, orgId, defectLines.map((d) => d.lineKey));
  for (const d of defectLines) {
    const applied = appliedDisposition(dispositionsOf.get(`${d.c.storeId}|${d.c.weekStart}`) ?? [], d.kind, d.lineKey, d.c.createdAt);
    defects.push({
      storeId: d.c.storeId,
      weekStart: d.c.weekStart,
      kind: d.kind,
      lineKey: d.lineKey,
      label: labels.get(d.lineKey) ?? d.lineKey,
      class: d.class,
      ref: applied?.ref ?? '',
    });
  }
  defects.sort((a, b) => cmp(a.weekStart, b.weekStart) || cmp(a.storeId, b.storeId) || cmp(a.kind, b.kind) || cmp(a.lineKey, b.lineKey));

  // signable: every criterion named when it fails.
  const reasons: string[] = [];
  const nameOf = new Map(stores.map((s) => [s.storeId, s.name] as const));
  const open = counted.filter((c) => c.verdict === 'open');
  if (open.length > 0) {
    reasons.push(`${open.length} open week${open.length === 1 ? '' : 's'}: ${open.map((c) => `${nameOf.get(c.storeId) ?? c.storeId} ${c.weekStart}`).join(', ')}`);
  }
  if (totalDays < MIN_TOTAL_DAYS) reasons.push(`Total compared days ${totalDays} < ${MIN_TOTAL_DAYS}`);
  for (const s of stores) if (s.days < MIN_STORE_DAYS) reasons.push(`${s.name} ${s.days} < ${MIN_STORE_DAYS}`);
  if (stale.length > 0) {
    reasons.push(`re-run compare: a disposition is newer than the report for ${stale.map((s) => `${nameOf.get(s.storeId) ?? s.storeId} ${s.weekStart}`).join(', ')}`);
  }

  return {
    fromWeek: input.fromWeek,
    toWeek: input.toWeek,
    minTotalDays: MIN_TOTAL_DAYS,
    minStoreDays: MIN_STORE_DAYS,
    signable: reasons.length === 0,
    reasons,
    totalDays,
    countedWeeks: counted.length,
    stores,
    weeks: current.map((c) => ({ storeId: c.storeId, weekStart: c.weekStart, verdict: c.verdict, comparedDays: c.comparedDays, versionCount: c.versionCount })),
    noData,
    stale,
    classTotals,
    defects,
  };
}
