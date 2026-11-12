import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-552 (audit P-003) - the POS server enforces a required option group's minimum. docs/tasks/552-pos-required-options-server.md.
 * Before the fix `optionDelta` returned at once for a line with no choices and only judged groups the line chose from, so a stale or replayed
 * event could leave a required group unanswered and the paid option delta dropped out of the price. Real PostgreSQL (database name contains _test).
 */
import { RefusalError } from '@shareat/db';
import { addLines, openStand } from '../../src/pos';
import { applyPosEvents } from '../../src/pos/inbox';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadStoreMenu } from '@shareat/domain';
import { asOrg, closeAll, counts, ev, fixture, linesAddedPayload, newStand, nowIso, RATES, signedIn, sql, standOpenedPayload, uuid, type Fx } from './_fixtures/t525-pos';
import { insOptionOffer } from '../../../db/tests/integration/_fixtures/t401-menu';

afterAll(closeAll);

type V = { name: string; delta: string | null }; // delta null = no store offer: the value cannot be ordered here
/** An active option group linked to an item. Returns the group id and its value ids in the order given. */
async function group(f: Fx, itemId: string, g: { name: string; mode: 'single' | 'multi'; min: number; max: number; values: V[] }) {
  const [row] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
    values (${f.orgId}, ${g.name}, ${g.mode}, ${g.min}, ${g.max}, 'active', ${f.personId}) returning id`;
  await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${f.orgId}, ${row!.id}, ${itemId}, 'active', ${f.personId})`;
  const ids: string[] = [];
  for (const [i, v] of g.values.entries()) {
    const [val] = await sql<{ id: string }[]>`
      insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${f.orgId}, ${row!.id}, ${v.name}, ${i}, 'active', ${f.personId}) returning id`;
    if (v.delta !== null) await insOptionOffer(f, val!.id, v.delta);
    ids.push(val!.id);
  }
  return { groupId: row!.id, ids };
}

/** The pork (250.00): "Size" is required (single, exactly 1), "Sauce" is optional (multi, up to 2 of 3). */
async function twoGroupPork(f: Fx) {
  const size = await group(f, f.menu.pork.itemId, { name: 'Size', mode: 'single', min: 1, max: 1, values: [{ name: 'Large', delta: '30.00' }, { name: 'Small', delta: '0.00' }] });
  const sauce = await group(f, f.menu.pork.itemId, { name: 'Sauce', mode: 'multi', min: 0, max: 2, values: [{ name: 'Sweet', delta: '5.00' }, { name: 'Spicy', delta: '7.00' }, { name: 'Garlic', delta: '9.00' }] });
  return { large: size.ids[0]!, small: size.ids[1]!, sweet: sauce.ids[0]!, spicy: sauce.ids[1]!, garlic: sauce.ids[2]! };
}

async function openSession(f: Fx) {
  const st = await newStand(f);
  const sessionId = uuid();
  await asOrg(f.orgId, (tx) => openStand(tx, f.counter, { storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: st.id, headsCashier: 2, openedAtDevice: nowIso() }));
  return sessionId;
}
const addPork = (f: Fx, sessionId: string, optionValueIds?: string[], item = f.menu.pork) =>
  asOrg(f.orgId, (tx) =>
    addLines(tx, f.counter, {
      storeId: f.storeId, pairingId: f.pairingId, sessionId,
      lines: [{ lineId: uuid(), menuItemId: item.itemId, variantId: item.variantId, qty: 2, addedAtDevice: nowIso(), ...(optionValueIds ? { optionValueIds } : {}) }],
    }),
  );
const linesOf = (sessionId: string) => sql<{ unit_price: string; name: string; qty: number }[]>`select unit_price::text, name, qty from table_session_lines where session_id = ${sessionId} order by added_at, id`;

async function expectRefusal(p: Promise<unknown>, mentions: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err, `expected a RefusalError, got ${String((err as Error)?.message)}`).toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toContain(mentions);
  expect((err as RefusalError).userMessage, 'no UUID in a sentence').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
}

describe('T-552 - a required option group must be answered (direct domain call)', () => {
  it('a required group with no optionValueIds, or an empty list, is refused and nothing is written', async () => {
    const f = await fixture();
    await twoGroupPork(f);
    const s = await openSession(f);
    await expectRefusal(addPork(f, s), 'Size');
    await expectRefusal(addPork(f, s, []), 'Size');
    expect(await linesOf(s)).toHaveLength(0);
  });

  it('choices only from ANOTHER group do not satisfy the required one', async () => {
    const f = await fixture();
    const o = await twoGroupPork(f);
    const s = await openSession(f);
    await expectRefusal(addPork(f, s, [o.sweet]), 'Size');
    await expectRefusal(addPork(f, s, [o.sweet, o.spicy]), 'Size');
    expect(await linesOf(s)).toHaveLength(0);
  });

  it('the required minimum met: accepted, and the delta is in the price (the optional group stays optional)', async () => {
    const f = await fixture();
    const o = await twoGroupPork(f);
    const s = await openSession(f);
    await addPork(f, s, [o.large]);
    await addPork(f, s, [o.large, o.sweet]);
    await addPork(f, s, [o.small]);
    expect((await linesOf(s)).map((l) => l.unit_price)).toEqual(['280.00', '285.00', '250.00']); // 250 + 30 | + 5 | + 0
  });

  it('an optional group (min 0) left out is still accepted at a zero delta', async () => {
    const f = await fixture();
    await group(f, f.menu.cola.itemId, { name: 'Ice', mode: 'multi', min: 0, max: 2, values: [{ name: 'Extra ice', delta: '5.00' }, { name: 'Lemon', delta: '8.00' }] });
    const s = await openSession(f);
    await addPork(f, s, undefined, f.menu.cola);
    await addPork(f, s, [], f.menu.cola);
    expect((await linesOf(s)).map((l) => l.unit_price)).toEqual(['80.00', '80.00']);
  });

  it('the maximum and single-mode refusals still fire', async () => {
    const f = await fixture();
    const o = await twoGroupPork(f);
    const s = await openSession(f);
    await expectRefusal(addPork(f, s, [o.large, o.small]), 'Size'); // two in a single-choice group
    await expectRefusal(addPork(f, s, [o.large, o.sweet, o.spicy, o.garlic]), 'Sauce'); // 3 > max 2
    expect(await linesOf(s)).toHaveLength(0);
  });

  it('a minimum above 1 is judged: one of a required 2 is refused, two are accepted', async () => {
    const f = await fixture();
    const g = await group(f, f.menu.cola.itemId, { name: 'Toppings', mode: 'multi', min: 2, max: 3, values: [{ name: 'Pearls', delta: '10.00' }, { name: 'Jelly', delta: '12.00' }, { name: 'Cream', delta: '15.00' }] });
    const s = await openSession(f);
    await expectRefusal(addPork(f, s, [g.ids[0]!], f.menu.cola), 'Toppings');
    await addPork(f, s, [g.ids[0]!, g.ids[1]!], f.menu.cola);
    expect((await linesOf(s)).map((l) => l.unit_price)).toEqual(['102.00']); // 80 + 10 + 12
  });

  it('DECISION: a required group with NO orderable value is refused, exactly as the screen decides (it cannot be satisfied there either)', async () => {
    const f = await fixture();
    const g = await group(f, f.menu.cola.itemId, { name: 'Cup', mode: 'single', min: 1, max: 1, values: [{ name: 'Sold out cup', delta: null }] });
    const s = await openSession(f);
    // The screen's own rule over the very menu the server reads: 0 choices is invalid, and the only value is not orderable.
    const menu = await asOrg(f.orgId, (tx) => loadStoreMenu(tx, f.orgId, f.storeId, new Date()));
    const grp = menu.menu.items.find((i) => i.id === f.menu.cola.itemId)!.variants[0]!.optionGroups.find((x) => x.id === g.groupId)!;
    expect(grp.values.some((v) => v.channels.store.orderable)).toBe(false);
    // The screen's rule (apps/erp/.../menu-filter.ts isOptionChoiceValid) is a plain count >= minSelections; a package may not import an app, so pin its source text.
    const screen = readFileSync(join(process.cwd(), 'apps/erp/src/app/pos/_orders/menu-filter.ts'), 'utf8');
    expect(screen).toContain('n >= group.minSelections');
    expect(grp.minSelections).toBe(1); // so 0 chosen is invalid on the screen
    await expectRefusal(addPork(f, s, undefined, f.menu.cola), 'Cup');
    await expectRefusal(addPork(f, s, [g.ids[0]!], f.menu.cola), 'not available'); // choosing the unorderable value is refused too
    expect(await linesOf(s)).toHaveLength(0);
  });
});

describe('T-552 - the same rule through the inbox', () => {
  it('a lines.added event that omits the required choice is quarantined and writes no line; the corrected event is applied with the delta', async () => {
    const f = await fixture();
    const o = await twoGroupPork(f);
    await signedIn(f, f.counterId);
    const sessionId = uuid();
    const withOpts = (seq: number, optionValueIds?: string[]) => {
      const p = linesAddedPayload(sessionId, [{ lineId: uuid(), item: f.menu.pork, qty: 1 }]);
      return ev(seq, 'lines.added', f.counterId, optionValueIds ? { ...p, lines: p.lines.map((l) => ({ ...l, optionValueIds })) } : p);
    };
    const r = await applyPosEvents(
      { pairing: { pairingId: f.pairingId, orgId: f.orgId, storeId: f.storeId }, events: [ev(1, 'stand.opened', f.counterId, standOpenedPayload(sessionId, f.stand7)), withOpts(2), withOpts(3, [o.sweet]), withOpts(4, [o.large])] },
      RATES,
    );
    expect(r.results.map((x) => x.status)).toEqual(['applied', 'quarantined', 'quarantined', 'applied']);
    expect(r.results[1]!.error).toMatch(/^POS_EVENT_REFUSED: .*Size/);
    expect(r.results[2]!.error).toMatch(/^POS_EVENT_REFUSED: .*Size/);
    expect((await counts(f)).lines).toBe(1);
    expect((await linesOf(sessionId)).map((l) => l.unit_price)).toEqual(['280.00']);
  });
});
