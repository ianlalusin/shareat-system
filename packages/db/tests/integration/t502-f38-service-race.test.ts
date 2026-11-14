/**
 * T-502 F38 (P2 race) - "convert to service" racing "first stock movement". TWO SEPARATE connections, explicit BEGIN.
 * The guards (items_refuse_service_item, items_refuse_service_recipe_output) read items.kind; items_service_kind_has_history reads
 * stock history. Without a row lock each sees the other's pre-commit state and the item ends up a service WITH stock history.
 * Asserts the FINAL STATE and the refusal in words, in BOTH orderings.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error('Refusing to run: database name must contain "_test".');

vi.setConfig({ testTimeout: 45000 });
const PAUSE_MS = 700;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = postgres(url, { max: 2 });
const cx = postgres(url, { max: 1 });
const cy = postgres(url, { max: 1 });
afterAll(async () => {
  await cx.end({ timeout: 5 });
  await cy.end({ timeout: 5 });
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
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'Store') returning id`;
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${s!.id}, 'KIT', 'Kitchen', ${lt!.id}, 'operating', true, ${p!.id}) returning id`;
  const [it] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${code()}, ${uid('Electricity')}, 'supply', 'pcs', ${p!.id}) returning id`;
  return { orgId, personId: p!.id, storeId: s!.id, locationId: loc!.id, itemId: it!.id };
}
type World = Awaited<ReturnType<typeof world>>;

const toService = (c: postgres.Sql, w: World) => c`update items set kind = 'service' where id = ${w.itemId}`;
const moveStock = (c: postgres.Sql, w: World) =>
  c`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${w.orgId}, ${w.storeId}, ${w.locationId}, ${w.itemId}, now(), 5, 'receipt', 'test', uuidv7(), ${w.personId})`;

/** X runs `first` and holds open; Y runs `second` (may block); X commits; Y commits only if it succeeded. */
async function race(first: () => PromiseLike<unknown>, second: () => PromiseLike<unknown>) {
  await cx.unsafe('begin');
  await cy.unsafe('begin');
  await cx.unsafe(`set local lock_timeout = '8s'`);
  await cy.unsafe(`set local lock_timeout = '8s'`);
  await first();
  const yP = Promise.resolve(second()).then(
    () => ({ ok: true as const, msg: '' }),
    (e: Error) => ({ ok: false as const, msg: e.message }),
  );
  const settledEarly = await Promise.race([yP.then(() => true), sleep(PAUSE_MS).then(() => false)]);
  await cx.unsafe('commit');
  const y = await Promise.race([yP, sleep(20000).then(() => 'timeout' as const)]);
  if (y === 'timeout') {
    await cy.unsafe('rollback').catch(() => undefined);
    throw new Error('second transaction hung for 20s');
  }
  if (y.ok) await cy.unsafe('commit');
  else await cy.unsafe('rollback').catch(() => undefined);
  return { yOk: y.ok, yMsg: y.msg, settledEarly };
}

const state = async (w: World) => {
  const [r] = await sql<{ kind: string; n: number }[]>`
    select i.kind, (select count(*)::int from stock_movements m where m.item_id = i.id) as n from items i where i.id = ${w.itemId}`;
  return r!;
};

describe('F38 - convert-to-service racing a first stock movement', () => {
  it('(a) convert first (uncommitted), movement second: the movement waits, then is refused in words', async () => {
    const w = await world('f38a');
    const out = await race(() => toService(cx, w), () => moveStock(cy, w));
    const s = await state(w);
    expect(out.settledEarly, 'the movement did not wait for the conversion (no lock)').toBe(false);
    expect(out.yOk).toBe(false);
    expect(out.yMsg).toMatch(/never stocked/);
    expect(s).toEqual({ kind: 'service', n: 0 });
  });

  it('(b) movement first (uncommitted), convert second: the conversion waits, then is refused (has history)', async () => {
    const w = await world('f38b');
    const out = await race(() => moveStock(cx, w), () => toService(cy, w));
    const s = await state(w);
    expect(out.settledEarly, 'the conversion did not wait for the movement (no lock)').toBe(false);
    expect(out.yOk).toBe(false);
    expect(out.yMsg).toMatch(/already has stock, delivery, usage, recipe or invoice history/);
    expect(s).toEqual({ kind: 'supply', n: 1 });
  });
});
