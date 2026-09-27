import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 S7 — change 5 (trade line numbers), the domain leg (N2, N2n).
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S7. Same harness as
 * `t328-trade-inputs-refused-by-parser.test.ts` (real Postgres, PROJECT_BIBLE.md §9 rule 3).
 *
 * ⛔ TESTER, not BUILDER. `packages/domain/src/trade/index.ts:220-303`'s loop still reads
 * `line ${i + 1}` everywhere (S5.5m already landed rows 31-32's third `parseMoneyInput` argument
 * as the literal `"A line's rate"` / `"A line's total"` — a fixed string, not yet `Line ${n}`).
 * `TradeLineDraft` has no `lineNo` field yet, so a line built with one carries it only because TS's
 * excess-property check does not fire on a variable (the `packages/domain/tests/integration/
 * deliveries.test.ts:704-714` R3 precedent for the exact same situation on `CreateDeliveryLineInput`).
 *
 * - N2: two valid lines, the second carrying `lineNo: 3` and a malformed `rate` → today's raw still
 *   numbers by array position (`line 2`), and today's `userMessage` is the fixed `"A line's
 *   rate — …"` label S5.5m gave it, not `"Line 3's rate — …"`.
 * - N2n: the same order with NO `lineNo` → `.message` is already byte-identical to what it will
 *   stay (`n = draft.lineNo ?? i + 1` falls through to `i + 1` either way) — green now — but
 *   `userMessage` is still `"A line's rate — …"`, not `"Line 2's rate — …"` — red.
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
import { createCustomer, createItem, createTradeOrder, type TradeLineDraft } from '@shareat/domain';
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
  const code = uid('s7-n2');
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

async function twoLineOrder(f: Awaited<ReturnType<typeof fixture>>, secondLineNo: number | undefined): Promise<unknown> {
  const item1 = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: uid('WS'), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  );
  const item2 = await asOrg(f.orgId, (tx) =>
    createItem(tx, f.superAdmin, { code: uid('WS'), name: `Item ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }),
  );
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Buyer ${uid('b')}`, customerGroup: 'wholesale' }));

  // Assigned via a variable, not an inline literal — TS's excess-property check does not fire on a
  // field `TradeLineDraft` does not declare yet (deliveries.test.ts:704-714 precedent).
  const lines: TradeLineDraft[] = [
    { itemId: item1.id, quantity: '1', rate: '10' },
    { itemId: item2.id, quantity: '1', rate: 'abc', ...(secondLineNo === undefined ? {} : { lineNo: secondLineNo }) },
  ];

  return asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, {
      storeId: f.storeId,
      customerId: customer.id,
      orderDate: '2026-01-10',
      lines,
    }),
  ).then(
    () => null,
    (e: unknown) => e,
  );
}

describe('N2 — a line refusal names the VISIBLE row (lineNo), not the post-array-position index', () => {
  it(
    'lineNo: 3 on the second (and only other) line: userMessage says "Line 3\'s rate", .message says "line 3"',
    async () => {
      const f = await fixture();
      const caught = await twoLineOrder(f, 3);

      expect(caught, 'the malformed rate was not refused at all').toBeInstanceOf(Error);
      const err = caught as Error;
      expect(errorMessage(err)).toBe('Line 3\'s rate — "abc" is not a valid amount. Use at most two decimal places.');
      expect(err.message).toBe('createTradeOrder: line 3\'s rate — "abc" is not a valid amount. Use at most two decimal places.');
    },
    30000,
  );
});

describe('N2n (⛔ .message green now; userMessage red) — no lineNo falls back to the array position', () => {
  it(
    'no lineNo on the second line: .message is byte-identical to today\'s ("line 2"); userMessage still says "Line 2\'s rate"',
    async () => {
      const f = await fixture();
      const caught = await twoLineOrder(f, undefined);

      expect(caught, 'the malformed rate was not refused at all').toBeInstanceOf(Error);
      const err = caught as Error;
      // Invariant 1/25 — byte-identical whether or not S7 has landed: `n = draft.lineNo ?? i + 1`
      // falls through to `i + 1` here either way.
      expect(err.message).toBe('createTradeOrder: line 2\'s rate — "abc" is not a valid amount. Use at most two decimal places.');
      expect(errorMessage(err)).toBe('Line 2\'s rate — "abc" is not a valid amount. Use at most two decimal places.');
    },
    30000,
  );
});
