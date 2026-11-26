import { afterAll, describe, expect, it } from 'vitest';

/**
 * T-643 - flavours chosen at seating. docs/tasks/643-seating-flavours.md.
 * A "Flavours" option group on a PACKAGE (multi, min 1, max 3, 0.00) makes `openStand` demand 1 to 3 flavours (data, not code: `optionDelta` is unchanged), and the
 * refill table source (`listRefillableTables`) carries the names chosen as `seatFlavours`. Real PostgreSQL (database name contains _test).
 * MUTANTS: test 1 goes red if `optionDelta` loses its required-group loop (0 accepted) or `n > group.maxSelections` (4 accepted); test 2 goes red if the repo's
 * `seatFlavours` select is removed or the domain stops merging it.
 */
import { RefusalError } from '@shareat/db';
import { listRefillableTables, openStand } from '../../src/pos';
import { insOptionOffer } from '../../../db/tests/integration/_fixtures/t401-menu';
import { asOrg, closeAll, fixture, makeServer0240, newStand, nowIso, sql, uuid, type Fx } from './_fixtures/t525-pos';

afterAll(closeAll);

/** A multi 1..3 "Flavours" group on the Unli package item, four values at 0.00, in the order given. */
async function seatingFlavours(f: Fx) {
  const [row] = await sql<{ id: string }[]>`
    insert into menu_option_groups (org_id, name, selection_mode, min_selections, max_selections, status, created_by)
    values (${f.orgId}, 'Flavours', 'multi', 1, 3, 'active', ${f.personId}) returning id`;
  await sql`insert into menu_option_group_links (org_id, option_group_id, menu_item_id, status, created_by) values (${f.orgId}, ${row!.id}, ${f.menu.unli.itemId}, 'active', ${f.personId})`;
  const ids: string[] = [];
  for (const [i, name] of ['Spicy', 'Garlic', 'Sweet', 'Plain'].entries()) {
    const [v] = await sql<{ id: string }[]>`
      insert into menu_option_values (org_id, option_group_id, name, sort_order, status, created_by) values (${f.orgId}, ${row!.id}, ${name}, ${i}, 'active', ${f.personId}) returning id`;
    await insOptionOffer(f, v!.id, '0.00');
    ids.push(v!.id);
  }
  return ids;
}

const seat = async (f: Fx, optionValueIds?: string[]) => {
  const stand = await newStand(f);
  const sessionId = uuid();
  await asOrg(f.orgId, (tx) =>
    openStand(tx, f.counter, {
      storeId: f.storeId, pairingId: f.pairingId, sessionId, mode: 'dine_in', standId: stand.id, headsCashier: 2, openedAtDevice: nowIso(),
      lines: [{ lineId: uuid(), menuItemId: f.menu.unli.itemId, variantId: f.menu.unli.variantId, qty: 2, addedAtDevice: nowIso(), ...(optionValueIds ? { optionValueIds } : {}) }],
    }),
  );
  return sessionId;
};
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

  it('the names chosen at seating, in menu order (not tap order); [] when the package has no flavour group', async () => {
    const f = await fixture();
    const plain = await seat(f); // no group yet: seats with no options
    const v = await seatingFlavours(f);
    const flavoured = await seat(f, [v[1]!, v[0]!]);
    const out = await read(f);
    expect(out.tables.find((t) => t.sessionId === plain)!.seatFlavours).toEqual([]);
    expect(out.tables.find((t) => t.sessionId === flavoured)!.seatFlavours).toEqual(['Garlic', 'Spicy']);
  });
});
