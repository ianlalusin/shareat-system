import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-390 S1 - opening counts per room. `docs/tasks/390-opening-stock-and-subledger-tieout.md` s4 R1, R2, R3, the count half of
 * R8 and R13, s8 tests 1-5 and the count part of 14a. Written TESTER-FIRST: it is red until migration 0191 and the S1 repo/domain
 * changes land.
 *
 * Lives in the root tests/integration/ ("integration" vitest project), as the spec names (s7 S1 row).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, RefusalError, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { cutoverProgress, recordOpeningCount, postEntry } from '@shareat/domain';
import { seedChartOfAccounts } from '../../packages/db/seed/chart-of-accounts';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** S1 widens the input (locationId, costSource, costEvidence); the cast keeps this file compiling before the builder's change. */
type CountInput = Parameters<typeof recordOpeningCount>[2] & {
  locationId?: string | null;
  costSource?: string | null;
  costEvidence?: string | null;
};
const record = (f: Fixture, input: CountInput) =>
  asOrg(f.orgId, (tx) => recordOpeningCount(tx, f.admin, input as Parameters<typeof recordOpeningCount>[2]));

/** The error a call rejects with, or null when it resolves. */
const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

interface CountRow {
  location_id: string;
  quantity: string;
  unit_cost: string | null;
  cost_source: string | null;
}
const rowsFor = (f: Fixture, storeId: string, itemId: string) =>
  sql<CountRow[]>`
    select location_id, quantity::text, unit_cost::text, cost_source
    from opening_counts where org_id = ${f.orgId} and store_id = ${storeId} and item_id = ${itemId}
    order by location_id`;
const rowCount = async (f: Fixture, storeId: string, itemId: string) => {
  const [r] = await sql<{ n: string }[]>`
    select count(*)::text as n from opening_counts
    where org_id = ${f.orgId} and store_id = ${storeId} and item_id = ${itemId}`;
  return Number(r!.n);
};

async function fixture(hint: string) {
  const code = uid(`t390s1-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-12-01', '2026-12-31', 'open'),
      (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid(name)}, ${`Store ${name}`}, 'multi_room') returning id`;
    return s!.id;
  };
  const storeA = await mkStore('A');
  const storeB = await mkStore('B');
  const storeC = await mkStore('C'); // no rooms at all, so no default room

  const [admin] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  for (const s of [storeA, storeB, storeC]) {
    await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${s})`;
  }

  const [lt] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, roomCode: string, isDefault: boolean, status = 'active') => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, status, created_by)
      values (${orgId}, ${storeId}, ${roomCode}, ${roomCode}, ${lt!.id}, 'operating', ${isDefault}, ${status}, ${admin!.id})
      returning id`;
    return r!.id;
  };
  const kitchenA = await mkRoom(storeA, 'KIT', true);
  const freezerA = await mkRoom(storeA, 'FRZ', false);
  const closedA = await mkRoom(storeA, 'OLD', false, 'inactive');
  const barB = await mkRoom(storeB, 'BAR', true);

  const mkItem = async (name: string) => {
    const [i] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${uid('IT')}, ${`${name} ${uid('n')}`}, 'raw_material', 'kg', ${admin!.id}) returning id`;
    return i!.id;
  };
  const item1 = await mkItem('Pork');
  const item2 = await mkItem('Beef');
  const actor: Actor = { personId: admin!.id, orgId };
  return {
    orgId, storeA, storeB, storeC, kitchenA, freezerA, closedA, barB, item1, item2,
    admin: actor, adminId: admin!.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('R1 - a count belongs to a room (test 1, kills M1)', () => {
  it('the same item counted in Kitchen and in Freezer is TWO rows', async () => {
    const f = await fixture('twoRooms');
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' });
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '7' });
    // (store, item) was the old unique key: the second call overwrote the first and left ONE row.
    expect(await rowCount(f, f.storeA, f.item1)).toBe(2);
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(new Set(rows.map((r) => r.location_id))).toEqual(new Set([f.kitchenA, f.freezerA]));
    const byRoom = new Map(rows.map((r) => [r.location_id, Number(r.quantity)]));
    expect(byRoom.get(f.kitchenA)).toBe(5);
    expect(byRoom.get(f.freezerA)).toBe(7);
  });

  it('B3 is still per STORE: one row in ANY room satisfies it', async () => {
    const f = await fixture('b3');
    // Only the non-default room is counted, for both items.
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '1' });
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item2, quantity: '0' });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.location_id).toBe(f.freezerA);
    const p = await asOrg(f.orgId, (tx) => cutoverProgress(tx, f.orgId, [f.storeA]));
    expect(p.steps.find((s) => s.def.code === 'B3')!.done).toBe(true);
  });

  it('recording the same (store, room, item) again corrects the row, it does not add one', async () => {
    const f = await fixture('upsert');
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' });
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '9' });
    expect(await rowCount(f, f.storeA, f.item1)).toBe(1);
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows[0]!.location_id).toBe(f.kitchenA);
    expect(Number(rows[0]!.quantity)).toBe(9);
  });

  it('the database refuses a duplicate (store, room, item) on a raw insert', async () => {
    const f = await fixture('dupkey');
    const ins = () => sql`
      insert into opening_counts (org_id, store_id, location_id, item_id, quantity, counted_by)
      values (${f.orgId}, ${f.storeA}, ${f.kitchenA}, ${f.item1}, 1, ${f.adminId})`;
    await ins();
    await expect(ins()).rejects.toThrow(/opening_counts_store_location_item_key/);
  });

  it('a store-level count with NO room goes to the store default room (R1)', async () => {
    const f = await fixture('defaultRoom');
    await record(f, { storeId: f.storeA, itemId: f.item1, quantity: '3' });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.location_id).toBe(f.kitchenA);
    expect(Number(rows[0]!.quantity)).toBe(3);
  });

  it('a store-level count with no room is REFUSED IN WORDS when the store has no default room', async () => {
    const f = await fixture('noDefault');
    const err = await errorOf(record(f, { storeId: f.storeC, itemId: f.item1, quantity: '3' }));
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/default room/i);
    expect(await rowCount(f, f.storeC, f.item1)).toBe(0);
  });

  it('a room that is not active is refused by the domain', async () => {
    const f = await fixture('inactiveRoom');
    const err = await errorOf(record(f, { storeId: f.storeA, locationId: f.closedA, itemId: f.item1, quantity: '3' }));
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/room/i);
    expect(await rowCount(f, f.storeA, f.item1)).toBe(0);
  });
});

describe('R1 - a room of another store is refused (test 2, kills M2)', () => {
  it("the DOMAIN refuses store B's room on a store A count, in words, and writes nothing", async () => {
    const f = await fixture('xstoreDomain');
    const err = await errorOf(record(f, { storeId: f.storeA, locationId: f.barB, itemId: f.item1, quantity: '3' }));
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/room/i);
    expect(await rowCount(f, f.storeA, f.item1)).toBe(0);
  });

  it('the DATABASE refuses it on a raw insert (trigger opening_counts_room_in_store)', async () => {
    const f = await fixture('xstoreDb');
    await expect(
      sql`
        insert into opening_counts (org_id, store_id, location_id, item_id, quantity, counted_by)
        values (${f.orgId}, ${f.storeA}, ${f.barB}, ${f.item1}, 1, ${f.adminId})`,
    ).rejects.toThrow(/is not a room of store/);
  });

  it('and on an UPDATE of location_id (the trigger fires on UPDATE OF location_id too)', async () => {
    const f = await fixture('xstoreUpd');
    await sql`
      insert into opening_counts (org_id, store_id, location_id, item_id, quantity, counted_by)
      values (${f.orgId}, ${f.storeA}, ${f.kitchenA}, ${f.item1}, 1, ${f.adminId})`;
    await expect(
      sql`
        update opening_counts set location_id = ${f.barB}
        where org_id = ${f.orgId} and store_id = ${f.storeA} and item_id = ${f.item1}`,
    ).rejects.toThrow(/is not a room of store/);
  });
});

describe('R2/R3 - one cost per item per store, recorded with its source (tests 3 and 4, kill M3 and M4)', () => {
  it('a cost typed in Kitchen appears on the Freezer row of the same item; cost_source = typed on both', async () => {
    const f = await fixture('costBoth');
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '7' });
    await record(f, {
      storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5', unitCost: '12.5', costSource: 'typed',
    });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Number(r.unit_cost)).toBe(12.5);
      expect(r.cost_source).toBe('typed');
    }
  });

  it('a later cost typed in the OTHER room overwrites both (still one cost per item per store)', async () => {
    const f = await fixture('costBoth2');
    await record(f, {
      storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5', unitCost: '12.5', costSource: 'typed',
    });
    await record(f, {
      storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '7', unitCost: '14', costSource: 'typed',
    });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.unit_cost))).toEqual([14, 14]);
  });

  it('the cost reaches only that item in that store (other item, other store untouched)', async () => {
    const f = await fixture('costScoped');
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item2, quantity: '2' });
    await record(f, { storeId: f.storeB, locationId: f.barB, itemId: f.item1, quantity: '2' });
    await record(f, {
      storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5', unitCost: '12.5', costSource: 'typed',
    });
    const other = await rowsFor(f, f.storeA, f.item2);
    expect(other).toHaveLength(1);
    expect(other[0]!.unit_cost).toBeNull();
    expect(other[0]!.cost_source).toBeNull();
    const otherStore = await rowsFor(f, f.storeB, f.item1);
    expect(otherStore).toHaveLength(1);
    expect(otherStore[0]!.unit_cost).toBeNull();
  });

  it('a supplied source and evidence are stored (an imported cost keeps its label)', async () => {
    const f = await fixture('costEvidence');
    await record(f, {
      storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5',
      unitCost: '2.6042', costSource: 'v1_last_delivery', costEvidence: 'D-77 2026-12-20 Acme 48 pcs @ 2.6042',
    });
    const [r] = await sql<{ cost_source: string; cost_evidence: string | null }[]>`
      select cost_source, cost_evidence from opening_counts
      where org_id = ${f.orgId} and store_id = ${f.storeA} and item_id = ${f.item1}`;
    expect(r!.cost_source).toBe('v1_last_delivery');
    expect(r!.cost_evidence).toBe('D-77 2026-12-20 Acme 48 pcs @ 2.6042');
  });

  it('a cost with no source is REFUSED by the domain (the screen passes typed)', async () => {
    const f = await fixture('noSourceDomain');
    const err = await errorOf(
      record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5', unitCost: '12.5' }),
    );
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/source/i);
    expect(await rowCount(f, f.storeA, f.item1)).toBe(0);
  });

  it('the DATABASE refuses unit_cost with a null cost_source (opening_counts_cost_source_pair_check)', async () => {
    const f = await fixture('pairCheck1');
    await expect(
      sql`
        insert into opening_counts (org_id, store_id, location_id, item_id, quantity, unit_cost, counted_by)
        values (${f.orgId}, ${f.storeA}, ${f.kitchenA}, ${f.item1}, 1, 5, ${f.adminId})`,
    ).rejects.toThrow(/opening_counts_cost_source_pair_check/);
  });

  it('...and a cost_source with a null unit_cost', async () => {
    const f = await fixture('pairCheck2');
    await expect(
      sql`
        insert into opening_counts (org_id, store_id, location_id, item_id, quantity, cost_source, counted_by)
        values (${f.orgId}, ${f.storeA}, ${f.kitchenA}, ${f.item1}, 1, 'typed', ${f.adminId})`,
    ).rejects.toThrow(/opening_counts_cost_source_pair_check/);
  });

  it('...and a blank cost_source (opening_counts_cost_source_not_blank_check)', async () => {
    const f = await fixture('blankSource');
    await expect(
      sql`
        insert into opening_counts (org_id, store_id, location_id, item_id, quantity, unit_cost, cost_source, counted_by)
        values (${f.orgId}, ${f.storeA}, ${f.kitchenA}, ${f.item1}, 1, 5, '   ', ${f.adminId})`,
    ).rejects.toThrow(/opening_counts_cost_source_not_blank_check/);
  });

  it('a count with no cost at all is still fine: both null together', async () => {
    const f = await fixture('noCost');
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unit_cost).toBeNull();
    expect(rows[0]!.cost_source).toBeNull();
  });
});

describe('R3 siblings - a count WITHOUT a cost never changes any cost (coordinator ruling)', () => {
  it('re-counting a room with no cost leaves the costs of every room row of that item untouched', async () => {
    const f = await fixture('sibKeep');
    await record(f, {
      storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5', unitCost: '12.5', costSource: 'typed',
    });
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '7' });
    // Re-count Kitchen with NO cost: Kitchen keeps its cost, Freezer's (inherited) cost is kept.
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '6' });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Number(r.unit_cost)).toBe(12.5);
      expect(r.cost_source).toBe('typed');
    }
    expect(rows.map((r) => Number(r.quantity)).sort()).toEqual([6, 7]);
  });

  it('a NEW room row for an item that already has a store cost takes that cost and source', async () => {
    const f = await fixture('sibInherit');
    await record(f, {
      storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5',
      unitCost: '2.6042', costSource: 'v1_last_delivery', costEvidence: 'D-1',
    });
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '7' });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Number(r.unit_cost)).toBe(2.6042);
      expect(r.cost_source).toBe('v1_last_delivery');
    }
  });
});

describe('R3 under concurrency and with a null-cost sibling (audit round)', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const distinctCosts = async (f: Fixture, itemId: string) => {
    const rows = await rowsFor(f, f.storeA, itemId);
    return { rows, costs: new Set(rows.map((r) => `${r.unit_cost}|${r.cost_source}`)) };
  };
  const costed = (f: Fixture, locationId: string, cost: string): CountInput => ({
    storeId: f.storeA, locationId, itemId: f.item1, quantity: '5', unitCost: cost, costSource: 'typed',
  });

  it('two transactions write DIFFERENT costs for the same (store,item) in two rooms at once: ONE cost survives', async () => {
    const f = await fixture('concCosts');
    // Connection 1 writes Kitchen @10 and holds its transaction open; connection 2 writes Freezer @20 meanwhile.
    const c1 = asOrg(f.orgId, async (tx) => {
      await recordOpeningCount(tx, f.admin, costed(f, f.kitchenA, '10') as Parameters<typeof recordOpeningCount>[2]);
      await sleep(900);
    });
    await sleep(250);
    const c2 = record(f, costed(f, f.freezerA, '20'));
    await Promise.all([c1, c2]);
    const { rows, costs } = await distinctCosts(f, f.item1);
    expect(rows).toHaveLength(2);
    expect(costs.size).toBe(1); // never two different costs for one item in one store
  }, 60_000);

  it('a concurrent cost-less NEW-room write and a costed write: the new row ends with the store cost', async () => {
    const f = await fixture('concNew');
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' });
    const c1 = asOrg(f.orgId, async (tx) => {
      await recordOpeningCount(tx, f.admin, costed(f, f.kitchenA, '12') as Parameters<typeof recordOpeningCount>[2]);
      await sleep(900);
    });
    await sleep(250);
    const c2 = record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '7' });
    await Promise.all([c1, c2]);
    const { rows } = await distinctCosts(f, f.item1);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Number(r.unit_cost)).toBe(12);
      expect(r.cost_source).toBe('typed');
    }
  }, 60_000);

  it('a cost-less recount of a row whose OWN cost is null, with a costed sibling, takes the sibling cost and source', async () => {
    const f = await fixture('nullSib');
    // Legal shapes written raw: Freezer uncosted, Kitchen costed.
    await sql`
      insert into opening_counts (org_id, store_id, location_id, item_id, quantity, counted_by)
      values (${f.orgId}, ${f.storeA}, ${f.freezerA}, ${f.item1}, 7, ${f.adminId})`;
    await sql`
      insert into opening_counts (org_id, store_id, location_id, item_id, quantity, unit_cost, cost_source, counted_by)
      values (${f.orgId}, ${f.storeA}, ${f.kitchenA}, ${f.item1}, 5, 12.5, 'v1_last_delivery', ${f.adminId})`;
    await record(f, { storeId: f.storeA, locationId: f.freezerA, itemId: f.item1, quantity: '8' });
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(Number(r.unit_cost)).toBe(12.5);
      expect(r.cost_source).toBe('v1_last_delivery');
    }
    expect(rows.map((r) => Number(r.quantity)).sort()).toEqual([5, 8]);
  });
});

describe('R8 count half - counts before C2 are accepted, after a POSTED opening refused (test 5, kills M5)', () => {
  /** A posted opening_balance entry: balance-sheet only, dated the conversion date. */
  const postOpening = (tx: Tx, f: Fixture, amount = '5000.00') =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: '2027-01-01', sourceType: 'opening_balance',
      sourceId: uid('op'), idempotencyKey: uid('op'), memo: 'Opening balance', postedBy: f.adminId,
      lines: [
        { accountCode: '1110', storeId: f.storeA, debit: amount },
        { accountCode: '3900', storeId: f.storeA, credit: amount },
      ],
    });

  it('before C2 has run (no C2 row at all) a count is ACCEPTED: the count is 31 Dec, the purge is 1 Jan', async () => {
    const f = await fixture('beforeC2');
    const [c2] = await sql<{ n: string }[]>`
      select count(*)::text as n from cutover_steps where org_id = ${f.orgId} and step_code = 'C2'`;
    expect(Number(c2!.n)).toBe(0);
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' });
    expect(await rowCount(f, f.storeA, f.item1)).toBe(1);
  });

  it('after a posted opening_balance entry a count is REFUSED in words, and writes nothing', async () => {
    const f = await fixture('afterPost');
    await asOrg(f.orgId, (tx) => postOpening(tx, f));
    const err = await errorOf(record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' }));
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/books were opened/i);
    expect(await rowCount(f, f.storeA, f.item1)).toBe(0);
  });

  it('...and a CORRECTION of an existing count is refused the same way (the opening cannot be re-typed)', async () => {
    const f = await fixture('afterPostCorrect');
    await record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' });
    await asOrg(f.orgId, (tx) => postOpening(tx, f));
    const err = await errorOf(record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '9' }));
    expect(err).toBeInstanceOf(RefusalError);
    const rows = await rowsFor(f, f.storeA, f.item1);
    expect(Number(rows[0]!.quantity)).toBe(5);
  });
});

describe('R13 count half - the writer takes the SHARED opening lock before its R8 check (test 14a, kills M28)', () => {
  const settle = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));

  it('while C5 holds the EXCLUSIVE lock, recordOpeningCount BLOCKS; once the post commits it is refused by R8', async () => {
    const f = await fixture('lockBlocks');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));

    // Connection 1 stands in for postOpeningBalances: exclusive lock, post the opening, hold the transaction open.
    const conn1 = asOrg(f.orgId, async (tx) => {
      await tx.execute(dsql`select pg_advisory_xact_lock(390001, hashtext(${f.orgId}::text))`);
      await postEntry(tx, {
        orgId: f.orgId, entryDate: '2027-01-01', sourceType: 'opening_balance',
        sourceId: uid('op'), idempotencyKey: uid('op'), memo: 'Opening balance', postedBy: f.adminId,
        lines: [
          { accountCode: '1110', storeId: f.storeA, debit: '100.00' },
          { accountCode: '3900', storeId: f.storeA, credit: '100.00' },
        ],
      });
      locked();
      await gate;
    });

    let conn2: Promise<unknown> = Promise.resolve(null);
    try {
      await lockedP;
      // Connection 2: the writer. Without the shared lock it would commit NOW, before C5 finishes.
      conn2 = errorOf(record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' }));
      const early = await Promise.race([conn2, settle(1500)]);
      expect(early).toBe('timeout'); // blocked on the lock: neither written nor refused yet
    } finally {
      release();
      await conn1;
    }
    const outcome = await conn2;
    expect(outcome).toBeInstanceOf(RefusalError);
    expect((outcome as RefusalError).userMessage).toMatch(/books were opened/i);
    expect(await rowCount(f, f.storeA, f.item1)).toBe(0);
  }, 60_000);

  it('a SHARED holder does not block a count (writers run side by side; an exclusive lock in writers fails this)', async () => {
    const f = await fixture('lockShared');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const conn1 = asOrg(f.orgId, async (tx) => {
      await tx.execute(dsql`select pg_advisory_xact_lock_shared(390001, hashtext(${f.orgId}::text))`);
      locked();
      await gate;
    });
    try {
      await lockedP;
      const outcome = await Promise.race([
        record(f, { storeId: f.storeA, locationId: f.kitchenA, itemId: f.item1, quantity: '5' }).then(() => 'wrote' as const),
        settle(5000),
      ]);
      expect(outcome).toBe('wrote');
    } finally {
      release();
      await conn1;
    }
    expect(await rowCount(f, f.storeA, f.item1)).toBe(1);
  }, 60_000);
});
