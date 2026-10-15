import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-371 S0 — production module: `labourCost` and the input/output line `quantity` on `createProductionDraft` (register-named `labourCost`; the lines go through
 * the BULK `insertProductionRecordLines`, which the first census missed). §S0 per-module NaN tests.
 *
 * Today `labourCost: input.labourCost ?? '0'` and the line quantities reach the INSERTs unparsed, so `'abc'` / `'NaN'` surface as the database's own error.
 * The draft is a two-step write (the record, then its lines) inside the caller's transaction, so a refused LINE must leave no orphan record either.
 * The target: a plain sentence quoting the typed value and naming the field, zero rows in BOTH tables, and a later valid draft succeeds.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) throw new Error('Refusing to run against a database whose name does not contain "_test".');

import { closeDb } from '@shareat/db';
import { createProductionDraft } from '@shareat/domain';
import { NAN_INPUTS, asOrg, bootstrap, count, expectPlainRefusal, refusalOf, uid } from './_fixtures/t371-nan';
import { testItemCode } from './_fixtures/item-code';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const k = await bootstrap(sql, hint);
  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${k.orgId}, 'STK', 'Stockroom') returning id`;
  const [loc] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${k.orgId}, ${k.storeId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${k.adminId}) returning id`;
  // T-409: a slice takes a slab and makes sliced meat, so the fixture items carry those kinds (assertions unchanged).
  await sql`update items set kind = 'meat_slab' where id = ${k.itemId}`;
  const [out] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by) values (${k.orgId}, ${testItemCode()}, 'Sliced pork', 'meat_sliced', 'kg', ${k.adminId}) returning id`;
  const draft = (over: Record<string, unknown> = {}) => ({
    orgId: k.orgId, storeId: k.storeId, locationId: loc!.id, kind: 'slice' as const, producedOn: '2026-01-10', labourCost: '25.00',
    inputs: [{ itemId: k.itemId, quantity: '5', unit: 'kg' }], outputs: [{ itemId: out!.id, quantity: '4', unit: 'kg' }], ...over,
  });
  return { k, draft };
}
const rows = async (orgId: string) => [
  await count(sql, 'production_records', orgId),
  Number((await sql<{ n: string }[]>`select count(*)::text as n from production_record_lines l join production_records r on r.id = l.record_id where r.org_id = ${orgId}`)[0]!.n),
];

describe('production — labourCost', () => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the labour cost; zero records and lines; a later valid draft succeeds and reads back`, async () => {
      const { k, draft } = await fixture(`pr-labour-${typed}`);
      const before = await rows(k.orgId);
      const got = await refusalOf(asOrg(k.orgId, (tx) => createProductionDraft(tx, k.admin, draft({ labourCost: typed }))));
      expectPlainRefusal(got, typed, /labour/i, 'createProductionDraft.labourCost');
      expect(await rows(k.orgId), 'a refused draft wrote rows').toEqual(before);
      const ok = await refusalOf(asOrg(k.orgId, (tx) => createProductionDraft(tx, k.admin, draft())));
      expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
      const [row] = await sql<{ l: string }[]>`select labour_cost::text as l from production_records where org_id = ${k.orgId}`;
      expect(row?.l, 'a valid labour cost reads back byte-identical').toBe('25.00');
    });
  }
});

describe('production — a valid draft reads back byte-identical (line quantities, numeric(14,3))', () => {
  it('inputs 5 kg and outputs 4 kg are stored as 5.000 and 4.000', async () => {
    const { k, draft } = await fixture('pr-readback');
    const ok = await refusalOf(asOrg(k.orgId, (tx) => createProductionDraft(tx, k.admin, draft())));
    expect(ok.text, `the control was refused: ${ok.text}`).toBeNull();
    const lines = await sql<{ direction: string; q: string }[]>`select l.direction, l.quantity::text as q from production_record_lines l join production_records r on r.id = l.record_id where r.org_id = ${k.orgId} order by l.direction`;
    expect(lines.map((l) => `${l.direction}:${l.q}`)).toEqual(['in:4.000', 'out:5.000']);
  });
});

describe('production — a BLANK labourCost follows the column (✎R13: NOT NULL with a default 0 -> the default applies, never an error)', () => {
  it("'' creates the draft and stores the column default 0.00", async () => {
    const { k, draft } = await fixture('pr-labour-blank');
    const out = await refusalOf(asOrg(k.orgId, (tx) => createProductionDraft(tx, k.admin, draft({ labourCost: '' }))));
    expect(out.text, `a blank labour cost was refused: ${out.text}`).toBeNull();
    const [row] = await sql<{ l: string }[]>`select labour_cost::text as l from production_records where org_id = ${k.orgId}`;
    expect(row?.l, 'a blank must take the column default, not a guessed value').toBe('0.00');
  });
});

describe.each([['input', 'inputs'], ['output', 'outputs']] as const)('production — %s line quantity (a BULK insert)', (label, field) => {
  for (const typed of NAN_INPUTS) {
    it(`${JSON.stringify(typed)}: a plain sentence quoting it and naming the quantity; NO orphan record and no lines`, async () => {
      const { k, draft } = await fixture(`pr-${label}-${typed}`);
      const before = await rows(k.orgId);
      const base = draft();
      const lines = [{ ...(base[field][0] as { itemId: string; unit: string }), quantity: typed }];
      const got = await refusalOf(asOrg(k.orgId, (tx) => createProductionDraft(tx, k.admin, draft({ [field]: lines }))));
      expectPlainRefusal(got, typed, /quantity/i, `createProductionDraft.${field}[0].quantity`);
      expect(await rows(k.orgId), 'a refused line left an orphan production record').toEqual(before);
    });
  }
});
