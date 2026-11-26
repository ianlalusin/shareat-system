import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-634 - the charge server actions on `/admin/pos-tablets` (the org list: create / update / retire; a store: switch on / off), end to end against Postgres through
 * the REAL domain, session and flash helpers. docs/tasks/634-central-charges.md. Not run on the builder's PC (no database): CI runs it. Runs on ANY `_test` database; every row uses fresh ids.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) throw new Error('Refusing to run: the database name must contain "_test".');

import { currentJar, RedirectSignal } from '../../../../tests/helpers/flash-jar-core';
import { outcomeOf } from '../../../../tests/helpers/flash-jar';
import { closeDb } from '@shareat/db';
import { hashPin, pinLookupHash, signInWithPin } from '@shareat/auth';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => {
  const core = await import('../../../../tests/helpers/flash-jar-core');
  return {
    redirect: (to: string) => {
      throw new core.RedirectSignal(to);
    },
    notFound: () => {
      throw new Error('notFound() called');
    },
  };
});

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
let pinSeq = 0;

async function fixture() {
  const code = uid('t634e');
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const storeA = (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Lipa') returning id`)[0]!.id;
  const person = async (name: string, role: string, scope: string) => {
    const id = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${id}, ${scope}, 'manual')`;
    const pin = String(634100 + ++pinSeq);
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
              values (${id}, 'pin', ${scope}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { id, pin, scope };
  };
  const adminA = await person('Admin A', 'admin', storeA);
  const managerA = await person('Manager A', 'manager', storeA);
  const staffA = await person('Staff A', 'staff', storeA);
  await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeA}, ${staffA.id}, 'SE-001', 'regular', '2026-01-01')`;
  const signedInAs = async (who: { pin: string; scope: string }) => {
    const s = await signInWithPin(null, { orgId, storeId: who.scope, pin: who.pin });
    currentJar().set('shareat_session', s.token, {});
    return s.token;
  };
  return { orgId, storeA, adminA, managerA, staffA, signedInAs };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

const form = (o: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(o)) fd.set(k, v);
  return fd;
};
async function run(action: (fd: FormData) => Promise<void>, fd: FormData) {
  try {
    await action(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return outcomeOf(e);
    throw e;
  }
  throw new Error('expected a redirect');
}
const actions = () => import('../../src/app/admin/pos-tablets/actions');
const options = (f: Fx) => sql<{ id: string; name: string; amount: string; per_unit: boolean; status: string }[]>`
  select id, name, amount::text, per_unit, status from charge_options where org_id = ${f.orgId} order by name`;
const storeRows = (f: Fx) => sql<{ name: string; amount: string; status: string }[]>`
  select name, amount::text, status from pos_charge_presets where org_id = ${f.orgId} and store_id = ${f.storeA} order by name, created_at`;

beforeEach(() => {
  currentJar().store.clear();
});

describe('T-634 the charge actions, end to end', () => {
  it('an administrator adds a charge for all stores, changes its amount and (once it is off everywhere) retires it; each says ok', async () => {
    const { createChargeOptionAction, updateChargeOptionAction, setChargeOptionStatusAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.adminA);

    const a = await run(createChargeOptionAction, form({ storeId: f.storeA, name: 'Leftover', amount: '1,250.5', perUnit: 'on' }));
    expect(a.path).toBe('/admin/pos-tablets');
    expect(a.flash.error).toBeUndefined();
    expect(a.flash.ok).toBe('Added the charge Leftover for all stores. Switch it on at each store that uses it.');
    const [o] = await options(f);
    expect(o).toMatchObject({ name: 'Leftover', amount: '1250.50', per_unit: true, status: 'active' });

    const u = await run(updateChargeOptionAction, form({ storeId: f.storeA, chargeOptionId: o!.id, amount: '175' }));
    expect(u.flash.ok).toBe('Charge changed for all stores (0 stores have it on). Charges already on a table keep their amount.');
    expect((await options(f))[0]).toMatchObject({ amount: '175.00', per_unit: false });

    const r = await run(setChargeOptionStatusAction, form({ storeId: f.storeA, chargeOptionId: o!.id, status: 'retired' }));
    expect(r.flash.ok).toBe('Charge retired for all stores. Past bills keep it.');
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action like 'charge_option.%'`).toHaveLength(3);
  });

  it('a store manager switches a charge on and off at their store, but is refused on the org list', async () => {
    const { createChargeOptionAction, setStoreChargeAction, updateChargeOptionAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.adminA);
    await run(createChargeOptionAction, form({ storeId: f.storeA, name: 'Extra griller', amount: '150' }));
    const [o] = await options(f);
    currentJar().store.clear();
    await f.signedInAs(f.managerA);

    const refused = await run(createChargeOptionAction, form({ storeId: f.storeA, name: 'Sneaky', amount: '5' }));
    expect(refused.flash.error).toBeTruthy();
    const refused2 = await run(updateChargeOptionAction, form({ storeId: f.storeA, chargeOptionId: o!.id, amount: '1' }));
    expect(refused2.flash.error).toBeTruthy();
    expect(await options(f)).toHaveLength(1);
    expect((await options(f))[0]!.amount).toBe('150.00');

    const on = await run(setStoreChargeAction, form({ storeId: f.storeA, chargeOptionId: o!.id, on: '1' }));
    expect(on.flash.ok).toBe('Extra griller is on at this store. The tablet shows the change after its next refresh.');
    expect(await storeRows(f)).toEqual([{ name: 'Extra griller', amount: '150.00', status: 'active' }]);
    const off = await run(setStoreChargeAction, form({ storeId: f.storeA, chargeOptionId: o!.id, on: '0' }));
    expect(off.flash.ok).toBe('Extra griller is off at this store. The tablet shows the change after its next refresh.');
    // on again reuses the one row: no duplicate
    await run(setStoreChargeAction, form({ storeId: f.storeA, chargeOptionId: o!.id, on: '1' }));
    expect(await storeRows(f)).toEqual([{ name: 'Extra griller', amount: '150.00', status: 'active' }]);
  });

  it('a cashier is refused the store switch; retiring a charge that a store has on is refused in words', async () => {
    const { createChargeOptionAction, setStoreChargeAction, setChargeOptionStatusAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.adminA);
    await run(createChargeOptionAction, form({ storeId: f.storeA, name: 'Leftover', amount: '100' }));
    const [o] = await options(f);
    await run(setStoreChargeAction, form({ storeId: f.storeA, chargeOptionId: o!.id, on: '1' }));
    const r = await run(setChargeOptionStatusAction, form({ storeId: f.storeA, chargeOptionId: o!.id, status: 'retired' }));
    expect(r.flash.error).toBe('Leftover is switched on at 1 store. Switch it off there first, then retire it.');
    expect((await options(f))[0]!.status).toBe('active');

    currentJar().store.clear();
    await f.signedInAs(f.staffA);
    const s = await run(setStoreChargeAction, form({ storeId: f.storeA, chargeOptionId: o!.id, on: '0' }));
    expect(s.flash.error).toBeTruthy();
    expect((await storeRows(f))[0]!.status).toBe('active');
  });
});
