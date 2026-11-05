/**
 * T-510 S2 - the daypart writers (create, edit, retire) and the daypart-aware offer writers, against a real PostgreSQL.
 * docs/tasks/510-menu-dayparts.md R1, R3, R8, R12, and Ian's pairing ruling (5 Nov): `pair_menu_dayparts`, super admin only.
 * Every tick has a cross that fires: cashier (staff) and a manager scoped to ANOTHER store are refused the window writers; admin, manager and
 * staff are refused the pairing structure; a plain price change on an existing slot stays `set_menu_price` (manager ok).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError, type Actor } from '@shareat/auth';
import { createDaypart, retireDaypart, setMenuOffer, updateDaypart, withdrawMenuOffer } from '@shareat/domain';
import { inTxRetry } from '../../src/menu/shared';

import { asOrg, attempt, auditCount, cast, expectSentence, rawItem, rawRule, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

interface Fx {
  c: Cast;
  variantId: string;
}
async function fx(hint: string): Promise<Fx> {
  const c = await cast(hint);
  const { variantId } = await rawItem(c);
  await rawRule(c, variantId);
  return { c, variantId };
}
const spareVariant = async (f: Fx) => {
  const { variantId } = await rawItem(f.c);
  await rawRule(f.c, variantId);
  return variantId;
};

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const mk = (f: Fx, a: Actor, storeId: string, name: string, start: string, end: string, days = DAYS) =>
  asOrg(f.c.orgId, (tx) => createDaypart(a, { storeId, name, days, start, end }, tx)).then((r) => r.id);
const lunchDinner = async (f: Fx) => ({ lunch: await mk(f, f.c.admin, f.c.storeA, 'Lunch', '08:00', '17:00'), dinner: await mk(f, f.c.admin, f.c.storeA, 'Dinner', '17:00', '08:00') });

const price = (f: Fx, a: Actor, o: { variantId?: string; storeId?: string; daypartId?: string | null; amount?: string }) =>
  asOrg(f.c.orgId, (tx) =>
    setMenuOffer(a, { storeId: o.storeId ?? f.c.storeA, variantId: o.variantId ?? f.variantId, channel: 'store', amount: o.amount ?? '100.00', daypartId: o.daypartId }, tx),
  );
const withdraw = (f: Fx, a: Actor, o: { variantId?: string; daypartId?: string | null }) =>
  asOrg(f.c.orgId, (tx) => withdrawMenuOffer(a, { storeId: f.c.storeA, variantId: o.variantId ?? f.variantId, channel: 'store', daypartId: o.daypartId }, tx));

const audits = (f: Fx) =>
  sql<{ action: string; store_id: string; entity: string; entity_id: string; before: unknown; after: unknown }[]>`
    select action, store_id, entity, entity_id, before, after from audit_log where org_id = ${f.c.orgId} and action like 'menu_daypart.%' order by recorded_at, id`;
const daypartCount = async (f: Fx) => (await sql<{ n: number }[]>`select count(*)::int as n from menu_dayparts where org_id = ${f.c.orgId}`)[0]!.n;
const offerCount = async (f: Fx) => (await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where org_id = ${f.c.orgId}`)[0]!.n;
const liveAmounts = async (f: Fx, variantId = f.variantId) =>
  (
    await sql<{ amount: string | null; name: string | null }[]>`
      select o.amount::text as amount, d.name from menu_offer_in_force(${f.c.storeA}::uuid, ${variantId}::uuid, 'store', now() + interval '1 second') o
      left join menu_dayparts d on d.id = o.daypart_id where not o.withdrawn order by d.name nulls first`
  ).map((r) => `${r.name ?? 'all-day'}=${r.amount}`);

async function expectCapabilityRefused(f: Fx, run: () => Promise<unknown>, capability: string, what: string) {
  const before = { dp: await daypartCount(f), offers: await offerCount(f), audit: await auditCount(f.c.orgId) };
  const r = await attempt(run);
  expect(r.failed, `${what}: not refused`).toBe(true);
  expect(r.error, `${what}: refused, but not by authorize() (${r.message})`).toBeInstanceOf(AuthorizationError);
  expect((r.error as AuthorizationError).capability, what).toBe(capability);
  expect(await daypartCount(f), `${what}: wrote a daypart`).toBe(before.dp);
  expect(await offerCount(f), `${what}: wrote an offer`).toBe(before.offers);
  expect(await auditCount(f.c.orgId), `${what}: wrote an audit row`).toBe(before.audit);
}

describe('createDaypart', () => {
  it('writes the row (days ascending, times as HH:MM) and exactly one audit row for the store', async () => {
    const f = await fx('create');
    const id = await mk(f, f.c.manager, f.c.storeA, '  Dinner  ', '17:00', '08:00:00', [3, 1, 2]);
    const [row] = await sql<{ name: string; days: number[]; start_time: string; end_time: string; status: string; store_id: string }[]>`
      select name, days, start_time::text, end_time::text, status, store_id from menu_dayparts where id = ${id}`;
    expect(row).toMatchObject({ name: 'Dinner', days: [1, 2, 3], start_time: '17:00:00', end_time: '08:00:00', status: 'active', store_id: f.c.storeA });
    const a = await audits(f);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: 'menu_daypart.created', store_id: f.c.storeA, entity: 'menu_dayparts', entity_id: id, before: null });
    expect(a[0]!.after).toEqual({ name: 'Dinner', days: [1, 2, 3], start: '17:00', end: '08:00', status: 'active' });
  });

  it('cross: a cashier, and a manager scoped to ANOTHER store, are refused with manage_store_settings; a manager of that store may', async () => {
    const f = await fx('create-x');
    const run = (a: Actor, storeId: string) => () => mk(f, a, storeId, `X${Math.random()}`, '08:00', '17:00');
    await expectCapabilityRefused(f, run(f.c.staff, f.c.storeA), 'manage_store_settings', 'cashier');
    await expectCapabilityRefused(f, run(f.c.managerA, f.c.storeB), 'manage_store_settings', 'manager of store A at store B');
    expect((await attempt(run(f.c.managerA, f.c.storeA))).failed).toBe(false);
  });

  it('refuses a bad window in a sentence, and writes nothing', async () => {
    const f = await fx('create-bad');
    const bad: [string, number[], string, string, string][] = [
      ['no days', [], '08:00', '17:00', 'Pick'],
      ['same start and end', DAYS, '08:00', '08:00', 'Name'],
      ['not a time', DAYS, '8am', '17:00', 'Name'],
      ['day 7', [7], '08:00', '17:00', 'Name'],
      ['blank name', DAYS, '08:00', '17:00', '   '],
    ];
    for (const [what, days, start, end, name] of bad) {
      const r = await attempt(() => mk(f, f.c.admin, f.c.storeA, name, start, end, days));
      expectSentence(r, what);
    }
    expect(await daypartCount(f)).toBe(0);
    expect(await audits(f)).toHaveLength(0);
  });

  it('refuses a second ACTIVE daypart with the same name (ignoring capitals) in a sentence; a retired one frees the name', async () => {
    const f = await fx('create-dup');
    const id = await mk(f, f.c.admin, f.c.storeA, 'Lunch', '08:00', '17:00');
    expectSentence(await attempt(() => mk(f, f.c.admin, f.c.storeA, 'LUNCH', '09:00', '10:00')), 'duplicate name');
    await mk(f, f.c.admin, f.c.storeB, 'Lunch', '08:00', '17:00'); // another store: fine
    await asOrg(f.c.orgId, (tx) => retireDaypart(f.c.admin, { id }, tx));
    await mk(f, f.c.admin, f.c.storeA, 'lunch', '08:00', '17:00');
  });
});

describe('updateDaypart', () => {
  it('changes name, days and times, writes before and after in one audit row; a change of nothing writes nothing', async () => {
    const f = await fx('edit');
    const id = await mk(f, f.c.admin, f.c.storeA, 'Lunch', '08:00', '17:00');
    const r = await asOrg(f.c.orgId, (tx) => updateDaypart(f.c.manager, { id, name: 'Brunch', days: [6, 0], start: '09:00', end: '14:00' }, tx));
    expect(r).toEqual({ id, wrote: true });
    const [row] = await sql<{ name: string; days: number[]; start_time: string; end_time: string; updated_at: Date | null }[]>`
      select name, days, start_time::text, end_time::text, updated_at from menu_dayparts where id = ${id}`;
    expect(row).toMatchObject({ name: 'Brunch', days: [0, 6], start_time: '09:00:00', end_time: '14:00:00' });
    expect(row!.updated_at).not.toBeNull();
    const a = (await audits(f)).filter((x) => x.action === 'menu_daypart.edited');
    expect(a).toHaveLength(1);
    expect(a[0]!.before).toEqual({ name: 'Lunch', days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '17:00', status: 'active' });
    expect(a[0]!.after).toEqual({ name: 'Brunch', days: [0, 6], start: '09:00', end: '14:00', status: 'active' });
    const again = await asOrg(f.c.orgId, (tx) => updateDaypart(f.c.manager, { id, name: 'Brunch', days: [0, 6], start: '09:00', end: '14:00' }, tx));
    expect(again.wrote).toBe(false);
    expect((await audits(f)).filter((x) => x.action === 'menu_daypart.edited')).toHaveLength(1);
  });

  it('cross: cashier and the manager of another store are refused; a bad window and a duplicate name are sentences; a retired daypart is not edited', async () => {
    const f = await fx('edit-x');
    const idB = await mk(f, f.c.admin, f.c.storeB, 'Lunch', '08:00', '17:00');
    await expectCapabilityRefused(f, () => asOrg(f.c.orgId, (tx) => updateDaypart(f.c.staff, { id: idB, name: 'Z' }, tx)), 'manage_store_settings', 'cashier');
    await expectCapabilityRefused(f, () => asOrg(f.c.orgId, (tx) => updateDaypart(f.c.managerA, { id: idB, name: 'Z' }, tx)), 'manage_store_settings', 'manager of store A on a store B daypart');
    const id = await mk(f, f.c.admin, f.c.storeA, 'Lunch', '08:00', '17:00');
    const other = await mk(f, f.c.admin, f.c.storeA, 'Dinner', '17:00', '08:00');
    expectSentence(await attempt(() => asOrg(f.c.orgId, (tx) => updateDaypart(f.c.admin, { id, end: '08:00' }, tx))), 'end equals start');
    expectSentence(await attempt(() => asOrg(f.c.orgId, (tx) => updateDaypart(f.c.admin, { id, name: 'dinner' }, tx))), 'duplicate name');
    await asOrg(f.c.orgId, (tx) => retireDaypart(f.c.admin, { id: other }, tx));
    expectSentence(await attempt(() => asOrg(f.c.orgId, (tx) => updateDaypart(f.c.admin, { id: other, name: 'Late' }, tx))), 'retired daypart');
    expectSentence(await attempt(() => asOrg(f.c.orgId, (tx) => updateDaypart(f.c.admin, { id: '00000000-0000-7000-8000-000000000000', name: 'Z' }, tx))), 'missing daypart');
  });

  it('refuses, in a sentence, an edit that would make two live offers of one variant overlap; a harmless edit of the same daypart still goes through', async () => {
    const f = await fx('edit-overlap');
    const { lunch, dinner } = await lunchDinner(f);
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00' });
    await price(f, f.c.superAdmin, { daypartId: dinner, amount: '358.00' });
    const before = await audits(f);
    const r = await attempt(() => asOrg(f.c.orgId, (tx) => updateDaypart(f.c.admin, { id: lunch, end: '18:00' }, tx)));
    expectSentence(r, 'overlap');
    expect(r.error).toMatchObject({ userMessage: expect.stringMatching(/overlap/i) });
    expect(await audits(f)).toHaveLength(before.length);
    const [row] = await sql<{ end_time: string }[]>`select end_time::text from menu_dayparts where id = ${lunch}`;
    expect(row!.end_time).toBe('17:00:00');
    await asOrg(f.c.orgId, (tx) => updateDaypart(f.c.admin, { id: lunch, name: 'Lunch time' }, tx)); // a rename never clashes
    await asOrg(f.c.orgId, (tx) => updateDaypart(f.c.admin, { id: lunch, end: '16:00' }, tx)); // shrinking never clashes
  });
});

describe('retireDaypart', () => {
  it('retires an unused daypart with one audit row; a second retire is a no-op', async () => {
    const f = await fx('retire');
    const id = await mk(f, f.c.admin, f.c.storeA, 'Lunch', '08:00', '17:00');
    expect(await asOrg(f.c.orgId, (tx) => retireDaypart(f.c.manager, { id }, tx))).toEqual({ id, wrote: true });
    const [row] = await sql<{ status: string }[]>`select status from menu_dayparts where id = ${id}`;
    expect(row!.status).toBe('retired');
    const a = (await audits(f)).filter((x) => x.action === 'menu_daypart.retired');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ store_id: f.c.storeA, entity_id: id });
    expect(a[0]!.before).toMatchObject({ status: 'active' });
    expect(a[0]!.after).toMatchObject({ status: 'retired' });
    expect(await asOrg(f.c.orgId, (tx) => retireDaypart(f.c.manager, { id }, tx))).toEqual({ id, wrote: false });
    expect((await audits(f)).filter((x) => x.action === 'menu_daypart.retired')).toHaveLength(1);
  });

  it('cross: cashier and the manager of another store are refused', async () => {
    const f = await fx('retire-x');
    const idB = await mk(f, f.c.admin, f.c.storeB, 'Lunch', '08:00', '17:00');
    await expectCapabilityRefused(f, () => asOrg(f.c.orgId, (tx) => retireDaypart(f.c.staff, { id: idB }, tx)), 'manage_store_settings', 'cashier');
    await expectCapabilityRefused(f, () => asOrg(f.c.orgId, (tx) => retireDaypart(f.c.managerA, { id: idB }, tx)), 'manage_store_settings', 'manager of another store');
  });

  it('is refused in a sentence with the count while a live offer uses it, and goes through once the offer is withdrawn', async () => {
    const f = await fx('retire-live');
    const { lunch } = await lunchDinner(f);
    const v2 = await spareVariant(f);
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00' });
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00', variantId: v2 });
    const r = await attempt(() => asOrg(f.c.orgId, (tx) => retireDaypart(f.c.admin, { id: lunch }, tx)));
    expectSentence(r, 'retire with live offers');
    expect((r.error as { userMessage: string }).userMessage).toMatch(/2 live prices/);
    const before = await audits(f);
    await withdraw(f, f.c.superAdmin, { daypartId: lunch });
    expectSentence(await attempt(() => asOrg(f.c.orgId, (tx) => retireDaypart(f.c.admin, { id: lunch }, tx))), 'one still live');
    await withdraw(f, f.c.superAdmin, { daypartId: lunch, variantId: v2 });
    expect((await asOrg(f.c.orgId, (tx) => retireDaypart(f.c.admin, { id: lunch }, tx))).wrote).toBe(true);
    expect(await audits(f)).toHaveLength(before.length + 1);
  });
});

describe('setMenuOffer / withdrawMenuOffer with a daypart', () => {
  it('lunch 338 and dinner 358 on one variant are both live; a package with one price all day is one all-day offer', async () => {
    const f = await fx('offers');
    const { lunch, dinner } = await lunchDinner(f);
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00' });
    await price(f, f.c.superAdmin, { daypartId: dinner, amount: '358.00' });
    expect(await liveAmounts(f)).toEqual(['Dinner=358.00', 'Lunch=338.00']);
    const porkChicken = await spareVariant(f);
    await price(f, f.c.manager, { variantId: porkChicken, amount: '298.00' }); // no daypart: manager, exactly as before
    expect(await liveAmounts(f, porkChicken)).toEqual(['all-day=298.00']);
    const [o] = await sql<{ daypart_id: string | null }[]>`select daypart_id from menu_offers where variant_id = ${porkChicken}`;
    expect(o!.daypart_id).toBeNull();
  });

  it('refuses in a sentence, before the database does: a live all-day offer next to a dayparted one, and the reverse', async () => {
    const f = await fx('mixed');
    const { lunch } = await lunchDinner(f);
    const v2 = await spareVariant(f);
    await price(f, f.c.manager, { amount: '300.00' }); // all-day on variant 1
    await price(f, f.c.superAdmin, { variantId: v2, daypartId: lunch, amount: '338.00' }); // dayparted on variant 2
    const n = await offerCount(f);
    const a = await attempt(() => price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00' }));
    expectSentence(a, 'dayparted beside all-day');
    expect((a.error as { userMessage: string }).userMessage).toMatch(/all-day price/i);
    const b = await attempt(() => price(f, f.c.superAdmin, { variantId: v2, daypartId: null, amount: '300.00' }));
    expectSentence(b, 'all-day beside dayparted');
    expect((b.error as { userMessage: string }).userMessage).toMatch(/time of day/i);
    expect(await offerCount(f)).toBe(n);
  });

  it('refuses in a sentence an offer whose daypart overlaps another live daypart of the variant', async () => {
    const f = await fx('overlap');
    const { lunch } = await lunchDinner(f);
    const brunch = await mk(f, f.c.admin, f.c.storeA, 'Brunch', '10:00', '12:00');
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00' });
    const r = await attempt(() => price(f, f.c.superAdmin, { daypartId: brunch, amount: '350.00' }));
    expectSentence(r, 'overlap');
    expect((r.error as { userMessage: string }).userMessage).toMatch(/hours/);
  });

  it('refuses in a sentence a daypart that does not exist, is retired (set only), or belongs to another store', async () => {
    const f = await fx('daypart-checks');
    const other = await mk(f, f.c.admin, f.c.storeB, 'Lunch', '08:00', '17:00');
    const retired = await mk(f, f.c.admin, f.c.storeA, 'Old', '08:00', '17:00');
    await asOrg(f.c.orgId, (tx) => retireDaypart(f.c.admin, { id: retired }, tx));
    const n = await offerCount(f);
    expectSentence(await attempt(() => price(f, f.c.superAdmin, { daypartId: other })), 'other store');
    expectSentence(await attempt(() => price(f, f.c.superAdmin, { daypartId: retired })), 'retired');
    expectSentence(await attempt(() => price(f, f.c.superAdmin, { daypartId: '00000000-0000-7000-8000-000000000000' })), 'missing');
    expectSentence(await attempt(() => withdraw(f, f.c.superAdmin, { daypartId: other })), 'withdraw, other store');
    expect(await offerCount(f)).toBe(n);
  });

  it('a variant with no dayparts behaves as before (set, re-set, withdraw: three all-day rows)', async () => {
    const f = await fx('plain');
    await price(f, f.c.manager, { amount: '120.00' });
    await price(f, f.c.manager, { amount: '130.00' });
    await withdraw(f, f.c.manager, {});
    expect(await liveAmounts(f)).toEqual([]);
    const [r] = await sql<{ n: number }[]>`select count(*)::int as n from menu_offers where variant_id = ${f.variantId} and daypart_id is null`;
    expect(r!.n).toBe(3);
  });
});

describe('pair_menu_dayparts: the pairing structure is super admin only; a plain re-price is not', () => {
  async function paired(hint: string) {
    const f = await fx(hint);
    const { lunch, dinner } = await lunchDinner(f);
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00' });
    await price(f, f.c.superAdmin, { daypartId: dinner, amount: '358.00' });
    return { f, lunch, dinner };
  }

  it('a manager re-prices an EXISTING dayparted slot (and a manager of the store only, not another store)', async () => {
    const { f, lunch } = await paired('pair-reprice');
    await price(f, f.c.manager, { daypartId: lunch, amount: '348.00' });
    await price(f, f.c.managerA, { daypartId: lunch, amount: '349.00' });
    expect(await liveAmounts(f)).toEqual(['Dinner=358.00', 'Lunch=349.00']);
    await expectCapabilityRefused(f, () => price(f, f.c.managerA, { storeId: f.c.storeB, daypartId: lunch, amount: '1.00' }), 'set_menu_price', 'manager of A pricing store B');
  });

  it('a manager is refused (authorize, capability pair_menu_dayparts) on every change of structure; nothing is written', async () => {
    const { f, lunch, dinner } = await paired('pair-manager');
    const brunch = await mk(f, f.c.admin, f.c.storeA, 'Late', '23:00', '23:30'); // inside Dinner: overlap is not what is tested here, authority comes first
    const v2 = await spareVariant(f);
    await expectCapabilityRefused(f, () => price(f, f.c.manager, { variantId: v2, daypartId: lunch, amount: '1.00' }), 'pair_menu_dayparts', 'manager creating a pairing');
    await expectCapabilityRefused(f, () => price(f, f.c.manager, { daypartId: brunch, amount: '1.00' }), 'pair_menu_dayparts', 'manager pairing a new daypart');
    await expectCapabilityRefused(f, () => price(f, f.c.manager, { daypartId: null, amount: '1.00' }), 'pair_menu_dayparts', 'manager switching to all-day');
    await expectCapabilityRefused(f, () => withdraw(f, f.c.manager, { daypartId: dinner }), 'pair_menu_dayparts', 'manager withdrawing a pairing');
    await expectCapabilityRefused(f, () => withdraw(f, f.c.manager, {}), 'pair_menu_dayparts', 'manager withdrawing all-day of a dayparted variant');
    const r = await attempt(() => price(f, f.c.manager, { variantId: v2, daypartId: lunch, amount: '1.00' }));
    expect((r.error as { userMessage?: string }).userMessage, 'a sentence, not a raw database error').toEqual(expect.any(String));
  });

  it('admin and cashier are refused the structure too, and the cashier is refused even a plain price (set_menu_price)', async () => {
    const { f, lunch } = await paired('pair-admin');
    const v2 = await spareVariant(f);
    await expectCapabilityRefused(f, () => price(f, f.c.admin, { variantId: v2, daypartId: lunch, amount: '1.00' }), 'pair_menu_dayparts', 'admin creating a pairing');
    await expectCapabilityRefused(f, () => withdraw(f, f.c.admin, { daypartId: lunch }), 'pair_menu_dayparts', 'admin withdrawing a pairing');
    await expectCapabilityRefused(f, () => price(f, f.c.staff, { variantId: v2, daypartId: lunch, amount: '1.00' }), 'set_menu_price', 'cashier');
    // admin keeps the plain re-price
    await price(f, f.c.admin, { daypartId: lunch, amount: '340.00' });
  });

  it('a manager may still price and withdraw a variant that has no dayparts (byte-identical to today)', async () => {
    const f = await fx('pair-plain');
    await price(f, f.c.manager, { amount: '100.00' });
    await price(f, f.c.manager, { amount: '110.00' });
    await withdraw(f, f.c.manager, {});
    await price(f, f.c.manager, { amount: '120.00' });
    expect(await liveAmounts(f)).toEqual(['all-day=120.00']);
  });

  it('super admin does all of it: create, re-price, withdraw, and re-link a package from dayparts to all-day and back', async () => {
    const { f, lunch, dinner } = await paired('pair-super');
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '345.00' });
    await withdraw(f, f.c.superAdmin, { daypartId: lunch });
    await withdraw(f, f.c.superAdmin, { daypartId: dinner });
    expect(await liveAmounts(f)).toEqual([]);
    await price(f, f.c.superAdmin, { daypartId: null, amount: '298.00' }); // to all-day
    expect(await liveAmounts(f)).toEqual(['all-day=298.00']);
    await withdraw(f, f.c.superAdmin, { daypartId: null });
    await price(f, f.c.superAdmin, { daypartId: lunch, amount: '338.00' }); // and back
    expect(await liveAmounts(f)).toEqual(['Lunch=338.00']);
  });
});

describe('deadlock retry (40P01)', () => {
  const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

  it('runs the WHOLE transaction twice when the first run deadlocks: the first run is rolled back, the second commits one row and one audit row', async () => {
    const f = await fx('retry');
    let runs = 0;
    const r = await inTxRetry(undefined, f.c.orgId, async (trx) => {
      runs++;
      const out = await createDaypart(f.c.admin, { storeId: f.c.storeA, name: 'Lunch', days: DAYS, start: '08:00', end: '17:00' }, trx);
      if (runs === 1) throw deadlock(); // after the write: proves the rollback, or the second run would hit the duplicate name
      return out;
    });
    expect(runs).toBe(2);
    expect(await daypartCount(f)).toBe(1);
    expect(await audits(f)).toHaveLength(1);
    expect(r.id).toEqual(expect.any(String));
  });

  it('retries ONCE: a second deadlock propagates; any other error is not retried', async () => {
    const f = await fx('retry-once');
    let runs = 0;
    await expect(
      inTxRetry(undefined, f.c.orgId, async () => {
        runs++;
        throw deadlock();
      }),
    ).rejects.toMatchObject({ code: '40P01' });
    expect(runs).toBe(2);
    runs = 0;
    await expect(
      inTxRetry(undefined, f.c.orgId, async () => {
        runs++;
        throw Object.assign(new Error('x'), { code: '23505' });
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(runs).toBe(1);
  });

  it('the writers own their transaction when none is handed in (createDaypart / setMenuOffer without tx work, and commit)', async () => {
    const f = await fx('own-tx');
    const made = await createDaypart(f.c.admin, { storeId: f.c.storeA, name: 'Lunch', days: DAYS, start: '08:00', end: '17:00' });
    const o = await setMenuOffer(f.c.superAdmin, { storeId: f.c.storeA, variantId: f.variantId, channel: 'store', amount: '338.00', daypartId: made.id });
    expect(o.id).toEqual(expect.any(String));
    expect(await liveAmounts(f)).toEqual(['Lunch=338.00']);
  });
});
