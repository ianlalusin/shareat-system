/**
 * T-526b (real Postgres) - the P0 from the render: a Kitchen Staff or Server person signing in on the PAIRED tablet must land on the first tab
 * they may open (/pos/kitchen, /pos/refills), not on /pos where `record_sale` refuses them. This drives the REAL `signInWithTabletPinAction`
 * with a fake cookie jar and a real pairing, and reads the redirect. Runs on any `_test` database; names none.
 */
import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: the database name must contain "_test".');

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
class FakeJar {
  store = new Map<string, string>();
  set(name: string, value: string) {
    this.store.set(name, value);
  }
  get(name: string) {
    const value = this.store.get(name);
    return value === undefined ? undefined : { name, value };
  }
  delete(name: string) {
    this.store.delete(name);
  }
}
let jar = new FakeJar();
vi.mock('next/headers', () => ({ cookies: async () => jar }));

import { pairPosTablet } from '@shareat/auth';
import { withOrgPrincipal } from '../../src/app/expenses/lib';
import { closeAll, fixture, makeStaff, pinOf, sql, type Fx } from '../../../../packages/domain/tests/integration/_fixtures/t525-pos';

let f: Fx;
let token: string;
const people: Record<string, { code: string; pin: string }> = {};

async function staffOn(position: string | null, name: string): Promise<{ code: string; pin: string }> {
  const id = await makeStaff({ orgId: f.orgId, storeId: f.storeId, adminId: f.adminId }, name, position ? [] : undefined);
  const [emp] = await sql<{ id: string; staff_code: string }[]>`select id, staff_code from employments where person_id = ${id}`;
  if (position) {
    const [pos] = await sql<{ id: string }[]>`select id from positions where org_id = ${f.orgId} and name = ${position} and is_canonical`;
    await sql`delete from employment_positions where employment_id = ${emp!.id}`;
    await sql`insert into employment_positions (employment_id, position_id, is_primary) values (${emp!.id}, ${pos!.id}, true)`;
  }
  return { code: emp!.staff_code.replace(/\D/g, ''), pin: await pinOf(f, id) };
}

beforeAll(async () => {
  f = await fixture('test');
  for (const n of ['Kitchen Staff', 'Server']) {
    await sql`insert into positions (org_id, store_id, name, is_canonical, is_active) values (${f.orgId}, null, ${n}, true, true)`;
  }
  people.cashier = await staffOn(null, 'Carla Cashier'); // the everyday grants include record_sale
  people.kitchen = await staffOn('Kitchen Staff', 'Kiko Kitchen');
  people.server = await staffOn('Server', 'Sam Server');
  // The REAL B0240 block: what the canonical positions are granted.
  const text = readFileSync('packages/db/migrations/0240_t524_receipt_append_guard.sql', 'utf8');
  const stmts = text.slice(text.indexOf('-- B0240:begin'), text.indexOf('-- B0240:end')).split(/-->\s*statement-breakpoint/).map((x) => x.trim()).filter(Boolean);
  await sql.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
  });
  token = (await withOrgPrincipal(f.orgId, (tx) => pairPosTablet(tx, f.admin, { storeId: f.storeId, label: 'Lipa counter' }))).token;
});
afterAll(closeAll);

async function signIn(who: { code: string; pin: string }, next = '', paired = true): Promise<string> {
  jar = new FakeJar();
  if (paired) jar.set('shareat_pos_tablet', token);
  const fd = new FormData();
  fd.set('staffCode', who.code);
  fd.set('pin', who.pin);
  fd.set('next', next);
  const { signInWithTabletPinAction } = await import('../../src/app/sign-in/actions');
  try {
    await signInWithTabletPinAction(fd);
  } catch (e) {
    if (e instanceof RedirectSignal) return e.to;
    throw e;
  }
  throw new Error('no redirect');
}

describe('T-526b P0 - where the paired tablet sends each position after the real sign-in action', () => {
  it('Cashier (record_sale) -> /pos', async () => {
    expect(await signIn(people.cashier!)).toBe('/pos');
  }, 60_000);
  it('Kitchen Staff (serve_pos_ticket only) -> /pos/kitchen', async () => {
    expect(await signIn(people.kitchen!)).toBe('/pos/kitchen');
  }, 60_000);
  it('Server (request_pos_refill only) -> /pos/refills', async () => {
    expect(await signIn(people.server!)).toBe('/pos/refills');
  }, 60_000);
  // The ROOT CAUSE: a tablet that opens /pos signed out is sent to /sign-in?next=/pos, so the kitchen person arrived with next=/pos.
  it('ROOT CAUSE: Kitchen Staff and Server arriving with next=/pos (the redirect a signed-out tablet gets) land on their own tab, not /pos', async () => {
    expect(await signIn(people.kitchen!, '/pos')).toBe('/pos/kitchen');
    expect(await signIn(people.server!, '/pos')).toBe('/pos/refills');
    expect(await signIn(people.server!, '/pos/kitchen')).toBe('/pos/refills');
  }, 60_000);
  it('controls: a POS next the person may open wins (cashier /pos, /pos/receipts; kitchen /pos/kitchen); a non-POS next always wins', async () => {
    expect(await signIn(people.cashier!, '/pos')).toBe('/pos');
    expect(await signIn(people.cashier!, '/pos/receipts')).toBe('/pos/receipts');
    expect(await signIn(people.kitchen!, '/pos/kitchen')).toBe('/pos/kitchen');
    expect(await signIn(people.kitchen!, '/inventory')).toBe('/inventory');
  }, 60_000);
});
