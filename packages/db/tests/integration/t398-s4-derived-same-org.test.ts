/**
 * T-398 S4 / DEF-491 part 3 -- migration 0214: the same-org validator triggers on the derived-scope children.
 * docs/tasks/398-padre-garcia-franchise-org.md S3-S4 section, A1, A2, C2, D3, D4, D7 (the 2026-10-22 amendments win).
 * Real Postgres via TEST_DATABASE_URL, `_test` name guard; the behaviour legs run in a scratch database whose name
 * contains "_test" (built at head, CHECKs stripped, every user trigger disabled EXCEPT the S4 triggers).
 *
 * THE NUMBERS (derived below from the catalog and the RLS registry, never typed as a list):
 *   82 derived-scope FKs (77 derived->org, 3 org->derived, 2 derived->derived) = OPEN_DEF_491 after S3
 *   27 of them ARE their table's own RLS `via` header (rls/registry.ts)  -> guarded by construction, PINNED, no trigger
 *   55 get a BEFORE INSERT OR UPDATE OF trigger calling assert_same_org_via_parent() (D3)
 *   post-S4 OPEN_DEF_491 = 0 (82 - 55 triggered - 27 pinned-by-construction); the 27 live in VIA_HEADER_GUARDED.
 *
 * ASSUMPTIONS the builder must meet (spec silent -> flagged in the tester report):
 *   - the pinned list is exported from packages/db/src/rls/same-org-fk-exemptions.ts as `VIA_HEADER_GUARDED`
 *     (strings `child.col->parent`, or objects with an `fk` of that shape);
 *   - the function is public.assert_same_org_via_parent(); TG_ARGV = (child FK column, header table, header FK column,
 *     target table) -- the S1 census already reads tgargs that way. For the 3 org->derived FKs (the child carries its
 *     own org_id) there is no header; only tgargs[0] (column) and tgargs[3] (target table) are asserted for those;
 *   - a refusal is SQLSTATE 23503 and its message names DEF-491.
 *
 * MUTANTS (each names the leg that must go red):
 *   - one trigger dropped                                  -> D1 "has exactly one trigger" (names the FK) and its D2 legs
 *   - UPDATE OF <col> turned into plain UPDATE             -> D1 tgattr leg, and D5 "unrelated column does not fire"
 *   - trigger not on INSERT / not BEFORE / not row-level   -> D1 shape leg
 *   - a via FK silently added to / removed from the pinned list -> D1 pinned-list legs (count, sha, equals the registry set)
 *   - a trigger built on a via FK (double guard)           -> D1 "via FK carries no trigger"
 *   - function compares the header's org to the child's own (nonexistent) org_id (always NULL) -> D2 same-org controls red
 *   - NOT FOUND -> RETURN NEW (fail open, D4)              -> D4 "invisible/missing parent RAISES" legs
 *   - NOT FOUND -> RETURN true / compare against NULL      -> same legs
 *   - function SECURITY DEFINER, or EXECUTE left on PUBLIC -> D6
 *   - registry entry missing / wrong kind or mode          -> D7
 *   - OPEN_DEF_491 not emptied, or an unlisted/unguarded derived FK -> D8
 *   - 0214 without lock_timeout first / budget / pre-flight -> L1
 */
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as exemptions from '../../src/rls/same-org-fk-exemptions';
import { APP_ROLE, RLS_REGISTRY } from '../../src/rls/registry';
import { TRIGGER_REGISTRY } from '../../src/triggers/registry';
import { buildScratchAtHead, dropDb, insertOrg, insertSynthResolved, MIGRATIONS_FOLDER } from './t398-s3-fixture';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const FN = 'assert_same_org_via_parent';
const sha = (lines: readonly string[]) => createHash('sha256').update([...lines].sort().join('\n')).digest('hex');

// =================================================================================================
// PINS (by value). 27 via-header FKs, the post-S1/S3 open set, the pre-S4 trigger-registry size.
// =================================================================================================

const VIA_PIN = { count: 27, sha256: '7bd75be8bb9c1b360306e18a96af8ebca287ebaf21ab722ee6710c7759c7a56a' } as const;
/** sha of the 82 keys OPEN_DEF_491 holds after S3 (the S1 census file pins the same value): 55 triggered + 27 via. */
const PRE_S4_OPEN = { count: 82, sha256: '2df148cd2e5e0757ca384cb3c9cc5522cf138f67179f5c30787ba40f584782cf' } as const;
const TRIGGERED_COUNT = 55;
/** TRIGGER_REGISTRY had 100 entries (69 origin, 57 validator) at 0213; S4 adds exactly 55 validator/origin entries. */
const REGISTRY_BEFORE_S4 = 100;
/** Triggers classified AFTER S4 by later tasks (each lane bumps this): T-455 S1 (0215) adds 4 lobby validators; T-479 adds lobby_entries_party_size_cap. */
// T-475 S3 (0217): +2 (supplier_invoices self-verify capability + immutability triggers). 5 -> 7.
// T-398 S5b (0218): +3 (inter_entity_shipments link check + two receipt guards). 7 -> 10.
// T-398 S5 audit (0218): +4 (two freeze triggers + two deferred sum-check constraint triggers). 10 -> 14.
// T-398 S5d QI-2 (0218): +2 (supplier_invoices_system_made_guard_trg, supplier_invoice_lines_system_made_guard_trg). 14 -> 16.
// T-398 S6 (0220): +3 (franchise_access_log_append_only_trg, franchise_agreements_app_guard_trg, sessions_break_glass_log_trg). 16 -> 19.
// T-498 S1 (0221): +1 (pay_rates_append_only history guard). 19 -> 20.
const REGISTRY_ADDED_AFTER_S4 = 20;

function pinMismatch(keys: readonly string[], pin: { count: number; sha256: string }): string | null {
  if (keys.length !== pin.count) return `count ${keys.length} != pinned ${pin.count}`;
  if (sha(keys) !== pin.sha256) return 'sha256 differs from the pin (same count, different members)';
  return null;
}

// =================================================================================================
// Scope, read from the catalog and the RLS registry
// =================================================================================================

interface FkRow {
  child: string;
  col: string;
  parent: string;
  childOrg: boolean;
  parentOrg: boolean;
  nullable: boolean;
}
const keyOf = (r: { child: string; col: string; parent: string }) => `${r.child}.${r.col}->${r.parent}`;
const ORG_LESS = new Set(exemptions.ORG_LESS_TABLES);

async function readDerivedFks(q: postgres.Sql): Promise<FkRow[]> {
  const rows = await q<{ child: string; col: string; parent: string; child_org: boolean; parent_org: boolean; nullable: boolean }[]>`
    select cr.relname as child, a.attname as col, pr.relname as parent,
      exists(select 1 from pg_attribute x where x.attrelid = con.conrelid and x.attname = 'org_id' and not x.attisdropped) as child_org,
      exists(select 1 from pg_attribute x where x.attrelid = con.confrelid and x.attname = 'org_id' and not x.attisdropped) as parent_org,
      not a.attnotnull as nullable
    from pg_constraint con
    join pg_class cr on cr.oid = con.conrelid
    join pg_class pr on pr.oid = con.confrelid
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and con.connamespace = 'public'::regnamespace and cardinality(con.conkey) = 1
      and pr.relname <> 'organizations'
    order by 1, 2, 3`;
  return rows
    .filter((r) => !(ORG_LESS.has(r.child) && ORG_LESS.has(r.parent)))
    .map((r) => ({ child: r.child, col: r.col, parent: r.parent, childOrg: r.child_org, parentOrg: r.parent_org, nullable: r.nullable }))
    .filter((r) => !(r.childOrg && r.parentOrg));
}

/** table -> its RLS via header, parsed from the registry's `via` predicate (the policy text the live database enforces). */
interface Via {
  table: string;
  col: string;
  parent: string;
}
const VIA_RE = /from (\w+) \w+ where \w+\.id = (?:\w+\.)?(\w+) and/;
const viaByTable = new Map<string, Via>();
for (const [table, e] of Object.entries(RLS_REGISTRY)) {
  if (e.scope !== 'derived' || !e.via) continue;
  const m = VIA_RE.exec(e.via);
  if (m) viaByTable.set(table, { table, col: m[2]!, parent: m[1]! });
}
const viaKeys = [...viaByTable.values()].map((v) => `${v.table}.${v.col}->${v.parent}`);

const derivedFks = await readDerivedFks(sql);
const viaSet = new Set(viaKeys);
const triggered = derivedFks.filter((r) => !viaSet.has(keyOf(r)));
const label = (r: FkRow) => keyOf(r);

function normaliseList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((e) => (typeof e === 'string' ? e : (e as { fk: string }).fk));
}
const viaPinned = normaliseList((exemptions as Record<string, unknown>).VIA_HEADER_GUARDED);

// =================================================================================================
// Trigger reader
// =================================================================================================

interface Trg {
  tbl: string;
  name: string;
  enabled: string;
  type: number;
  args: string[];
  updCols: string[];
}
async function readTriggers(q: postgres.Sql): Promise<Trg[]> {
  const rows = await q<{ tbl: string; name: string; en: string; tgtype: number; args: string; upd: string[] | null }[]>`
    select c.relname as tbl, t.tgname as name, t.tgenabled::text as en, t.tgtype::int as tgtype, encode(t.tgargs, 'hex') as args,
      (select array_agg(a.attname::text order by a.attnum) from pg_attribute a where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)) as upd
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and p.proname = ${FN} and p.pronamespace = 'public'::regnamespace
    order by 1, 2`;
  return rows.map((r) => ({
    tbl: r.tbl,
    name: r.name,
    enabled: r.en,
    type: r.tgtype,
    args: Buffer.from(r.args, 'hex').toString('utf8').split('\0'),
    updCols: r.upd ?? [],
  }));
}
const triggers = await readTriggers(sql);
const triggerFor = (r: { child: string; col: string }) => triggers.filter((t) => t.tbl === r.child && t.args[0] === r.col);

// =================================================================================================
// D1 -- every guarded derived FK has its trigger; the 27 via-header FKs are pinned and have none
// =================================================================================================

describe('D1 -- 55 triggers, 27 pinned-by-construction, nothing else', () => {
  it('sanity: the catalog holds 82 derived-scope FKs; 27 are their table\'s RLS via header, 55 are not; the 82 equal the pre-S4 open set', () => {
    expect(derivedFks.length).toBe(82);
    expect(viaKeys.length, 'via headers parsed from rls/registry.ts').toBe(27);
    expect(viaKeys.filter((k) => !derivedFks.some((r) => keyOf(r) === k)), 'a via header that is not a catalog FK').toEqual([]);
    expect(triggered.length).toBe(TRIGGERED_COUNT);
    expect(pinMismatch(derivedFks.map(keyOf), PRE_S4_OPEN)).toBeNull();
    expect(pinMismatch(viaKeys, VIA_PIN)).toBeNull();
  });

  it('RED until 0214: the function exists and exactly 55 triggers call it (one per guarded FK)', () => {
    expect(triggers.length, `triggers calling ${FN}(): ${triggers.length}`).toBe(TRIGGERED_COUNT);
  });

  it.each(triggered.map((r) => [label(r), r] as const))('RED until 0214: %s has exactly one trigger naming it (BEFORE ROW INSERT OR UPDATE OF, enabled origin)', (_n, r) => {
    const t = triggerFor(r);
    expect(t.length, `triggers whose tgargs name ${label(r)} (mutant: one trigger dropped)`).toBe(1);
    const x = t[0]!;
    expect(x.args[3], 'TG_ARGV[3] is the target table').toBe(r.parent);
    // tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE
    expect(x.type & 1, 'row-level').toBe(1);
    expect(x.type & 2, 'BEFORE').toBe(2);
    expect(x.type & 4, 'fires on INSERT').toBe(4);
    expect(x.type & 16, 'fires on UPDATE').toBe(16);
    expect(x.type & (8 | 32), 'no DELETE / TRUNCATE').toBe(0);
    expect(x.enabled, "tgenabled 'O' (origin: a validator, bible T-354)").toBe('O');
    expect(x.updCols.length, 'mutant: UPDATE OF <col> turned into plain UPDATE (tgattr empty)').toBeGreaterThan(0);
    expect(x.updCols, 'UPDATE OF names the FK column').toContain(r.col);
    const via = viaByTable.get(r.child);
    if (via) {
      expect(x.args[1], 'TG_ARGV[1] is the header table').toBe(via.parent);
      expect(x.args[2], 'TG_ARGV[2] is the header FK column').toBe(via.col);
      expect(x.updCols, 'A2: the trigger also fires when the child\'s header FK changes (D7 of the old numbering)').toContain(via.col);
    }
  });

  it('no via-header FK carries a trigger of its own (it is guarded by construction: the table\'s RLS WITH CHECK)', () => {
    const doubled = viaKeys.filter((k) => {
      const v = viaByTable.get(k.split('.')[0]!)!;
      return triggerFor({ child: v.table, col: v.col }).length > 0;
    });
    expect(doubled, 'mutant: a trigger built on a via FK').toEqual([]);
  });

  it('the pinned list VIA_HEADER_GUARDED exists, equals the 27 via headers read from rls/registry.ts, and matches its pin by value', () => {
    expect(viaPinned.length, 'RED until the builder adds VIA_HEADER_GUARDED to same-org-fk-exemptions.ts').toBe(27);
    expect(pinMismatch(viaPinned, VIA_PIN), 'mutant: a via FK silently added / removed / swapped').toBeNull();
    expect([...viaPinned].sort()).toEqual([...viaKeys].sort());
    expect(new Set(viaPinned).size).toBe(viaPinned.length);
  });

  it('the pin detector itself: a widened list (one non-via FK added) and a swapped list are both reported', () => {
    expect(pinMismatch([...viaKeys, 'count_lines.item_id->items'], VIA_PIN)).toMatch(/count/);
    expect(pinMismatch([...viaKeys.slice(1), 'count_lines.item_id->items'], VIA_PIN)).toMatch(/sha256/);
  });

  it('the live policy of every via table still names its header (the construction the pin relies on)', async () => {
    const bad: string[] = [];
    for (const v of viaByTable.values()) {
      const rows = await sql<{ q: string | null; w: string | null }[]>`
        select qual as q, with_check as w from pg_policies where schemaname = 'public' and tablename = ${v.table}`;
      const text = rows.map((r) => `${r.q ?? ''} ${r.w ?? ''}`).join(' ');
      if (!text.includes(v.parent) || !text.includes(v.col)) bad.push(`${v.table}: policy does not mention ${v.parent}/${v.col}`);
    }
    expect(bad).toEqual([]);
  });
});

// =================================================================================================
// D6 -- the function is SECURITY INVOKER with EXECUTE revoked from PUBLIC
// =================================================================================================

describe('D6 -- function properties', () => {
  it('RED until 0214: assert_same_org_via_parent exists, is SECURITY INVOKER, and EXECUTE is not granted to PUBLIC', async () => {
    const rows = await sql<{ secdef: boolean; acl: string | null; public_exec: boolean }[]>`
      select p.prosecdef as secdef, p.proacl::text as acl,
        coalesce((select bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE') from aclexplode(p.proacl) a), true) as public_exec
      from pg_proc p where p.proname = ${FN} and p.pronamespace = 'public'::regnamespace`;
    expect(rows.length, 'the function does not exist yet (0214)').toBe(1);
    expect(rows[0]!.secdef, 'mutant: SECURITY DEFINER').toBe(false);
    expect(rows[0]!.acl, 'proacl NULL = the default, PUBLIC may execute').not.toBeNull();
    expect(rows[0]!.public_exec, 'mutant: EXECUTE left on PUBLIC').toBe(false);
  });
  it('RED until 0214: the trigger is a trigger function (returns trigger) taking no SQL-level arguments', async () => {
    const rows = await sql<{ ret: string; nargs: number }[]>`
      select p.prorettype::regtype::text as ret, p.pronargs::int as nargs from pg_proc p
      where p.proname = ${FN} and p.pronamespace = 'public'::regnamespace`;
    expect(rows[0]?.ret).toBe('trigger');
    expect(rows[0]?.nargs).toBe(0);
  });
});

// =================================================================================================
// D7 -- triggers registry: 55 validator/origin entries; live tgenabled agrees (t354 stays consistent)
// =================================================================================================

describe('D7 -- packages/db/src/triggers/registry.ts', () => {
  it('RED until 0214: the registry grew by exactly 55 entries, all kind validator, mode origin', () => {
    const n = Object.keys(TRIGGER_REGISTRY).length;
    expect(n, `registry size ${n}; 100 before S4`).toBe(REGISTRY_BEFORE_S4 + TRIGGERED_COUNT + REGISTRY_ADDED_AFTER_S4);
  });
  it('every live assert_same_org_via_parent trigger is classified: validator, origin, on its own table, live tgenabled = O', () => {
    const bad: string[] = [];
    for (const t of triggers) {
      const e = TRIGGER_REGISTRY[t.name];
      if (!e) bad.push(`${t.name}: not in TRIGGER_REGISTRY`);
      else {
        if (e.kind !== 'validator') bad.push(`${t.name}: kind ${e.kind}`);
        if (e.mode !== 'origin') bad.push(`${t.name}: mode ${e.mode}`);
        if (e.table !== t.tbl) bad.push(`${t.name}: registry table ${e.table}, live ${t.tbl}`);
      }
      if (t.enabled !== 'O') bad.push(`${t.name}: tgenabled ${t.enabled}`);
    }
    expect(triggers.length, 'no live triggers yet (0214)').toBe(TRIGGERED_COUNT);
    expect(bad).toEqual([]);
  });
  it('the 55 new registry entries are exactly the 55 live triggers (no stale entry, none missing)', () => {
    const live = new Set(triggers.map((t) => t.name));
    const mentioning = Object.entries(TRIGGER_REGISTRY).filter(([, e]) => /DEF-491|same.org/i.test(e.reason)).map(([k]) => k);
    expect(mentioning.length, 'registry entries whose reason cites DEF-491 / same-org').toBe(TRIGGERED_COUNT);
    expect(mentioning.filter((k) => !live.has(k)), 'registry entries with no live trigger').toEqual([]);
  });
});

// =================================================================================================
// D8 -- the census: after S4 nothing is open
// =================================================================================================

describe('D8 -- census after S4', () => {
  it('RED until the builder empties it: OPEN_DEF_491 is [] (82 - 55 triggered - 27 pinned-by-construction = 0)', () => {
    expect(exemptions.OPEN_DEF_491.length, `OPEN_DEF_491 still holds ${exemptions.OPEN_DEF_491.length} entries`).toBe(0);
  });
  it('RED until 0214: every derived-scope FK is guarded by a trigger or pinned by construction; none is neither', () => {
    const pinned = new Set(viaPinned);
    const unguarded = derivedFks.filter((r) => triggerFor(r).length === 0 && !pinned.has(keyOf(r))).map(keyOf);
    expect(unguarded.length, `${unguarded.length} unguarded derived FKs; first: ${unguarded.slice(0, 6).join(', ')}`).toBe(0);
  });
  it('the triggered set and the pinned set are disjoint and together equal the pre-S4 82', () => {
    const t = triggered.map(keyOf);
    expect(t.filter((k) => viaSet.has(k))).toEqual([]);
    expect(pinMismatch([...t, ...viaKeys], PRE_S4_OPEN)).toBeNull();
  });
});

// =================================================================================================
// L1 (D7) -- migration 0214's own text
// =================================================================================================

describe('L1 (D7) -- the 0214 migration text', () => {
  const journal = () => (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] }).entries;
  const text = (): string => {
    const e = journal().find((x) => x.tag.startsWith('0214_'));
    expect(e, 'no journal entry numbered 0214: the S4 migration does not exist yet').toBeDefined();
    const f = join(MIGRATIONS_FOLDER, `${e!.tag}.sql`);
    expect(existsSync(f)).toBe(true);
    return readFileSync(f, 'utf8');
  };
  const statements = (t: string) => t.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '');

  it('RED until the migration exists: exactly one 0214 entry, LF-only, no BOM', () => {
    expect(journal().filter((e) => e.tag.startsWith('0214_')).length).toBe(1);
    const t = text();
    expect(t.includes('\r'), 'CRLF').toBe(false);
    expect(t.charCodeAt(0), 'BOM').not.toBe(0xfeff);
  });
  it("RED until the migration exists: the first statement is SET LOCAL lock_timeout = '5s' and the text names DEF-491", () => {
    const t = text();
    expect(t).toMatch(/DEF-491/);
    expect(statements(t)[0] ?? '', 'mutant: lock_timeout missing or not first').toMatch(/^SET LOCAL lock_timeout\s*=\s*'5s'/i);
  });
  it('RED until the migration exists: the header states the budget (a measured time, the lock mode) and the counts 55 / 27', () => {
    const header = text().split('\n').filter((l) => l.trim().startsWith('--')).join('\n');
    expect(header, 'mutant: no budget').toMatch(/budget/i);
    expect(header).toMatch(/\d+(\.\d+)?\s*(s|ms|sec|seconds)\b/i);
    expect(header, 'CREATE TRIGGER takes SHARE ROW EXCLUSIVE').toMatch(/SHARE ROW EXCLUSIVE/i);
    expect(header).toMatch(/\b55\b/);
    expect(header).toMatch(/\b27\b/);
  });
  it('RED until the migration exists: a fail-closed pre-flight (DO block that RAISEs naming DEF-491) precedes the first CREATE TRIGGER; the function is revoked from PUBLIC', () => {
    const t = text();
    const lock = t.search(/SET LOCAL lock_timeout/i);
    const doBlock = t.search(/\bDO \$\$/);
    const raise = t.search(/RAISE EXCEPTION/i);
    const firstTrigger = t.search(/CREATE TRIGGER|EXECUTE FUNCTION assert_same_org_via_parent|EXECUTE PROCEDURE assert_same_org_via_parent/i);
    expect(doBlock, 'a DO $$ pre-flight block').toBeGreaterThan(lock);
    expect(raise).toBeGreaterThan(doBlock);
    expect(firstTrigger, 'the pre-flight precedes every CREATE TRIGGER').toBeGreaterThan(raise);
    expect(t.slice(doBlock, firstTrigger)).toMatch(/DEF-491/);
    expect(t, 'D6: EXECUTE revoked from PUBLIC').toMatch(/REVOKE\s+(ALL|EXECUTE)[^;]*ON\s+FUNCTION\s+[^;]*assert_same_org_via_parent[^;]*FROM\s+PUBLIC/i);
    expect(t, 'D4: the function must not fail open on NOT FOUND').not.toMatch(/NOT FOUND[^;]*RETURN\s+(NEW|true)/i);
  });
});

// =================================================================================================
// D2-D5 -- behaviour, in a scratch database, as shareat_app (and as the owner)
// =================================================================================================

type PgErr = Error & { code?: string };
class Rollback extends Error {}
interface LegResult {
  err?: PgErr;
  rows: number;
  calls?: number;
}

const SCRATCH = `shareat_t398s4_test_${Date.now()}`;
let ssql: postgres.Sql;
beforeAll(async () => {
  ssql = await buildScratchAtHead(url, SCRATCH);
  // buildScratchAtHead disables every user trigger; the S4 triggers are the thing under test, so switch them back on (origin).
  const rows = await ssql<{ tbl: string; name: string }[]>`
    select c.relname as tbl, t.tgname as name from pg_trigger t
    join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and p.proname = ${FN}`;
  for (const r of rows) await ssql.unsafe(`alter table "${r.tbl}" enable trigger "${r.name}"`);
  await ssql.unsafe(`grant insert, select, delete on all tables in schema public to ${APP_ROLE}`);
}, 300_000);
afterAll(async () => {
  await ssql?.end({ timeout: 5 });
  await dropDb(url, SCRATCH);
}, 120_000);

interface Setup {
  a: string;
  b: string;
  ta: string;
  ta2: string;
  tb: string;
  childId: string;
  /** the child's row as it stands (generated and identity columns removed), for INSERT legs */
  template: Record<string, unknown>;
  insertCols: string[];
  header?: { col: string; hb: string };
  unrelatedCol?: string;
}

const memo = new Map<string, Promise<Setup>>();
function setupFor(r: FkRow): Promise<Setup> {
  const k = keyOf(r);
  let p = memo.get(k);
  if (!p) {
    p = buildSetup(r);
    memo.set(k, p);
  }
  return p;
}

async function buildSetup(r: FkRow): Promise<Setup> {
  const via = viaByTable.get(r.child);
  return ssql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    const a = await insertOrg(tx, 'a');
    const b = await insertOrg(tx, 'b');
    const ta = await insertSynthResolved(tx, r.parent, a);
    const ta2 = await insertSynthResolved(tx, r.parent, a);
    const tb = await insertSynthResolved(tx, r.parent, b);
    const childId = await insertSynthResolved(tx, r.child, a, { [r.col]: `'${ta}'::uuid` });
    const cols = await tx<{ name: string; gen: string; ident: string }[]>`
      select attname as name, attgenerated as gen, attidentity as ident from pg_attribute
      where attrelid = ${r.child}::regclass and attnum > 0 and not attisdropped order by attnum`;
    const insertCols = cols.filter((c) => c.gen === '' && c.ident === '').map((c) => c.name);
    const [row] = await tx.unsafe<{ j: Record<string, unknown> }[]>(`select to_jsonb(c) as j from "${r.child}" c where id = $1`, [childId]);
    const template = row!.j;
    const fkCols = await tx<{ col: string }[]>`
      select a.attname as col from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
      where con.contype = 'f' and con.conrelid = ${r.child}::regclass`;
    const skip = new Set([...fkCols.map((x) => x.col), 'id', 'org_id']);
    const unrelated = cols.find((c) => !skip.has(c.name) && c.gen === '' && c.ident === '' && template[c.name] !== undefined);
    const setup: Setup = { a, b, ta, ta2, tb, childId, template, insertCols };
    if (unrelated) setup.unrelatedCol = unrelated.name;
    if (via) {
      const hb = await insertSynthResolved(tx, via.parent, b);
      setup.header = { col: via.col, hb };
    }
    return setup;
  });
}

type Body = (tx: postgres.TransactionSql, s: Setup) => Promise<unknown>;

/** Run `body` in a transaction that is ALWAYS rolled back; as shareat_app (org A) or as the owner. A DB error is captured, not thrown. */
/** Cumulative calls of the via-check function seen by this transaction's stats (pg_stat_xact_user_functions). */
async function funcCalls(tx: postgres.TransactionSql): Promise<number> {
  const [c] = await tx<{ n: number }[]>`select coalesce(sum(calls), 0)::int as n from pg_stat_xact_user_functions where funcname = ${FN}`;
  return c!.n;
}

async function leg(r: FkRow, asApp: boolean, body: Body, withCalls = false): Promise<LegResult> {
  const s = await setupFor(r);
  const out: LegResult = { rows: -1 };
  try {
    await ssql.begin(async (tx) => {
      // The pooled connection can carry counts from earlier legs, so the call count is the DELTA over this leg.
      let callsBefore = 0;
      if (withCalls) {
        await tx`set local track_functions = 'all'`;
        callsBefore = await funcCalls(tx);
      }
      if (asApp) {
        await tx.unsafe(`set local role ${APP_ROLE}`);
        await tx`select set_config('app.org_id', ${s.a}, true)`;
      }
      try {
        await tx.savepoint(async (sp) => {
          const res = (await body(sp as unknown as postgres.TransactionSql, s)) as { count?: number } | undefined;
          out.rows = res?.count ?? -1;
        });
      } catch (err) {
        out.err = err as PgErr;
      }
      if (withCalls) {
        await tx.unsafe('reset role');
        out.calls = (await funcCalls(tx)) - callsBefore;
      }
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

const updateCol = (r: FkRow, col: string, value: string | null): Body => (tx, s) =>
  tx.unsafe(`update "${r.child}" set "${col}" = $1 where id = $2`, [value, s.childId]);

/** Delete the persistent child (as the connection's current role is still the owner when called first), then insert its template with `col` = value. */
const insertChild = (r: FkRow, value: string | null, asApp: boolean): Body => async (tx, s) => {
  // the leg's role was already switched to the app role by `leg`; deleting the template row needs the owner, so do it via reset/set
  if (asApp) await tx.unsafe('reset role');
  await tx.unsafe(`delete from "${r.child}" where id = $1`, [s.childId]);
  if (asApp) await tx.unsafe(`set local role ${APP_ROLE}`);
  const row: Record<string, unknown> = { ...s.template, [r.col]: value };
  const cols = s.insertCols.map((c) => `"${c}"`).join(', ');
  return tx.unsafe(`insert into "${r.child}" (${cols}) select ${cols} from jsonb_populate_record(null::"${r.child}", $1::jsonb)`, [JSON.stringify(row)]);
};

const refused = (r: LegResult, why: string) => {
  expect(r.err, `${why}: no error (rows touched ${r.rows}) - the cross-org reference was ACCEPTED`).toBeDefined();
  expect(r.err?.code, r.err?.message).toBe('23503');
  expect(r.err?.message, 'the refusal must come from the trigger and name DEF-491 (not the bare foreign-key message)').toMatch(/DEF-491/);
};

const cases = triggered.map((r) => [label(r), r] as const);

describe('D2 -- as shareat_app (org A): a cross-org target is refused on INSERT and on UPDATE of the FK column', () => {
  it.each(cases)('INSERT %s with a target in org B', async (_n, r) => {
    refused(await leg(r, true, insertChild(r, (await setupFor(r)).tb, true)), 'INSERT');
  });
  it.each(cases)('UPDATE %s to a target in org B', async (_n, r) => {
    const s = await setupFor(r);
    refused(await leg(r, true, updateCol(r, r.col, s.tb)), 'UPDATE');
  });
});

describe('D3 -- as the table owner (org B is VISIBLE, different org): still refused, naming DEF-491', () => {
  it.each(cases)('UPDATE %s to a target in org B as owner', async (_n, r) => {
    const s = await setupFor(r);
    refused(await leg(r, false, updateCol(r, r.col, s.tb)), 'owner UPDATE');
  });
});

describe('D4 -- fail closed: a target the caller cannot see, or that does not exist, RAISES (never RETURN NEW / true)', () => {
  it.each(cases)('UPDATE %s to a random (missing) uuid as shareat_app', async (_n, r) => {
    refused(await leg(r, true, updateCol(r, r.col, crypto.randomUUID())), 'missing target');
  });
  it.each(cases)('INSERT %s with a random (missing) uuid as shareat_app', async (_n, r) => {
    refused(await leg(r, true, insertChild(r, crypto.randomUUID(), true)), 'missing target on INSERT');
  });
  it.each(cases.filter(([, r]) => viaByTable.has(r.child)))('UPDATE of the header FK of %s to a header in org B (A2 / old D7) as shareat_app is refused (by RLS WITH CHECK or by the trigger, whichever fires first)', async (_n, r) => {
    const s = await setupFor(r);
    const h = s.header!;
    const res = await leg(r, true, updateCol(r, h.col, h.hb));
    expect(res.err, `header moved to org B was ACCEPTED (rows ${res.rows})`).toBeDefined();
    expect(['23503', '42501'], res.err?.message).toContain(res.err?.code);
  });
  it.each(cases.filter(([, r]) => viaByTable.has(r.child)))('UPDATE of the header FK of %s to a header in org B as owner (visible)', async (_n, r) => {
    const s = await setupFor(r);
    const h = s.header!;
    refused(await leg(r, false, updateCol(r, h.col, h.hb)), 'header moved to org B (owner)');
  });
});

describe('D5 -- same-org controls pass (they prove the fixture, and that the guard is the org comparison)', () => {
  it.each(cases)('UPDATE %s to a second target in the same org as shareat_app', async (_n, r) => {
    const s = await setupFor(r);
    const res = await leg(r, true, updateCol(r, r.col, s.ta2));
    expect(res.err, `same-org update must succeed: ${res.err?.message} (mutant: function compares to the child's own nonexistent org_id)`).toBeUndefined();
    expect(res.rows, 'exactly the one fixture row (0 = invisible to RLS)').toBe(1);
  });
  it.each(cases)('INSERT %s with a target in the same org as shareat_app', async (_n, r) => {
    const s = await setupFor(r);
    const res = await leg(r, true, insertChild(r, s.ta, true));
    expect(res.err, `same-org insert must succeed: ${res.err?.message}`).toBeUndefined();
    expect(res.rows).toBe(1);
  });
  it.each(cases.filter(([, r]) => r.nullable))('NULL passes: UPDATE %s to NULL and INSERT with NULL as shareat_app', async (_n, r) => {
    const u = await leg(r, true, updateCol(r, r.col, null));
    expect(u.err, `NULL on a nullable FK must pass: ${u.err?.message}`).toBeUndefined();
    const i = await leg(r, true, insertChild(r, null, true));
    expect(i.err, `INSERT with a NULL FK must pass: ${i.err?.message}`).toBeUndefined();
  });
  it('the fixture exercised every guarded FK: 55 legs, and the nullable ones are the ones the catalog says', () => {
    expect(cases.length).toBe(TRIGGERED_COUNT);
    expect(cases.filter(([, r]) => r.nullable).length, 'nullable guarded FKs (catalog)').toBeGreaterThan(0);
  });
});

describe('D5b -- UPDATE OF <col>: updating an unrelated column does not run the function (pg_stat_xact_user_functions)', () => {
  const withUnrelated = cases;
  it.each(withUnrelated)('%s', async (_n, r) => {
    const s = await setupFor(r);
    if (!s.unrelatedCol) return; // a table made only of keys has no unrelated column to touch
    const c = s.unrelatedCol;
    const quiet = await leg(r, true, (tx) => tx.unsafe(`update "${r.child}" set "${c}" = "${c}" where id = $1`, [s.childId]), true);
    expect(quiet.err, `unrelated update failed: ${quiet.err?.message}`).toBeUndefined();
    expect(quiet.calls, 'mutant: plain UPDATE instead of UPDATE OF - the function ran for an unrelated column').toBe(0);
    const loud = await leg(r, true, updateCol(r, r.col, s.ta2), true);
    expect(loud.calls, 'positive control: updating the FK column DOES run the function (proves the counter)').toBeGreaterThanOrEqual(1);
  });
});
