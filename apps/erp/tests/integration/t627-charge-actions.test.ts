import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-627 - the Charges server actions on `/admin/pos-tablets` (`saveChargeAction`, `retireChargeAction`), end to end against Postgres through the REAL domain, session and
 * flash helpers. docs/tasks/627-pos-charges.md. Runs on ANY `_test` database; every row uses fresh ids.
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
  const code = uid('t627e');
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const storeA = (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'Lipa') returning id`)[0]!.id;
  const person = async (name: string, role: string, scope: string) => {
    const id = (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
    await sql`insert into person_roles (person_id, org_id, role) values (${id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id, source) values (${id}, ${scope}, 'manual')`;
    const pin = String(627100 + ++pinSeq);
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
const charges = (f: Fx) => sql<{ id: string; name: string; amount: string; per_unit: boolean; status: string }[]>`
  select id, name, amount::text, per_unit, status from pos_charge_presets where org_id = ${f.orgId} order by name, created_at`;

beforeEach(() => {
  currentJar().store.clear();
});

describe('the Charges screen actions, end to end', () => {
  it('a store manager adds, changes and retires a charge: each lands, says ok, and is audited', async () => {
    const { saveChargeAction, retireChargeAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);

    const a = await run(saveChargeAction, form({ storeId: f.storeA, name: 'Leftover', amount: '150', perUnit: 'on' }));
    expect(a.path).toBe('/admin/pos-tablets');
    expect(a.flash.error).toBeUndefined();
    expect(a.flash.ok).toMatch(/^Added the charge Leftover\./);
    // a grouped peso amount (the number box groups thousands) is read as the plain amount; no tick = once per bill
    await run(saveChargeAction, form({ storeId: f.storeA, name: 'Extra griller', amount: '1,250.5' }));
    expect(await charges(f)).toMatchObject([
      { name: 'Extra griller', amount: '1250.50', per_unit: false, status: 'active' },
      { name: 'Leftover', amount: '150.00', per_unit: true, status: 'active' },
    ]);

    const c = await run(saveChargeAction, form({ storeId: f.storeA, name: 'Leftover', amount: '175' }));
    expect(c.flash.ok).toMatch(/^Changed Leftover\./);
    const leftover = (await charges(f)).find((p) => p.name === 'Leftover')!;
    expect(leftover.amount).toBe('175.00');
    expect(leftover.per_unit).toBe(false); // the box was not ticked this time: that is the new value

    const r = await run(retireChargeAction, form({ storeId: f.storeA, presetId: leftover.id }));
    expect(r.flash.ok).toBe('Charge retired. Cashiers stop seeing it. Past sales keep it.');
    expect((await charges(f)).find((p) => p.id === leftover.id)!.status).toBe('retired');
    // retire then add the same name works (the unique index is on active names only)
    const again = await run(saveChargeAction, form({ storeId: f.storeA, name: 'Leftover', amount: '200' }));
    expect(again.flash.ok).toMatch(/^Added the charge Leftover\./);
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos.charge_preset_set'`).toHaveLength(4);
    expect(await sql`select 1 from audit_log where org_id = ${f.orgId} and action = 'pos.charge_preset_retired'`).toHaveLength(1);
  });

  it('a refusal shows a plain sentence and writes nothing: a zero amount, a blank name, words for an amount', async () => {
    const { saveChargeAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    for (const bad of [{ name: 'Free', amount: '0' }, { name: '  ', amount: '10' }, { name: 'Words', amount: 'abc' }]) {
      const out = await run(saveChargeAction, form({ storeId: f.storeA, ...bad }));
      expect(out.flash.error, JSON.stringify(bad)).toBeTruthy();
      expect(out.flash.error).not.toMatch(/violates|constraint|SQL|syntax/i);
    }
    expect(await charges(f)).toHaveLength(0);
  });

  it('a cashier is refused for add and retire with a sentence, and nothing changes', async () => {
    const { saveChargeAction, retireChargeAction } = await actions();
    const f = await fixture();
    await f.signedInAs(f.managerA);
    await run(saveChargeAction, form({ storeId: f.storeA, name: 'Leftover', amount: '150' }));
    const [p] = await charges(f);
    currentJar().store.clear();
    await f.signedInAs(f.staffA);
    const add = await run(saveChargeAction, form({ storeId: f.storeA, name: 'Sneaky', amount: '5' }));
    const gone = await run(retireChargeAction, form({ storeId: f.storeA, presetId: p!.id }));
    expect(add.flash.error).toBeTruthy();
    expect(gone.flash.error).toBeTruthy();
    expect(await charges(f)).toMatchObject([{ name: 'Leftover', status: 'active' }]);
  });
});
