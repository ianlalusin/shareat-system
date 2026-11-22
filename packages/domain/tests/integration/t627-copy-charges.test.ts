/**
 * T-627 - "Copy from another store" also copies the store charges (kind 'charges'), the T-611 S3 pattern. docs/tasks/627-pos-charges.md. Against real PostgreSQL.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { copySettingsToStore, previewCopyToStore, upsertPosChargePreset } from '@shareat/domain';

import { asOrg, cast, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const charge = (c: Cast, storeId: string, name: string, amount: string, perUnit = false) =>
  asOrg(c.orgId, (tx) => upsertPosChargePreset(tx, c.admin, { storeId, name, amount, perUnit }, 'web')).then((r) => r.presetId);
const copy = (c: Cast, source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => copySettingsToStore(c.admin, { kind: 'charges', sourceStoreId: source, targetStoreId: target, replace, approverPersonId: c.admin.personId }, tx));
const preview = (c: Cast, source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => previewCopyToStore(c.admin, { kind: 'charges', sourceStoreId: source, targetStoreId: target, replace }, tx));
const shown = async (storeId: string) =>
  (await sql<{ name: string; amount: string; per_unit: boolean }[]>`select name, amount::text, per_unit from pos_charge_presets where store_id = ${storeId} and status = 'active' order by lower(name)`).map(
    (p) => `${p.name} ${p.amount} ${p.per_unit ? 'each' : 'once'}`,
  );

describe('T-627: copy store charges', () => {
  it('adds the missing ones, matches by name ignoring capitals, keeps a different amount unless Replace is on, and the counts match the preview', async () => {
    const c = await cast('t627-copy1');
    await charge(c, c.storeA, 'Leftover', '100', true);
    await charge(c, c.storeA, 'Extra griller', '150');
    await charge(c, c.storeA, 'Corkage', '200');
    await charge(c, c.storeB, 'LEFTOVER', '100', true); // same, other capitals
    await charge(c, c.storeB, 'Corkage', '250'); // differs

    const p = await preview(c, c.storeA, c.storeB);
    expect(p.counts).toEqual({ added: 1, replaced: 0, skipped: 2, same: 1, kept: 1 });
    expect(p.lines.find((l) => l.status === 'different')!.note).toBe('The store has 250.00 pesos.');
    expect((await copy(c, c.storeA, c.storeB)).counts).toEqual(p.counts);
    expect(await shown(c.storeB)).toEqual(['Corkage 250.00 once', 'Extra griller 150.00 once', 'LEFTOVER 100.00 each']);

    const r = await preview(c, c.storeA, c.storeB, true);
    expect(r.counts).toMatchObject({ replaced: 1, kept: 0 });
    await copy(c, c.storeA, c.storeB, true);
    expect(await shown(c.storeB)).toContain('Corkage 200.00 once');
  });
});
