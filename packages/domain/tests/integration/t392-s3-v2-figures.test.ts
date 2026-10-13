import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-392 S3 - `docs/tasks/392-dual-run-comparator.md`, invariants 21-25 (+ R5, R5a, R6, R10, section 3). TESTER file.
 * Real Postgres. Migration 0195 adds dual_run_reports, dual_run_lines, dual_run_dispositions (RLS ENABLE + FORCE, app
 * role SELECT + INSERT only), the repo `dualRunRepo`, and the v2 figures query. Every test names its killing mutant and
 * why it is red on HEAD (no table / no module / no CHECK).
 *
 * Trap: postgres.js reports a statement's FIRST error, so every refusal asserts the SPECIFIC constraint name.
 *
 * ---- PINNED CONTRACT (the spec does not name these; the builder follows them or says why not) ----
 * Tables (snake_case columns, money numeric(14,2), never float):
 *   dual_run_reports(id, org_id, store_id, week_start date, through date, v1_fingerprint text, v2_fingerprint text,
 *     keys_sha text, v1_snapshot_sha text, v1_extracted_at timestamptz, verdict text, compared_days int,
 *     created_by uuid, created_at)
 *   dual_run_lines(id, report_id, kind, line_key, label, v1_amount, v2_amount, delta, class, paired bool,
 *     auto_reason text null, per_day jsonb, v1_counter numeric null, opening_gap numeric null)
 *   dual_run_dispositions(id, org_id, store_id, week_start date, kind, line_key, delta_at numeric, class, ref, note,
 *     created_by, created_at)
 * Constraint names: dual_run_reports_week_monday_check, dual_run_reports_through_in_week_check,
 *   dual_run_reports_no_data_days_check (verdict 'no_data' => compared_days = 0), dual_run_reports_verdict_check,
 *   dual_run_reports_identity_unique (org_id, store_id, week_start, through, v1_fingerprint, keys_sha, v2_fingerprint),
 *   dual_run_lines_delta_check (delta = v2_amount - v1_amount), dual_run_lines_class_check (class in CLASS_CATALOGUE),
 *   dual_run_lines_key_unique (report_id, kind, line_key), dual_run_dispositions_class_check (V1_DEFECT|V2_DEFECT),
 *   dual_run_dispositions_ref_check (ref ~ '^DEF-[0-9]+$').
 * Repo, exported from @shareat/db as `dualRunRepo` (every function takes `tx` first, runs under the caller's principal):
 *   insertReport(tx, { orgId, storeId, weekStart, through, v1Fingerprint, v2Fingerprint, keysSha, v1SnapshotSha,
 *     v1ExtractedAt: Date, verdict, comparedDays, createdBy }): Promise<{ id }>
 *   insertLines(tx, reportId, lines: { kind, lineKey, label, v1Amount, v2Amount, delta, class, paired, autoReason,
 *     perDay: { date, v1, v2, delta, state }[], v1Counter: Money | null, openingGap: Money | null }[]): Promise<void>
 *   insertDisposition(tx, { orgId, storeId, weekStart, kind, lineKey, deltaAt, class, ref, note, createdBy }): Promise<{ id }>
 *   linesOf(tx, reportId): Promise<row[]>  (camelCase, money as 2dp strings, perDay parsed)
 *   v2Figures(tx, orgId, { storeId, weekStart, through }): Promise<{ lines: V2Line[]; datedLater: { entryId }[] }>
 *     V2Line = { kind: 'cash_bank'|'staff_cash'|'sales_tender'|'expense_category'|'ap_supplier'|'unassigned_store',
 *       storeId: string | null, glCode: string, partyType: string | null, partyId: string | null, categoryId?: string,
 *       debit, credit, amount (= debit - credit, 2dp strings), byDay: { date, amount }[] }
 *     It returns lines of ONE store plus the org's `unassigned_store` lines (storeId null); week = weekStart..through.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import * as db from '@shareat/db';
import { closeDb, transaction, withOrgPrincipal, APP_ROLE, type Tx } from '@shareat/db';
import { CUTOVER_CLASSIFICATION } from '../../../db/src/cutover/classification';
import { RLS_REGISTRY } from '../../../db/src/rls/registry';
import { CLASS_CATALOGUE } from '../../../etl/src/dual-run/classes';
import { toBusinessDate } from '@shareat/core/datetime';
import { postEntry, reverseEntry } from '@shareat/domain';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

const TABLES = ['dual_run_reports', 'dual_run_lines', 'dual_run_dispositions'] as const;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** Resolved at call time so a missing export is a red TypeError in THIS test only. */
interface V2Line {
  kind: string;
  storeId: string | null;
  glCode: string;
  partyType: string | null;
  partyId: string | null;
  categoryId?: string;
  debit: string;
  credit: string;
  amount: string;
  byDay: { date: string; amount: string }[];
}
interface V2Result {
  lines: V2Line[];
  datedLater: { entryId: string }[];
}
type Repo = {
  insertReport(tx: Tx, i: Record<string, unknown>): Promise<{ id: string }>;
  insertLines(tx: Tx, reportId: string, lines: Record<string, unknown>[]): Promise<void>;
  insertDisposition(tx: Tx, i: Record<string, unknown>): Promise<{ id: string }>;
  linesOf(tx: Tx, reportId: string): Promise<Record<string, unknown>[]>;
  v2Figures(tx: Tx, orgId: string, i: { storeId: string; weekStart: string; through: string }): Promise<V2Result>;
};
const repo = (): Repo => (db as unknown as { dualRunRepo: Repo }).dualRunRepo;

function constraintOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { constraint_name?: string }).constraint_name ?? (e as { constraint?: string }).constraint;
    if (c) return c;
  }
  return undefined;
}
function codeOf(err: unknown): string | undefined {
  for (let e: unknown = err, i = 0; e && i < 6; i++, e = (e as { cause?: unknown }).cause) {
    const c = (e as { code?: string }).code;
    if (c) return c;
  }
  return undefined;
}
async function failure(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}

async function fixture(hint: string) {
  const code = uid(`t392s3-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-10-01', '2026-10-31', 'open')`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-11-01', '2026-11-30', 'open')`;
  const mkStore = async (n: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(n)}, ${`Store ${n}`}) returning id`)[0]!.id;
  const storeA = await mkStore('a');
  const storeB = await mkStore('b');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Tester') returning id`;
  return { orgId, storeA, storeB, personId: p!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const W19 = { weekStart: '2026-10-19', through: '2026-10-25' };
const W26 = { weekStart: '2026-10-26', through: '2026-11-01' };

interface LineIn {
  accountCode: string;
  storeId?: string | null;
  partyType?: string;
  partyId?: string;
  debit?: string;
  credit?: string;
}
const post = (f: Fixture, i: { date: string; sourceType: string; sourceId: string; key?: string; lines: LineIn[] }) =>
  withOrgPrincipal(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: i.date,
      sourceType: i.sourceType,
      sourceId: i.sourceId,
      idempotencyKey: i.key ?? uid('k'),
      lines: i.lines,
    }),
  );

/** A balanced sale: cash on 1110 (and optionally one wallet on 1140 keyed by its money_account party). */
function saleLines(storeId: string | null, cash: string, wallet?: { id: string; amount: string }): LineIn[] {
  const lines: LineIn[] = [{ accountCode: '1110', storeId, debit: cash }];
  let total = Number(cash);
  if (wallet) {
    lines.push({ accountCode: '1140', storeId, partyType: 'money_account', partyId: wallet.id, debit: wallet.amount });
    total += Number(wallet.amount);
  }
  lines.push({ accountCode: '4100', storeId, credit: total.toFixed(2) });
  return lines;
}

async function moneyAccount(f: Fixture, storeId: string, name: string, instrument: string, gl: string, custodian: string) {
  const [r] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${f.orgId}, ${storeId}, ${name}, ${instrument}, ${gl}, ${custodian}) returning id`;
  return r!.id;
}

/** A DRAFT entry by raw SQL (postEntry only posts). Balanced, as the deferred trigger demands. */
async function rawDraft(f: Fixture, date: string, sourceType: string, sourceId: string, storeId: string, amount: string) {
  return sql.begin(async (t) => {
    const [pe] = await t<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and ${date}::date between starts_on and ends_on`;
    const [e] = await t<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${date}, ${pe!.id}, ${sourceType}, ${sourceId}, 'draft') returning id`;
    const acct = async (code: string) => (await t<{ id: string }[]>`select id from accounts where org_id = ${f.orgId} and code = ${code}`)[0]!.id;
    await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 1, ${await acct('1110')}, ${storeId}, ${amount}, 0)`;
    await t`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit) values (${e!.id}, 2, ${await acct('4100')}, ${storeId}, 0, ${amount})`;
    return e!.id;
  });
}

/** A verified POS-linked sales day with two feeds, raw (the workflow is not under test). */
async function realDay(f: Fixture, storeId: string, date: string) {
  const [d] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, status, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${f.orgId}, ${storeId}, ${date}, 'verified', '1000.00', '1000.00', '0.00', ${f.personId}) returning id`;
  const feed = async (n: number) =>
    (await sql<{ id: string }[]>`
      insert into pos_v1_day_feeds (org_id, store_id, business_date, kind, purpose, batch_id, pos_store_id, body, payload, content_hash, fetched_at, fetched_by)
      values (${f.orgId}, ${storeId}, ${date}, 'sales', 'recheck', ${crypto.randomUUID()}, 'pos-x', '{"found":true}', '{"found":true}'::jsonb,
        ${String(n).repeat(64)}, now(), ${f.personId}) returning id`)[0]!.id;
  return { dayId: d!.id, storeId, date, fromFeed: await feed(1), toFeed: await feed(2) };
}
/** A postPosCorrection-shaped correction: entry (source sale, source_id = correction id) + the corrections row. */
async function correction(f: Fixture, day: Awaited<ReturnType<typeof realDay>>, entryDate: string, amount: string) {
  const correctionId = crypto.randomUUID();
  const e = await post(f, {
    date: entryDate, sourceType: 'sale', sourceId: correctionId,
    lines: [{ accountCode: '4100', storeId: day.storeId, debit: amount }, { accountCode: '1110', storeId: day.storeId, credit: amount }],
  });
  await sql`
    insert into sales_day_pos_corrections (id, org_id, store_id, sales_day_id, from_feed_id, to_feed_id, entry_date, journal_entry_id, reason, posted_by)
    values (${correctionId}, ${f.orgId}, ${day.storeId}, ${day.dayId}, ${day.fromFeed}, ${day.toFeed}, ${entryDate}, ${e.entryId}, 'POS changed', ${f.personId})`;
  return { correctionId, entryId: e.entryId };
}
/** S3 money ruling b: the inventory_basis GL codes (2120 GRNI is deliberately NOT here). */
const INV_CODES = ['1310', '1320', '1330', '1340', '5100', '5110', '5120', '5130', '5140', '5150', '5160', '5170', '5175', '5200', '5300', '5400', '5450'];
/** n seeded NON-COGS categories with DISTINCT non-null account codes outside the inventory list. */
async function categories(f: Fixture, n: number) {
  return sql<{ id: string; account_code: string }[]>`
    select id, account_code from expense_categories
    where org_id = ${f.orgId} and account_code is not null and "group" <> 'COGS'
      and not (account_code = any(${sql.array(INV_CODES)}))
      and account_code in (select account_code from expense_categories where org_id = ${f.orgId} and account_code is not null group by 1 having count(*) = 1)
    order by account_code limit ${n}`;
}
/** A POSTED expenses row (supplier invoice around it, verified by a different person as the CHECK demands). */
async function expenseRow(f: Fixture, categoryId: string, date: string, amount: string): Promise<string> {
  const [other] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Verifier') returning id`;
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${f.orgId}, ${uid('sup')}, ${f.personId}) returning id`;
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, status, verified_by, verified_at,
      attested_supplier, attested_invoice, attested_items, attested_price, created_by)
    values (${f.orgId}, ${f.storeA}, ${sup!.id}, ${date}, ${amount}, 'verified', ${other!.id}, now(), true, true, true, true, ${f.personId}) returning id`;
  const [x] = await sql<{ id: string }[]>`
    insert into expenses (org_id, store_id, business_date, total_amount, category_id, supplier_id, supplier_invoice_id, particulars, status, created_by)
    values (${f.orgId}, ${f.storeA}, ${date}, ${amount}, ${categoryId}, ${sup!.id}, ${inv!.id}, 'fixture', 'posted', ${f.personId}) returning id`;
  return x!.id;
}

const figures = (f: Fixture, storeId: string, w: { weekStart: string; through: string }, asOrgId = f.orgId) =>
  asOrg(asOrgId, (tx) => repo().v2Figures(tx, f.orgId, { storeId, ...w }));
const lineOf = (r: V2Result, kind: string, glCode: string, partyId: string | null = null) =>
  r.lines.find((l) => l.kind === kind && l.glCode === glCode && l.partyId === partyId);
const amt = (r: V2Result, kind: string, glCode: string, partyId: string | null = null) =>
  lineOf(r, kind, glCode, partyId)?.amount ?? '0.00';

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ======================================================================================================
describe('21-24 - v2 figures (posted ledger only, R5 / R5a)', () => {
  it(
    'F1: a DRAFT entry contributes nothing; a posted one does; amounts are 2dp strings, never numbers. Mutant: figures from documents / status filter dropped. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f1');
      await rawDraft(f, '2026-10-21', 'sale', uid('d'), f.storeA, '500.00');
      await post(f, { date: '2026-10-20', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(f.storeA, '1000.00') });
      const r = await figures(f, f.storeA, W19);
      expect(amt(r, 'sales_tender', '1110')).toBe('1000.00');
      expect(amt(r, 'cash_bank', '1110')).toBe('1000.00');
      expect(typeof lineOf(r, 'cash_bank', '1110')!.amount).toBe('string');
    },
    30_000,
  );

  it(
    'F2: a reversed entry and its reversal net to 0 on sales_tender (placed on the original date), and on cash_bank each keeps its own date. Mutant: entry date used for sales_tender. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f2');
      const sid = uid('s');
      const e = await post(f, { date: '2026-10-24', sourceType: 'sale', sourceId: sid, lines: saleLines(f.storeA, '1000.00') });
      await withOrgPrincipal(f.orgId, (tx) =>
        reverseEntry(tx, { entryId: e.entryId, reason: 'void day', reversalDate: '2026-10-28' }),
      );
      const w19 = await figures(f, f.storeA, W19);
      const w26 = await figures(f, f.storeA, W26);
      expect(amt(w19, 'sales_tender', '1110')).toBe('0.00');
      expect(amt(w26, 'sales_tender', '1110')).toBe('0.00');
      expect(amt(w19, 'cash_bank', '1110')).toBe('1000.00');
      expect(amt(w26, 'cash_bank', '1110')).toBe('-1000.00');
    },
    30_000,
  );

  it(
    'F3a (ruling 1b): a REAL verified POS day (24 Oct) and its postPosCorrection-shaped entry (source sale, source_id = sales_day_pos_corrections.id) posted 28 Oct: sales_tender lands on 24 Oct, cash_bank on 28 Oct. Mutant: entry date used. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f3a');
      const day = await realDay(f, f.storeA, '2026-10-24');
      await post(f, { date: '2026-10-24', sourceType: 'sale', sourceId: day.dayId, lines: saleLines(f.storeA, '1000.00') });
      await correction(f, day, '2026-10-28', '50.00');
      const w19 = await figures(f, f.storeA, W19);
      const w26 = await figures(f, f.storeA, W26);
      expect(lineOf(w19, 'sales_tender', '1110')!.byDay).toEqual([{ date: '2026-10-24', amount: '950.00' }]);
      expect(amt(w26, 'sales_tender', '1110')).toBe('0.00');
      expect(amt(w19, 'cash_bank', '1110')).toBe('1000.00');
      expect(amt(w26, 'cash_bank', '1110')).toBe('-50.00');
    },
    30_000,
  );

  it(
    'F3b (ruling 1a): the REVERSAL of that correction (reversal_of_entry_id, posted 3 Nov) also lands on the corrected day 24 Oct for sales_tender; cash_bank keeps 3 Nov. Mutant: reversal on its own date. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f3b');
      const day = await realDay(f, f.storeA, '2026-10-24');
      await post(f, { date: '2026-10-24', sourceType: 'sale', sourceId: day.dayId, lines: saleLines(f.storeA, '1000.00') });
      const c = await correction(f, day, '2026-10-28', '50.00');
      await withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId: c.entryId, reason: 'undo', reversalDate: '2026-11-03' }));
      const w19 = await figures(f, f.storeA, W19);
      const w2 = await figures(f, f.storeA, { weekStart: '2026-11-02', through: '2026-11-08' });
      expect(lineOf(w19, 'sales_tender', '1110')!.byDay).toEqual([{ date: '2026-10-24', amount: '1000.00' }]);
      expect(amt(w2, 'sales_tender', '1110')).toBe('0.00');
      expect(amt(w2, 'cash_bank', '1110')).toBe('50.00');
    },
    30_000,
  );

  it(
    'F3c (ruling 1c): a later entry with the same source as an earlier POSTED entry takes the earliest one\'s date. Mutant: entry date used. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f3c');
      const sid = uid('day');
      await post(f, { date: '2026-10-24', sourceType: 'sale', sourceId: sid, lines: saleLines(f.storeA, '1000.00') });
      await post(f, {
        date: '2026-10-28', sourceType: 'sale', sourceId: sid,
        lines: [{ accountCode: '4100', storeId: f.storeA, debit: '50.00' }, { accountCode: '1110', storeId: f.storeA, credit: '50.00' }],
      });
      expect(lineOf(await figures(f, f.storeA, W19), 'sales_tender', '1110')!.byDay).toEqual([{ date: '2026-10-24', amount: '950.00' }]);
      expect(amt(await figures(f, f.storeA, W26), 'cash_bank', '1110')).toBe('-50.00');
    },
    30_000,
  );

  it(
    'F3d (ruling 1): ap_supplier keeps the entry\'s OWN date even when the entry has an earlier same-source entry. Mutant: ap re-dated. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f3d');
      const sup = uid('sup');
      const sid = uid('inv');
      await post(f, {
        date: '2026-10-20', sourceType: 'supplier_invoice', sourceId: sid,
        lines: [{ accountCode: '1310', storeId: f.storeA, debit: '800.00' }, { accountCode: '2110', storeId: f.storeA, partyType: 'supplier', partyId: sup, credit: '800.00' }],
      });
      await post(f, {
        date: '2026-10-28', sourceType: 'supplier_invoice', sourceId: sid,
        lines: [{ accountCode: '2110', storeId: f.storeA, partyType: 'supplier', partyId: sup, debit: '100.00' }, { accountCode: '1310', storeId: f.storeA, credit: '100.00' }],
      });
      expect(lineOf(await figures(f, f.storeA, W19), 'ap_supplier', '2110', sup)).toMatchObject({ credit: '800.00', debit: '0.00' });
      expect(lineOf(await figures(f, f.storeA, W26), 'ap_supplier', '2110', sup)).toMatchObject({ credit: '0.00', debit: '100.00' });
    },
    30_000,
  );

  it(
    'F4a (ruling 5): a REAL expenses row; entries joined via source_type expense_payment / source_id = expenses.id; the line carries that category id, and a 29 Oct correction takes the expense date (22 Oct). Mutant: key by GL code / entry date. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f4a');
      const [ca] = await categories(f, 1);
      const eid = await expenseRow(f, ca!.id, '2026-10-22', '300.00');
      const code = ca!.account_code;
      await post(f, {
        date: '2026-10-22', sourceType: 'expense_payment', sourceId: eid,
        lines: [{ accountCode: code, storeId: f.storeA, debit: '300.00' }, { accountCode: '1110', storeId: f.storeA, credit: '300.00' }],
      });
      await post(f, {
        date: '2026-10-29', sourceType: 'expense_payment', sourceId: eid,
        lines: [{ accountCode: '1110', storeId: f.storeA, debit: '20.00' }, { accountCode: code, storeId: f.storeA, credit: '20.00' }],
      });
      const w19 = await figures(f, f.storeA, W19);
      const w26 = await figures(f, f.storeA, W26);
      expect(w19.lines.find((l) => l.kind === 'expense_category' && l.categoryId === ca!.id)?.amount).toBe('280.00');
      expect(w26.lines.find((l) => l.kind === 'expense_category' && l.categoryId === ca!.id)?.amount ?? '0.00').toBe('0.00');
      expect(amt(w26, 'cash_bank', '1110')).toBe('20.00');
    },
    30_000,
  );

  it(
    'F4b (ruling 5): two categories sharing ONE account_code stay TWO lines, each with its own categoryId. Mutant: grouped by GL code. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f4b');
      const [ca, cb] = await categories(f, 2);
      await sql`update expense_categories set account_code = ${ca!.account_code} where id = ${cb!.id}`;
      const code = ca!.account_code;
      for (const [c, a] of [[ca!, '100.00'], [cb!, '40.00']] as const) {
        const eid = await expenseRow(f, c.id, '2026-10-21', a);
        await post(f, {
          date: '2026-10-21', sourceType: 'expense_payment', sourceId: eid,
          lines: [{ accountCode: code, storeId: f.storeA, debit: a }, { accountCode: '1110', storeId: f.storeA, credit: a }],
        });
      }
      const ex = (await figures(f, f.storeA, W19)).lines.filter((l) => l.kind === 'expense_category');
      expect(ex.map((l) => `${l.categoryId}|${l.amount}`).sort()).toEqual([`${ca!.id}|100.00`, `${cb!.id}|40.00`].sort());
    },
    30_000,
  );

  it.each(['depreciation', 'adhoc', 'payroll_payout'])(
    'F4c (money ruling c): a posting on an expense-category code whose chain root is source_type %s (not expense_payment) is NOT emitted: not expense_category, not unassigned_store, for a store or a null store. Mutant: any 6xxx debit counted. Red today: dualRunRepo undefined',
    async (src) => {
      const f = await fixture('f4c');
      const [ca] = await categories(f, 1);
      for (const store of [f.storeA, null]) {
        await post(f, {
          date: '2026-10-21', sourceType: src, sourceId: uid('x'),
          lines: [{ accountCode: ca!.account_code, storeId: store, debit: '75.00' }, { accountCode: '1110', storeId: store, credit: '75.00' }],
        });
      }
      const r = await figures(f, f.storeA, W19);
      expect(r.lines.filter((l) => l.kind === 'expense_category')).toEqual([]);
      expect(r.lines.some((l) => l.kind === 'unassigned_store' && l.glCode === ca!.account_code)).toBe(false);
      expect(r.lines.some((l) => l.glCode === ca!.account_code)).toBe(false);
    },
    30_000,
  );

  it(
    'F4d (money ruling c): a REVERSAL whose chain root is expense_payment still counts (root, not own source). Mutant: only the entry own source tested. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f4d');
      const [ca] = await categories(f, 1);
      const eid = await expenseRow(f, ca!.id, '2026-10-22', '300.00');
      const e = await post(f, {
        date: '2026-10-22', sourceType: 'expense_payment', sourceId: eid,
        lines: [{ accountCode: ca!.account_code, storeId: f.storeA, debit: '300.00' }, { accountCode: '1110', storeId: f.storeA, credit: '300.00' }],
      });
      await withOrgPrincipal(f.orgId, (tx) => reverseEntry(tx, { entryId: e.entryId, reason: 'void', reversalDate: '2026-10-29' }));
      const w19 = await figures(f, f.storeA, W19);
      expect(w19.lines.find((l) => l.kind === 'expense_category' && l.categoryId === ca!.id)?.amount ?? '0.00').toBe('0.00');
      expect(w19.lines.filter((l) => l.kind === 'expense_category')).toHaveLength(1);
    },
    30_000,
  );

  it(
    'F15 (money ruling b): a COGS-group category spend (expense_payment on a COGS code) lands in inventory_basis, NOT expense_category. Mutant: COGS category in expense_category. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f15');
      const [cg] = await sql<{ id: string; account_code: string }[]>`
        select id, account_code from expense_categories where org_id = ${f.orgId} and "group" = 'COGS' and account_code is not null order by account_code limit 1`;
      const eid = await expenseRow(f, cg!.id, '2026-10-22', '120.00');
      await post(f, {
        date: '2026-10-22', sourceType: 'expense_payment', sourceId: eid,
        lines: [{ accountCode: cg!.account_code, storeId: f.storeA, debit: '120.00' }, { accountCode: '1110', storeId: f.storeA, credit: '120.00' }],
      });
      const r = await figures(f, f.storeA, W19);
      expect(amt(r, 'inventory_basis', cg!.account_code)).toBe('120.00');
      expect(r.lines.filter((l) => l.kind === 'expense_category')).toEqual([]);
    },
    30_000,
  );

  it(
    'G1 (money ruling b guard): every seeded COGS-group category code is in the inventory_basis list (INV_CODES mirrors the ruling; the builder uses the same list). Fails if the seed gains a COGS code the list lacks',
    async () => {
      const f = await fixture('g1');
      const rows = await sql<{ account_code: string | null }[]>`select distinct account_code from expense_categories where org_id = ${f.orgId} and "group" = 'COGS'`;
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(INV_CODES, `COGS code ${r.account_code}`).toContain(r.account_code);
    },
    30_000,
  );

  it(
    'F16 (money ruling a): sign per kind, pinned to v1-figures (cash_bank in-out, sales_tender positive, inventory spend positive, ap owed positive): the same facts give the v1-style positive number on v2, byDay follows amount. Mutant: credit - debit everywhere / debit - credit on 2110. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f16');
      const sup = uid('sup');
      await post(f, { date: '2026-10-20', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(f.storeA, '1000.00') });
      await post(f, {
        date: '2026-10-21', sourceType: 'supplier_invoice', sourceId: uid('i'),
        lines: [{ accountCode: '1310', storeId: f.storeA, debit: '500.00' }, { accountCode: '2110', storeId: f.storeA, partyType: 'supplier', partyId: sup, credit: '500.00' }],
      });
      const r = await figures(f, f.storeA, W19);
      expect(amt(r, 'cash_bank', '1110')).toBe('1000.00');
      expect(amt(r, 'sales_tender', '1110')).toBe('1000.00');
      expect(amt(r, 'inventory_basis', '1310')).toBe('500.00');
      expect(amt(r, 'ap_supplier', '2110', sup)).toBe('500.00');
      expect(lineOf(r, 'ap_supplier', '2110', sup)!.byDay).toEqual([{ date: '2026-10-21', amount: '500.00' }]);
      await post(f, {
        date: '2026-10-22', sourceType: 'ap_payment', sourceId: uid('p'),
        lines: [{ accountCode: '2110', storeId: f.storeA, partyType: 'supplier', partyId: sup, debit: '700.00' }, { accountCode: '1110', storeId: f.storeA, credit: '700.00' }],
      });
      const r2 = await figures(f, f.storeA, W19);
      expect(amt(r2, 'ap_supplier', '2110', sup)).toBe('-200.00');
      expect(lineOf(r2, 'ap_supplier', '2110', sup)).toMatchObject({ credit: '500.00', debit: '700.00' });
    },
    30_000,
  );

  it(
    'F14 (money ruling b): a receipt Dr 1310 / Cr 2120 is NOT netted away: 2120 is excluded from inventory_basis, so 1310 shows the 800 less usage and COGS 5100 its 200. Mutant: 2120 included (receipt nets to 0). Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f14');
      await post(f, {
        date: '2026-10-20', sourceType: 'delivery', sourceId: uid('d'),
        lines: [{ accountCode: '1310', storeId: f.storeA, debit: '800.00' }, { accountCode: '2120', storeId: f.storeA, credit: '800.00' }],
      });
      await post(f, {
        date: '2026-10-21', sourceType: 'stock_usage', sourceId: uid('u'),
        lines: [{ accountCode: '5100', storeId: f.storeA, debit: '200.00' }, { accountCode: '1310', storeId: f.storeA, credit: '200.00' }],
      });
      const r = await figures(f, f.storeA, W19);
      expect(amt(r, 'inventory_basis', '1310')).toBe('600.00');
      expect(amt(r, 'inventory_basis', '5100')).toBe('200.00');
      expect(r.lines.some((l) => l.glCode === '2120')).toBe(false);
    },
    30_000,
  );

  it(
    'F5b (money ruling d): a POSTED original with a later DRAFT sibling of the same source is NOT in datedLater (and the draft contributes nothing). Mutant: any later same-source entry listed. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f5b');
      const sid = uid('day');
      await post(f, { date: '2026-10-24', sourceType: 'sale', sourceId: sid, lines: saleLines(f.storeA, '1000.00') });
      await rawDraft(f, '2026-10-28', 'sale', sid, f.storeA, '50.00');
      for (const w of [W19, W26]) expect((await figures(f, f.storeA, w)).datedLater).toEqual([]);
      expect(amt(await figures(f, f.storeA, W26), 'cash_bank', '1110')).toBe('0.00');
    },
    30_000,
  );


  it(
    'F5 (R5a): a same-source entry whose original is only a DRAFT cannot be resolved: it stays on its own date and is listed in datedLater. (Pinned reading, see report.) Mutant: unresolved entry silently moved or dropped. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f5');
      const sid = uid('day');
      await rawDraft(f, '2026-10-24', 'sale', sid, f.storeA, '1000.00');
      const e = await post(f, {
        date: '2026-10-28', sourceType: 'sale', sourceId: sid,
        lines: [{ accountCode: '4100', storeId: f.storeA, debit: '50.00' }, { accountCode: '1110', storeId: f.storeA, credit: '50.00' }],
      });
      const w26 = await figures(f, f.storeA, W26);
      expect(amt(w26, 'sales_tender', '1110')).toBe('-50.00');
      expect(w26.datedLater.map((d) => d.entryId)).toContain(e.entryId);
    },
    30_000,
  );

  it(
    'F6: dating is Manila: a Sunday-night-UTC instant is Monday in Manila and lands in the NEXT week. Mutant: UTC-derived date. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f6');
      const instant = new Date('2026-10-25T17:30:00Z'); // Sunday 17:30 UTC = Monday 01:30 Manila
      const manila = toBusinessDate(instant);
      expect(manila).toBe('2026-10-26');
      expect(instant.toISOString().slice(0, 10)).toBe('2026-10-25');
      await post(f, { date: manila, sourceType: 'sale', sourceId: uid('s'), lines: saleLines(f.storeA, '700.00') });
      expect(amt(await figures(f, f.storeA, W19), 'cash_bank', '1110')).toBe('0.00');
      expect(amt(await figures(f, f.storeA, W26), 'cash_bank', '1110')).toBe('700.00');
    },
    30_000,
  );

  it(
    'F7 (inv 23): two money accounts on one GL code at one store sum on the cash key (gl, store). Mutant: keyed per money account. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f7');
      await moneyAccount(f, f.storeA, 'Till 1', 'cash', '1110', 'cashier');
      await moneyAccount(f, f.storeA, 'Till 2', 'cash', '1110', 'cashier');
      for (const [i, a] of ['400.00', '600.00'].entries()) {
        await post(f, {
          date: `2026-10-2${i}`, sourceType: 'money_transfer', sourceId: uid('t'),
          lines: [{ accountCode: '1110', storeId: f.storeA, debit: a }, { accountCode: '1130', storeId: f.storeA, credit: a }],
        });
      }
      const r = await figures(f, f.storeA, W19);
      expect(r.lines.filter((l) => l.kind === 'cash_bank' && l.glCode === '1110')).toHaveLength(1);
      expect(amt(r, 'cash_bank', '1110')).toBe('1000.00');
      expect(amt(r, 'cash_bank', '1130')).toBe('-1000.00');
    },
    30_000,
  );

  it(
    'F8 (inv 23): an online line is keyed by its money_account PARTY, never by GL 1140. Mutant: online keyed by GL code. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f8');
      const w1 = await moneyAccount(f, f.storeA, 'GCash 1', 'ewallet', '1140', 'cashier');
      const w2 = await moneyAccount(f, f.storeA, 'Maya 1', 'ewallet', '1140', 'cashier');
      await post(f, { date: '2026-10-20', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(f.storeA, '100.00', { id: w1, amount: '250.00' }) });
      await post(f, { date: '2026-10-21', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(f.storeA, '100.00', { id: w2, amount: '150.00' }) });
      const r = await figures(f, f.storeA, W19);
      const online = r.lines.filter((l) => l.kind === 'cash_bank' && l.glCode === '1140');
      expect(online).toHaveLength(2);
      expect(online.every((l) => l.partyType === 'money_account')).toBe(true);
      expect(amt(r, 'cash_bank', '1140', w1)).toBe('250.00');
      expect(amt(r, 'cash_bank', '1140', w2)).toBe('150.00');
      expect(amt(r, 'sales_tender', '1140', w1)).toBe('250.00');
    },
    30_000,
  );

  it(
    'F9 (inv 23): a staff-custodian line with an employee party lands on staff cash, summed per store. Mutant: staff cash folded into cash_bank 1110. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f9');
      // A store is born with its foundation money accounts (incl. the staff-custodian one on 1120), so none is inserted.
      const [sf] = await sql<{ gl_account_code: string }[]>`select gl_account_code from money_accounts where store_id = ${f.storeA} and custodian = 'staff'`;
      expect(sf?.gl_account_code).toBe('1120');
      for (const [emp, a] of [['emp-1', '300.00'], ['emp-2', '200.00']] as const) {
        await post(f, {
          date: '2026-10-22', sourceType: 'money_transfer', sourceId: uid('t'),
          lines: [
            { accountCode: '1120', storeId: f.storeA, partyType: 'employee', partyId: emp, debit: a },
            { accountCode: '1110', storeId: f.storeA, credit: a },
          ],
        });
      }
      const r = await figures(f, f.storeA, W19);
      const staff = r.lines.filter((l) => l.kind === 'staff_cash');
      expect(staff).toHaveLength(1);
      expect(staff[0]).toMatchObject({ storeId: f.storeA, glCode: '1120', amount: '500.00' });
      expect(amt(r, 'cash_bank', '1110')).toBe('-500.00');
    },
    30_000,
  );

  it(
    'F9b (ruling 2): a NON-employee party on the staff code still goes to staff_cash, under its real party. Mutant: dropped, or folded into 1110. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f9b');
      await post(f, {
        date: '2026-10-22', sourceType: 'money_transfer', sourceId: uid('t'),
        lines: [
          { accountCode: '1120', storeId: f.storeA, partyType: 'customer', partyId: 'cust-9', debit: '50.00' },
          { accountCode: '1110', storeId: f.storeA, credit: '50.00' },
        ],
      });
      const r = await figures(f, f.storeA, W19);
      const l = r.lines.find((x) => x.kind === 'staff_cash' && x.partyId === 'cust-9');
      expect(l).toMatchObject({ glCode: '1120', partyType: 'customer', amount: '50.00' });
      expect(amt(r, 'cash_bank', '1110')).toBe('-50.00');
    },
    30_000,
  );

  it(
    'F10 (R5, inv 23): a tie-set line with store_id null appears on unassigned_store, whichever store is asked, and never on a store cash line. Mutant: null-store line dropped. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f10');
      await post(f, { date: '2026-10-23', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(null, '70.00') });
      for (const s of [f.storeA, f.storeB]) {
        const r = await figures(f, s, W19);
        const u = r.lines.find((l) => l.kind === 'unassigned_store' && l.glCode === '1110');
        expect(u, 'unassigned_store line').toBeDefined();
        expect(u!.storeId).toBeNull();
        expect(u!.amount).toBe('70.00');
        expect(amt(r, 'cash_bank', '1110')).toBe('0.00');
      }
    },
    30_000,
  );

  it(
    'F11 (inv 24): another store never appears in this store\'s figures. Mutant: no store_id filter. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f11');
      await post(f, { date: '2026-10-20', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(f.storeA, '111.00') });
      await post(f, { date: '2026-10-20', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(f.storeB, '999.00') });
      const a = await figures(f, f.storeA, W19);
      expect(amt(a, 'cash_bank', '1110')).toBe('111.00');
      expect(a.lines.some((l) => l.storeId === f.storeB)).toBe(false);
    },
    30_000,
  );

  it(
    'F12 (inv 24): RLS - org B sees none of org A\'s ledger through the repo, even when asked for org A by id. Mutant: repo query without org_id. Red today: dualRunRepo undefined',
    async () => {
      const a = await fixture('f12a');
      const b = await fixture('f12b');
      await post(a, { date: '2026-10-20', sourceType: 'sale', sourceId: uid('s'), lines: saleLines(a.storeA, '555.00') });
      expect(amt(await figures(a, a.storeA, W19), 'cash_bank', '1110')).toBe('555.00');
      const asB = await asOrg(b.orgId, (tx) => repo().v2Figures(tx, a.orgId, { storeId: a.storeA, ...W19 }));
      expect(asB.lines).toEqual([]);
    },
    30_000,
  );

  it(
    'F13: ap_supplier carries supplier credits (incurred) and debits (paid) gross, party-keyed. Mutant: net only / party dropped. Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('f13');
      const sup = uid('sup');
      await post(f, {
        date: '2026-10-20', sourceType: 'supplier_invoice', sourceId: uid('i'),
        lines: [{ accountCode: '1310', storeId: f.storeA, debit: '800.00' }, { accountCode: '2110', storeId: f.storeA, partyType: 'supplier', partyId: sup, credit: '800.00' }],
      });
      await post(f, {
        date: '2026-10-22', sourceType: 'ap_payment', sourceId: uid('p'),
        lines: [{ accountCode: '2110', storeId: f.storeA, partyType: 'supplier', partyId: sup, debit: '300.00' }, { accountCode: '1110', storeId: f.storeA, credit: '300.00' }],
      });
      const l = lineOf(await figures(f, f.storeA, W19), 'ap_supplier', '2110', sup);
      expect(l).toMatchObject({ credit: '800.00', debit: '300.00', amount: '500.00', partyType: 'supplier' }); // owed positive (money ruling a)
    },
    30_000,
  );
});

// ======================================================================================================
describe('25 - storage: inserts through the repo, CHECKs name themselves', () => {
  const reportIn = (f: Fixture, over: Record<string, unknown> = {}) => ({
    orgId: f.orgId, storeId: f.storeA, weekStart: '2026-10-19', through: '2026-10-25',
    v1Fingerprint: uid('v1'), v2Fingerprint: uid('v2'), keysSha: 'k'.repeat(8), v1SnapshotSha: 's'.repeat(8),
    v1ExtractedAt: new Date('2026-10-26T01:00:00Z'), verdict: 'explained', comparedDays: 5, createdBy: f.personId, ...over,
  });
  const rawReport = (f: Fixture, o: Record<string, unknown> = {}) => {
    const r = { week_start: '2026-10-19', through: '2026-10-25', verdict: 'explained', compared_days: 5, v1: uid('v1'), v2: uid('v2'), ...o };
    return sql`
      insert into dual_run_reports (org_id, store_id, week_start, through, v1_fingerprint, v2_fingerprint, keys_sha,
        v1_snapshot_sha, v1_extracted_at, verdict, compared_days, created_by)
      values (${f.orgId}, ${f.storeA}, ${r.week_start as string}, ${r.through as string}, ${r.v1 as string}, ${r.v2 as string}, 'k', 's',
        now(), ${r.verdict as string}, ${r.compared_days as number}, ${f.personId}) returning id`;
  };
  const lineIn = (over: Record<string, unknown> = {}) => ({
    kind: 'sales_tender', lineKey: uid('lk'), label: 'Cash', v1Amount: '100.00', v2Amount: '150.00', delta: '50.00',
    class: 'UNEXPLAINED', paired: false, autoReason: null,
    perDay: [{ date: '2026-10-20', v1: '100.00', v2: '150.00', delta: '50.00', state: 'open' }],
    v1Counter: null, openingGap: null, ...over,
  });
  const rawLine = (reportId: string, o: Record<string, unknown> = {}) => {
    const l = { ...lineIn(), v1: '100.00', v2: '150.00', delta: '50.00', ...o } as unknown as Record<string, string>;
    return sql`
      insert into dual_run_lines (org_id, report_id, kind, line_key, label, v1_amount, v2_amount, delta, class, paired, per_day)
      values ((select org_id from dual_run_reports where id = ${reportId}), ${reportId}, ${l.kind!}, ${l.lineKey!}, 'x', ${l.v1!}, ${l.v2!}, ${l.delta!}, ${l.class!}, false, '[]'::jsonb)`;
  };
  const rawDisp = (f: Fixture, o: Record<string, unknown> = {}) => {
    const d = { class: 'V1_DEFECT', ref: 'DEF-634', store: f.storeA, org: f.orgId, kind: 'sales_tender', ...o } as unknown as Record<string, string | null>;
    return sql`
      insert into dual_run_dispositions (org_id, store_id, week_start, kind, line_key, delta_at, class, ref, note, created_by)
      values (${d.org!}, ${d.store!}, '2026-10-19', ${d.kind!}, 'cash', 50.00, ${d.class!}, ${d.ref ?? null}, 'n', ${f.personId})`;
  };

  it(
    'S1: report, lines and a disposition insert through the repo and read back as 2dp strings (numeric, not float). Red today: dualRunRepo undefined',
    async () => {
      const f = await fixture('s1');
      const out = await asOrg(f.orgId, async (tx) => {
        const rep = await repo().insertReport(tx, reportIn(f));
        await repo().insertLines(tx, rep.id, [lineIn({ lineKey: 'cash', v1Counter: '12.50', openingGap: '1000.10' })]);
        await repo().insertDisposition(tx, {
          orgId: f.orgId, storeId: f.storeA, weekStart: '2026-10-19', kind: 'sales_tender', lineKey: 'cash',
          deltaAt: '50.00', class: 'V2_DEFECT', ref: 'DEF-700', note: 'POS rounding', createdBy: f.personId,
        });
        return repo().linesOf(tx, rep.id);
      });
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ v1Amount: '100.00', v2Amount: '150.00', delta: '50.00', v1Counter: '12.50', openingGap: '1000.10', paired: false });
      expect(out[0]!.perDay).toEqual([{ date: '2026-10-20', v1: '100.00', v2: '150.00', delta: '50.00', state: 'open' }]);
    },
    30_000,
  );

  it(
    'S2: every money column is numeric(14,2), never float/real. Mutant: double precision. Red today: columns do not exist',
    async () => {
      const rows = await sql<{ table_name: string; column_name: string; data_type: string; numeric_precision: number; numeric_scale: number }[]>`
        select table_name, column_name, data_type, numeric_precision, numeric_scale from information_schema.columns
        where table_name in ('dual_run_lines', 'dual_run_dispositions')
          and column_name in ('v1_amount', 'v2_amount', 'delta', 'v1_counter', 'opening_gap', 'delta_at')`;
      expect(rows.map((r) => r.column_name).sort()).toEqual(['delta', 'delta_at', 'opening_gap', 'v1_amount', 'v1_counter', 'v2_amount']);
      for (const r of rows) expect(r).toMatchObject({ data_type: 'numeric', numeric_precision: 14, numeric_scale: 2 });
    },
    30_000,
  );

  it.each([
    ['dual_run_reports_week_monday_check', { week_start: '2026-10-20', through: '2026-10-25' }],
    ['dual_run_reports_through_in_week_check', { week_start: '2026-10-19', through: '2026-10-18' }],
    ['dual_run_reports_through_in_week_check', { week_start: '2026-10-19', through: '2026-10-26' }],
    ['dual_run_reports_no_data_days_check', { verdict: 'no_data', compared_days: 3 }],
    ['dual_run_reports_verdict_check', { verdict: 'maybe', compared_days: 1 }],
  ] as const)(
    'C1: report refusal -> %s. Killing mutant: that CHECK dropped. Red today: relation does not exist',
    async (name, over) => {
      const f = await fixture('c1');
      expect(constraintOf(await failure(rawReport(f, over)))).toBe(name);
    },
    30_000,
  );

  it(
    'C2: controls - a Monday week with through = Sunday, no_data with 0 days, and through = week start all store. Red today: relation does not exist',
    async () => {
      const f = await fixture('c2');
      await rawReport(f, { through: '2026-10-25' });
      await rawReport(f, { verdict: 'no_data', compared_days: 0 });
      await rawReport(f, { through: '2026-10-19' });
      for (const v of ['ties', 'open', 'explained']) await rawReport(f, { verdict: v, compared_days: 0 }); // ruling 3: only no_data implies 0
    },
    30_000,
  );

  it(
    'C3: the R8 identity is unique, and a changed fingerprint is a NEW version (append, not upsert). Mutant: identity unique dropped / upsert. Red today: relation does not exist',
    async () => {
      const f = await fixture('c3');
      const o = { v1: 'same-v1', v2: 'same-v2' };
      await rawReport(f, o);
      expect(constraintOf(await failure(rawReport(f, o)))).toBe('dual_run_reports_identity_unique');
      await rawReport(f, { v1: 'same-v1', v2: 'v2-one-centavo-later' });
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from dual_run_reports where org_id = ${f.orgId}`;
      expect(n!.n).toBe(2);
    },
    30_000,
  );

  it.each([
    ['delta not v2 - v1', { v1: '100.00', v2: '150.00', delta: '40.00' }, 'dual_run_lines_delta_check'],
    ['class outside the catalogue', { class: 'MADE_UP' }, 'dual_run_lines_class_check'],
  ] as const)(
    'C4: line refusal (%s) -> %s. Killing mutant: that CHECK dropped. Red today: relation does not exist',
    async (_n, over, name) => {
      const f = await fixture('c4');
      const [rep] = await rawReport(f);
      expect(constraintOf(await failure(rawLine(rep!.id as string, over)))).toBe(name);
    },
    30_000,
  );

  it(
    'C5: every code in CLASS_CATALOGUE is accepted as a line class, the same (report, kind, line_key) twice is refused. Mutant: catalogue copy drifts / unique dropped. Red today: relation does not exist',
    async () => {
      const f = await fixture('c5');
      const [rep] = await rawReport(f);
      for (const c of Object.keys(CLASS_CATALOGUE)) await rawLine(rep!.id as string, { class: c, lineKey: `k-${c}` });
      expect(constraintOf(await failure(rawLine(rep!.id as string, { lineKey: 'k-TIES' })))).toBe('dual_run_lines_key_unique');
    },
    60_000,
  );

  it.each(['INVENTORY_BASIS', 'NOT_IN_DUAL_RUN_SCOPE', 'UNEXPLAINED', 'TIES'])(
    'C6 (R10): a disposition of %s is refused - a person assigns only V1_DEFECT / V2_DEFECT. Mutant: class CHECK dropped. Red today: relation does not exist',
    async (c) => {
      const f = await fixture('c6');
      expect(constraintOf(await failure(rawDisp(f, { class: c })))).toBe('dual_run_dispositions_class_check');
    },
    30_000,
  );

  it.each(['foo', 'DEF-', 'DEF-12x', 'def-12', ''])(
    'C7 (R10): a defect disposition with ref %j is refused. Mutant: ref CHECK dropped. Red today: relation does not exist',
    async (ref) => {
      const f = await fixture('c7');
      expect(constraintOf(await failure(rawDisp(f, { ref })))).toBe('dual_run_dispositions_ref_check');
    },
    30_000,
  );

  it(
    'C8 (R10): a defect disposition with NO ref is refused (NOT NULL or the ref CHECK); valid V1_DEFECT/DEF-634 and V2_DEFECT/DEF-7 store. Red today: relation does not exist',
    async () => {
      const f = await fixture('c8');
      const err = await failure(rawDisp(f, { ref: null }));
      expect(codeOf(err)).toBe('23502'); // ruling 4: NOT NULL
      await rawDisp(f, { class: 'V1_DEFECT', ref: 'DEF-634' });
      await rawDisp(f, { class: 'V2_DEFECT', ref: 'DEF-7' });
    },
    30_000,
  );

  it(
    'C9 (ruling 7): a cross-org store or created_by is refused with 23503 NAMING the 0194-pattern composite FK, on reports and on dispositions. Mutant: plain store_id FK / no FK on created_by. Red today: relation does not exist',
    async () => {
      const a = await fixture('c9a');
      const b = await fixture('c9b');
      const rep = (store: string, by: string) => sql`
        insert into dual_run_reports (org_id, store_id, week_start, through, v1_fingerprint, v2_fingerprint, keys_sha, v1_snapshot_sha, v1_extracted_at, verdict, compared_days, created_by)
        values (${a.orgId}, ${store}, '2026-10-19', '2026-10-25', ${uid('x')}, ${uid('y')}, 'k', 's', now(), 'open', 1, ${by})`;
      const disp = (store: string, by: string) => sql`
        insert into dual_run_dispositions (org_id, store_id, week_start, kind, line_key, delta_at, class, ref, note, created_by)
        values (${a.orgId}, ${store}, '2026-10-19', 'sales_tender', 'cash', 1, 'V1_DEFECT', 'DEF-1', 'n', ${by})`;
      for (const [t, mk] of [['dual_run_reports', rep], ['dual_run_dispositions', disp]] as const) {
        const e1 = await failure(mk(b.storeA, a.personId));
        expect([codeOf(e1), constraintOf(e1)], `${t} store`).toEqual(['23503', `${t}_store_id_same_org_fk`]);
        const e2 = await failure(mk(a.storeA, b.personId));
        expect([codeOf(e2), constraintOf(e2)], `${t} created_by`).toEqual(['23503', `${t}_created_by_same_org_fk`]);
      }
    },
    30_000,
  );

  it.each([
    ['dual_run_lines', 'dual_run_lines_kind_check'],
    ['dual_run_dispositions', 'dual_run_dispositions_kind_check'],
  ] as const)(
    'C10 (ruling 6): a kind outside the seven is refused on %s -> %s; every allowed kind is accepted. Mutant: kind CHECK dropped. Red today: relation does not exist',
    async (table, name) => {
      const f = await fixture('c10');
      const kinds = ['cash_bank', 'staff_cash', 'sales_tender', 'expense_category', 'ap_supplier', 'inventory_basis', 'unassigned_store'];
      const [rep] = await rawReport(f);
      const ins = (k: string) =>
        table === 'dual_run_lines' ? rawLine(rep!.id as string, { kind: k, lineKey: uid('lk') }) : rawDisp(f, { kind: k });
      expect(constraintOf(await failure(ins('made_up_kind')))).toBe(name);
      for (const k of kinds) await ins(k);
    },
    30_000,
  );

  it(
    'L1 (money ruling e): dual_run_lines.org_id is NOT NULL, there is NO trigger named dual_run_lines_set_org (nor any non-internal trigger on the table), and a raw line with an org_id different from its report is refused 23503 naming dual_run_lines_report_same_org_fk. Mutant: trigger-filled org_id / plain report FK. Red today: relation does not exist',
    async () => {
      const a = await fixture('l1a');
      const b = await fixture('l1b');
      const [col] = await sql<{ is_nullable: string }[]>`select is_nullable from information_schema.columns where table_name = 'dual_run_lines' and column_name = 'org_id'`;
      expect(col?.is_nullable).toBe('NO');
      const trg = await sql<{ tgname: string }[]>`select tgname from pg_trigger where tgrelid = to_regclass('dual_run_lines') and not tgisinternal`;
      expect(trg.map((t) => t.tgname)).toEqual([]);
      const [rep] = await rawReport(a);
      const bad = sql`
        insert into dual_run_lines (org_id, report_id, kind, line_key, label, v1_amount, v2_amount, delta, class, paired, per_day)
        values (${b.orgId}, ${rep!.id as string}, 'sales_tender', 'cash', 'x', 1, 2, 1, 'UNEXPLAINED', false, '[]'::jsonb)`;
      const err = await failure(bad);
      expect([codeOf(err), constraintOf(err)]).toEqual(['23503', 'dual_run_lines_report_same_org_fk']);
    },
    30_000,
  );

  it(
    'L2 (money ruling e): insertLines copies org_id from the report; a report id of ANOTHER org inserts nothing and raises. Mutant: caller-supplied org_id / silent no-op. Red today: dualRunRepo undefined',
    async () => {
      const a = await fixture('l2a');
      const b = await fixture('l2b');
      const repId = await asOrg(a.orgId, async (tx) => {
        const rep = await repo().insertReport(tx, reportIn(a));
        await repo().insertLines(tx, rep.id, [lineIn({ lineKey: 'cash' })]);
        return rep.id;
      });
      const [row] = await sql<{ org_id: string }[]>`select org_id from dual_run_lines where report_id = ${repId}`;
      expect(row?.org_id).toBe(a.orgId);
      const err = await failure(asOrg(b.orgId, (tx) => repo().insertLines(tx, repId, [lineIn({ lineKey: 'smuggled' })])));
      expect(err).toBeInstanceOf(Error);
      const [n] = await sql<{ n: number }[]>`select count(*)::int as n from dual_run_lines where report_id = ${repId}`;
      expect(n!.n).toBe(1);
    },
    30_000,
  );
});

// ======================================================================================================
describe('25 - RLS, append-only grants, classification', () => {
  it(
    'R1: all three tables are ENABLE + FORCE row security. Mutant: FORCE omitted. Red today: relation does not exist',
    async () => {
      for (const t of TABLES) {
        const [r] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          select relrowsecurity, relforcerowsecurity from pg_class where oid = to_regclass(${t})`;
        expect(r, t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }
    },
    30_000,
  );

  it(
    'R2: org B sees none of org A\'s reports, lines or dispositions; org A sees its own. Mutant: policy missing on a table. Red today: relation does not exist',
    async () => {
      const a = await fixture('r2a');
      const b = await fixture('r2b');
      const [rep] = await sql<{ id: string }[]>`
        insert into dual_run_reports (org_id, store_id, week_start, through, v1_fingerprint, v2_fingerprint, keys_sha, v1_snapshot_sha, v1_extracted_at, verdict, compared_days, created_by)
        values (${a.orgId}, ${a.storeA}, '2026-10-19', '2026-10-25', 'x', 'y', 'k', 's', now(), 'open', 2, ${a.personId}) returning id`;
      await sql`insert into dual_run_lines (org_id, report_id, kind, line_key, label, v1_amount, v2_amount, delta, class, paired, per_day)
        values (${a.orgId}, ${rep!.id}, 'sales_tender', 'cash', 'Cash', 1, 2, 1, 'UNEXPLAINED', false, '[]'::jsonb)`;
      await sql`insert into dual_run_dispositions (org_id, store_id, week_start, kind, line_key, delta_at, class, ref, note, created_by)
        values (${a.orgId}, ${a.storeA}, '2026-10-19', 'sales_tender', 'cash', 1, 'V1_DEFECT', 'DEF-1', 'n', ${a.personId})`;
      for (const t of TABLES) {
        const count = (org: string) => asOrg(org, async (tx) => Number(((await tx.execute(dsql.raw(`select count(*)::int as n from ${t}`))) as unknown as { n: number }[])[0]!.n));
        expect(await count(a.orgId), `${t} as A`).toBe(1);
        expect(await count(b.orgId), `${t} as B`).toBe(0);
      }
    },
    30_000,
  );

  it(
    'R3: org B cannot INSERT a report or a disposition for org A (WITH CHECK, 42501). Mutant: policy without WITH CHECK. Red today: relation does not exist',
    async () => {
      const a = await fixture('r3a');
      const b = await fixture('r3b');
      const rep = asOrg(b.orgId, (tx) => repo().insertReport(tx, {
        orgId: a.orgId, storeId: a.storeA, weekStart: '2026-10-19', through: '2026-10-25', v1Fingerprint: 'x', v2Fingerprint: 'y',
        keysSha: 'k', v1SnapshotSha: 's', v1ExtractedAt: new Date(), verdict: 'open', comparedDays: 1, createdBy: a.personId,
      }));
      expect(codeOf(await failure(rep))).toBe('42501');
      const disp = asOrg(b.orgId, (tx) => repo().insertDisposition(tx, {
        orgId: a.orgId, storeId: a.storeA, weekStart: '2026-10-19', kind: 'sales_tender', lineKey: 'cash', deltaAt: '1.00',
        class: 'V1_DEFECT', ref: 'DEF-1', note: 'n', createdBy: a.personId,
      }));
      expect(codeOf(await failure(disp))).toBe('42501');
    },
    30_000,
  );

  it(
    'R4 (inv 25): the app role cannot UPDATE or DELETE any of the three tables (42501). Mutant: a broader GRANT. Red today: relation does not exist',
    async () => {
      const f = await fixture('r4');
      const stmts = [
        'update dual_run_reports set compared_days = 9',
        'delete from dual_run_reports',
        "update dual_run_lines set label = 'x'",
        'delete from dual_run_lines',
        "update dual_run_dispositions set note = 'x'",
        'delete from dual_run_dispositions',
      ];
      for (const s of stmts) {
        expect(codeOf(await failure(asOrg(f.orgId, (tx) => tx.execute(dsql.raw(s))))), s).toBe('42501');
      }
    },
    30_000,
  );

  it(
    'R5: the app role HAS select + insert on all three (a refused UPDATE above must not be a blanket lockout). Red today: relation does not exist',
    async () => {
      for (const t of TABLES) {
        const [r] = await sql<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>`
          select has_table_privilege(${APP_ROLE}, ${t}, 'SELECT') as s, has_table_privilege(${APP_ROLE}, ${t}, 'INSERT') as i,
                 has_table_privilege(${APP_ROLE}, ${t}, 'UPDATE') as u, has_table_privilege(${APP_ROLE}, ${t}, 'DELETE') as d`;
        expect(r, t).toEqual({ s: true, i: true, u: false, d: false });
      }
    },
    30_000,
  );

  it(
    'K1: every new table is classified (purge, notBefore 2027-01-31) AND registered in the RLS registry as org_column. Mutant: either entry missing. Red today: no entry',
    () => {
      for (const t of TABLES) {
        expect(CUTOVER_CLASSIFICATION[t], `${t} must be classified`).toBeDefined();
        expect(CUTOVER_CLASSIFICATION[t]!.class).toBe('purge');
        expect(CUTOVER_CLASSIFICATION[t]!.notBefore).toBe('2027-01-31');
        expect(RLS_REGISTRY[t], `${t} must be in the RLS registry`).toMatchObject({ scope: 'org_column' });
      }
    },
  );
});
