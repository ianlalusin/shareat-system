import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S5.5m — DEF-454. docs/tasks/343-def-417-human-readable-refusals.md §S5.5m.
 *
 * ⛔ TESTER, not BUILDER. Every `parseMoneyInput` call site below still passes only two arguments
 * (`raw`, `rawLabel`) — `humanLabel` is optional on HEAD, so every throw is a plain, non-presentable
 * `Error` and `errorMessage()` falls through to the raw sentence (H1, H3, H4) or a `[hidden]`-redacted
 * one (H2). Every leg here is expected red until the builder adds each row's third argument.
 *
 * H1-H4: real Postgres (bible §9 rule 3), same `asOrg`/`fixture` shape as
 * `t328-trade-inputs-refused-by-parser.test.ts` and the domain-package integration suites. H5 (the
 * `createRemittanceAction` re-wrap) is a separate file — an action harness, not this one.
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
import { createCashRequest, createSalesDay, createTradeOrder, createItem, createCustomer, createSupplier, recordPayment } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { errorMessage } from '../../src/lib/constraint-messages';
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

/** One org, one store, one fiscal period, a manager and an admin — the shared floor every H leg
 *  below starts from. Each leg adds only what its own call needs. */
async function baseFixture(hint: string) {
  const code = uid(`s55m-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('store')}, 'Store') returning id`;
  const storeId = store!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mkPerson('Manager', 'manager');
  const adminId = await mkPerson('Admin', 'admin');
  const superAdminId = await mkPerson('Super Admin', 'super_admin');
  return {
    orgId,
    storeId,
    manager: actor(orgId, managerId),
    admin: actor(orgId, adminId),
    superAdmin: actor(orgId, superAdminId),
  };
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const SUFFIX = (typed: string) => ` — "${typed}" is not a valid amount. Use at most two decimal places.`;

describe('H1 — createSalesDay tender: a mistyped amount on "GCash" names the wallet, not the raw label', () => {
  it('tender "abc" on GCash', async () => {
    const f = await baseFixture('h1');
    const [wallet] = await sql<{ id: string }[]>`
      insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
      values (${f.orgId}, ${f.storeId}, 'GCash', 'ewallet', '1140', 'cashier') returning id`;

    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createSalesDay(tx, f.manager, {
          storeId: f.storeId,
          businessDate: '2026-01-10',
          totalSales: '1000.00',
          unliSales: '1000.00',
          alaCarteSales: '0.00',
          cashCollected: '1000.00',
          tenders: [{ moneyAccountId: wallet!.id, amount: 'abc' }],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toBe(`The amount for "GCash"${SUFFIX('abc')}`);
    // H6 — the raw diagnostic stays byte-identical (Invariant 1).
    expect((caught as Error).message).toBe(`sales day tenders: "GCash"'s amount${SUFFIX('abc')}`);
  });
});

describe('H2 — recordPayment: the payment amount and an allocation each name themselves, no id leaks', () => {
  it('amount "1.234" → The payment amount', async () => {
    const f = await baseFixture('h2a');
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `${uid('sup')}` }));

    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId,
          supplierId: supplier.id,
          businessDate: '2026-01-15',
          amount: '1.234',
          moneyAccountId: uid('acct'), // never reached — the amount parse throws first
          allocations: [{ expenseId: uid('exp'), amountApplied: '1.00' }],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toBe(`The payment amount${SUFFIX('1.234')}`);
    expect((caught as Error).message).toBe(`recordPayment: the amount${SUFFIX('1.234')}`);
  });

  it('an allocation "abc" → An amount applied to an invoice, no UUID, no [hidden]', async () => {
    const f = await baseFixture('h2b');
    const supplier = await asOrg(f.orgId, (tx) => createSupplier(tx, f.manager, { name: `${uid('sup')}` }));
    const fakeExpenseId = '01a0db2b-f5da-759b-a288-d3803c68dcf6'; // well-formed UUID shape; never looked up

    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        recordPayment(tx, f.manager, { requestId: crypto.randomUUID(),
          storeId: f.storeId,
          supplierId: supplier.id,
          businessDate: '2026-01-15',
          amount: '500.00',
          moneyAccountId: uid('acct'),
          allocations: [{ expenseId: fakeExpenseId, amountApplied: 'abc' }],
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const shown = errorMessage(caught);
    expect(shown).toBe(`An amount applied to an invoice${SUFFIX('abc')}`);
    expect(shown).not.toContain('[hidden]');
    expect(shown).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect((caught as Error).message).toBe(`recordPayment: the allocation for expense ${fakeExpenseId}${SUFFIX('abc')}`);
  });
});

describe('H3 — createTradeOrder: deliveryFee "abc" → The delivery fee', () => {
  it('delivery fee "abc"', async () => {
    const f = await baseFixture('h3');
    const item = await asOrg(f.orgId, (tx) =>
      createItem(tx, f.superAdmin, { code: testItemCode(), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
    );
    const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));

    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createTradeOrder(tx, f.manager, {
          storeId: f.storeId,
          customerId: customer.id,
          orderDate: '2026-01-10',
          lines: [{ itemId: item.id, quantity: '1', rate: '10' }],
          deliveryFee: 'abc',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toBe(`The delivery fee${SUFFIX('abc')}`);
    expect((caught as Error).message).toBe('trade.createTradeOrder.deliveryFee: money check failed');
  });
});

describe('H4 — createCashRequest: amount "abc" → The amount requested', () => {
  it('amount "abc"', async () => {
    const f = await baseFixture('h4');

    let caught: unknown;
    try {
      await asOrg(f.orgId, (tx) =>
        createCashRequest(tx, f.manager, {
          storeId: f.storeId,
          requestedFor: f.manager.personId,
          purpose: 'Market run',
          amount: 'abc',
          on: '2026-01-05',
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorMessage(caught)).toBe(`The amount requested${SUFFIX('abc')}`);
    expect((caught as Error).message).toBe('cash-requests.create.amount: money check failed');
  });
});
