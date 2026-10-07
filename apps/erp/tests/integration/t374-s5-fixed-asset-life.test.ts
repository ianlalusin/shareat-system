import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-374 S5 (DEF-584, ✎R9) — WEB leg: `createAssetAction` reads the useful-life box with `Number()`, so `0x10` is saved as 16 and `1e1` as 10.
 *   '0x10' / '1e1' -> redirect to /fixed-assets/new with ?error = the whole-number sentence; no asset row (red today: HEAD saves a 16 / 10-month asset).
 *   Controls: '16' -> a 16-month asset; blank -> the category default (the life an omitted box gets).
 * ⛔ TESTER. Harness is t370-settings-attendance-web's (one RedirectSignal, one session holder, the real constraint-messages, a real Postgres).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
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
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({ actor: ACTOR_HOLDER.actor!, sessionId: 's' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { paramsOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t374fa-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, '0');
    const last = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, ${`2026-${mm}-01`}, ${`2026-${mm}-${last}`}, 'open')`;
  }
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, opening_date) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}, '2020-01-01') returning id`;
  const [admin] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${admin!.id}, ${orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${admin!.id}, ${store!.id})`;
  return { orgId, storeId: store!.id, admin: { orgId, personId: admin!.id } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function form(f: Fixture, life: string): FormData {
  const fd = new FormData();
  fd.set('storeId', f.storeId);
  fd.set('name', 'Chest freezer');
  fd.set('category', 'appliances');
  fd.set('acquiredOn', '2026-01-15');
  fd.set('cost', '120000.00');
  fd.set('usefulLifeMonths', life);
  fd.set('interval', 'monthly');
  return fd;
}
async function submit(f: Fixture, fd: FormData): Promise<string> {
  ACTOR_HOLDER.actor = f.admin;
  const { createAssetAction } = await import('../../src/app/fixed-assets/actions');
  try {
    await createAssetAction(fd);
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => paramsOf(to).get(k);
const lives = async (storeId: string) =>
  (await sql<{ u: number }[]>`select useful_life_months as u from fixed_assets where store_id = ${storeId} order by created_at`).map((r) => r.u);
const sentence = (typed: string) => `The useful life — "${typed}" is not a whole number of months from 1 to 1200.`;

describe('DEF-584 web — a hex / exponent useful life is refused in words, nothing saved', () => {
  for (const typed of ['0x10', '1e1', '1201']) {
    it(`usefulLifeMonths ${JSON.stringify(typed)} -> ?error = the sentence, redirect to /fixed-assets/new; no asset row — red today: HEAD saves it via Number()`, async () => {
      const f = await fixture('r');
      const to = await submit(f, form(f, typed));
      expect(param(to, 'error') ?? `NO error — redirected to ${to}; assets saved with lives ${JSON.stringify(await lives(f.storeId))}`).toBe(sentence(typed));
      expect(to).toMatch(/^\/fixed-assets\/new\?/);
      expect(await lives(f.storeId), 'a refused form wrote an asset').toEqual([]);
    });
  }
});

describe('controls — the same door saves honest input, so the empty counts above are not an inert path', () => {
  it("'16' -> a 16-month asset", async () => {
    const f = await fixture('c16');
    const to = await submit(f, form(f, '16'));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(to).toMatch(/^\/fixed-assets\/[0-9a-f-]{36}/);
    expect(await lives(f.storeId)).toEqual([16]);
  });

  it('blank -> the category default, the same life an omitted box gets (domain default), not 0 and not refused', async () => {
    const f = await fixture('cb');
    const to = await submit(f, form(f, ''));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    const [life] = await lives(f.storeId);
    expect(life).toBeGreaterThan(0);
    expect(life).not.toBe(16);
  });
});
