import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-328 Test 2(a) — docs/tasks/328-every-typed-amount-reaches-the-parser-that-already-exists.md
 * §Tests item 2(a): "trade's inputs are refused by the parser with the cashier-readable
 * sentence — reachable by parsing alone."
 *
 * ⭐ WHAT MAKES THIS DIFFERENT FROM T-327'S OWN `deliveryFee: 'abc'` TEST
 * (t327-operator-sentence-two-paths.test.ts): that file proves T-327's DATABASE backstop — the
 * `_finite_check` CHECK constraint — catches this today, and it does, at INSERT time, with a
 * `constraint_name` on it. This test asserts the OTHER thing: T-328 Invariant 4 says "T-327's
 * constraints never fire from an enumerated path. If one does, the conversion at that site is
 * wrong." So this test must fail unless the app rejects `deliveryFee: 'abc'` BEFORE any row is
 * ever attempted — i.e. via `parseMoneyInput`, not via Postgres.
 *
 * ⛔ TWO ASSERTIONS, BOTH REQUIRED, because either alone is satisfied by the wrong mechanism:
 *   1. `constraintNameOf(err)` is null — no Postgres constraint fired, i.e. no INSERT was
 *      attempted. T-327's `_finite_check` errors always carry a `constraint_name`; an app-layer
 *      `parseMoneyInput` throw is a plain `Error` and never does.
 *   2. The message is `parseMoneyInput`'s own shape — `<label> — "abc" is not a valid amount. Use
 *      at most two decimal places.` — never T-327's DB-driven sentence ("That is not a valid
 *      amount. Enter a figure like 1234.50."), which is textually different on purpose (no label,
 *      different closing clause) so the two are never confusable.
 *
 * ⭐ WHAT WOULD HAVE TO BE WRONG FOR THIS TO GO RED, AND DOES THE CODE SUPPLY IT: today,
 * `packages/domain/src/trade/index.ts` reads `deliveryFee` as `Number(input.deliveryFee ?? 0)` —
 * never through `parseMoneyInput`. `Number('abc')` is `NaN`; `NaN < 0` is `false`, so the
 * immediately-following negative-fee guard does not fire either. `total` becomes `NaN`,
 * `.toFixed(2)` normalises it to the literal string `"NaN"`, and THAT reaches
 * `tradeRepo.insertOrder`, where T-327's constraint (not this task's) is what actually throws —
 * supplying a non-null `constraint_name` and the DB sentence, failing both assertions above for
 * the real, current reason. Once Contract §4's "reads" half routes `deliveryFee` through
 * `parseMoneyInput`, the call throws synchronously before any INSERT is attempted, both
 * assertions hold, and this goes green.
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
import { createCustomer, createItem, createTradeOrder } from '@shareat/domain';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

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
  const code = uid('t328-2a');
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
 * Runs `fn`, expecting it to throw. Fails loudly if it does not — but first, if
 * `cleanupOnSuccess` is given, hands it the real result so any row the call actually wrote can be
 * deleted by explicit key before this throws. Same discipline as t327-operator-sentence-two-paths.
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
      throw new Error(`expected the app-layer parser to refuse this, but the call succeeded (cleanup also failed: ${cleanupErr})`);
    }
  }
  throw new Error('expected the app-layer parser to refuse this, but the call succeeded');
}

/** The raw driver's own structured field — never CONSTRAINT_MESSAGES, never a parse of prose. */
function constraintNameOf(err: unknown): string | null {
  const name = (err as { constraint_name?: unknown } | null)?.constraint_name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

// parseMoneyInput's own template (packages/domain/src/shared/money-input.ts), the raw value fixed
// to what this test sends. The label is deliberately NOT hard-coded — Contract §4 does not say
// what label the builder will choose for this call site, and this test should not presume it.
const PARSER_SUFFIX = ' — "abc" is not a valid amount. Use at most two decimal places.';

describe('T-328 Test 2(a) — trade\'s inputs are refused by the parser, not by the database', () => {
  it('deliveryFee: \'abc\' is refused before any row is attempted', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(),
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

    expect(
      constraintNameOf(err),
      `expected no database round trip (app-layer refusal), but got a Postgres constraint: ${JSON.stringify(err)}`,
    ).toBeNull();
    expect(err).toBeInstanceOf(Error);
    expect(
      (err as Error).message,
      `expected parseMoneyInput's own sentence ending "${PARSER_SUFFIX}", got: ${(err as Error).message}`,
    ).toContain(PARSER_SUFFIX);
  });
});
