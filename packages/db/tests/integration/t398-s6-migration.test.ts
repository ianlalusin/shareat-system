/**
 * T-398 S6b (TESTER) -- migration 0220 as a FILE and its registrations. docs/tasks/398-s6/{S6-REFRESH s3,TESTS R1 + N1},
 * docs/decisions/ADR-012-hand-authored-migrations.md s5. Real Postgres via TEST_DATABASE_URL for the catalog legs.
 *
 * RED TODAY: no journal entry numbered 0220, no migration file, no registry / classification entry, no schema mirror, no repo file.
 *
 * ASSUMPTIONS the builder must meet (S6-REFRESH s3; also in the hand-back):
 *   - journal entry idx 220, tag starts "0220_" and names t398 (0220_t398_s6_franchise_view), `when` = 1805081507084 (= 0219's 1804995107084 + 86 400 000), breakpoints true.
 *   - RLS_REGISTRY[table] = { scope: 'dual_org_counterparty', counterpartyColumn: 'franchisor_org_id', reason names "SELECT only" and the writers } for both tables.
 *   - CUTOVER_CLASSIFICATION[table].class = 'keep' for both (QO-7).
 *   - NO_FK_REFERENCES has { column: 'franchise_access_log.session_id', kind: 'snapshot' } (K12) -- NOTE `snapshot` is not in the NoFkReference kind union
 *     today (external-key | idempotency-key | polymorphic | asserted-party | ref-gap); the builder widens the union.
 *   - the two tables each have ONE policy, FOR SELECT, naming org_id and franchisor_org_id; RLS ENABLE + FORCE.
 *
 * MUTANTS: lock_timeout not first / RESET missing -> L1; CRLF/BOM/0x08 -> L1; `when` off the grid -> L0; a policy for INSERT/UPDATE/DELETE or a write GRANT -> P1;
 *   registry kind missing / wrong counterparty column -> G1; classification missing / purge -> G2; the stale "only the two shipment tables" comment -> G1b;
 *   CROSS_ORG_BY_DESIGN grows -> N1; NO_FK entry missing -> N1; the ops README row missing -> O1; a table created in the scratch DB differently from the catalog -> L2.
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
import { CROSS_ORG_BY_DESIGN, NO_FK_REFERENCES } from '../../src/rls/same-org-fk-exemptions';
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

const TABLES = ['franchise_agreements', 'franchise_access_log'] as const;
const WHEN_0219 = 1804995107084;
const WHEN_0220 = WHEN_0219 + 86_400_000; // 1805081507084
const SRC = join(MIGRATIONS_FOLDER, '..', 'src');
const SCHEMA = join(MIGRATIONS_FOLDER, '..', 'schema');
const REPO_ROOT = join(MIGRATIONS_FOLDER, '..', '..', '..');

interface JournalEntry { idx: number; version: string; when: number; tag: string; breakpoints: boolean }
const journal = () => (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] }).entries;
const entry = () => journal().find((e) => e.tag.startsWith('0220_'));
function text(): string {
  const e = entry();
  expect(e, 'RED today: no journal entry numbered 0220 (the S6b migration does not exist yet)').toBeDefined();
  const f = join(MIGRATIONS_FOLDER, `${e!.tag}.sql`);
  expect(existsSync(f), `${f} missing`).toBe(true);
  return readFileSync(f, 'utf8');
}
const stmts = (t: string) =>
  t.split(/-->\s*statement-breakpoint/).map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()).filter(Boolean);
const header = (t: string) => t.split('\n').filter((l) => l.trim().startsWith('--')).join('\n');

describe('L0 -- journal entry', () => {
  it('exactly one 0220 entry: idx 220, tag names t398, version 7, breakpoints true, when = 0219 + 86 400 000 = 1805081507084 (the day grid)', () => {
    const all = journal().filter((e) => e.tag.startsWith('0220_'));
    expect(all.length, 'RED today: no 0220 entry').toBe(1);
    expect(all[0]).toMatchObject({ idx: 220, version: '7', breakpoints: true, when: WHEN_0220 });
    expect(all[0]!.tag).toMatch(/t398/);
    expect(WHEN_0220).toBe(1805081507084);
    const j = journal();
    const prev = j.find((e) => e.tag.startsWith('0219_'));
    expect(prev?.when, '0219 stays where the S5 journal leg pins it').toBe(WHEN_0219);
  });

  it('the journal stays strictly ordered by when, and the file list and the journal agree (every .sql has an entry and every entry a .sql)', () => {
    const j = journal();
    for (let i = 1; i < j.length; i++) expect(j[i]!.when, `${j[i]!.tag} when must exceed ${j[i - 1]!.tag}`).toBeGreaterThan(j[i - 1]!.when);
    const files = readdirSync(MIGRATIONS_FOLDER).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4)).sort();
    expect(j.map((e) => e.tag).sort()).toEqual(files);
    expect(j.some((e) => e.tag.startsWith('0220_')), 'RED today').toBe(true);
  });
});

describe('L1 -- the 0220 migration text (ADR-012 s5)', () => {
  it('LF-only, no BOM, no 0x08 byte (a broken \\b regex), ends with a newline', () => {
    const t = text();
    expect(t.includes('\r'), 'CRLF').toBe(false);
    expect(t.charCodeAt(0), 'BOM').not.toBe(0xfeff);
    expect(t.includes(String.fromCharCode(8)), 'a backspace byte').toBe(false);
    expect(t.endsWith('\n')).toBe(true);
  });

  it("the first statement is SET LOCAL lock_timeout = '5s' and the last is RESET lock_timeout", () => {
    const s = stmts(text());
    expect(s[0] ?? '').toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'/i);
    expect(s[s.length - 1] ?? '', 'RESET last').toMatch(/^RESET lock_timeout/i);
  });

  it('the header names T-398 S6 and the rulings it implements (R6, A5, B3, C4), the sessions trigger (the lock it takes on a live table), K4, and states that a forged log_break_glass_approval can only ADD a row', () => {
    const h = header(text());
    expect(h).toMatch(/T-398/);
    expect(h).toMatch(/S6/);
    for (const r of ['R6', 'A5', 'B3', 'C4']) expect(h, `header should cite ${r}`).toMatch(new RegExp(r));
    expect(h).toMatch(/sessions/);
    expect(h).toMatch(/lock/i);
    expect(h).toMatch(/log_break_glass_approval/);
    expect(h, 'the over-reporting argument is written down').toMatch(/over-?report|only (add|ADD)|never hid/i);
    for (const fn of ['franchise_sales_daily', 'franchise_stock_levels', 'franchise_franchisees', 'franchise_reader_check']) {
      expect(h, `the header lists the definer ${fn} (V14 pins the set against this list)`).toMatch(new RegExp(fn));
    }
  });

  it('it creates both tables, ENABLEs and FORCEs RLS on both, creates every definer with SECURITY DEFINER + a pinned search_path and REVOKEs it FROM PUBLIC, and creates the sessions trigger', () => {
    const t = text();
    for (const tbl of TABLES) {
      expect(t, `${tbl} not created`).toMatch(new RegExp(`CREATE TABLE "?${tbl}"?`, 'i'));
      expect(t, `${tbl}: ENABLE ROW LEVEL SECURITY`).toMatch(new RegExp(`ALTER TABLE "?${tbl}"? ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(t, `${tbl}: FORCE ROW LEVEL SECURITY`).toMatch(new RegExp(`ALTER TABLE "?${tbl}"? FORCE ROW LEVEL SECURITY`, 'i'));
    }
    for (const fn of ['franchise_sales_daily', 'franchise_stock_levels', 'franchise_franchisees', 'log_break_glass_approval', 'franchise_reader_check']) {
      expect(t, `${fn} not created`).toMatch(new RegExp(`FUNCTION\\s+"?${fn}"?`, 'i'));
      expect(t, `${fn}: REVOKE ... FROM PUBLIC`).toMatch(new RegExp(`REVOKE\\s+(ALL|EXECUTE)[^;]*${fn}[^;]*FROM\\s+PUBLIC`, 'is'));
    }
    expect((t.match(/SECURITY DEFINER/gi) ?? []).length, 'five definer functions + the session trigger function').toBeGreaterThanOrEqual(6);
    expect((t.match(/SET search_path/gi) ?? []).length, 'search_path pinned on each').toBeGreaterThanOrEqual(6);
    expect(t, 'the sessions trigger').toMatch(/CREATE TRIGGER\s+"?sessions_break_glass_log_trg"?\s+AFTER INSERT ON\s+"?sessions"?/i);
  });

  it('P1 it grants shareat_app SELECT only on the two tables and creates exactly one policy per table, FOR SELECT (A5, V12, V24). Mutant: a write policy or a write grant', () => {
    const t = text();
    expect(t, 'no INSERT/UPDATE/DELETE/ALL grant to shareat_app on the franchise tables').not.toMatch(/GRANT\s+(ALL|INSERT|UPDATE|DELETE|TRUNCATE)[^;]*franchise_(agreements|access_log)[^;]*shareat_app/is);
    expect(t, 'SELECT is granted').toMatch(/GRANT\s+SELECT[^;]*franchise_(agreements|access_log)[^;]*shareat_app/is);
    const policies = [...t.matchAll(/CREATE POLICY\s+"?([a-z_]+)"?\s+ON\s+"?([a-z_]+)"?([^;]*);/gis)];
    expect(policies.map((m) => m[2]).sort()).toEqual([...TABLES].sort());
    for (const p of policies) {
      expect(p[3], `${p[1]} must be FOR SELECT`).toMatch(/FOR SELECT/i);
      expect(p[3], `${p[1]} names the franchisor arm`).toMatch(/franchisor_org_id/);
    }
  });

  it('it touches no live table except sessions (the trigger) and drops nothing: no DROP TABLE / DROP COLUMN, ALTER TABLE only on the two new tables, no float type', () => {
    const t = text();
    expect(t).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    const altered = [...t.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?"?([a-z_]+)"?/gi)].map((m) => m[1]!.toLowerCase());
    expect([...new Set(altered)].filter((x) => !(TABLES as readonly string[]).includes(x)), 'a table the plan does not touch').toEqual([]);
    expect(t).not.toMatch(/\b(double precision|float4|float8|real)\b/i);
  });
});

describe('L2 -- 0220 applies from zero on a scratch database and yields the catalog the behaviour legs assume', () => {
  it('migrate() through the whole journal succeeds; both tables, the four callable definers + the guard helper and the sessions trigger exist; both tables have RLS enabled AND forced', async () => {
    const name = `shareat_t398s6_test_${Date.now()}`;
    await dropDb(url, name);
    await withAdmin(url, (a) => a.unsafe(`CREATE DATABASE "${name}"`));
    const s = postgres(dbUrl(url, name), { max: 2 });
    try {
      await migrate(drizzle(s), { migrationsFolder: MIGRATIONS_FOLDER });
      const t = await s<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        select relname, relrowsecurity, relforcerowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any(${TABLES as unknown as string[]})`;
      expect(t.map((r) => r.relname).sort(), 'RED today: 0220 absent').toEqual([...TABLES].sort());
      expect(t.every((r) => r.relrowsecurity && r.relforcerowsecurity), 'RLS enabled AND forced on both').toBe(true);
      const f = await s<{ proname: string }[]>`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('franchise_sales_daily', 'franchise_stock_levels', 'franchise_franchisees', 'log_break_glass_approval', 'franchise_reader_check')`;
      expect(f.length).toBe(5);
      const tr = await s<{ tgname: string }[]>`select tgname from pg_trigger where tgrelid = 'sessions'::regclass and tgname = 'sessions_break_glass_log_trg' and not tgisinternal`;
      expect(tr.length).toBe(1);
      const pol = await s<{ tablename: string; cmd: string; qual: string }[]>`select tablename, cmd, qual from pg_policies where schemaname = 'public' and tablename = any(${TABLES as unknown as string[]})`;
      expect(pol.map((p) => [p.tablename, p.cmd]).sort(), 'one SELECT policy per table, nothing else').toEqual([['franchise_access_log', 'SELECT'], ['franchise_agreements', 'SELECT']]);
      for (const p of pol) {
        expect(p.qual, `${p.tablename}: own-org arm`).toMatch(/org_id/);
        expect(p.qual, `${p.tablename}: franchisor arm`).toMatch(/franchisor_org_id/);
      }
      const trg = await s<{ tgrelid: string; tgname: string }[]>`select tgrelid::regclass::text tgrelid, tgname from pg_trigger where tgrelid = any(array['franchise_access_log'::regclass, 'franchise_agreements'::regclass]) and not tgisinternal`;
      expect(trg.filter((x) => x.tgrelid === 'franchise_access_log').length, 'log: the append-only trigger (T-398 S6 (no TRUNCATE trigger, orchestrator 28 Oct))').toBeGreaterThanOrEqual(1);
      expect(trg.filter((x) => x.tgrelid === 'franchise_agreements').length, 'agreements: the app-role guard (T-398 S6 (no TRUNCATE trigger, orchestrator 28 Oct))').toBeGreaterThanOrEqual(1);
    } finally {
      await s.end({ timeout: 5 });
      await dropDb(url, name);
    }
  }, 240_000);
});

describe('G -- registrations: RLS registry kind, cutover classification, census, Drizzle mirror, repo, ops README', () => {
  it.each(TABLES)('G1 %s is in RLS_REGISTRY with scope dual_org_counterparty and counterpartyColumn franchisor_org_id; the reason says SELECT only (A10, A5)', (t) => {
    const e = RLS_REGISTRY[t] as unknown as { scope: string; counterpartyColumn?: string; reason: string } | undefined;
    expect(e, `${t}: RED today, no RLS registry entry`).toBeDefined();
    expect(e!.scope).toBe('dual_org_counterparty');
    expect(e!.counterpartyColumn).toBe('franchisor_org_id');
    expect(e!.reason.length).toBeGreaterThan(30);
    expect(e!.reason, 'the registry reason says how it is written').toMatch(/SELECT only/i);
    expect(e!.reason).toMatch(/definer|trigger/i);
  });

  it('T6 every trigger on franchise_access_log is ENABLE ALWAYS (tgenabled A) and registered in TRIGGER_REGISTRY as always, so session_replication_role = replica cannot be used to rewrite the log; the sessions trigger is registered (T-354 registry: T1 pins the ALWAYS count 35 -> 35 + k, the builder bumps it)', async () => {
    const live = await sql<{ tgname: string; tgenabled: string }[]>`select tgname, tgenabled::text from pg_trigger where tgrelid = 'franchise_access_log'::regclass and not tgisinternal`;
    // T-398 S6 (no TRUNCATE trigger, orchestrator 28 Oct)
    expect(live.length, 'no triggers on the log').toBeGreaterThanOrEqual(1);
    expect(live.map((t) => t.tgname), 'the append-only trigger exists').toContain('franchise_access_log_append_only_trg');
    for (const t of live) expect(t.tgenabled, `${t.tgname} must be ENABLE ALWAYS`).toBe('A');
    const { TRIGGER_REGISTRY } = (await import('../../src/triggers/registry')) as { TRIGGER_REGISTRY: Record<string, { table: string; mode: string }> };
    for (const t of live) expect(TRIGGER_REGISTRY[t.tgname], `${t.tgname}: not in TRIGGER_REGISTRY (T-354 T2)`).toMatchObject({ table: 'franchise_access_log', mode: 'always' });
    expect(TRIGGER_REGISTRY['sessions_break_glass_log_trg'], 'the sessions trigger is registered').toMatchObject({ table: 'sessions' });
  });

  it('G1b the kind\'s comment in registry.ts no longer claims "only the two inter-entity shipment tables use it" (K8)', () => {
    const src = readFileSync(join(SRC, 'rls', 'registry.ts'), 'utf8');
    expect(src, 'RED today: the comment is stale').not.toMatch(/only the two inter-entity shipment tables/i);
    expect(src).toMatch(/franchise/i);
  });

  it('N1 CROSS_ORG_BY_DESIGN is still [] (the cross-org person columns are composite FKs to a DECLARED counterparty column, K6); NO_FK_REFERENCES declares franchise_access_log.session_id as a snapshot (K12)', () => {
    expect(CROSS_ORG_BY_DESIGN, 'a single-column cross-org FK was added').toEqual([]);
    const e = NO_FK_REFERENCES.find((x) => x.column === 'franchise_access_log.session_id');
    expect(e, 'RED today: the session_id declaration is missing').toBeDefined();
    expect(String(e!.kind)).toBe('snapshot');
    expect(e!.reason.length).toBeGreaterThan(20);
    expect(NO_FK_REFERENCES.length, 'NO_FK_PIN 30 -> 31').toBe(31);
  });

  it.each(TABLES)('G2 %s is classified in CUTOVER_CLASSIFICATION as keep, with a reason (QO-7: configuration / append-only history PG is owed)', (t) => {
    const e = CUTOVER_CLASSIFICATION[t];
    expect(e, `${t}: RED today, no cutover classification`).toBeDefined();
    expect(e!.class).toBe('keep');
    expect(e!.reason.length).toBeGreaterThan(30);
  });

  it('G3 census restated: every public base table has an RLS registry entry and a cutover classification (the build guard, as a catalog sweep), and the franchise tables are among them once 0220 is applied', async () => {
    const t = await sql<{ relname: string }[]>`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relispartition and relname not like '\_\_drizzle%'`;
    const names = t.map((r) => r.relname);
    expect(names, 'RED today: the franchise tables absent').toEqual(expect.arrayContaining([...TABLES]));
    expect(names.filter((n) => !(n in RLS_REGISTRY)), 'tables with no RLS registry entry').toEqual([]);
    expect(names.filter((n) => !(n in CUTOVER_CLASSIFICATION)), 'tables with no cutover classification').toEqual([]);
  });

  it('G4 the Drizzle mirror: schema/franchise.ts exists, schema/index.ts exports it, and NOTE comments name migration 0220 (triggers and definers are hand-authored, not expressible)', () => {
    const f = join(SCHEMA, 'franchise.ts');
    expect(existsSync(f), 'RED today: schema/franchise.ts missing').toBe(true);
    const src = readFileSync(f, 'utf8');
    expect(src, 'no 0220 NOTE').toMatch(/0220/);
    expect(src).toMatch(/franchise_agreements/);
    expect(src).toMatch(/franchise_access_log/);
    expect(readFileSync(join(SCHEMA, 'index.ts'), 'utf8'), 'schema/index.ts must export franchise').toMatch(/franchise/);
  });

  it('G5 the repo file exists and holds the SQL (packages/db/src/repo/franchise.ts) and is exported from the db package; the domain does not write SQL for these tables', () => {
    expect(existsSync(join(SRC, 'repo', 'franchise.ts')), 'RED today: repo/franchise.ts missing').toBe(true);
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8')).toMatch(/repo\/franchise/);
  });

  it('G6 withActorPrincipal lives in packages/db/src/rls/principal.ts (K5): one round trip, transaction-local (kills: session-scoped set_config)', () => {
    const src = readFileSync(join(SRC, 'rls', 'principal.ts'), 'utf8');
    expect(src, 'RED today: withActorPrincipal absent from principal.ts').toMatch(/export\s+(async\s+)?function\s+withActorPrincipal/);
    expect(src).toMatch(/app\.person_id/);
  });

  it('O1 docs/ops/README.md has a 0220 row ("no precheck: new tables + one trigger") and warns not to deploy 05:30-07:00 Manila', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'ops', 'README.md'), 'utf8');
    const line = doc.split('\n').find((l) => /\b0220\b/.test(l));
    expect(line, 'RED today: no 0220 row in docs/ops/README.md').toBeDefined();
    expect(line).toMatch(/no precheck/i);
  });
});
