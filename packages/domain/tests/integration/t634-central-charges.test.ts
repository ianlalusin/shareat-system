import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-634 - central charges (migration 0282): the org's ONE list of charges, each store's on/off switch, the mirror, and what a change does (and does not do) to a
 * table already open. docs/tasks/634-central-charges.md. Real Postgres on a scratch "_test" database through the T-525 fixture (the DATABASE is the oracle; the
 * snapshot is the real `buildPosSnapshot`; charges reach a table through the real inbox). Not run on the builder's PC (no database): CI runs it.
 */
import { AuthorizationError } from '@shareat/auth';
import { applyPosEvents } from '../../src/pos/inbox';
import { buildPosSnapshot } from '../../src/pos/snapshot';
import { createChargeOption, setChargeOptionStatus, setStoreCharge, updateChargeOption } from '../../src/pos/charge-options';
import { asOrg, auditRows, closeAll, ev, fixture, linesAddedPayload, nowIso, RATES, signedIn, sql, standOpenedPayload, uuid, type Ev, type Fx } from './_fixtures/t525-pos';

afterAll(closeAll);

async function world(): Promise<Fx> {
  const f = await fixture();
  await signedIn(f, f.counterId, f.managerId);
  return f;
}
const send = (f: Fx, events: Ev[]) => applyPosEvents({ pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId }, events }, RATES);
const statuses = (r: Awaited<ReturnType<typeof send>>) => r.results.map((x) => (x.status === 'applied' || x.status === 'duplicate' ? x.status : `${x.status}: ${x.error}`));

const create = (f: Fx, actor: Fx['admin'], name: string, amount: string, perUnit = false) => asOrg(f.orgId, (tx) => createChargeOption(tx, actor, { name, amount, perUnit }));
const change = (f: Fx, actor: Fx['admin'], id: string, amount: string, perUnit?: boolean) =>
  asOrg(f.orgId, (tx) => updateChargeOption(tx, actor, { chargeOptionId: id, amount, ...(perUnit === undefined ? {} : { perUnit }) }));
const status = (f: Fx, actor: Fx['admin'], id: string, s: 'active' | 'retired') => asOrg(f.orgId, (tx) => setChargeOptionStatus(tx, actor, { chargeOptionId: id, status: s }));
const sw = (f: Fx, actor: Fx['admin'], storeId: string, id: string, on: boolean) => asOrg(f.orgId, (tx) => setStoreCharge(tx, actor, { storeId, chargeOptionId: id, on }));
const storeRows = (f: Fx, optionId: string) =>
  sql<{ store_id: string; name: string; amount: string; per_unit: boolean; status: string }[]>`
    select store_id, name, amount::text, per_unit, status from pos_charge_presets where org_id = ${f.orgId} and charge_option_id = ${optionId} order by store_id`;
const snapshotCharges = async (f: Fx) =>
  (await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES))).body.chargePresets;
const userMessage = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as { userMessage?: string } | null)?.userMessage;
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

describe('T-634 the org list and the store switch', () => {
  it('an amount change mirrors to EVERY store row of the option (on and off), and each store that has it on gets a new snapshot version', async () => {
    const f = await world();
    const { id } = await create(f, f.admin, 'Leftover', '100', true);
    await sw(f, f.admin, f.storeId, id, true);
    await sw(f, f.admin, f.store2Id, id, true);
    await sw(f, f.admin, f.store2Id, id, false); // a row that is off follows too
    const v = async () => Number((await sql<{ v: string }[]>`select state_version::text v from pos_stores where store_id = ${f.storeId}`)[0]!.v);
    const v0 = await v();
    expect(await change(f, f.admin, id, '120.50')).toEqual({ outcome: 'updated', storesOn: 1 });
    expect((await storeRows(f, id)).map((r) => [r.amount, r.per_unit])).toEqual([
      ['120.50', true],
      ['120.50', true],
    ]);
    expect(await v()).toBe(v0 + 1);
    expect(await snapshotCharges(f)).toMatchObject([{ name: 'Leftover', amount: '120.50', perUnit: true }]);
    const [audit] = await auditRows(f, 'charge_option.updated');
    expect(audit).toMatchObject({ entity_id: id, store_id: null, before: { amount: '100.00', perUnit: true }, after: { amount: '120.50', perUnit: true, storesOn: 1 } });
    // the same amount again writes nothing
    expect(await change(f, f.admin, id, '120.5')).toEqual({ outcome: 'unchanged', storesOn: 1 });
    expect(await auditRows(f, 'charge_option.updated')).toHaveLength(1);
  });

  it('the database mirror holds even for a writer that skips the domain: a store row cannot carry its own amount or name', async () => {
    const f = await world();
    const { id } = await create(f, f.admin, 'Leftover', '100', true);
    await sw(f, f.admin, f.storeId, id, true);
    await sql`update pos_charge_presets set amount = 5, per_unit = false where charge_option_id = ${id}`;
    expect((await storeRows(f, id))[0]).toMatchObject({ name: 'Leftover', amount: '100.00', per_unit: true });
    await sql`update charge_options set amount = 130 where id = ${id}`;
    expect((await storeRows(f, id))[0]).toMatchObject({ amount: '130.00' });
    await expect(sql`update charge_options set name = 'Renamed' where id = ${id}`).rejects.toMatchObject({ code: '23001' });
  });

  it('retire is refused while any store has it on (in words, and by the database); allowed once every store has it off; Restore brings it back', async () => {
    const f = await world();
    const { id } = await create(f, f.admin, 'Extra griller', '150');
    await sw(f, f.admin, f.storeId, id, true);
    expect(await userMessage(status(f, f.admin, id, 'retired'))).toBe('Extra griller is switched on at 1 store. Switch it off there first, then retire it.');
    await expect(sql`update charge_options set status = 'retired' where id = ${id}`).rejects.toMatchObject({ code: '23001' });
    await sw(f, f.admin, f.storeId, id, false);
    expect(await status(f, f.admin, id, 'retired')).toEqual({ outcome: 'changed' });
    // a retired charge cannot be switched on, in words and by the database
    expect(await userMessage(sw(f, f.admin, f.storeId, id, true))).toBe('Extra griller is retired for all stores, so it cannot be switched on. Bring it back in the list above first.');
    await expect(sql`update pos_charge_presets set status = 'active' where charge_option_id = ${id}`).rejects.toMatchObject({ code: '23001' });
    expect(await status(f, f.admin, id, 'active')).toEqual({ outcome: 'changed' });
    expect(await auditRows(f, 'charge_option.retired')).toHaveLength(1);
    expect(await auditRows(f, 'charge_option.reactivated')).toHaveLength(1);
  });

  it('authorize first: a store manager and a cashier are refused on the org list (even with bad input); nothing is written', async () => {
    const f = await world();
    const { id } = await create(f, f.admin, 'Leftover', '100', true);
    for (const who of [f.manager, f.counter]) {
      await expectAuthRefusal(create(f, who, 'Sneaky', '5'));
      await expectAuthRefusal(create(f, who, '', 'not a number'));
      await expectAuthRefusal(change(f, who, id, '1'));
      await expectAuthRefusal(status(f, who, id, 'retired'));
    }
    expect(await sql`select 1 from charge_options where org_id = ${f.orgId}`).toHaveLength(1);
    expect((await sql<{ amount: string }[]>`select amount::text from charge_options where id = ${id}`)[0]!.amount).toBe('100.00');
  });

  it('the store switch: the store manager may; a cashier and a manager of another store may not; on again reuses the one row; each change is audited', async () => {
    const f = await world();
    const { id } = await create(f, f.admin, 'Leftover', '100', true);
    await expectAuthRefusal(sw(f, f.counter, f.storeId, id, true));
    await expectAuthRefusal(sw(f, f.managerOther, f.storeId, id, true));
    expect(await sw(f, f.manager, f.storeId, id, true)).toEqual({ outcome: 'on', name: 'Leftover' });
    expect(await sw(f, f.manager, f.storeId, id, true)).toEqual({ outcome: 'unchanged', name: 'Leftover' });
    expect(await sw(f, f.manager, f.storeId, id, false)).toEqual({ outcome: 'off', name: 'Leftover' });
    expect(await sw(f, f.manager, f.storeId, id, true)).toEqual({ outcome: 'on', name: 'Leftover' });
    expect(await storeRows(f, id)).toHaveLength(1);
    expect(await auditRows(f, 'pos.charge_preset_set')).toHaveLength(2);
    expect(await auditRows(f, 'pos.charge_preset_retired')).toHaveLength(1);
  });

  it('the same name twice (any case or punctuation) is refused in words', async () => {
    const f = await world();
    await create(f, f.admin, 'Extra griller', '150');
    expect(await userMessage(create(f, f.admin, 'extra-GRILLER', '150'))).toBe('There is already a charge called "Extra griller".');
  });
});

describe('T-634 the tablet', () => {
  it('the snapshot carries only the charges switched ON at this store (not ones off here, retired, or on at another store only)', async () => {
    const f = await world();
    const leftover = await create(f, f.admin, 'Leftover', '100', true);
    const griller = await create(f, f.admin, 'Extra griller', '150');
    const corkage = await create(f, f.admin, 'Corkage', '200');
    const other = await create(f, f.admin, 'Other store fee', '10');
    await sw(f, f.admin, f.storeId, leftover.id, true);
    await sw(f, f.admin, f.storeId, griller.id, true);
    await sw(f, f.admin, f.storeId, griller.id, false);
    await status(f, f.admin, corkage.id, 'retired');
    await sw(f, f.admin, f.store2Id, other.id, true);
    expect((await snapshotCharges(f)).map((c) => c.name)).toEqual(['Leftover']);
  });

  it('an open table keeps the amount its charge was added at after the amount changes; the next charge added takes the new amount', async () => {
    const f = await world();
    const { id } = await create(f, f.admin, 'Extra griller', '150');
    await sw(f, f.admin, f.storeId, id, true);
    const [presetRow] = await sql<{ id: string }[]>`select id from pos_charge_presets where charge_option_id = ${id} and store_id = ${f.storeId}`;
    const sessionId = uuid();
    const add = (seq: number) =>
      ev(seq, 'charge.added', f.counterId, { chargeId: uuid(), sessionId, presetId: presetRow!.id, qty: 1, addedAtDevice: nowIso() });
    const r1 = await send(f, [
      ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)),
      ev(2, 'lines.added', f.counterId, linesAddedPayload(sessionId, [{ lineId: uuid(), item: f.menu.pork, qty: 1 }])),
      add(3),
    ]);
    expect(statuses(r1)).toEqual(['applied', 'applied', 'applied']);
    await change(f, f.admin, id, '175');
    expect(statuses(await send(f, [add(4)]))).toEqual(['applied']);
    const charges = await sql<{ name: string; unit_amount: string }[]>`
      select name, unit_amount::text from table_session_charges where session_id = ${sessionId} order by added_at_device, id`;
    expect(charges.map((c) => c.unit_amount).sort()).toEqual(['150.00', '175.00']);
  });
});
