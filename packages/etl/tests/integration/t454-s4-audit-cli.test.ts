import { config } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-454 S4 (TESTER, audit round C/D) - CLI wiring of `scripts/audit.ts --expect-zero`. Real PostgreSQL (landed v1 journal legs in
 * etl_source_documents), the script is spawned and its exit code read.
 *   - an open party balance  -> exit code non-zero, the party printed
 *   - every party settled    -> exit 0
 *   - writes no docs/reviews/v1-audit-<asOf>.md
 *   - `--stores` without `--expect-zero` is refused (non-zero, mentions --expect-zero)
 * Mutant killed: exitCode computed but never set on the process / report path still taken.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: database name must contain "_test".');

const ROOT = join(__dirname, '..', '..', '..', '..');
const BANAY = 'iGOW7q2pZbeHWV832UNh';
const LIPA = 'b9DzsnPbr1BUnY88lyT4';
const sql = postgres(url, { max: 2 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let n = 0;
async function land(storeCode: string, legs: Array<Record<string, unknown>>): Promise<void> {
  const [run] = await sql<{ id: string }[]>`insert into etl_runs (source_system, mode, status) values ('erp_v1', 'capture', 'succeeded') returning id`;
  for (const l of legs) {
    n += 1;
    const id = `journal:t454-${Date.now()}-${n}:leg`;
    const payload = { id, storeId: storeCode, sourceType: 'journal', sourceId: `t454-${Date.now()}-${n}`, legKey: 'leg', businessDate: '2026-12-01', supplierId: null, customerId: null, employeeId: null, ...l };
    await sql`
      insert into etl_source_documents (run_id, source_system, collection_path, doc_path, doc_id, store_code, payload, content_hash)
      values (${run!.id}, 'erp_v1', ${`stores/${storeCode}/journal`}, ${`stores/${storeCode}/journal/${id}`}, ${id}, ${storeCode}, ${sql.json(payload as never)}, ${`h-${id}`})`;
  }
}

function audit(args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'audit.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: url },
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('T-454 audit CLI --expect-zero', () => {
  it('an open supplier balance: exit non-zero, supplier printed, no report file written', async () => {
    await land(BANAY, [{ accountId: 'ap__SUP-T454', direction: 'in', amount: 12.5, supplierId: 'SUP-T454' }]);
    const report = join(ROOT, 'docs', 'reviews', 'v1-audit-2026-12-31.md');
    const had = existsSync(report);
    const r = audit(['--stores', BANAY, '--as-of', '2026-12-31', '--expect-zero']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('SUP-T454');
    expect(existsSync(report)).toBe(had);
  }, 150_000);

  it('every party settled: exit 0', async () => {
    await land(LIPA, [
      { accountId: 'ap__SUP-T454', direction: 'in', amount: 40, supplierId: 'SUP-T454' },
      { accountId: 'ap__SUP-T454', direction: 'out', amount: 40, supplierId: 'SUP-T454' },
    ]);
    const r = audit(['--stores', LIPA, '--as-of', '2026-12-31', '--expect-zero']);
    expect(r.code).toBe(0);
  }, 150_000);

  it('--stores without --expect-zero is refused', () => {
    const r = audit(['--stores', BANAY, '--as-of', '2026-12-31']);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/expect-zero/);
  }, 150_000);
});
