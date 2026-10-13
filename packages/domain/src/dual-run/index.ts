/**
 * The dual-run comparator's run: v1 snapshot + v2 ledger -> one report version per (store, week). T-392 S4.
 * docs/tasks/392-dual-run-comparator.md Contract section 1 (`compare`), R3, R7, R8, R12, R13 and "S4 rulings".
 *
 * Order, and why:
 *  1. `authorize('run_cutover')` first: the dual run is a cutover activity, and a dry run reads the whole book.
 *  2. Every refusal that needs no lock (keys sheet, store mapping) is thrown before anything else is touched.
 *  3. Per (week, store), in one fixed order: take the advisory lock (apply only), read v2, compare, check staleness and
 *     the R8 identity. NOTHING is written in this pass, so a refusal leaves the database as it was.
 *  4. Only then: insert each new report version with its lines, and one `audit_log` row for the run.
 *
 * The caller's transaction is used as is (a rollback undoes the whole run); `tx` null opens an org-scoped one.
 *
 * Warning: this module reads `packages/etl/src/dual-run` (the pure S1/S2 comparator) by relative path. `@shareat/etl`
 * depends on `@shareat/domain`, so the package import would be a cycle; the files read here import neither the domain
 * index nor the db. No disposition is written here: that is S5's server action (R10).
 */
import { createHash, randomUUID } from 'node:crypto';
import { authorize, type Actor } from '@shareat/auth';
import { fromCentavos, money, toCentavos, type Money } from '@shareat/core/money';
import {
  advisoryLocksRepo,
  auditLogRepo,
  dualRunRepo,
  masterLinksRepo,
  withOrgPrincipal,
  type DualRunV2Line,
  type Tx,
} from '@shareat/db';
import { STAFF_CASH_KEY, assertNoStaffCashRow, assertStoresTicked, parseKeysCsv, type KeyRow } from '../../../etl/src/dual-run/keys';
import { CLASS_CATALOGUE, type ClassCode } from '../../../etl/src/dual-run/classes';
import { compareStoreWeek, type Disposition, type StoreWeekResult } from '../../../etl/src/dual-run/compare';
import { computeV1Figures, type V1LineKind, type V1StoreFigures, type V1Warning } from '../../../etl/src/dual-run/v1-figures';
import type { ExcludedStore, V1Snapshot } from '../../../etl/src/dual-run/snapshot';
import { addDays, weekStartOf } from '../../../etl/src/dual-run/week';

export interface RunDualRunInput {
  /** Already parsed and verified by the CLI (`loadSnapshotFile`). */
  snapshot: V1Snapshot;
  /** sha256 of the snapshot FILE: provenance only, never part of the R8 identity. */
  snapshotSha: string;
  keysText: string;
  /** v2 `stores.code` filter (the CLI's --stores); omitted = every ticked store row. */
  storeCodes?: string[];
  /** false = dry run: nothing written, no audit row. */
  apply: boolean;
}

export interface RunDualRunLine {
  kind: string;
  key: string;
  /** Integer centavos. */
  v1: number;
  v2: number;
  delta: number;
  class: string;
  paired: boolean;
}

export interface RunDualRunWeek {
  storeId: string;
  storeCode: string;
  v1StoreId: string;
  weekStart: string;
  through: string;
  verdict: 'no_data' | 'ties' | 'explained' | 'open';
  comparedDays: number;
  lineCount: number;
  lines: RunDualRunLine[];
  status: 'dry' | 'inserted' | 'unchanged';
  /** v1 values that were not whole centavos (reported, never silently rounded). */
  warnings: V1Warning[];
  /** Apply only; for an 'unchanged' week, the current report. */
  reportId?: string;
}

export interface RunDualRunResult {
  applied: boolean;
  snapshotSha: string;
  keysSha: string;
  excluded: ExcludedStore[];
  weeks: RunDualRunWeek[];
  /** 2 when any week is 'open' (not a failure), else 0. */
  exitCode: 0 | 2;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const cents = (v: string): number => Number(toCentavos(money(v)));
const asMoney = (c: number): Money => fromCentavos(BigInt(c));
/** Orders two ASCII strings (business dates, store codes) with no relational operator on strings (T-371 G2). */
const cmp = (a: string, b: string): number => a.localeCompare(b, 'en');
const isAfter = (a: string, b: string): boolean => Math.sign(cmp(a, b)) === 1;

/** The v2 key a v2 line carries into the comparator; the keys sheet and the supplier links map v1 onto these. */
function v2KeyOf(l: DualRunV2Line): string {
  switch (l.kind) {
    case 'sales_tender':
      // credit sales: the debits to 1210 from ar_charge entries are one stated line, no sheet row (S4 tender keys).
      if (l.glCode === '1210') return 'credit';
      // 1220 takes a channel party: one line per channel. 1221/1222 take none and stay keyed by GL code.
      if (l.partyType === 'channel' && l.partyId) return `channel:${l.partyId}`;
      return l.partyType === 'money_account' && l.partyId ? l.partyId : l.glCode;
    case 'inventory_basis':
      // one line per store-week, key COGS (S4 tender keys): the per-code lines of v2Figures are summed by the comparator.
      return 'COGS';
    case 'staff_cash':
      // employee lines are summed per store under the stated key; any other party stays under itself (S2: UNEXPLAINED).
      if (l.partyType === 'employee') return STAFF_CASH_KEY;
      return `${l.glCode}:${l.partyId ?? 'none'}`;
    case 'cash_bank':
      return l.partyType === 'money_account' && l.partyId ? l.partyId : l.glCode;
    case 'expense_category':
      return l.categoryId ?? l.glCode;
    case 'ap_supplier': {
      const base = l.partyId ?? l.glCode;
      return l.glCode === '1240' ? `1240:${base}` : base;
    }
    default:
      return l.partyId ? `${l.glCode}:${l.partyId}` : l.glCode;
  }
}

function keyMapFor(
  v1StoreId: string,
  rows: readonly KeyRow[],
  store: V1StoreFigures,
  supplierLinks: ReadonlyMap<string, string>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (!r.ticked || r.v2Key.trim() === '' || r.v1Store !== v1StoreId) continue;
    if (r.section === 'money') {
      map[`cash_bank|${r.v1Key}`] = r.v2Key.trim();
      map[`sales_tender|${r.v1Key}`] = r.v2Key.trim();
    } else if (r.section === 'category') {
      map[`expense_category|${r.v1Key}`] = r.v2Key.trim();
    }
  }
  for (const l of store.lines) {
    if (l.kind !== 'ap_supplier') continue;
    const m = /^(ap|supplier_advance)__(.+)$/.exec(l.key);
    const v2 = m ? supplierLinks.get(m[2]!) : undefined;
    if (m && v2) map[`ap_supplier|${l.key}`] = m[1] === 'ap' ? v2 : `1240:${v2}`;
  }
  map['inventory_basis|COGS'] = 'COGS';
  map['sales_tender|credit'] = 'credit';
  map[`staff_cash|${STAFF_CASH_KEY}`] = STAFF_CASH_KEY;
  return map;
}

function mondays(from: string, through: string): string[] {
  const out: string[] = [];
  for (let w = weekStartOf(from); !isAfter(w, through); w = addDays(w, 7)) out.push(w);
  return out;
}

interface Planned {
  week: RunDualRunWeek;
  result: StoreWeekResult;
  existingId?: string;
}

export async function runDualRun(tx: Tx | null, actor: Actor, input: RunDualRunInput): Promise<RunDualRunResult> {
  if (tx === null) return withOrgPrincipal(actor.orgId, (own) => runDualRun(own, actor, input));
  await authorize(tx, actor, 'run_cutover', {});

  const { snapshot, apply } = input;
  const orgId = actor.orgId;
  const keysSha = sha256(input.keysText);
  const rows = parseKeysCsv(input.keysText);
  assertNoStaffCashRow(rows);
  assertStoresTicked(rows, snapshot.stores.map((s) => s.id));

  // Each snapshot store -> its v2 store, by the ticked store row's code.
  const wanted = new Set(input.storeCodes ?? []);
  const rowOf = new Map(rows.filter((r) => r.section === 'store').map((r) => [r.v1Key, r] as const));
  const codes = snapshot.stores.map((s) => rowOf.get(s.id)!.v2Key.trim());
  const found = new Map((await dualRunRepo.storesByCode(tx, orgId, codes)).map((s) => [s.code, s.id] as const));
  const targets: { v1StoreId: string; storeCode: string; storeId: string }[] = [];
  for (const s of snapshot.stores) {
    const code = rowOf.get(s.id)!.v2Key.trim();
    const storeId = found.get(code);
    if (!storeId) throw new Error(`keys sheet: store row for ${s.name} names ${code}, which is not a store of this organisation`);
    if (wanted.size === 0 || wanted.has(code)) targets.push({ v1StoreId: s.id, storeCode: code, storeId });
  }
  for (const c of wanted) {
    if (!targets.some((t) => t.storeCode === c)) throw new Error(`--stores ${c}: no ticked keys-sheet store row maps to that store`);
  }
  targets.sort((a, b) => cmp(a.storeCode, b.storeCode));

  const links = new Map<string, Map<string, string>>();
  for (const l of await masterLinksRepo.linksFor(tx, orgId, 'supplier')) {
    const m = links.get(l.v1StoreId) ?? new Map<string, string>();
    m.set(l.v1Id, l.v2Id);
    links.set(l.v1StoreId, m);
  }

  const extractedAt = new Date(snapshot.extractedAt);
  const planned: Planned[] = [];
  for (const weekStart of mondays(snapshot.from, snapshot.through)) {
    const sunday = addDays(weekStart, 6);
    const through = isAfter(sunday, snapshot.through) ? snapshot.through : sunday;
    const v1 = computeV1Figures(snapshot, { weekStart, through, keys: rows });
    for (const t of targets) {
      if (apply) await advisoryLocksRepo.lockDualRunWeek(tx, orgId, t.storeId, weekStart);
      const latest = await dualRunRepo.latestExtractedAt(tx, orgId, t.storeId, weekStart);
      if (latest && extractedAt.getTime() < latest.getTime()) {
        throw new Error(
          `snapshot extracted ${snapshot.extractedAt} is older than the latest report for ${t.storeCode} week ${weekStart} (${latest.toISOString()}); extract again`,
        );
      }
      const figures = v1.stores[t.v1StoreId]!;
      const v2 = await dualRunRepo.v2Figures(tx, orgId, { storeId: t.storeId, weekStart, through });
      const tradingDays = await dualRunRepo.verifiedSalesDays(tx, orgId, t.storeId, weekStart, through);
      const dispositions: Disposition[] = (await dualRunRepo.dispositionsFor(tx, orgId, t.storeId, weekStart)).map((d) => ({
        orgId,
        storeId: t.storeId,
        weekStart,
        kind: d.kind as V1LineKind,
        lineKey: d.lineKey,
        deltaAt: cents(d.deltaAt),
        class: d.class,
        ref: d.ref,
        createdAt: d.createdAt.toISOString(),
      }));
      const result = compareStoreWeek({
        orgId,
        storeId: t.storeId,
        weekStart,
        through,
        // v1 `cash__staff` is staff cash, a kind of its own (S4 tender keys): re-kinded so it meets v2 `staff_cash`.
        v1: { lines: figures.lines.map((l) => (l.kind === 'cash_bank' && l.key === STAFF_CASH_KEY ? { ...l, kind: 'staff_cash' as V1LineKind } : l)), tradingDays: figures.tradingDays, cashResidual: figures.cashResidual, scope: figures.scope, flags: figures.flags },
        v2: {
          // staff_cash and unassigned_store are v2-only kinds (S3 rulings 2 and 6); the comparator treats a kind as a label.
          lines: v2.lines.map((l) => ({
            kind: l.kind as V1LineKind,
            key: v2KeyOf(l),
            amount: cents(l.amount),
            days: Object.fromEntries(l.byDay.map((d) => [d.date, cents(d.amount)])),
          })),
          tradingDays,
        },
        keyMap: keyMapFor(t.v1StoreId, rows, figures, links.get(t.v1StoreId) ?? new Map()),
        // Document-level matching (R9) needs v2 documents, which S3's repo does not read: an unmatched delta stays UNEXPLAINED
        // (open) rather than being called NOT_DOUBLE_ENTERED without having looked at v2.
        v1Docs: [],
        v2Docs: [],
        dispositions,
      });
      const existing = apply
        ? await dualRunRepo.findReport(tx, {
            orgId,
            storeId: t.storeId,
            weekStart,
            through,
            v1Fingerprint: result.v1Fingerprint,
            keysSha,
            v2Fingerprint: result.v2Fingerprint,
          })
        : undefined;
      planned.push({
        result,
        existingId: existing?.id,
        week: {
          storeId: t.storeId,
          storeCode: t.storeCode,
          v1StoreId: t.v1StoreId,
          weekStart,
          through,
          verdict: result.verdict,
          comparedDays: result.comparedDays.length,
          lineCount: result.lines.length,
          lines: result.lines.map((l) => ({ kind: l.kind, key: l.key, v1: l.v1, v2: l.v2, delta: l.delta, class: l.class, paired: l.paired })),
          warnings: figures.warnings,
          status: apply ? (existing ? 'unchanged' : 'inserted') : 'dry',
          ...(existing ? { reportId: existing.id } : {}),
        },
      });
    }
  }

  if (apply) {
    for (const p of planned) {
      if (p.existingId) continue;
      const { id } = await dualRunRepo.insertReport(tx, {
        orgId,
        storeId: p.week.storeId,
        weekStart: p.week.weekStart,
        through: p.week.through,
        v1Fingerprint: p.result.v1Fingerprint,
        v2Fingerprint: p.result.v2Fingerprint,
        keysSha,
        v1SnapshotSha: input.snapshotSha,
        v1ExtractedAt: extractedAt,
        verdict: p.result.verdict,
        comparedDays: p.week.comparedDays,
        createdBy: actor.personId,
      });
      p.week.reportId = id;
      await dualRunRepo.insertLines(
        tx,
        id,
        p.result.lines.map((l) => ({
          kind: l.kind,
          lineKey: l.key,
          label: `${l.kind} ${l.key}`,
          v1Amount: asMoney(l.v1),
          v2Amount: asMoney(l.v2),
          delta: asMoney(l.delta),
          class: l.class,
          paired: l.paired,
          autoReason: l.class === 'TIES' ? null : CLASS_CATALOGUE[l.class as ClassCode].meaning,
          perDay: l.days.map((d) => ({ date: d.date, v1: asMoney(d.v1), v2: asMoney(d.v2), delta: asMoney(d.delta), state: d.state })),
          v1Counter: null,
          openingGap: null,
        })),
      );
    }
    await auditLogRepo.append(tx, orgId, {
      actorPersonId: actor.personId,
      action: 'dual_run.compare',
      storeId: null,
      entityId: randomUUID(),
      before: null,
      after: {
        snapshotSha: input.snapshotSha,
        keysSha,
        weeks: planned.map((p) => ({
          storeCode: p.week.storeCode,
          weekStart: p.week.weekStart,
          through: p.week.through,
          v1Fingerprint: p.result.v1Fingerprint,
          v2Fingerprint: p.result.v2Fingerprint,
          verdict: p.week.verdict,
          status: p.week.status,
          lineCount: p.week.lineCount,
          warnings: p.week.warnings,
        })),
      },
      source: 'etl',
    });
  }

  const weeks = planned.map((p) => p.week).sort((a, b) => cmp(a.weekStart, b.weekStart) || cmp(a.storeCode, b.storeCode));
  return {
    applied: apply,
    snapshotSha: input.snapshotSha,
    keysSha,
    excluded: snapshot.excludedStores,
    weeks,
    exitCode: weeks.some((w) => w.verdict === 'open') ? 2 : 0,
  };
}
