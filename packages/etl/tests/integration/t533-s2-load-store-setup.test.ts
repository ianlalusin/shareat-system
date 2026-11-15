/**
 * T-533 S2 (TESTER) - the one-time store setup load, against a FAKE v1 source (made-up data only). docs/tasks/533-pos-lipa-switch.md R2.
 *
 *   packages/etl/src/pos-v2/load-store-setup.ts
 *     loadStoreSetup(tx, actor, { storeId, dryRun }, source) -> report { stands, presets, gaps }
 *   Writes only through the audited domain upserts. A dry run keeps nothing; a re-run changes nothing; a bad preset is named and left out;
 *   the report lists each gap kind (tenders without alias, items without station, packages without refills, staff without PIN) and fixes none.
 *
 * Raw SQL builds the world (the POS t525 fixture), so the DATABASE is the oracle. Runs on any `_test` database.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { RefusalError } from '@shareat/db';
import { asOrg, auditRows, closeAll, fixture, sql, stateVersionOf, type Fx } from '../../../domain/tests/integration/_fixtures/t525-pos';
import { insRule, newItem } from '../../../db/tests/integration/_fixtures/t401-menu';
import { formatStoreSetupReport, loadStoreSetup, type V1Discount, type V1StoreSetupSource, type V1Table } from '../../src/pos-v2/load-store-setup';

afterAll(closeAll);

const disc = (name: string, type: unknown, value: unknown, o: Partial<V1Discount> = {}): V1Discount => ({
  name, type, value, isArchived: false, isEnabled: true, adminSuspended: false, ...o,
});
const fake = (tables: V1Table[], discounts: V1Discount[], globals: V1Discount[] = []): V1StoreSetupSource => ({
  listTables: async () => tables,
  listDiscounts: async () => discounts,
  listGlobalDiscounts: async () => globals,
});
const TABLES: V1Table[] = [
  { tableNumber: '31', isActive: true },
  { tableNumber: '32', isActive: true },
  { tableNumber: '33', isActive: false }, // switched off in v1: skipped
  { tableNumber: 'VIP', isActive: true }, // not a number: skipped, never invented
];
const DISCOUNTS: V1Discount[] = [
  disc('Senior Treat', 'percent', 20),
  disc('Birthday Peso Off', 'fixed', 100),
  disc('Old Archived', 'percent', 5, { isArchived: true }),
  disc('Switched Off', 'percent', 5, { isEnabled: false }),
];

const run = (f: Fx, source: V1StoreSetupSource, dryRun: boolean, storeId = f.storeId) =>
  asOrg(f.orgId, (tx) => loadStoreSetup(tx, f.admin, { storeId, dryRun }, source));
const counts = async (f: Fx) => ({
  stands: (await sql<{ n: number }[]>`select count(*)::int n from pos_stands where store_id = ${f.storeId}`)[0]!.n,
  presets: (await sql<{ n: number }[]>`select count(*)::int n from pos_discount_presets where store_id = ${f.storeId}`)[0]!.n,
  standAudit: (await auditRows(f, 'pos.stand_added')).length,
  presetAudit: (await auditRows(f, 'pos.discount_preset_set')).length,
  version: await stateVersionOf(f),
});

describe('loadStoreSetup', () => {
  it('a DRY RUN reports what a real run would do and writes nothing (rows, audit, state_version all unchanged)', async () => {
    const f = await fixture();
    const before = await counts(f);
    const r = await run(f, fake(TABLES, DISCOUNTS), true);
    expect(r.dryRun).toBe(true);
    expect(r.stands.created).toEqual([31, 32]);
    expect(r.stands.skipped).toHaveLength(2);
    expect(r.presets.created).toEqual(['Senior Treat', 'Birthday Peso Off']);
    expect(r.presets.skipped).toHaveLength(2);
    expect(await counts(f)).toEqual(before);
    expect(formatStoreSetupReport(r)[0]).toMatch(/^DRY RUN/);
  });

  it('a real run inserts the active tables and enabled presets, audited once each, and skips the rest by name', async () => {
    const f = await fixture();
    const before = await counts(f);
    const r = await run(f, fake(TABLES, DISCOUNTS), false);
    expect(r.stands.created).toEqual([31, 32]);
    expect(r.presets.created).toEqual(['Senior Treat', 'Birthday Peso Off']);
    const after = await counts(f);
    expect(after.stands).toBe(before.stands + 2);
    expect(after.presets).toBe(before.presets + 2);
    expect(after.standAudit).toBe(2);
    expect(after.presetAudit).toBe(2);
    expect(after.version).toBeGreaterThan(before.version);
    const got = await sql<{ name: string; value_type: string; value: string }[]>`
      select name, value_type, value::text from pos_discount_presets where store_id = ${f.storeId} and name in ('Senior Treat', 'Birthday Peso Off') order by name`;
    expect(got).toEqual([
      { name: 'Birthday Peso Off', value_type: 'fixed', value: '100.00' },
      { name: 'Senior Treat', value_type: 'percent', value: '20.00' },
    ]);
    expect(r.presets.skipped.some((s) => s.startsWith('Old Archived')) && r.presets.skipped.some((s) => s.startsWith('Switched Off'))).toBe(true);
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_discount_presets where store_id = ${f.storeId} and name in ('Old Archived', 'Switched Off')`)[0]!.n).toBe(0);
  });

  it('a RE-RUN changes nothing: no new rows, no new audit, no state_version bump; the report says unchanged', async () => {
    const f = await fixture();
    await run(f, fake(TABLES, DISCOUNTS), false);
    const mid = await counts(f);
    const r = await run(f, fake(TABLES, DISCOUNTS), false);
    expect(r.stands.created).toEqual([]);
    expect(r.stands.unchanged).toEqual([31, 32]);
    expect(r.presets.created).toEqual([]);
    expect(r.presets.unchanged).toEqual(['Senior Treat', 'Birthday Peso Off']);
    expect(await counts(f)).toEqual(mid);
  });

  it('a preset with value 0 or a percent over 100 is refused IN WORDS, named in the report, left out; the good ones still load', async () => {
    const f = await fixture();
    const r = await run(f, fake([], [disc('Zero Off', 'fixed', 0), disc('Huge Off', 'percent', 150), disc('Fine Off', 'percent', 10)]), false);
    expect(r.presets.created).toEqual(['Fine Off']);
    expect(r.presets.refused.map((x) => x.name)).toEqual(['Zero Off', 'Huge Off']);
    expect(r.presets.refused[0]!.reason).toMatch(/value of 0/);
    expect(r.presets.refused[1]!.reason).toMatch(/percent over 100/);
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_discount_presets where store_id = ${f.storeId} and name in ('Zero Off', 'Huge Off')`)[0]!.n).toBe(0);
    expect(formatStoreSetupReport(r).join('\n')).toMatch(/Zero Off: .*value of 0/);
  });

  it('v1 GLOBAL discounts load as presets too; a store discount of the same name wins (one preset per name); globals outside their dates are left out', async () => {
    const f = await fixture();
    const now = new Date('2026-11-20T04:00:00Z');
    const source = fake([], [disc('Senior Treat', 'percent', 20)], [
      disc('Senior Treat', 'percent', 50), // clashes with the store's: the store one wins
      disc('Anniversary Promo', 'percent', 15, { startDate: '2026-11-01', endDate: '2026-11-30' }),
      disc('Always Peso Off', 'fixed', 30),
      disc('Future Promo', 'percent', 10, { startDate: '2026-12-01' }),
      disc('Past Promo', 'percent', 10, { endDate: '2026-10-31' }),
    ]);
    const r = await asOrg(f.orgId, (tx) => loadStoreSetup(tx, f.admin, { storeId: f.storeId, dryRun: false, now }, source));
    expect(r.presets.created).toEqual(['Senior Treat', 'Anniversary Promo', 'Always Peso Off']);
    expect(r.presets.skipped.map((s) => s.split(' (')[0])).toEqual(['Senior Treat', 'Future Promo', 'Past Promo']);
    expect(r.presets.skipped[0]).toMatch(/store discount, which wins/);
    const rows = await sql<{ name: string; value: string }[]>`
      select name, value::text from pos_discount_presets
      where store_id = ${f.storeId} and name in ('Senior Treat', 'Anniversary Promo', 'Always Peso Off') order by name`;
    expect(rows).toEqual([
      { name: 'Always Peso Off', value: '30.00' },
      { name: 'Anniversary Promo', value: '15.00' },
      { name: 'Senior Treat', value: '20.00' }, // 20 from the store, never the global 50
    ]);
    expect((await sql<{ n: number }[]>`select count(*)::int n from pos_discount_presets where store_id = ${f.storeId} and name in ('Future Promo', 'Past Promo')`)[0]!.n).toBe(0);
  });

  it('two non-archived STORE discounts with the same name (any case): the first loads, the other is skipped as a duplicate name, and a re-run changes nothing', async () => {
    const f = await fixture();
    const source = fake([], [disc('Dup Promo', 'percent', 10), disc('dup promo ', 'percent', 25), disc('Dup Promo', 'percent', 5, { isArchived: true })]);
    const r = await run(f, source, false);
    expect(r.presets.created).toEqual(['Dup Promo']);
    expect(r.presets.skipped).toHaveLength(2); // the second live one (duplicate name) and the archived one
    expect(r.presets.skipped.some((s) => /duplicate name/.test(s))).toBe(true);
    expect((await sql<{ value: string }[]>`select value::text from pos_discount_presets where store_id = ${f.storeId} and lower(name) = 'dup promo' and status = 'active'`).map((x) => x.value)).toEqual(['10.00']);
    const mid = await counts(f);
    const again = await run(f, source, false);
    expect(again.presets.created).toEqual([]);
    expect(again.presets.updated).toEqual([]); // the 25 never overwrites the 10
    expect(await counts(f)).toEqual(mid);
  });

  it('a store discount that is switched off, archived or suspended does not claim the name: the first LOADABLE one wins, and a global of that name can load', async () => {
    const f = await fixture();
    const source = fake([], [
      disc('Claim Test', 'percent', 5, { isEnabled: false }),
      disc('claim test', 'percent', 6, { adminSuspended: true }),
      disc('Claim Test', 'percent', 7, { isArchived: true }),
      disc('Claim Test', 'percent', 10), // first loadable: wins
      disc('Claim Test', 'percent', 25), // loadable duplicate: skipped
      disc('Only Off', 'percent', 5, { isEnabled: false }),
    ], [disc('Only Off', 'percent', 40)]); // the store's is off, so it does not block the global
    const r = await run(f, source, false);
    expect(r.presets.created).toEqual(['Claim Test', 'Only Off']);
    expect(r.presets.skipped.filter((s) => /duplicate name/.test(s))).toHaveLength(1);
    const rows = await sql<{ name: string; value: string }[]>`select name, value::text from pos_discount_presets where store_id = ${f.storeId} and name in ('Claim Test', 'Only Off') order by name`;
    expect(rows).toEqual([
      { name: 'Claim Test', value: '10.00' },
      { name: 'Only Off', value: '40.00' },
    ]);
  });

  it('a global outside its dates never blocks a later valid global of the same name', async () => {
    const f = await fixture();
    const now = new Date('2026-11-20T04:00:00Z');
    const source = fake([], [], [
      disc('Seasonal', 'percent', 10, { endDate: '2026-10-31' }), // expired
      disc('Seasonal', 'percent', 12, { startDate: '2026-12-01' }), // not started
      disc('Seasonal', 'percent', 15, { startDate: '2026-11-01', endDate: '2026-11-30' }), // valid: loads
    ]);
    const r = await asOrg(f.orgId, (tx) => loadStoreSetup(tx, f.admin, { storeId: f.storeId, dryRun: false, now }, source));
    expect(r.presets.created).toEqual(['Seasonal']);
    expect(r.presets.skipped).toHaveLength(2);
    expect((await sql<{ value: string }[]>`select value::text from pos_discount_presets where store_id = ${f.storeId} and name = 'Seasonal'`).map((x) => x.value)).toEqual(['15.00']);
  });

  it('a store with no live v1 link is refused in words and nothing is read from the source', async () => {
    const f = await fixture();
    let read = 0;
    const source: V1StoreSetupSource = { listTables: async () => { read++; return []; }, listDiscounts: async () => { read++; return []; }, listGlobalDiscounts: async () => { read++; return []; } };
    const err = await run(f, source, false, f.store2Id).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusalError);
    expect((err as RefusalError).userMessage).toMatch(/not linked to POS v1/);
    expect(read).toBe(0);
  });

  it('the report lists each gap kind and fixes none of them', async () => {
    const f = await fixture();
    // an item the store sells with no kitchen route, and a package with no refill items
    const orphan = await newItem(f, 'a_la_carte', 'Orphan Dish');
    await insRule(f, orphan.variantId);
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${f.orgId}, ${f.storeId}, ${orphan.variantId}, 'store', '99.00', false, ${f.personId})`;
    const pkg = await newItem(f, 'package', 'Bare Package');
    await insRule(f, pkg.variantId);
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${f.orgId}, ${f.storeId}, ${pkg.variantId}, 'store', '399.00', false, ${f.personId})`;
    const tendersBefore = await sql`select id, pos_v1_alias from tenders where store_id = ${f.storeId} order by id`;

    const r = await run(f, fake([], []), false);

    expect(r.gaps.tendersWithoutAlias).toEqual(['Cash', 'GCash']); // Maya is inactive, so not a gap
    expect(r.gaps.itemsWithoutStation).toContain('Orphan Dish');
    expect(r.gaps.itemsWithoutStation).toContain('Bare Package');
    expect(r.gaps.itemsWithoutStation).not.toContain('Pork belly');
    expect(r.gaps.packagesWithoutRefills).toEqual(['Bare Package']); // Unli Grill names Rice refill
    expect(r.gaps.staffWithoutPin.map((s) => s.displayName)).toEqual(['Cara Counter', 'Kit Kitchen']);
    expect(await sql`select id, pos_v1_alias from tenders where store_id = ${f.storeId} order by id`).toEqual(tendersBefore);
    const lines = formatStoreSetupReport(r).join('\n');
    expect(lines).toMatch(/tenders without a v1 alias: 2/);
    expect(lines).toMatch(/packages without refill items: 1/);
  });

  it('a person who has a live PIN at the store is not listed as missing one', async () => {
    const f = await fixture();
    await sql`insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash) values (${f.counterId}, 'pin', ${f.storeId}, 'x-hash', ${`lh-${f.counterId}`})`;
    const r = await run(f, fake([], []), true);
    expect(r.gaps.staffWithoutPin.map((s) => s.displayName)).toEqual(['Kit Kitchen']);
  });

  it('prints no Firestore id: the report text carries only stand numbers and names', async () => {
    const f = await fixture();
    const posStoreId = (await sql<{ pos_store_id: string }[]>`select pos_store_id from pos_v1_store_links where store_id = ${f.storeId}`)[0]!.pos_store_id;
    const r = await run(f, fake(TABLES, DISCOUNTS), true);
    expect(formatStoreSetupReport(r).join('\n')).not.toContain(posStoreId);
    expect(JSON.stringify(r)).not.toContain(posStoreId);
  });
});
