/**
 * T-383 S2b - `docs/tasks/383-item-rename.md` B2.5, web legs W6-W8. TESTER file.
 *
 * A retired item is offered by a consume/move picker ONLY while it has stock above zero at the store being worked on
 * (`itemsRepo.listUsableItems`, tested in the domain file), and its option reads "{name} (retired)". Outputs of a production
 * run keep hiding retired items. Real Postgres, real page render and real loaders; only `requireSession` / `next/navigation`
 * and the Next.js path aliases are mocked (same mocks as the S1/S2a web file).
 *
 * Where the label lives (the spec says "labelled {name} (retired)" without naming the field): in the option's `name` field of
 * the loader results (`usageScreenData().items[].name`, `productionScreenData().inputItems[].name`), and in the rendered option
 * text on the transfers page. `productionScreenData` gains an `inputItems` array (B2.5); `items` stays active-only.
 */
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!,
    sessionId: 'session-1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/shell/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('@/components/FilterRow', () => ({ FilterRow: ({ children }: { children: unknown }) => children }));

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t383pk-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(label)}, ${`Store ${label}`}, 'multi_room') returning id`;
    return s!.id;
  };
  const storeA = await mkStore('a');
  const storeB = await mkStore('b');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'super_admin')`;
  for (const s of [storeA, storeB]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, roomCode: string, isDefault: boolean) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${storeId}, ${roomCode}, ${roomCode}, ${lt!.id}, 'operating', ${isDefault}, ${p!.id}) returning id`;
    return r!.id;
  };
  const kitchenA = await mkRoom(storeA, 'KIT', true);
  await mkRoom(storeA, 'DISP', false); // a transfer needs two rooms, or the page shows no form at all
  const kitchenB = await mkRoom(storeB, 'KIT', true);
  await mkRoom(storeB, 'DISP', false);
  const actor = { orgId, personId: p!.id };
  return { orgId, storeA, storeB, kitchenA, kitchenB, actor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function mkItem(f: Fixture, name: string, kind = 'raw_material'): Promise<{ id: string; name: string }> {
  const full = `${name} ${uid('n')}`;
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${f.orgId}, ${testItemCode()}, ${full}, ${kind}, 'kg', ${f.actor.personId}) returning id`;
  return { id: row!.id, name: full };
}
async function stock(f: Fixture, itemId: string, storeId: string, locationId: string, qty: string): Promise<void> {
  await sql`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${f.orgId}, ${storeId}, ${locationId}, ${itemId}, now(), ${qty}, 'opening', 'test_seed', ${crypto.randomUUID()}, ${f.actor.personId})`;
}
/** Retire through the real S2a verb, and prove the fixture: the row really is `inactive`. */
async function retire(f: Fixture, itemId: string): Promise<void> {
  const { transaction, APP_ROLE } = await import('@shareat/db');
  const { setItemStatus } = await import('@shareat/domain');
  await transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${f.orgId}, true)`);
    return setItemStatus(tx, f.actor, { itemId, status: 'inactive' });
  });
  const [row] = await sql<{ status: string }[]>`select status from items where id = ${itemId}`;
  expect(row!.status, 'fixture: the item must be retired before the leg under test').toBe('inactive');
}

/** Two retired items with stock: `atA` has +5 at store A only, `atB` has +5 at store B only; plus one active item and one retired item at zero. */
async function pickerWorld(hint: string) {
  const f = await fixture(hint);
  const atA = await mkItem(f, 'Old Coke at A');
  const atB = await mkItem(f, 'Old Coke at B');
  const retiredEmpty = await mkItem(f, 'Old Coke used up');
  const active = await mkItem(f, 'Coke active');
  await stock(f, atA.id, f.storeA, f.kitchenA, '5');
  await stock(f, atB.id, f.storeB, f.kitchenB, '5');
  for (const i of [atA, atB, retiredEmpty]) await retire(f, i.id);
  return { f, atA, atB, retiredEmpty, active };
}

describe('W6 - the usage screen offers a retired item only where it has stock', () => {
  it('store A lists "{name} (retired)" for the +5 item and not the store-B one or the used-up one; store B the reverse; the active item is plain at both. RED on HEAD (retired items are never offered). Mutant: the usage loader back on listItems({ includeInactive: false }) -> red', async () => {
    const { usageScreenData } = await import('../../src/app/inventory/usage/lib');
    const { f, atA, atB, retiredEmpty, active } = await pickerWorld('w6');

    const a = await usageScreenData(f.orgId, f.storeA);
    const namesA = a.items.map((i) => i.name);
    expect(namesA).toContain(`${atA.name} (retired)`);
    expect(namesA.filter((n) => n.includes(atB.name)), 'stock at the OTHER store does not make it usable here').toEqual([]);
    expect(namesA.filter((n) => n.includes(retiredEmpty.name)), 'used up (zero) drops out').toEqual([]);
    expect(namesA, 'an active item keeps its plain name').toContain(active.name);
    expect(a.items.find((i) => i.id === atA.id)?.name).toBe(`${atA.name} (retired)`);

    const b = await usageScreenData(f.orgId, f.storeB);
    const namesB = b.items.map((i) => i.name);
    expect(namesB).toContain(`${atB.name} (retired)`);
    expect(namesB.filter((n) => n.includes(atA.name))).toEqual([]);
    expect(namesB).toContain(active.name);
  });
});

describe('W7 - the transfers page offers a retired item only where it has stock', () => {
  it('the page for store A renders the option "{name} (retired)" and not store B\'s item; the page for store B the reverse. RED on HEAD (the page lists active items only). Mutant: the page query back on status = active -> red', async () => {
    const TransfersPage = (await import('../../src/app/inventory/transfers/page')).default;
    const { f, atA, atB, retiredEmpty, active } = await pickerWorld('w7');
    ACTOR_HOLDER.actor = f.actor;
    const render = async (storeId: string) =>
      renderToStaticMarkup((await TransfersPage({ searchParams: Promise.resolve({ store: storeId }) })) as never);

    const htmlA = await render(f.storeA);
    expect(htmlA, 'sanity: the New transfer form rendered (the store has two rooms)').toContain('New transfer');
    expect(htmlA, 'sanity: an active item is offered, unlabelled').toContain(active.name);
    expect(htmlA).toContain(`${atA.name} (retired)`);
    expect(htmlA).not.toContain(atB.name);
    expect(htmlA).not.toContain(retiredEmpty.name);

    const htmlB = await render(f.storeB);
    expect(htmlB).toContain(`${atB.name} (retired)`);
    expect(htmlB).not.toContain(atA.name);
    expect(htmlB).not.toContain(retiredEmpty.name);
  });
});

describe('W8 - the production screen: retired items may be INPUTS (with stock), never outputs', () => {
  it('inputItems has "{name} (retired)" for the +5 item; items (the outputs) has no retired item at all. RED on HEAD (no inputItems). Mutant: the retired item leaks into items -> red; inputItems built from listItems(active) -> red', async () => {
    const { productionScreenData } = await import('../../src/app/inventory/production/lib');
    const { f, atA, atB, retiredEmpty, active } = await pickerWorld('w8');

    const data = (await productionScreenData(f.orgId, f.storeA)) as unknown as {
      items: { id: string; name: string }[];
      inputItems: { id: string; name: string }[] | undefined;
    };
    expect(data.inputItems, 'productionScreenData must return inputItems (B2.5)').toBeDefined();
    const inputs = data.inputItems!.map((i) => i.name);
    expect(inputs).toContain(`${atA.name} (retired)`);
    expect(inputs.filter((n) => n.includes(atB.name))).toEqual([]);
    expect(inputs.filter((n) => n.includes(retiredEmpty.name))).toEqual([]);
    expect(inputs, 'an active item is an input too').toContain(active.name);

    const outputs = data.items.map((i) => i.name);
    for (const retired of [atA, atB, retiredEmpty]) {
      expect(outputs.filter((n) => n.includes(retired.name)), `${retired.name} must not be an output`).toEqual([]);
    }
    expect(outputs).toContain(active.name);
  });
});
