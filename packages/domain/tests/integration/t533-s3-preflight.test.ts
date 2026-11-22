/**
 * T-533 S3 (TESTER, written FIRST) - posPreflight against a real database. docs/tasks/533-pos-lipa-switch.md R3.
 *
 *   packages/domain/src/pos/preflight.ts (new)
 *     posPreflight(tx, actor, { storeId }, { keyFilePresent, today? }) -> { blocking: Item[], warnings: Item[] }   Item = { code, sentence, href }
 *   Capability: `manage_stores` (admin and super_admin; a store manager never), checked FIRST. A read: it writes nothing.
 *
 * The pure decision (every item firing alone) is `src/pos/preflight.test.ts`; THIS file proves the facts are read right from the tables:
 * each blocking and each warning item fires on its own from a fully set-up store, the set-up store has none, and the other store's rows,
 * retired rows and inactive tenders are not counted. The t525 fixture builds the world with raw SQL, so the DATABASE is the oracle.
 * Made-up data only; no database name appears here (the integration setup guard accepts any "_test" database).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { asOrg, closeAll, fixture, pinOf, sql, stateVersionOf, uuid, type Fx } from './_fixtures/t525-pos';
import { posPreflight } from '../../src/pos/preflight';
import { employManager } from './_fixtures/t533-store-ready';
import { superAdminOf } from './_fixtures/t626-super-admin';
import { addMenuVariant, createDaypart, setDepletionRule, setMenuOffer, withdrawMenuOffer } from '../../src/menu';

afterAll(closeAll);

const RULE_KEYS: [string, string][] = [
  ['tax.vat_percent', '12.00'],
  ['pos.senior_pwd_discount_percent', '20.00'],
  ['pos.business_day_start_hour', '4.00'],
  ['pos.table_warn_minutes', '90.00'],
];

/** A store that is ready for the switch: everything the t525 fixture lacks is added (rule rows, tender aliases, PINs). `rules: false` leaves the rows out (they cannot be deleted: the table is append-only). */
async function ready(o: { rules?: boolean } = {}): Promise<Fx> {
  const f = await fixture('test');
  if (o.rules !== false) {
    for (const [key, value] of RULE_KEYS) {
      await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason)
                values (${f.orgId}, ${key}, ${value}, '2026-01-01', ${f.adminId}, 'seed for the test')`;
    }
  }
  await sql`update tenders set pos_v1_alias = lower(name) where store_id = ${f.storeId} and is_active`; // the inactive Maya keeps NO alias: inactive tenders are not counted
  for (const id of [f.managerId, f.counterId, f.kitchenId]) await pinOf(f, id);
  await employManager(f); // T-601 S6: the approver must be on the tablet's sign-in list
  return f;
}

const KEY_PRESENT = { keyFilePresent: () => true };
const run = (f: Fx, actor = f.admin, deps: { keyFilePresent: () => boolean; today?: string } = KEY_PRESENT, storeId = f.storeId) =>
  asOrg(f.orgId, (tx) => posPreflight(tx, actor, { storeId }, deps));
const codes = async (f: Fx, deps?: { keyFilePresent: () => boolean; today?: string }) => {
  const r = await run(f, f.admin, deps);
  return { blocking: r.blocking.map((i) => i.code), warnings: r.warnings.map((i) => i.code) };
};
const NONE = { blocking: [] as string[], warnings: [] as string[] };

describe('R3 posPreflight - a ready store', () => {
  it('a fully set-up store has no blocking item and no warning', async () => {
    const f = await ready();
    expect(await codes(f)).toEqual(NONE);
  });

  it('every item is a plain sentence plus a link (or null); it writes nothing: no audit row, no state_version bump', async () => {
    const f = await ready();
    await sql`delete from pos_stands where store_id = ${f.storeId} and status = 'active'`;
    const auditCount = async () => (await sql<{ n: number }[]>`select count(*)::int n from audit_log where org_id = ${f.orgId}`)[0]!.n;
    const before = { audit: await auditCount(), version: await stateVersionOf(f) };
    const r = await run(f);
    expect(r.blocking.length).toBeGreaterThan(0);
    for (const i of r.blocking) {
      expect(typeof i.sentence).toBe('string');
      expect(i.href === null || i.href.startsWith('/')).toBe(true);
    }
    expect({ audit: await auditCount(), version: await stateVersionOf(f) }).toEqual(before);
  });
});

describe('R3 posPreflight - each blocking item fires on its own', () => {
  it('no pos_stores row', async () => {
    const f = await ready();
    await sql`delete from pos_stores where store_id = ${f.storeId}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_pos_store_row'] });
  });

  it('no active stands (a retired one does not count)', async () => {
    const f = await ready();
    await sql`update pos_stands set status = 'retired' where store_id = ${f.storeId}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_stands'] });
  });

  it('no active cash tender (another store\'s cash tender does not count)', async () => {
    const f = await ready();
    await sql`update tenders set is_active = false where id = ${f.cash}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_cash_tender'] });
  });

  it('an active tender without a v1 name while the store is v1-linked; an inactive one is not counted', async () => {
    const f = await ready();
    await sql`update tenders set pos_v1_alias = null where id = ${f.gcash}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['tender_without_alias'] });
    await sql`update tenders set is_active = false where id = ${f.gcash}`;
    expect(await codes(f)).toEqual(NONE);
  });

  it('no till linked to a live pairing: no till link at all, or the pairing revoked', async () => {
    const f = await ready();
    await sql`update pos_terminals set pairing_id = null where store_id = ${f.storeId}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_linked_till'] });
    await sql`update pos_terminals set pairing_id = ${f.pairingId} where store_id = ${f.storeId}`;
    expect(await codes(f)).toEqual(NONE);
    await sql`update pos_tablet_pairings set revoked_at = now(), revoked_by = ${f.adminId} where id = ${f.pairingId}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_linked_till'] });
  });

  it('the business rules not seeded (no rows for the org); a partly seeded org still blocks', async () => {
    const f = await ready({ rules: false });
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['rules_not_seeded'] });
    await sql`insert into business_rule_values (org_id, key, value, effective_from, set_by, reason) values (${f.orgId}, 'tax.vat_percent', '12.00', '2026-01-01', ${f.adminId}, 'one only')`;
    const r = await run(f);
    expect(r.blocking.map((i) => i.code)).toEqual(['rules_not_seeded']);
    expect(r.blocking[0]!.sentence).not.toContain('VAT included');
    expect(r.blocking[0]!.sentence).toContain('Senior citizen and PWD discount');
  });

  it('no person at the store who may sell (record_sale): the cashier and the manager (who sells by role) have both left', async () => {
    const f = await ready();
    await sql`update employments set ended_on = '2025-06-01', employment_status = 'resigned' where person_id in (${f.counterId}, ${f.managerId})`;
    // No approver either: nobody is left on the sign-in list who has a PIN and the grant.
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_record_sale_person', 'no_approver'] });
  });

  it('no tablet registered for approvals (T-601 S6): no active pos_terminal_links row; a revoked one does not count', async () => {
    const f = await ready();
    await sql`update pos_terminal_links set revoked_at = now(), revoked_by = ${f.adminId} where store_id = ${f.storeId}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_terminal_link'] });
  });

  it('no approver (T-601 S6): a revoked PIN, a manager of another store, and a staff PIN do not count; the manager with a live PIN does', async () => {
    const f = await ready();
    await pinOf(f, f.managerOtherId);
    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'test' where person_id = ${f.managerId} and kind = 'pin'`;
    // The manager is on the sign-in list and now has no PIN, so the staff_without_pin warning fires too.
    expect(await codes(f)).toEqual({ blocking: ['no_approver'], warnings: ['staff_without_pin'] });
    await sql`update person_credentials set revoked_at = null, revoke_reason = null where person_id = ${f.managerId} and kind = 'pin'`;
    expect(await codes(f)).toEqual(NONE);
  });

  it('no approver (T-612): a SUSPENDED manager with a live PIN and the grant is not an approver; reinstated, they are', async () => {
    const f = await ready();
    // Mutant: no account_status test in personMaySignInAtStore, listOpenEmploymentsAtStore, personIdsWithLivePin and authorize -> the suspended manager still approves (red).
    await sql`update persons set account_status = 'suspended' where id = ${f.managerId}`;
    expect((await codes(f)).blocking, 'a paused account is no approver').toContain('no_approver');
    await sql`update persons set account_status = 'active' where id = ${f.managerId}`;
    expect(await codes(f)).toEqual(NONE);
  });

  it('no approver (T-601 S6): the only approver is also the only seller (the cashier left), so they cannot approve their own close', async () => {
    const f = await ready();
    await sql`update employments set ended_on = '2025-06-01', employment_status = 'resigned' where person_id = ${f.counterId}`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_approver'] });
  });

  it('the bridge key file not configured, from the injected probe only', async () => {
    const f = await ready();
    expect(await codes(f, { keyFilePresent: () => false })).toEqual({ ...NONE, blocking: ['no_bridge_key_file'] });
    expect(await codes(f, { keyFilePresent: () => true })).toEqual(NONE);
  });

  it('the alias and key-file items stop applying once the store is not v1-linked, or the date is after 2026-12-31', async () => {
    const f = await ready();
    await sql`update tenders set pos_v1_alias = null where id = ${f.gcash}`;
    const off = { keyFilePresent: () => false };
    expect((await codes(f, off)).blocking).toEqual(['tender_without_alias', 'no_bridge_key_file']);
    expect(await codes(f, { ...off, today: '2027-01-05' })).toEqual(NONE);
    await sql`update pos_v1_store_links set unlinked_at = now(), unlinked_by = ${f.adminId}, unlink_reason = 'test' where store_id = ${f.storeId}`;
    expect(await codes(f, off)).toEqual(NONE);
  });
});

describe('R3 posPreflight - each warning fires on its own and never blocks', () => {
  it('menu items offered here with no kitchen station, named', async () => {
    const f = await ready();
    await sql`delete from kitchen_routes where menu_item_id = ${f.menu.pork.itemId}`;
    const r = await run(f);
    expect(r.blocking).toEqual([]);
    expect(r.warnings.map((i) => i.code)).toEqual(['items_without_station']);
    expect(r.warnings[0]!.sentence).toContain('Pork belly');
  });

  it('a package with no refill items, named', async () => {
    const f = await ready();
    await sql`delete from menu_package_refills where package_variant_id = ${f.menu.unli.variantId}`;
    const r = await run(f);
    expect(r.blocking).toEqual([]);
    expect(r.warnings.map((i) => i.code)).toEqual(['packages_without_refills']);
    expect(r.warnings[0]!.sentence).toContain('Unli Grill');
  });

  it('staff who can sign in at the store but have no PIN (a revoked PIN counts as none)', async () => {
    const f = await ready();
    await sql`update person_credentials set revoked_at = now(), revoke_reason = 'test' where person_id = ${f.counterId} and kind = 'pin'`;
    const r = await run(f);
    expect(r.blocking).toEqual([]);
    expect(r.warnings.map((i) => i.code)).toEqual(['staff_without_pin']);
    expect(r.warnings[0]!.sentence).toMatch(/\b1\b/);
  });

  it('no active discount presets (a retired one does not count)', async () => {
    const f = await ready();
    await sql`update pos_discount_presets set status = 'retired' where store_id = ${f.storeId}`;
    expect(await codes(f)).toEqual({ ...NONE, warnings: ['no_discount_presets'] });
  });
});

describe('R3 posPreflight - who may ask, and which store', () => {
  it('a store manager is refused, and so is a cashier (manage_stores is admin only)', async () => {
    const f = await ready();
    for (const who of [f.manager, f.counter]) {
      const err = await run(f, who).then(() => null, (e: unknown) => e);
      expect(err, 'expected a refusal, got success').not.toBeNull();
      expect(err).toBeInstanceOf(AuthorizationError);
    }
  });

  it('a store of another organisation, or an unknown store, is refused in words', async () => {
    const f = await ready();
    const other = await ready();
    for (const storeId of [other.storeId, uuid()]) {
      const err = await run(f, f.admin, KEY_PRESENT, storeId).then(() => null, (e: unknown) => e);
      expect(err, 'expected a refusal, got success').not.toBeNull();
      expect(err).toBeInstanceOf(RefusalError);
    }
  });

  it('only this store\'s rows count: the other store has a stand and a cash tender but no till and no switch row', async () => {
    const f = await ready();
    const r = await run(f, f.admin, KEY_PRESENT, f.store2Id);
    const blocking = r.blocking.map((i) => i.code);
    expect(blocking).toContain('no_pos_store_row');
    expect(blocking).toContain('no_linked_till');
    expect(blocking).not.toContain('no_stands');
    expect(blocking).not.toContain('no_cash_tender');
  });
});

describe('T-626 posPreflight - the menu must be sellable before the switch', () => {
  it('no package on sale blocks: the only package withdrawn (sold out) leaves the tablet nothing to start a table with', async () => {
    const f = await ready();
    await sql`insert into menu_offers (org_id, store_id, variant_id, channel, amount, withdrawn, created_by) values (${f.orgId}, ${f.storeId}, ${f.menu.unli.variantId}, 'store', null, true, ${f.personId})`;
    expect(await codes(f)).toEqual({ ...NONE, blocking: ['no_packages_on_sale'] });
  });

  it('a package with no kitchen station blocks, named once (it is not also a warning)', async () => {
    const f = await ready();
    await sql`delete from kitchen_routes where menu_item_id = ${f.menu.unli.itemId}`;
    const r = await run(f);
    expect(r.blocking.map((i) => i.code)).toEqual(['package_without_station']);
    expect(r.blocking[0]!.sentence).toContain('Unli Grill');
    expect(r.warnings).toEqual([]);
  });

  it('a package priced for lunch but not dinner blocks and names the missing hours, once some package sells at dinner (T-626 audit ruling 2); the prices clear it', async () => {
    const f = await ready();
    const sa = await superAdminOf(f);
    const { storeId } = f;
    const days = [0, 1, 2, 3, 4, 5, 6];
    const lunch = await asOrg(f.orgId, (tx) => createDaypart(sa, { storeId, name: 'Lunch', days, start: '08:00', end: '17:00' }, tx));
    const dinner = await asOrg(f.orgId, (tx) => createDaypart(sa, { storeId, name: 'Dinner', days, start: '17:00', end: '08:00' }, tx));
    // all-day 449.00 is replaced by a lunch price only
    await asOrg(f.orgId, (tx) => withdrawMenuOffer(sa, { storeId, variantId: f.menu.unli.variantId, channel: 'store' }, tx));
    await asOrg(f.orgId, (tx) => setMenuOffer(sa, { storeId, variantId: f.menu.unli.variantId, channel: 'store', amount: '449.00', daypartId: lunch.id }, tx));
    // No package is priced for Dinner, so Dinner is not a window anything sells in: not a missing price.
    expect((await run(f)).blocking).toEqual([]);
    // A second package variant priced only for Dinner makes Dinner a selling window: now each misses the other's hours.
    const kids = await asOrg(f.orgId, (tx) => addMenuVariant(sa, { menuItemId: f.menu.unli.itemId, label: 'Kids' }, tx));
    await asOrg(f.orgId, (tx) => setDepletionRule(sa, { variantId: kids.id, mode: 'no_stock' }, tx));
    await asOrg(f.orgId, (tx) => setMenuOffer(sa, { storeId, variantId: kids.id, channel: 'store', amount: '299.00', daypartId: dinner.id }, tx));
    const r = await run(f);
    expect(r.blocking.map((i) => i.code)).toEqual(['package_missing_price']);
    expect(r.blocking[0]!.sentence).toContain('Unli Grill (no Dinner price)');
    expect(r.blocking[0]!.sentence).toContain('Unli Grill (Kids) (no Lunch price)');
    await asOrg(f.orgId, (tx) => setMenuOffer(sa, { storeId, variantId: f.menu.unli.variantId, channel: 'store', amount: '499.00', daypartId: dinner.id }, tx));
    await asOrg(f.orgId, (tx) => setMenuOffer(sa, { storeId, variantId: kids.id, channel: 'store', amount: '249.00', daypartId: lunch.id }, tx));
    expect((await run(f)).blocking).toEqual([]);
  });
});
