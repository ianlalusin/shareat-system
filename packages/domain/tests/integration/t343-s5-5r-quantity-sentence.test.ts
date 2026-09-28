import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S5.5r — DEF-469. `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5r item 2.
 * S5.5r is now built and both legs below are green.
 *
 * ⛔ TESTER, not BUILDER. Before this fix, `parseQuantityInput`
 * (`packages/domain/src/trade/index.ts:110-116`) was a module-private wrapper: `try { return
 * parseQuantity(raw); } catch { throw new Error(...); }` — every failure, out-of-range or
 * malformed, got the SAME plain `Error`, no `userMessage` at all, no distinction by cause.
 * Confirmed directly (not just reasoned): the first run of this file, before `rate: '10.00'` was
 * added to each line draft below, measured `userMessage: undefined` on both legs. Not exported, so
 * exercised here through `createTradeOrder`'s own line quantity, the same wrapper it calls at
 * `:285` — `lines` needs a `rate` too, or `createTradeOrder` refuses on the missing price-list
 * quote before ever reaching the quantity parse.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createTradeOrder } from '@shareat/domain';

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

async function fixture(hint: string) {
  const code = uid(`s55r-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  const [superAdmin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Super') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${superAdmin!.id}, ${orgId}, 'super_admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${superAdmin!.id}, ${storeId})`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${storeId})`;

  const superActor = actor(orgId, superAdmin!.id);
  const item = await asOrg(orgId, (tx) =>
    createItem(tx, superActor, { code: uid('WS'), name: `Beef ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  );

  const customer = await asOrg(orgId, (tx) =>
    createCustomer(tx, actor(orgId, admin!.id), { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale', priceListId: null }),
  );

  return { orgId, storeId, admin: actor(orgId, admin!.id), itemId: item.id, customerId: customer.id };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe('Q2 (DEF-469) — a line quantity out of numeric(14,3) range says "too large", not the malformed-string sentence', () => {
  it('userMessage contains "too large" — was red before this fix: a plain Error, no userMessage at all', async () => {
    const f = await fixture('q2-toolarge');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.admin, {
          storeId: f.storeId,
          customerId: f.customerId,
          orderDate: '2026-01-10',
          lines: [{ itemId: f.itemId, quantity: '100000000000', rate: '10.00' }],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the out-of-range quantity to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage, 'must carry a userMessage').toBeDefined();
    expect(err.userMessage).toContain('too large');
    expect(err.userMessage).not.toContain('decimal places');
  });
});

describe('Q2n — a malformed (too many decimal places) quantity keeps the human label, no function name leaked', () => {
  it('userMessage contains "Line 1\'s quantity" and never "createTradeOrder" — red now: the current tree leaks the function name on the malformed arm (builder fixing)', async () => {
    const f = await fixture('q2-malformed');
    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.admin, {
          storeId: f.storeId,
          customerId: f.customerId,
          orderDate: '2026-01-10',
          lines: [{ itemId: f.itemId, quantity: '1.2345', rate: '10.00' }],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught, 'expected the malformed quantity to be refused at all').toBeInstanceOf(Error);
    const err = caught as Error & { userMessage?: string };
    expect(err.userMessage).toBeDefined();
    expect(err.userMessage).not.toContain('too large');
    expect(err.userMessage, 'wanted: the human label, not the function name').toContain("Line 1's quantity");
    expect(err.userMessage, 'wanted: no function name leaked on the malformed arm').not.toContain('createTradeOrder');
  });
});

describe('Q3 (T-343 S5.5u item 2) — scientific notation "1e15" says "too large", not the decimal-places sentence', () => {
  it(
    'wanted: userMessage contains "too large" (huge-exponent arm not yet added) — observed today ' +
      '(measured, not presumed): userMessage is the decimal-places sentence, since "1e15" fails ' +
      "parseQuantity's plain-decimal regex the same way any malformed string does",
    async () => {
      const f = await fixture('q3-exponent');
      let caught: unknown;
      try {
        await asOrg(f.orgId, (tx) =>
          createTradeOrder(tx, f.admin, {
            storeId: f.storeId,
            customerId: f.customerId,
            orderDate: '2026-01-10',
            lines: [{ itemId: f.itemId, quantity: '1e15', rate: '10.00' }],
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected the exponent-notation quantity to be refused at all').toBeInstanceOf(Error);
      const err = caught as Error & { userMessage?: string };
      expect(err.userMessage).toBeDefined();
      expect(err.userMessage).toContain('too large');
      expect(err.userMessage).not.toContain('decimal places');
    },
  );
});

describe('Q4 (S5.5u Amendment A1 item 2) — a leading-dot exponent mantissa ".5e300" also says "too large"', () => {
  it(
    'wanted: userMessage contains "too large" (huge-exponent regex needs a leading-dot arm, not yet ' +
      'built) — observed today (measured, not presumed): userMessage is the decimal-places sentence ' +
      '— the live regex /^[+-]?\\d+(\\.\\d+)?e[+-]?\\d+$/i requires a digit before the dot, which ' +
      '".5e300" lacks, so it falls through to the malformed-string arm despite the VALUE being huge',
    async () => {
      const f = await fixture('q4-leading-dot-exponent');
      let caught: unknown;
      try {
        await asOrg(f.orgId, (tx) =>
          createTradeOrder(tx, f.admin, {
            storeId: f.storeId,
            customerId: f.customerId,
            orderDate: '2026-01-10',
            lines: [{ itemId: f.itemId, quantity: '.5e300', rate: '10.00' }],
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught, 'expected the leading-dot exponent quantity to be refused at all').toBeInstanceOf(Error);
      const err = caught as Error & { userMessage?: string };
      expect(err.userMessage).toBeDefined();
      expect(err.userMessage).toContain('too large');
      expect(err.userMessage).not.toContain('decimal places');
    },
  );
});
