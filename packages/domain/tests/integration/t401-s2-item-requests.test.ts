/**
 * T-401 S2, I21 (domain half). docs/tasks/401-erp-menu-catalog-master.md R14(c), section 4 I21. TESTER, not BUILDER. Real Postgres.
 * A manager requests an item; ONLY super admin resolves a request (approve / duplicate / reject, all under add_menu_item); a requester
 * withdraws only their own open request.
 *
 * ## Assumed contract (all `(actor, input, tx?)`, table menu_item_requests, audit entity 'menu_item_requests', entity_id = the request id)
 *   requestMenuItem(actor, { storeId, name, itemType, categoryId?, note? })  -> { id, possibleDuplicates: [{ id, name }] }   gate request_menu_item (store)
 *   withdrawMenuItemRequest(actor, { id })                                    -> { id }    gate request_menu_item at the request's store, AND requested_by = actor
 *   approveMenuItemRequest(actor, { id, categoryId })                         -> { id, itemId }   creates the item (createMenuItem) in the SAME tx; add_menu_item
 *   markMenuItemRequestDuplicate(actor, { id, itemId })                       -> { id }    itemId must be an existing menu item of the org; add_menu_item
 *   rejectMenuItemRequest(actor, { id, note })                                -> { id }    note required (resolution_note); add_menu_item
 *   Request statuses: open | approved | duplicate | rejected | withdrawn; a resolved request never changes again.
 *   A refusal is a throw or { ok:false }; capability refusals are AuthorizationError with .capability.
 *   possibleDuplicates: a normalised exact-name match (case/space) is always listed; an unrelated name lists nothing.
 *
 * ## Red today
 * `requestMenuItem is not a function`, and migration 0196 has no menu_item_requests table yet (S1 revision). Mutants: approval creates the item
 * on another connection or leaves the request open; resolution gated by manage_menu (admin resolves); withdraw not limited to the requester.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { AuthorizationError } from '@shareat/auth';
import {
  approveMenuItemRequest,
  markMenuItemRequestDuplicate,
  rejectMenuItemRequest,
  requestMenuItem,
  withdrawMenuItemRequest,
} from '@shareat/domain';

import { asOrg, attempt, auditCount, cast, rawItem, sql, type Cast } from './_fixtures/t401-s2-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

interface Req {
  id: string;
  status: string;
  store_id: string;
  requested_by: string;
  resolved_item_id: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}
const reqRow = async (id: string) =>
  (await sql<Req[]>`select id, status, store_id, requested_by, resolved_item_id, resolved_by, resolution_note from menu_item_requests where id = ${id}`)[0]!;
const itemCount = async (c: Cast) => Number((await sql<{ n: number }[]>`select count(*)::int as n from menu_items where org_id = ${c.orgId}`)[0]!.n);

const open = (c: Cast, name = 'Wagyu Platter', who = c.manager, storeId = c.storeA) =>
  asOrg(c.orgId, (tx) => requestMenuItem(who, { storeId, name, itemType: 'a_la_carte', note: 'guests ask for it' }, tx));

describe('requestMenuItem -- the request and its duplicate check', () => {
  it('stores an open request for the requester and store; lists a likely duplicate by normalised name; the request is still created', async () => {
    const c = await cast('rq-dup');
    const existing = await rawItem(c, 'a_la_carte', 'Samgyupsal Set');
    const r = await open(c, 'samgyupsal  set');
    expect(r.possibleDuplicates.map((d: { id: string }) => d.id)).toContain(existing.itemId);
    const row = await reqRow(r.id);
    expect(row).toMatchObject({ status: 'open', store_id: c.storeA, requested_by: c.manager.personId, resolved_item_id: null });
  });

  it('an unrelated name lists no duplicates (mutant: everything is a duplicate)', async () => {
    const c = await cast('rq-nodup');
    await rawItem(c, 'a_la_carte', 'Samgyupsal Set');
    const r = await open(c, 'Halo-halo Supreme');
    expect(r.possibleDuplicates).toEqual([]);
  });

  it('a manager cannot request for a store outside their scope; staff cannot request at all', async () => {
    const c = await cast('rq-scope');
    for (const [who, store] of [[c.managerA, c.storeB], [c.staff, c.storeA]] as const) {
      const before = await auditCount(c.orgId);
      const r = await attempt(() => open(c, 'Nope', who, store));
      expect(r.failed).toBe(true);
      expect(r.error).toBeInstanceOf(AuthorizationError);
      expect((r.error as AuthorizationError).capability).toBe('request_menu_item');
      expect(await auditCount(c.orgId)).toBe(before);
    }
  });
});

describe('resolving a request is SUPER ADMIN only (add_menu_item); a request resolves once', () => {
  it('approve by super admin creates the item (with its default variant) AND resolves the request, in one transaction', async () => {
    const c = await cast('rq-ok');
    const r = await open(c, 'Wagyu Platter');
    const out = await asOrg(c.orgId, (tx) => approveMenuItemRequest(c.superAdmin, { id: r.id, categoryId: c.categoryId }, tx));
    const row = await reqRow(r.id);
    expect(row).toMatchObject({ status: 'approved', resolved_item_id: out.itemId, resolved_by: c.superAdmin.personId });
    const [item] = await sql<{ name: string; item_type: string }[]>`select name, item_type from menu_items where id = ${out.itemId}`;
    expect(item).toEqual({ name: 'Wagyu Platter', item_type: 'a_la_carte' });
    const [v] = await sql<{ n: number }[]>`select count(*)::int as n from menu_item_variants where menu_item_id = ${out.itemId} and is_default`;
    expect(v!.n).toBe(1);
  });

  it('roll the transaction back after approving: NEITHER the item NOR the resolution survives (mutant: item made on another connection)', async () => {
    const c = await cast('rq-rb');
    const r = await open(c, 'Ghost Platter');
    const before = await itemCount(c);
    await expect(
      asOrg(c.orgId, async (tx) => {
        await approveMenuItemRequest(c.superAdmin, { id: r.id, categoryId: c.categoryId }, tx);
        throw new Error('rollback on purpose');
      }),
    ).rejects.toThrow('rollback on purpose');
    expect((await reqRow(r.id)).status).toBe('open');
    expect(await itemCount(c)).toBe(before);
  });

  it('approve, mark-duplicate and reject by ADMIN are each refused with add_menu_item; the request stays open, no item, no audit (mutant: gated by manage_menu)', async () => {
    const c = await cast('rq-admin');
    const existing = await rawItem(c, 'a_la_carte', 'Existing Thing');
    const r = await open(c, 'Wagyu Platter');
    const items = await itemCount(c);
    const audit = await auditCount(c.orgId);
    const runs: (() => Promise<unknown>)[] = [
      () => asOrg(c.orgId, (tx) => approveMenuItemRequest(c.admin, { id: r.id, categoryId: c.categoryId }, tx)),
      () => asOrg(c.orgId, (tx) => markMenuItemRequestDuplicate(c.admin, { id: r.id, itemId: existing.itemId }, tx)),
      () => asOrg(c.orgId, (tx) => rejectMenuItemRequest(c.admin, { id: r.id, note: 'no' }, tx)),
    ];
    for (const run of runs) {
      const a = await attempt(run);
      expect(a.failed, 'admin resolved a request').toBe(true);
      expect(a.error).toBeInstanceOf(AuthorizationError);
      expect((a.error as AuthorizationError).capability).toBe('add_menu_item');
    }
    expect((await reqRow(r.id)).status).toBe('open');
    expect(await itemCount(c)).toBe(items);
    expect(await auditCount(c.orgId)).toBe(audit);
  });

  it('manager and the requester themself cannot resolve either', async () => {
    const c = await cast('rq-mgr');
    const r = await open(c, 'Wagyu Platter');
    const a = await attempt(() => asOrg(c.orgId, (tx) => rejectMenuItemRequest(c.manager, { id: r.id, note: 'self-reject' }, tx)));
    expect(a.failed).toBe(true);
    expect(a.error).toBeInstanceOf(AuthorizationError);
    expect((await reqRow(r.id)).status).toBe('open');
  });

  it('mark-duplicate needs an existing item of the org: a random id is refused, a real one resolves the request pointing at it', async () => {
    const c = await cast('rq-dupmark');
    const r = await open(c, 'Samgyupsal Set');
    const bad = await asOrg(c.orgId, (tx) => attempt(() => markMenuItemRequestDuplicate(c.superAdmin, { id: r.id, itemId: '00000000-0000-7000-8000-000000000000' }, tx)));
    expect(bad.failed, 'a non-existent item id was accepted as the duplicate').toBe(true);
    expect((await reqRow(r.id)).status).toBe('open');
    const existing = await rawItem(c, 'a_la_carte', 'Samgyupsal Set');
    await asOrg(c.orgId, (tx) => markMenuItemRequestDuplicate(c.superAdmin, { id: r.id, itemId: existing.itemId }, tx));
    expect(await reqRow(r.id)).toMatchObject({ status: 'duplicate', resolved_item_id: existing.itemId });
  });

  it('reject needs a note: blank is refused, a note resolves it and is kept', async () => {
    const c = await cast('rq-rej');
    const r = await open(c, 'Wagyu Platter');
    for (const note of ['', '   ']) {
      const bad = await asOrg(c.orgId, (tx) => attempt(() => rejectMenuItemRequest(c.superAdmin, { id: r.id, note }, tx)));
      expect(bad.failed, `note ${JSON.stringify(note)} accepted`).toBe(true);
    }
    expect((await reqRow(r.id)).status).toBe('open');
    await asOrg(c.orgId, (tx) => rejectMenuItemRequest(c.superAdmin, { id: r.id, note: 'we already sell it as a set' }, tx));
    expect(await reqRow(r.id)).toMatchObject({ status: 'rejected', resolution_note: 'we already sell it as a set' });
  });

  it('a resolved request resolves once: a second resolution is refused and nothing changes (mutant: resolution not guarded)', async () => {
    const c = await cast('rq-once');
    const r = await open(c, 'Wagyu Platter');
    await asOrg(c.orgId, (tx) => rejectMenuItemRequest(c.superAdmin, { id: r.id, note: 'no' }, tx));
    const items = await itemCount(c);
    const again = await asOrg(c.orgId, (tx) => attempt(() => approveMenuItemRequest(c.superAdmin, { id: r.id, categoryId: c.categoryId }, tx)));
    expect(again.failed, 'a rejected request was approved').toBe(true);
    expect((await reqRow(r.id)).status).toBe('rejected');
    expect(await itemCount(c)).toBe(items);
  });
});

describe('withdraw: only the requester, only while open', () => {
  it('the requester withdraws their own open request', async () => {
    const c = await cast('rq-wd');
    const r = await open(c, 'Wagyu Platter', c.manager);
    await asOrg(c.orgId, (tx) => withdrawMenuItemRequest(c.manager, { id: r.id }, tx));
    expect((await reqRow(r.id)).status).toBe('withdrawn');
  });

  it("manager B cannot withdraw manager A's request: refused, the request stays open (mutant: any store manager may withdraw)", async () => {
    const c = await cast('rq-wd2');
    const r = await open(c, 'Wagyu Platter', c.manager);
    const a = await asOrg(c.orgId, (tx) => attempt(() => withdrawMenuItemRequest(c.manager2, { id: r.id }, tx)));
    expect(a.failed, "manager 2 withdrew manager 1's request").toBe(true);
    expect((await reqRow(r.id)).status).toBe('open');
  });

  it('a resolved request cannot be withdrawn', async () => {
    const c = await cast('rq-wd3');
    const r = await open(c, 'Wagyu Platter', c.manager);
    await asOrg(c.orgId, (tx) => rejectMenuItemRequest(c.superAdmin, { id: r.id, note: 'no' }, tx));
    const a = await asOrg(c.orgId, (tx) => attempt(() => withdrawMenuItemRequest(c.manager, { id: r.id }, tx)));
    expect(a.failed).toBe(true);
    expect((await reqRow(r.id)).status).toBe('rejected');
  });
});

describe('I17 for requests -- one audit_log row per write, entity menu_item_requests', () => {
  async function oneRow(c: Cast, label: string, run: () => Promise<{ id: string }>, actor: string) {
    const before = await auditCount(c.orgId);
    const out = await run();
    const rows = await sql<{ actor_person_id: string; entity: string; entity_id: string; action: string }[]>`
      select actor_person_id, entity, entity_id, action from audit_log where org_id = ${c.orgId} and entity = 'menu_item_requests' and entity_id = ${out.id}
      order by occurred_at desc, id desc`;
    expect(rows.length, `${label}: audit rows for the request`).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ actor_person_id: actor, entity: 'menu_item_requests', entity_id: out.id });
    expect(rows[0]!.action.trim().length).toBeGreaterThan(0);
    return { out, delta: (await auditCount(c.orgId)) - before, forRequest: rows.length };
  }

  it('request, withdraw, reject and mark-duplicate each leave exactly one audit row; approve one for the request (plus the item\'s own)', async () => {
    const c = await cast('rq-audit');
    const existing = await rawItem(c, 'a_la_carte', 'Existing Thing');
    const a = await oneRow(c, 'request', () => open(c, 'A One'), c.manager.personId);
    expect([a.delta, a.forRequest]).toEqual([1, 1]);
    const w = await oneRow(c, 'withdraw', async () => {
      const r = await open(c, 'A Two');
      return asOrg(c.orgId, (tx) => withdrawMenuItemRequest(c.manager, { id: r.id }, tx));
    }, c.manager.personId);
    expect(w.forRequest).toBe(2); // its request row + its withdraw row
    const r3 = await open(c, 'A Three');
    const before = await auditCount(c.orgId);
    await asOrg(c.orgId, (tx) => rejectMenuItemRequest(c.superAdmin, { id: r3.id, note: 'no' }, tx));
    expect((await auditCount(c.orgId)) - before, 'reject: exactly one audit row').toBe(1);
    const r4 = await open(c, 'A Four');
    const before4 = await auditCount(c.orgId);
    await asOrg(c.orgId, (tx) => markMenuItemRequestDuplicate(c.superAdmin, { id: r4.id, itemId: existing.itemId }, tx));
    expect((await auditCount(c.orgId)) - before4, 'mark duplicate: exactly one audit row').toBe(1);
    const r5 = await open(c, 'A Five');
    const ap = await oneRow(c, 'approve', () => asOrg(c.orgId, (tx) => approveMenuItemRequest(c.superAdmin, { id: r5.id, categoryId: c.categoryId }, tx)).then((x) => ({ id: r5.id, ...x })), c.superAdmin.personId);
    expect(ap.forRequest).toBeGreaterThanOrEqual(2);
  });
});
