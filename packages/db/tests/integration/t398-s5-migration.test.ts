/**
 * T-398 S5b (TESTER) -- migration 0218 as a FILE and its registrations. docs/tasks/398-s5/{S5-REFRESH s3,TESTS L0},
 * docs/decisions/ADR-012-hand-authored-migrations.md s5. Real Postgres via TEST_DATABASE_URL for the catalog legs.
 *
 * RED TODAY: no journal entry numbered 0218, no migration file, no registry / classification entry, no schema mirror.
 *
 * ASSUMPTIONS the builder must meet (see the hand-back):
 *   - journal entry idx 218, tag starts "0218_" and names t398 (S5-REFRESH: 0218_t398_s5_inter_entity_shipments), `when` = 1804908707084
 *     (= 0217's 1804822307084 + 86 400 000), breakpoints true.
 *   - RLS_REGISTRY[table] = { scope: 'dual_org_counterparty', counterpartyColumn: 'buyer_org_id', reason } for both tables.
 *   - CUTOVER_CLASSIFICATION[table].class = 'purge' (S5-REFRESH s3.10 "operational, purged per org", spec B4).
 *   - the scheduler_runs_job_check restates EVERY job of the previous list (0216's) plus 'inter_entity_reconcile'; if 0217 (another
 *     lane) adds a job, the builder must merge it -- the leg reads the previous list from the newest earlier migration on disk.
 *   - trade_discrepancies gets disposition 'franchise_credit' (paired with direction 'short') and a nullable inter_entity_shipment_line_id
 *     that is a composite (org_id, inter_entity_shipment_line_id) -> inter_entity_shipment_lines (org_id, id).
 *
 * MUTANTS: lock_timeout not first / RESET missing -> L1; CRLF/BOM/0x08 -> L1; journal `when` off the grid -> L0;
 *   registry kind missing -> G1; classification missing -> G2; job list shortened -> J1; disposition not added -> TD1;
 *   a table created in the scratch DB differently from the catalog -> L2.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { RLS_REGISTRY } from '../../src/rls/registry';
import { CUTOVER_CLASSIFICATION } from '../../src/cutover/classification';
import { dbUrl, dropDb, MIGRATIONS_FOLDER, withAdmin } from './t398-s3-fixture';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}
const sql = postgres(url, { max: 3 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const TABLES = ['inter_entity_shipments', 'inter_entity_shipment_lines'] as const;
const WHEN_0217 = 1804822307084;
const WHEN_0218 = WHEN_0217 + 86_400_000; // 1804908707084

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}
const journal = () => (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries;
const entry = () => journal().find((e) => e.tag.startsWith('0218_'));
function text(): string {
  const e = entry();
  expect(e, 'RED today: no journal entry numbered 0218 (the S5b migration does not exist yet)').toBeDefined();
  const f = join(MIGRATIONS_FOLDER, `${e!.tag}.sql`);
  expect(existsSync(f), `${f} missing`).toBe(true);
  return readFileSync(f, 'utf8');
}
const stmts = (t: string) =>
  t.split(/-->\s*statement-breakpoint/).map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()).filter(Boolean);

describe('L0 -- journal entry', () => {
  it('exactly one 0218 entry: idx 218, tag names t398, version 7, breakpoints true, when = 0217 + 86 400 000 = 1804908707084 (the day grid)', () => {
    const all = journal().filter((e) => e.tag.startsWith('0218_'));
    expect(all.length, 'RED today: no 0218 entry').toBe(1);
    expect(all[0]).toMatchObject({ idx: 218, version: '7', breakpoints: true, when: WHEN_0218 });
    expect(all[0]!.tag).toMatch(/t398/);
    expect(WHEN_0218).toBe(1804908707084);
  });

  it('the entry is the LAST one and strictly after every earlier entry (journal stays ordered by when)', () => {
    const j = journal();
    expect(j[j.length - 1]!.tag.startsWith('0218_'), 'RED today: 0218 not the head').toBe(true);
    for (let i = 1; i < j.length; i++) expect(j[i]!.when, `${j[i]!.tag} when must exceed ${j[i - 1]!.tag}`).toBeGreaterThan(j[i - 1]!.when);
  });

  it('the file list and the journal agree: every .sql has an entry and every entry has a .sql', () => {
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4)).sort();
    expect(journal().map((e) => e.tag).sort()).toEqual(files);
  });
});

describe('L1 -- the 0218 migration text (ADR-012 s5)', () => {
  it('LF-only, no BOM, no 0x08 byte (a broken \\b regex), ends with a newline', () => {
    const t = text();
    expect(t.includes('\r'), 'CRLF').toBe(false);
    expect(t.charCodeAt(0), 'BOM').not.toBe(0xfeff);
    expect(t.includes(String.fromCharCode(8)), 'a backspace byte').toBe(false);
    expect(t.endsWith('\n')).toBe(true);
  });

  it("the first statement is SET LOCAL lock_timeout = '5s' and the last is RESET lock_timeout (kills: either missing or out of place)", () => {
    const s = stmts(text());
    expect(s[0] ?? '').toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'/i);
    expect(s[s.length - 1] ?? '', 'RESET last').toMatch(/^RESET lock_timeout/i);
  });

  it('the header names T-398 S5 and the rulings it implements (R5, A3, A4, A6, C5) and states the lock it takes on the live tables it ALTERs', () => {
    const header = text().split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(header).toMatch(/T-398/);
    expect(header).toMatch(/S5/);
    for (const r of ['A3', 'A4', 'A6', 'C5']) expect(header, `header should cite ${r}`).toMatch(new RegExp(r));
    expect(header).toMatch(/deliveries/);
    expect(header).toMatch(/lock/i);
  });

  it('it creates both tables, ENABLEs and FORCEs RLS on both, and creates the three definer functions with SECURITY DEFINER', () => {
    const t = text();
    for (const tbl of TABLES) {
      expect(t, `${tbl} not created`).toMatch(new RegExp(`CREATE TABLE "?${tbl}"?`, 'i'));
      expect(t, `${tbl}: ENABLE ROW LEVEL SECURITY`).toMatch(new RegExp(`ALTER TABLE "?${tbl}"? ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(t, `${tbl}: FORCE ROW LEVEL SECURITY`).toMatch(new RegExp(`ALTER TABLE "?${tbl}"? FORCE ROW LEVEL SECURITY`, 'i'));
    }
    for (const fn of ['receive_inter_entity_shipment', 'inter_entity_buyer_posted', 'inter_entity_counterparty_balance']) {
      expect(t, `${fn} not created`).toMatch(new RegExp(`FUNCTION\\s+"?${fn}"?`, 'i'));
      expect(t, `${fn}: REVOKE ... FROM PUBLIC`).toMatch(new RegExp(`REVOKE\\s+(ALL|EXECUTE)[^;]*${fn}[^;]*FROM\\s+PUBLIC`, 'is'));
    }
    expect((t.match(/SECURITY DEFINER/gi) ?? []).length, 'three definer functions').toBeGreaterThanOrEqual(3);
    expect((t.match(/SET search_path/gi) ?? []).length, 'search_path pinned on each').toBeGreaterThanOrEqual(3);
  });

  it('every table it ALTERs is one the plan names; it drops nothing (additive: no DROP TABLE / DROP COLUMN)', () => {
    const t = text();
    expect(t).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    const altered = [...t.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?"?([a-z_]+)"?/gi)].map((m) => m[1]!.toLowerCase());
    const allowed = new Set(['inter_entity_shipments', 'inter_entity_shipment_lines', 'deliveries', 'suppliers', 'customers', 'scheduler_runs', 'trade_discrepancies']);
    expect([...new Set(altered)].filter((x) => !allowed.has(x)), 'a table the plan does not touch').toEqual([]);
  });

  it('it contains no float type and no "double precision" / "real"', () => {
    expect(text()).not.toMatch(/\b(double precision|float4|float8|real)\b/i);
  });
});

describe('L2 -- 0218 applies from zero on a scratch database and yields the catalog the behaviour legs assume', () => {
  it('migrate() through the whole journal succeeds; both tables, three definer functions, the new columns exist', async () => {
    const name = `shareat_t398s5_test_${Date.now()}`;
    await dropDb(url, name);
    await withAdmin(url, (a) => a.unsafe(`CREATE DATABASE "${name}"`));
    const s = postgres(dbUrl(url, name), { max: 2 });
    try {
      await migrate(drizzle(s), { migrationsFolder: MIGRATIONS_FOLDER });
      const t = await s<{ relname: string }[]>`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${TABLES as unknown as string[]})`;
      expect(t.map((r) => r.relname).sort(), 'RED today: 0218 absent').toEqual([...TABLES].sort());
      const f = await s<{ proname: string }[]>`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('receive_inter_entity_shipment', 'inter_entity_buyer_posted', 'inter_entity_counterparty_balance')`;
      expect(f.length).toBe(3);
      const c = await s<{ table_name: string; column_name: string }[]>`
        select table_name, column_name from information_schema.columns where table_schema = 'public'
         and ((table_name = 'deliveries' and column_name = 'inter_entity_shipment_id') or (table_name = 'suppliers' and column_name = 'counterparty_org_id')
           or (table_name = 'customers' and column_name = 'credit_terms_days') or (table_name = 'trade_discrepancies' and column_name = 'inter_entity_shipment_line_id'))`;
      expect(c.length, JSON.stringify(c)).toBe(4);
    } finally {
      await s.end({ timeout: 5 });
      await dropDb(url, name);
    }
  }, 240_000);
});

describe('J -- scheduler_runs_job_check restates the whole list plus inter_entity_reconcile', () => {
  it('J1 the live constraint admits every job the previous migration listed and inter_entity_reconcile (kills: list shortened)', async () => {
    const [c] = await sql<{ def: string }[]>`select pg_get_constraintdef(oid) def from pg_constraint where conname = 'scheduler_runs_job_check' and conrelid = 'scheduler_runs'::regclass`;
    expect(c, 'constraint missing').toBeDefined();
    expect(c!.def, 'RED today: inter_entity_reconcile not admitted').toContain('inter_entity_reconcile');
    // previous list = the newest migration BEFORE 0218 that restates the constraint
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.startsWith('0218_')).sort().reverse();
    const prior = files.find((f) => /scheduler_runs_job_check"?\s*\n?\s*CHECK/i.test(readFileSync(join(MIGRATIONS_FOLDER, f), 'utf8')));
    expect(prior, 'a prior migration restating the job list').toBeDefined();
    const src = readFileSync(join(MIGRATIONS_FOLDER, prior!), 'utf8');
    const block = src.slice(src.search(/ADD CONSTRAINT "scheduler_runs_job_check"/i));
    const list = [...block.slice(0, block.indexOf(';')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(list.length, 'parsed the previous job list').toBeGreaterThan(10);
    for (const job of list) expect(c!.def, `job ${job} dropped from the check`).toContain(`'${job}'`);
  });
});

describe('TD -- trade_discrepancies learns franchise_credit (QO-2 a)', () => {
  it('TD1 the disposition CHECK admits franchise_credit and still admits every old disposition; the direction CHECK pairs it with short', async () => {
    const defs = await sql<{ conname: string; def: string }[]>`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid = 'trade_discrepancies'::regclass and contype = 'c'`;
    const disp = defs.find((d) => d.conname === 'trade_discrepancies_disposition_check');
    expect(disp, 'disposition check missing').toBeDefined();
    expect(disp!.def, 'RED today').toContain('franchise_credit');
    for (const old of ['loss', 'charge', 'late_receipt', 'extra_dispatch', 'return', 'audit']) expect(disp!.def, `old disposition ${old} dropped`).toContain(`'${old}'`);
    const dir = defs.find((d) => d.conname === 'trade_discrepancies_disposition_direction_check');
    expect(dir!.def, 'direction pairing').toMatch(/franchise_credit/);
  });

  it('TD2 inter_entity_shipment_line_id is nullable and composite (org_id, inter_entity_shipment_line_id) -> inter_entity_shipment_lines (org_id, id)', async () => {
    const col = await sql<{ is_nullable: string }[]>`select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'trade_discrepancies' and column_name = 'inter_entity_shipment_line_id'`;
    expect(col.length, 'RED today: column missing').toBe(1);
    expect(col[0]!.is_nullable).toBe('YES');
    const fk = await sql<{ cols: string[]; pcols: string[]; parent: string }[]>`
      select array(select attname from unnest(c.conkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by o) cols,
             array(select attname from unnest(c.confkey) with ordinality k(n, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by o) pcols,
             c.confrelid::regclass::text parent
      from pg_constraint c where c.contype = 'f' and c.conrelid = 'trade_discrepancies'::regclass`;
    expect(fk.some((f) => f.cols.join() === 'org_id,inter_entity_shipment_line_id' && f.pcols.join() === 'org_id,id' && f.parent === 'inter_entity_shipment_lines'), JSON.stringify(fk)).toBe(true);
  });
});

describe('G -- registrations: RLS registry kind, cutover classification, census, Drizzle mirror', () => {
  it.each(TABLES)('G1 %s is in RLS_REGISTRY with scope dual_org_counterparty and counterpartyColumn buyer_org_id (A10)', (t) => {
    const e = RLS_REGISTRY[t] as unknown as { scope: string; counterpartyColumn?: string; reason: string } | undefined;
    expect(e, `${t}: RED today, no RLS registry entry`).toBeDefined();
    expect(e!.scope).toBe('dual_org_counterparty');
    expect(e!.counterpartyColumn).toBe('buyer_org_id');
    expect(e!.reason.length).toBeGreaterThan(30);
  });

  it('G1b the RlsScope union and RlsEntry in registry.ts declare the new kind and its counterpartyColumn field', () => {
    const src = readFileSync(join(MIGRATIONS_FOLDER, '..', 'src', 'rls', 'registry.ts'), 'utf8');
    expect(src, "RlsScope must include 'dual_org_counterparty'").toMatch(/'dual_org_counterparty'/);
    expect(src).toMatch(/counterpartyColumn/);
  });

  it('G1c only these two tables use the new kind (it is not a general escape hatch)', () => {
    const users = Object.entries(RLS_REGISTRY).filter(([, e]) => (e as unknown as { scope: string }).scope === 'dual_org_counterparty').map(([t]) => t).sort();
    expect(users, 'RED today: none').toEqual([...TABLES].sort());
  });

  it.each(TABLES)('G2 %s is classified in CUTOVER_CLASSIFICATION as purge, with a reason (operational, purged per org)', (t) => {
    const e = CUTOVER_CLASSIFICATION[t];
    expect(e, `${t}: RED today, no cutover classification`).toBeDefined();
    expect(e!.class).toBe('purge');
    expect(e!.reason.length).toBeGreaterThan(30);
  });

  it('G3 census restated: every public base table has an RLS registry entry and a cutover classification (the build guard, as a catalog sweep)', async () => {
    const t = await sql<{ relname: string }[]>`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relispartition and relname not like '\_\_drizzle%'`;
    const names = t.map((r) => r.relname);
    expect(names, 'RED today: the shipment tables absent').toEqual(expect.arrayContaining([...TABLES]));
    expect(names.filter((n) => !(n in RLS_REGISTRY)), 'tables with no RLS registry entry').toEqual([]);
    expect(names.filter((n) => !(n in CUTOVER_CLASSIFICATION)), 'tables with no cutover classification').toEqual([]);
  });

  it('G4 the Drizzle mirror: schema/inter-entity.ts exists and the NOTE comments name migration 0218 in the changed schemas', () => {
    const dir = join(MIGRATIONS_FOLDER, '..', 'schema');
    expect(existsSync(join(dir, 'inter-entity.ts')), 'RED today: schema/inter-entity.ts missing').toBe(true);
    for (const f of ['suppliers.ts', 'customers.ts', 'deliveries.ts', 'trade-discrepancies.ts', 'scheduler.ts']) {
      expect(readFileSync(join(dir, f), 'utf8'), `${f}: no 0218 NOTE`).toMatch(/0218/);
    }
    expect(readFileSync(join(dir, 'index.ts'), 'utf8'), 'schema/index.ts must export inter-entity').toMatch(/inter-entity/);
  });

  it('G5 the repo file exists and holds the SQL (packages/db/src/repo/inter-entity.ts); the domain does not write SQL for these tables', () => {
    expect(existsSync(join(MIGRATIONS_FOLDER, '..', 'src', 'repo', 'inter-entity.ts')), 'RED today: repo/inter-entity.ts missing').toBe(true);
  });
});
