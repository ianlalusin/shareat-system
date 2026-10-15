import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S7 (DEF-578) T12 - `voidPullAction` (apps/erp/src/app/inventory/pos-usage/actions.ts): the form's
 * door to `voidPosUsagePull`. `docs/tasks/374-money-push-follow-ups.md` section S7.
 *
 * TESTER, not BUILDER. RED on HEAD because `voidPullAction` is not exported from the actions file
 * ("voidPullAction is not a function"). The domain half (all-or-none, dating, locks, refusals) is
 * `packages/domain/tests/integration/t374-s7-void-pos-usage-pull.test.ts`.
 *
 * ## What the spec leaves open, pinned so the builder has one reading (a question to the tester, not a test edit)
 *  - the form fields are `storeId`, `salesDayId`, `pullId`, `reason` (the first three are the names every other
 *    action in this file reads; `reason` is the one new field, "a required reason");
 *  - success redirects to `/inventory/pos-usage?...&ok=Pull voided — {n} usage record(s) reversed. The day can be
 *    pulled again.` and a refusal to `...&error=<sentence>` with NO `ok`, exactly as the sibling actions do.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
}));
// the actions file imports the bare `@/lib/constraint-messages` specifier the root vitest config does not resolve
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { toBusinessDate } from '@shareat/core/datetime';
import { buildPlan, finalizeSections, upsertPosItemMap } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { receiveDelivery } from '../../../../packages/domain/src/deliveries/receive';
import { quantity } from '../../../../packages/domain/src/stock/quantity';
import { importTestDay, linkTestStore, seedTestTenders } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { urlOf } from '../helpers/flash-jar';
import { legacyPostPull } from '../../../../packages/domain/tests/integration/_fixtures/pull-draft';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });
const DAY = '2026-05-20';
// T-375 S5 (S5-lite): the day is IMPORTED on a LINKED store; the plan reads its stored sold items (cheese 4).
const SOLD = [{ key: 'cheese', name: 'Cheese', physicalQty: 4 }];

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/** A finalized pull for DAY at one store; `manager` may void it, `nobody` holds no role. */
async function fixture(hint: string, opts: { legacy?: boolean } = {}) {
  const code = uid(`t374s7w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const todayStart = `${toBusinessDate().slice(0, 7)}-01`;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
    select ${orgId}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open'
    from generate_series('2026-05-01'::date, ${todayStart}::date, interval '1 month') m`;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Lipa', 'multi_room') returning id`;
  const storeId = store!.id;
  const mkPerson = async (name: string, role: string | null) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    if (role) await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const managerId = await mkPerson('Manager', 'manager');
  const nobodyId = await mkPerson('Nobody', null);
  const adminId = await mkPerson('Admin', 'admin'); // T-403: mapping is admin-only
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId, channelId: ch!.id, createdBy: managerId });
  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${orgId}, ${storeId}, 'KIT', 'Kitchen', ${type!.id}, 'operating', true, ${managerId}) returning id`;
  const kitchen = loc!.id;
  const [it] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Cheese', 'meat_slab', 'kg', ${managerId}) returning id`;
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${`orgs/${orgId}/p-${uid('f')}.jpg`}, 'image/jpeg', 10, 'x', 'receipt_photo', ${managerId}) returning id`;
  const [del] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgId}, ${storeId}, 'purchase', '2026-05-02', ${file!.id}, ${managerId}) returning id`;
  await asOrg(orgId, (tx) =>
    receiveDelivery(tx, {
      orgId, storeId, deliveryId: del!.id, deliveredOn: '2026-05-02', receivedBy: managerId,
      locations: [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      lines: [{ lineId: '1', itemId: it!.id, itemKind: 'meat_slab', receivedQuantity: quantity('50'), conversionFactor: '1', unitCost: '10.0000', locationId: kitchen }],
    }),
  );
  const manager = actor(orgId, managerId);
  await asOrg(orgId, (tx) =>
    upsertPosItemMap(tx, actor(orgId, adminId), { orgId, storeId, posItemKey: 'cheese', posItemName: 'Cheese', mode: 'direct', itemId: it!.id, quantityPerSale: '1' }),
  );
  const { id: dayId } = await asOrg(orgId, (tx) => importTestDay(tx, manager, { storeId, businessDate: DAY, soldItems: SOLD }));
  const built = await asOrg(orgId, (tx) => buildPlan(tx, manager, { orgId, storeId, salesDayId: dayId, locationId: kitchen }));
  if (!built.ok) throw new Error(`fixture: ${built.reason}`);
  const fin = await asOrg(orgId, (tx) =>
    finalizeSections(tx, manager, { pullId: built.pullId, sections: ['direct', 'recipe', 'orphan'], confirmedKeys: built.lines.map((l) => l.key) }),
  );
  if (!fin.ok) throw new Error(`fixture: ${fin.reason}`);
  // T-401 S6 (Ian 15 Oct): finalize now makes a usage DRAFT. The reversal this form exists for is of pulls finalized BEFORE S6, whose
  // usage was POSTED and linked to the pull (production has them), so the default fixture turns the draft into that legacy state;
  // `{ legacy: false }` keeps the new state (an unposted draft) for the draft-only void.
  if (opts.legacy !== false) {
    await legacyPostPull(sql, asOrg, manager, {
      pullId: built.pullId, storeId, date: DAY,
      lines: built.lines.filter((l) => l.section === 'direct' && !l.blocked && l.itemId).map((l) => ({ key: l.key, itemId: l.itemId!, locationId: l.locationId!, quantity: l.quantity! })),
    });
  }
  return { orgId, storeId, dayId, pullId: built.pullId, manager, nobody: actor(orgId, nobodyId), managerId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function form(f: Fixture, over: Record<string, string | undefined> = {}): FormData {
  const fd = new FormData();
  const fields: Record<string, string | undefined> = { storeId: f.storeId, salesDayId: f.dayId, pullId: f.pullId, reason: 'POS corrected two receipts', ...over };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  return fd;
}

/** Runs the action; returns where it redirected, as a path and its query. */
async function run(f: Fixture, who: Actor, fd: FormData): Promise<{ path: string; q: URLSearchParams }> {
  ACTOR_HOLDER.actor = who;
  const actions = (await import('../../src/app/inventory/pos-usage/actions')) as unknown as Record<string, unknown>;
  const fn = actions.voidPullAction;
  if (typeof fn !== 'function') throw new Error('voidPullAction is not exported from inventory/pos-usage/actions.ts');
  try {
    await (fn as (fd: FormData) => Promise<void>)(fd);
  } catch (err) {
    if (err instanceof RedirectSignal) {
      const u = urlOf(err.to);
      return { path: u.pathname, q: u.searchParams };
    }
    throw err;
  }
  throw new Error('voidPullAction returned without redirecting');
}
const pullStatus = async (id: string) => (await sql<{ status: string }[]>`select status from pos_usage_pulls where id = ${id}`)[0]!.status;
const postedRecords = async (f: Fixture) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_usage_records where org_id = ${f.orgId} and status = 'posted'`)[0]!.n);

const draftsOfDay = async (f: Fixture) =>
  Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_usage_records where org_id = ${f.orgId} and status = 'draft'`)[0]!.n);

describe('T12 - voidPullAction', () => {
  it('(T-401 S6) a pull whose draft is still UNPOSTED: voiding it succeeds (an ok banner, no error), removes the draft, and stock stays untouched', async () => {
    const f = await fixture('draftonly', { legacy: false });
    expect(await draftsOfDay(f), 'control: finalize made one draft').toBe(1);
    expect(await postedRecords(f), 'control: nothing posted').toBe(0);
    const r = await run(f, f.manager, form(f));
    expect(r.q.get('error')).toBeNull();
    expect(r.q.get('ok')).toBeTruthy();
    expect(await pullStatus(f.pullId)).toBe('void');
    expect(await draftsOfDay(f), 'the draft goes with the pull').toBe(0);
    const [m] = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId} and quantity < 0`;
    expect(Number(m!.n)).toBe(0);
  });

  it('ok banner with the count; the pull is void; the loader shows no live pull for the day', async () => {
    const f = await fixture('ok');
    expect(await postedRecords(f), 'control: the (legacy) finalized pull has one posted usage record').toBe(1);
    const { findLivePull } = await import('../../src/app/inventory/pos-usage/lib');
    expect(await findLivePull(f.orgId, f.storeId, f.dayId), 'control: before the void the day has a live pull').not.toBeNull();

    const r = await run(f, f.manager, form(f));
    expect(r.path).toBe('/inventory/pos-usage');
    expect(r.q.get('error')).toBeNull();
    expect(r.q.get('store')).toBe(f.storeId);
    expect(r.q.get('ok')).toBe('Pull voided — 1 usage record(s) reversed. The day can be pulled again.');

    expect(await pullStatus(f.pullId)).toBe('void');
    expect(await postedRecords(f)).toBe(0);
    expect(await findLivePull(f.orgId, f.storeId, f.dayId), 'the loader no longer offers the voided pull as live').toBeNull();
  });

  it('a blank reason -> ?error= with the sentence (no ok, no uuid); the pull is untouched', async () => {
    const f = await fixture('blank');
    const r = await run(f, f.manager, form(f, { reason: '   ' }));
    expect(r.q.get('ok')).toBeNull();
    expect(r.q.get('error')).toBe('Say why this pull is being voided.');
    expect(r.q.get('error')).not.toMatch(UUID);
    expect(await pullStatus(f.pullId)).toBe('finalized');
    expect(await postedRecords(f)).toBe(1);
    // control: the same form with a reason works
    const ok = await run(f, f.manager, form(f));
    expect(ok.q.get('ok')).not.toBeNull();
  });

  it('a person without void_usage_record -> ?error= (no ok); nothing reversed', async () => {
    const f = await fixture('denied');
    const r = await run(f, f.nobody, form(f));
    expect(r.q.get('ok')).toBeNull();
    expect(r.q.get('error')).toBeTruthy();
    expect(await pullStatus(f.pullId)).toBe('finalized');
    expect(await postedRecords(f)).toBe(1);
  });

  it('a second void -> ?error= "already voided" (no ok)', async () => {
    const f = await fixture('twice');
    expect((await run(f, f.manager, form(f))).q.get('ok')).not.toBeNull();
    const r = await run(f, f.manager, form(f, { reason: 'again' }));
    expect(r.q.get('ok')).toBeNull();
    expect(r.q.get('error')).toBe('This POS usage pull was already voided.');
  });
});
