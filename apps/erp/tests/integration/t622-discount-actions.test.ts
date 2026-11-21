import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-622 - the Discounts server actions on `/admin/pos-tablets` (`savePresetAction`, `retirePresetAction`), end to end against Postgres through the REAL
 * domain, session and flash helpers. docs/tasks/622-pos-discount-presets-screen.md. Runs on ANY `_test` database; every row uses fresh ids.
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
  const code = uid('t622e');
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const store = async (n: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, ${n}) returning id`)[0]!.id;
  const storeA = await store('Lipa');
  const storeB = await store('Malvar');
  const person = async (name: string, role: string, scope: string) => {
    const id = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${id}, ${scope}, 'manual')`;
    const pin = String(622100 + ++pinSeq);
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
              values (${id}, 'pin', ${scope}, ${await hashPin(pin)}, ${pinLookupHash(orgId, pin)})`;
    return { id, pin, scope };
  };
  const managerA = await person('Manager A', 'manager', storeA);
  const staffA = await person('Staff A', 'staff', storeA);
  await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${orgId}, ${storeA}, ${staffA.id}, 'SE-001', 'regular', '2026-01-01')`;
  const signedInAs = async (who: { pin: string; scope: string }) => {
    const s = await signInWithPin(null, { orgId, storeId: who.scope, pin: who.pin });
    currentJar().set('shareat_session', s.token, {});
    return s.token;
  };
  return { orgId, storeA, managerA, staffA, signedInAs };
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
const presets = (f: Fx) => sql<{ id: string; name: string; value_type: string; value: string; status: string }[]>`
  select id, name, value_type, value::text, status from pos_discount_presets where org_id = ${f.orgId} order by name, created_at`;

beforeEach(() => {
  currentJar().store.clear();
});

describe('the Discounts screen actions, end to end', () => {
  it('a store manager adds, changes and retires a discount: each lands, says ok, and is audited', async () => {
    const { savePresetAction, retirePresetAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);

    const a = await run(savePresetAction, form({ storeId: f.storeA, name: 'Staff meal', valueType: 'percent', value: '20' }));
    expect(a.path).toBe('/admin/pos-tablets');
    expect(a.flash.error).toBeUndefined();
    expect(a.flash.ok).toMatch(/^Added the discount Staff meal\./);
    // a grouped peso amount (the number box groups thousands) is read as the plain amount
    await run(savePresetAction, form({ storeId: f.storeA, name: 'Big night', valueType: 'fixed', value: '1,250.5' }));
    expect(await presets(f)).toMatchObject([
      { name: 'Big night', value_type: 'fixed', value: '1250.50', status: 'active' },
      { name: 'Staff meal', value_type: 'percent', value: '20.00', status: 'active' },
    ]);

    const c = await run(savePresetAction, form({ storeId: f.storeA, name: 'Staff meal', valueType: 'percent', value: '25' }));
    expect(c.flash.ok).toMatch(/^Changed Staff meal\./);
    const staff = (await presets(f)).find((p) => p.name === 'Staff meal')!;
    expect(staff.value).toBe('25.00');

    const r = await run(retirePresetAction, form({ storeId: f.storeA, presetId: staff.id }));
    expect(r.flash.ok).toBe('Discount retired. Cashiers stop seeing it. Past sales keep it.');
    expect((await presets(f)).find((p) => p.id === staff.id)!.status).toBe('retired');
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos.discount_preset_set'`).toHaveLength(3);
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos.discount_preset_retired'`).toHaveLength(1);
  });

  it('a refusal shows a plain sentence and writes nothing: percent over 100, a zero value, a blank name', async () => {
    const { savePresetAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    const over = await run(savePresetAction, form({ storeId: f.storeA, name: 'Too much', valueType: 'percent', value: '150' }));
    expect(over.flash.error).toMatch(/percent over 100/);
    for (const bad of [{ name: 'Free', value: '0' }, { name: '  ', value: '10' }, { name: 'Words', value: 'abc' }]) {
      const out = await run(savePresetAction, form({ storeId: f.storeA, valueType: 'percent', ...bad }));
      expect(out.flash.error, JSON.stringify(bad)).toBeTruthy();
      expect(out.flash.error).not.toMatch(/violates|constraint|SQL|syntax/i);
    }
    expect(await presets(f)).toHaveLength(0);
  });

  it('a cashier is refused for add and retire with a sentence, and nothing changes', async () => {
    const { savePresetAction, retirePresetAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    await run(savePresetAction, form({ storeId: f.storeA, name: 'Staff meal', valueType: 'percent', value: '20' }));
    const [p] = await presets(f);
    currentJar().store.clear();
    await f.signedInAs(f.staffA);
    const add = await run(savePresetAction, form({ storeId: f.storeA, name: 'Sneaky', valueType: 'percent', value: '5' }));
    const gone = await run(retirePresetAction, form({ storeId: f.storeA, presetId: p!.id }));
    expect(add.flash.error).toBeTruthy();
    expect(gone.flash.error).toBeTruthy();
    expect(await presets(f)).toMatchObject([{ name: 'Staff meal', status: 'active' }]);
  });
});
