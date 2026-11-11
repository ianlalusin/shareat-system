/**
 * T-502 S3 / section 13 rulings A1-A3, A6 (DATABASE side). Real Postgres, any `*_test` database.
 *
 * A3 (+A1, A2): a service item is refused by trigger `service_item_never_stocked` on EVERY table that carries stock by item_id.
 * The BEFORE ROW trigger fires before NOT NULL / FK checks, so a bare `insert (item_id)` proves the refusal: the service item is
 * refused with constraint `service_item_never_stocked`; the control (a supply item) is refused by something ELSE (a missing
 * column), which proves the refusal is about the service kind and not a malformed fixture.
 * A6: a service is never a variation (CHECK on items and item_requests).
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error('Refusing to run: database name must contain "_test".');

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`;
const stemStart = Math.floor(Math.random() * 36 ** 4);
let codeN = 0;
const code = () => `${((stemStart + ++codeN * 7919) % 36 ** 4).toString(36).toUpperCase().padStart(4, '0')}-001`;

async function world(hint: string) {
  const c = uid(hint);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${c}`}, ${c}) returning id`;
  const orgId = o!.id;
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  const mk = async (name: string, kind: string, baseUnit: string, extra: { variantOf?: string } = {}) => {
    const [r] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by, variant_of_item_id)
      values (${orgId}, ${code()}, ${`${name} ${uid('n')}`}, ${kind}, ${baseUnit}, ${p!.id}, ${extra.variantOf ?? null}) returning id`;
    return r!.id;
  };
  return { orgId, personId: p!.id, mk, control: await mk('Charcoal', 'supply', 'kg'), service: await mk('Electricity', 'service', 'pcs') };
}

async function failure(fn: () => PromiseLike<unknown>): Promise<{ constraint?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return { constraint: (e as { constraint_name?: string }).constraint_name, message: (e as Error).message };
  }
}

/** Tables that carry stock (or a selling / counting claim) by item_id: A1, A2, A3. */
const COVERED = [
  'count_lines',
  'stock_transfer_lines',
  'stock_reservations',
  'trade_order_lines',
  'supplier_return_lines',
  'customer_return_lines',
  'stock_layers',
  'store_item_thresholds',
  'opening_counts', // A1
  'store_item_sellability', // A2
  'production_record_lines',
  'menu_depletion_rules',
  'commissary_item_offerings',
  'price_list_items',
  'item_pricing',
  'pos_item_maps',
  'pos_usage_pull_lines',
] as const;

/** Tables whose earlier-named org-resolution triggers (DEF-491) reject a bare row first: proven by the catalogue test only. */
const CATALOGUE_ONLY = new Set(['count_lines', 'stock_transfer_lines', 'supplier_return_lines', 'customer_return_lines', 'opening_counts', 'production_record_lines', 'pos_usage_pull_lines']);

describe('A3 - the never-stocked trigger sits on every table that carries stock by item_id', () => {
  for (const table of COVERED) {
    it(`${table}: the guard trigger exists, is enabled, runs items_refuse_service_item on INSERT and UPDATE OF item_id`, async () => {
      const rows = await sql<{ fn: string; enabled: string; def: string }[]>`
        select p.proname as fn, t.tgenabled as enabled, pg_get_triggerdef(t.oid) as def
        from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = ${table}::regclass and not t.tgisinternal and p.proname = 'items_refuse_service_item'`;
      expect(rows.length, `${table} needs exactly one service guard`).toBe(1);
      expect(rows[0]!.enabled).toBe('O');
      expect(rows[0]!.def).toMatch(/BEFORE INSERT OR UPDATE OF item_id ON/);
    });

    if (CATALOGUE_ONLY.has(table)) continue;
    it(`${table}: a service item is refused with service_item_never_stocked; a control item is not refused by it`, async () => {
      const w = await world(`a3-${table}`);
      const bad = await failure(() => sql.unsafe(`insert into ${table} (item_id) values ('${w.service}')`));
      expect(bad?.constraint, `${table} must refuse a service`).toBe('service_item_never_stocked');
      const ok = await failure(() => sql.unsafe(`insert into ${table} (item_id) values ('${w.control}')`));
      expect(ok?.constraint, `${table} control must fail on something else`).not.toBe('service_item_never_stocked');
    });
  }

  it('control: the catalogue query finds the five guards that already existed (so a rename cannot hide a missing one)', async () => {
    for (const table of ['stock_movements', 'delivery_lines', 'stock_usage_lines', 'production_recipe_lines']) {
      const [r] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = ${table}::regclass and p.proname = 'items_refuse_service_item'`;
      expect(r!.n, table).toBe(1);
    }
  });
});

describe('A6 - a service is never a variation', () => {
  it('items: a service cannot name a variant_of_item_id (insert); a stocked item still can (control)', async () => {
    const w = await world('a6-ins');
    const parent = await w.mk('Power parent', 'service', 'pcs');
    const bad = await failure(() => w.mk('Power child', 'service', 'pcs', { variantOf: parent }));
    expect(bad?.constraint).toBe('items_service_not_variation_check');
    const sup = await w.mk('Box', 'supply', 'pcs');
    await expect(w.mk('Box large', 'supply', 'pcs', { variantOf: sup })).resolves.toBeTruthy();
  });

  it('items: an existing service cannot be turned into a variation (update)', async () => {
    const w = await world('a6-upd');
    const parent = await w.mk('Water parent', 'service', 'pcs');
    const bad = await failure(() => sql`update items set variant_of_item_id = ${parent} where id = ${w.service}`);
    expect(bad?.constraint).toBe('items_service_not_variation_check');
  });

  it('items: a stocked item cannot be a variation of a service (parent side)', async () => {
    const w = await world('a6-par');
    const bad = await failure(() => w.mk('Child of service', 'supply', 'pcs', { variantOf: w.service }));
    expect(bad).not.toBeNull();
  });

  it('item_requests: a service request cannot carry variant_of_item_id', async () => {
    const w = await world('a6-req');
    const parent = await w.mk('Parent', 'supply', 'pcs');
    const ins = (kind: string, unit: string) => sql`
      insert into item_requests (org_id, name, code, kind, base_unit, requested_by, variant_of_item_id)
      values (${w.orgId}, ${uid('Req')}, ${code()}, ${kind}, ${unit}, ${w.personId}, ${parent})`;
    const bad = await failure(() => ins('service', 'pcs'));
    expect(bad?.constraint).toBe('item_requests_service_not_variation_check');
    await expect(ins('supply', 'pcs')).resolves.toBeTruthy();
  });
});
