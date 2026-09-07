import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-229 slice 3 — the store's Wastage Monitor. **DEF-206.**
 * `docs/tasks/229-reference-data-administration.md`.
 *
 * ⭐ **Why this is a money test and not a settings test.** `stores.wastage_monitor_person_id` had
 * ZERO writers outside one raw `UPDATE` in T-178's own suite. With none set,
 * `recordOrderWastage`'s invariant-2 seed silently does nothing, every tracked wastage is created
 * ownerless, and the 15-day backstop falls to its third tier — *store absorbs, net zero*. Nothing
 * is recovered and nothing errors. Test 7 is the one that proves the remedy: the seed appears.
 *
 * ⛔ Run through `it.mjs` against a LANE database, never `npm run test:integration`.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { CUTOVER_CLASSIFICATION } from '../../../db/src/cutover/classification';
import { APP_ROLE, closeDb, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { ownerlessTrackedWastages, setWastageMonitor, wastageMonitorOf } from '../../src/stores/service';
import { createSalesChannel } from '../../src/sales-channels';
import { recordOrderWastage } from '../../src/wastage/orders';

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

async function person(orgId: string, storeId: string | null, role: string, name: string) {
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
  if (storeId) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
  return p!.id;
}

async function fixture(hint: string) {
  const code = uid(`wm-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status)
    values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store A') returning id`;
  const storeId = store!.id;

  const adminId = await person(orgId, storeId, 'admin', 'Admin');
  const managerId = await person(orgId, storeId, 'manager', 'Manager');
  const staffId = await person(orgId, storeId, 'staff', 'Line staff');
  const monitorId = await person(orgId, storeId, 'staff', 'Wastage Monitor');

  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${storeId}, '2026-01-10', 0, 0, 0, ${managerId}) returning id`;

  return {
    orgId,
    storeId,
    salesDayId: day!.id,
    adminId,
    managerId,
    staffId,
    monitorId,
    admin: actorOf(orgId, adminId),
    manager: actorOf(orgId, managerId),
    staff: actorOf(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function monitorColumn(storeId: string): Promise<string | null> {
  const [row] = await sql<{ wastage_monitor_person_id: string | null }[]>`
    select wastage_monitor_person_id from stores where id = ${storeId}`;
  return row?.wastage_monitor_person_id ?? null;
}

/** A tracked channel to record against. */
async function trackedChannel(f: Fixture, name = 'Foodpanda') {
  const { channelId } = await asOrg(f.orgId, (tx) =>
    createSalesChannel(tx, f.admin, {
      storeId: f.storeId,
      name,
      isRemittedDaily: false,
      receivableAccountCode: '1220',
      wastageTypeMode: 'tracked',
    }),
  );
  return channelId;
}

async function recordTracked(f: Fixture, channel: string, amount: string) {
  return asOrg(f.orgId, (tx) =>
    recordOrderWastage(tx, f.manager, {
      storeId: f.storeId,
      salesDayId: f.salesDayId,
      channel,
      amount,
      reason: 'Refunded order',
      openedOn: '2026-01-10',
    }),
  );
}

async function allocationsOf(wastageId: string) {
  return sql<{ person_id: string; percent: string }[]>`
    select person_id, percent::text from order_wastage_allocations where wastage_id = ${wastageId}`;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

describe('T-229 slice 3 — the store’s Wastage Monitor (DEF-206)', () => {
  it('1 ⭐ a manager assigns the Monitor, and the store reads it back', async () => {
    const f = await fixture('set');
    expect(await monitorColumn(f.storeId)).toBeNull();

    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.manager, { storeId: f.storeId, personId: f.monitorId }));

    expect(await monitorColumn(f.storeId)).toBe(f.monitorId);
    const read = await asOrg(f.orgId, (tx) => wastageMonitorOf(tx, f.manager, f.storeId));
    expect(read?.personId).toBe(f.monitorId);
    expect(read?.displayName).toBe('Wastage Monitor');
  });

  it('2 a rank-and-file staff member is refused, and the column is unchanged', async () => {
    const f = await fixture('gate');
    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: f.monitorId }));

    await expect(
      asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.staff, { storeId: f.storeId, personId: f.staffId })),
    ).rejects.toThrow(/may not 'manage_store_settings'/);

    // ⛔ Refused, not silently no-op — and note WHO was being assigned: without the gate, the
    //    person who records their own losses could name themselves out of the way.
    expect(await monitorColumn(f.storeId)).toBe(f.monitorId);
  });

  it('3 clearing the Monitor is allowed and must stay allowed', async () => {
    const f = await fixture('clear');
    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: f.monitorId }));
    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: null }));
    // The column is nullable ON PURPOSE — "an unassigned Monitor is not a failure, it is the last
    // rung of the backstop's own fallback order". A Monitor who leaves must be removable.
    expect(await monitorColumn(f.storeId)).toBeNull();
  });

  it('4 another org’s person and another org’s store are both refused', async () => {
    const a = await fixture('orgA');
    const b = await fixture('orgB');

    await expect(
      asOrg(a.orgId, (tx) => setWastageMonitor(tx, a.admin, { storeId: a.storeId, personId: b.monitorId })),
    ).rejects.toThrow(/does not exist in this organisation/i);

    await expect(
      asOrg(b.orgId, (tx) => setWastageMonitor(tx, b.admin, { storeId: a.storeId, personId: b.monitorId })),
    ).rejects.toThrow();

    expect(await monitorColumn(a.storeId)).toBeNull();
  });

  it('5 a deactivated person cannot be made Monitor', async () => {
    const f = await fixture('inactive');
    await sql`update persons set is_active = false where id = ${f.monitorId}`;
    await expect(
      asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: f.monitorId })),
    ).rejects.toThrow(/no longer active/i);
  });

  it('6 ⭐ a Monitor lost by any means can be re-assigned — the recovery path DEF-206 lacked', async () => {
    const f = await fixture('reassign');
    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: f.monitorId }));

    // ⚠️ **This is NOT the cutover.** It was, until 2026-09-07: `stores` was `keep_shell` and the
    // purge nulled this column, and this test replicated that statement. Ian reversed the carve-out
    // — the cutover wipes transactional data, not store settings, so the Monitor now SURVIVES it
    // (bible §13 row 182, `classification.ts`). Test 9 pins that.
    //
    // What is left is the general property worth keeping: the column can reach null by some other
    // route — a direct fix, a restore, a person removed — and the screen must be able to put a
    // Monitor back. Before this slice there was no writer at all, so it could not.
    await sql`update stores set wastage_monitor_person_id = null where id = ${f.storeId}`;
    expect(await monitorColumn(f.storeId)).toBeNull();

    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: f.managerId }));
    expect(await monitorColumn(f.storeId)).toBe(f.managerId);
  });

  it('9 ⛔ the cutover does NOT clear the Monitor — `stores` is a plain KEEP', async () => {
    // ⭐ Ian, 2026-09-07: "the cutover wipes transactional data, not stores and store settings."
    // T-178 had carved this one column out and nulled it, which put every branch into the
    // no-Monitor state on cutover morning — DEF-206 re-created fleet-wide, silently. Asserted
    // against the classification itself, because that is what `cutover-purge.ts` derives its
    // clear-list from: nothing hand-codes this column, so the classification IS the behaviour.
    const entry = CUTOVER_CLASSIFICATION.stores!;
    expect(entry.class).toBe('keep');
    expect(entry).not.toHaveProperty('clearColumns');
  });

  it('7 ⭐⭐ THE MONEY HALF — with a Monitor set the tracked wastage gets an owner; without one it does not', async () => {
    const f = await fixture('seed');
    await trackedChannel(f);

    // (a) No Monitor — the state DEF-206 describes. The wastage is created OWNERLESS, silently.
    const ownerless = await recordTracked(f, 'Foodpanda', '250.00');
    expect(ownerless.status).toBe('open');
    expect(await allocationsOf(ownerless.id)).toHaveLength(0);

    // (b) Monitor set — invariant 2's seed finally fires.
    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: f.monitorId }));
    const owned = await recordTracked(f, 'Foodpanda', '250.00');
    const allocs = await allocationsOf(owned.id);
    expect(allocs).toHaveLength(1);
    expect(allocs[0]!.person_id).toBe(f.monitorId);
    expect(Number(allocs[0]!.percent)).toBe(100);
  });

  it('8 ⚠️ setting a Monitor does NOT retro-own wastages already open — and the count says so', async () => {
    const f = await fixture('count');
    await trackedChannel(f);

    const a = await recordTracked(f, 'Foodpanda', '100.00');
    const b = await recordTracked(f, 'Foodpanda', '50.50');

    const before = await asOrg(f.orgId, (tx) => ownerlessTrackedWastages(tx, f.manager, f.storeId));
    expect(before.count).toBe(2);
    expect(before.amount).toBe('150.50');

    await asOrg(f.orgId, (tx) => setWastageMonitor(tx, f.admin, { storeId: f.storeId, personId: f.monitorId }));

    // ⛔ The two already-open rows keep no owner. Re-assigning them would rewrite an attribution
    //    nobody made; the screen says this in words rather than pretending the number dropped.
    const after = await asOrg(f.orgId, (tx) => ownerlessTrackedWastages(tx, f.manager, f.storeId));
    expect(after.count).toBe(2);
    expect([a.id, b.id]).toHaveLength(2);

    // A NEW one is owned, so the count stops growing.
    await recordTracked(f, 'Foodpanda', '10.00');
    const later = await asOrg(f.orgId, (tx) => ownerlessTrackedWastages(tx, f.manager, f.storeId));
    expect(later.count).toBe(2);
  });
});
