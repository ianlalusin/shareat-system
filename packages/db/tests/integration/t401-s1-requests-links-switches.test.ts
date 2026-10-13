/**
 * T-401 S1 amend (migration 0196, in place) - the three tables Ian's answers add. TESTER. Raw SQL as the migration role.
 *   menu_item_requests         (R14, I21 DB half)
 *   menu_pos_v1_links          (R7, I22)
 *   menu_usage_source_switches (R7, I26)
 * plus each table's same-org composite FKs (R10).
 *
 * Red today: the three tables do not exist in 0196 yet, so every fixture fails on `relation ... does not exist`.
 * Refusal TEXT is matched loosely; SQLSTATE is pinned for CHECK (23514), UNIQUE (23505), FK (23503) and grants (42501).
 */
import { afterAll, describe, expect, it } from 'vitest';

import {
  asApp, insLink, insRequest, insRule, insSwitch, menuFixture, newItem, newLocation, refusal, sql, uid, type MenuFx,
} from './_fixtures/t401-menu';

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

const statusOf = async (id: string) => (await sql<{ s: string }[]>`select status s from menu_item_requests where id = ${id}`)[0]!.s;

// =================================================================================================
describe('I21 (DB half) -- item requests: a request resolves once; identity columns are frozen', () => {
  const resolve = (f: MenuFx, id: string, status: string, o: { item?: string | null; note?: string | null } = {}) =>
    sql`update menu_item_requests
           set status = ${status}, resolved_item_id = ${o.item ?? null}, resolved_by = ${f.personId}, resolved_at = now(), resolution_note = ${o.note ?? null}
         where id = ${id}`;

  it('an OPEN request is accepted; a blank name -> 23514', async () => {
    const f = await menuFixture('i21a');
    expect(await refusal(() => insRequest(f))).toBeUndefined();
    expect((await refusal(() => insRequest(f, '   ')))?.code).toBe('23514');
  });

  it('open => every resolved_* column NULL; a resolved status with no resolved_by/at is the mirror CHECK (23514)', async () => {
    const f = await menuFixture('i21b');
    const bad = await refusal(
      () => sql`insert into menu_item_requests (org_id, store_id, requested_by, name, item_type, note, status, resolved_by, resolved_at, created_by)
                values (${f.orgId}, ${f.storeId}, ${f.personId}, ${uid('R')}, 'a_la_carte', 'x', 'open', ${f.personId}, now(), ${f.personId})`,
    );
    expect(bad?.code).toBe('23514');
  });

  it('open -> approved with NO resolved_item_id is refused (23514); with the item accepted (control)', async () => {
    const f = await menuFixture('i21c');
    const [r] = await insRequest(f);
    const err = await refusal(() => resolve(f, r!.id, 'approved'));
    expect(err?.code).toBe('23514');
    expect(await statusOf(r!.id)).toBe('open');
    expect(await refusal(() => resolve(f, r!.id, 'approved', { item: f.itemId }))).toBeUndefined();
  });

  it('open -> duplicate needs an existing item id too (23514)', async () => {
    const f = await menuFixture('i21d');
    const [r] = await insRequest(f);
    expect((await refusal(() => resolve(f, r!.id, 'duplicate')))?.code).toBe('23514');
    expect(await refusal(() => resolve(f, r!.id, 'duplicate', { item: f.itemId }))).toBeUndefined();
  });

  it('rejected without a note (NULL or blank) -> 23514; with a note accepted', async () => {
    const f = await menuFixture('i21e');
    const [r1] = await insRequest(f);
    expect((await refusal(() => resolve(f, r1!.id, 'rejected')))?.code).toBe('23514');
    expect((await refusal(() => resolve(f, r1!.id, 'rejected', { note: '   ' })))?.code).toBe('23514');
    expect(await refusal(() => resolve(f, r1!.id, 'rejected', { note: 'we already sell it' }))).toBeUndefined();
  });

  it('withdrawn is a legal resolution of an open request', async () => {
    const f = await menuFixture('i21f');
    const [r] = await insRequest(f);
    expect(await refusal(() => resolve(f, r!.id, 'withdrawn'))).toBeUndefined();
    expect(await statusOf(r!.id)).toBe('withdrawn');
  });

  it.each([
    ['approved', 'rejected'],
    ['rejected', 'approved'],
    ['withdrawn', 'open'],
    ['approved', 'withdrawn'],
  ])('a RESOLVED request (%s) never changes again: -> %s refused, status unchanged (mutant: transition trigger missing)', async (from, to) => {
    const f = await menuFixture('i21g');
    const [r] = await insRequest(f);
    if (from === 'approved') await resolve(f, r!.id, 'approved', { item: f.itemId });
    if (from === 'rejected') await resolve(f, r!.id, 'rejected', { note: 'no' });
    if (from === 'withdrawn') await resolve(f, r!.id, 'withdrawn');
    const err = await refusal(() => resolve(f, r!.id, to, { item: f.itemId, note: 'because' }));
    expect(err, `${from} -> ${to} was accepted`).toBeDefined();
    expect(await statusOf(r!.id)).toBe(from);
  });

  it('a resolved request cannot even have its note edited (status unchanged, other column changed)', async () => {
    const f = await menuFixture('i21h');
    const [r] = await insRequest(f);
    await sql`update menu_item_requests set status = 'rejected', resolved_by = ${f.personId}, resolved_at = now(), resolution_note = 'no' where id = ${r!.id}`;
    expect(await refusal(() => sql`update menu_item_requests set resolution_note = 'changed my mind' where id = ${r!.id}`)).toBeDefined();
  });

  it.each([
    ['name', 'Different name'],
    ['item_type', 'package'],
  ])('UPDATE of %s on an open request is refused (frozen) and the value is unchanged', async (col, value) => {
    const f = await menuFixture('i21i');
    const [r] = await insRequest(f);
    const before = (await sql.unsafe(`select ${col}::text v from menu_item_requests where id = '${r!.id}'`))[0]!.v;
    const err = await refusal(() => sql.unsafe(`update menu_item_requests set ${col} = '${value}' where id = '${r!.id}'`));
    expect(err, `${col} was changed on an open request`).toBeDefined();
    expect(err!.message).toMatch(/frozen|immutable|cannot change|never change|name|item_type/i);
    expect((await sql.unsafe(`select ${col}::text v from menu_item_requests where id = '${r!.id}'`))[0]!.v).toBe(before);
  });

  it('UPDATE of store_id and of requested_by on an open request is refused (frozen)', async () => {
    const f = await menuFixture('i21j');
    const [other] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Other') returning id`;
    const [r] = await insRequest(f);
    expect(await refusal(() => sql`update menu_item_requests set store_id = ${f.store2Id} where id = ${r!.id}`), 'store_id changed').toBeDefined();
    expect(await refusal(() => sql`update menu_item_requests set requested_by = ${other!.id} where id = ${r!.id}`), 'requested_by changed').toBeDefined();
    const [row] = await sql<{ s: string; p: string }[]>`select store_id s, requested_by p from menu_item_requests where id = ${r!.id}`;
    expect(row).toEqual({ s: f.storeId, p: f.personId });
  });

  it('shareat_app may update the workflow (withdraw an open request) but holds no DELETE (42501)', async () => {
    const f = await menuFixture('i21k');
    const [r] = await insRequest(f);
    const up = await asApp(f.orgId, (tx) =>
      tx`update menu_item_requests set status = 'withdrawn', resolved_by = ${f.personId}, resolved_at = now() where id = ${r!.id} returning id`);
    expect(up.err, `app role could not withdraw: ${up.err?.message}`).toBeUndefined();
    const del = await asApp(f.orgId, (tx) => tx.unsafe(`delete from menu_item_requests where id = '${r!.id}'`));
    expect(del.err?.code).toBe('42501');
  });
});

// =================================================================================================
describe('I22 -- a v1 link always has a rule', () => {
  it('link to a variant with NO rule refused; with a rule only SCHEDULED refused; with a rule in force accepted (mutant: any rule exists)', async () => {
    const f = await menuFixture('i22a');
    const none = await refusal(() => insLink(f, f.variantId));
    expect(none, 'a link to a variant with no rule was accepted').toBeDefined();
    expect(none!.message).toMatch(/depletion|rule/i);
    await insRule(f, f.variantId, '1 day');
    const sched = await refusal(() => insLink(f, f.variantId));
    expect(sched, 'a link to a variant whose only rule is in the future was accepted').toBeDefined();
    expect(sched!.message).toMatch(/depletion|rule/i);
    const other = await newItem(f, 'a_la_carte');
    await insRule(f, other.variantId);
    expect(await refusal(() => insLink(f, other.variantId))).toBeUndefined();
  });

  it('a link to a RETIRED variant is refused', async () => {
    const f = await menuFixture('i22b');
    const sib = await newItem(f, 'a_la_carte');
    const [v] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${f.orgId}, ${sib.itemId}, 'Large', false, 1, 'active', ${f.personId}) returning id`;
    await insRule(f, v!.id);
    await sql`update menu_item_variants set status = 'retired' where id = ${v!.id}`;
    expect(await refusal(() => insLink(f, v!.id))).toBeDefined();
  });

  it('two ACTIVE links for one (store, key) -> 23505; an inactive duplicate and the same key at another store are fine', async () => {
    const f = await menuFixture('i22c');
    await insRule(f, f.variantId);
    const [a] = await insLink(f, f.variantId, 'KEY-1');
    expect((await refusal(() => insLink(f, f.variantId, 'KEY-1')))?.code).toBe('23505');
    expect(await refusal(() => insLink({ ...f, storeId: f.store2Id }, f.variantId, 'KEY-1'))).toBeUndefined();
    await sql`update menu_pos_v1_links set status = 'inactive' where id = ${a!.id}`;
    expect(await refusal(() => insLink(f, f.variantId, 'KEY-1'))).toBeUndefined();
  });

  it('a blank pos_item_key -> 23514', async () => {
    const f = await menuFixture('i22d');
    await insRule(f, f.variantId);
    expect((await refusal(() => insLink(f, f.variantId, '  ')))?.code).toBe('23514');
  });

  it.each(['variant_id', 'store_id', 'pos_item_key'])('changing %s is refused (relink = deactivate + insert); the row is unchanged', async (col) => {
    const f = await menuFixture('i22e');
    await insRule(f, f.variantId);
    const other = await newItem(f, 'a_la_carte');
    await insRule(f, other.variantId);
    const [l] = await insLink(f, f.variantId, 'KEY-IMM');
    const val = col === 'variant_id' ? other.variantId : col === 'store_id' ? f.store2Id : 'KEY-OTHER';
    const err = await refusal(() => sql.unsafe(`update menu_pos_v1_links set ${col} = '${val}' where id = '${l!.id}'`));
    expect(err, `${col} was changed`).toBeDefined();
    const [row] = await sql<{ v: string; s: string; k: string }[]>`select variant_id v, store_id s, pos_item_key k from menu_pos_v1_links where id = ${l!.id}`;
    expect(row).toEqual({ v: f.variantId, s: f.storeId, k: 'KEY-IMM' });
  });

  it('status and location_id ARE updatable (deactivate; set the store location)', async () => {
    const f = await menuFixture('i22f');
    await insRule(f, f.variantId);
    const [l] = await insLink(f, f.variantId, 'KEY-UPD');
    const loc = await newLocation(f, f.storeId);
    expect(await refusal(() => sql`update menu_pos_v1_links set location_id = ${loc} where id = ${l!.id}`)).toBeUndefined();
    expect(await refusal(() => sql`update menu_pos_v1_links set status = 'inactive' where id = ${l!.id}`)).toBeUndefined();
  });

  it('the location must belong to the link\'s store', async () => {
    const f = await menuFixture('i22g');
    await insRule(f, f.variantId);
    const locOther = await newLocation(f, f.store2Id);
    const err = await refusal(() => insLink(f, f.variantId, 'KEY-LOC', locOther));
    expect(err, 'a link to another store\'s stock location was accepted').toBeDefined();
    expect(err!.message).toMatch(/location|store/i);
    const locOwn = await newLocation(f, f.storeId);
    expect(await refusal(() => insLink(f, f.variantId, 'KEY-LOC2', locOwn))).toBeUndefined();
  });

  it('RE-ACTIVATING a link whose variant is now retired is refused (the insert-time guard also runs on re-activation)', async () => {
    const f = await menuFixture('i22h');
    const sib = await newItem(f, 'a_la_carte');
    const [v] = await sql<{ id: string }[]>`
      insert into menu_item_variants (org_id, menu_item_id, label, is_default, sort_order, status, created_by)
      values (${f.orgId}, ${sib.itemId}, 'Large', false, 1, 'active', ${f.personId}) returning id`;
    await insRule(f, v!.id);
    const [l] = await insLink(f, v!.id, 'KEY-REACT');
    await sql`update menu_pos_v1_links set status = 'inactive' where id = ${l!.id}`;
    await sql`update menu_item_variants set status = 'retired' where id = ${v!.id}`;
    expect(await refusal(() => sql`update menu_pos_v1_links set status = 'active' where id = ${l!.id}`)).toBeDefined();
  });

  it('shareat_app holds no DELETE on menu_pos_v1_links (42501)', async () => {
    const f = await menuFixture('i22i');
    await insRule(f, f.variantId);
    const [l] = await insLink(f, f.variantId, 'KEY-DEL');
    const del = await asApp(f.orgId, (tx) => tx.unsafe(`delete from menu_pos_v1_links where id = '${l!.id}'`));
    expect(del.err?.code).toBe('42501');
  });
});

// =================================================================================================
describe('I26 -- switches are append-only history', () => {
  it('pos_item_maps accepted with no reason; menu_rules with difference_count > 0 and no reason -> 23514; with a reason accepted', async () => {
    const f = await menuFixture('i26a');
    expect(await refusal(() => insSwitch(f, 'pos_item_maps'))).toBeUndefined();
    expect(await refusal(() => insSwitch(f, 'menu_rules', null, 0))).toBeUndefined();
    expect((await refusal(() => insSwitch(f, 'menu_rules', null, 2)))?.code).toBe('23514');
    expect((await refusal(() => insSwitch(f, 'menu_rules', '   ', 2)))?.code).toBe('23514');
    expect(await refusal(() => insSwitch(f, 'menu_rules', 'Lipa signed off the 7-day diff', 2))).toBeUndefined();
  });

  it('source outside pos_item_maps|menu_rules and a negative difference_count -> 23514', async () => {
    const f = await menuFixture('i26b');
    expect((await refusal(() => insSwitch(f, 'both')))?.code).toBe('23514');
    expect((await refusal(() => insSwitch(f, 'menu_rules', 'x', -1)))?.code).toBe('23514');
  });

  it('a created_at supplied in the PAST is overwritten to now() (a switch is immediate, never back-dated)', async () => {
    const f = await menuFixture('i26c');
    const [row] = await sql<{ id: string; past: boolean }[]>`
      insert into menu_usage_source_switches (org_id, store_id, source, created_at, created_by)
      values (${f.orgId}, ${f.storeId}, 'pos_item_maps', now() - interval '3 days', ${f.personId})
      returning id, (created_at < now() - interval '1 minute') as past`;
    expect(row!.past, 'the back-dated created_at was stored').toBe(false);
  });

  it('UPDATE is refused for the owner (append-only) and the row is unchanged', async () => {
    const f = await menuFixture('i26d');
    const [s] = await insSwitch(f, 'pos_item_maps');
    const err = await refusal(() => sql`update menu_usage_source_switches set source = 'menu_rules', reason = 'sneaky' where id = ${s!.id}`);
    expect(err, 'a switch row was UPDATEd').toBeDefined();
    expect(err!.message).toMatch(/append-only|never updated|immutable/i);
    expect((await sql<{ s: string }[]>`select source s from menu_usage_source_switches where id = ${s!.id}`)[0]!.s).toBe('pos_item_maps');
  });

  it('UPDATE is refused even under session_replication_role = replica (ENABLE ALWAYS) (mutant: guard left at origin)', async () => {
    const f = await menuFixture('i26e');
    const [s] = await insSwitch(f, 'pos_item_maps');
    const err = await refusal(() =>
      sql.begin(async (tx) => {
        await tx.unsafe(`set local session_replication_role = 'replica'`);
        await tx`update menu_usage_source_switches set source = 'menu_rules' where id = ${s!.id}`;
      }),
    );
    expect(err, 'a switch row was UPDATEd in replica mode').toBeDefined();
    expect(err!.message).toMatch(/append-only|never updated|immutable/i);
  });

  it('shareat_app holds no UPDATE and no DELETE (42501 each)', async () => {
    const f = await menuFixture('i26f');
    const [s] = await insSwitch(f, 'pos_item_maps');
    const up = await asApp(f.orgId, (tx) => tx.unsafe(`update menu_usage_source_switches set reason = 'x' where id = '${s!.id}'`));
    expect(up.err?.code).toBe('42501');
    const del = await asApp(f.orgId, (tx) => tx.unsafe(`delete from menu_usage_source_switches where id = '${s!.id}'`));
    expect(del.err?.code).toBe('42501');
  });

  it('the latest row by created_at is the store\'s source (history is queryable in order)', async () => {
    const f = await menuFixture('i26g');
    await insSwitch(f, 'pos_item_maps');
    await sql`select pg_sleep(0.05)`;
    await insSwitch(f, 'menu_rules', null, 0);
    const [r] = await sql<{ source: string }[]>`select source from menu_usage_source_switches where store_id = ${f.storeId} order by created_at desc limit 1`;
    expect(r!.source).toBe('menu_rules');
  });
});

// =================================================================================================
describe('R10 -- the new tables carry same-org composite FKs (23503 on a cross-org reference, even for the owner)', () => {
  it('menu_item_requests: store_id, requested_by, resolved_by, resolved_item_id, category_id', async () => {
    const a = await menuFixture('fk1a');
    const b = await menuFixture('fk1b');
    const base = (o: Record<string, string | null>) => ({
      store: a.storeId, by: a.personId, resBy: null as string | null, resItem: null as string | null, cat: null as string | null, ...o,
    });
    const cases: [string, ReturnType<typeof base>, string][] = [
      ['store_id', base({ store: b.storeId }), 'open'],
      ['requested_by', base({ by: b.personId }), 'open'],
      ['category_id', base({ cat: b.categoryId }), 'open'],
      ['resolved_by', base({ resBy: b.personId }), 'rejected'],
      ['resolved_item_id', base({ resBy: a.personId, resItem: b.itemId }), 'approved'],
    ];
    for (const [col, v, status] of cases) {
      const err = await refusal(
        () => sql`insert into menu_item_requests (org_id, store_id, requested_by, name, item_type, category_id, note, status, resolved_item_id, resolved_by, resolved_at, resolution_note, created_by)
                  values (${a.orgId}, ${v.store}, ${v.by}, ${uid('FK')}, 'a_la_carte', ${v.cat}, 'x', ${status}, ${v.resItem}, ${v.resBy},
                          ${status === 'open' ? null : new Date()}, ${status === 'rejected' ? 'no' : null}, ${a.personId})`,
      );
      expect(err?.code, `${col}: ${err?.message ?? 'accepted'}`).toBe('23503');
    }
  });

  it('menu_item_requests.created_by pointing at another org\'s person -> 23503', async () => {
    const a = await menuFixture('fk1c');
    const b = await menuFixture('fk1d');
    const err = await refusal(
      () => sql`insert into menu_item_requests (org_id, store_id, requested_by, name, item_type, note, status, created_by)
                values (${a.orgId}, ${a.storeId}, ${a.personId}, ${uid('FK')}, 'a_la_carte', 'x', 'open', ${b.personId})`,
    );
    expect(err?.code).toBe('23503');
  });

  it('menu_pos_v1_links: store_id, variant_id, location_id', async () => {
    const a = await menuFixture('fk2a');
    const b = await menuFixture('fk2b');
    await insRule(a, a.variantId);
    await insRule(b, b.variantId);
    const locB = await newLocation(b, b.storeId);
    const ins = (store: string, variant: string, loc: string | null) =>
      sql`insert into menu_pos_v1_links (org_id, store_id, pos_item_key, variant_id, location_id, status, created_by)
          values (${a.orgId}, ${store}, ${uid('K')}, ${variant}, ${loc}, 'active', ${a.personId})`;
    expect((await refusal(() => ins(b.storeId, a.variantId, null)))?.code, 'store_id').toBe('23503');
    expect((await refusal(() => ins(a.storeId, b.variantId, null)))?.code, 'variant_id').toBe('23503');
    expect((await refusal(() => ins(a.storeId, a.variantId, locB)))?.code, 'location_id').toBe('23503');
  });

  it('menu_usage_source_switches.store_id and created_by', async () => {
    const a = await menuFixture('fk3a');
    const b = await menuFixture('fk3b');
    const e1 = await refusal(
      () => sql`insert into menu_usage_source_switches (org_id, store_id, source, created_by) values (${a.orgId}, ${b.storeId}, 'pos_item_maps', ${a.personId})`,
    );
    expect(e1?.code, 'store_id').toBe('23503');
    const e2 = await refusal(
      () => sql`insert into menu_usage_source_switches (org_id, store_id, source, created_by) values (${a.orgId}, ${a.storeId}, 'pos_item_maps', ${b.personId})`,
    );
    expect(e2?.code, 'created_by').toBe('23503');
  });
});
