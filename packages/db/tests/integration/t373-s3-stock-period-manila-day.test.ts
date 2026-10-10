import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { testItemCode } from '../../../domain/tests/integration/_fixtures/item-code';

/**
 * T-373 S3 / DEF-555 (TESTER) - the closed-month stock trigger judges a movement by its MANILA business day.
 * `docs/tasks/373-money-follow-ups.md` section S3, R5. The trigger alone, by direct insert with an explicit `moved_at`;
 * the flows that stamp `now` are `packages/domain/tests/integration/t373-s3-now-stamped-flows.test.ts`.
 *
 * Fixture: March 2026 closed, April 2026 open (no other period, so nothing else can refuse). Every "accepted" leg is
 * paired, in the same test, with a control that IS refused, so a trigger that refused/accepted everything fails.
 *   T1  00:00 and 07:59:59 Manila on 1 April (UTC date = 31 March, closed) are accepted.   [red on HEAD: UTC date]
 *   T2  23:59:59 Manila on 31 March (UTC date = 31 March too) is refused with 0145's sentence.   [control]
 *   T3  date-stamped writers (UTC midnight) are unchanged: 2026-04-01T00:00Z accepted, 2026-03-31T00:00Z refused.
 *   T4  T2 under app.period_override = 'on' -> the override sentence, unchanged.
 *   T5  a locked month (Dec 2025 -> Jan 2026): 15:59:59Z refused, 16:00:00Z accepted - one second apart.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const sql = postgres(url, { max: 3 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

async function fixture(withMarchApril = true) {
  const code = uid('t373s3');
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Store', 'single_room') returning id`;
  const [person] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  const [type] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [location] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgId}, ${store!.id}, 'A', 'Room A', ${type!.id}, ${person!.id}) returning id`;
  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgId}, ${testItemCode()}, 'Test Item', 'raw_material', 'kg', ${person!.id}) returning id`;
  // March closed, April open. Earlier months do not exist (a date no period covers is allowed by the trigger).
  if (withMarchApril) {
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
              (${orgId}, '2026-03-01', '2026-03-31', 'closed'), (${orgId}, '2026-04-01', '2026-04-30', 'open')`;
  }
  return { orgId, storeId: store!.id, locationId: location!.id, itemId: item!.id, personId: person!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Insert one movement at `movedAt` (an ISO instant); resolves 'accepted' or the trigger's message. `override` sets the GUC first. */
async function move(f: Fixture, movedAt: string, override = false): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      if (override) await tx`select set_config('app.period_override', 'on', true)`;
      await tx`
        insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
        values (${f.orgId}, ${f.storeId}, ${f.locationId}, ${f.itemId}, ${movedAt}::timestamptz, 1, 'opening', 'test', ${crypto.randomUUID()}, ${f.personId})`;
    });
    return 'accepted';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const rows = async (f: Fixture) => Number((await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where org_id = ${f.orgId}`)[0]!.n);

const CLOSED = /^cannot move stock into a closed period \(moved_at = /;

describe('T-373 S3 - the trigger judges moved_at by its Manila date', () => {
  it('T1: 00:00 Manila and 07:59:59 Manila on 1 April are accepted although their UTC date is 31 March (closed) - control: 23:59:59 Manila on 31 March is refused', async () => {
    const f = await fixture();
    expect(await move(f, '2026-03-31T15:59:59Z'), 'control: the last second of a closed Manila March is refused').toMatch(CLOSED);
    expect(await rows(f)).toBe(0);
    expect(await move(f, '2026-03-31T16:00:00Z'), '00:00 Manila on 1 April').toBe('accepted');
    expect(await move(f, '2026-03-31T23:59:59Z'), '07:59:59 Manila on 1 April').toBe('accepted');
    expect(await rows(f)).toBe(2);
  });

  it('T2: 23:30 and 23:59:59 Manila on 31 March (UTC date also 31 March) are refused with 0145\'s exact sentence, nothing written - control: noon Manila on 1 April is accepted', async () => {
    const f = await fixture();
    for (const at of ['2026-03-31T15:30:00Z', '2026-03-31T15:59:59Z']) {
      const said = await move(f, at);
      expect(said, at).toMatch(CLOSED);
      expect(said).not.toMatch(/override/i);
    }
    expect(await rows(f)).toBe(0);
    expect(await move(f, '2026-04-01T04:00:00Z'), 'control: noon Manila on 1 April').toBe('accepted');
  });

  it('T3: date-stamped writers (UTC midnight) are unchanged - 2026-04-01T00:00Z accepted, 2026-03-31T00:00Z refused', async () => {
    const f = await fixture();
    expect(await move(f, '2026-03-31T00:00:00Z'), 'a movement dated 31 March').toMatch(CLOSED);
    expect(await move(f, '2026-03-01T00:00:00Z'), 'a movement dated 1 March').toMatch(CLOSED);
    expect(await move(f, '2026-04-01T00:00:00Z'), 'a movement dated 1 April').toBe('accepted');
    expect(await rows(f)).toBe(1);
  });

  it('T4: under app.period_override = on the refusal is the override sentence, unchanged - and a Manila-April instant is still accepted (the override changes the wording only)', async () => {
    const f = await fixture();
    const said = await move(f, '2026-03-31T15:59:59Z', true);
    expect(said).toMatch(CLOSED);
    expect(said).toMatch(/does not extend to stock movements/i);
    expect(await rows(f)).toBe(0);
    expect(await move(f, '2026-03-31T16:00:00Z', true), 'Manila 1 April with the override held').toBe('accepted');
  });

  it('T5: a locked month (Dec 2025, the year boundary) judges by Manila date the same way - 2025-12-31T15:59:59Z refused as locked, 16:00:00Z (00:00 Manila on 1 Jan) accepted', async () => {
    const f = await fixture(false);
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2025-12-01', '2025-12-31', 'closed'), (${f.orgId}, '2026-01-01', '2026-01-31', 'open')`;
    await sql`update fiscal_periods set status = 'locked' where org_id = ${f.orgId} and starts_on = '2025-12-01'`;
    expect(await move(f, '2025-12-31T15:59:59Z')).toMatch(/^cannot move stock into a locked period \(moved_at = /);
    expect(await move(f, '2025-12-31T16:00:00Z')).toBe('accepted');
  });
});
