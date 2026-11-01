/**
 * T-502 step 1 - READ-ONLY export of v1 expenses for the expense item catalogue. Modelled on dual-run-extract.ts.
 *
 * - v1 is only read: the client is `makeReadOnlyV1Client`'s (`collection(path).get()` and nothing else).
 * - A document's store is taken from its PATH; a storeId field inside the document is not trusted.
 * - Amounts are kept exactly as v1 holds them, as strings; they are never run through Number() for output.
 * - No key material is read here (the caller builds the client) and none is printed.
 * - Under NODE_ENV=production it refuses before it reads or writes anything.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeCsvCell } from '../../packages/core/src/csv';
import type { ReadOnlyV1Client } from '../../packages/etl/src/master-data/snapshot';
import { normaliseBusinessDate } from '../../packages/etl/src/dual-run/week';

export interface V1ExpenseExportOptions {
  from: string;
  through: string;
  outDir: string;
  /** v1 store ids; omitted = every store in the roster. */
  stores?: string[];
  env: { NODE_ENV?: string; [k: string]: string | undefined };
  now?: Date;
}

export interface V1ExpenseExportResult {
  expensesPath: string;
  entriesPath: string;
  summaryPath: string;
  readmePath: string;
  counts: { expenses: number; expenseEntries: number; particulars: number };
  summary: string;
}

type Raw = Record<string, unknown>;
const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? '' : String(v));
const row = (cells: Array<string | number>): string => cells.map((c) => escapeCsvCell(c)).join(',') + '\n';

export function normaliseParticulars(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Used only for the summary total; the amount column itself stays a string.
const centavos = (s: string): number => {
  const n = Math.round(Number(s) * 100);
  return Number.isFinite(n) ? n : 0;
};
const pesos = (c: number): string => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

interface ExpenseRow {
  id: string; storeId: string; storeName: string; date: string; group: string; category: string; subCategory: string;
  entryId: string; particulars: string; amount: string; supplier: string; payment: string; voided: boolean;
}

function write(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* the OS may not support it */ }
}

export async function runV1ExpenseExport(client: ReadOnlyV1Client, opts: V1ExpenseExportOptions): Promise<V1ExpenseExportResult> {
  if (opts.env.NODE_ENV === 'production') {
    throw new Error('v1-expense-export refuses to run under NODE_ENV=production: production holds no v1 credentials. Run it on the owner machine.');
  }
  const from = normaliseBusinessDate(opts.from);
  const through = normaliseBusinessDate(opts.through);
  if (!from) throw new Error(`--from ${JSON.stringify(opts.from)} is not a real calendar date (YYYY-MM-DD)`);
  if (!through) throw new Error(`--through ${JSON.stringify(opts.through)} is not a real calendar date (YYYY-MM-DD)`);
  if (through < from) throw new Error(`--through ${through} is before --from ${from}`);

  const roster = (await client.collection('stores').get()).docs.map((d) => ({ id: d.id, name: text(d.data().name) }));
  const known = new Set(roster.map((s) => s.id));
  for (const id of opts.stores ?? []) if (!known.has(id)) throw new Error(`--stores ${id}: not a v1 store`);
  const chosen = opts.stores ? roster.filter((s) => opts.stores!.includes(s.id)) : roster;

  const rows: ExpenseRow[] = [];
  for (const s of chosen) {
    for (const d of (await client.collection(`stores/${s.id}/expenses`).get()).docs) {
      const e = d.data() as Raw;
      const date = normaliseBusinessDate(e.dayKey);
      if (!date || date < from || date > through) continue;
      const payments = Array.isArray(e.payments) ? (e.payments as Raw[]) : [];
      rows.push({
        id: d.id, storeId: s.id, storeName: s.name, date,
        group: text(e.expenseEntryGroup), category: text(e.category), subCategory: text(e.subCategory),
        entryId: text(e.expenseEntryId), particulars: text(e.particulars), amount: text(e.totalAmount),
        supplier: text(e.supplierName), payment: payments.map((p) => text(p.method)).filter(Boolean).join('|'),
        voided: e.status === 'voided' || e.deleted === true || e.isDeleted === true,
      });
    }
  }
  rows.sort((a, b) => a.storeId.localeCompare(b.storeId) || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const entries = (await client.collection('expenseEntries').get()).docs.map((d) => ({ ...(d.data() as Raw), id: d.id }) as Raw & { id: string });

  const agg = new Map<string, { count: number; total: number; first: string; last: string; cats: Set<string> }>();
  for (const r of rows) {
    const key = normaliseParticulars(r.particulars);
    if (r.voided || key === '') continue;
    const a = agg.get(key) ?? { count: 0, total: 0, first: r.date, last: r.date, cats: new Set<string>() };
    a.count += 1;
    a.total += centavos(r.amount);
    if (r.date < a.first) a.first = r.date;
    if (r.date > a.last) a.last = r.date;
    a.cats.add([r.group, r.category, r.subCategory].join(' / '));
    agg.set(key, a);
  }
  const summaryRows = [...agg.entries()].sort((x, y) => y[1].count - x[1].count || x[0].localeCompare(y[0]));

  mkdirSync(opts.outDir, { recursive: true });
  const expensesPath = join(opts.outDir, 'expenses.csv');
  const entriesPath = join(opts.outDir, 'expense-entries.csv');
  const summaryPath = join(opts.outDir, 'particulars-summary.csv');
  const readmePath = join(opts.outDir, 'README.txt');

  write(expensesPath, row(['v1_id', 'store_id', 'store_name', 'business_date', 'group', 'category', 'sub_category', 'expense_entry_id', 'particulars', 'amount', 'supplier_name', 'payment_method', 'voided'])
    + rows.map((r) => row([r.id, r.storeId, r.storeName, r.date, r.group, r.category, r.subCategory, r.entryId, r.particulars, r.amount, r.supplier, r.payment, String(r.voided)])).join(''));
  write(entriesPath, row(['id', 'group', 'category', 'sub_category', 'is_active', 'need_receipts', 'need_particulars', 'is_system'])
    + entries.map((e) => row([e.id, text(e.group), text(e.category), text(e.subCategory), text(e.isActive), text(e.needReceipts), text(e.needParticulars), text(e.isSystem)])).join(''));
  write(summaryPath, row(['particulars', 'count', 'total_amount', 'first_date', 'last_date', 'categories'])
    + summaryRows.map(([k, a]) => row([k, a.count, pesos(a.total), a.first, a.last, [...a.cats].sort().join(' | ')])).join(''));

  const counts = { expenses: rows.length, expenseEntries: entries.length, particulars: summaryRows.length };
  const summary = `Window ${from} to ${through}; stores ${chosen.length}; expenses ${counts.expenses}; expense entries ${counts.expenseEntries}; distinct particulars ${counts.particulars} (voided and blank particulars excluded from the summary).`;
  write(readmePath, `v1 expense export, run ${(opts.now ?? new Date()).toISOString().slice(0, 10)}. ${from} to ${through} inclusive. ${summary}\nContains real purchase data: keep it off the repo and off shared drives.\n`);
  return { expensesPath, entriesPath, summaryPath, readmePath, counts, summary };
}
