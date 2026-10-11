import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T-390 S2 - audit legs (coordinator, 2026-10-11). `docs/tasks/390-opening-stock-and-subledger-tieout.md` s4 R3, R5, R7, R8.
 * 1 zero cost is UNPRICED, 2 a store worth under 0.005 never blocks forever, 3 post re-checks one-cost-per-item, 4 a REVERSED opening
 * still closes every writer, 5 unmapped kind by name in the integration path and a sub-centavo fixture compared in centavos.
 * Same private DB and fixtures as t390-s2-opening-stock-post.test.ts.
 */
import { closeDb, stockLayersRepo } from '@shareat/db';
import {
  asOrg, attestC3P, count, domain, errorOf, openingLayers, openingMovements, post, postedOpeningLine,
  primePool, readyToPost, s2fixture, sentenceOf, settle3900, sql, uid, value, type S2Fixture,
} from './t390-s2-common';
import { CONVERSION } from './t390-s3-common';

const OPENED = /The books were opened on/;
const figure = (f: S2Fixture, accountCode: string, amount: string, storeId = f.storeA) =>
  asOrg(f.orgId, (tx) => domain.addOpeningFigure(tx, f.admin, { accountCode, storeId, direction: 'debit', amount, entryDate: CONVERSION }));
/** "123.45" -> 12345n. Exact; never a float. */
const centavos = (t: string): bigint => {
  const [whole = '0', frac = ''] = t.trim().split('.');
  expect(frac.slice(2).replace(/0/g, ''), `${t} has sub-centavo digits`).toBe('');
  return BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
};

beforeAll(async () => {
  await primePool(10);
}, 300_000);
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('leg 1 - a cost of 0 is UNPRICED', () => {
  it('valueOpeningStock refuses and names the item; post writes no zero-cost layer', async () => {
    const f = await s2fixture('a1-zero');
    const typed = await errorOf(count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '5', cost: '0' }));
    if (typed) {
      expect(sentenceOf(typed)).toMatch(/cost/i); // refusing a zero cost at entry is also acceptable
      return;
    }
    const err = await errorOf(value(f, f.storeA));
    expect(err, 'a zero-cost count was valued (it would open at nothing)').not.toBeNull();
    expect(sentenceOf(err)).toContain(f.names.raw!);

    // And C5 itself must not open it: a figure elsewhere so a draft exists, then post.
    await figure(f, '1130', '50.00');
    await settle3900(f);
    await attestC3P(f);
    const p = await errorOf(post(f));
    expect(p, 'C5 posted a counted item at cost 0').not.toBeNull();
    expect(await openingLayers(f.orgId), 'a zero-cost layer was written').toHaveLength(0);
    expect(await openingMovements(f.orgId)).toHaveLength(0);
  });
});

describe('leg 2 - a store whose lines all value to under 0.005', () => {
  it('never gives the wrong "count changed" sentence, and a retry behaves the same (no permanent block)', async () => {
    const f = await s2fixture('a2-tiny');
    await count(f, { store: f.storeB, room: f.barB, item: f.raw, qty: '1', cost: '0.0040' });
    expect(await value(f, f.storeB), 'worth 0.004: no 1310 line, so nothing to draft').toBeNull();
    await figure(f, '1130', '50.00', f.storeB);
    await settle3900(f);
    await attestC3P(f);

    const first = await errorOf(post(f));
    if (first === null) {
      // Consistent alternative: it posted, wrote its layer, and there is no 1310 line.
      expect(await openingLayers(f.orgId)).toHaveLength(1);
      expect(centavos(await postedOpeningLine(f.orgId, f.storeB, '1310'))).toBe(0n);
      return;
    }
    const s1 = sentenceOf(first);
    expect(s1, 'wrong reason: nothing changed after valuing').not.toMatch(/count changed after it was valued/i);
    expect(await openingLayers(f.orgId)).toHaveLength(0);
    await value(f, f.storeB); // pressing Value again must not be required, and must not change the outcome
    const second = await errorOf(post(f));
    expect(second, 'the second attempt behaved differently').not.toBeNull();
    expect(sentenceOf(second)).toBe(s1);
  });
});

describe('leg 3 - writeOpeningStock re-checks one cost per item per store at post time', () => {
  it('two room costs 0.0001 apart (same rounded total) are refused, naming the item and store', async () => {
    const f = await s2fixture('a3-twocosts');
    await readyToPost(f);
    await sql`update opening_counts set unit_cost = 100.0001 where org_id = ${f.orgId} and store_id = ${f.storeA} and location_id = ${f.frzA} and item_id = ${f.raw}`;
    const err = await errorOf(post(f));
    expect(err, 'C5 posted one item with two costs').not.toBeNull();
    expect(sentenceOf(err)).toContain(f.names.raw!);
    expect(sentenceOf(err)).toContain(f.nameA);
    expect(await openingMovements(f.orgId)).toHaveLength(0);
    expect(await openingLayers(f.orgId)).toHaveLength(0);
  });
});

describe('leg 4 - a REVERSED opening still closes every writer', () => {
  it('post, reverse every opening entry, then count / figure / value all refuse with the books-opened sentence', async () => {
    const f = await s2fixture('a4-reversed');
    await readyToPost(f);
    const r = await post(f);
    for (const id of r.entryIds) {
      await asOrg(f.orgId, (tx) =>
        domain.reverseEntry(tx, { entryId: id, reason: 'T-390 audit leg 4', reversedBy: f.adminId, reversalDate: CONVERSION }),
      );
    }
    const originals = await sql<{ status: string }[]>`select status from journal_entries where id = any(${r.entryIds})`;
    expect(originals.every((e) => e.status === 'reversed'), 'fixture: every posted opening entry should now be reversed').toBe(true);
    const attempts: [string, unknown][] = [];
    attempts.push(['recordOpeningCount', await errorOf(count(f, { store: f.storeA, room: f.kitA, item: f.raw, qty: '9', cost: '100.0000' }))]);
    attempts.push(['addOpeningFigure', await errorOf(figure(f, '1120', '10.00'))]);
    attempts.push(['valueOpeningStock', await errorOf(value(f, f.storeA))]);
    for (const [name, err] of attempts) {
      expect(err, `${name} worked after a reversed opening`).not.toBeNull();
      expect(sentenceOf(err), name).toMatch(OPENED);
    }
  });
});

describe('leg 5 - unmapped kind by name; sub-centavo fixture compared in centavos', () => {
  it('valueOpeningStock refuses an item whose kind has no inventory account, by item name', async () => {
    const f = await s2fixture('a5-kind');
    const nm = `Mystery Crate ${uid('k')}`;
    await sql.unsafe('alter table items drop constraint items_kind_check');
    let itemId: string | undefined;
    try {
      const [it] = await sql<{ id: string }[]>`
        insert into items (org_id, code, name, kind, base_unit, created_by) values (${f.orgId}, ${uid('IT')}, ${nm}, 'mystery_kind', 'kg', ${f.adminId}) returning id`;
      itemId = it!.id;
      await count(f, { store: f.storeA, room: f.kitA, item: itemId, qty: '2', cost: '10.0000' });
      const err = await errorOf(value(f, f.storeA));
      expect(err, 'an unmapped kind was valued').not.toBeNull();
      expect(sentenceOf(err)).toContain(nm);
    } finally {
      if (itemId) {
        await sql`delete from opening_counts where item_id = ${itemId}`;
        await sql`delete from items where id = ${itemId}`;
      }
      await sql.unsafe(
        `alter table items add constraint items_kind_check check (kind in ('raw_material','supply','retail','meat_slab','meat_sliced'))`,
      );
    }
  });

  it('3 rooms x 1 unit at 0.3333 value at 1.00 (one rounding), and I1 holds in exact centavos', async () => {
    const f = await s2fixture('a5-sub');
    for (const room of [f.kitA, f.frzA, f.dryA]) await count(f, { store: f.storeA, room, item: f.pinch, qty: '1', cost: '0.3333' });
    const v = await value(f, f.storeA);
    expect(v!.byAccount).toEqual([{ code: '1310', amount: '1.00' }]);
    await settle3900(f);
    await attestC3P(f);
    await post(f);
    const valuation = await asOrg(f.orgId, (tx) => stockLayersRepo.valuation(tx, f.storeA));
    const layerValue = valuation.reduce((a, r) => a + centavos(r.value), 0n);
    expect(layerValue).toBe(100n);
    expect(centavos(await postedOpeningLine(f.orgId, f.storeA, '1310'))).toBe(layerValue);
  });
});
