/**
 * T-633 - add and retire table numbers from the ERP Tables section (docs/tasks/633-tables-screen.md). Raw SQL builds the world (the t525 fixture), so the
 * DATABASE is the oracle; the snapshot is the real `buildPosSnapshot`. Capability `manage_store_settings` at the store, checked FIRST. Runs on any `_test`
 * database. Not run on the builder's PC (no database): CI runs it.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { asOrg, auditRows, closeAll, fixture, RATES, sql, stateVersionOf, type Fx } from './_fixtures/t525-pos';
import { addPosStands, retirePosStand } from '../../src/pos/store-setup';
import { buildPosSnapshot } from '../../src/pos/snapshot';

afterAll(closeAll);

const add = (f: Fx, actor: Fx['admin'], numbers: string) => asOrg(f.orgId, (tx) => addPosStands(tx, actor, { storeId: f.storeId, numbers }));
const retire = (f: Fx, actor: Fx['admin'], standId: string) => asOrg(f.orgId, (tx) => retirePosStand(tx, actor, { storeId: f.storeId, standId }));
const snapshotNumbers = async (f: Fx) =>
  (await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES))).body.stands.map((s) => s.number);
const standsAt = async (f: Fx, storeId = f.storeId) =>
  sql<{ number: number; status: string }[]>`select number, status from pos_stands where store_id = ${storeId} order by number`;
const userMessage = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as { userMessage?: string } | null)?.userMessage;

async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

describe('T-633 add tables', () => {
  it('a range adds every number in one go, audited from the web, and the snapshot carries them', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    // the fixture already has 7 (active) and 8 (retired)
    expect(await add(f, f.admin, '5-10')).toEqual({ added: 4, existed: 1, retired: 1 });
    expect((await standsAt(f)).map((s) => `${s.number}:${s.status}`)).toEqual(['5:active', '6:active', '7:active', '8:retired', '9:active', '10:active']);
    expect(await snapshotNumbers(f)).toEqual(expect.arrayContaining([5, 6, 7, 9, 10]));
    expect(await snapshotNumbers(f)).not.toContain(8); // retired is never reused
    const rows = await auditRows(f, 'pos.stand_added');
    expect(rows).toHaveLength(4);
    expect(await sql<{ source: string }[]>`select distinct source from audit_log where org_id = ${f.orgId} and action = 'pos.stand_added'`).toEqual([{ source: 'web' }]);
    expect(await stateVersionOf(f)).toBeGreaterThan(v0);
  });

  it('a repeat adds nothing and audits nothing', async () => {
    const f = await fixture();
    await add(f, f.admin, '20');
    const v1 = await stateVersionOf(f);
    expect(await add(f, f.admin, '20')).toEqual({ added: 0, existed: 1, retired: 0 });
    expect(await auditRows(f, 'pos.stand_added')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBe(v1);
  });

  it('bad input, a reversed range and more than 200 are refused in words and add none', async () => {
    const f = await fixture();
    const before = await standsAt(f);
    expect(await userMessage(add(f, f.admin, 'ten'))).toBe('Type one table number, like 5, or a range, like 1-20.');
    expect(await userMessage(add(f, f.admin, '20-1'))).toBe('The range 20-1 goes backwards. Put the smaller number first, like 1-20.');
    expect(await userMessage(add(f, f.admin, '1-201'))).toBe('You can add at most 200 tables at a time. 1-201 is 201 tables.');
    expect(await standsAt(f)).toEqual(before);
  });

  it('the numbers are per store: the same number at another store is its own table', async () => {
    const f = await fixture();
    expect(await add(f, f.admin, '1')).toEqual({ added: 1, existed: 0, retired: 0 }); // store B already has its own 1
    expect((await standsAt(f, f.store2Id)).map((s) => s.number)).toEqual([1]);
  });
});

describe('T-633 retire a table', () => {
  it('retire: gone from the snapshot, row kept as retired, audited before/after, state_version +1; a second retire writes nothing', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    expect(await retire(f, f.admin, f.stand7)).toEqual({ outcome: 'retired', number: 7 });
    expect(await snapshotNumbers(f)).not.toContain(7);
    expect((await standsAt(f)).find((s) => s.number === 7)?.status).toBe('retired');
    const [audit] = await auditRows(f, 'pos.stand_retired');
    expect(audit).toMatchObject({ entity_id: f.stand7, actor_person_id: f.adminId, store_id: f.storeId, before: { number: 7, status: 'active' }, after: { number: 7, status: 'retired' } });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
    expect(await retire(f, f.admin, f.stand7)).toEqual({ outcome: 'unchanged', number: 7 });
    expect(await auditRows(f, 'pos.stand_retired')).toHaveLength(1);
    // and the number is never reused
    expect(await add(f, f.admin, '7')).toEqual({ added: 0, existed: 0, retired: 1 });
  });

  it('refused while the table has an open bill, in words; nothing changes; allowed once the bill is no longer open', async () => {
    const f = await fixture();
    const [sess] = await sql<{ id: string }[]>`
      insert into table_sessions (org_id, store_id, stand_id, mode, heads_cashier, opened_by, opened_at_device, opened_on_pairing_id)
      values (${f.orgId}, ${f.storeId}, ${f.stand7}, 'dine_in', 2, ${f.counter.personId}, now(), ${f.pairingId}) returning id`;
    expect(await userMessage(retire(f, f.admin, f.stand7))).toBe('Table 7 has an open bill. Settle or void it on the tablet first, then retire the table.');
    expect((await standsAt(f)).find((s) => s.number === 7)?.status).toBe('active');
    expect(await auditRows(f, 'pos.stand_retired')).toHaveLength(0);
    await sql`update table_sessions set status = 'voided', voided_by = ${f.counter.personId}, voided_at_device = now(), void_reason = 'test' where id = ${sess!.id}`;
    expect((await retire(f, f.admin, f.stand7)).outcome).toBe('retired');
  });

  it('a table of another store, or one that does not exist, is refused in words', async () => {
    const f = await fixture();
    for (const id of [f.standB, '00000000-0000-4000-8000-000000000000']) {
      expect(await userMessage(retire(f, f.admin, id))).toBe('That table does not exist at this store.');
    }
    expect((await standsAt(f, f.store2Id))[0]?.status).toBe('active');
  });

  it('a cashier and a manager of another store are refused for add and retire, and nothing is written', async () => {
    const f = await fixture();
    const before = await standsAt(f);
    for (const who of [f.counter, f.managerOther]) {
      await expectAuthRefusal(add(f, who, '30-31'));
      await expectAuthRefusal(retire(f, who, f.stand7));
      // authorize comes before the parse: bad input from someone without the right is an authorization refusal, not a parse sentence
      await expectAuthRefusal(add(f, who, 'nonsense'));
    }
    expect(await standsAt(f)).toEqual(before);
  });

  it('a manager of the store may add and retire (same capability as Discounts)', async () => {
    const f = await fixture();
    expect((await add(f, f.manager, '40')).added).toBe(1);
    expect((await retire(f, f.manager, f.stand7)).outcome).toBe('retired');
  });
});
