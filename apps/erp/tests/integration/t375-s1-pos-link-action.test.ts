import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-375 S1 audit follow-ups, F3 - `apps/erp/src/app/settings/pos-link/actions.ts`.
 *
 * TESTER, not BUILDER. The action is driven end to end (real Postgres, real `linkStoreToPos`); only the session, the
 * Next navigation helpers and the POS bridge fetch (`fetchPosV1Stores`, spied) are replaced.
 *
 *  - (a) a signed-in actor WITHOUT `manage_chart_of_accounts` must be refused BEFORE the POS bridge is called: the
 *    spy is not hit, the action redirects with an `error`, and no link row exists. Control: an admin reaches the
 *    bridge, and links.
 *  - (b) a `posStoreId` that is not among the stores the bridge returns is refused, whatever name the form carries,
 *    and no link row is written. The sentence is the tester's choice: it must name POS and tell the person to
 *    choose from the list (`/choose|pick|list/i`). Control: a listed id links, and the stored name is the BRIDGE's.
 *    Control: with the bridge unavailable the text-box path still links.
 *
 * Red on HEAD: (a) the action calls `posStoreOptions()` (the bridge) before any authorisation; (b) the action
 * accepts any id, and the forged one links.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({
  actor: null as null | { personId: string; orgId: string },
  stores: vi.fn(async () => [] as { id: string; name: string }[]),
}));

class Redirected extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT ${target}`);
  }
}
vi.mock('../../src/lib/session', () => ({ requireActor: vi.fn(async () => h.actor) }));
vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new Redirected(target);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@shareat/domain', async (orig) => ({ ...(await orig<typeof import('@shareat/domain')>()), fetchPosV1Stores: () => h.stores() }));

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { linkStoreToPosAction } from '../../src/app/settings/pos-link/actions';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

beforeEach(() => {
  h.stores.mockReset();
  h.stores.mockResolvedValue([]);
});

async function fixture(hint: string) {
  const code = uid(`t375s1a-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, 'Lipa') returning id`;
  const storeId = store!.id;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return { personId: p!.id, orgId };
  };
  const admin = await mk('Admin', 'admin');
  const manager = await mk('Manager', 'manager');
  const [ch] = await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`;
  return { orgId, storeId, channelId: ch!.id, admin, manager, listed: uid('pos-listed'), forged: uid('pos-forged') };
}
type F = Awaited<ReturnType<typeof fixture>>;

function form(f: F, posStoreId: string, extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('storeName', 'Lipa');
  fd.set('posStoreId', posStoreId);
  fd.set('posTaxType', 'vat_inclusive');
  fd.set('salesChannelId', f.channelId);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

/** Runs the action and returns the redirect's query (the action always ends in a redirect). */
async function run(as: { personId: string; orgId: string }, fd: FormData): Promise<URLSearchParams> {
  h.actor = as;
  const err = await linkStoreToPosAction(fd).then(() => null, (e) => e);
  expect(err, 'the action ends by redirecting').toBeInstanceOf(Redirected);
  return new URL((err as Redirected).target, 'http://x').searchParams;
}

const links = (storeId: string) =>
  sql<{ pos_store_id: string; pos_store_name: string }[]>`select pos_store_id, pos_store_name from pos_v1_store_links where store_id = ${storeId}`;

describe('F3a - the POS bridge is not called for an actor who may not link', () => {
  it('a manager (no manage_chart_of_accounts): redirected with an error, the bridge spy is NOT called, no link row', async () => {
    const f = await fixture('a');
    h.stores.mockResolvedValue([{ id: f.listed, name: 'Listed' }]);
    const q = await run(f.manager, form(f, f.listed));
    expect(q.get('error'), 'a refusal sentence is shown').toBeTruthy();
    expect(q.get('ok')).toBeNull();
    expect(h.stores, 'the bridge must not be called before authorisation').not.toHaveBeenCalled();
    expect(await links(f.storeId)).toHaveLength(0);
  });

  it('control: an admin reaches the bridge and links the listed store', async () => {
    const f = await fixture('ac');
    h.stores.mockResolvedValue([{ id: f.listed, name: 'Listed' }]);
    const q = await run(f.admin, form(f, f.listed));
    expect(q.get('error')).toBeNull();
    expect(q.get('ok')).toBeTruthy();
    expect(h.stores).toHaveBeenCalledTimes(1);
    expect(await links(f.storeId)).toEqual([{ pos_store_id: f.listed, pos_store_name: 'Listed' }]);
  });
});

describe('F3b - a posStoreId the bridge did not list is refused', () => {
  it('forged id (picker path, no name): refused with a choose-from-the-list sentence naming POS; no link row', async () => {
    const f = await fixture('b');
    h.stores.mockResolvedValue([{ id: f.listed, name: 'Listed' }]);
    const q = await run(f.admin, form(f, f.forged));
    expect(await links(f.storeId), 'a forged POS id must not link').toHaveLength(0);
    expect(q.get('ok')).toBeNull();
    expect(q.get('error') ?? '').toMatch(/POS/);
    expect(q.get('error') ?? '').toMatch(/choose|pick|list/i);
  });

  it('forged id WITH a posStoreName in the form: still refused, no link row', async () => {
    const f = await fixture('b2');
    h.stores.mockResolvedValue([{ id: f.listed, name: 'Listed' }]);
    const q = await run(f.admin, form(f, f.forged, { posStoreName: 'Anything' }));
    expect(await links(f.storeId)).toHaveLength(0);
    expect(q.get('ok')).toBeNull();
  });

  it("control: the listed id links, and the stored name is the bridge's, not the form's", async () => {
    const f = await fixture('bc');
    h.stores.mockResolvedValue([{ id: f.listed, name: 'Listed' }]);
    const q = await run(f.admin, form(f, f.listed, { posStoreName: 'Form says otherwise' }));
    expect(q.get('ok')).toBeTruthy();
    expect(await links(f.storeId)).toEqual([{ pos_store_id: f.listed, pos_store_name: 'Listed' }]);
  });

  it('control: bridge unavailable -> the text-box path still links any id with its name', async () => {
    const f = await fixture('bt');
    h.stores.mockRejectedValue(new Error('not configured'));
    const q = await run(f.admin, form(f, f.forged, { posStoreName: 'Typed name' }));
    expect(q.get('ok')).toBeTruthy();
    expect(await links(f.storeId)).toEqual([{ pos_store_id: f.forged, pos_store_name: 'Typed name' }]);
  });
});
