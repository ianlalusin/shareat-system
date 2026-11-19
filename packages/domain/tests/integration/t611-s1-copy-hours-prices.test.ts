/**
 * T-611 S1 - "Copy from another store": menu hours and store prices (with option prices). docs/tasks/611-copy-settings-between-stores.md.
 * Against real PostgreSQL. Each tick has a cross that fires (the mutants are listed in the hand-back, run by hand).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { copySettingsToStore, createDaypart, previewCopyToStore, setMenuOffer, setOptionOffer, type CopyKind } from '@shareat/domain';

import { asOrg, attempt, auditCount, cast, expectSentence, rawItem, rawOption, rawRule, sql, uid, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const DAYS = [0, 1, 2, 3, 4, 5, 6];
interface World extends Cast {
  storeC: string;
}
async function world(hint: string): Promise<World> {
  const c = await cast(hint);
  const [r] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${c.orgId}, ${uid('ST')}, 'Malvar') returning id`;
  for (const p of [c.admin, c.superAdmin, c.manager]) await sql`insert into person_store_scope (person_id, store_id) values (${p.personId}, ${r!.id})`;
  return { ...c, storeC: r!.id };
}
const hour = (c: Cast, storeId: string, name: string, start: string, end: string) =>
  asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId, name, days: DAYS, start, end }, tx)).then((r) => r.id);
const price = (c: Cast, storeId: string, variantId: string, amount: string, o: { channel?: 'store' | 'online'; daypartId?: string } = {}) =>
  asOrg(c.orgId, (tx) => setMenuOffer(c.superAdmin, { storeId, variantId, channel: o.channel ?? 'store', amount, ...(o.daypartId ? { daypartId: o.daypartId } : {}) }, tx));
const variant = async (c: Cast) => {
  const v = await rawItem(c);
  await rawRule(c, v.variantId);
  return v.variantId;
};
const copy = (c: Cast, who: Cast['admin'], kind: CopyKind, source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => copySettingsToStore(who, { kind, sourceStoreId: source, targetStoreId: target, replace, approverPersonId: c.admin.personId }, tx));
const preview = (c: Cast, who: Cast['admin'], kind: CopyKind, source: string, target: string, replace = false) =>
  asOrg(c.orgId, (tx) => previewCopyToStore(who, { kind, sourceStoreId: source, targetStoreId: target, replace }, tx));
const said = (r: { error?: unknown }) => (r.error as { userMessage: string }).userMessage;

interface OfferRow { amount: string | null; daypart_id: string | null; withdrawn: boolean; effective_from: Date; channel: string }
const offerRows = (storeId: string, variantId: string) =>
  sql<OfferRow[]>`select amount::text, daypart_id, withdrawn, effective_from, channel from menu_offers where store_id = ${storeId} and variant_id = ${variantId} order by effective_from, id`;
const hoursOf = (storeId: string) =>
  sql<{ id: string; name: string; start: string; end: string; status: string }[]>`
    select id, name, start_time::text as start, end_time::text as end, status from menu_dayparts where store_id = ${storeId} order by start_time, name`;

describe('T-611 S1: copy menu hours', () => {
  it('1: the preview counts match the apply; a different hour is KEPT unless Replace is on; matching is by name, ignoring capitals', async () => {
    const c = await world('t611-h1');
    await hour(c, c.storeA, 'Breakfast', '06:00', '10:00');
    await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    await hour(c, c.storeA, 'Dinner', '15:00', '22:00');
    await hour(c, c.storeB, 'LUNCH', '10:00', '15:00');
    await hour(c, c.storeB, 'Dinner', '16:00', '22:00');

    const p = await preview(c, c.admin, 'hours', c.storeA, c.storeB);
    expect(p.counts).toEqual({ added: 1, replaced: 0, skipped: 2, same: 1, kept: 1 });
    expect(p.lines.map((l) => l.status).sort()).toEqual(['add', 'different', 'same']);
    const before = await auditCount(c.orgId);
    expect(before).toBeGreaterThan(0);

    const r = await copy(c, c.admin, 'hours', c.storeA, c.storeB);
    expect(r.counts).toEqual(p.counts);
    const after = await hoursOf(c.storeB);
    expect(after.map((h) => `${h.name} ${h.start.slice(0, 5)}-${h.end.slice(0, 5)}`)).toEqual(['Breakfast 06:00-10:00', 'LUNCH 10:00-15:00', 'Dinner 16:00-22:00']);
  });

  it('2: Replace on updates the different hour through updateDaypart (an edited audit row), and the counts say so', async () => {
    const c = await world('t611-h2');
    await hour(c, c.storeA, 'Dinner', '15:00', '22:00');
    const dinnerB = await hour(c, c.storeB, 'Dinner', '16:00', '22:00');
    const p = await preview(c, c.admin, 'hours', c.storeA, c.storeB, true);
    expect(p.counts).toEqual({ added: 0, replaced: 1, skipped: 0, same: 0, kept: 0 });
    const r = await copy(c, c.admin, 'hours', c.storeA, c.storeB, true);
    expect(r.counts).toEqual(p.counts);
    const [row] = await hoursOf(c.storeB);
    expect(row!.id).toBe(dinnerB);
    expect(row!.start.slice(0, 5)).toBe('15:00');
    const [n] = await sql<{ n: number }[]>`select count(*)::int as n from audit_log where store_id = ${c.storeB} and action = 'menu_daypart.edited'`;
    expect(n!.n).toBe(1);
  });

  it('3: an overlap refuses THAT target with the T-610 sentence and writes nothing there (all or nothing); another target still gets its copy', async () => {
    const c = await world('t611-h3');
    await hour(c, c.storeA, 'Early', '05:00', '06:00');
    await hour(c, c.storeA, 'Dinner', '14:00', '22:00');
    await hour(c, c.storeC, 'Lunch', '10:00', '15:00');
    // Early (05:00) is created before Dinner (14:00) is refused: it must not survive in Malvar.
    const bad = await attempt(() => copy(c, c.admin, 'hours', c.storeA, c.storeC));
    expectSentence(bad, 'overlap at one target');
    expect(said(bad)).toContain('overlaps Lunch');
    expect((await hoursOf(c.storeC)).map((h) => h.name)).toEqual(['Lunch']);
    await copy(c, c.admin, 'hours', c.storeA, c.storeB);
    expect((await hoursOf(c.storeB)).map((h) => h.name)).toEqual(['Early', 'Dinner']);
  });
});

describe('T-611 S1: copy store prices', () => {
  it('4: a missing price is added as a NEW row effective now; the source history is untouched; an all-day and a dayparted price both copy; the hour is mapped by name', async () => {
    const c = await world('t611-p1');
    const v1 = await variant(c);
    const v2 = await variant(c);
    const lunchA = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    const lunchB = await hour(c, c.storeB, 'lunch', '10:00', '15:00');
    await price(c, c.storeA, v1, '120.00');
    await price(c, c.storeA, v2, '95.00', { daypartId: lunchA });
    const srcBefore = JSON.stringify([...(await offerRows(c.storeA, v1)), ...(await offerRows(c.storeA, v2))]);

    const p = await preview(c, c.admin, 'prices', c.storeA, c.storeB);
    expect(p.counts.added).toBe(1); // the dayparted one needs a super admin to pair a new hour: skipped for a plain admin
    expect(p.lines.find((l) => l.status === 'skip')!.note).toContain('super admin');
    const r = await copy(c, c.superAdmin, 'prices', c.storeA, c.storeB);
    expect(r.counts).toEqual({ added: 2, replaced: 0, skipped: 0, same: 0, kept: 0 });

    const a = await offerRows(c.storeB, v1);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ amount: '120.00', daypart_id: null, withdrawn: false });
    expect(Math.abs(a[0]!.effective_from.getTime() - Date.now())).toBeLessThan(60_000); // effective now, not the source's date
    const b = await offerRows(c.storeB, v2);
    expect(b[0]).toMatchObject({ amount: '95.00', daypart_id: lunchB }); // the TARGET's hour, found by name
    expect(JSON.stringify([...(await offerRows(c.storeA, v1)), ...(await offerRows(c.storeA, v2))])).toBe(srcBefore);
  });

  it('5: a missing target hour skips that price with the reason; after the hours are copied the price copies', async () => {
    const c = await world('t611-p2');
    const v = await variant(c);
    const lunchA = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    await price(c, c.storeA, v, '95.00', { daypartId: lunchA });
    const p = await preview(c, c.superAdmin, 'prices', c.storeA, c.storeB);
    expect(p.counts).toEqual({ added: 0, replaced: 0, skipped: 1, same: 0, kept: 0 });
    expect(p.lines[0]!.note).toBe('Batangas has no hours called Lunch. Copy the menu hours first.');
    await copy(c, c.superAdmin, 'prices', c.storeA, c.storeB);
    expect(await offerRows(c.storeB, v)).toHaveLength(0);
    await copy(c, c.admin, 'hours', c.storeA, c.storeB);
    const r = await copy(c, c.superAdmin, 'prices', c.storeA, c.storeB);
    expect(r.counts.added).toBe(1);
    expect(await offerRows(c.storeB, v)).toHaveLength(1);
  });

  it('6: a different price is KEPT by default; with Replace it becomes a new row and the old row is never edited; an identical price writes nothing', async () => {
    const c = await world('t611-p3');
    const diff = await variant(c);
    const same = await variant(c);
    await price(c, c.storeA, diff, '150.00');
    await price(c, c.storeA, same, '80.00');
    await price(c, c.storeB, diff, '140.00');
    await price(c, c.storeB, same, '80.00');
    const oldRow = (await offerRows(c.storeB, diff))[0]!;

    const kept = await copy(c, c.admin, 'prices', c.storeA, c.storeB);
    expect(kept.counts).toEqual({ added: 0, replaced: 0, skipped: 2, same: 1, kept: 1 });
    expect(await offerRows(c.storeB, diff)).toHaveLength(1);
    expect((await offerRows(c.storeB, diff))[0]!.amount).toBe('140.00');

    const p = await preview(c, c.admin, 'prices', c.storeA, c.storeB, true);
    const done = await copy(c, c.admin, 'prices', c.storeA, c.storeB, true);
    expect(done.counts).toEqual(p.counts);
    expect(done.counts).toEqual({ added: 0, replaced: 1, skipped: 1, same: 1, kept: 0 });
    const hist = await offerRows(c.storeB, diff);
    expect(hist).toHaveLength(2); // history grew
    expect(hist[0]).toMatchObject({ amount: '140.00', withdrawn: false });
    expect(hist[0]!.effective_from.getTime()).toBe(oldRow.effective_from.getTime()); // the old row is exactly as it was
    expect(hist[1]!.amount).toBe('150.00');
    expect(await offerRows(c.storeB, same)).toHaveLength(1); // identical: no new row
  });

  it('7: a price the target has and the source lacks is never withdrawn; copying removes nothing', async () => {
    const c = await world('t611-p4');
    const mine = await variant(c);
    const theirs = await variant(c);
    await price(c, c.storeA, mine, '60.00');
    await price(c, c.storeB, theirs, '70.00');
    await copy(c, c.admin, 'prices', c.storeA, c.storeB, true);
    const rows = await offerRows(c.storeB, theirs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.withdrawn).toBe(false);
  });

  it('8: option prices copy the same way (add, keep a different one, replace it on request)', async () => {
    const c = await world('t611-p5');
    const o1 = await rawOption(c);
    const o2 = await rawOption(c);
    const setOpt = (storeId: string, valueId: string, priceDelta: string) =>
      asOrg(c.orgId, (tx) => setOptionOffer(c.superAdmin, { storeId, optionValueId: valueId, channel: 'store', priceDelta }, tx));
    await setOpt(c.storeA, o1.valueId, '10.00');
    await setOpt(c.storeA, o2.valueId, '5.00');
    await setOpt(c.storeB, o2.valueId, '7.00');
    const r = await copy(c, c.admin, 'prices', c.storeA, c.storeB);
    expect(r.counts).toEqual({ added: 1, replaced: 0, skipped: 1, same: 0, kept: 1 });
    const deltas = (v: string) => sql<{ d: string }[]>`select price_delta::text as d from menu_option_offers where store_id = ${c.storeB} and option_value_id = ${v} order by effective_from`;
    expect((await deltas(o1.valueId)).map((x) => x.d)).toEqual(['10.00']);
    expect((await deltas(o2.valueId)).map((x) => x.d)).toEqual(['7.00']);
    await copy(c, c.admin, 'prices', c.storeA, c.storeB, true);
    expect((await deltas(o2.valueId)).map((x) => x.d)).toEqual(['7.00', '5.00']);
  });

  it('9: a target that prices the variant the other way (all day vs by time of day) is skipped with a reason, not failed', async () => {
    const c = await world('t611-p6');
    const v = await variant(c);
    const lunchA = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    await hour(c, c.storeB, 'Lunch', '10:00', '15:00');
    await price(c, c.storeA, v, '95.00', { daypartId: lunchA });
    await price(c, c.storeB, v, '100.00'); // all day at B
    const p = await preview(c, c.superAdmin, 'prices', c.storeA, c.storeB);
    expect(p.counts).toEqual({ added: 0, replaced: 0, skipped: 1, same: 0, kept: 0 });
    expect(p.lines[0]!.note).toBe('Batangas has an all-day price for this. Withdraw it first.');
  });
});

describe('T-611 S1: who may copy, and where', () => {
  it('10: a store of another organisation is refused as "does not exist", before anything is read or written', async () => {
    const c = await world('t611-g1');
    const other = await cast('t611-g1-other');
    const v = await variant(c);
    await price(c, c.storeA, v, '10.00');
    const r = await attempt(() => copy(c, c.admin, 'prices', c.storeA, other.storeA));
    expectSentence(r, 'foreign target');
    expect(said(r)).toMatch(/could not be found/);
    expect((await offerRows(other.storeA, v)).length).toBe(0);
    const s = await attempt(() => copy(c, c.admin, 'prices', other.storeA, c.storeB));
    expectSentence(s, 'foreign source');
    expect(said(s)).toMatch(/could not be found/);
  });

  it('11: only an administrator copies; a manager is refused in a sentence and nothing is written', async () => {
    const c = await world('t611-g2');
    const v = await variant(c);
    await price(c, c.storeA, v, '10.00');
    const r = await attempt(() => preview(c, c.manager, 'prices', c.storeA, c.storeB));
    expectSentence(r, 'manager preview');
    expect(said(r)).toBe('Only an administrator can copy settings from one store to another.');
    const w = await attempt(() => copy(c, c.manager, 'prices', c.storeA, c.storeB));
    expectSentence(w, 'manager copy');
    expect(await offerRows(c.storeB, v)).toHaveLength(0);
  });

  it('12: the same store, and a closed store, are refused', async () => {
    const c = await world('t611-g3');
    expectSentence(await attempt(() => copy(c, c.admin, 'hours', c.storeA, c.storeA)), 'same store');
    await sql`update stores set is_active = false where id = ${c.storeC}`;
    const r = await attempt(() => copy(c, c.admin, 'hours', c.storeA, c.storeC));
    expectSentence(r, 'closed store');
    expect(said(r)).toContain('closed');
  });

  it('13: a plain admin cannot start a time-of-day price at a new store (pairing is super admin only): skipped with the reason, the rest still copies', async () => {
    const c = await world('t611-g4');
    const dayparted = await variant(c);
    const plain = await variant(c);
    const lunchA = await hour(c, c.storeA, 'Lunch', '10:00', '15:00');
    await hour(c, c.storeB, 'Lunch', '10:00', '15:00');
    await price(c, c.storeA, dayparted, '95.00', { daypartId: lunchA });
    await price(c, c.storeA, plain, '60.00');
    const r = await copy(c, c.admin, 'prices', c.storeA, c.storeB);
    expect(r.counts).toMatchObject({ added: 1, skipped: 1 });
    expect(r.lines.find((l) => l.status === 'skip')!.note).toBe('Only a super admin can set a new price by time of day.');
    expect(await offerRows(c.storeB, dayparted)).toHaveLength(0);
    expect(await offerRows(c.storeB, plain)).toHaveLength(1);
  });
});

describe('T-611 S1: the audit trail', () => {
  it('14: one settings.copied row per target with the kind, the source and the counts; the preview writes nothing', async () => {
    const c = await world('t611-a1');
    const v = await variant(c);
    await price(c, c.storeA, v, '40.00');
    const n0 = await auditCount(c.orgId);
    await preview(c, c.admin, 'prices', c.storeA, c.storeB);
    expect(await auditCount(c.orgId)).toBe(n0); // a preview leaves no trace
    await copy(c, c.admin, 'prices', c.storeA, c.storeB);
    await copy(c, c.admin, 'prices', c.storeA, c.storeC);
    const rows = await sql<{ store_id: string; after: Record<string, unknown> }[]>`
      select store_id, "after" from audit_log where org_id = ${c.orgId} and action = 'settings.copied' order by store_id`;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.store_id).sort()).toEqual([c.storeB, c.storeC].sort());
    expect(rows[0]!.after).toMatchObject({ kind: 'prices', sourceStoreId: c.storeA, added: 1, replaced: 0, skipped: 0, replace: false, approverPersonId: c.admin.personId });
  });
});
