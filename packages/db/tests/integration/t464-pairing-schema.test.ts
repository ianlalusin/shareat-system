import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-464 (migration 0214) - the database guarantees under the POS tablet sign-in:
 *   - employments.staff_code is ALWAYS `SE-` + 3 or more digits, and two codes at one store never share a NUMBER (SE-007 vs SE-0007);
 *   - the allocator reads only `SE-` + digits and survives a digit-heavy code (DEF-725);
 *   - pos_tablet_pairings: one LIVE pairing per store, same-org composite FKs, org-isolation RLS, no DELETE for the app role;
 *   - the Employee ID bucket (pin_attempt_throttle.staff_code) coexists with the store's own bucket.
 * Runs on ANY `_test` database; every row uses fresh ids.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run: the database name must contain "_test".');

import { APP_ROLE, closeDb, employmentRepo, posTabletPairingsRepo, transaction, type Tx } from '@shareat/db';

const sql = postgres(url, { max: 4 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function fixture() {
  const code = uid('t464s');
  const orgId = (await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`)[0]!.id;
  const store = async () => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('S')}, 'S') returning id`)[0]!.id;
  const person = async () => (await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'P') returning id`)[0]!.id;
  const storeA = await store();
  const storeB = await store();
  const manager = await person();
  const employ = async (storeId: string, staffCode: string) =>
    sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
        values (${orgId}, ${storeId}, ${await person()}, ${staffCode}, 'regular', '2026-01-01')`;
  return { orgId, storeA, storeB, manager, employ, person, store };
}

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const refused = (p: PromiseLike<unknown>) => Promise.resolve(p).then(() => null, (e: { code?: string; message?: string; cause?: { code?: string; constraint_name?: string } }) => e);

describe('employments.staff_code - the shape and the number are guaranteed by the database', () => {
  it('refuses a code that is not SE- plus 3+ digits (each of these used to be insertable)', async () => {
    const f = await fixture();
    for (const bad of ['EMP-7', 'se-007', 'SE-07', 'SE-0A7', '123456', 'SE-007 ', '', 'SE-']) {
      const e = await refused(f.employ(f.storeA, bad));
      expect(e, `mutant: CHECK removed - "${bad}" was accepted`).not.toBeNull();
      expect(e!.message).toMatch(/employments_staff_code_shape_check/);
    }
    await expect(f.employ(f.storeA, 'SE-007')).resolves.toBeDefined();
    await expect(f.employ(f.storeA, 'SE-1000')).resolves.toBeDefined();
  });

  it('SE-007 and SE-0007 can never coexist at one store; the same number at ANOTHER store is fine', async () => {
    const f = await fixture();
    await f.employ(f.storeA, 'SE-007');
    const e = await refused(f.employ(f.storeA, 'SE-0007'));
    expect(e, 'mutant: number index removed').not.toBeNull();
    expect(e!.message).toMatch(/employments_store_staff_number_unique/);
    await expect(f.employ(f.storeB, 'SE-0007')).resolves.toBeDefined();
  });
});

describe('allocateStaffCode (DEF-725)', () => {
  it('a digit-heavy code at the store no longer overflows the allocator: the next code is max + 1, padded to 3', async () => {
    const f = await fixture();
    await f.employ(f.storeA, 'SE-003');
    await f.employ(f.storeA, 'SE-99999999999999999999'); // 20 digits: the old regexp_replace(...)::int overflowed on this
    const next = await asOrg(f.orgId, (tx) => employmentRepo.allocateStaffCode(tx, f.storeA));
    expect(next).toBe('SE-100000000000000000000');
    // and the ordinary case is unchanged
    const g = await fixture();
    await g.employ(g.storeA, 'SE-006');
    expect(await asOrg(g.orgId, (tx) => employmentRepo.allocateStaffCode(tx, g.storeA))).toBe('SE-007');
    expect(await asOrg(g.orgId, (tx) => employmentRepo.allocateStaffCode(tx, g.storeB))).toBe('SE-001');
  });
});

describe('findLiveEmploymentByStaffNumber - the tablet lookup', () => {
  it('7, 07 and 007 reach the same employment; an ended employment and another store do not', async () => {
    const f = await fixture();
    await f.employ(f.storeA, 'SE-007');
    await f.employ(f.storeB, 'SE-008');
    const ended = await f.person();
    await sql`insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on, ended_on)
              values (${f.orgId}, ${f.storeA}, ${ended}, 'SE-009', 'terminated', '2026-01-01', '2026-02-01')`;
    const find = (store: string, n: string) => asOrg(f.orgId, (tx) => employmentRepo.findLiveEmploymentByStaffNumber(tx, f.orgId, store, n));
    const a = await find(f.storeA, '7');
    expect(a?.staffCode).toBe('SE-007');
    expect((await find(f.storeA, '07'))?.id).toBe(a!.id);
    expect((await find(f.storeA, '007'))?.id).toBe(a!.id);
    expect(await find(f.storeB, '007'), 'SE-007 is not this store\'s code at the other store').toBeUndefined();
    expect(await find(f.storeA, '009'), 'an ended employment is not live').toBeUndefined();
    expect(await find(f.storeB, '8')).toBeDefined();
  });
});

describe('pos_tablet_pairings', () => {
  const pairing = (f: Awaited<ReturnType<typeof fixture>>, storeId: string, hash = uid('h')) =>
    sql`insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by) values (${f.orgId}, ${storeId}, 'Counter', ${hash}, ${f.manager}) returning id`;

  it('one LIVE pairing per store; a revoked one frees the slot; the token hash is unique', async () => {
    const f = await fixture();
    const [first] = await pairing(f, f.storeA);
    const e = await refused(pairing(f, f.storeA));
    expect(e, 'mutant: partial unique index removed').not.toBeNull();
    expect(e!.message).toMatch(/pos_tablet_pairings_live_store_unique/);
    await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.manager} where id = ${first!.id}`;
    await expect(pairing(f, f.storeA)).resolves.toBeDefined();
    const dup = uid('dup');
    await pairing(f, f.storeB, dup);
    const g = await fixture();
    const e2 = await refused(pairing(g, g.storeA, dup));
    expect(e2!.message).toMatch(/pos_tablet_pairings_cookie_digest_unique/);
  });

  it('revoked_at and revoked_by are set together or not at all', async () => {
    const f = await fixture();
    const e = await refused(sql`insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by, revoked_at)
                                values (${f.orgId}, ${f.storeA}, 'X', ${uid('h')}, ${f.manager}, now())`);
    expect(e!.message).toMatch(/pos_tablet_pairings_revoked_shape_check/);
  });

  it('a store or person of ANOTHER org is refused by the composite same-org FKs (born composite)', async () => {
    const f = await fixture();
    const other = await fixture();
    const e1 = await refused(sql`insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by) values (${f.orgId}, ${other.storeA}, 'X', ${uid('h')}, ${f.manager})`);
    expect(e1!.message).toMatch(/pos_tablet_pairings_store_id_same_org_fk/);
    const e2 = await refused(sql`insert into pos_tablet_pairings (org_id, store_id, label, cookie_digest, paired_by) values (${f.orgId}, ${f.storeA}, 'X', ${uid('h')}, ${other.manager})`);
    expect(e2!.message).toMatch(/pos_tablet_pairings_paired_by_same_org_fk/);
  });

  it('RLS: another org sees nothing; the app role cannot DELETE', async () => {
    const f = await fixture();
    const other = await fixture();
    await pairing(f, f.storeA);
    expect(await asOrg(other.orgId, (tx) => posTabletPairingsRepo.listForStores(tx, other.orgId, [f.storeA]))).toHaveLength(0);
    expect(await asOrg(f.orgId, (tx) => posTabletPairingsRepo.listForStores(tx, f.orgId, [f.storeA]))).toHaveLength(1);
    const e = await refused(asOrg(f.orgId, (tx) => tx.execute(dsql`delete from pos_tablet_pairings where org_id = ${f.orgId}`)));
    expect(e, 'mutant: DELETE granted to the app role').not.toBeNull();
  });
});

describe('pin_attempt_throttle - the Employee ID bucket', () => {
  it('a store bucket and an Employee ID bucket (and a second ID) coexist; the same ID twice is one bucket', async () => {
    const f = await fixture();
    const o = f.orgId;
    const s = f.storeA;
    await sql`insert into pin_attempt_throttle (org_id, store_id) values (${o}, ${s})`;
    await sql`insert into pin_attempt_throttle (org_id, store_id, staff_code) values (${o}, ${s}, 'SE-007')`;
    await sql`insert into pin_attempt_throttle (org_id, store_id, staff_code) values (${o}, ${s}, 'SE-008')`;
    const e1 = await refused(sql`insert into pin_attempt_throttle (org_id, store_id, staff_code) values (${o}, ${s}, 'SE-007')`);
    expect(e1!.message).toMatch(/pin_attempt_throttle_staff_code_unique/);
    const e2 = await refused(sql`insert into pin_attempt_throttle (org_id, store_id) values (${o}, ${s})`);
    expect(e2!.message, 'the store bucket stays unique').toMatch(/pin_attempt_throttle_store_id_unique/);
    const e3 = await refused(sql`insert into pin_attempt_throttle (org_id, staff_code) values (${o}, 'SE-007')`);
    expect(e3!.message).toMatch(/staff_code_needs_store_check/);
  });
});
