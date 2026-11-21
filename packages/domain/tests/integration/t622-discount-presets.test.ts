/**
 * T-622 - add, change and retire a named discount (docs/tasks/622-pos-discount-presets-screen.md). Raw SQL builds the world (the t525 fixture), so the
 * DATABASE is the oracle; the snapshot is the real `buildPosSnapshot`. Capability `manage_store_settings` at the store, checked FIRST. Runs on any `_test` database.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { asOrg, auditRows, closeAll, fixture, RATES, sql, stateVersionOf, type Fx } from './_fixtures/t525-pos';
import { retirePosDiscountPreset, upsertPosDiscountPreset } from '../../src/pos/store-setup';
import { buildPosSnapshot } from '../../src/pos/snapshot';

afterAll(closeAll);

const save = (f: Fx, actor: Fx['admin'], name: string, valueType: string, value: unknown) =>
  asOrg(f.orgId, (tx) => upsertPosDiscountPreset(tx, actor, { storeId: f.storeId, name, valueType, value }, 'web'));
const retire = (f: Fx, actor: Fx['admin'], presetId: string) => asOrg(f.orgId, (tx) => retirePosDiscountPreset(tx, actor, { storeId: f.storeId, presetId }));
const snapshotPresets = async (f: Fx) =>
  (await asOrg(f.orgId, (tx) => buildPosSnapshot(tx, { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId } }, RATES))).body.discountPresets;
const names = async (f: Fx) => (await snapshotPresets(f)).map((p) => p.name);
const statusOf = async (id: string) => (await sql<{ status: string; updated_at: Date | null }[]>`select status, updated_at from pos_discount_presets where id = ${id}`)[0]!;

async function expectAuthRefusal(p: Promise<unknown>) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected an authorization refusal, got success').not.toBeNull();
  expect(err, `expected AuthorizationError, got ${String((err as Error)?.message)}`).toBeInstanceOf(AuthorizationError);
}

describe('T-622 add, change, retire', () => {
  it('add: the discount reaches the snapshot, audited from the web screen', async () => {
    const f = await fixture();
    expect(await names(f)).not.toContain('Staff meal');
    const r = await save(f, f.admin, 'Staff meal', 'percent', '20');
    expect(r.outcome).toBe('created');
    expect(await snapshotPresets(f)).toContainEqual({ id: r.presetId, name: 'Staff meal', valueType: 'percent', value: '20.00' });
    expect(await auditRows(f, 'pos.discount_preset_set')).toHaveLength(1);
    expect(await sql<{ source: string }[]>`select source from audit_log where entity_id = ${r.presetId} and action = 'pos.discount_preset_set'`).toEqual([{ source: 'web' }]);
  });

  it('change: the value changes on the same row, the audit row holds before and after, and the snapshot has the new value', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    const r = await save(f, f.admin, 'Employee 10%', 'percent', '15');
    expect(r).toEqual({ presetId: f.emp10, outcome: 'updated' });
    expect((await snapshotPresets(f)).find((p) => p.id === f.emp10)).toMatchObject({ valueType: 'percent', value: '15.00' });
    const [row] = await auditRows(f, 'pos.discount_preset_set');
    expect(row!.before).toEqual({ name: 'Employee 10%', valueType: 'percent', value: '10.00' });
    expect(row!.after).toEqual({ name: 'Employee 10%', valueType: 'percent', value: '15.00' });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('retire: gone from the snapshot, row kept as retired, audited with its old name, type and value, state_version +1', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    expect(await names(f)).toContain('Promo 50 off');
    expect(await retire(f, f.admin, f.promo50)).toEqual({ outcome: 'retired' });
    expect(await names(f)).not.toContain('Promo 50 off');
    expect(await names(f)).toContain('Employee 10%'); // the others stay
    const row = await statusOf(f.promo50);
    expect(row.status).toBe('retired');
    expect(row.updated_at).not.toBeNull();
    const [audit] = await auditRows(f, 'pos.discount_preset_retired');
    expect(audit).toMatchObject({ entity_id: f.promo50, actor_person_id: f.adminId, store_id: f.storeId, before: { name: 'Promo 50 off', valueType: 'fixed', value: '50.00' }, after: null });
    expect(await stateVersionOf(f)).toBe(v0 + 1);
  });

  it('retiring one that is already retired writes nothing: no audit row, no state_version bump', async () => {
    const f = await fixture();
    await retire(f, f.admin, f.promo50);
    const v1 = await stateVersionOf(f);
    expect(await retire(f, f.admin, f.promo50)).toEqual({ outcome: 'unchanged' });
    expect(await retire(f, f.admin, f.presetRetired)).toEqual({ outcome: 'unchanged' }); // the fixture's own retired preset
    expect(await auditRows(f, 'pos.discount_preset_retired')).toHaveLength(1);
    expect(await stateVersionOf(f)).toBe(v1);
  });

  it('a discount of another store, or one that does not exist, is refused in words and nothing changes', async () => {
    const f = await fixture();
    for (const id of [f.presetB, '00000000-0000-4000-8000-000000000000']) {
      const err = await retire(f, f.admin, id).then(() => null, (e: unknown) => e);
      expect((err as { userMessage?: string }).userMessage).toBe('That discount does not exist any more.');
    }
    expect((await statusOf(f.presetB)).status).toBe('active');
    expect(await auditRows(f, 'pos.discount_preset_retired')).toHaveLength(0);
  });

  it('a cashier (no manage_store_settings) and a manager of another store are refused for add, change and retire, and nothing is written', async () => {
    const f = await fixture();
    const v0 = await stateVersionOf(f);
    for (const who of [f.counter, f.managerOther]) {
      await expectAuthRefusal(save(f, who, 'Sneaky', 'percent', '5'));
      await expectAuthRefusal(save(f, who, 'Employee 10%', 'percent', '99'));
      await expectAuthRefusal(retire(f, who, f.emp10));
    }
    expect(await names(f)).not.toContain('Sneaky');
    expect((await snapshotPresets(f)).find((p) => p.id === f.emp10)).toMatchObject({ value: '10.00' });
    expect((await statusOf(f.emp10)).status).toBe('active');
    expect(await stateVersionOf(f)).toBe(v0);
  });

  it('a manager of the store may retire (same capability as add)', async () => {
    const f = await fixture();
    expect(await retire(f, f.manager, f.emp10)).toEqual({ outcome: 'retired' });
  });

  it('retire then add the same name works: the unique index is on active names only', async () => {
    const f = await fixture();
    await retire(f, f.admin, f.emp10);
    const r = await save(f, f.admin, 'Employee 10%', 'fixed', '25');
    expect(r.outcome).toBe('created');
    expect(r.presetId).not.toBe(f.emp10);
    expect(await names(f)).toContain('Employee 10%');
    expect((await snapshotPresets(f)).filter((p) => p.name === 'Employee 10%')).toHaveLength(1);
    expect((await statusOf(f.emp10)).status).toBe('retired'); // history stays
  });
});
