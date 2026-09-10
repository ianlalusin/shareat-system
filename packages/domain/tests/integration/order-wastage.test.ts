import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-178 — order/channel wastage disposition. `docs/tasks/178-channel-wastage-disposition.md`.
 *
 * ⚠️ NOT stock wastage (T-168). Test 1 is the one that proves it: every disposition here is
 * asserted against UNCHANGED stock tables.
 *
 * ⭐ Fixture pattern mirrors `channel-settlements.test.ts` (T-150) rather than the truncate-based
 * `commissary-discrepancy.test.ts`: a fresh org per test via `fixture()`, because several tests
 * here need a REAL T-150 settlement (test 8) and this file's own `asOrg` RLS-scoped transaction.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { APP_ROLE, closeDb, orderWastageRepo, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { recordChannelSettlement } from '../../src/channel-settlements';
import { listPostedSettlementsForStore } from '../../src/channel-settlements';
import { matchWastagesToSettlement, type SettleableOrderWastage } from '../../src/wastage/settlement-match';
import { postEntry } from '../../src/ledger/post-entry';
import {
  __setPhase5AvailableForTests,
  disputeOrderWastage,
  recordOrderWastage,
  resolveOrderWastage,
  reverseAutoCharge,
  runOrderWastageBackstop,
} from '../../src/wastage/orders';

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

const actorOf = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function fixture(hint: string) {
  const code = uid(`ow-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  // A generous open window so a backstop `now` weeks after the original businessDate still
  // resolves to a covering period, except where a test deliberately closes one (test 12).
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open'),
      (${orgId}, '2026-03-01', '2026-03-31', 'open')`;

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store A') returning id`;
  const storeId = store!.id;

  const [manager] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;

  const [monitor] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Wastage Monitor') returning id`;
  const [staffA] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff A') returning id`;
  const [staffB] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff B') returning id`;

  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;

  const [channel] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code,
                                destination_money_account_id)
    values (${orgId}, ${storeId}, 'Foodpanda', false, '1220', ${bank!.id}) returning id`;

  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${storeId}, '2026-01-10', 0, 0, 0, ${manager!.id}) returning id`;

  return {
    orgId, storeId, channelId: channel!.id, salesDayId: day!.id, bankId: bank!.id,
    managerId: manager!.id, monitorId: monitor!.id, staffAId: staffA!.id, staffBId: staffB!.id,
    manager: actorOf(orgId, manager!.id),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setMonitor(f: Fixture, personId: string | null) {
  await sql`update stores set wastage_monitor_person_id = ${personId} where id = ${f.storeId}`;
}

/** Raise the 1220 receivable a verified channel-day would have raised. */
async function raiseReceivable(f: Fixture, amount: string, date = '2026-01-10') {
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId, entryDate: date, sourceType: 'sales_day', sourceId: f.salesDayId,
      idempotencyKey: `sales_day:${f.salesDayId}:${amount}:${date}`, memo: 'Channel day',
      postedBy: f.managerId,
      lines: [
        { accountCode: '1220', storeId: f.storeId, debit: amount, partyType: 'channel', partyId: f.channelId },
        { accountCode: '4150', storeId: f.storeId, credit: amount },
      ],
    }),
  );
}

async function legsOf(entryId: string) {
  return sql<{ code: string; debit: string; credit: string; party_type: string | null; party_id: string | null }[]>`
    select a.code, jl.debit::text, jl.credit::text, jl.party_type, jl.party_id
    from journal_lines jl join accounts a on a.id = jl.account_id
    where jl.entry_id = ${entryId} order by a.code, jl.debit desc`;
}

async function stockTableCounts(orgId: string) {
  const [row] = await sql<{ movements: string; layers: string; usage: string }[]>`
    select
      (select count(*) from stock_movements where org_id = ${orgId})::text as movements,
      (select count(*) from stock_layers where org_id = ${orgId})::text as layers,
      (select count(*) from stock_usage_records where org_id = ${orgId})::text as usage`;
  return { movements: Number(row!.movements), layers: Number(row!.layers), usage: Number(row!.usage) };
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// =====================================================================================
// Test 1 — no stock movement, ever.
// =====================================================================================

describe('T-178 test 1 — ⭐ no stock moves, whatever the disposition', () => {
  it('record + resolve absorbed + resolve charged (Phase 5 forced on) + backstop leave every stock table untouched', async () => {
    const f = await fixture('nostock');
    const before = await stockTableCounts(f.orgId);
    expect(before).toEqual({ movements: 0, layers: 0, usage: 0 });

    await raiseReceivable(f, '500.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '100.00', reason: 'remade order', openedOn: '2026-01-10',
        allocations: [{ personId: f.staffAId, percent: '100.00' }],
      }),
    );
    await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, {
        wastageId: rec.id, storeId: f.storeId, disposition: 'absorbed', resolvedOn: '2026-01-11',
      }),
    );

    const restore = __setPhase5AvailableForTests(true);
    try {
      await raiseReceivable(f, '80.00', '2026-01-12');
      const rec2 = await asOrg(f.orgId, (tx) =>
        recordOrderWastage(tx, f.manager, {
          storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
          amount: '80.00', reason: 'refund', openedOn: '2026-01-12',
          allocations: [{ personId: f.staffAId, percent: '100.00' }],
        }),
      );
      await asOrg(f.orgId, (tx) =>
        resolveOrderWastage(tx, f.manager, {
          wastageId: rec2.id, storeId: f.storeId, disposition: 'charged', resolvedOn: '2026-01-13',
        }),
      );
    } finally {
      restore();
    }

    await sql`update order_wastages set opened_at = opened_at - interval '20 days' where org_id = ${f.orgId} and status = 'open'`;
    await asOrg(f.orgId, (tx) => runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-30T00:00:00Z'), postedBy: null }));

    expect(await stockTableCounts(f.orgId)).toEqual({ movements: 0, layers: 0, usage: 0 });
  });
});

// =====================================================================================
// Test 2 — the Monitor default (invariant 2).
// =====================================================================================

describe('T-178 test 2 — a tracked wastage with no allocation gets the Monitor', () => {
  it('seeds the store Monitor at 100% when none is supplied', async () => {
    const f = await fixture('monitor');
    await setMonitor(f, f.monitorId);
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '75.00', reason: 'no allocation given', openedOn: '2026-01-10',
      }),
    );
    const allocations = await asOrg(f.orgId, (tx) => orderWastageRepo.listAllocations(tx, rec.id));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.personId).toBe(f.monitorId);
    expect(allocations[0]!.percent).toBe('100.00');
  });

  it('⚠️ with no Monitor configured, the wastage is created with no allocation — never a synthetic owner', async () => {
    const f = await fixture('nomonitor');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '75.00', reason: 'no monitor either', openedOn: '2026-01-10',
      }),
    );
    const allocations = await asOrg(f.orgId, (tx) => orderWastageRepo.listAllocations(tx, rec.id));
    expect(allocations).toHaveLength(0);
  });
});

// =====================================================================================
// Test 3 — allocation percentages must sum to exactly 100 (DB-checked).
// =====================================================================================

describe('T-178 test 3 — allocation percentages sum to exactly 100', () => {
  it('60/30 is refused', async () => {
    const f = await fixture('sum60-30');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordOrderWastage(tx, f.manager, {
          storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
          amount: '100.00', reason: 'bad split', openedOn: '2026-01-10',
          allocations: [
            { personId: f.staffAId, percent: '60.00' },
            { personId: f.staffBId, percent: '30.00' },
          ],
        }),
      ),
    ).rejects.toThrow(/not 100/);
  });

  it('60/40 is accepted', async () => {
    const f = await fixture('sum60-40');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '100.00', reason: 'good split', openedOn: '2026-01-10',
        allocations: [
          { personId: f.staffAId, percent: '60.00' },
          { personId: f.staffBId, percent: '40.00' },
        ],
      }),
    );
    const allocations = await asOrg(f.orgId, (tx) => orderWastageRepo.listAllocations(tx, rec.id));
    expect(allocations).toHaveLength(2);
  });
});

// =====================================================================================
// Test 4 — the backstop fires for a DISPUTED record too (the removed carve-out).
// =====================================================================================

describe('T-178 test 4 — ⭐ the backstop fires at 15 days for a DISPUTED record', () => {
  it('a disputed record past 15 days is closed by the backstop, exactly like an open one', async () => {
    const f = await fixture('disputed15');
    await raiseReceivable(f, '200.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '150.00', reason: 'disputed order', openedOn: '2026-01-10',
      }),
    );
    const disputed = await asOrg(f.orgId, (tx) =>
      disputeOrderWastage(tx, f.manager, { wastageId: rec.id, storeId: f.storeId }),
    );
    expect(disputed.ok).toBe(true);

    await sql`update order_wastages set opened_at = '2026-01-01T00:00:00Z' where id = ${rec.id}`;
    const result = await asOrg(f.orgId, (tx) =>
      runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-20T00:00:00Z'), postedBy: null }),
    );
    expect(result.outcomes.map((o) => o.wastageId)).toContain(rec.id);

    const [row] = await sql<{ status: string; auto_charged: boolean }[]>`
      select status, auto_charged from order_wastages where id = ${rec.id}`;
    expect(row!.status).toBe('resolved');
    expect(row!.auto_charged).toBe(true);
  });
});

// =====================================================================================
// Test 5 — the backstop's three fallback tiers.
// =====================================================================================

describe('T-178 test 5 — the backstop fallback order: allocated split -> Monitor -> store absorbs', () => {
  async function backdatedTracked(f: Fixture, amount: string, allocations?: { personId: string; percent: string }[]) {
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount, reason: 'backstop tier test', openedOn: '2026-01-10', allocations,
      }),
    );
    await sql`update order_wastages set opened_at = '2026-01-01T00:00:00Z' where id = ${rec.id}`;
    return rec.id;
  }

  it('with an ALLOCATION, the backstop would charge it — degrades to absorbed while Phase 5 is off, and says so', async () => {
    const f = await fixture('tier1');
    await raiseReceivable(f, '90.00');
    const id = await backdatedTracked(f, '90.00', [{ personId: f.staffAId, percent: '100.00' }]);
    const result = await asOrg(f.orgId, (tx) =>
      runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-20T00:00:00Z'), postedBy: null }),
    );
    const outcome = result.outcomes.find((o) => o.wastageId === id)!;
    expect(outcome.degraded).toBe(true);
    expect(outcome.disposition).toBe('absorbed');
    const [entry] = await sql<{ memo: string }[]>`select memo from journal_entries where id = ${outcome.journalEntryId}`;
    expect(entry!.memo).toMatch(/degraded to store-absorbed/i);
  });

  it('with NO allocation but a MONITOR, the backstop would charge the Monitor — degrades the same way', async () => {
    const f = await fixture('tier2');
    await setMonitor(f, f.monitorId);
    await raiseReceivable(f, '60.00');
    const id = await backdatedTracked(f, '60.00');
    const result = await asOrg(f.orgId, (tx) =>
      runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-20T00:00:00Z'), postedBy: null }),
    );
    const outcome = result.outcomes.find((o) => o.wastageId === id)!;
    expect(outcome.degraded).toBe(true);
    expect(outcome.disposition).toBe('absorbed');
  });

  it('with NO allocation and NO Monitor, the store absorbs net-zero — never flagged as degraded', async () => {
    const f = await fixture('tier3');
    await raiseReceivable(f, '45.00');
    const id = await backdatedTracked(f, '45.00');
    const result = await asOrg(f.orgId, (tx) =>
      runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-20T00:00:00Z'), postedBy: null }),
    );
    const outcome = result.outcomes.find((o) => o.wastageId === id)!;
    expect(outcome.degraded).toBe(false);
    expect(outcome.disposition).toBe('absorbed');
    const [entry] = await sql<{ memo: string }[]>`select memo from journal_entries where id = ${outcome.journalEntryId}`;
    expect(entry!.memo).not.toMatch(/degraded/i);
  });
});

// =====================================================================================
// Test 6 — the three postings (charged forced on, to prove the SHAPE).
// =====================================================================================

describe('T-178 test 6 — the postings: absorbed / charged (split) / platform_paid', () => {
  it('absorbed posts Dr 5300 / Cr 1220', async () => {
    const f = await fixture('post-absorbed');
    await raiseReceivable(f, '300.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '300.00', reason: 'absorbed test', openedOn: '2026-01-10',
      }),
    );
    const res = await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, { wastageId: rec.id, storeId: f.storeId, disposition: 'absorbed', resolvedOn: '2026-01-11' }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const legs = await legsOf(res.journalEntryId!);
    expect(Number(legs.find((l) => l.code === '5300')!.debit)).toBe(300);
    expect(Number(legs.find((l) => l.code === '1220')!.credit)).toBe(300);
  });

  it('⭐ charged posts Dr 1230 / Cr 1220, split by percentage (Phase 5 forced on for this proof)', async () => {
    const f = await fixture('post-charged');
    await raiseReceivable(f, '100.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '100.00', reason: 'split charge', openedOn: '2026-01-10',
        allocations: [
          { personId: f.staffAId, percent: '60.00' },
          { personId: f.staffBId, percent: '40.00' },
        ],
      }),
    );
    const restore = __setPhase5AvailableForTests(true);
    let res: Awaited<ReturnType<typeof resolveOrderWastage>>;
    try {
      res = await asOrg(f.orgId, (tx) =>
        resolveOrderWastage(tx, f.manager, { wastageId: rec.id, storeId: f.storeId, disposition: 'charged', resolvedOn: '2026-01-11' }),
      );
    } finally {
      restore();
    }
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const legs = await legsOf(res.journalEntryId!);
    const charges = legs.filter((l) => l.code === '1230');
    expect(charges).toHaveLength(2);
    expect(charges.find((l) => l.party_id === f.staffAId)!.debit).toBe('60.00');
    expect(charges.find((l) => l.party_id === f.staffBId)!.debit).toBe('40.00');
    expect(charges.every((l) => l.party_type === 'employee')).toBe(true);
    expect(Number(legs.find((l) => l.code === '1220')!.credit)).toBe(100);
  });

  it('platform_paid posts nothing', async () => {
    const f = await fixture('post-paid');
    await raiseReceivable(f, '50.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '50.00', reason: 'platform actually paid', openedOn: '2026-01-10',
      }),
    );
    const res = await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, { wastageId: rec.id, storeId: f.storeId, disposition: 'platform_paid', resolvedOn: '2026-01-11' }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.journalEntryId).toBeNull();
  });
});

// =====================================================================================
// Test 7 — the settlement matcher proposes; nothing posts until confirmed.
// =====================================================================================

describe('T-178 test 7 — a settlement match proposes and posts nothing until a manager confirms', () => {
  it('building candidates from real DB-sourced data writes nothing, and the wastage stays open', async () => {
    const f = await fixture('match-propose');
    await raiseReceivable(f, '400.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '80.00', reason: 'maybe paid', openedOn: '2026-01-10',
      }),
    );
    const settlementResult = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '400.00', netDeposited: '400.00',
        settledOn: '2026-01-12',
      }),
    );

    const before = await sql<{ n: string }[]>`select count(*)::text n from journal_lines`;

    const settlements = await asOrg(f.orgId, (tx) => listPostedSettlementsForStore(tx, f.manager, { storeId: f.storeId }));
    const wastages: SettleableOrderWastage[] = [
      { wastageId: rec.id, storeId: f.storeId, channelId: f.channelId, channel: 'Foodpanda', businessDate: '2026-01-10', amount: '80.00', orderRef: null, status: 'open' },
    ];
    const candidates = matchWastagesToSettlement(wastages, settlements);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.settlementId).toBe(settlementResult.settlementId);

    const after = await sql<{ n: string }[]>`select count(*)::text n from journal_lines`;
    expect(after[0]!.n).toBe(before[0]!.n);

    const [row] = await sql<{ status: string }[]>`select status from order_wastages where id = ${rec.id}`;
    expect(row!.status).toBe('open');
  });
});

// =====================================================================================
// Test 8 — a matched-and-paid wastage resolves platform_paid; T-150's settlement clears
// 1220 normally, end to end — the two modules do not double-clear.
// =====================================================================================

describe('T-178 test 8 — end to end: settlement clears 1220, the wastage adds nothing on top', () => {
  it('resolves platform_paid, posts nothing, and 1220 is exactly zero after the settlement alone', async () => {
    const f = await fixture('e2e-paid');
    await raiseReceivable(f, '1000.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '150.00', reason: 'refunded, platform ate it', openedOn: '2026-01-10',
      }),
    );

    const settlement = await asOrg(f.orgId, (tx) =>
      recordChannelSettlement(tx, f.manager, {
        storeId: f.storeId, channelId: f.channelId, salesDayId: f.salesDayId,
        businessDate: '2026-01-10', grossAmount: '1000.00', netDeposited: '1000.00',
        settledOn: '2026-01-12',
      }),
    );

    const res = await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, {
        wastageId: rec.id, storeId: f.storeId, disposition: 'platform_paid',
        settlementId: settlement.settlementId, resolvedOn: '2026-01-13',
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.journalEntryId).toBeNull();

    // ⭐ The proof: T-150's own settlement already cleared the FULL 1000 gross, and the wastage
    // resolution added no further 1220 leg — so the channel's receivable reads exactly zero, not
    // 1000 minus 150 minus something.
    const [row] = await sql<{ balance: string }[]>`
      select coalesce(sum(jl.debit - jl.credit), 0)::text as balance
      from journal_lines jl join accounts a on a.id = jl.account_id
      where a.code = '1220' and jl.party_type = 'channel' and jl.party_id = ${f.channelId}`;
    expect(Number(row!.balance)).toBe(0);

    const [wrow] = await sql<{ settlement_id: string; disposition: string }[]>`
      select settlement_id, disposition from order_wastages where id = ${rec.id}`;
    expect(wrow!.settlement_id).toBe(settlement.settlementId);
    expect(wrow!.disposition).toBe('platform_paid');
  });
});

// =====================================================================================
// Test 9 — charge refused with Phase 5 absent; the backstop degrades and records that it did.
// =====================================================================================

describe('T-178 test 9 — charge refused with Phase 5 absent; backstop degrades and says so', () => {
  it('resolveOrderWastage with disposition charged throws a named error', async () => {
    const f = await fixture('phase5-off');
    await raiseReceivable(f, '20.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '20.00', reason: 'try to charge', openedOn: '2026-01-10',
        allocations: [{ personId: f.staffAId, percent: '100.00' }],
      }),
    );
    await expect(
      asOrg(f.orgId, (tx) =>
        resolveOrderWastage(tx, f.manager, { wastageId: rec.id, storeId: f.storeId, disposition: 'charged', resolvedOn: '2026-01-11' }),
      ),
    ).rejects.toThrow(/Phase 5/);

    const [row] = await sql<{ status: string }[]>`select status from order_wastages where id = ${rec.id}`;
    // ⚠️ The refusal is transactional — nothing partial survives it.
    expect(row!.status).toBe('open');
  });
  // The backstop's own degrade-and-record behaviour is test 5's tier1/tier2 cases above — the
  // SAME code path, and duplicating the assertion here would be the second implementation this
  // whole task exists to avoid.
});

// =====================================================================================
// Test 10 — reversing an auto-charge within 30 days; refused past 30.
// =====================================================================================

describe('T-178 test 10 — reversing an auto-charge: 30-day window', () => {
  async function autoResolve(f: Fixture, amount: string, openedAt: string) {
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount, reason: 'reversal test', openedOn: '2026-01-10',
      }),
    );
    await sql`update order_wastages set opened_at = ${openedAt} where id = ${rec.id}`;
    return rec.id;
  }

  it('within 30 days: writes a reversal and reopens the row for a new resolution', async () => {
    const f = await fixture('reverse-ok');
    await raiseReceivable(f, '65.00');
    const id = await autoResolve(f, '65.00', '2026-01-01T00:00:00Z');
    await asOrg(f.orgId, (tx) => runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-20T00:00:00Z'), postedBy: null }));

    const [before] = await sql<{ journal_entry_id: string; status: string }[]>`
      select journal_entry_id, status from order_wastages where id = ${id}`;
    expect(before!.status).toBe('resolved');

    const res = await asOrg(f.orgId, (tx) =>
      reverseAutoCharge(tx, f.manager, { wastageId: id, storeId: f.storeId, reason: 'wrongly resolved', reversedOn: '2026-01-21' }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const [after] = await sql<{ status: string; disposition: string | null }[]>`
      select status, disposition from order_wastages where id = ${id}`;
    expect(after!.status).toBe('open');
    expect(after!.disposition).toBeNull();

    const [reversal] = await sql<{ reversal_of_entry_id: string }[]>`
      select reversal_of_entry_id from journal_entries where id = ${res.reversalEntryId}`;
    expect(reversal!.reversal_of_entry_id).toBe(before!.journal_entry_id);
  });

  it('at 31 days: refused', async () => {
    const f = await fixture('reverse-late');
    await raiseReceivable(f, '65.00');
    const id = await autoResolve(f, '65.00', '2026-01-01T00:00:00Z');
    await asOrg(f.orgId, (tx) => runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-20T00:00:00Z'), postedBy: null }));
    // Push the resolution itself back so "today" is 31 days past it.
    await sql`update order_wastages set resolved_at = resolved_at - interval '31 days' where id = ${id}`;

    const res = await asOrg(f.orgId, (tx) =>
      reverseAutoCharge(tx, f.manager, { wastageId: id, storeId: f.storeId, reason: 'too late', reversedOn: '2026-02-20' }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toMatch(/30 days|no longer reversible/);
  });
});

// =====================================================================================
// Test 11 — the backstop run twice on one day charges (resolves) once.
// =====================================================================================

describe('T-178 test 11 — the backstop is idempotent: a second run the same day does nothing new', () => {
  it('the second run finds nothing left to do', async () => {
    const f = await fixture('idempotent');
    await raiseReceivable(f, '30.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '30.00', reason: 'run twice', openedOn: '2026-01-10',
      }),
    );
    await sql`update order_wastages set opened_at = '2026-01-01T00:00:00Z' where id = ${rec.id}`;

    const now = new Date('2026-01-20T00:00:00Z');
    const first = await asOrg(f.orgId, (tx) => runOrderWastageBackstop(tx, f.orgId, { now, postedBy: null }));
    expect(first.outcomes.map((o) => o.wastageId)).toContain(rec.id);

    const [beforeCount] = await sql<{ n: string }[]>`select count(*)::text n from journal_lines where entry_id = (select journal_entry_id from order_wastages where id = ${rec.id})`;

    const second = await asOrg(f.orgId, (tx) => runOrderWastageBackstop(tx, f.orgId, { now, postedBy: null }));
    expect(second.outcomes).toHaveLength(0);

    const [afterCount] = await sql<{ n: string }[]>`select count(*)::text n from journal_lines where entry_id = (select journal_entry_id from order_wastages where id = ${rec.id})`;
    expect(afterCount!.n).toBe(beforeCount!.n);
  });
});

// =====================================================================================
// Test 12 — a backstop posting into a closed period is refused (invariant 11).
// =====================================================================================

describe('T-178 test 12 — a backstop posting into a closed period is refused, not silently skipped', () => {
  it('records the row in `failures` and leaves the wastage unresolved', async () => {
    const f = await fixture('closed-period');
    await raiseReceivable(f, '40.00');
    const rec = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
        amount: '40.00', reason: 'lands in a closed period', openedOn: '2026-01-10',
      }),
    );
    await sql`update order_wastages set opened_at = '2026-01-01T00:00:00Z' where id = ${rec.id}`;
    // Close the period the backstop's `now` (2026-01-20) resolves to.
    await sql`update fiscal_periods set status = 'closed' where org_id = ${f.orgId} and starts_on = '2026-01-01'`;

    const result = await asOrg(f.orgId, (tx) =>
      runOrderWastageBackstop(tx, f.orgId, { now: new Date('2026-01-20T00:00:00Z'), postedBy: null }),
    );
    expect(result.outcomes).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.wastageId).toBe(rec.id);
    expect(result.failures[0]!.reason).toMatch(/closed/i);

    const [row] = await sql<{ status: string }[]>`select status from order_wastages where id = ${rec.id}`;
    expect(row!.status).toBe('open');
  });
});

// Test 13 (live route on 9008) is deliberately not automated here — the coordinator runs the
// combined live smoketest after merging both concurrent lanes (see the T-178 task report).

describe('DEF-272 — a sub-centavo amount gets a written sentence, not money()\'s raw TypeError', () => {
  // ⭐ Not a guard-bypass site: `recordOrderWastage` already called `money(input.amount)` before
  // this fix, so a sub-centavo amount was already refused — just with a developer-facing
  // `TypeError`, not a sentence a manager can act on. `parseMoneyInput` is the same shared entry
  // point as every other site here, so the improvement is in the MESSAGE, not the outcome.
  it('refuses "0.004" with a written sentence', async () => {
    const f = await fixture('def272-message');
    await raiseReceivable(f, '500.00');
    await expect(
      asOrg(f.orgId, (tx) =>
        recordOrderWastage(tx, f.manager, {
          storeId: f.storeId, salesDayId: f.salesDayId, channel: 'Foodpanda',
          amount: '0.004', reason: 'test', openedOn: '2026-01-10',
          allocations: [{ personId: f.staffAId, percent: '100.00' }],
        }),
      ),
    ).rejects.toThrow(/recordOrderWastage: the amount.*"0\.004"/);
  });
});
