/**
 * T-610 (Ian, 19 Nov 2026: "refuse overlapping hours") - a menu hour may not overlap another ACTIVE hour of the same store, on create or edit.
 * docs/tasks/610-menu-hours-refuse-overlap.md. Against real PostgreSQL. Each tick has a cross that fires.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { createDaypart, retireDaypart, updateDaypart } from '@shareat/domain';

import { asOrg, attempt, cast, expectSentence, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const mk = (c: Cast, storeId: string, name: string, start: string, end: string, days = DAYS) =>
  asOrg(c.orgId, (tx) => createDaypart(c.admin, { storeId, name, days, start, end }, tx)).then((r) => r.id);
const edit = (c: Cast, id: string, patch: { name?: string; days?: number[]; start?: string; end?: string }) =>
  asOrg(c.orgId, (tx) => updateDaypart(c.admin, { id, ...patch }, tx));
const said = (r: { error?: unknown }) => (r.error as { userMessage: string }).userMessage;
/** An overlapping row as it may already sit in live data: raw SQL, no check. */
const raw = async (c: Cast, storeId: string, name: string, start: string, end: string, days = DAYS) =>
  (
    await sql<{ id: string }[]>`
    insert into menu_dayparts (org_id, store_id, name, days, start_time, end_time, created_by)
    values (${c.orgId}, ${storeId}, ${name}, ${days}, ${start}, ${end}, ${c.admin.personId}) returning id`
  )[0]!.id;
const countOf = async (c: Cast) => (await sql`select 1 from menu_dayparts where org_id = ${c.orgId}`).length;

describe('T-610 menu hours may not overlap', () => {
  it('1: Dinner 14-22 against Lunch 10-15 is refused, naming both hours in plain words; nothing is written', async () => {
    const c = await cast('t610-1');
    await mk(c, c.storeA, 'Lunch', '10:00', '15:00');
    const r = await attempt(() => mk(c, c.storeA, 'Dinner', '14:00', '22:00'));
    expectSentence(r, 'overlap');
    expect(said(r)).toBe('Dinner (Mon–Sun 14:00–22:00) overlaps Lunch (Mon–Sun 10:00–15:00). Change one so they meet or leave a gap.');
    expect(await countOf(c)).toBe(1);
  });

  it('2: Dinner 15-22 back to back with Lunch 10-15 is accepted', async () => {
    const c = await cast('t610-2');
    await mk(c, c.storeA, 'Lunch', '10:00', '15:00');
    await mk(c, c.storeA, 'Dinner', '15:00', '22:00');
    expect(await countOf(c)).toBe(2);
  });

  it('3: overnight 22:00-02:00 against 01:00-05:00 is refused, against 02:00-05:00 accepted (Saturday night runs into Sunday)', async () => {
    const c = await cast('t610-3');
    await mk(c, c.storeA, 'Late', '22:00', '02:00', [6]);
    expectSentence(await attempt(() => mk(c, c.storeA, 'Early', '01:00', '05:00', [0])), 'Sunday 01:00 is inside the Saturday overnight');
    await mk(c, c.storeA, 'Early', '02:00', '05:00', [0]);
  });

  it('4: a retired overlapping hour does not block', async () => {
    const c = await cast('t610-4');
    const lunch = await mk(c, c.storeA, 'Lunch', '10:00', '15:00');
    await asOrg(c.orgId, (tx) => retireDaypart(c.admin, { id: lunch }, tx));
    await mk(c, c.storeA, 'Brunch', '11:00', '14:00');
  });

  it('5: editing an hour into an overlap is refused (days, start and end alike); clear of one it is accepted, and so is a rename', async () => {
    const c = await cast('t610-5');
    await mk(c, c.storeA, 'Lunch', '10:00', '15:00', [1, 2]);
    const dinner = await mk(c, c.storeA, 'Dinner', '18:00', '22:00', [1, 2]);
    const start = await attempt(() => edit(c, dinner, { start: '14:00' }));
    expectSentence(start, 'start into Lunch');
    expect(said(start)).toContain('Dinner (Mon–Tue 14:00–22:00) overlaps Lunch (Mon–Tue 10:00–15:00)');
    expectSentence(await attempt(() => edit(c, dinner, { start: '12:00', end: '13:00' })), 'inside Lunch');
    expect((await edit(c, dinner, { start: '15:00' })).wrote).toBe(true);
    const sat = await mk(c, c.storeA, 'Sat lunch', '10:00', '15:00', [6]);
    expectSentence(await attempt(() => edit(c, sat, { days: [6, 1] })), 'days widened onto Monday lunch');
    expect((await edit(c, dinner, { name: 'Supper' })).wrote).toBe(true);
    const [row] = await sql<{ start_time: string }[]>`select start_time::text from menu_dayparts where id = ${dinner}`;
    expect(row!.start_time).toBe('15:00:00');
  });

  it("6: another store's hour never blocks", async () => {
    const c = await cast('t610-6');
    await mk(c, c.storeB, 'Lunch', '10:00', '15:00');
    await mk(c, c.storeA, 'Dinner', '14:00', '22:00');
    expect(await countOf(c)).toBe(2);
  });

  it('existing overlapping rows are left alone; saving a change to one is refused naming the clash, and moving one clear lets the other save', async () => {
    const c = await cast('t610-legacy');
    const lunch = await raw(c, c.storeA, 'Lunch', '10:00', '15:00');
    const dinner = await raw(c, c.storeA, 'Dinner', '14:00', '22:00');
    const r = await attempt(() => edit(c, dinner, { name: 'Supper' }));
    expectSentence(r, 'rename of an already-overlapping hour');
    expect(said(r)).toContain('overlaps Lunch');
    expect((await edit(c, dinner, { start: '15:00' })).wrote).toBe(true);
    expect((await edit(c, lunch, { name: 'Brunch' })).wrote).toBe(true);
  });

  it('7: two saves at once that would overlap - the second waits for the first and is refused', async () => {
    const c = await cast('t610-7');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstCreated!: () => void;
    const created = new Promise<void>((r) => (firstCreated = r));
    // Connection 1 creates Lunch and keeps its transaction open.
    const first = asOrg(c.orgId, async (tx) => {
      await createDaypart(c.admin, { storeId: c.storeA, name: 'Lunch', days: DAYS, start: '10:00', end: '15:00' }, tx);
      firstCreated();
      await gate;
    });
    await created;
    // Connection 2 asks for an overlapping Dinner while Lunch is not yet committed: it must wait on the store's lock, not slip through.
    let settled = false;
    const second = attempt(() => mk(c, c.storeA, 'Dinner', '14:00', '22:00')).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled, 'the second save did not wait for the first').toBe(false);
    release();
    await first;
    const r = await second;
    expectSentence(r, 'second of two concurrent overlapping saves');
    expect(said(r)).toContain('overlaps Lunch');
    expect(await countOf(c)).toBe(1);
  });
});
