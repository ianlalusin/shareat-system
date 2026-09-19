import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-327 test 3 — docs/tasks/327-a-poison-value-that-passes-every-guard.md §Tests item 3, as
 * strengthened by the orchestrator 2026-09-19 (3a/3b) after the auditor read the spec cold.
 *
 * ⭐ Two REAL domain paths, two DIFFERENT tables, neither needing a source change — proving §2's
 * suffix rule rather than letting one exact-name `CONSTRAINT_MESSAGES` entry pass this green:
 *
 *   1. `createTradeOrder({ ..., deliveryFee: 'abc' })` — `Number('abc')` is `NaN`, the
 *      `deliveryFee < 0` guard is false on `NaN`, and `.toFixed(2)` NORMALISES it to the literal
 *      string `"NaN"` before it reaches `trade_orders.delivery_fee`.
 *   2. `setPrice({ ..., rate: 'NaN' })` — `Number('NaN') < 0` is false, and `input.rate` is
 *      inserted VERBATIM (no `.toFixed`) into `price_list_items.rate`. A different mechanism, a
 *      different table, the same poison shape.
 *
 * ⛔ THE ACTUAL side (the message a cashier sees) MUST come from the real code, so `errorMessage`
 * is imported and called on the real caught error — that function *is* the code under test.
 * ⛔ THE EXPECTED side is a HAND-WRITTEN LITERAL, never read from `CONSTRAINT_MESSAGES` or any
 * helper that consults it — importing only `errorMessage`, never `CONSTRAINT_MESSAGES` itself, is
 * what keeps this test able to fail. If both sides came from the map, the map would define its own
 * correctness (`money-positivity-guard.test.ts`'s and this repo's own recurring lesson: a control
 * that computes its own expectation controls nothing).
 * ⛔ The constraint NAME is derived from the real driver's `err.constraint_name` field — the same
 * technique `constraint-message-lookup.test.ts` already uses — never from the map either.
 *
 * ⭐ RED TODAY, for a PRIOR reason: no `_finite_check` constraint exists yet (lane DB is at 0154,
 * deliberately not migrated — that is what makes this red real), so `provoke()` itself fails with
 * "expected a real constraint violation, but the call succeeded" before either assertion below is
 * ever reached. A wrong literal and a right literal produce the identical red right now. The
 * literal-mutation check ("change a word, watch it go red") is only meaningful once migration
 * `0155` and the `constraint-messages.ts` suffix rule both exist — done and reported separately
 * once the builder ships them, not claimed here.
 *
 * ⛔ CLEANUP — orchestrator, 2026-09-19: a red run before the migration lands means the call
 * actually SUCCEEDS, which means it actually WRITES a real row — measured live, this is precisely
 * what left 7 poisoned `trade_orders` rows and 3 poisoned `price_list_items` rows in the lane DB
 * and blocked migration `0155` when it was finally applied. `provoke()` below deletes whatever the
 * successful call created, by explicit primary/natural key, strictly AFTER capturing proof it was
 * really written (its own returned id, or the natural key `setPrice` upserts on) — never before,
 * so the red this test exists to produce stays exactly as real as it was.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createPriceList, createTradeOrder, setPrice } from '@shareat/domain';
import { errorMessage } from '../../src/lib/constraint-messages';

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

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture() {
  const code = uid('t327-op');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Store') returning id`;
  const storeId = store!.id;

  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const superAdminId = await mkPerson('Super', 'super_admin');
  const adminId = await mkPerson('Admin', 'admin');
  const managerId = await mkPerson('Manager', 'manager');

  return {
    orgId,
    storeId,
    superAdmin: actor(orgId, superAdminId),
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
  };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

/**
 * Runs `fn`, expecting it to throw a real error. Fails loudly if it does not — but first, if
 * `cleanupOnSuccess` is given, hands it the real result so the row(s) the call actually wrote can
 * be deleted by explicit key before this throws. The write already happened and is fully
 * observable (the caller has `ok`, proof it was real) before cleanup ever runs.
 */
async function provoke<T>(fn: () => Promise<T>, cleanupOnSuccess?: (ok: T) => Promise<void>): Promise<unknown> {
  let ok: T;
  try {
    ok = await fn();
  } catch (err) {
    return err;
  }
  if (cleanupOnSuccess) {
    try {
      await cleanupOnSuccess(ok);
    } catch (cleanupErr) {
      throw new Error(`expected a real constraint violation, but the call succeeded (cleanup also failed: ${cleanupErr})`);
    }
  }
  throw new Error('expected a real constraint violation, but the call succeeded');
}

/** The raw driver's own structured field — never CONSTRAINT_MESSAGES, never a parse of prose. */
function constraintNameOf(err: unknown): string | null {
  const name = (err as { constraint_name?: unknown } | null)?.constraint_name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

// ⛔ Hand-typed, verbatim from spec §2's own house-style example. Never read from
// CONSTRAINT_MESSAGES — that is the whole point of this file.
const EXPECTED_SENTENCE = 'That is not a valid amount. Enter a figure like 1234.50.';

describe('T-327 test 3 — the cashier reads a sentence, on two different constraints', () => {
  it('⛔ path 1 — createTradeOrder, deliveryFee: \'abc\' → trade_orders.delivery_fee', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: uid('WS'),
        name: `Item ${uid('n')}`,
        kind: 'raw_material',
        baseUnit: 'kg',
        sellableWholesale: true,
      }),
    );
    const customer = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }),
    );

    const err = await provoke(
      () =>
        asOrg(f.orgId, (tx) =>
          createTradeOrder(tx, f.manager, {
            storeId: f.storeId,
            customerId: customer.id,
            orderDate: '2026-01-10',
            lines: [{ itemId: item.id, quantity: '1', rate: '10' }],
            deliveryFee: 'abc',
          }),
        ),
      async (ok) => {
        await sql`delete from trade_order_lines where order_id = ${ok.orderId}`;
        await sql`delete from trade_orders where id = ${ok.orderId}`;
      },
    );

    const constraintName = constraintNameOf(err);
    expect(constraintName).toMatch(/^trade_orders_.*_finite_check$/);
    expect(errorMessage(err)).toBe(EXPECTED_SENTENCE);
  });

  it('⛔ path 2 — setPrice, rate: \'NaN\' → price_list_items.rate (a different table, a different mechanism)', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: uid('WS'),
        name: `Item ${uid('n')}`,
        kind: 'raw_material',
        baseUnit: 'kg',
        sellableWholesale: true,
      }),
    );
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));

    const err = await provoke(
      () => asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: item.id, rate: 'NaN' })),
      // `setPrice` returns void — `upsertPriceListItem` upserts on the (priceListId, itemId)
      // natural key, so that pair is what identifies the row it wrote.
      async () => {
        await sql`delete from price_list_items where price_list_id = ${list.id} and item_id = ${item.id}`;
      },
    );

    const constraintName = constraintNameOf(err);
    expect(constraintName).toMatch(/^price_list_items_.*_finite_check$/);
    expect(errorMessage(err)).toBe(EXPECTED_SENTENCE);
  });

  it('the two paths trip two DIFFERENT constraint names — proving a suffix rule, not one exact-name entry', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: uid('WS'),
        name: `Item ${uid('n')}`,
        kind: 'raw_material',
        baseUnit: 'kg',
        sellableWholesale: true,
      }),
    );
    const customer = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }),
    );
    const list = await asOrg(f.orgId, (tx) => createPriceList(tx, f.admin, { name: `List ${uid('l')}` }));

    const err1 = await provoke(
      () =>
        asOrg(f.orgId, (tx) =>
          createTradeOrder(tx, f.manager, {
            storeId: f.storeId,
            customerId: customer.id,
            orderDate: '2026-01-10',
            lines: [{ itemId: item.id, quantity: '1', rate: '10' }],
            deliveryFee: 'abc',
          }),
        ),
      async (ok) => {
        await sql`delete from trade_order_lines where order_id = ${ok.orderId}`;
        await sql`delete from trade_orders where id = ${ok.orderId}`;
      },
    );
    const err2 = await provoke(
      () => asOrg(f.orgId, (tx) => setPrice(tx, f.admin, { priceListId: list.id, itemId: item.id, rate: 'NaN' })),
      async () => {
        await sql`delete from price_list_items where price_list_id = ${list.id} and item_id = ${item.id}`;
      },
    );

    const name1 = constraintNameOf(err1);
    const name2 = constraintNameOf(err2);
    expect(name1).not.toBeNull();
    expect(name2).not.toBeNull();
    expect(name1).not.toBe(name2);
    // Same sentence from two different constraint names is exactly what a suffix rule produces —
    // and exactly what N exact-name entries with copied wording would also produce. This test
    // cannot by itself distinguish the two mechanisms (the orchestrator's own note); it raises the
    // price of faking it. Reading constraint-messages.ts settles which one shipped.
    expect(errorMessage(err1)).toBe(EXPECTED_SENTENCE);
    expect(errorMessage(err2)).toBe(EXPECTED_SENTENCE);
  });
});
