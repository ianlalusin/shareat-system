/**
 * T-533 S2 (TESTER) - the audited domain upserts behind the one-time store setup load. docs/tasks/533-pos-lipa-switch.md R2.
 *
 *   packages/domain/src/pos/store-setup.ts
 *     upsertPosStand(tx, actor, { storeId, number })                          -> { standId, outcome: 'created' | 'unchanged' | 'kept_retired' }
 *     upsertPosDiscountPreset(tx, actor, { storeId, name, valueType, value }) -> { presetId, outcome: 'created' | 'updated' | 'unchanged' }
 *   Capability `manage_store_settings` (admin, manager at the store; staff and a manager of another store never), checked FIRST.
 *   Audit pos.stand_added / pos.discount_preset_set; a change bumps pos_stores.state_version; a repeat writes nothing at all.
 *
 * Raw SQL builds the world (the t525 fixture), so the DATABASE is the oracle. Runs on any `_test` database.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { asOrg, auditRows, closeAll, fixture, sql, stateVersionOf, type Fx } from './_fixtures/t525-pos';
import { upsertPosDiscountPreset, upsertPosStand } from '../../src/pos/store-setup';

afterAll(closeAll);

const stand = (f: Fx, actor: Fx['admin'], number: unknown, storeId = f.storeId) => asOrg(f.orgId, (tx) => upsertPosStand(tx, actor, { storeId, number }));
const preset = (f: Fx, actor: Fx['admin'], name: unknown, valueType: unknown, value: unknown, storeId = f.storeId) =>
  asOrg(f.orgId, (tx) => upsertPosDiscountPreset(tx, actor, { storeId, name, valueType, value }, 'etl'));
const standCount = async (f: Fx) => (await sql<{ n: number }[]>`select count(*)::int n from pos_stands where store_id = ${f.storeId}`)[0]!.n;
const presetRow = async (f: Fx, name: string) =>
  (
    await sql<{ value_type: string; value: string; status: string }[]>`
      select value_type, value::text, status from pos_discount_presets
      where store_id = ${f.storeId} and lower(name) = lower(${name}) and status = 'active'`
  )[0];

async function expectRefusal(p: Promise<unknown>, sentence: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toMatch(sentence);
}
async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

describe('upsertPosStand', () => {
  it('adds a stand: active row, created_by, audited pos.stand_added, state_version +1', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    const r = await stand(f, f.admin, 21);
    expect(r.outcome).toBe('created');
    const row = (await sql<{ number: number; status: string; created_by: string }[]>`select number, status, created_by from pos_stands where id = ${r.standId}`)[0]!;
    expect(row).toMatchObject({ number: 21, status: 'active', created_by: f.adminId });
    expect(await auditRows(f, 'pos.stand_added')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('a second time changes nothing: same id, no new audit row, no state_version bump', async () => {
    const f = await fixture();
    const first = await stand(f, f.admin, 22);
    const v1 = await stateVersionOf(f);
    const again = await stand(f, f.admin, 22);
    expect(again).toEqual({ standId: first.standId, outcome: 'unchanged' });
    expect(await auditRows(f, 'pos.stand_added')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBe(v1);
  });

  it('a retired number stays retired (never reused): outcome kept_retired, row untouched, nothing audited', async () => {
    const f = await fixture();
    const n = (await sql<{ number: number }[]>`select number from pos_stands where id = ${f.standRetired}`)[0]!.number;
    const r = await stand(f, f.admin, n);
    expect(r).toEqual({ standId: f.standRetired, outcome: 'kept_retired' });
    expect((await sql<{ status: string }[]>`select status from pos_stands where id = ${f.standRetired}`)[0]!.status).toBe('retired');
    expect(await auditRows(f, 'pos.stand_added')).toHaveLength(0);
  });

  it('refuses a number that is not a whole number from 1 to 999, in words, and writes nothing', async () => {
    const f = await fixture();
    const before = await standCount(f);
    for (const bad of [0, 1000, 2.5, '12', null]) await expectRefusal(stand(f, f.admin, bad), /whole number from 1 to 999/);
    expect(await standCount(f)).toBe(before);
  });

  it('is refused for a cashier and for a manager of another store (the gate is checked first)', async () => {
    const f = await fixture();
    const before = await standCount(f);
    await expectAuthRefusal(stand(f, f.counter, 30));
    await expectAuthRefusal(stand(f, f.managerOther, 30));
    expect(await standCount(f)).toBe(before);
  });

  it('a manager of the store may add one', async () => {
    const f = await fixture();
    expect((await stand(f, f.manager, 31)).outcome).toBe('created');
  });
});

describe('upsertPosDiscountPreset', () => {
  it('creates an active preset (value stored with two decimals), audited, state_version +1', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    const r = await preset(f, f.admin, 'Lipa Promo', 'percent', 12.5);
    expect(r.outcome).toBe('created');
    expect(await presetRow(f, 'Lipa Promo')).toEqual({ value_type: 'percent', value: '12.50', status: 'active' });
    expect(await auditRows(f, 'pos.discount_preset_set')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('the same preset again (name matched without case, same type and value) changes nothing', async () => {
    const f = await fixture();
    await preset(f, f.admin, 'Lipa Promo', 'fixed', '50');
    const v1 = await stateVersionOf(f);
    const again = await preset(f, f.admin, '  lipa promo ', 'fixed', 50.0);
    expect(again.outcome).toBe('unchanged');
    expect(await auditRows(f, 'pos.discount_preset_set')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBe(v1);
  });

  it('a changed value updates the same row (no second row), audits before and after, bumps state_version', async () => {
    const f = await fixture();
    const first = await preset(f, f.admin, 'Lipa Promo', 'percent', 10);
    const v1 = await stateVersionOf(f);
    const second = await preset(f, f.admin, 'Lipa Promo', 'percent', 15);
    expect(second).toEqual({ presetId: first.presetId, outcome: 'updated' });
    expect(await presetRow(f, 'Lipa Promo')).toMatchObject({ value: '15.00' });
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_discount_presets where store_id = ${f.storeId} and lower(name) = 'lipa promo'`)[0]!.n).toBe(1);
    expect(await auditRows(f, 'pos.discount_preset_set')).toHaveLength(2);
    expect(await stateVersionOf(f)).toBe(v1 + 1);
  });

  it('a RETIRED preset of that name does not block a new active one', async () => {
    const f = await fixture();
    const r = await preset(f, f.admin, 'Old promo', 'percent', 5);
    expect(r.outcome).toBe('created');
    expect(r.presetId).not.toBe(f.presetRetired);
  });

  it('refuses a value of 0, in words, and writes nothing', async () => {
    const f = await fixture();
    await expectRefusal(preset(f, f.admin, 'Free lunch', 'fixed', 0), /value of 0/);
    await expectRefusal(preset(f, f.admin, 'Free lunch', 'percent', '0.00'), /value of 0/);
    expect(await presetRow(f, 'Free lunch')).toBeUndefined();
  });

  it('refuses a percent over 100, in words (100 itself is allowed), and writes nothing', async () => {
    const f = await fixture();
    await expectRefusal(preset(f, f.admin, 'Too much', 'percent', 100.5), /percent over 100/);
    await expectRefusal(preset(f, f.admin, 'Too much', 'percent', 150), /percent over 100/);
    expect(await presetRow(f, 'Too much')).toBeUndefined();
    expect((await preset(f, f.admin, 'Full', 'percent', 100)).outcome).toBe('created');
  });

  it('refuses a bad type, a negative or over-precise value, and a name that is empty or over 40 characters', async () => {
    const f = await fixture();
    await expectRefusal(preset(f, f.admin, 'X', 'bogus', 10), /percent or a fixed peso amount/);
    await expectRefusal(preset(f, f.admin, 'X', 'fixed', -5), /above 0 with at most two decimals/);
    await expectRefusal(preset(f, f.admin, 'X', 'fixed', 10.123), /above 0 with at most two decimals/);
    await expectRefusal(preset(f, f.admin, '   ', 'fixed', 10), /1 to 40 characters/);
    await expectRefusal(preset(f, f.admin, 'n'.repeat(41), 'fixed', 10), /1 to 40 characters/);
  });

  it('is refused for a cashier and for a manager of another store', async () => {
    const f = await fixture();
    await expectAuthRefusal(preset(f, f.counter, 'Sneaky', 'fixed', 10));
    await expectAuthRefusal(preset(f, f.managerOther, 'Sneaky', 'fixed', 10));
    expect(await presetRow(f, 'Sneaky')).toBeUndefined();
  });
});
