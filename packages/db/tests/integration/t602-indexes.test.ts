/**
 * T-602 S1 - migration 0272: indexes for the POS receipt lists and for on-hand. docs/tasks/602-performance-first-pass.md S1.
 * (The spec called it 0263; main had moved past it and the board gave 0272.) Real Postgres via TEST_DATABASE_URL.
 *
 *  M1  file `0272_*.sql` names t602; journal idx 272, `when` = previous entry's `when` + 86,400,000 x idx gap, breakpoints true.
 *  M2  X1-X4 exist in pg_indexes with the exact definition (predicate and INCLUDE included).
 *  M3  with sequential scans off, EXPLAIN of each query shape (hand-written copies, each tagged with its file) names the index built for it;
 *      the new maxTerminalSeq shape names the UNIQUE (terminal_id, receipt_seq) index and has no Join. MUTANT: DROP INDEX X1 in the tx -> the plan no longer names it.
 *
 * Every probe runs in a transaction that is ALWAYS rolled back.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';
import { pinPlan } from './_fixtures/plan-pins';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
const sql = postgres(url, { max: 2 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const MIGRATIONS = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'migrations');
type Tx = postgres.TransactionSql;
class Rollback extends Error {}

/** Run `fn` in a transaction that is always rolled back; seq scans off so the plan shows which index COULD serve the shape. */
async function planTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let value: T | undefined;
  try {
    await sql.begin(async (tx) => {
      await pinPlan((s) => tx.unsafe(s));
      value = await fn(tx);
      throw new Rollback('rollback');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return value as T;
}
const explain = async (tx: Tx, query: string): Promise<string> => {
  const rows = await tx.unsafe(`explain ${query}`);
  return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
};

/**
 * T-624: EXPLAIN with the sibling indexes that could also serve the shape dropped (in a savepoint, undone at once). Which of two valid
 * indexes the planner prefers moves with row estimates, and CI shards share a database; what M3 proves is that `keep` CAN serve the shape.
 */
async function explainAlone(tx: Tx, query: string, siblings: readonly string[]): Promise<string> {
  let plan = '';
  try {
    await tx.savepoint(async (sp) => {
      for (const name of siblings) await sp.unsafe(`drop index ${name}`);
      plan = await explain(sp, query);
      throw new Rollback('undo the drops');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return plan;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = '00000000-0000-4000-8000-000000000002';
const TERMINAL = '00000000-0000-4000-8000-000000000003';
const CLOSE = '00000000-0000-4000-8000-000000000004';

// repo/pos-v2.ts listReceiptsSinceForList (the receipt columns; its joins to terminals/sessions/payments are on primary keys).
const SINCE = `select * from pos_sales_receipts where org_id = '${ORG}' and store_id = '${STORE}' and issued_at_device >= now() - interval '1 day' order by issued_at_device desc, id desc`;
// repo/pos-v2.ts listReceiptsOfClose
const OF_CLOSE = `select * from pos_sales_receipts where org_id = '${ORG}' and store_id = '${STORE}' and day_close_id = '${CLOSE}' order by issued_at_device asc, id asc`;
// repo/pos-v2.ts listOpenReceipts
const OPEN = `select * from pos_sales_receipts where org_id = '${ORG}' and store_id = '${STORE}' and terminal_id = '${TERMINAL}' and day_close_id is null order by issued_at_device asc, id asc`;
// repo/low-stock.ts lowStock, the on_hand CTE
const ON_HAND = `select item_id, coalesce(sum(quantity), 0) as qty from stock_movements where org_id = '${ORG}' and store_id = '${STORE}' group by item_id`;
// repo/pos-v2.ts maxTerminalSeq (T-602: terminal id, no join)
const MAX_SEQ = `select coalesce(max(receipt_seq), 0)::text from pos_sales_receipts where org_id = '${ORG}' and terminal_id = '${TERMINAL}'`;

describe('T-602 S1 - migration 0272', () => {
  const file = readdirSync(MIGRATIONS).find((f) => /^0272_.*t602.*\.sql$/.test(f));

  it('M1: the file names t602 and is journalled on the one-day grid', () => {
    expect(file, 'a 0272_*t602*.sql file').toBeTruthy();
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] };
    const e = journal.entries.find((x) => x.idx === 272)!;
    expect(e.tag).toBe(file!.replace(/\.sql$/, ''));
    expect(e.breakpoints).toBe(true);
    const prev = [...journal.entries].filter((x) => x.idx < 272).sort((a, b) => b.idx - a.idx)[0]!;
    expect(e.when).toBe(prev.when + 86_400_000 * (272 - prev.idx));
    expect(readFileSync(join(MIGRATIONS, file!), 'utf8')).toMatch(/SET LOCAL lock_timeout = '5s'/);
  });

  const DEFS: Record<string, string> = {
    pos_sales_receipts_store_issued_idx: 'CREATE INDEX pos_sales_receipts_store_issued_idx ON public.pos_sales_receipts USING btree (store_id, issued_at_device DESC, id DESC)',
    pos_sales_receipts_day_close_idx: 'CREATE INDEX pos_sales_receipts_day_close_idx ON public.pos_sales_receipts USING btree (day_close_id, issued_at_device, id) WHERE (day_close_id IS NOT NULL)',
    pos_sales_receipts_open_idx: 'CREATE INDEX pos_sales_receipts_open_idx ON public.pos_sales_receipts USING btree (terminal_id, issued_at_device, id) WHERE (day_close_id IS NULL)',
    stock_movements_store_item_qty_idx: 'CREATE INDEX stock_movements_store_item_qty_idx ON public.stock_movements USING btree (org_id, store_id, item_id) INCLUDE (quantity)',
  };
  it('M2: X1-X4 exist with the exact definition', async () => {
    for (const [name, def] of Object.entries(DEFS)) {
      const rows = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}`;
      expect(rows.map((r) => r.indexdef), name).toEqual([def]);
    }
  });

  it('M3: the query shapes are served by their index; dropping X1 un-serves the till list (mutant)', async () => {
    await planTx(async (tx) => {
      const X1 = 'pos_sales_receipts_store_issued_idx';
      const X2 = 'pos_sales_receipts_day_close_idx';
      const X3 = 'pos_sales_receipts_open_idx';
      expect(await explainAlone(tx, SINCE, [X2, X3])).toContain(X1);
      expect(await explainAlone(tx, OF_CLOSE, [X1, X3])).toContain(X2);
      expect(await explainAlone(tx, OPEN, [X1, X2])).toContain(X3);
      expect(await explainAlone(tx, ON_HAND, ['stock_movements_store_moved_idx', 'stock_movements_item_location_idx'])).toContain('stock_movements_store_item_qty_idx');
      const max = await explainAlone(tx, MAX_SEQ, [X1, X2, X3]);
      expect(max).toContain('pos_sales_receipts_terminal_seq_unique');
      expect(max).not.toMatch(/Join/);
      // MUTANT: without X1 the plan cannot name it.
      await tx`drop index pos_sales_receipts_store_issued_idx`;
      expect(await explain(tx, SINCE)).not.toContain('pos_sales_receipts_store_issued_idx');
    });
  });
});
