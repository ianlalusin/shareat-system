import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-330 — auto-allocate a payment, oldest first. docs/tasks/330-auto-allocate-a-payment-oldest-first.md.
 *
 * ⛔ Targets `suggestCollectionAllocation(tx, actor, storeId, amount, open, keys)` against
 * AMENDMENT 3's deliberately-empty stub (AMENDMENT 4 added `storeId` as the third argument).
 * Mirrors ap-auto-allocate.test.ts. `ar_charges` IS the allocation grain (no join needed for the
 * ordering keys), but AMENDMENT 4 found AR had the SAME defect AP's `created_at` did — `defaultNow()`
 * ties within one transaction — so AR's final tie-break is `id` too, not `created_at`.
 *
 * ⛔ `dueDate` is handed in RAW (nullable) alongside a NOT-NULL `chargeDate` fallback — the PURE
 * module resolves `dueDate ?? chargeDate` itself, not this file's key lookup.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { money } from '@shareat/core/money';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { arRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import {
  createCustomer,
  recordCharge,
  recordCollection,
  // ⛔ DOES NOT EXIST YET — the contract the amended spec names; see the header comment in
  // ap-auto-allocate.test.ts for the `tx`-parameter assumption this file makes too.
  suggestCollectionAllocation,
} from '@shareat/domain';

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
  const code = uid(`araauto-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const storeId = store!.id;
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const staffId = await mk('Staff', 'staff');
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const manager = actor(orgId, managerId);
  // ⚠️ createCustomer needs manage_chart_of_accounts (ADR-008), which is admin+, not manager —
  // matching ar.test.ts's own fixture, which uses admin for exactly this call.
  const customer = await asOrg(orgId, (tx) => createCustomer(tx, actor(orgId, adminId), { name: `Resto ${code}` }));
  return {
    orgId, storeId, adminId, managerId, staffId, manager, staff: actor(orgId, staffId),
    drawerId: drawer!.id, customerId: customer.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function charge(
  f: Fixture,
  amount: string,
  opts: { chargeDate?: string; dueDate?: string | null; referenceNo?: string | null } = {},
) {
  return asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.manager, {
      storeId: f.storeId,
      customerId: f.customerId,
      chargeDate: opts.chargeDate ?? '2026-01-10',
      dueDate: opts.dueDate ?? null,
      referenceNo: opts.referenceNo ?? null,
      totalAmount: amount,
      revenueAccountCode: '4150',
    }),
  );
}

/** The narrow ordering-key lookup ruling 1 describes. AR's grain is the charge row itself, so this
 *  is a direct select, no join. ⛔ AMENDMENT 4 (final): `dueDate` is RAW/nullable, `chargeDate` is
 *  the NOT-NULL fallback resolved by the pure module itself — this lookup does not coalesce, and
 *  `createdAt` stays gone (it tied within one transaction just like AP's did; F3+F7). */
interface ArOrderingKeys {
  chargeId: string;
  dueDate: string | null;
  chargeDate: string;
  referenceNo: string | null;
}
async function orderingKeysFor(chargeIds: string[]): Promise<ArOrderingKeys[]> {
  if (chargeIds.length === 0) return [];
  const rows = await sql<{ charge_id: string; due_date: string | null; charge_date: string; reference_no: string | null }[]>`
    select id as charge_id, due_date::text as due_date, charge_date::text as charge_date, reference_no
    from ar_charges where id = any(${chargeIds})
  `;
  return rows.map((r) => ({
    chargeId: r.charge_id,
    dueDate: r.due_date,
    chargeDate: r.charge_date,
    referenceNo: r.reference_no,
  }));
}

/** ⭐ AMENDMENT 4: `storeId` is now a required third argument — the caller's own duty to prove
 *  `open` was fetched store-scoped. */
async function suggest(f: Fixture, who: Actor, amount: string) {
  return asOrg(f.orgId, async (tx) => {
    const open = await arRepo.openItems(tx, f.orgId, f.customerId, f.storeId);
    const keys = await orderingKeysFor(open.map((o) => o.chargeId));
    return suggestCollectionAllocation(tx, who, f.storeId, amount, open, keys);
  });
}

beforeAll(async () => { await sql`select 1`; });
afterAll(async () => { await closeDb(); await sql.end({ timeout: 5 }); });

describe('T-330 — suggestCollectionAllocation', () => {
  it('1. exhausts the payment across three outstanding charges, all to zero', async () => {
    const f = await fixture('exhaust');
    await charge(f, '1000.00', { dueDate: '2026-01-05', referenceNo: 'X-1' });
    await charge(f, '2000.00', { dueDate: '2026-01-10', referenceNo: 'X-2' });
    await charge(f, '1500.00', { dueDate: '2026-01-15', referenceNo: 'X-3' });

    const result = await suggest(f, f.manager, '4500.00');
    expect(result.surplus).toBe('0.00');
    const total = result.allocations.reduce((s, a) => s + Number(a.amountApplied), 0);
    expect(total.toFixed(2)).toBe('4500.00');

    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '4500.00', moneyAccountId: f.drawerId, allocations: result.allocations,
      }),
    );
    const open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open).toHaveLength(0);
  });

  it('2. a payment smaller than the oldest charge allocates that charge only, partially', async () => {
    const f = await fixture('partial');
    await charge(f, '1000.00', { dueDate: '2026-01-05', referenceNo: 'P-1' });
    await charge(f, '2000.00', { dueDate: '2026-01-20', referenceNo: 'P-2' });

    const result = await suggest(f, f.manager, '400.00');
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.amountApplied).toBe('400.00');
    expect(result.surplus).toBe('0.00');
  });

  it('3. ⭐ oldest by due_date, tie-broken by reference_no then id — two charges coincidentally share both', async () => {
    const f = await fixture('order');
    // Insertion order deliberately scrambled: a1, then b, then a2. a1's uuidv7 id is smaller than
    // a2's (created first), which is the only thing separating them once due_date and reference_no
    // both tie — AMENDMENT 4 found AR needed this same fix AP did (created_at ties within a
    // transaction on both sides), so `id` is the tie-break here too, not `created_at`.
    const a1 = await charge(f, '1000.00', { dueDate: '2026-01-10', referenceNo: 'A-1' }); // created first — must win the tie
    const b = await charge(f, '2000.00', { dueDate: '2026-01-05', referenceNo: 'B-1' }); // most overdue — must go first overall
    const a2 = await charge(f, '1500.00', { dueDate: '2026-01-10', referenceNo: 'A-1' }); // same due_date AND reference_no as a1 — must lose the tie

    const result = await suggest(f, f.manager, '2500.00');
    expect(result.allocations).toEqual([
      { chargeId: b.chargeId, amountApplied: '2000.00' },
      { chargeId: a1.chargeId, amountApplied: '500.00' },
    ]);
    expect(result.surplus).toBe('0.00');
    expect(result.allocations.some((a) => a.chargeId === a2.chargeId)).toBe(false);
  });

  it("3b. ⭐⭐ an undated charge falls back to its charge date and can outrank a charge with a real, later due date — Ian's reversal (AMENDMENT 4)", async () => {
    const f = await fixture('coalesce');
    // dueDate: null is passed through RAW — the fallback to charge_date happens inside
    // suggestCollectionAllocation / the pure module, not in this fixture or the keys lookup.
    const jan = await charge(f, '50000.00', { chargeDate: '2026-01-15', dueDate: null, referenceNo: 'JAN-1' });
    await charge(f, '10000.00', { chargeDate: '2026-01-20', dueDate: '2026-09-25', referenceNo: 'SEP-1' });

    const result = await suggest(f, f.manager, '10000.00');
    expect(result.allocations).toEqual([{ chargeId: jan.chargeId, amountApplied: '10000.00' }]);
    expect(result.surplus).toBe('0.00');
  });

  it("⛔ refuses an item whose storeId differs from the one named — the caller's own store-scope duty (AMENDMENT 4)", async () => {
    const f = await fixture('crossstore');
    await charge(f, '1000.00', { dueDate: '2026-01-05', referenceNo: 'CS-1' });
    const [otherStore] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${f.orgId}, ${uid('other')}, 'Other Store') returning id
    `;

    await expect(
      asOrg(f.orgId, async (tx) => {
        const open = await arRepo.openItems(tx, f.orgId, f.customerId, f.storeId);
        const keys = await orderingKeysFor(open.map((o) => o.chargeId));
        const tampered = open.map((o) => ({ ...o, storeId: otherStore!.id }));
        return suggestCollectionAllocation(tx, f.manager, f.storeId, '500.00', tampered, keys);
      }),
    ).rejects.toThrow(/outside the collection's own store/);
  });

  it("⛔ Q3 — an `open` id with no matching `keys` entry is refused, fail closed, not sorted first or last (AMENDMENT 4 spec table)", async () => {
    const f = await fixture('nokeys');
    await charge(f, '1000.00', { dueDate: '2026-01-05', referenceNo: 'NK-1' });

    await expect(
      asOrg(f.orgId, async (tx) => {
        const open = await arRepo.openItems(tx, f.orgId, f.customerId, f.storeId);
        const keys = await orderingKeysFor(open.map((o) => o.chargeId));
        // Simulates a keys lookup that silently dropped a row — `open` still names a charge
        // `keys` says nothing about. The ruling is THROW, never synthesize a fallback key
        // (`chargeDate: ''` sorts before every real date — undated-first again, a third route).
        const partial = keys.slice(1);
        return suggestCollectionAllocation(tx, f.manager, f.storeId, '500.00', open, partial);
      }),
      // ⚠️ Message-asserted, not bare — same reasoning as the storeId case just above.
    ).rejects.toThrow(/has no ordering key/);
  });

  it("2b. ⭐ AMENDMENT 7 — the payment available is reduced by the typed sum, and the merged array still posts cleanly through recordCollection's own guard", async () => {
    const f = await fixture('typed-reduce');
    const typedCharge = await charge(f, '1000.00', { dueDate: '2026-01-01', referenceNo: 'TY-1' });
    const openCharge = await charge(f, '2000.00', { dueDate: '2026-01-05', referenceNo: 'OP-1' });

    const typed = [{ id: typedCharge.chargeId, amount: money('300.00') }];
    const result = await asOrg(f.orgId, async (tx) => {
      const open = await arRepo.openItems(tx, f.orgId, f.customerId, f.storeId);
      const keys = await orderingKeysFor(open.map((o) => o.chargeId));
      return suggestCollectionAllocation(tx, f.manager, f.storeId, '800.00', open, keys, typed);
    });

    expect(result.allocations).toEqual([{ chargeId: openCharge.chargeId, amountApplied: '500.00' }]);
    expect(result.surplus).toBe('0.00');

    const merged = [
      { chargeId: typedCharge.chargeId, amountApplied: '300.00' },
      ...result.allocations,
    ];
    const posted = await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '800.00', moneyAccountId: f.drawerId, allocations: merged,
      }),
    );
    expect(posted.allocated).toBe('800.00');
    expect(posted.surplus).toBe('0.00');
  });

  it('4. a payment exceeding everything outstanding leaves the exact surplus, before posting', async () => {
    const f = await fixture('remainder');
    const a = await charge(f, '1000.00', { dueDate: '2026-01-05', referenceNo: 'R-1' });

    const result = await suggest(f, f.manager, '1500.00');
    expect(result.allocations).toEqual([{ chargeId: a.chargeId, amountApplied: '1000.00' }]);
    expect(result.surplus).toBe('500.00');
  });

  it('⛔ a staff-role actor is refused — this is a new read path over the counterparty\'s ledger and must be gated like recordCollection', async () => {
    const f = await fixture('unauth');
    await charge(f, '1000.00', { dueDate: '2026-01-05', referenceNo: 'U-1' });

    // ⚠️ Specifically an AuthorizationError — see ap-auto-allocate.test.ts's identical comment: a
    // bare `.rejects.toThrow()` would pass right now for the wrong reason (not a function yet).
    await expect(suggest(f, f.staff, '500.00')).rejects.toThrow(AuthorizationError);
  });

  it("6'. ⭐ the surplus is provable from the DOUBLE ENTRY (Cr 2140, store credit), not from re-evaluating the same subtraction twice", async () => {
    // ⛔ FIXED per AMENDMENT 4 F5 — same defect and same fix as AP's 6': comparing
    // `posted.surplus` to `result.surplus` is one formula evaluated twice over the identical
    // `allocations` array. Read the credit balance out of the ledger instead.
    const f = await fixture('agree');
    await charge(f, '1000.00', { dueDate: '2026-01-05', referenceNo: 'G-1' });

    const before = await asOrg(f.orgId, (tx) => arRepo.creditBalanceOf(tx, f.orgId, f.customerId));

    const result = await suggest(f, f.manager, '1300.00');
    expect(result.surplus).toBe('300.00');

    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '1300.00', moneyAccountId: f.drawerId, allocations: result.allocations,
      }),
    );

    const after = await asOrg(f.orgId, (tx) => arRepo.creditBalanceOf(tx, f.orgId, f.customerId));
    expect((Number(after) - Number(before)).toFixed(2)).toBe(result.surplus);
  });
});
