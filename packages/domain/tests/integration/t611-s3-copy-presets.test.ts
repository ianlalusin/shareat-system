/**
 * T-611 S3 - "Copy from another store": discount presets. docs/tasks/611-copy-settings-between-stores.md.
 * Against real PostgreSQL. Each tick has a cross that fires (the mutants are listed in the hand-back, run by hand).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { copySettingsToStore, previewCopyToStore, upsertPosDiscountPreset, upsertPosStand } from '@shareat/domain';

import { asOrg, attempt, cast, expectSentence, sql, uid, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

interface World extends Cast {
  storeC: string;
}
async function world(hint: string): Promise<World> {
  const c = await cast(hint);
  const [r] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${c.orgId}, ${uid('ST')}, 'Malvar') returning id`;
  for (const p of [c.admin, c.superAdmin, c.manager]) await sql`insert into person_store_scope (person_id, store_id) values (${p.personId}, ${r!.id})`;
  return { ...c, storeC: r!.id };
}
const preset = (c: Cast, storeId: string, name: string, valueType: 'percent' | 'fixed', value: string) =>
  asOrg(c.orgId, (tx) => upsertPosDiscountPreset(tx, c.admin, { storeId, name, valueType, value }, 'etl')).then((r) => r.presetId);
const copy = (c: Cast, who: Cast['admin'], source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => copySettingsToStore(who, { kind: 'presets', sourceStoreId: source, targetStoreId: target, replace, approverPersonId: c.admin.personId }, tx));
const preview = (c: Cast, who: Cast['admin'], source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => previewCopyToStore(who, { kind: 'presets', sourceStoreId: source, targetStoreId: target, replace }, tx));
const said = (r: { error?: unknown }) => (r.error as { userMessage: string }).userMessage;

const presetsOf = (storeId: string) =>
  sql<{ id: string; name: string; type: string; value: string; status: string }[]>`
    select id, name, value_type as type, value::text as value, status from pos_discount_presets where store_id = ${storeId} order by lower(name)`;
const shown = async (storeId: string) => (await presetsOf(storeId)).map((p) => `${p.name} ${p.type} ${p.value}`);

describe('T-611 S3: copy discount presets', () => {
  it('1: the preview counts match the apply; matching is by name, ignoring capitals; a different value is KEPT unless Replace is on', async () => {
    const c = await world('t611-d1');
    await preset(c, c.storeA, 'Staff meal', 'percent', '20.00');
    await preset(c, c.storeA, 'Birthday', 'percent', '10.00');
    await preset(c, c.storeA, 'Promo', 'fixed', '50.00');
    await preset(c, c.storeB, 'STAFF MEAL', 'percent', '20.00'); // same, other capitals
    await preset(c, c.storeB, 'Promo', 'fixed', '30.00'); // differs

    const p = await preview(c, c.admin, c.storeA, c.storeB);
    expect(p.counts).toEqual({ added: 1, replaced: 0, skipped: 2, same: 1, kept: 1 });
    expect(p.lines.map((l) => l.status).sort()).toEqual(['add', 'different', 'same']);
    expect(p.lines.find((l) => l.status === 'different')!.note).toBe('The store has 30.00 pesos.');
    const r = await copy(c, c.admin, c.storeA, c.storeB);
    expect(r.counts).toEqual(p.counts);
    expect(await shown(c.storeB)).toEqual(['Birthday percent 10.00', 'Promo fixed 30.00', 'STAFF MEAL percent 20.00']);
  });

  it('2: Replace on changes the different preset in place through the preset writer (an audit row with before and after); the counts match the preview', async () => {
    const c = await world('t611-d2');
    await preset(c, c.storeA, 'Promo', 'percent', '15.00');
    const promoB = await preset(c, c.storeB, 'Promo', 'fixed', '30.00');
    const p = await preview(c, c.admin, c.storeA, c.storeB, true);
    expect(p.counts).toEqual({ added: 0, replaced: 1, skipped: 0, same: 0, kept: 0 });
    const r = await copy(c, c.admin, c.storeA, c.storeB, true);
    expect(r.counts).toEqual(p.counts);
    const [row] = await presetsOf(c.storeB);
    expect(row).toMatchObject({ id: promoB, type: 'percent', value: '15.00' });
    const [a] = await sql<{ before: { value: string }; after: { value: string } }[]>`
      select "before", "after" from audit_log where store_id = ${c.storeB} and action = 'pos.discount_preset_set' and entity_id = ${promoB} and "before" is not null`;
    expect(a).toMatchObject({ before: { value: '30.00' }, after: { value: '15.00' } });
  });

  it('3: copying removes nothing, copies no retired preset, and touches nothing else: a target-only preset stays; stands are not copied', async () => {
    const c = await world('t611-d3');
    await preset(c, c.storeA, 'Staff meal', 'percent', '20.00');
    const old = await preset(c, c.storeA, 'Old promo', 'percent', '5.00');
    await sql`update pos_discount_presets set status = 'retired' where id = ${old}`;
    await asOrg(c.orgId, (tx) => upsertPosStand(tx, c.admin, { storeId: c.storeA, number: 1 }));
    await preset(c, c.storeB, 'Local special', 'fixed', '25.00');
    await copy(c, c.admin, c.storeA, c.storeB, true);
    expect(await shown(c.storeB)).toEqual(['Local special fixed 25.00', 'Staff meal percent 20.00']);
    expect((await sql`select 1 from pos_stands where store_id = ${c.storeB}`).length).toBe(0);
  });
});

describe('T-611 S3: who may copy, and where', () => {
  it('4: a store of another organisation is refused as "does not exist", before anything is read or written', async () => {
    const c = await world('t611-d4');
    const other = await cast('t611-d4-other');
    await preset(c, c.storeA, 'Staff meal', 'percent', '20.00');
    const r = await attempt(() => copy(c, c.admin, c.storeA, other.storeA));
    expectSentence(r, 'foreign target');
    expect(said(r)).toMatch(/could not be found/);
    expect(await presetsOf(other.storeA)).toHaveLength(0);
    const s = await attempt(() => copy(c, c.admin, other.storeA, c.storeB));
    expectSentence(s, 'foreign source');
    expect(said(s)).toMatch(/could not be found/);
  });

  it('5: only an administrator copies; a manager is refused in a sentence and nothing is written', async () => {
    const c = await world('t611-d5');
    await preset(c, c.storeA, 'Staff meal', 'percent', '20.00');
    const r = await attempt(() => preview(c, c.manager, c.storeA, c.storeB));
    expectSentence(r, 'manager preview');
    expect(said(r)).toBe('Only an administrator can copy settings from one store to another.');
    expectSentence(await attempt(() => copy(c, c.manager, c.storeA, c.storeB)), 'manager copy');
    expect(await presetsOf(c.storeB)).toHaveLength(0);
  });

  it('6: an administrator without the edit right at a target store is refused; a closed target is refused; the other target still gets its copy', async () => {
    const c = await world('t611-d6');
    await preset(c, c.storeA, 'Staff meal', 'percent', '20.00');
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${c.orgId}, 'Admin of Lipa only') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${c.orgId}, 'admin')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${c.storeA})`;
    expectSentence(await attempt(() => copy(c, { ...c.admin, personId: p!.id }, c.storeA, c.storeB)), 'no right at the target');
    expect(await presetsOf(c.storeB)).toHaveLength(0);

    await sql`update stores set is_active = false where id = ${c.storeC}`;
    const closed = await attempt(() => copy(c, c.admin, c.storeA, c.storeC));
    expectSentence(closed, 'closed target');
    expect(said(closed)).toContain('closed');
    await copy(c, c.admin, c.storeA, c.storeB);
    expect(await shown(c.storeB)).toEqual(['Staff meal percent 20.00']);
    expect(await presetsOf(c.storeC)).toHaveLength(0);
  });
});

describe('T-611 S3: the audit trail', () => {
  it('7: one settings.copied row per target with the kind, the source and the counts; the preview writes nothing', async () => {
    const c = await world('t611-d7');
    await preset(c, c.storeA, 'Staff meal', 'percent', '20.00');
    await preset(c, c.storeA, 'Promo', 'fixed', '50.00');
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from audit_log where org_id = ${c.orgId}`)[0]!.n;
    const n0 = await count();
    await preview(c, c.admin, c.storeA, c.storeB);
    expect(await count()).toBe(n0);
    await copy(c, c.admin, c.storeA, c.storeB);
    await copy(c, c.admin, c.storeA, c.storeC);
    const rows = await sql<{ store_id: string; after: Record<string, unknown> }[]>`
      select store_id, "after" from audit_log where org_id = ${c.orgId} and action = 'settings.copied' order by store_id`;
    expect(rows.map((r) => r.store_id).sort()).toEqual([c.storeB, c.storeC].sort());
    expect(rows[0]!.after).toMatchObject({ kind: 'presets', sourceStoreId: c.storeA, added: 2, replaced: 0, skipped: 0, replace: false, approverPersonId: c.admin.personId });
  });
});

describe("T-615: the preset audit rows carry the caller's source", () => {
  it("8: a copy writes created and replaced rows as web; the loader's own call (etl) still writes etl", async () => {
    const c = await world('t615-src');
    await preset(c, c.storeA, 'Promo', 'percent', '15.00');
    await preset(c, c.storeA, 'Staff meal', 'percent', '20.00');
    const promoB = await preset(c, c.storeB, 'Promo', 'fixed', '30.00'); // written through the loader's call: etl
    const sourcesOf = async (storeId: string) =>
      (await sql<{ source: string; name: string }[]>`
        select source, "after"->>'name' as name from audit_log where store_id = ${storeId} and action = 'pos.discount_preset_set' order by recorded_at, id`).map((r) => `${r.name}:${r.source}`);
    expect(await sourcesOf(c.storeB)).toEqual(['Promo:etl']);
    await copy(c, c.admin, c.storeA, c.storeB, true); // adds Staff meal, replaces Promo in place
    const rows = await sourcesOf(c.storeB);
    expect([...rows].sort()).toEqual(['Promo:etl', 'Promo:web', 'Staff meal:web']);
    expect(promoB).toBeTruthy();
  });
});

