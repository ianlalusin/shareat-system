import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-328 — the rate-message defect the orchestrator named while answering Q1/Q2, filed against
 * this task's own spec as §6(b)-adjacent: NOT a NaN-safety gap (the call already throws today —
 * `createTradeOrder`'s existing `lineTotal = parseMoneyInput((quantity * rate).toFixed(2), ...)`
 * already routes a bad rate through the parser), and explicitly NOT to be described as one.
 *
 * ⛔ THE DEFECT: with `rate: 'abc'`, the operator TYPED the rate box wrong, but the sentence they
 * read blames "line 1's total" — the DERIVED field, not the one they touched. The label passed to
 * `parseMoneyInput` at the `lineTotal` call site
 * (`createTradeOrder: line ${i + 1}'s total`) never mentions "rate", so a person acting on this
 * message corrects the wrong box.
 *
 * ⭐ WHAT WOULD HAVE TO BE WRONG FOR THIS TO GO RED, AND DOES THE CODE SUPPLY IT: today the label
 * is hard-coded to `line N's total`. This test asserts the thrown message names "rate" (case
 * insensitive) when the LINE'S RATE is the malformed input — it does not today, so this reds on
 * the literal current string, not on an import failure or an absence of any exception at all.
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
  const code = uid('t328-rate');
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
    orgId, storeId,
    superAdmin: actor(orgId, superAdminId),
    admin: actor(orgId, adminId),
    manager: actor(orgId, managerId),
  };
}

afterAll(async () => { await sql.end({ timeout: 5 }); });

describe('T-328 — a bad rate must be blamed on the rate, not on the total it produces', () => {
  it('rate: \'abc\' throws a sentence naming "rate", not only "total"', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true,
      }),
    );
    const customer = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }),
    );

    let thrown: Error | undefined;
    try {
      await asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId,
          customerId: customer.id,
          orderDate: '2026-01-10',
          lines: [{ itemId: item.id, quantity: '1', rate: 'abc' }],
        }),
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown, 'expected createTradeOrder to refuse rate: \'abc\'').toBeInstanceOf(Error);
    expect(
      thrown!.message,
      `expected the sentence to name "rate" (the field the operator typed), got: ${thrown!.message}`,
    ).toMatch(/rate/i);
  });

  /**
   * ⭐ THE PARALLEL CASE, same mechanism, different field: `Number(draft.quantity) <= 0` is also
   * `false` for `NaN` (`draft.quantity: 'abc'`), so that guard does not fire either, and the SAME
   * `lineTotal = parseMoneyInput((quantity * rate).toFixed(2), 'line N's total')` throws blaming
   * "total" when QUANTITY is what the operator mistyped. Same defect class as the rate test above,
   * named separately because it is a different field and a different red.
   */
  it('quantity: \'abc\' throws a sentence naming "quantity", not only "total"', async () => {
    const f = await fixture();
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, {
        code: testItemCode(), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true,
      }),
    );
    const customer = await asOrg(f.orgId, (tx) =>
      createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }),
    );

    let thrown: Error | undefined;
    try {
      await asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId,
          customerId: customer.id,
          orderDate: '2026-01-10',
          lines: [{ itemId: item.id, quantity: 'abc', rate: '10' }],
        }),
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown, 'expected createTradeOrder to refuse quantity: \'abc\'').toBeInstanceOf(Error);
    expect(
      thrown!.message,
      `expected the sentence to name "quantity" (the field the operator typed), got: ${thrown!.message}`,
    ).toMatch(/quantity/i);
  });
});
