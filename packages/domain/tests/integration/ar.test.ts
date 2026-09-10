import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-131 — accounts receivable. `docs/tasks/131-accounts-receivable.md`.
 *
 * ⭐ Three tests carry this module:
 *   1. *"a collection with a platform fee posts exactly three legs"* — the shape that stops v1's
 *      ₱198,148.29 double-count, where the same fee was recognised in the collection AND again
 *      as an expense document.
 *   2. *"a surplus becomes a 2140 liability"* — v1 stamped a boolean called
 *      `overageAsStoreCredit` with no balance anywhere behind it, used 0 times in 512.
 *   3. *"write-off is refused for the charge's own author"* — v1 has no identity check anywhere
 *      in AR, and write-off is the one action that makes a debt disappear.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { arRepo, closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createCustomer,
  recordCharge,
  recordCollection,
  voidCharge,
  voidCollection,
  writeOffCharge,
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
  const code = uid(`ar-${hint}`);
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
      (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open'),
      (${orgId}, '2026-03-01', '2026-03-31', 'open')`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const adminId = await mk('Admin', 'admin');
  const admin2Id = await mk('Second admin', 'admin');
  const managerId = await mk('Manager', 'manager');
  const [drawer] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId}
      and instrument = 'cash' and custodian = 'cashier' and is_foundation`;
  const [wallet] = await sql<{ id: string }[]>`
    select id from money_accounts where store_id = ${storeId} and instrument = 'e_wallet' limit 1`;
  const customer = await asOrg(orgId, (tx) =>
    createCustomer(tx, actor(orgId, adminId), { name: `Resto ${code}` }),
  );
  return {
    orgId, storeId, adminId, admin2Id, managerId,
    admin: actor(orgId, adminId), admin2: actor(orgId, admin2Id), manager: actor(orgId, managerId),
    drawerId: drawer!.id, walletId: wallet?.id ?? null, customerId: customer.id,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function charge(
  f: Fixture,
  amount: string,
  opts: { date?: string; dueDate?: string; by?: Actor; creditOverrideReason?: string } = {},
) {
  return asOrg(f.orgId, (tx) =>
    recordCharge(tx, opts.by ?? f.manager, {
      storeId: f.storeId,
      customerId: f.customerId,
      chargeDate: opts.date ?? '2026-01-10',
      dueDate: opts.dueDate ?? null,
      totalAmount: amount,
      revenueAccountCode: '4150',
      ...(opts.creditOverrideReason !== undefined
        ? { creditOverrideReason: opts.creditOverrideReason }
        : {}),
    }),
  );
}

async function setCreditLimit(f: Fixture, amount: string) {
  await sql`update customers set credit_limit = ${amount} where id = ${f.customerId}`;
}

interface Line { code: string; debit: string; credit: string; party_id: string | null }
async function linesFor(entryId: string): Promise<Line[]> {
  return sql<Line[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by a.code`;
}

beforeAll(async () => { await sql`select 1`; });
afterAll(async () => { await closeDb(); await sql.end({ timeout: 5 }); });

describe('a customer owes, pays, and the payment is matched to what it settles', () => {
  it('a posted charge shows as open and as a 1210 balance', async () => {
    const f = await fixture('basic');
    const { chargeId } = await charge(f, '5000.00');
    const open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open.map((o) => [o.chargeId, o.outstanding])).toEqual([[chargeId, '5000.00']]);
    const pos = await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId));
    expect(pos.controlBalance).toBe('5000.00');
  });

  it('collecting in full closes it; a partial leaves the remainder', async () => {
    const f = await fixture('partial');
    const { chargeId } = await charge(f, '5000.00');
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '2000.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '2000.00' }],
      }),
    );
    let open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open[0]!.outstanding).toBe('3000.00');

    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-25',
        amount: '3000.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '3000.00' }],
      }),
    );
    open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open).toHaveLength(0);
    expect((await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId))).controlBalance).toBe('0.00');
  });

  it('⭐ a collection WITH a platform fee posts exactly three legs — the ₱198k pattern', async () => {
    const f = await fixture('fee');
    const { chargeId } = await charge(f, '5000.00');
    const { entryId } = await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '5000.00', platformFee: '250.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '5000.00' }],
      }),
    );
    const lines = await linesFor(entryId);
    expect(lines).toHaveLength(3);
    // Only ₱4,750 actually lands; the fee is an expense; the receivable clears at GROSS.
    expect(lines.find((l) => l.code === '1110')!.debit).toBe('4750.00');
    expect(lines.find((l) => l.code === '6400')!.debit).toBe('250.00');
    expect(lines.find((l) => l.code === '1210')!.credit).toBe('5000.00');
    expect(lines.find((l) => l.code === '1210')!.party_id).toBe(f.customerId);
  });

  it('a fee of zero produces TWO legs — 6400 is absent entirely, not zero', async () => {
    const f = await fixture('nofee');
    const { chargeId } = await charge(f, '2000.00');
    const { entryId } = await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '2000.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '2000.00' }],
      }),
    );
    const lines = await linesFor(entryId);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.code === '6400')).toBe(false);
  });

  it('⭐ a surplus becomes a real 2140 liability, not a boolean on a document', async () => {
    const f = await fixture('surplus');
    const { chargeId } = await charge(f, '1000.00');
    const res = await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '1500.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '1000.00' }],
      }),
    );
    expect(res.surplus).toBe('500.00');
    const lines = await linesFor(res.entryId);
    const credit = lines.find((l) => l.code === '2140')!;
    expect(credit.credit).toBe('500.00');
    expect(credit.party_id, 'a store credit must say whose it is').toBe(f.customerId);
  });
});

describe('the refusals', () => {
  it('⛔ allocations totalling more than the collection are refused before any write', async () => {
    const f = await fixture('over');
    const { chargeId } = await charge(f, '5000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordCollection(tx, f.manager, {
          storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
          amount: '1000.00', moneyAccountId: f.drawerId,
          allocations: [{ chargeId, amountApplied: '5000.00' }],
        }),
      ),
    ).rejects.toThrow(/more than the/);
  });

  it('⛔ another customer’s charge cannot be settled here', async () => {
    const f = await fixture('other');
    const other = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Other ${uid('c')}` }));
    const { chargeId } = await charge(f, '1000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordCollection(tx, f.manager, {
          storeId: f.storeId, customerId: other.id, collectionDate: '2026-01-20',
          amount: '1000.00', moneyAccountId: f.drawerId,
          allocations: [{ chargeId, amountApplied: '1000.00' }],
        }),
      ),
    ).rejects.toThrow(/not open for this customer/);
  });

  it('⛔ a fee larger than the collection is refused — the debt cannot clear for nothing', async () => {
    const f = await fixture('bigfee');
    const { chargeId } = await charge(f, '1000.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordCollection(tx, f.manager, {
          storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
          amount: '1000.00', platformFee: '1200.00', moneyAccountId: f.drawerId,
          allocations: [{ chargeId, amountApplied: '1000.00' }],
        }),
      ),
    ).rejects.toThrow(/exceeds the/);
  });

  it('⛔ two concurrent collections cannot both settle one charge', async () => {
    const f = await fixture('race');
    const { chargeId } = await charge(f, '1000.00');
    const collect = () =>
      asOrg(f.orgId, (tx) =>
        recordCollection(tx, f.manager, {
          storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
          amount: '1000.00', moneyAccountId: f.drawerId,
          allocations: [{ chargeId, amountApplied: '1000.00' }],
        }),
      );
    const results = await Promise.allSettled([collect(), collect()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId))).controlBalance).toBe('0.00');
  });
});

describe('voiding, and write-off', () => {
  it('voiding a collection reopens the charge and leaves the original visible', async () => {
    const f = await fixture('voidcol');
    const { chargeId } = await charge(f, '1000.00');
    const { collectionId } = await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '1000.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '1000.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => voidCollection(tx, f.manager, { collectionId, reason: 'Cheque bounced' }));
    const open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open[0]!.outstanding).toBe('1000.00');
    expect((await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId))).controlBalance).toBe('1000.00');
  });

  it('a write-off posts 6860/1210 and clears the outstanding', async () => {
    const f = await fixture('wo');
    // ⚠️ Created by the MANAGER so a different admin can legitimately write it off.
    const { chargeId } = await charge(f, '1000.00', { by: f.manager });
    const { entryId } = await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin, { chargeId, amount: '1000.00', reason: 'Fully uncollectible' }),
    );
    const lines = await linesFor(entryId);
    expect(lines.find((l) => l.code === '6860')!.debit).toBe('1000.00');
    expect(lines.find((l) => l.code === '1210')!.credit).toBe('1000.00');
    const open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open).toHaveLength(0);
  });

  it('⭐⛔ the charge’s own author cannot write it off, even as an admin', async () => {
    const f = await fixture('selfwo');
    // The ADMIN records the charge this time, then tries to write off their own receivable.
    const { chargeId } = await charge(f, '1000.00', { by: f.admin });
    await expect(
      asOrg(f.orgId, (tx) =>
        writeOffCharge(tx, f.admin, { chargeId, amount: '1000.00', reason: 'Bad debt' }),
      ),
      'writing off your own receivable is how a shortfall gets buried',
    ).rejects.toThrow(/cannot also write it off/);

    // A different admin can.
    await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin2, { chargeId, amount: '1000.00', reason: 'Bad debt' }),
    );
  });

  it('⭐ a MANAGER may write off (Ian, 2026-08-28) — but still not one they recorded', async () => {
    const f = await fixture('mgrwo');
    // Recorded by an admin, so the manager is a genuine second pair of eyes.
    const { chargeId } = await charge(f, '1000.00', { by: f.admin });
    await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.manager, { chargeId, amount: '500.00', reason: 'Partly uncollectible' }),
    );
    const open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open[0]!.outstanding).toBe('500.00');

    // ⛔ And the control that actually matters still bites: the manager cannot write off a charge
    // they recorded themselves, whatever their rank.
    const own = await charge(f, '800.00', { by: f.manager });
    await expect(
      asOrg(f.orgId, (tx) =>
        writeOffCharge(tx, f.manager, { chargeId: own.chargeId, amount: '800.00', reason: 'Mine' }),
      ),
    ).rejects.toThrow(/cannot also write it off/);
  });

  it('two partial write-offs leave the right residue, each with its own entry', async () => {
    const f = await fixture('partialwo');
    const { chargeId } = await charge(f, '1000.00', { by: f.manager });
    const a = await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin, { chargeId, amount: '400.00', reason: 'Part one' }),
    );
    const b = await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin, { chargeId, amount: '250.00', reason: 'Part two' }),
    );
    expect(a.entryId).not.toBe(b.entryId);
    const open = await asOrg(f.orgId, (tx) => arRepo.openItems(tx, f.orgId, f.customerId, f.storeId));
    expect(open[0]!.outstanding).toBe('350.00');
    expect(open[0]!.writtenOffAmount).toBe('650.00');
  });
});

describe('aging — by DUE date, per bible row 162', () => {
  it('a 45-day-old charge lands in 31-60 by its DUE date, not its charge date', async () => {
    const f = await fixture('aging');
    // Charged 1 Jan but due 1 Jan too; as of 15 Feb that is 45 days overdue.
    await charge(f, '900.00', { date: '2026-01-01', dueDate: '2026-01-01' });
    const buckets = await asOrg(f.orgId, (tx) => arRepo.aging(tx, f.orgId, '2026-02-15'));
    const row = buckets.find((b) => b.customerId === f.customerId);
    expect(row!.d31to60).toBe('900.00');
    expect(row!.current).toBe('0.00');
  });

  it('a charge with NO due date ages from its own date', async () => {
    const f = await fixture('nodue');
    await charge(f, '500.00', { date: '2026-01-01' });
    const buckets = await asOrg(f.orgId, (tx) => arRepo.aging(tx, f.orgId, '2026-02-15'));
    expect(buckets.find((b) => b.customerId === f.customerId)!.d31to60).toBe('500.00');
  });
});

describe('org isolation', () => {
  it('org A’s charges are invisible to org B', async () => {
    const a = await fixture('isoA');
    const b = await fixture('isoB');
    await charge(a, '1000.00');
    const seen = await asOrg(b.orgId, (tx) => arRepo.openItems(tx, b.orgId, a.customerId, a.storeId));
    expect(seen).toHaveLength(0);
  });
});

describe('⛔ DEF-158 — recordCharge enforces the credit limit itself, not only its one caller', () => {
  it('a breach with no reason given is refused, and the message shows the arithmetic', async () => {
    const f = await fixture('def158-breach');
    await setCreditLimit(f, '500.00');
    await expect(charge(f, '900.00')).rejects.toThrow(/limit of ₱500.00/);
  });

  it('a manager may charge anyway by saying why, and it posts', async () => {
    const f = await fixture('def158-override');
    await setCreditLimit(f, '500.00');
    const result = await charge(f, '900.00', {
      creditOverrideReason: 'Paying on delivery, agreed with the owner.',
    });
    expect(result.entryId).toBeTruthy();
  });

  it('⚠️ a NULL limit never blocks — that is not the same as a limit of zero', async () => {
    const f = await fixture('def158-nolimit');
    const result = await charge(f, '99999.00');
    expect(result.entryId).toBeTruthy();
  });

  it('the limit counts what is ALREADY owed, not just this charge', async () => {
    const f = await fixture('def158-cumulative');
    await setCreditLimit(f, '1000.00');
    await charge(f, '700.00');
    await expect(charge(f, '500.00')).rejects.toThrow(/owes ₱700.00/);
  });
});

// =======================================================================================
// T-226 / DEF-190 — the registers behind `/customers/[customerId]`
//
// ⛔ These reads exist because `1210` had a raising path, a reporting path and NO clearing
// path a human could reach. The point of every assertion below is the same one: a figure
// on that page must never be a second derivation of a figure the ledger already holds —
// v1's stored `outstandingBalance` disagreed with its own inputs on 106 of 794 live rows.
// =======================================================================================

describe('T-226 — the customer detail registers', () => {
  it('⭐ the charge register agrees with openItems AND outstandingForCharge for the same charge', async () => {
    // The drift check, and the reason the three figures come out of ONE statement: three
    // derivations of one number is exactly how v1's 13.3% disagreement happened.
    const f = await fixture('t226-drift');
    const { chargeId } = await charge(f, '5000.00');
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '1200.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '1200.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin, { chargeId, amount: '300.00', reason: 'Short-paid, agreed' }),
    );

    const [list, open, one] = await asOrg(f.orgId, async (tx) => [
      await arRepo.listChargesForCustomer(tx, f.orgId, f.customerId),
      await arRepo.openItems(tx, f.orgId, f.customerId, f.storeId),
      await arRepo.outstandingForCharge(tx, f.orgId, chargeId),
    ]);
    const row = list.find((r) => r.chargeId === chargeId)!;
    expect(row.totalAmount).toBe('5000.00');
    expect(row.allocatedAmount).toBe('1200.00');
    expect(row.writtenOffAmount).toBe('300.00');
    expect(row.outstanding).toBe('3500.00');
    expect(row.outstanding).toBe(open.find((o) => o.chargeId === chargeId)!.outstanding);
    expect(row.outstanding).toBe(one);
  });

  it('⚠️ a VOIDED charge lists with outstanding 0.00 — never its arithmetic remainder', async () => {
    // Its entry was reversed, so nothing is owed. Showing the remainder would put a debt on
    // screen that `1210` does not carry, and the page would stop tying to the control account.
    const f = await fixture('t226-void');
    const { chargeId } = await charge(f, '900.00');
    await asOrg(f.orgId, (tx) => voidCharge(tx, f.manager, { chargeId, reason: 'Raised on the wrong customer' }));

    const [list, open] = await asOrg(f.orgId, async (tx) => [
      await arRepo.listChargesForCustomer(tx, f.orgId, f.customerId),
      await arRepo.openItems(tx, f.orgId, f.customerId, f.storeId),
    ]);
    const row = list.find((r) => r.chargeId === chargeId)!;
    expect(row.status).toBe('voided');
    expect(row.outstanding).toBe('0.00');
    expect(row.totalAmount).toBe('900.00'); // the document is still legible; it is not deleted
    expect(open).toEqual([]);
  });

  it('the collection register says WHICH charges each payment settled, and they sum to it', async () => {
    const f = await fixture('t226-alloc');
    const a = await charge(f, '1000.00', { date: '2026-01-05' });
    const b = await charge(f, '2000.00', { date: '2026-01-06' });
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '2500.00', moneyAccountId: f.drawerId,
        allocations: [
          { chargeId: a.chargeId, amountApplied: '1000.00' },
          { chargeId: b.chargeId, amountApplied: '1500.00' },
        ],
      }),
    );
    const list = await asOrg(f.orgId, (tx) => arRepo.listCollectionsForCustomer(tx, f.orgId, f.customerId));
    expect(list).toHaveLength(1);
    const row = list[0]!;
    expect(row.amount).toBe('2500.00');
    expect(row.moneyAccountName).toBeTruthy();
    const byCharge = new Map(row.allocations.map((x) => [x.chargeId, x.amountApplied]));
    expect(byCharge.get(a.chargeId)).toBe('1000.00');
    expect(byCharge.get(b.chargeId)).toBe('1500.00');
    const summed = row.allocations.reduce((t, x) => t + Number(x.amountApplied), 0).toFixed(2);
    expect(summed).toBe(row.amount);
  });

  it('⛔ a collection relieves 1210 by its GROSS amount, and the aging still ties to the control', async () => {
    // The fee comes out of what LANDS, never out of what the customer owed — booking it against
    // the receivable would forgive debt the customer still has. v1 recognised the same fee twice
    // (₱198,148.29, 37 documents voided); this asserts the half that keeps the books tied.
    const f = await fixture('t226-gross');
    const { chargeId } = await charge(f, '4000.00');
    const before = await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId));
    expect(before.controlBalance).toBe('4000.00');

    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '4000.00', platformFee: '150.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '4000.00' }],
      }),
    );

    const [after, agingTotal] = await asOrg(f.orgId, async (tx) => [
      await arRepo.positionOf(tx, f.orgId, f.customerId),
      await arRepo.orgAgingTotal(tx, f.orgId),
    ]);
    expect(after.controlBalance).toBe('0.00'); // relieved by 4000, NOT by 3850
    expect(agingTotal).toBe(after.controlBalance); // invariant 6, at the org level
  });

  it('a surplus becomes real store credit at 2140 that the next payment can spend', async () => {
    // v1 stamped a boolean called `overageAsStoreCredit` with no balance behind it — used 0 of
    // 512 times — so an overpayment floated, unre-appliable. Here it is a liability with a number.
    const f = await fixture('t226-surplus');
    const first = await charge(f, '1000.00', { date: '2026-01-05' });
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '1500.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId: first.chargeId, amountApplied: '1000.00' }],
      }),
    );
    expect(await asOrg(f.orgId, (tx) => arRepo.creditBalanceOf(tx, f.orgId, f.customerId))).toBe('500.00');

    const second = await charge(f, '800.00', { date: '2026-02-05' });
    await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-02-10',
        amount: '800.00', creditApplied: '500.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId: second.chargeId, amountApplied: '800.00' }],
      }),
    );
    expect(await asOrg(f.orgId, (tx) => arRepo.creditBalanceOf(tx, f.orgId, f.customerId))).toBe('0.00');
    expect((await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId))).controlBalance).toBe('0.00');
  });

  it('a partial write-off leaves the remainder, a second clears it, and the register shows both', async () => {
    // ⚠️ **The spec asked for "two identical write-offs do not collapse into one entry" and that
    // is the wrong assertion** — `postEntry`'s idempotency key is
    // `ar_write_off:{charge}:{amount}:{actor}`, so the same person writing off the same amount
    // twice is a RETRY and collapsing it is the guard working. What must stay distinct is two
    // write-offs that are genuinely different acts: different amounts, or different people.
    // Reported as a spec defect (RULES §3.4a) rather than worked around.
    const f = await fixture('t226-writeoff');
    const { chargeId } = await charge(f, '1000.00', { by: f.manager });

    const one = await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin, { chargeId, amount: '400.00', reason: 'Disputed delivery' }),
    );
    let list = await asOrg(f.orgId, (tx) => arRepo.listChargesForCustomer(tx, f.orgId, f.customerId));
    expect(list[0]!.writtenOffAmount).toBe('400.00');
    expect(list[0]!.outstanding).toBe('600.00');

    const two = await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin, { chargeId, amount: '600.00', reason: 'Closed the account' }),
    );
    expect(two.entryId).not.toBe(one.entryId);

    list = await asOrg(f.orgId, (tx) => arRepo.listChargesForCustomer(tx, f.orgId, f.customerId));
    expect(list[0]!.writtenOffAmount).toBe('1000.00');
    expect(list[0]!.outstanding).toBe('0.00');
    expect((await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId))).controlBalance).toBe('0.00');

    // Both write-offs are a HISTORY, not a total — who declared what dead, and when.
    const offs = await asOrg(f.orgId, (tx) => arRepo.listWriteOffsForCharge(tx, f.orgId, chargeId));
    expect(offs.map((o) => o.amount)).toEqual(['400.00', '600.00']);
    expect(offs.map((o) => o.reason)).toEqual(['Disputed delivery', 'Closed the account']);
    expect(new Set(offs.map((o) => o.journalEntryId)).size).toBe(2);
  });

  it('⭐ two admins writing off the SAME amount post two entries — the key carries the actor', async () => {
    const f = await fixture('t226-twoadmins');
    const { chargeId } = await charge(f, '1000.00', { by: f.manager });
    const a = await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin, { chargeId, amount: '250.00', reason: 'First tranche' }),
    );
    const b = await asOrg(f.orgId, (tx) =>
      writeOffCharge(tx, f.admin2, { chargeId, amount: '250.00', reason: 'Second tranche' }),
    );
    expect(b.entryId).not.toBe(a.entryId);
    const list = await asOrg(f.orgId, (tx) => arRepo.listChargesForCustomer(tx, f.orgId, f.customerId));
    expect(list[0]!.writtenOffAmount).toBe('500.00');
    expect(list[0]!.outstanding).toBe('500.00');
  });

  it('voiding a collection restores the position EXACTLY, and the register still shows it', async () => {
    const f = await fixture('t226-voidcol');
    const { chargeId } = await charge(f, '3000.00');
    const before = (await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId))).controlBalance;

    const { collectionId } = await asOrg(f.orgId, (tx) =>
      recordCollection(tx, f.manager, {
        storeId: f.storeId, customerId: f.customerId, collectionDate: '2026-01-20',
        amount: '1200.00', moneyAccountId: f.drawerId,
        allocations: [{ chargeId, amountApplied: '1200.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) => voidCollection(tx, f.manager, { collectionId, reason: 'Cheque bounced' }));

    const after = (await asOrg(f.orgId, (tx) => arRepo.positionOf(tx, f.orgId, f.customerId))).controlBalance;
    expect(after).toBe(before);

    // ⛔ Reversed, never deleted. The voided collection stays on the register with its allocations
    // intact — that is what lets somebody see WHY a charge that looked settled is open again.
    const list = await asOrg(f.orgId, (tx) => arRepo.listCollectionsForCustomer(tx, f.orgId, f.customerId));
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('voided');
    expect(list[0]!.allocations.map((a) => a.amountApplied)).toEqual(['1200.00']);
    const charges = await asOrg(f.orgId, (tx) => arRepo.listChargesForCustomer(tx, f.orgId, f.customerId));
    expect(charges[0]!.allocatedAmount).toBe('0.00'); // a voided collection allocates nothing
    expect(charges[0]!.outstanding).toBe('3000.00');
  });
});

describe('DEF-272 — a sub-centavo amount is refused with a written sentence, not driver text', () => {
  it('recordCharge refuses "0.004" for totalAmount', async () => {
    const f = await fixture('def272-charge');
    await expect(charge(f, '0.004')).rejects.toThrow(/recordCharge: the charge amount.*"0\.004"/);
  });

  it('recordCharge refuses "1.234" too', async () => {
    const f = await fixture('def272-precision');
    await expect(charge(f, '1.234')).rejects.toThrow(/"1\.234"/);
  });

  it('an ordinary charge still works, and the exact value posts on both legs', async () => {
    const f = await fixture('def272-happy');
    const { entryId } = await charge(f, '0.01');
    const [row] = await sql<{ debit: string; credit: string }[]>`
      select debit::text, credit::text from journal_lines where entry_id = ${entryId} order by debit desc
    `;
    expect(row!.debit).toBe('0.01');
  });
});
