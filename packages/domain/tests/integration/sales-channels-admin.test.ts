import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-230 — sales channels: the admin surface (DEF-207) + per-channel wastage policy (bible §13
 * row 180). `docs/tasks/230-sales-channels-admin-and-wastage-policy.md`.
 *
 * ⭐ Fixture pattern mirrors `order-wastage.test.ts` (T-178): a fresh org per test via `fixture()`,
 * and this file's own `asOrg` RLS-scoped transaction. Nothing here truncates — the lane database is
 * shared with the suites this task changes the contract of.
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
import { APP_ROLE, closeDb, orderWastageRepo, salesDaysRepo, transaction, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createSalesChannel,
  listSalesChannelsForAdmin,
  setSalesChannelActive,
  updateSalesChannel,
} from '../../src/sales-channels';
import { storeReadiness } from '../../src/stores/service';
import { recordOrderWastage, resolveOrderWastage } from '../../src/wastage/orders';
import { matchWastagesToSettlement, type SettleableOrderWastage } from '../../src/wastage/settlement-match';

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
  const code = uid(`sc-${hint}`);
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-01-01', '2026-01-31', 'open'),
      (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Store A') returning id`;
  const storeId = store!.id;
  // A default room + an admin with scope, so `storeReadiness`'s OTHER checks can pass and the
  // sales-channel one is the only thing standing between this store and ready.
  const adminId = await person(orgId, storeId, 'admin', 'Admin');
  const [ltype] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'stockroom', 'Stockroom') returning id`;
  await sql`
    insert into stock_locations (org_id, store_id, type_id, code, name, created_by)
    values (${orgId}, ${storeId}, ${ltype!.id}, 'MAIN', 'Main stockroom', ${adminId})`;

  const managerId = await person(orgId, storeId, 'manager', 'Manager');
  // ⚠️ `person_roles_role_check` allows only super_admin | admin | manager | staff — there is no
  //    'cashier' role in v2. A rank-and-file staff member is the denial case.
  const staffId = await person(orgId, storeId, 'staff', 'Line staff');
  const monitorId = await person(orgId, storeId, 'staff', 'Wastage Monitor');
  await sql`update stores set wastage_monitor_person_id = ${monitorId} where id = ${storeId}`;

  const [bank] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'Payout wallet', 'bank', '1140', 'office') returning id`;

  const [day] = await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, created_by)
    values (${orgId}, ${storeId}, '2026-01-10', 0, 0, 0, ${managerId}) returning id`;

  return {
    orgId,
    storeId,
    salesDayId: day!.id,
    bankId: bank!.id,
    adminId,
    managerId,
    monitorId,
    admin: actorOf(orgId, adminId),
    manager: actorOf(orgId, managerId),
    staff: actorOf(orgId, staffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function storeRow(f: Fixture) {
  const [row] = await sql<Record<string, unknown>[]>`select * from stores where id = ${f.storeId}`;
  return row as never;
}

async function channelRowById(id: string) {
  const [row] = await sql<Record<string, unknown>[]>`select * from sales_channels where id = ${id}`;
  return row!;
}

afterAll(async () => {
  await sql.end();
  await closeDb();
});

// =====================================================================================
// The admin surface — DEF-207
// =====================================================================================

describe('T-230 — sales-channel administration (DEF-207)', () => {
  it('1 ⭐ a store with no channels is NOT ready; creating one makes it ready — DEF-207 end to end', async () => {
    const f = await fixture('ready');
    const row = await storeRow(f);

    const before = await asOrg(f.orgId, (tx) => storeReadiness(tx, f.admin, row));
    const beforeCheck = before.find((c) => c.key === 'salesChannel')!;
    expect(beforeCheck.ok).toBe(false);
    expect(beforeCheck.blocking).toBe(true);

    await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.admin, { storeId: f.storeId, name: 'Walk-in', isRemittedDaily: true }),
    );

    const after = await asOrg(f.orgId, (tx) => storeReadiness(tx, f.admin, row));
    expect(after.find((c) => c.key === 'salesChannel')!.ok).toBe(true);
  });

  it('2 a manager may create a channel; a rank-and-file staff member is refused', async () => {
    const f = await fixture('gate');

    const { channelId } = await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.manager, { storeId: f.storeId, name: 'Grab', isRemittedDaily: false, receivableAccountCode: '1220' }),
    );
    expect(channelId).toBeTruthy();

    await expect(
      asOrg(f.orgId, (tx) =>
        createSalesChannel(tx, f.staff, { storeId: f.storeId, name: 'Sneaky', isRemittedDaily: true }),
      ),
    ).rejects.toThrow(/may not 'manage_store_settings'/);
  });

  it('3 a non-remitted channel with no receivable is refused, and the message names the receivable', async () => {
    const f = await fixture('recv');
    await expect(
      asOrg(f.orgId, (tx) =>
        createSalesChannel(tx, f.admin, { storeId: f.storeId, name: 'Foodpanda', isRemittedDaily: false }),
      ),
    ).rejects.toThrow(/receivable/i);
  });

  it('4 ⭐ a blank name is refused; a case/whitespace duplicate is refused by the DATABASE', async () => {
    const f = await fixture('dupe');

    await expect(
      asOrg(f.orgId, (tx) => createSalesChannel(tx, f.admin, { storeId: f.storeId, name: '   ', isRemittedDaily: true })),
    ).rejects.toThrow(/name/i);

    await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.admin, { storeId: f.storeId, name: 'Foodpanda', isRemittedDaily: true }),
    );

    // (a) through the domain: a readable sentence naming the existing channel.
    await expect(
      asOrg(f.orgId, (tx) =>
        createSalesChannel(tx, f.admin, { storeId: f.storeId, name: '  foodpanda ', isRemittedDaily: true }),
      ),
    ).rejects.toThrow(/Foodpanda/);

    // (b) ⭐ R6 — straight through the REPO, bypassing the pre-read, so the refusal is the INDEX's
    //     and not a nicety of the domain layer. This is what "by the database" has to mean.
    await expect(
      asOrg(f.orgId, (tx) =>
        salesDaysRepo.insertChannel(tx, {
          orgId: f.orgId,
          storeId: f.storeId,
          name: 'FOODPANDA  ',
          isRemittedDaily: true,
          receivableAccountCode: null,
          wastageTypeMode: 'tracked',
        }),
      ),
    ).rejects.toThrow(/sales_channels_org_id_store_id_name_unique/);
  });

  it('5 a receivable account must exist, be postable, be active AND require a party', async () => {
    const f = await fixture('acct');
    const make = (receivableAccountCode: string) =>
      asOrg(f.orgId, (tx) =>
        createSalesChannel(tx, f.admin, {
          storeId: f.storeId,
          name: uid('ch'),
          isRemittedDaily: false,
          receivableAccountCode,
        }),
      );

    await expect(make('9999')).rejects.toThrow(/9999/);
    // `1000` is the Assets parent — present, not postable.
    await expect(make('1000')).rejects.toThrow(/postable|leaf/i);
    // `5300` is postable and active but does NOT require a party — T-118's trigger would refuse
    // the `party_type = 'channel'` line `sales-days/routing.ts` writes against it.
    await expect(make('5300')).rejects.toThrow(/party/i);

    await sql`update accounts set status = 'reserved' where org_id = ${f.orgId} and code = '1210'`;
    await expect(make('1210')).rejects.toThrow(/active|reserved/i);
  });

  it('6 another org cannot address this org’s store or channel', async () => {
    const a = await fixture('orgA');
    const b = await fixture('orgB');

    await expect(
      asOrg(b.orgId, (tx) =>
        createSalesChannel(tx, b.admin, { storeId: a.storeId, name: 'Trespass', isRemittedDaily: true }),
      ),
    ).rejects.toThrow();

    const { channelId } = await asOrg(a.orgId, (tx) =>
      createSalesChannel(tx, a.admin, { storeId: a.storeId, name: 'Walk-in', isRemittedDaily: true }),
    );

    await expect(
      asOrg(b.orgId, (tx) =>
        updateSalesChannel(tx, b.admin, {
          channelId,
          name: 'Hijacked',
          isRemittedDaily: true,
          wastageTypeMode: 'tracked',
        }),
      ),
    ).rejects.toThrow();

    // ⛔ Refused, not silently no-op: the row is untouched.
    expect(String((await channelRowById(channelId)).name)).toBe('Walk-in');
  });

  it('7 ⭐ a rename resolves nothing differently — the open wastage still posts, the resolved memo is unchanged', async () => {
    const f = await fixture('rename');
    const { channelId } = await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.admin, {
        storeId: f.storeId,
        name: 'Foodpanda',
        isRemittedDaily: false,
        receivableAccountCode: '1220',
      }),
    );
    await raiseReceivable(f, channelId, '900.00');

    const openW = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId,
        salesDayId: f.salesDayId,
        channel: 'Foodpanda',
        amount: '100.00',
        reason: 'Refunded order',
        openedOn: '2026-01-10',
      }),
    );
    const resolvedW = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId,
        salesDayId: f.salesDayId,
        channel: 'Foodpanda',
        amount: '50.00',
        reason: 'Already settled',
        openedOn: '2026-01-10',
      }),
    );
    await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, {
        wastageId: resolvedW.id,
        storeId: f.storeId,
        disposition: 'absorbed',
        resolvedOn: '2026-01-10',
      }),
    );
    const memoBefore = await memoOf(resolvedW.id);

    await asOrg(f.orgId, (tx) =>
      updateSalesChannel(tx, f.admin, {
        channelId,
        name: 'Foodpanda PH',
        isRemittedDaily: false,
        receivableAccountCode: '1220',
        wastageTypeMode: 'tracked',
      }),
    );

    // ⭐ The whole point: this used to throw "no 'Foodpanda' channel is configured for this store".
    const out = await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, {
        wastageId: openW.id,
        storeId: f.storeId,
        disposition: 'absorbed',
        resolvedOn: '2026-01-10',
      }),
    );
    expect(out.ok).toBe(true);

    // The posted memo of the already-resolved row is untouched by the rename.
    expect(await memoOf(resolvedW.id)).toBe(memoBefore);
  });

  it('8 deactivate hides a channel from pickers, keeps it readable, and un-readies the store', async () => {
    const f = await fixture('deact');
    const { channelId } = await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.admin, { storeId: f.storeId, name: 'Walk-in', isRemittedDaily: true }),
    );
    const row = await storeRow(f);
    expect((await asOrg(f.orgId, (tx) => storeReadiness(tx, f.admin, row))).find((c) => c.key === 'salesChannel')!.ok).toBe(true);

    await asOrg(f.orgId, (tx) => setSalesChannelActive(tx, f.admin, { channelId, isActive: false }));

    expect((await asOrg(f.orgId, (tx) => storeReadiness(tx, f.admin, row))).find((c) => c.key === 'salesChannel')!.ok).toBe(false);

    const all = await asOrg(f.orgId, (tx) => salesDaysRepo.listChannels(tx, f.orgId, f.storeId));
    const active = await asOrg(f.orgId, (tx) => salesDaysRepo.listChannels(tx, f.orgId, f.storeId, { activeOnly: true }));
    expect(all.map((c) => c.id)).toContain(channelId); // ⛔ the row is still THERE — never deleted
    expect(active.map((c) => c.id)).not.toContain(channelId);

    // …and it comes back.
    await asOrg(f.orgId, (tx) => setSalesChannelActive(tx, f.admin, { channelId, isActive: true }));
    expect((await asOrg(f.orgId, (tx) => salesDaysRepo.listChannels(tx, f.orgId, f.storeId, { activeOnly: true }))).map((c) => c.id)).toContain(channelId);
  });

  it('9 an edit leaves is_active, the payout wallet and the tax treatment untouched', async () => {
    const f = await fixture('narrow');
    const { channelId } = await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.admin, {
        storeId: f.storeId,
        name: 'Grab',
        isRemittedDaily: false,
        receivableAccountCode: '1220',
      }),
    );
    // Set the two fields this task deliberately does not write, the way their real owners do.
    await sql`
      update sales_channels set destination_money_account_id = ${f.bankId}, tax_treatment = 'creditable', is_active = false
       where id = ${channelId}`;
    const before = await channelRowById(channelId);

    await asOrg(f.orgId, (tx) =>
      updateSalesChannel(tx, f.admin, {
        channelId,
        name: 'GrabFood',
        isRemittedDaily: false,
        receivableAccountCode: '1220',
        wastageTypeMode: 'instant',
      }),
    );

    const after = await channelRowById(channelId);
    expect(after.name).toBe('GrabFood');
    expect(after.wastage_type_mode).toBe('instant');
    expect(after.destination_money_account_id).toBe(before.destination_money_account_id);
    expect(after.tax_treatment).toBe(before.tax_treatment);
    expect(after.is_active).toBe(before.is_active);
  });

  it('10 ⭐ the wastage policy defaults to the SAFE side, and only the two values exist', async () => {
    const f = await fixture('mode');
    // The column default is what a row created without stating a policy gets.
    const [row] = await sql<{ wastage_type_mode: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily)
      values (${f.orgId}, ${f.storeId}, 'Legacy', true)
      returning wastage_type_mode`;
    expect(row!.wastage_type_mode).toBe('tracked');

    await expect(
      sql`insert into sales_channels (org_id, store_id, name, is_remitted_daily, wastage_type_mode)
          values (${f.orgId}, ${f.storeId}, 'Broken', true, 'both')`,
    ).rejects.toThrow(/sales_channels_wastage_type_mode_check/);

    const listed = await asOrg(f.orgId, (tx) => listSalesChannelsForAdmin(tx, f.admin, { storeId: f.storeId }));
    expect(listed.find((c) => c.name === 'Legacy')!.wastageTypeMode).toBe('tracked');
  });
});

// =====================================================================================
// The derivation — bible §13 row 180
// =====================================================================================

describe('T-230 — the channel decides tracked vs instant (bible §13 row 180)', () => {
  async function twoChannels(f: Fixture) {
    const tracked = await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.admin, {
        storeId: f.storeId,
        name: 'Foodpanda',
        isRemittedDaily: false,
        receivableAccountCode: '1220',
        wastageTypeMode: 'tracked',
      }),
    );
    const instant = await asOrg(f.orgId, (tx) =>
      createSalesChannel(tx, f.admin, {
        storeId: f.storeId,
        name: 'Dine-in',
        isRemittedDaily: false,
        receivableAccountCode: '1220',
        wastageTypeMode: 'instant',
      }),
    );
    return { tracked: tracked.channelId, instant: instant.channelId };
  }

  it('11 ⭐ a tracked channel opens; an instant channel resolves and posts — from the CHANNEL, not the caller', async () => {
    const f = await fixture('derive');
    const ids = await twoChannels(f);
    await raiseReceivable(f, ids.tracked, '500.00');
    await raiseReceivable(f, ids.instant, '500.00');

    const t = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId,
        salesDayId: f.salesDayId,
        channel: 'Foodpanda',
        amount: '120.00',
        reason: 'Refunded',
        openedOn: '2026-01-10',
      }),
    );
    expect(t.status).toBe('open');
    expect(t.journalEntryId).toBeNull();
    const [alloc] = await sql<{ person_id: string }[]>`
      select person_id from order_wastage_allocations where wastage_id = ${t.id}`;
    expect(alloc!.person_id).toBe(f.monitorId); // invariant 2 — the Monitor is seeded

    const i = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId,
        salesDayId: f.salesDayId,
        channel: 'Dine-in',
        amount: '80.00',
        reason: 'Remake',
        openedOn: '2026-01-10',
        disposition: 'absorbed',
      }),
    );
    expect(i.status).toBe('resolved');
    expect(i.journalEntryId).not.toBeNull();

    const rows = await sql<{ type_mode: string; channel: string }[]>`
      select type_mode, channel from order_wastages where id in (${t.id}, ${i.id}) order by amount desc`;
    expect(rows.map((r) => r.type_mode)).toEqual(['tracked', 'instant']);
  });

  it('12 ⛔ THE HOLE IAN CLOSED — a recorder cannot make a tracked channel instant', async () => {
    const f = await fixture('hole');
    const ids = await twoChannels(f);
    await raiseReceivable(f, ids.tracked, '500.00');

    // Before T-230 this exact call succeeded and returned `resolved`, skipping the Wastage Monitor,
    // the 48-hour dispute window and the 15-day auto-charge backstop in one click.
    await expect(
      asOrg(f.orgId, (tx) =>
        recordOrderWastage(tx, f.manager, {
          storeId: f.storeId,
          salesDayId: f.salesDayId,
          channel: 'Foodpanda',
          amount: '100.00',
          reason: 'Not my fault',
          openedOn: '2026-01-10',
          disposition: 'absorbed',
        }),
      ),
    ).rejects.toThrow(/tracked|awaits a disposition/i);

    // Nothing was written by the refused call.
    const [count] = await sql<{ n: number }[]>`
      select count(*)::int as n from order_wastages where store_id = ${f.storeId}`;
    expect(count!.n).toBe(0);
  });

  it('13 an unconfigured channel name is refused AT CREATION, not days later at posting', async () => {
    const f = await fixture('typo');
    await twoChannels(f);

    await expect(
      asOrg(f.orgId, (tx) =>
        recordOrderWastage(tx, f.manager, {
          storeId: f.storeId,
          salesDayId: f.salesDayId,
          channel: 'Foodpandaa',
          amount: '10.00',
          reason: 'Typo',
          openedOn: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/no 'Foodpandaa' channel is configured/);
  });

  it('14 a retired channel refuses NEW wastages, but one opened before still resolves and posts', async () => {
    const f = await fixture('retired');
    const ids = await twoChannels(f);
    await raiseReceivable(f, ids.tracked, '500.00');

    const opened = await asOrg(f.orgId, (tx) =>
      recordOrderWastage(tx, f.manager, {
        storeId: f.storeId,
        salesDayId: f.salesDayId,
        channel: 'Foodpanda',
        amount: '100.00',
        reason: 'Refunded',
        openedOn: '2026-01-10',
      }),
    );

    await asOrg(f.orgId, (tx) => setSalesChannelActive(tx, f.admin, { channelId: ids.tracked, isActive: false }));

    await expect(
      asOrg(f.orgId, (tx) =>
        recordOrderWastage(tx, f.manager, {
          storeId: f.storeId,
          salesDayId: f.salesDayId,
          channel: 'Foodpanda',
          amount: '10.00',
          reason: 'Too late',
          openedOn: '2026-01-10',
        }),
      ),
    ).rejects.toThrow(/no longer an active channel/);

    // ⭐ The other half, and the one an over-eager `is_active` filter in `channelById` would break:
    // a pre-existing obligation still posts against the retired channel's receivable.
    const out = await asOrg(f.orgId, (tx) =>
      resolveOrderWastage(tx, f.manager, {
        wastageId: opened.id,
        storeId: f.storeId,
        disposition: 'absorbed',
        resolvedOn: '2026-01-10',
      }),
    );
    expect(out.ok).toBe(true);
  });

  it('15 ⭐ the settlement matcher keys on the channel ID, so a rename does not lose a match', async () => {
    const f = await fixture('match');
    const ids = await twoChannels(f);
    const wastages: SettleableOrderWastage[] = [
      {
        wastageId: 'w1',
        storeId: f.storeId,
        channelId: ids.tracked,
        channel: 'Foodpanda',
        businessDate: '2026-01-10',
        amount: '100.00',
        orderRef: null,
        status: 'open',
      },
    ];
    // The settlement was posted while the channel was still called "Foodpanda"; the channel has
    // since been renamed, so its summary carries the NEW name and the same id.
    const settlements = [
      {
        settlementId: 's1',
        storeId: f.storeId,
        channelId: ids.tracked,
        channel: 'Foodpanda PH',
        businessDate: '2026-01-10',
        grossAmount: '1000.00',
        outstandingCleared: '1000.00',
        netDeposited: '900.00',
        deductions: {
          commission: '100.00', marketing: '0.00', platformFee: '0.00',
          vatOnFees: '0.00', withholdingTax: '0.00', penalty: '0.00',
        },
        variance: '0.00',
        settlementGain: '0.00',
      },
    ];
    expect(matchWastagesToSettlement(wastages, settlements)).toHaveLength(1);
  });
});

/** Raise the 1220 receivable a verified channel-day would have raised, so a wastage has something
 *  to post against. Mirrors `order-wastage.test.ts`'s helper of the same name. */
async function raiseReceivable(f: Fixture, channelId: string, amount: string, date = '2026-01-10') {
  const { postEntry } = await import('../../src/ledger/post-entry');
  await asOrg(f.orgId, (tx) =>
    postEntry(tx, {
      orgId: f.orgId,
      entryDate: date,
      sourceType: 'sales_day',
      sourceId: f.salesDayId,
      idempotencyKey: `sales_day:${f.salesDayId}:${channelId}:${amount}:${date}`,
      memo: 'Channel day',
      postedBy: f.managerId,
      lines: [
        { accountCode: '1220', storeId: f.storeId, debit: amount, partyType: 'channel', partyId: channelId },
        { accountCode: '4150', storeId: f.storeId, credit: amount },
      ],
    }),
  );
}

async function memoOf(wastageId: string): Promise<string> {
  const [row] = await sql<{ memo: string }[]>`
    select je.memo from order_wastages w
    join journal_entries je on je.id = w.journal_entry_id
    where w.id = ${wastageId}`;
  return row?.memo ?? '';
}
