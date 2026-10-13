import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-392 S4 (TESTER) - the dual-run domain run. docs/tasks/392-dual-run-comparator.md Contract section 1 (`compare`), R3, R8, R10,
 * R12, R13, invariants 17, 20, 26, 27 (the DB half), 28, and "S3 rulings" 3, 4. Real Postgres (migrations 0194/0195).
 *
 * ---- PINNED CONTRACT (the spec names only the files; the builder follows these or says why not) ----
 * packages/domain/src/dual-run/index.ts, re-exported from @shareat/domain (one line in packages/domain/src/index.ts):
 *   runDualRun(tx: Tx | null, actor: Actor /* { personId, orgId } *\/, input: {
 *       snapshot: V1Snapshot;          // already parsed and verified by the CLI (loadSnapshotFile)
 *       snapshotSha: string;           // sha256 of the file bytes: PROVENANCE only (v1_snapshot_sha), never part of the R8 identity
 *       keysText: string;              // the keys sheet text; keysSha = sha256(keysText); parsed with parseKeysCsv
 *       storeCodes?: string[];         // v2 stores.code filter (the CLI's --stores); omitted = every ticked store row
 *       apply: boolean;                // false = dry run: nothing written, no audit row
 *   }): Promise<{
 *       applied: boolean; snapshotSha: string; keysSha: string; excluded: { id; name; reason }[];
 *       weeks: { storeId: string; storeCode: string; v1StoreId: string; weekStart: string; through: string;
 *                verdict: 'no_data'|'ties'|'explained'|'open'; comparedDays: number; lineCount: number;
 *                lines: { kind; key; v1: number; v2: number; delta: number; class: string; paired: boolean }[]   // integer CENTAVOS, delta = v2 - v1
 *                status: 'dry' | 'inserted' | 'unchanged'; reportId?: string /* apply only; the current report for an 'unchanged' week *\/ }[];
 *       exitCode: 0 | 2;               // 2 when any week is 'open' (not a failure)
 *   }>
 *   - tx null opens its own transaction; a passed tx is used as is (so the caller can roll the whole run back).
 *   - authorize(tx, actor, 'run_cutover', { storeId }) per store BEFORE the advisory lock or any write ('run_cutover': the spec names none
 *     for the run; it is the only capability the spec names for the comparator's writes, R10/S5).
 *   - one advisory xact lock per (org, store, week) is taken before the identity check; the report + its lines are inserted in the caller's
 *     one transaction; identity = (org, store, week_start, through, v1_fingerprint, keys_sha, v2_fingerprint) (R8).
 *   - every apply run writes EXACTLY ONE audit_log row: action 'dual_run.compare', entity 'dual_run', source 'etl',
 *     actor_person_id = actor.personId, after jsonb { snapshotSha, keysSha, weeks: [{ storeCode, weekStart, through, v1Fingerprint,
 *     v2Fingerprint, verdict, status, lineCount }] } - also when every week is 'unchanged'. A dry run writes none.
 *   - weeks = every Monday-week the snapshot spans ([from, through]); report.through = min(Sunday, snapshot.through).
 *   - a ticked keys-sheet `store` row maps a v1 store id to a v2 stores.code; the ap_supplier v2 key (and so dual_run_lines.line_key) is the
 *     v2 SUPPLIER UUID, resolved through v1_master_links (entity 'supplier', v1_store_id, v1_id); a v1 supplier with no link is keyed
 *     `v1:ap__<id>` and classed UNMAPPED_KEY. Cash: a `money` row maps v1 'cash__cashier' to the GL code '1110'.
 *   - v2 trading days for R13 = sales_days of the store with status 'verified' (a posted sales day).
 *   - refusals are thrown before ANY write: a snapshot store with no ticked store row, a ticked row naming no v2 store, a snapshot whose
 *     extractedAt is older than the latest report's v1_extracted_at for that store-week (message /older/i).
 *
 * Red today: packages/domain/src/dual-run/index.ts does not exist, so @shareat/domain has no runDualRun.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import * as domain from '@shareat/domain';
import { postEntry, reverseEntry } from '@shareat/domain';
import { serialiseKeysCsv, type KeyRow } from '../../../etl/src/dual-run/keys';
import { v1SalesDay } from '../../../etl/tests/fixtures/t392-v1-sales-day';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();
const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex');

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const PADRE = 'y1DMgfisuTHBF57cNL6i';

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

interface Fx {
  orgId: string;
  storeA: { id: string; code: string };
  storeB: { id: string; code: string };
  admin: Actor;
  staff: Actor;
  foreign: Actor;
  supId: string;
}

async function fixture(hint: string): Promise<Fx> {
  const code = uid(`T392S4${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-10-01', '2026-10-31', 'open')`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-11-01', '2026-11-30', 'open')`;
  const mkStore = async (n: string) => {
    const c = uid(n);
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${c}, ${`Store ${n}`}) returning id`;
    return { id: s!.id, code: c };
  };
  const storeA = await mkStore('LP');
  const storeB = await mkStore('MV');
  const mk = async (org: string, name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${org}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${org}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return { orgId: org, personId: p!.id } as Actor;
  };
  const admin = await mk(orgId, 'Admin', 'admin', [storeA.id, storeB.id]);
  const staff = await mk(orgId, 'Staff', 'staff', [storeA.id, storeB.id]);
  // an admin of ANOTHER org, who is nonetheless asked to run for this one
  const [org2] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${'Other'}, ${uid('T392S4X')}) returning id`;
  const [os] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${org2!.id}, ${uid('XS')}, 'X') returning id`;
  const foreign = await mk(org2!.id, 'Foreign admin', 'admin', [os!.id]);
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('Acme')}, ${admin.personId}) returning id`;
  await sql`insert into v1_master_links (org_id, entity, v1_store_id, v1_id, v2_id, created_by) values (${orgId}, 'supplier', ${L}, 'sup1', ${sup!.id}, ${admin.personId})`;
  return { orgId, storeA, storeB, admin, staff, foreign: { ...foreign }, supId: sup!.id };
}

const keyRows = (f: Fx, extra: KeyRow[] = [], stores: 'both' | 'lipa' = 'both'): KeyRow[] => [
  { section: 'store', v1Store: '', v1Key: L, v1Label: 'SharEat Lipa', v2Key: f.storeA.code, ticked: true },
  ...(stores === 'both' ? [{ section: 'store' as const, v1Store: '', v1Key: M, v1Label: 'SharEat Malvar', v2Key: f.storeB.code, ticked: true }] : []),
  ...extra,
];
const cashKey: KeyRow = { section: 'money', v1Store: L, v1Key: 'cash__cashier', v1Label: 'cash cashier', v2Key: '1110', ticked: true };

interface SnapOpts { expenses?: Any[]; journal?: Any[]; salesDays?: Any[]; extractedAt?: string; through?: string; from?: string; stores?: Any[] }
const snap = (o: SnapOpts = {}): Any => ({
  version: 1,
  from: o.from ?? '2026-10-19',
  through: o.through ?? '2026-10-25',
  window: { from: '2026-10-12', through: '2026-11-01' },
  extractedAt: o.extractedAt ?? '2026-10-26T01:00:00.000Z',
  stores: o.stores ?? [{ id: L, name: 'SharEat Lipa' }, { id: M, name: 'SharEat Malvar' }],
  excludedStores: [{ id: PADRE, name: 'SharEat Padre Garcia', reason: 'not operating yet' }],
  suppliers: [{ id: 'sup1', name: 'Acme' }],
  paymentAccounts: [],
  journal: o.journal ?? [],
  expenses: o.expenses ?? [],
  salesDays: o.salesDays ?? [],
});
let legSeq = 0;
const apLeg = (amount: number, date = '2026-10-21', extra: Any = {}): Any => ({
  id: `leg${++legSeq}`, storeId: L, businessDate: date, sourceType: 'expense_payment', sourceId: `src${legSeq}`, legKey: `k${legSeq}`,
  accountId: 'ap__sup1', direction: 'in', amount, status: 'posted', supplierId: 'sup1', ...extra,
});
const cashSaleLeg = (amount: number, date: string): Any => ({
  id: `leg${++legSeq}`, storeId: L, businessDate: date, sourceType: 'sale', sourceId: `sale${legSeq}`, legKey: `k${legSeq}`,
  accountId: 'cash__cashier', direction: 'in', amount, status: 'posted',
});
const salesDay = (date: string, remitted: number): Any => v1SalesDay(L, date, remitted);

/** v2: Dr 1310 / Cr 2110 for a supplier owed (the invoice), at store A. */
const postApInvoice = (f: Fx, date: string, amount: string, supplier = f.supId) =>
  withOrgPrincipal(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: date, sourceType: 'supplier_invoice', sourceId: uid('i'), idempotencyKey: uid('k'),
      lines: [
        { accountCode: '1310', storeId: f.storeA.id, debit: amount },
        { accountCode: '2110', storeId: f.storeA.id, partyType: 'supplier', partyId: supplier, credit: amount },
      ],
    }),
  );
const postCashSale = (f: Fx, date: string, amount: string) =>
  withOrgPrincipal(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: date, sourceType: 'sale', sourceId: uid('s'), idempotencyKey: uid('k'),
      lines: [{ accountCode: '1110', storeId: f.storeA.id, debit: amount }, { accountCode: '4100', storeId: f.storeA.id, credit: amount }],
    }),
  );
const verifiedSalesDay = async (f: Fx, date: string) =>
  sql`insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
      values (${f.orgId}, ${f.storeA.id}, ${date}, 'verified', '1000.00', '1000.00', '0.00', ${f.admin.personId})`;

interface RunOver { actor?: Actor; snapshot?: Any; snapshotSha?: string; keysText?: string; storeCodes?: string[]; apply?: boolean }
const run = (f: Fx, o: RunOver = {}): Promise<Any> => {
  const fn = (domain as Any).runDualRun as (tx: Tx | null, actor: Actor, input: Any) => Promise<Any>;
  const input = {
    snapshot: o.snapshot ?? snap({ journal: [apLeg(500)] }),
    snapshotSha: o.snapshotSha ?? sha256(uid('file')),
    keysText: o.keysText ?? serialiseKeysCsv(keyRows(f)),
    storeCodes: o.storeCodes,
    apply: o.apply ?? true,
  };
  return asOrg(f.orgId, (tx) => fn(tx, o.actor ?? f.admin, input));
};
const weekOf = (out: Any, code: string): Any => out.weeks.find((w: Any) => w.storeCode === code);
const apLineOf = (w: Any): Any => w.lines.find((l: Any) => l.kind === 'ap_supplier');
const counts = async (f: Fx) => ({
  reports: Number((await sql<Any[]>`select count(*)::int n from dual_run_reports where org_id = ${f.orgId}`)[0]!.n),
  lines: Number((await sql<Any[]>`select count(*)::int n from dual_run_lines where org_id = ${f.orgId}`)[0]!.n),
  audit: Number((await sql<Any[]>`select count(*)::int n from audit_log where org_id = ${f.orgId} and action = 'dual_run.compare'`)[0]!.n),
});

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ======================================================================================================
describe('R. compare reads the snapshot and v2Figures and runs S2 (verdict, no_data, compared days)', () => {
  it(
    'R1 (the sign, end to end): a supplier owed 500 on BOTH sides gives delta 0 on its ap_supplier line, class TIES; the stored line says the same. Mutant: 2110 read debit - credit (-500 vs 500). Red today: runDualRun undefined',
    async () => {
      const f = await fixture('r1');
      await postApInvoice(f, '2026-10-21', '500.00');
      const out = await run(f);
      const w = weekOf(out, f.storeA.code);
      const ap = apLineOf(w);
      expect(ap).toMatchObject({ key: f.supId, v1: 50000, v2: 50000, delta: 0, class: 'TIES' });
      const [row] = await sql<Any[]>`select l.delta::text d, l.v1_amount::text a, l.v2_amount::text b, l.class, l.line_key from dual_run_lines l
        join dual_run_reports r on r.id = l.report_id where r.org_id = ${f.orgId} and r.store_id = ${f.storeA.id} and l.kind = 'ap_supplier'`;
      expect(row).toMatchObject({ d: '0.00', a: '500.00', b: '500.00', class: 'TIES', line_key: f.supId });
    },
    60_000,
  );

  it(
    'R2: a traded day on both sides with equal cash ties the week: verdict ties, compared_days 1, stored on the report. Mutant: compared days counted from the week delta / v2 trading days ignored. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('r2');
      await verifiedSalesDay(f, '2026-10-20');
      await postCashSale(f, '2026-10-20', '1000.00');
      const out = await run(f, {
        snapshot: snap({ journal: [cashSaleLeg(1000, '2026-10-20')], salesDays: [salesDay('2026-10-20', 1000)] }),
        keysText: serialiseKeysCsv(keyRows(f, [cashKey])),
      });
      const w = weekOf(out, f.storeA.code);
      expect(w).toMatchObject({ verdict: 'ties', comparedDays: 1, status: 'inserted' });
      expect(out.exitCode).toBe(0);
      const [r] = await sql<Any[]>`select verdict, compared_days from dual_run_reports where id = ${w.reportId}`;
      expect(r).toMatchObject({ verdict: 'ties', compared_days: 1 });
    },
    60_000,
  );

  it(
    'R3 (invariant 17, ruling 3): a store-week with no data on either side is no_data with 0 compared days and is still recorded. Mutant: all-zero read as ties. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('r3');
      const out = await run(f); // store B (Malvar) has nothing in the snapshot and nothing in v2
      const w = weekOf(out, f.storeB.code);
      expect(w).toMatchObject({ verdict: 'no_data', comparedDays: 0, lineCount: 0, status: 'inserted' });
      const [r] = await sql<Any[]>`select verdict, compared_days from dual_run_reports where id = ${w.reportId}`;
      expect(r).toMatchObject({ verdict: 'no_data', compared_days: 0 });
    },
    60_000,
  );

  it(
    'R4 (R12, exit code): a v1-only supplier debt with no v2 entry is open, classed NOT_DOUBLE_ENTERED (S4b: R9 document matching is wired, and v2 holds no candidate), and exitCode 2; a recorded V2_DEFECT disposition at that exact delta is read and classes the line V2_DEFECT (week stays open: 0 compared days, S2 ruling, exitCode 2); the CLI path READS dispositions. Mutant: dispositions ignored. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('r4');
      const open = await run(f, { apply: false });
      expect(weekOf(open, f.storeA.code)).toMatchObject({ verdict: 'open' });
      expect(apLineOf(weekOf(open, f.storeA.code))).toMatchObject({ v1: 50000, v2: 0, delta: -50000 });
      expect(apLineOf(weekOf(open, f.storeA.code)).class).toBe('NOT_DOUBLE_ENTERED');
      expect(open.exitCode).toBe(2);
      await sql`insert into dual_run_dispositions (org_id, store_id, week_start, kind, line_key, delta_at, class, ref, note, created_by)
                values (${f.orgId}, ${f.storeA.id}, '2026-10-19', 'ap_supplier', ${f.supId}, '-500.00', 'V2_DEFECT', 'DEF-901', 'invoice not entered', ${f.admin.personId})`;
      const closed = await run(f, { apply: false });
      expect(weekOf(closed, f.storeA.code).verdict).toBe('open'); // S2 ruling: 0 compared days is never explained
      expect(apLineOf(weekOf(closed, f.storeA.code))).toMatchObject({ class: 'V2_DEFECT' });
      expect(closed.exitCode).toBe(2);
    },
    60_000,
  );

  it(
    'R5 (invariant 20): a v1 supplier with NO v1_master_links row is its own line v1:ap__<id> classed UNMAPPED_KEY, never merged into another supplier. Mutant: silent merge. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('r5');
      await postApInvoice(f, '2026-10-21', '500.00');
      const leg = apLeg(500, '2026-10-21', { accountId: 'ap__supNOLINK', supplierId: 'supNOLINK' });
      const out = await run(f, { snapshot: snap({ journal: [leg] }) });
      const lines = weekOf(out, f.storeA.code).lines.filter((l: Any) => l.kind === 'ap_supplier');
      const unmapped = lines.find((l: Any) => l.key === 'v1:ap__supNOLINK');
      expect(unmapped).toMatchObject({ class: 'UNMAPPED_KEY', v1: 50000, v2: 0 });
      expect(lines.find((l: Any) => l.key === f.supId)).toMatchObject({ v1: 0, v2: 50000 });
    },
    60_000,
  );

  it(
    'R6 (dates are Manila business dates): a leg businessDate 2026-10-25 whose createdAtMs is already 26 Oct in Manila stays in the 19 Oct week; a leg dated 26 Oct is not in it; --through mid-week shows `through` and ignores a later v2 entry. Mutant: week from a timestamp / through ignored. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('r6');
      await postApInvoice(f, '2026-10-25', '500.00');
      const sunday = apLeg(500, '2026-10-25', { createdAtMs: Date.UTC(2026, 9, 25, 17, 0, 0) });
      const nextWeek = apLeg(999, '2026-10-26', { createdAtMs: Date.UTC(2026, 9, 25, 15, 0, 0) });
      const out = await run(f, { snapshot: snap({ journal: [sunday, nextWeek], through: '2026-10-26' }) });
      const w19 = out.weeks.find((w: Any) => w.storeCode === f.storeA.code && w.weekStart === '2026-10-19');
      expect(w19.through).toBe('2026-10-25');
      expect(apLineOf(w19)).toMatchObject({ v1: 50000, v2: 50000, delta: 0 });
      const w26 = out.weeks.find((w: Any) => w.storeCode === f.storeA.code && w.weekStart === '2026-10-26');
      expect(w26.through).toBe('2026-10-26');
      expect(apLineOf(w26)).toMatchObject({ v1: 99900, v2: 0 });

      const g = await fixture('r6b');
      await postApInvoice(g, '2026-10-21', '500.00');
      await postApInvoice(g, '2026-10-24', '100.00'); // after --through: must not count
      const early = await run(g, { snapshot: snap({ journal: [apLeg(500, '2026-10-21')], through: '2026-10-22' }) });
      const we = weekOf(early, g.storeA.code);
      expect(we.through).toBe('2026-10-22');
      expect(apLineOf(we)).toMatchObject({ v1: 50000, v2: 50000, delta: 0 });
      const [r] = await sql<Any[]>`select week_start::text w, through::text t from dual_run_reports where id = ${we.reportId}`;
      expect(r).toMatchObject({ w: '2026-10-19', t: '2026-10-22' });
    },
    90_000,
  );

  it(
    'R7: --stores (storeCodes) limits the run to those v2 stores: the other store gets no report. The excluded stores are carried on the outcome. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('r7');
      const out = await run(f, { storeCodes: [f.storeA.code] });
      expect(out.weeks.map((w: Any) => w.storeCode)).toEqual([f.storeA.code]);
      expect((await counts(f)).reports).toBe(1);
      expect(out.excluded).toEqual([{ id: PADRE, name: 'SharEat Padre Garcia', reason: 'not operating yet' }]);
    },
    60_000,
  );
});

describe('I. idempotence and versions (R8, invariant 26)', () => {
  it(
    'I1: the same inputs twice: second run inserts nothing and says unchanged; a RE-EXTRACTED unchanged v1 (new file sha, later extractedAt) is unchanged too. Mutants: upsert; identity on the file sha. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('i1');
      await postApInvoice(f, '2026-10-21', '500.00');
      const first = await run(f);
      const before = await counts(f);
      const second = await run(f, { snapshot: snap({ journal: [apLeg(500)], extractedAt: '2026-10-27T01:00:00.000Z' }), snapshotSha: sha256('another extract') });
      expect(weekOf(first, f.storeA.code).status).toBe('inserted');
      expect(weekOf(second, f.storeA.code).status).toBe('unchanged');
      expect(weekOf(second, f.storeA.code).reportId).toBe(weekOf(first, f.storeA.code).reportId);
      const after = await counts(f);
      expect(after.reports).toBe(before.reports);
      expect(after.lines).toBe(before.lines);
    },
    60_000,
  );

  it(
    'I2: one centavo changed in v2 is a NEW version; the old one is intact (same id, same lines) and the latest by created_at is the new one. v1 changing does the same. Mutant: update in place. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('i2');
      await postApInvoice(f, '2026-10-21', '500.00');
      const first = await run(f);
      const id1 = weekOf(first, f.storeA.code).reportId;
      const linesBefore = await sql<Any[]>`select kind, line_key, v1_amount::text a, v2_amount::text b, delta::text d from dual_run_lines where report_id = ${id1} order by kind, line_key`;
      await postApInvoice(f, '2026-10-22', '0.01');
      const second = await run(f, { snapshot: snap({ journal: [apLeg(500)], extractedAt: '2026-10-27T01:00:00.000Z' }) });
      const id2 = weekOf(second, f.storeA.code).reportId;
      expect(weekOf(second, f.storeA.code).status).toBe('inserted');
      expect(id2).not.toBe(id1);
      expect(apLineOf(weekOf(second, f.storeA.code))).toMatchObject({ v1: 50000, v2: 50001, delta: 1 });
      const linesAfter = await sql<Any[]>`select kind, line_key, v1_amount::text a, v2_amount::text b, delta::text d from dual_run_lines where report_id = ${id1} order by kind, line_key`;
      expect(linesAfter).toEqual(linesBefore);
      const [latest] = await sql<Any[]>`select id from dual_run_reports where org_id = ${f.orgId} and store_id = ${f.storeA.id} and week_start = '2026-10-19' order by created_at desc limit 1`;
      expect(latest!.id).toBe(id2);

      // v1 restates in place (same leg id, new amount): a third version.
      const leg = apLeg(500);
      const third = await run(f, { snapshot: snap({ journal: [{ ...leg, amount: 500.01 }], extractedAt: '2026-10-28T01:00:00.000Z' }) });
      expect(weekOf(third, f.storeA.code).status).toBe('inserted');
      expect((await counts(f)).reports).toBe(4); // store A: three versions; store B (no_data) stays at one
    },
    90_000,
  );

  it(
    'I3: two identical applies racing for one (org, store, week) both succeed: exactly one inserts, one is unchanged, one report row. Mutant: no per-(org, store, week) advisory lock (the loser dies on the identity unique). Red today: runDualRun undefined',
    async () => {
      const f = await fixture('i3');
      await postApInvoice(f, '2026-10-21', '500.00');
      const [a, b] = await Promise.all([run(f, { storeCodes: [f.storeA.code] }), run(f, { storeCodes: [f.storeA.code] })]);
      const statuses = [weekOf(a, f.storeA.code).status, weekOf(b, f.storeA.code).status].sort();
      expect(statuses).toEqual(['inserted', 'unchanged']);
      expect((await counts(f)).reports).toBe(1);
    },
    90_000,
  );

  it(
    'I4: the report and its lines are written in the CALLER\'s one transaction: rolling the caller back leaves no report, no lines and no audit row. Mutant: the run opens its own transaction. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('i4');
      await postApInvoice(f, '2026-10-21', '500.00');
      const fn = (domain as Any).runDualRun as (tx: Tx | null, actor: Actor, input: Any) => Promise<Any>;
      await expect(
        asOrg(f.orgId, async (tx) => {
          await fn(tx, f.admin, { snapshot: snap({ journal: [apLeg(500)] }), snapshotSha: sha256('x'), keysText: serialiseKeysCsv(keyRows(f)), apply: true });
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
    },
    60_000,
  );
});

describe('D. dry run, audit row (invariant 27 DB half)', () => {
  it(
    'D1: a dry run writes nothing (no report, no line, no audit row) and returns what apply would write (status dry, lines, no reportId). Mutant: dry run commits. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('d1');
      await postApInvoice(f, '2026-10-21', '500.00');
      const out = await run(f, { apply: false });
      expect(out.applied).toBe(false);
      const w = weekOf(out, f.storeA.code);
      expect(w.status).toBe('dry');
      expect(w.reportId).toBeUndefined();
      expect(w.lineCount).toBe(w.lines.length);
      expect(w.lineCount).toBeGreaterThan(0);
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
    },
    60_000,
  );

  it(
    'D2: an apply writes EXACTLY ONE audit_log row for the run (not one per store-week): actor, snapshot sha, keys sha, the fingerprints and counts; a second, unchanged run adds its own single row. Mutant: row per report / none when unchanged. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('d2');
      await postApInvoice(f, '2026-10-21', '500.00');
      const keysText = serialiseKeysCsv(keyRows(f));
      const out = await run(f, { snapshotSha: sha256('file-one'), keysText });
      expect(out.weeks).toHaveLength(2); // two store-weeks
      const rows = await sql<Any[]>`select actor_person_id, entity, source, after from audit_log where org_id = ${f.orgId} and action = 'dual_run.compare'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_person_id: f.admin.personId, entity: 'dual_run', source: 'etl' });
      const after = rows[0]!.after;
      expect(after).toMatchObject({ snapshotSha: sha256('file-one'), keysSha: sha256(keysText) });
      expect(after.weeks).toHaveLength(2);
      const a = after.weeks.find((w: Any) => w.storeCode === f.storeA.code);
      expect(a).toMatchObject({ weekStart: '2026-10-19', through: '2026-10-25', verdict: 'open', status: 'inserted' });
      expect(a.v1Fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(a.v2Fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(out.keysSha).toBe(sha256(keysText));
      await run(f, { snapshotSha: sha256('file-two'), keysText });
      expect((await counts(f)).audit).toBe(2);
      // the snapshot sha is provenance on the report
      const [r] = await sql<Any[]>`select v1_snapshot_sha from dual_run_reports where id = ${weekOf(out, f.storeA.code).reportId}`;
      expect(r!.v1_snapshot_sha).toBe(sha256('file-one'));
    },
    60_000,
  );
});

describe('A. authorization and refusals (nothing is written on any of them)', () => {
  it(
    'A1: a staff-role person is refused (AuthorizationError, run_cutover); an admin of ANOTHER org asked to run for this org is refused. Neither writes. Mutant: authorize missing / after the write. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('a1');
      await postApInvoice(f, '2026-10-21', '500.00');
      await expect(run(f, { actor: f.staff })).rejects.toBeInstanceOf(AuthorizationError);
      await expect(run(f, { actor: { orgId: f.orgId, personId: f.foreign.personId } })).rejects.toBeInstanceOf(AuthorizationError);
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
      // and a dry run needs the same right: it reads the whole book
      await expect(run(f, { actor: f.staff, apply: false })).rejects.toBeInstanceOf(AuthorizationError);
      // the admin works
      expect(weekOf(await run(f), f.storeA.code).status).toBe('inserted');
    },
    60_000,
  );

  it(
    'A2 (invariant 10 at the run): a snapshot store with NO ticked store row refuses the whole run (exit-1 refusal), and a ticked row naming no v2 store is refused; nothing written for either, not even the mapped store. Mutant: skip the store. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('a2');
      await postApInvoice(f, '2026-10-21', '500.00');
      await expect(run(f, { keysText: serialiseKeysCsv(keyRows(f, [], 'lipa')) })).rejects.toThrow(/store|keys/i);
      const bad = keyRows(f).map((r) => (r.v1Key === M ? { ...r, v2Key: 'NO-SUCH-STORE' } : r));
      await expect(run(f, { keysText: serialiseKeysCsv(bad) })).rejects.toThrow(/store|keys/i);
      const unticked = keyRows(f).map((r) => (r.v1Key === M ? { ...r, ticked: false } : r));
      await expect(run(f, { keysText: serialiseKeysCsv(unticked) })).rejects.toThrow(/store|keys|ticked/i);
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
    },
    60_000,
  );

  it(
    'A3 (R3, contract): a snapshot OLDER than the week\'s latest version\'s extract is refused (/older/i) and writes nothing new; an equal extractedAt is allowed. Mutant: no staleness check. Red today: runDualRun undefined',
    async () => {
      const f = await fixture('a3');
      await postApInvoice(f, '2026-10-21', '500.00');
      await run(f, { snapshot: snap({ journal: [apLeg(500)], extractedAt: '2026-10-28T01:00:00.000Z' }) });
      const before = await counts(f);
      await expect(
        run(f, { snapshot: snap({ journal: [apLeg(999)], extractedAt: '2026-10-27T01:00:00.000Z' }) }),
      ).rejects.toThrow(/older/i);
      expect(await counts(f)).toEqual(before);
      const same = await run(f, { snapshot: snap({ journal: [apLeg(500)], extractedAt: '2026-10-28T01:00:00.000Z' }) });
      expect(weekOf(same, f.storeA.code).status).toBe('unchanged');
    },
    90_000,
  );
});

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const postRaw = (f: Fx, date: string, sourceType: string, lines: Any[], sourceId = uid('x')) =>
  withOrgPrincipal(f.orgId, (tx) =>
    postEntry(tx, { orgId: f.orgId, entryDate: date, sourceType, sourceId, idempotencyKey: uid('k'), lines }),
  );
const v1Expense = (id: string, group: string, amount: number, date = '2026-10-21'): Any => ({
  id, storeId: L, dayKey: date, totalAmount: amount, status: 'posted', supplierId: 'sup1', expenseEntryId: `ent-${id}`,
  expenseEntryGroup: group, category: 'X', payments: [],
});
const linesOfKind = (out: Any, code: string, kind: string): Any[] => weekOf(out, code).lines.filter((l: Any) => l.kind === kind);

describe('M. one comparison line per fact (audit rulings a-c, l)', () => {
  it(
    'M1 (a, S4 tender keys: staff cash): v1 cash__staff and v2 staff_cash for the same store-week and amount give ONE line, key cash__staff, delta 0; no UNMAPPED_KEY or UNEXPLAINED half, and no keys-sheet row is needed. Mutant: v1 cash_bank and v2 staff_cash left as two kinds. Red if the halves stay apart',
    async () => {
      const f = await fixture('m1');
      await postRaw(f, '2026-10-22', 'money_transfer', [
        { accountCode: '1120', storeId: f.storeA.id, partyType: 'employee', partyId: uid('emp'), debit: '300.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '300.00' },
      ]);
      const leg = { id: 'staff1', storeId: L, businessDate: '2026-10-22', sourceType: 'expense_payment', sourceId: 'sx', legKey: 'kx', accountId: 'cash__staff', direction: 'in', amount: 300, status: 'posted' };
      const out = await run(f, { snapshot: snap({ journal: [leg] }), apply: false });
      const w = weekOf(out, f.storeA.code);
      const halves = w.lines.filter((l: Any) => l.kind === 'staff_cash' || l.key.includes('cash__staff') || l.key.includes('1120'));
      expect(halves, JSON.stringify(halves)).toHaveLength(1);
      expect(halves[0]).toMatchObject({ key: 'cash__staff', v1: 30000, v2: 30000, delta: 0, class: 'TIES' });
      expect(w.lines.some((l: Any) => l.class === 'UNMAPPED_KEY' || l.class === 'UNEXPLAINED')).toBe(false);
    },
    60_000,
  );

  it(
    'M2 (b, l): v2 lines on 1310, 5100 and 5110 and the v1 COGS line are ONE inventory_basis line keyed COGS, v2 = sum(debit - credit); store-less inventory lines stay on unassigned_store, not on COGS. Mutant: one line per GL code / store-less folded in. Red if v2 stays split',
    async () => {
      const f = await fixture('m2');
      await postRaw(f, '2026-10-20', 'delivery', [{ accountCode: '1310', storeId: f.storeA.id, debit: '800.00' }, { accountCode: '2120', storeId: f.storeA.id, credit: '800.00' }]);
      await postRaw(f, '2026-10-21', 'stock_usage', [{ accountCode: '5100', storeId: f.storeA.id, debit: '200.00' }, { accountCode: '1310', storeId: f.storeA.id, credit: '200.00' }]);
      await postRaw(f, '2026-10-21', 'stock_usage', [{ accountCode: '5110', storeId: f.storeA.id, debit: '50.00' }, { accountCode: '1310', storeId: f.storeA.id, credit: '50.00' }]);
      await postRaw(f, '2026-10-22', 'delivery', [{ accountCode: '1310', storeId: null, debit: '60.00' }, { accountCode: '2120', storeId: null, credit: '60.00' }]);
      const out = await run(f, { snapshot: snap({ expenses: [v1Expense('cogs1', 'COGS', 800)] }), apply: false });
      const inv = linesOfKind(out, f.storeA.code, 'inventory_basis');
      expect(inv, JSON.stringify(inv)).toHaveLength(1);
      expect(inv[0]).toMatchObject({ key: 'COGS', v1: 80000, v2: 80000 });
      const un = linesOfKind(out, f.storeA.code, 'unassigned_store');
      expect(JSON.stringify(un)).toContain('6000'); // the 60.00 store-less receipt is visible, apart from COGS
    },
    60_000,
  );

  it(
    'M3 (c): the 1240 supplier advance: v1 supplier_advance__sup1 and v2 1240 for the mapped supplier are ONE line with delta 0 when equal (same sign), keyed 1240:<supplier uuid>, never v1:supplier_advance__sup1. Mutant: sign flipped / unlinked key. Red if the halves stay apart',
    async () => {
      const f = await fixture('m3');
      await postRaw(f, '2026-10-21', 'ap_payment', [
        { accountCode: '1240', storeId: f.storeA.id, partyType: 'supplier', partyId: f.supId, debit: '200.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '200.00' },
      ]);
      const leg = apLeg(200, '2026-10-21', { accountId: 'supplier_advance__sup1', sourceType: 'ap_payment' });
      const out = await run(f, { snapshot: snap({ journal: [leg] }), apply: false });
      const adv = linesOfKind(out, f.storeA.code, 'ap_supplier');
      expect(adv, JSON.stringify(adv)).toHaveLength(1);
      expect(adv[0]).toMatchObject({ key: `1240:${f.supId}`, v1: 20000, v2: 20000, delta: 0 });
    },
    60_000,
  );

  it(
    'M4 (c): a v2 1240 line with a NULL party never produces the key 1240:1240 (a refusal to post such a line also passes). Mutant: partyId ?? glCode. Red if the key is built from the GL code',
    async () => {
      const f = await fixture('m4');
      let posted = true;
      try {
        await postRaw(f, '2026-10-21', 'adjustment', [
          { accountCode: '1240', storeId: f.storeA.id, debit: '75.00' },
          { accountCode: '4100', storeId: f.storeA.id, credit: '75.00' },
        ]);
      } catch {
        posted = false;
      }
      if (!posted) return;
      const out = await run(f, { snapshot: snap(), apply: false });
      expect(weekOf(out, f.storeA.code).lines.map((l: Any) => l.key)).not.toContain('1240:1240');
    },
    60_000,
  );
});

describe('T. tender keys (S4 tender keys ruling, i-k)', () => {
  const salesDayWith = (date: string, extra: Any): Any => v1SalesDay(L, date, 300, extra);

  it(
    'T1 (i): credit: v1 creditSales 300 and a v2 ar_charge Dr 1210 300 (customer party) at the store give ONE sales_tender line keyed `credit`, delta 0, with no keys-sheet row; a 1210 CREDIT (a collection) is excluded. Mutant: collection counted / credit needs a sheet row. Red if credit is unmapped',
    async () => {
      const f = await fixture('t1');
      const charge = uid('chg');
      await postRaw(f, '2026-10-21', 'ar_charge', [
        { accountCode: '1210', storeId: f.storeA.id, partyType: 'customer', partyId: uid('cust'), debit: '300.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '300.00' },
      ], charge);
      await postRaw(f, '2026-10-22', 'ar_collection', [
        { accountCode: '1110', storeId: f.storeA.id, debit: '120.00' },
        { accountCode: '1210', storeId: f.storeA.id, partyType: 'customer', partyId: uid('cust'), credit: '120.00' },
      ]);
      const out = await run(f, { snapshot: snap({ salesDays: [salesDayWith('2026-10-21', { creditSales: 300 })] }), apply: false });
      const credit = linesOfKind(out, f.storeA.code, 'sales_tender').filter((l: Any) => l.key === 'credit');
      expect(credit, JSON.stringify(credit)).toHaveLength(1);
      expect(credit[0]).toMatchObject({ v1: 30000, v2: 30000, delta: 0 });
      expect(weekOf(out, f.storeA.code).lines.some((l: Any) => l.kind === 'sales_tender' && l.key.includes('1210'))).toBe(false);
    },
    60_000,
  );

  it(
    'T2 (j): other: with the store\'s `other` money row naming a money account, v1 other 200 and v2 200 on that account are ONE line, delta 0. Mutant: other keyed by GL code. Red if unmapped',
    async () => {
      const f = await fixture('t2');
      const [acct] = await sql<{ id: string }[]>`
        insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
        values (${f.orgId}, ${f.storeA.id}, 'Other tender', 'ewallet', '1140', 'cashier') returning id`;
      await postRaw(f, '2026-10-21', 'sale', [
        { accountCode: '1140', storeId: f.storeA.id, partyType: 'money_account', partyId: acct!.id, debit: '200.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '200.00' },
      ]);
      const row: KeyRow = { section: 'money', v1Store: L, v1Key: 'other', v1Label: 'other', v2Key: acct!.id, ticked: true };
      const out = await run(f, {
        snapshot: snap({ salesDays: [{ ...salesDay('2026-10-21', 200), otherPaymentSales: 200 }] }),
        keysText: serialiseKeysCsv(keyRows(f, [row])), apply: false,
      });
      const other = linesOfKind(out, f.storeA.code, 'sales_tender').filter((l: Any) => l.v1 === 20000 || l.v2 === 20000);
      expect(other, JSON.stringify(other)).toHaveLength(1);
      expect(other[0]).toMatchObject({ key: acct!.id, v1: 20000, v2: 20000, delta: 0 });
    },
    60_000,
  );

  it(
    'T3 (j): other with row `none`: a non-zero v1 other 200 is class NOT_DOUBLE_ENTERED exactly (not UNEXPLAINED); an UNTICKED other row is UNMAPPED_KEY. Red if other is silently dropped',
    async () => {
      const f = await fixture('t3');
      const snapshot = snap({ salesDays: [{ ...salesDay('2026-10-21', 200), otherPaymentSales: 200 }] });
      const none: KeyRow = { section: 'money', v1Store: L, v1Key: 'other', v1Label: 'other', v2Key: 'none', ticked: true };
      const a = await run(f, { snapshot, keysText: serialiseKeysCsv(keyRows(f, [none])), apply: false });
      const la = linesOfKind(a, f.storeA.code, 'sales_tender').find((l: Any) => l.v1 === 20000);
      expect(la, JSON.stringify(a.weeks)).toBeDefined();
      expect(la.delta).toBe(-20000);
      expect(la.class).toBe('NOT_DOUBLE_ENTERED');
      const unticked: KeyRow = { ...none, v2Key: '', ticked: false };
      const b = await run(f, { snapshot, keysText: serialiseKeysCsv(keyRows(f, [unticked])), apply: false });
      const lb = linesOfKind(b, f.storeA.code, 'sales_tender').find((l: Any) => l.v1 === 20000);
      expect(lb).toMatchObject({ class: 'UNMAPPED_KEY' });
    },
    60_000,
  );

  it(
    'T4 (k): a keys sheet row for cash__staff is REFUSED (staff cash is a stated mapping, no sheet row). Mutant: row accepted and silently used. Red if accepted',
    async () => {
      const f = await fixture('t4');
      const staffRow: KeyRow = { section: 'money', v1Store: L, v1Key: 'cash__staff', v1Label: 'cash staff', v2Key: '1120', ticked: true };
      await expect(run(f, { keysText: serialiseKeysCsv(keyRows(f, [staffRow])), apply: false })).rejects.toThrow(/cash__staff|staff/i);
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
    },
    60_000,
  );
});

describe('U. S4 audit round: channel keys, staff cash parties, credit provenance', () => {
  const channelRow = (f: Fx, v2Key: string): KeyRow => ({ section: 'money', v1Store: L, v1Key: 'other', v1Label: 'other', v2Key, ticked: true });
  const tenders = (out: Any, f: Fx): Any[] => linesOfKind(out, f.storeA.code, 'sales_tender');

  it(
    'U1 (audit 1): v2 sales-day debits to 1220 (the code that takes a channel party; 1221/1222 take none) for two channels give one sales_tender line PER channel, keyed channel:<id>, never one `1220` line. Red while the key is the GL code',
    async () => {
      const f = await fixture('u1');
      const ch1 = randomUUID();
      const ch2 = randomUUID();
      await postRaw(f, '2026-10-21', 'sale', [
        { accountCode: '1220', storeId: f.storeA.id, partyType: 'channel', partyId: ch1, debit: '100.00' },
        { accountCode: '1220', storeId: f.storeA.id, partyType: 'channel', partyId: ch2, debit: '50.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '150.00' },
      ]);
      const out = await run(f, { snapshot: snap(), apply: false });
      const t = tenders(out, f);
      const keys = t.map((l: Any) => l.key).sort();
      expect(keys, JSON.stringify(t)).toEqual([`channel:${ch1}`, `channel:${ch2}`].sort());
      expect(t.find((l: Any) => l.key === `channel:${ch1}`)).toMatchObject({ v2: 10000 });
      expect(t.find((l: Any) => l.key === `channel:${ch2}`)).toMatchObject({ v2: 5000 });
    },
    60_000,
  );

  it(
    'U2 (audit 1): an `other` sheet row with v2_key channel:<id> pairs v1 other 100 with the v2 1220 debit of that channel: ONE line keyed channel:<id>, delta 0. Red while 1220 is keyed by GL code',
    async () => {
      const f = await fixture('u2');
      const ch = randomUUID();
      await postRaw(f, '2026-10-21', 'sale', [
        { accountCode: '1220', storeId: f.storeA.id, partyType: 'channel', partyId: ch, debit: '100.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '100.00' },
      ]);
      const out = await run(f, {
        snapshot: snap({ salesDays: [v1SalesDay(L, '2026-10-21', 100, { otherPaymentSales: 100 })] }),
        keysText: serialiseKeysCsv(keyRows(f, [channelRow(f, `channel:${ch}`)])), apply: false,
      });
      const t = tenders(out, f).filter((l: Any) => l.v1 === 10000 || l.v2 === 10000);
      expect(t, JSON.stringify(tenders(out, f))).toHaveLength(1);
      expect(t[0]).toMatchObject({ key: `channel:${ch}`, v1: 10000, v2: 10000, delta: 0 });
    },
    60_000,
  );

  const staffMoney = async (f: Fx, gl: string) => {
    const have = await sql<Any[]>`select 1 from money_accounts where org_id = ${f.orgId} and store_id = ${f.storeA.id} and custodian = 'staff' and gl_account_code = ${gl}`;
    if (have.length === 0) {
      await sql`insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
                values (${f.orgId}, ${f.storeA.id}, ${`Staff cash ${gl}`}, 'cash', ${gl}, 'staff')`;
    }
  };

  it(
    'U3 (audit 5): a party-less line on a staff-custodian code (1130 here, which takes no party, as 1120 requires one) is not keyed cash__staff and is not summed into it; its own key keeps the amount. Red while a null party falls back to cash__staff',
    async () => {
      const f = await fixture('u3');
      await staffMoney(f, '1130');
      await postRaw(f, '2026-10-22', 'money_transfer', [
        { accountCode: '1130', storeId: f.storeA.id, debit: '300.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '300.00' },
      ]);
      const out = await run(f, { snapshot: snap(), apply: false });
      const staff = linesOfKind(out, f.storeA.code, 'staff_cash');
      expect(staff.find((l: Any) => l.key === 'cash__staff')?.v2 ?? 0, JSON.stringify(staff)).toBe(0);
      const orphan = staff.find((l: Any) => l.v2 === 30000);
      expect(orphan, JSON.stringify(staff)).toBeDefined();
      expect(orphan.key).toMatch(/^1130/);
    },
    60_000,
  );

  it(
    'U4 (audit 5): a NON-employee party on the staff-custodian code is keyed 1120:<party id> and stays out of cash__staff',
    async () => {
      const f = await fixture('u4');
      await staffMoney(f, '1120');
      await postRaw(f, '2026-10-22', 'money_transfer', [
        { accountCode: '1120', storeId: f.storeA.id, partyType: 'supplier', partyId: f.supId, debit: '70.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '70.00' },
      ]);
      const out = await run(f, { snapshot: snap(), apply: false });
      const staff = linesOfKind(out, f.storeA.code, 'staff_cash');
      expect(staff.map((l: Any) => l.key), JSON.stringify(staff)).toEqual([`1120:${f.supId}`]);
      expect(staff[0]).toMatchObject({ v2: 7000 });
    },
    60_000,
  );

  const creditOf = (out: Any, f: Fx): Any[] => tenders(out, f).filter((l: Any) => l.key === 'credit' || l.key.includes('1210'));
  const v1Credit = (): Any => snap({ salesDays: [v1SalesDay(L, '2026-10-21', 300, { creditSales: 300 })] });

  it(
    'U5 (audit 7 i): a REVERSED ar_charge: the original 1210 debit counts (v2 credit 300), the reversal credit does not (not 0, not 600)',
    async () => {
      const f = await fixture('u5');
      const e = await postRaw(f, '2026-10-21', 'ar_charge', [
        { accountCode: '1210', storeId: f.storeA.id, partyType: 'customer', partyId: randomUUID(), debit: '300.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '300.00' },
      ]);
      await withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId: (e as Any).entryId, reason: 'void', reversalDate: '2026-10-22' }));
      const out = await run(f, { snapshot: v1Credit(), apply: false });
      const c = creditOf(out, f);
      expect(c, JSON.stringify(c)).toHaveLength(1);
      expect(c[0]).toMatchObject({ key: 'credit', v1: 30000, v2: 30000 });
    },
    60_000,
  );

  it(
    'U6 (audit 7 ii): a 1210 debit whose root is NOT an ar_charge (an adjustment) is not credit: v2 credit stays 0',
    async () => {
      const f = await fixture('u6');
      await postRaw(f, '2026-10-21', 'adjustment', [
        { accountCode: '1210', storeId: f.storeA.id, partyType: 'customer', partyId: randomUUID(), debit: '300.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '300.00' },
      ]);
      const out = await run(f, { snapshot: v1Credit(), apply: false });
      const c = creditOf(out, f);
      expect(c.every((l: Any) => l.v2 === 0), JSON.stringify(c)).toBe(true);
    },
    60_000,
  );

  it(
    'U7 (audit 7 iii): a sale-source entry that touches 1210 yields no sales_tender line keyed 1210 and no v2 credit',
    async () => {
      const f = await fixture('u7');
      await postRaw(f, '2026-10-21', 'sale', [
        { accountCode: '1210', storeId: f.storeA.id, partyType: 'customer', partyId: randomUUID(), debit: '300.00' },
        { accountCode: '4100', storeId: f.storeA.id, credit: '300.00' },
      ]);
      const out = await run(f, { snapshot: v1Credit(), apply: false });
      const c = creditOf(out, f);
      expect(c.some((l: Any) => l.key.includes('1210')), JSON.stringify(c)).toBe(false);
      expect(c.every((l: Any) => l.v2 === 0), JSON.stringify(c)).toBe(true);
    },
    60_000,
  );
});

describe('W. SUB_CENTAVO warnings are surfaced (audit ruling d)', () => {
  it(
    'W1: a v1 amount with a sub-centavo part gives a SUB_CENTAVO warning on the week (code, docId, value), and the apply\'s audit row carries it. Mutant: warnings dropped after computeV1Figures. Red if not surfaced',
    async () => {
      const f = await fixture('w1');
      await postApInvoice(f, '2026-10-21', '500.00');
      const leg = apLeg(500.004);
      const out = await run(f, { snapshot: snap({ journal: [leg] }) });
      const w = weekOf(out, f.storeA.code);
      expect(w.warnings).toEqual([{ code: 'SUB_CENTAVO', docId: leg.id, value: 500.004 }]);
      const [row] = await sql<Any[]>`select after from audit_log where org_id = ${f.orgId} and action = 'dual_run.compare'`;
      const text = JSON.stringify(row!.after);
      expect(text).toContain('SUB_CENTAVO');
      expect(text).toContain(leg.id);
    },
    60_000,
  );
});

describe('X. the compare command: exit codes and the snapshot file (audit ruling e, g)', () => {
  function files(snapshot: Any, keysText: string) {
    const dir = mkdtempSync(join(tmpdir(), 't392-s4-cli-'));
    const snapPath = join(dir, 'v1-dual-run-2026-10-19-2026-10-25.json');
    const text = JSON.stringify(snapshot);
    writeFileSync(snapPath, text, { mode: 0o600 });
    chmodSync(snapPath, 0o600);
    writeFileSync(join(dir, 'v1-dual-run-2026-10-19-2026-10-25.sha256'), `${sha256(text)}  v1-dual-run-2026-10-19-2026-10-25.json\n`);
    const keysPath = join(dir, 'dual-run-keys.csv');
    writeFileSync(keysPath, keysText);
    return { dir, snapPath, keysPath };
  }
  const cli = (f: Fx, x: ReturnType<typeof files>, extra: string[], actor = f.admin.personId) => {
    const r = spawnSync(
      'npx',
      ['tsx', 'scripts/dual-run.ts', 'compare', '--snapshot', x.snapPath, '--keys', x.keysPath, '--org', f.orgId, '--actor', actor, ...extra],
      { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', shell: true, timeout: 150_000 },
    );
    return { status: r.status, all: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  };
  /** A week that ties (store A, one traded day, equal cash) and a no_data store B: no week is open. */
  async function tying(f: Fx) {
    await verifiedSalesDay(f, '2026-10-20');
    await postCashSale(f, '2026-10-20', '1000.00');
    return files(snap({ journal: [cashSaleLeg(1000, '2026-10-20')], salesDays: [salesDay('2026-10-20', 1000)] }), serialiseKeysCsv(keyRows(f, [cashKey])));
  }

  it(
    'X1: a dry run exits 0 for tying/no_data weeks, writes nothing, and leaves the snapshot in place. Mutant: dry run deletes',
    async () => {
      const f = await fixture('x1');
      const x = await tying(f);
      const r = cli(f, x, []);
      expect(r.status, r.all).toBe(0);
      expect(existsSync(x.snapPath)).toBe(true);
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
    },
    200_000,
  );

  it(
    'X2: --apply exits 0, commits, and THEN deletes the snapshot (the .sha256 stays). Mutant: delete before commit',
    async () => {
      const f = await fixture('x2');
      const x = await tying(f);
      const r = cli(f, x, ['--apply']);
      expect(r.status, r.all).toBe(0);
      expect(existsSync(x.snapPath)).toBe(false);
      expect(existsSync(x.snapPath.replace(/\.json$/, '.sha256'))).toBe(true);
      expect((await counts(f)).reports).toBe(2);
    },
    200_000,
  );

  it(
    'X3: an open week exits 2 (not a failure) and --apply still commits and deletes. Mutant: exit 1 on open',
    async () => {
      const f = await fixture('x3');
      const x = files(snap({ journal: [apLeg(500)] }), serialiseKeysCsv(keyRows(f)));
      const r = cli(f, x, ['--apply']);
      expect(r.status, r.all).toBe(2);
      expect(existsSync(x.snapPath)).toBe(false);
      expect((await counts(f)).reports).toBe(2);
    },
    200_000,
  );

  it(
    'X4: a failure (a staff actor refused) exits 1, writes nothing and does NOT delete the snapshot; so does a tampered snapshot (sha). Mutant: delete in finally',
    async () => {
      const f = await fixture('x4');
      const x = await tying(f);
      const refused = cli(f, x, ['--apply'], f.staff.personId);
      expect(refused.status, refused.all).toBe(1);
      expect(existsSync(x.snapPath)).toBe(true);
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
      writeFileSync(x.snapPath, `${JSON.stringify(snap())} `, { mode: 0o600 });
      const bad = cli(f, x, ['--apply']);
      expect(bad.status, bad.all).toBe(1);
      expect(existsSync(x.snapPath)).toBe(true);
    },
    200_000,
  );

  it.skipIf(process.platform === 'win32')(
    'X5: a failed unlink AFTER the commit does not exit 1 (the books are written) and says to delete the snapshot by hand. Mutant: exit 1 / silent. POSIX only (read-only directory)',
    async () => {
      const f = await fixture('x5');
      const x = await tying(f);
      chmodSync(x.dir, 0o500);
      try {
        const r = cli(f, x, ['--apply']);
        expect(r.status, r.all).not.toBe(1);
        expect(r.all).toMatch(/delete it by hand/i);
        expect((await counts(f)).reports).toBe(2);
      } finally {
        chmodSync(x.dir, 0o700);
      }
    },
    200_000,
  );

  it(
    'X6 (g): `--stores` with no value (the next token is a flag) is a usage error: exit 1, "usage", nothing written, the snapshot kept. Mutant: --apply swallowed as the stores list',
    async () => {
      const f = await fixture('x6');
      const x = await tying(f);
      const r = cli(f, x, ['--stores', '--apply']);
      expect(r.status, r.all).toBe(1);
      expect(r.all).toMatch(/usage/i);
      expect(existsSync(x.snapPath)).toBe(true);
      expect(await counts(f)).toEqual({ reports: 0, lines: 0, audit: 0 });
    },
    200_000,
  );

  it(
    'X7 (audit 4): the CLI prints each week\'s SUB_CENTAVO warning on a dry run AND on --apply. Red while warnings are only returned, never printed',
    async () => {
      const f = await fixture('x7');
      await postApInvoice(f, '2026-10-21', '500.00');
      const mk = () => files(snap({ journal: [apLeg(500.004)] }), serialiseKeysCsv(keyRows(f)));
      const dry = cli(f, mk(), []);
      expect(dry.all, dry.all).toMatch(/SUB_CENTAVO/);
      const applied = cli(f, mk(), ['--apply']);
      expect(applied.all, applied.all).toMatch(/SUB_CENTAVO/);
    },
    300_000,
  );
});
