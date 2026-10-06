/**
 * T-378 S2 - migration 0186: the item-unit history guard and the request flag columns.
 * `docs/tasks/378-item-unit-editable.md` R2, R7, REV-2..REV-9; tests B1-B8, B5b.
 *
 * TESTER, not BUILDER. Raw SQL as APP_ROLE under an org principal, so the DATABASE is what is proven. Every refusal
 * asserts the TARGET (SQLSTATE 23514 and the exact constraint name), never just "it threw": postgres.js reports a
 * transaction's FIRST error, which can hide a 25P02, so a bare `rejects.toThrow()` would pass on the wrong failure.
 * Every refusal runs in a transaction that is ALWAYS rolled back, and the unit is re-read afterwards on a separate
 * connection, so a write that wrongly succeeds on HEAD cannot leak into the next leg.
 *
 * ## Red on HEAD, and why (0186 does not exist yet)
 *  - B2 legs, B4-control, B7: the UPDATE SUCCEEDS (no trigger). Valid red: "expected the write to be refused".
 *  - B3, B5, B5b, B8: `items_unit_history_exists` / the migration file does not exist. Red ONLY for "function / file
 *    does not exist", which the spec names as a valid red; each carries its own killing mutant for after the build.
 *  - B6: the three columns do not exist (42703). Same kind of red.
 *  - GREEN on HEAD (the guards a mutant must turn red): B1 (control), B4 (allowed writes).
 *
 * ## Contracts the BUILDER must meet that the spec leaves open (named here so they are not a surprise)
 *  - B5b needs the two MARKER comments the spec does not name. This test reads the lines of the migration between
 *    `-- P0186b-pre:begin` and `-- P0186b-pre:end` (each on its own line), strips a leading `-- ` from each, drops a
 *    trailing `;`, and runs the result as ONE select that returns columns `name` and `has_history`. It must NOT call
 *    `items_unit_history_exists` (it is the pre-migration form: the function body's EXISTS list, pasted).
 *  - B3 matches each leg as `FROM <table> [alias] WHERE [alias.]<col> = p_item` (REV-6), so a leg may not be written
 *    as `WHERE org_id = x AND item_id = p_item`, nor as `p_item = col`. The outgoing cost-basis leg (REV-2) is matched
 *    as `FROM items [alias] WHERE id = p_item AND cost_basis_item_id IS NOT NULL` (either order of the two conditions).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

import { APP_ROLE } from '../../src/rls/registry';

const sql = postgres(url, { max: 8 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const FIXED = 'items_base_unit_fixed';

type Tx = postgres.TransactionSql;
type PgErr = { code?: string; constraint_name?: string; column_name?: string; message?: string } | null;
class Rollback extends Error {}

/** Runs `fn` as APP_ROLE under the org in a transaction that is ALWAYS rolled back; returns the error `fn` raised. */
async function attempt(orgId: string, fn: (t: Tx) => Promise<unknown>): Promise<PgErr> {
  let caught: unknown = null;
  try {
    await sql.begin(async (t) => {
      await t.unsafe(`set local role ${APP_ROLE}`);
      await t`select set_config('app.principal_kind', 'staff', true)`;
      await t`select set_config('app.org_id', ${orgId}, true)`;
      try {
        await fn(t);
      } catch (e) {
        caught = e;
      }
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return caught as PgErr;
}

/** A read as APP_ROLE under the org (committed tx, read-only use). `org: null` leaves app.org_id UNSET. */
async function asApp<T>(orgId: string | null, fn: (t: Tx) => Promise<T>): Promise<T> {
  return (await sql.begin(async (t) => {
    await t.unsafe(`set local role ${APP_ROLE}`);
    await t`select set_config('app.principal_kind', 'staff', true)`;
    if (orgId !== null) await t`select set_config('app.org_id', ${orgId}, true)`;
    return (await fn(t)) as never;
  })) as T;
}

function expectRefused(err: PgErr, what: string) {
  expect(err, `${what}: expected the UPDATE to be refused by ${FIXED}, but it SUCCEEDED`).not.toBeNull();
  expect({ what, code: err!.code, constraint: err!.constraint_name }).toEqual({ what, code: '23514', constraint: FIXED });
}

async function unitOf(itemId: string): Promise<string> {
  const [r] = await sql<{ base_unit: string }[]>`select base_unit from items where id = ${itemId}`;
  return r!.base_unit;
}

// ---- fixtures (owner connection; committed; unique org per file run) -----------------------------------------------
const code = uid('t378s2');
let orgId: string, storeId: string, personId: string, locationId: string, supplierId: string;

async function mkItem(hint: string, o: { kind?: string; unit?: string; parentSlab?: string; costBasis?: string } = {}) {
  const name = uid(`${hint}`);
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by, parent_slab_item_id, cost_basis_item_id)
    values (${orgId}, ${name}, ${name}, ${o.kind ?? 'raw_material'}, ${o.unit ?? 'kg'}, ${personId},
            ${o.parentSlab ?? null}, ${o.costBasis ?? null})
    returning id`;
  return { id: r!.id, name };
}

let setup: Promise<void> | null = null;
function ensureOrg(): Promise<void> {
  setup ??= (async () => {
    const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    orgId = org!.id;
    const [st] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('ST')}, 'Store', 'multi_room') returning id`;
    storeId = st!.id;
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Actor') returning id`;
    personId = p!.id;
    const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
    const [loc] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgId}, ${storeId}, 'MAIN', 'Main', ${lt!.id}, ${personId}) returning id`;
    locationId = loc!.id;
    const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('sup')}, ${personId}) returning id`;
    supplierId = sup!.id;
  })();
  return setup;
}

async function addMovement(itemId: string, run: Tx | postgres.Sql = sql) {
  await run`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${orgId}, ${storeId}, ${locationId}, ${itemId}, '2026-01-20T02:00:00Z', '10', 'receipt', 'delivery', ${crypto.randomUUID()}, ${personId})`;
}

/** One referencing row per leg. Each returns the item (the SUBJECT whose unit we try to change). */
const LEGS: Record<string, () => Promise<{ id: string; name: string }>> = {
  stock_movements: async () => {
    const i = await mkItem('mov');
    await addMovement(i.id);
    return i;
  },
  supplier_invoice_lines: async () => {
    const i = await mkItem('inv');
    const [inv] = await sql<{ id: string }[]>`
      insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, created_by)
      values (${orgId}, ${storeId}, ${supplierId}, '2026-01-20', '10.00', ${personId}) returning id`;
    await sql`
      insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
      values (${inv!.id}, 1, ${i.id}, '1', 'kg', '1', '10.00', '10.00')`;
    return i;
  },
  pos_item_maps: async () => {
    const i = await mkItem('map');
    await sql`
      insert into pos_item_maps (org_id, store_id, pos_item_key, pos_item_name, mode, item_id, quantity_per_sale, created_by)
      values (${orgId}, ${storeId}, ${uid('pk')}, 'Coke', 'direct', ${i.id}, '1', ${personId})`;
    return i;
  },
  production_recipe_lines: async () => {
    const i = await mkItem('rln');
    const out = await mkItem('rout');
    const [rec] = await sql<{ id: string }[]>`
      insert into production_recipes (org_id, name, output_item_id, output_quantity, created_by) values (${orgId}, ${uid('rec')}, ${out.id}, '1', ${personId}) returning id`;
    await sql`insert into production_recipe_lines (recipe_id, item_id, quantity, unit) values (${rec!.id}, ${i.id}, '1', 'kg')`;
    return i;
  },
  store_item_thresholds: async () => {
    const i = await mkItem('thr');
    await sql`insert into store_item_thresholds (org_id, store_id, item_id, low_stock_threshold, set_by) values (${orgId}, ${storeId}, ${i.id}, '5', ${personId})`;
    return i;
  },
  item_pricing: async () => {
    const i = await mkItem('prc');
    await sql`insert into item_pricing (org_id, item_id, pricing_mode, fixed_amount, set_by) values (${orgId}, ${i.id}, 'fixed', '10.00', ${personId})`;
    return i;
  },
  'items.parent_slab_item_id': async () => {
    const slab = await mkItem('slab', { kind: 'meat_slab' });
    await mkItem('sliced', { kind: 'meat_sliced', parentSlab: slab.id });
    return slab;
  },
  // Extras beyond the seven the spec names (REV-2 and the two other self-references; B3 only reads the function TEXT).
  'items.cost_basis_item_id (incoming)': async () => {
    const lender = await mkItem('lend');
    await mkItem('borrow', { costBasis: lender.id });
    return lender;
  },
  'items.cost_basis_item_id (OUTGOING, REV-2)': async () => {
    const lender = await mkItem('lend2');
    return mkItem('borrow2', { costBasis: lender.id });
  },
  'items.merged_into_id': async () => {
    const keeper = await mkItem('keep');
    const dup = await mkItem('dup');
    await sql`update items set status = 'merged', merged_into_id = ${keeper.id} where id = ${dup.id}`;
    return keeper;
  },
};

const legItems: Record<string, { id: string; name: string }> = {};
async function legItem(leg: string) {
  await ensureOrg();
  legItems[leg] ??= await LEGS[leg]!();
  return legItems[leg]!;
}
let b1: { id: string; name: string } | null = null;
async function noHistoryItem() {
  await ensureOrg();
  b1 ??= await mkItem('bare');
  return b1;
}

const changeUnit = (id: string) => (t: Tx) => t`update items set base_unit = 'pcs' where id = ${id}`;
const histFn = (t: Tx | postgres.Sql, id: string) => t<{ h: boolean }[]>`select items_unit_history_exists(${id}) as h`;

// =================================================================================================================
describe('B1 control - an item with no references can change unit', () => {
  it('UPDATE items SET base_unit = pcs succeeds (green on HEAD; a mutant that blocks everything turns it red)', async () => {
    const i = await noHistoryItem();
    const err = await attempt(orgId, changeUnit(i.id));
    expect(err, `a bare item must be editable, got ${err?.code} ${err?.constraint_name ?? err?.message}`).toBeNull();
    // the attempt rolled back; prove the same write COMMITS on a throwaway sibling so "editable" is not an artefact.
    const sib = await mkItem('bare-commit');
    await asApp(orgId, (t) => t`update items set base_unit = 'pcs' where id = ${sib.id}`);
    expect(await unitOf(sib.id)).toBe('pcs');
  });
});

describe('B2 - a unit change is refused by items_base_unit_fixed when ONE referencing row exists (one leg each)', () => {
  // Killing mutants: drop the trigger -> every leg red; drop one leg's EXISTS in the function -> that leg red.
  for (const leg of Object.keys(LEGS)) {
    it(`leg: ${leg}`, async () => {
      const i = await legItem(leg);
      const before = await unitOf(i.id);
      expect(before).toBe('kg');
      expectRefused(await attempt(orgId, changeUnit(i.id)), leg);
      expect(await unitOf(i.id), `${leg}: the unit must be unchanged`).toBe('kg');
    });
  }
});

describe('B4 - not every write is a change (an item WITH history)', () => {
  // Killing mutant: drop `WHEN (OLD.base_unit IS DISTINCT FROM NEW.base_unit)`, or BEFORE UPDATE without OF base_unit and
  // no distinct check -> the writes below are refused -> red.
  it('SET base_unit = base_unit, SET name, and a same-value literal all succeed (green on HEAD)', async () => {
    const i = await legItem('stock_movements');
    for (const [what, run] of [
      ['SET base_unit = base_unit', (t: Tx) => t`update items set base_unit = base_unit where id = ${i.id}`],
      ['SET base_unit = the current literal', (t: Tx) => t`update items set base_unit = 'kg' where id = ${i.id}`],
      ['SET name = ...', (t: Tx) => t`update items set name = ${i.name + '-renamed'} where id = ${i.id}`],
      ['SET status = inactive', (t: Tx) => t`update items set status = 'inactive' where id = ${i.id}`],
    ] as const) {
      const err = await attempt(orgId, run);
      expect(err, `${what}: must be allowed, got ${err?.code} ${err?.constraint_name ?? err?.message}`).toBeNull();
    }
  });

  it('control: the SAME item refuses a real unit change (red on HEAD: it succeeds), so the allowed writes above are not vacuous', async () => {
    const i = await legItem('stock_movements');
    expectRefused(await attempt(orgId, changeUnit(i.id)), 'B4 control');
    // and a multi-column UPDATE that includes a real change is refused too
    expectRefused(
      await attempt(orgId, (t) => t`update items set name = ${i.name + '-x'}, base_unit = 'g' where id = ${i.id}`),
      'B4 multi-column',
    );
  });
});

// ---- B3 --------------------------------------------------------------------------------------------------------
/** Strip `--` line comments and block comments, so a table named only in a comment cannot satisfy a leg. */
function stripComments(def: string): string {
  return def.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}
/** `rhs` is the item reference: `p_item` in the function, `i.id` in the P0186b-pre header query. */
const legRegex = (table: string, col: string, rhs = 'p_item') =>
  new RegExp(String.raw`FROM\s+"?${table}"?\s+(?:\w+\s+)?WHERE\s+(?:\w+\.)?"?${col}"?\s*=\s*${rhs.replace('.', String.raw`\.`)}(?!\w)`, 'i');
const outgoingCostBasis = (rhs = 'p_item') => {
  const r = rhs.replace('.', String.raw`\.`);
  return new RegExp(
    String.raw`(?:FROM\s+"?items"?\s+(?:\w+\s+)?WHERE\s+(?:\w+\.)?"?id"?\s*=\s*${r}\s+AND\s+(?:\w+\.)?"?cost_basis_item_id"?\s+IS\s+NOT\s+NULL)` +
      String.raw`|(?:FROM\s+"?items"?\s+(?:\w+\s+)?WHERE\s+(?:\w+\.)?"?cost_basis_item_id"?\s+IS\s+NOT\s+NULL\s+AND\s+(?:\w+\.)?"?id"?\s*=\s*${r}(?!\w))`,
    'i',
  );
};
const OUTGOING_COST_BASIS = outgoingCostBasis();
/** The (table, column) pairs of `legs` with no matching leg in `def` (comments stripped). The REV-2 leg is `items.OUTGOING`. */
function missingLegs(def: string, legs: { tbl: string; col: string }[], rhs = 'p_item'): string[] {
  const text = stripComments(def);
  const missing = legs.filter((l) => !legRegex(l.tbl, l.col, rhs).test(text)).map((l) => `${l.tbl}.${l.col}`);
  if (!outgoingCostBasis(rhs).test(text)) missing.push('items.OUTGOING cost_basis_item_id IS NOT NULL (REV-2)');
  return missing;
}
const EXEMPT: Record<string, string> = {
  'supplier_items.item_id': 'a declaration, no quantity or price (C2 ex)',
  'store_item_sellability.item_id': 'three booleans (C2 ex)',
  'item_requests.created_item_id': 'provenance only (C2 ex)',
};

async function itemFks() {
  const rows = await sql<{ tbl: string; col: string }[]>`
    select cl.relname as tbl, att.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    cross join lateral unnest(c.conkey) as k(attnum)
    join pg_attribute att on att.attrelid = c.conrelid and att.attnum = k.attnum
    where c.contype = 'f' and c.confrelid = 'public.items'::regclass and n.nspname = 'public'
    order by 1, 2`;
  return rows;
}
async function functionDef(): Promise<string> {
  const [r] = await sql<{ d: string }[]>`select pg_get_functiondef('public.items_unit_history_exists'::regproc) as d`;
  return r!.d;
}

describe('B3 - drift guard: every FK to items(id) is a leg of items_unit_history_exists, or exempt', () => {
  it('discovery is sane: >= 29 FKs (REV-1: 26 on other tables + 3 self-references) and every EXEMPT entry still exists', async () => {
    const fks = await itemFks();
    expect(fks.length).toBeGreaterThanOrEqual(29);
    const have = new Set(fks.map((f) => `${f.tbl}.${f.col}`));
    for (const e of Object.keys(EXEMPT)) expect(have.has(e), `stale EXEMPT entry ${e}`).toBe(true);
    for (const s of ['parent_slab_item_id', 'cost_basis_item_id', 'merged_into_id']) expect(have.has(`items.${s}`)).toBe(true);
  });

  it('every non-exempt FK has its own `FROM t WHERE c = p_item` leg (per leg, comments stripped) + the REV-2 outgoing leg', async () => {
    // Killing mutants: delete any one table from the function; a scratch migration adding a table with an FK to items.
    const legs = (await itemFks()).filter((f) => !(`${f.tbl}.${f.col}` in EXEMPT));
    const def = await functionDef();
    expect(missingLegs(def, legs)).toEqual([]);
  });

  it('the per-leg matcher is not vacuous: a commented-out leg, a swapped column and a deleted leg are each REPORTED missing', async () => {
    // Kills a regression of B3 itself to `includes(table) && includes(column)` (REV-6). Derived from the REAL function text.
    const legs = (await itemFks()).filter((f) => !(`${f.tbl}.${f.col}` in EXEMPT));
    const def = await functionDef();
    const pick = (tbl: string, col: string) => {
      const m = legRegex(tbl, col).exec(stripComments(def));
      expect(m, `leg ${tbl}.${col} not found in the real function`).not.toBeNull();
      return m![0];
    };
    // (a) leg moved into a comment
    const a = pick('stock_movements', 'item_id');
    expect(missingLegs(stripCommentsSafeReplace(def, a, `/* ${a} */ false`), legs)).toContain('stock_movements.item_id');
    // (b) commissary_item_map's branch_item_id leg rewritten to item_id
    const b = pick('commissary_item_map', 'branch_item_id');
    expect(missingLegs(stripCommentsSafeReplace(def, b, b.replace('branch_item_id', 'item_id')), legs)).toContain('commissary_item_map.branch_item_id');
    // (c) a leg deleted outright; its column survives as a substring of OTHER legs (created_item_id / output_item_id ...)
    const c = pick('count_lines', 'item_id');
    expect(missingLegs(stripCommentsSafeReplace(def, c, 'false'), legs)).toContain('count_lines.item_id');
    // (d) the REV-2 leg commented out
    const d = OUTGOING_COST_BASIS.exec(stripComments(def))![0];
    expect(missingLegs(stripCommentsSafeReplace(def, d, `/* ${d} */ false`), legs)).toEqual([
      'items.OUTGOING cost_basis_item_id IS NOT NULL (REV-2)',
    ]);
    // control: the untouched function has nothing missing
    expect(missingLegs(def, legs)).toEqual([]);
  });
});

/** Replace the first occurrence of `needle` in the (un-stripped) def; the needle came from the stripped text. */
function stripCommentsSafeReplace(def: string, needle: string, replacement: string): string {
  const idx = def.indexOf(needle);
  expect(idx, `needle not found verbatim in the un-stripped def: ${needle}`).toBeGreaterThanOrEqual(0);
  return def.slice(0, idx) + replacement + def.slice(idx + needle.length);
}

describe('B5 - items_unit_history_exists: false on a bare item, true on each B2 item', () => {
  // Killing mutant: drop one leg's EXISTS -> that leg's item returns false -> red (B2 catches it through the trigger too).
  it('false on B1\'s item', async () => {
    const i = await noHistoryItem();
    const [r] = await asApp(orgId, (t) => histFn(t, i.id));
    expect(r!.h).toBe(false);
  });
  for (const leg of Object.keys(LEGS)) {
    it(`true on the item of leg: ${leg}`, async () => {
      const i = await legItem(leg);
      const [r] = await asApp(orgId, (t) => histFn(t, i.id));
      expect(r!.h).toBe(true);
    });
  }
});

describe('B5b - the P0186b-pre query in the migration header agrees with the function (I2: no unreviewed second copy)', () => {
  const file = resolve(process.cwd(), 'packages/db/migrations/0186_t378_item_unit_fixed_and_request_flags.sql');
  function headerQuery(): string {
    expect(existsSync(file), `migration file missing: ${file} (red on HEAD: 0186 does not exist yet)`).toBe(true);
    const text = readFileSync(file, 'utf8');
    const m = /^--\s*P0186b-pre:begin[ \t]*\r?\n([\s\S]*?)^--\s*P0186b-pre:end[ \t]*$/m.exec(text);
    expect(m, 'the 0186 header must carry `-- P0186b-pre:begin` ... `-- P0186b-pre:end` marker lines around the query').not.toBeNull();
    const q = m![1]!
      .split(/\r?\n/)
      .map((l) => l.replace(/^--[ \t]?/, ''))
      .join('\n')
      .trim()
      .replace(/;\s*$/, '');
    expect(q.length).toBeGreaterThan(0);
    expect(q, 'P0186b-pre is the PRE-migration form: it must not call the function').not.toMatch(/items_unit_history_exists/i);
    return q;
  }

  it("STRUCTURAL: the header query has exactly the function's legs (every non-exempt FK from B3's list + the REV-2 outgoing leg), none extra", async () => {
    // Killing mutant: delete ANY one leg from the header query (the fixture comparison below reaches only some of them).
    const legs = (await itemFks()).filter((f) => !(`${f.tbl}.${f.col}` in EXEMPT));
    const q = headerQuery();
    expect(missingLegs(q, legs, 'i.id')).toEqual([]);
    expect(stripComments(q).match(/EXISTS\s*\(/gi)?.length, 'one EXISTS per leg plus the outgoing one: no extras').toBe(legs.length + 1);
  });

  it('for every fixture item, the pasted EXISTS list returns the same has_history as the function', async () => {
    // Killing mutant: drop one leg from the header query -> that leg's item disagrees -> red.
    for (const leg of Object.keys(LEGS)) await legItem(leg);
    await noHistoryItem();
    const q = headerQuery();
    const viaHeader = await asApp(orgId, (t) => t.unsafe<{ name: string; has_history: boolean }[]>(q));
    const items = await sql<{ id: string; name: string }[]>`select id, name from items where org_id = ${orgId}`;
    const byName = new Map(viaHeader.map((r) => [r.name, r.has_history]));
    expect(items.length).toBeGreaterThanOrEqual(Object.keys(LEGS).length + 1);
    const disagreements: string[] = [];
    for (const it of items) {
      expect(byName.has(it.name), `the header query returned no row for ${it.name}`).toBe(true);
      const [fn] = await asApp(orgId, (t) => histFn(t, it.id));
      if (byName.get(it.name) !== fn!.h) disagreements.push(`${it.name}: header=${byName.get(it.name)} function=${fn!.h}`);
    }
    expect(disagreements).toEqual([]);
    // non-vacuous: the set contains both answers
    expect([...byName.values()]).toContain(true);
    expect([...byName.values()]).toContain(false);
  });
});

describe('B6 (R7) - item_requests carries the three flags, NOT NULL, with the item defaults', () => {
  async function insertRequest(extra: { p?: unknown; r?: unknown; w?: unknown } | null) {
    await ensureOrg();
    const n = uid('req');
    if (extra === null) {
      const [row] = await sql<{ is_purchasable: boolean; sellable_retail: boolean; sellable_wholesale: boolean }[]>`
        insert into item_requests (org_id, name, code, kind, base_unit, requested_by) values (${orgId}, ${n}, ${n}, 'raw_material', 'pcs', ${personId})
        returning is_purchasable, sellable_retail, sellable_wholesale`;
      return row!;
    }
    const [row] = await sql<{ is_purchasable: boolean; sellable_retail: boolean; sellable_wholesale: boolean }[]>`
      insert into item_requests (org_id, name, code, kind, base_unit, requested_by, is_purchasable, sellable_retail, sellable_wholesale)
      values (${orgId}, ${n}, ${n}, 'raw_material', 'pcs', ${personId}, ${extra.p as boolean}, ${extra.r as boolean}, ${extra.w as boolean})
      returning is_purchasable, sellable_retail, sellable_wholesale`;
    return row!;
  }

  it('omitted -> true, false, false (red on HEAD: the columns do not exist, 42703)', async () => {
    expect(await insertRequest(null)).toEqual({ is_purchasable: true, sellable_retail: false, sellable_wholesale: false });
  });
  it('explicit values persist (flip every flag)', async () => {
    expect(await insertRequest({ p: false, r: true, w: true })).toEqual({ is_purchasable: false, sellable_retail: true, sellable_wholesale: true });
  });
  for (const col of ['is_purchasable', 'sellable_retail', 'sellable_wholesale'] as const) {
    it(`${col} = NULL is a NOT NULL violation (23502 on that column) - mutant: a nullable column turns it red`, async () => {
      const args = { p: true, r: false, w: false } as Record<string, unknown>;
      args[col === 'is_purchasable' ? 'p' : col === 'sellable_retail' ? 'r' : 'w'] = null;
      let err: PgErr = null;
      try {
        await insertRequest(args);
      } catch (e) {
        err = e as PgErr;
      }
      expect(err, `${col} = NULL was accepted`).not.toBeNull();
      expect({ code: err!.code, column: err!.column_name }).toEqual({ code: '23502', column: col });
    });
  }
});

describe('B7 (REV-3) - the race: a concurrent first stock insert vs a unit change', () => {
  // Killing mutant: drop `PERFORM 1 FROM items WHERE id = OLD.id FOR UPDATE` -> connection 1 does not block, commits
  // kg -> pcs, and connection 2 then commits a kg quantity onto a pcs item -> red.
  it('conn 1 BLOCKS behind conn 2\'s uncommitted first movement, then is refused items_base_unit_fixed once it commits', async () => {
    await ensureOrg();
    const item = await mkItem('race');
    const c1 = postgres(url, { max: 1, connection: { application_name: 't378s2-race-1' } });
    const c2 = postgres(url, { max: 1, connection: { application_name: 't378s2-race-2' } });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    let tx2Err: unknown = null;
    const tx2 = c2
      .begin(async (t) => {
        await t.unsafe(`set local role ${APP_ROLE}`);
        await t`select set_config('app.principal_kind', 'staff', true)`;
        await t`select set_config('app.org_id', ${orgId}, true)`;
        await addMovement(item.id, t); // the FK check takes FOR KEY SHARE on the item row; NOT committed
        inserted();
        await hold;
      })
      .catch((e) => {
        tx2Err = e;
        inserted();
      });
    try {
      await insertedP;
      expect(tx2Err, 'connection 2 could not insert the movement').toBeNull();

      let c1Err: PgErr = null;
      let c1Done = false;
      const tx1 = c1
        .begin(async (t) => {
          await t.unsafe(`set local role ${APP_ROLE}`);
          await t`select set_config('app.principal_kind', 'staff', true)`;
          await t`select set_config('app.org_id', ${orgId}, true)`;
          await t`set local lock_timeout = '20s'`; // safety net only: a hung test must not hang the suite
          await t`update items set base_unit = 'pcs' where id = ${item.id}`;
        })
        .catch((e) => {
          c1Err = e as PgErr;
        })
        .finally(() => {
          c1Done = true;
        });

      // Wait until connection 1 is provably WAITING on a lock held by connection 2.
      let blocked = false;
      for (let n = 0; n < 40 && !blocked && !c1Done; n++) {
        const w = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and application_name = 't378s2-race-1' and wait_event_type = 'Lock'`;
        blocked = w[0]!.n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 100));
      }
      expect(
        blocked,
        c1Done
          ? 'connection 1 did NOT block: its UPDATE ran to completion while connection 2 held an uncommitted first movement (no FOR UPDATE, or no trigger)'
          : 'connection 1 never reported a Lock wait',
      ).toBe(true);

      release();
      await tx2;
      await tx1;
      expect({ code: c1Err && (c1Err as PgErr)!.code, constraint: c1Err && (c1Err as PgErr)!.constraint_name }).toEqual({
        code: '23514',
        constraint: FIXED,
      });
      expect(await unitOf(item.id), 'a kg quantity must never land on a pcs item').toBe('kg');
    } finally {
      release();
      await tx2.catch(() => undefined);
      await c1.end({ timeout: 5 });
      await c2.end({ timeout: 5 });
    }
  }, 60_000);
});

describe('B8 (REV-4) - fail-closed: no org context + a role that cannot bypass RLS => "has history" (true)', () => {
  // Killing mutant: delete the NULL-org branch -> RLS hides every referencing row -> it answers false -> red.
  it('APP_ROLE with app.org_id UNSET: true on a bare item (control: with the org set it is false)', async () => {
    const i = await noHistoryItem();
    const [withOrg] = await asApp(orgId, (t) => histFn(t, i.id));
    expect(withOrg!.h, 'control: with the org set a bare item has no history').toBe(false);
    const [noOrg] = await asApp(null, (t) => histFn(t, i.id));
    expect(noOrg!.h, 'no org context + RLS-bound role must answer true (locked), not false (editable)').toBe(true);
  });
  it('control: the owner connection (superuser/BYPASSRLS) with no org context reads through and answers false on a bare item', async () => {
    const i = await noHistoryItem();
    const [r] = await histFn(sql, i.id);
    expect(r!.h).toBe(false);
  });
});
