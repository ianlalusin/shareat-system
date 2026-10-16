import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-416 (TESTER) A12 - the schema half of the per-person bucket (migration 0200). docs/tasks/416-per-person-pin-budget.md.
 * Rows are written straight to `pin_attempt_throttle` / `sign_in_attempts` by the owner connection; the constraint is
 * what is under test. RED BEFORE 0200: the `actor_person_id` column does not exist.
 *
 * MUTANTS: M12a drop the CHECK -> A12a red; M12b keep 0199's org-bucket index predicate -> A12c red (an org-bucket row
 * and an actor row in one org collide); M12c drop the composite FK -> A12d red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { closeDb } from '@shareat/db';

const sql = postgres(url, { max: 4 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function mkOrg(hint: string) {
  const code = uid(`t416s-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, 'S') returning id`;
  const person = async (name: string) =>
    (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`)[0]!.id;
  return { orgId, storeId: s!.id, person };
}
/** The Postgres error code a statement raises, or 'OK'. A missing column reports 42703: a red reason, not a pass. */
const code = (p: PromiseLike<unknown>): Promise<string> =>
  Promise.resolve(p).then(
    () => 'OK',
    (e: { code?: string; message?: string }) => e.code ?? `ERR:${e.message}`,
  );

describe('A12 the actor bucket constraints', () => {
  it('A12a: a row with BOTH store_id and actor_person_id is rejected on both tables (M12a)', async () => {
    const o = await mkOrg('a');
    const p = await o.person('P');
    expect(await code(sql`insert into pin_attempt_throttle (org_id, store_id, actor_person_id) values (${o.orgId}, ${o.storeId}, ${p})`)).toBe('23514');
    expect(await code(sql`insert into sign_in_attempts (org_id, store_id, actor_person_id, kind) values (${o.orgId}, ${o.storeId}, ${p}, 'miss')`)).toBe('23514');
  });

  it('A12b: a second throttle row for the same (org, person) is rejected; the first is accepted', async () => {
    const o = await mkOrg('b');
    const p = await o.person('P');
    expect(await code(sql`insert into pin_attempt_throttle (org_id, actor_person_id) values (${o.orgId}, ${p})`)).toBe('OK');
    expect(await code(sql`insert into pin_attempt_throttle (org_id, actor_person_id) values (${o.orgId}, ${p})`)).toBe('23505');
  });

  it('A12c: two different persons in one org both get buckets, next to the org bucket and a store bucket (M12b)', async () => {
    const o = await mkOrg('c');
    const p = await o.person('P');
    const q = await o.person('Q');
    expect(await code(sql`insert into pin_attempt_throttle (org_id) values (${o.orgId})`), 'the org bucket (0199 kept)').toBe('OK');
    expect(await code(sql`insert into pin_attempt_throttle (org_id, actor_person_id) values (${o.orgId}, ${p})`)).toBe('OK');
    expect(await code(sql`insert into pin_attempt_throttle (org_id, actor_person_id) values (${o.orgId}, ${q})`)).toBe('OK');
    expect(await code(sql`insert into pin_attempt_throttle (org_id, store_id) values (${o.orgId}, ${o.storeId})`)).toBe('OK');
    expect(await code(sql`insert into pin_attempt_throttle (org_id) values (${o.orgId})`), 'a SECOND org bucket is still refused').toBe('23505');
  });

  it('A12d: a person of another org is rejected by the same-org FK on both tables (M12c)', async () => {
    const a = await mkOrg('d1');
    const b = await mkOrg('d2');
    const foreign = await b.person('Foreign');
    expect(await code(sql`insert into pin_attempt_throttle (org_id, actor_person_id) values (${a.orgId}, ${foreign})`)).toBe('23503');
    expect(await code(sql`insert into sign_in_attempts (org_id, actor_person_id, kind) values (${a.orgId}, ${foreign}, 'miss')`)).toBe('23503');
    const own = await a.person('Own');
    expect(await code(sql`insert into sign_in_attempts (org_id, actor_person_id, kind) values (${a.orgId}, ${own}, 'miss')`), 'control: own-org person is fine').toBe('OK');
  });
});
