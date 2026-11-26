import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-643 - flavours chosen at seating. docs/tasks/643-seating-flavours.md.
 * A "Flavours" option group on a PACKAGE (multi, min 1, max 3, 0.00) makes `openStand` demand 1 to 3 flavours (data, not code: `optionDelta` is unchanged), and the
 * refill table source (`listRefillableTables`) carries the names chosen as `seatFlavours`. Real PostgreSQL (database name contains _test).
 * MUTANTS: test 1 goes red if `optionDelta` loses its required-group loop (0 accepted) or `n > group.maxSelections` (4 accepted); test 2 goes red if the repo's
 * `seatFlavours` select is removed or the domain stops merging it; test 3 goes red if the merge loop over a table's later package lines is dropped or the de-dupe is dropped;
 * test 2 (menu order) also goes red if `order by sort_order` leaves the repo's `array_agg`; test 4 goes red if the repo's `kitchen_status <> 'cancelled'` join filter is dropped.
 */
import { RefusalError } from '@shareat/db';
import { listRefillableTables, openStand } from '../../src/pos';
import { insOptionOffer } from '../../../db/tests/integration/_fixtures/t401-menu';
import { asOrg, closeAll, fixture, makeServer0240, newStand, nowIso, sql, uuid, type Fx } from './_fixtures/t525-pos';

afterAll(closeAll);

/** A multi 1..3 "Flavours" group on the Unli package item, four values at 0.00 (Spicy, Garlic, Sweet, Plain); `sortOrders` are their menu positions (default 0..3 = insertion order). */
async function seatingFlavours(f: Fx, sortOrders: number[] = [0, 1, 2, 3]) {
  const [row] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
    values (${f.orgId}, 'Flavours', 'multi', 1, 3, 'active', ${f.personId}) returning id`;
  await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${f.orgId}, ${row!.id}, ${f.menu.unli.itemId}, 'active', ${f.personId})`;
  const ids: string[] = [];
  for (const [i, name] of ['Spicy', 'Garlic', 'Sweet', 'Plain'].entries()) {
    const sortOrder = sortOrders[i]!;
    const [v] = await sql<{ id: string }[]>`
      insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${f.orgId}, ${row!.id}, ${name}, ${sortOrder}, 'active', ${f.personId}) returning id`;
    await insOptionOffer(f, v!.id, '0.00');
    ids.push(v!.id);
  }
  // Offers start at the DB's now() and may not be back-dated, but the seating line is stamped by this process's clock (nowIso): wait until that clock has passed them,
  // or a seating right after setup reads the menu "before" the flavours exist and is refused "option not on the item".
  const [last] = await sql<{ at: Date }[]>`select max(effective_from) as at from menu_option_offers where org_id = ${f.orgId}`;
  while (Date.now() <= last!.at.getTime()) await new Promise((r) => setTimeout(r, 5));
  return ids;
}

/** One table, one package line per entry of `picks` (each pick = that line's flavour ids, or undefined for none). Returns the session id. */
const seatLines = async (f: Fx, picks: (string[] | undefined)[]) => {
  const stand = await newStand(f);
  const sessionId = uuid();
  await asOrg(f.orgId, (tx) =>
    openStand(tx, f.counter, {
      storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso(),
      lines: picks.map((optionValueIds) => ({ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 2, addedAtDevice: nowIso(), ...(optionValueIds ? { optionValueIds } : {}) })),
    }),
  );
  return sessionId;
};
const seat = (f: Fx, optionValueIds?: string[]) => seatLines(f, [optionValueIds]);
const sessionCount = async (sessionId: string) => (await sql<{ n: number }[]>`select count(*)::int as n from table_sessions where id = ${sessionId}`)[0]!.n;
const stored = (sessionId: string) => sql<{ ids: string[] | null; name: string }[]>`select option_value_ids as ids, name from table_session_lines where session_id = ${sessionId}`;

async function refused(f: Fx, ids?: string[]) {
  const sessionId = uuid();
  const stand = await newStand(f);
  const err = await asOrg(f.orgId, (tx) =>
    openStand(tx, f.counter, {
      storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso(),
      lines: [{ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 2, addedAtDevice: nowIso(), ...(ids ? { optionValueIds: ids } : {}) }],
    }),
  ).then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').toBeInstanceOf(RefusalError);
  expect((err as RefusalError).userMessage).toContain('Flavours');
  expect(await sessionCount(sessionId), 'the refused seating wrote nothing').toBe(0);
}

describe('T-643 test 1 - seating a package with a Flavours group (min 1, max 3)', () => {
  it('0 flavours is refused, 4 is refused; 1, 2 and 3 are accepted and stored on option_value_ids', async () => {
    const f = await fixture();
    const v = await seatingFlavours(f);
    await refused(f); // no list at all
    await refused(f, []);
    await refused(f, v); // four
    for (const n of [1, 2, 3]) {
      const s = await seat(f, v.slice(0, n));
      const [line] = await stored(s);
      expect(line!.ids).toEqual(v.slice(0, n).sort()); // the server stores the ids sorted (T-557)
    }
  });

  it('the line name carries the flavours (this is what the KDS card shows)', async () => {
    const f = await fixture();
    const v = await seatingFlavours(f);
    const [line] = await stored(await seat(f, [v[0]!, v[1]!]));
    expect(line!.name).toMatch(/ \+ Spicy, Garlic$/);
  });
});

describe('T-643 test 2 - listRefillableTables carries seatFlavours', () => {
  const read = (f: Fx) => makeServer0240(f).then((server) => asOrg(f.orgId, (tx) => listRefillableTables(tx, server, { storeId: f.storeId })));

  it('the names chosen at seating, in menu (sort_order) order; [] when the package has no flavour group', async () => {
    const f = await fixture();
    const plain = await seat(f); // no group yet: seats with no options
    // sort_order is reversed against insertion order: menu = Garlic(0) Sweet(1) Spicy(2); insertion = Spicy Garlic Sweet; name = Garlic Spicy Sweet; tap = Sweet Spicy Garlic.
    // So the expected list differs from all three other orders: dropping `order by sort_order` from the repo goes red.
    const v = await seatingFlavours(f, [2, 0, 1, 3]);
    const flavoured = await seat(f, [v[2]!, v[0]!, v[1]!]);
    const out = await read(f);
    expect(out.tables.find((t) => t.sessionId === plain)!.seatFlavours).toEqual([]);
    expect(out.tables.find((t) => t.sessionId === flavoured)!.seatFlavours).toEqual(['Garlic', 'Sweet', 'Spicy']);
  });
});

describe('T-643 test 3 - a table with several package lines', () => {
  const read = (f: Fx) => makeServer0240(f).then((server) => asOrg(f.orgId, (tx) => listRefillableTables(tx, server, { storeId: f.storeId })));

  it('merges the flavours of every package line into one list, each flavour once (one table row)', async () => {
    const f = await fixture();
    const v = await seatingFlavours(f); // Spicy Garlic Sweet Plain
    // Line A: Spicy + Garlic. Line B: Garlic + Sweet. Garlic is on both lines. Only the first line is read if the loop over later lines is dropped (no Sweet);
    // without the de-dupe Garlic is listed twice. (Case/space-insensitive de-dupe cannot be set up here: a group's value names are unique ignoring case.)
    const s = await seatLines(f, [[v[0]!, v[1]!], [v[1]!, v[2]!]]);
    expect((await stored(s)).length, 'two package lines on the table').toBe(2);
    const rows = (await read(f)).tables.filter((t) => t.sessionId === s);
    expect(rows.length).toBe(1);
    expect(rows[0]!.seatFlavours).toEqual(['Spicy', 'Garlic', 'Sweet']);
  });
});

describe('T-643 test 4 - a cancelled package line', () => {
  const read = (f: Fx) => makeServer0240(f).then((server) => asOrg(f.orgId, (tx) => listRefillableTables(tx, server, { storeId: f.storeId })));

  it('contributes no flavours; a table whose only package line is cancelled has no refill row', async () => {
    const f = await fixture();
    const v = await seatingFlavours(f);
    const both = await seatLines(f, [[v[0]!], [v[2]!]]); // Spicy | Sweet
    const only = await seat(f, [v[1]!]); // Garlic
    const cancel = (sessionId: string, name: string) =>
      sql`update table_session_lines set kitchen_status = 'cancelled' where session_id = ${sessionId} and name like ${'%' + name}`;
    await cancel(both, 'Sweet');
    await cancel(only, 'Garlic');
    const out = await read(f);
    expect(out.tables.find((t) => t.sessionId === both)!.seatFlavours).toEqual(['Spicy']);
    expect(out.tables.find((t) => t.sessionId === only), 'no live package line, no row').toBeUndefined();
  });
});
