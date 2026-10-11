import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * T-390 S5 (TESTER) - the cutover server actions pass ROOM and PARTY through and a domain refusal reaches the flash as the domain's
 * sentence. `docs/tasks/390-opening-stock-and-subledger-tieout.md` s5.4, s8 row 22 (kills M26: party dropped in the action), DEF-630.
 *
 * CONTRACT PINNED HERE (the spec is silent; the builder matches):
 *  - recordCountAction reads `locationId` (the room); blank = the store's default room (the domain's rule, unchanged). After a
 *    refusal the redirect carries the nav key `room` so the user stays in the room he was counting (needs `room: UUID` in
 *    `lib/flash.ts` NAV_SHAPES, a file the spec's builder list does not name: see the report).
 *  - addOpeningFigureAction reads `partyType` and `partyId` (R12) and hands both to addOpeningFigure.
 *  - NEW `valueOpeningStockAction(formData{storeId})` and `valueOpeningAssetAction(formData{assetId, bookValue, remainingLifeMonths,
 *    salvageValue})`, both redirecting to /cutover/opening; `remainingLifeMonths` arrives as TEXT and the action makes it a number
 *    (a fraction must reach the domain as a fraction so the domain refuses it in words, not be truncated by parseInt).
 *  - every refusal is `redirectWithFlash(path, nav, { error: <the domain's userMessage> })`.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../../apps/erp/tests/helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../apps/erp/src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { captureRedirect, outcomeOf, resetJar } from '../../apps/erp/tests/helpers/flash-jar';
import { testItemCode } from '../../packages/domain/tests/integration/_fixtures/item-code';
import { asOrg, CONVERSION, domain, fixture, mkShell, mkSupplier, sql, uid } from './t390-s3-common';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const actionsModule = () => import('../../apps/erp/src/app/cutover/actions');

async function run(name: string, fields: Record<string, string>, who: { personId: string; orgId: string }) {
  const mod = (await actionsModule()) as Record<string, unknown>;
  const act = mod[name];
  if (typeof act !== 'function') throw new Error(`MISSING EXPORT: apps/erp/src/app/cutover/actions.ts does not export ${name} (T-390 S5 has not been built).`);
  resetJar();
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const signal = await captureRedirect(() => (act as (f: FormData) => Promise<void>)(fd));
  return outcomeOf(signal);
}

/** The s3 fixture (two stores, one default room each) plus a second room "Freezer" at store A and one raw item. */
async function setup(hint: string) {
  const f = await fixture(hint);
  const [lt] = await sql<{ id: string }[]>`select id from location_types where org_id = ${f.orgId} limit 1`;
  const [frz] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, status, created_by)
    values (${f.orgId}, ${f.storeA}, 'FRZ', 'Freezer', ${lt!.id}, 'operating', false, 'active', ${f.adminId}) returning id`;
  const mkItem = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, ${`${name} ${uid('i')}`}, 'raw_material', 'kg', ${f.adminId}) returning id`)[0]!.id;
  return { f, kit: f.roomA, frz: frz!.id, item: await mkItem('Pork'), item2: await mkItem('Chicken') };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const rows = (s: Setup, item = s.item) =>
  sql<{ location_id: string; quantity: string; unit_cost: string | null; cost_source: string | null }[]>`
    select location_id, quantity::text, unit_cost::text, cost_source from opening_counts
    where org_id = ${s.f.orgId} and store_id = ${s.f.storeA} and item_id = ${item} order by quantity`;
const qtyIn = async (s: Setup, room: string, item = s.item) =>
  Number((await rows(s, item)).find((r) => r.location_id === room)?.quantity ?? NaN);

describe('recordCountAction passes the ROOM through (DEF-630 starts here: the action ignores it today)', () => {
  it('a count with locationId lands in THAT room, not in the default room', async () => {
    const s = await setup('rc-room');
    const o = await run('recordCountAction', { storeId: s.f.storeA, locationId: s.frz, itemId: s.item, quantity: '4' }, s.f.admin);
    expect(o.flash.error, 'a good count').toBeUndefined();
    const got = await rows(s);
    expect(got.map((r) => r.location_id), 'one row, in the Freezer').toEqual([s.frz]);
  });

  it('the same item counted in two rooms is two rows; EDITING Kitchen leaves Freezer alone (no double count)', async () => {
    const s = await setup('rc-two');
    await run('recordCountAction', { storeId: s.f.storeA, locationId: s.kit, itemId: s.item, quantity: '7' }, s.f.admin);
    await run('recordCountAction', { storeId: s.f.storeA, locationId: s.frz, itemId: s.item, quantity: '6' }, s.f.admin);
    expect(await qtyIn(s, s.kit)).toBe(7);
    expect(await qtyIn(s, s.frz)).toBe(6);
    await run('recordCountAction', { storeId: s.f.storeA, locationId: s.kit, itemId: s.item, quantity: '9' }, s.f.admin);
    expect(await qtyIn(s, s.kit), 'Kitchen was edited').toBe(9);
    expect(await qtyIn(s, s.frz), 'Freezer is untouched by a Kitchen edit').toBe(6);
    expect((await rows(s)).reduce((n, r) => n + Number(r.quantity), 0), 'no room total was written back into a room').toBe(15);
  });

  it('no locationId = the default room (the old behaviour is kept for a form that has no room)', async () => {
    const s = await setup('rc-default');
    await run('recordCountAction', { storeId: s.f.storeA, itemId: s.item, quantity: '3' }, s.f.admin);
    expect(await qtyIn(s, s.kit)).toBe(3);
  });

  it('a typed cost is sourced "typed" and, per R3, sets the cost on every room row of the item', async () => {
    const s = await setup('rc-cost');
    await run('recordCountAction', { storeId: s.f.storeA, locationId: s.kit, itemId: s.item, quantity: '2' }, s.f.admin);
    await run('recordCountAction', { storeId: s.f.storeA, locationId: s.frz, itemId: s.item, quantity: '1', unitCost: '12.5' }, s.f.admin);
    expect(await rows(s), 'one row per room').toHaveLength(2);
    for (const r of await rows(s)) {
      expect(Number(r.unit_cost), 'the cost reaches both rooms').toBe(12.5);
      expect(r.cost_source).toBe('typed');
    }
  });

  it('a refusal in a room reaches the flash as the domain sentence, and the redirect stays in that room', async () => {
    const s = await setup('rc-refuse');
    const o = await run('recordCountAction', { storeId: s.f.storeA, locationId: s.frz, itemId: s.item, quantity: '-1' }, s.f.admin);
    expect(o.flash.error).toBe('A count cannot be negative.');
    expect(o.path).toBe('/cutover/count');
    expect(o.nav.get('store')).toBe(s.f.storeA);
    expect(o.nav.get('room'), 'the room rides the redirect so the page reopens the same room').toBe(s.frz);
    expect(await rows(s)).toHaveLength(0);
  });

  it("a room of ANOTHER store is refused in words (the room must reach the domain; the default room would have accepted it)", async () => {
    const s = await setup('rc-foreign');
    const o = await run('recordCountAction', { storeId: s.f.storeA, locationId: s.f.roomB, itemId: s.item, quantity: '5' }, s.f.admin);
    expect(o.flash.error).toMatch(/does not belong to this store/i);
    expect(await rows(s)).toHaveLength(0);
  });
});

describe('addOpeningFigureAction passes the PARTY through (R12, M26)', () => {
  it('a 2110 figure with partyType supplier + partyId lands on that supplier', async () => {
    const s = await setup('fig-party');
    const sup = await mkSupplier(s.f, 'Meat Supplier');
    const o = await run('addOpeningFigureAction', {
      accountCode: '2110', storeId: s.f.storeA, direction: 'credit', amount: '1500.00', entryDate: CONVERSION,
      partyType: 'supplier', partyId: sup.id,
    }, s.f.admin);
    expect(o.flash.error, 'a good figure').toBeUndefined();
    const lines = await sql<{ party_type: string | null; party_id: string | null }[]>`
      select jl.party_type, jl.party_id from journal_lines jl
      join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${s.f.orgId} and je.source_type = 'opening_balance' and a.code = '2110'`;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.party_type).toBe('supplier');
    expect(lines[0]!.party_id, 'the party reached the draft line').toBe(sup.id);
  });

  it('two suppliers on 2110 at one store are TWO figures (the party is part of the figure)', async () => {
    const s = await setup('fig-two');
    const a = await mkSupplier(s.f, 'Alpha');
    const b = await mkSupplier(s.f, 'Beta');
    for (const [sup, amt] of [[a, '100.00'], [b, '250.00']] as const) {
      await run('addOpeningFigureAction', {
        accountCode: '2110', storeId: s.f.storeA, direction: 'credit', amount: amt, entryDate: CONVERSION, partyType: 'supplier', partyId: sup.id,
      }, s.f.admin);
    }
    const [n] = await sql<{ n: number }[]>`
      select count(distinct jl.party_id)::int n from journal_lines jl
      join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${s.f.orgId} and je.source_type = 'opening_balance' and a.code = '2110'`;
    expect(n!.n).toBe(2);
  });
});

describe('valueOpeningStockAction calls valueOpeningStock; a refusal reaches the flash in words', () => {
  it('a costed count is valued: the store gets one 1310 draft and the redirect goes back to /cutover/opening', async () => {
    const s = await setup('vs-ok');
    await asOrg(s.f.orgId, (tx) =>
      domain.recordOpeningCount(tx, s.f.admin, { storeId: s.f.storeA, locationId: s.kit, itemId: s.item, quantity: '10', unitCost: '12.5', costSource: 'typed' } as never),
    );
    const o = await run('valueOpeningStockAction', { storeId: s.f.storeA }, s.f.admin);
    expect(o.flash.error, 'valued').toBeUndefined();
    expect(o.path).toBe('/cutover/opening');
    const [e] = await sql<{ amount: string }[]>`
      select sum(jl.debit)::text amount from journal_lines jl
      join journal_entries je on je.id = jl.entry_id join accounts a on a.id = jl.account_id
      where je.org_id = ${s.f.orgId} and je.idempotency_key = ${`opening-stock:${s.f.orgId}:${s.f.storeA}`} and a.code = '1310'`;
    expect(Number(e?.amount), '10 x 12.50').toBe(125);
  });

  it('an uncosted count is refused: the domain sentence (names the item) is the flash, and no draft is written', async () => {
    const s = await setup('vs-nocost');
    await asOrg(s.f.orgId, (tx) =>
      domain.recordOpeningCount(tx, s.f.admin, { storeId: s.f.storeA, locationId: s.kit, itemId: s.item, quantity: '10' } as never),
    );
    const o = await run('valueOpeningStockAction', { storeId: s.f.storeA }, s.f.admin);
    expect(o.flash.error).toMatch(/1 counted item at .* has no cost: Pork/);
    expect(o.flash.error, 'in words, never a constraint name').not.toMatch(/violates|constraint|_check/i);
    const [n] = await sql<{ n: number }[]>`select count(*)::int n from journal_entries where org_id = ${s.f.orgId} and idempotency_key like 'opening-stock:%'`;
    expect(n!.n).toBe(0);
  });

  it('staff are refused (run_cutover) and the refusal is a flash, not a thrown error', async () => {
    const s = await setup('vs-staff');
    const o = await run('valueOpeningStockAction', { storeId: s.f.storeA }, s.f.staff);
    expect(o.flash.error, 'a sentence').toBeTruthy();
    expect(o.path).toBe('/cutover/opening');
  });
});

describe('valueOpeningAssetAction calls valueOpeningAsset; a refusal reaches the flash in words', () => {
  const fields = (assetId: string, over: Record<string, string> = {}) => ({
    assetId, bookValue: '7500.00', remainingLifeMonths: '18', salvageValue: '500.00', ...over,
  });
  const assetRow = async (id: string) =>
    (await sql<{ status: string; cost: string | null; useful_life_months: number | null; acquired_on: string | null }[]>`
      select status, cost::text, useful_life_months, acquired_on::text from fixed_assets where id = ${id}`)[0]!;

  it('values a pending shell: active, book value as cost, remaining life, acquired on the conversion date', async () => {
    const s = await setup('va-ok');
    const shell = await mkShell(s.f, s.f.storeA);
    const o = await run('valueOpeningAssetAction', fields(shell.id), s.f.admin);
    expect(o.flash.error, 'valued').toBeUndefined();
    expect(o.path).toBe('/cutover/opening');
    const r = await assetRow(shell.id);
    expect(r.status).toBe('active');
    expect(Number(r.cost)).toBe(7500);
    expect(r.useful_life_months, 'the TEXT life became the number 18').toBe(18);
    expect(r.acquired_on).toBe(CONVERSION);
  });

  it('a zero book value is refused in the domain sentence and the shell stays pending', async () => {
    const s = await setup('va-zero');
    const shell = await mkShell(s.f, s.f.storeA);
    const o = await run('valueOpeningAssetAction', fields(shell.id, { bookValue: '0' }), s.f.admin);
    expect(o.flash.error).toMatch(/book value has to be greater than zero/i);
    expect((await assetRow(shell.id)).status).toBe('pending_valuation');
  });

  it('a fractional life reaches the domain as a fraction (refused as "whole number"), it is not truncated to 12', async () => {
    const s = await setup('va-frac');
    const shell = await mkShell(s.f, s.f.storeA);
    const o = await run('valueOpeningAssetAction', fields(shell.id, { remainingLifeMonths: '12.5' }), s.f.admin);
    expect(o.flash.error).toMatch(/whole number of months/i);
    expect((await assetRow(shell.id)).status).toBe('pending_valuation');
  });

  it('a blank salvage is allowed (zero) and a salvage at or above the book value is refused in words', async () => {
    const s = await setup('va-salv');
    const a = await mkShell(s.f, s.f.storeA);
    const b = await mkShell(s.f, s.f.storeA);
    expect((await run('valueOpeningAssetAction', fields(a.id, { salvageValue: '' }), s.f.admin)).flash.error).toBeUndefined();
    const o = await run('valueOpeningAssetAction', fields(b.id, { salvageValue: '7500.00' }), s.f.admin);
    expect(o.flash.error).toMatch(/salvage value has to be less than the book value/i);
  });
});
