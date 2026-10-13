import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-391 S3 - `docs/tasks/391-production-master-data-load.md`, tests 16-20a (+ review rules R8, R16). TESTER file.
 * Real Postgres. The item APPLY: `scripts/lib/master-data-apply.ts` runs the item planner's writes through the domain
 * functions (createItem, setItemPurchaseUnit) as a named actor, inserts v1_master_links, and writes ONE
 * `master_data_load` audit row per apply.
 *
 * CONTRACT these tests pin (the spec names the file, not the signature - the builder builds to this):
 *   scripts/lib/master-data-apply.ts
 *     applyItems({ snapshot, snapshotSha, map, orgId, orgCode, storeCodes?, answers, actor, apply })
 *       -> Promise<{ dryRun: boolean; created: number; linked: number; held: number }>
 *       snapshot/map/answers are exactly what planItems takes (map = parseStoreMap rows, answers = parsed CSV rows by sheet);
 *       actor is { personId, orgId } (or absent); apply:false is the dry run (everything rolled back, same counts).
 *       It plans INSIDE the locked transaction. It REJECTS (and writes nothing - not even the clean items) when the plan has
 *       held > 0 (message matches /held/i), when the actor is absent, of another org, or lacks approve_item
 *       (AuthorizationError from the domain gate), and when assertRunTarget refuses (--org's code != orgCode).
 *       `created` = items created, `linked` = v1_master_links rows inserted (created items' links + links to existing items).
 * LOCK KEY (pinned): each apply takes pg_advisory_xact_lock(hashtext('master-data:' || org_id)) before planning; a second apply WAITS.
 * Audit row: action 'master_data_load', entity 'items' (or 'item'), after = { snapshotSha, stores, created, linked, held },
 *   actor_person_id = the actor.
 *
 * Each test names its killing mutant. Red today: the module does not exist, so each test fails on the import, in itself.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseStoreMap } from '../../../etl/src/master-data/store-map';
import { planItems } from '../../../etl/src/master-data/items-plan';
import { key } from '../../../etl/src/master-data/keys';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const P = 'y1DMgfisuTHBF57cNL6i'; // Padre Garcia: its own organisation (bible row 305)
const SHA = 'a'.repeat(64);

const mapCsv = (se: string, pg: string): string =>
  [
    'v1_store_id,name,role,org_code,store_code',
    `${L},SharEat Lipa,own,${se},LIPA`,
    `${M},SharEat Malvar,own,${se},MLVR`,
    `${B},SharEat Banay-Banay,own,${se},BNBN`,
    `${P},SharEat Padre Garcia,franchise,${pg},PGAR`,
  ].join('\r\n');

interface Env {
  orgId: string;
  orgCode: string;
  pgOrgId: string;
  pgCode: string;
  map: Any[];
  superA: Actor;
  admin: Actor;
  manager: Actor;
  pgSuper: Actor;
}

async function mkOrg(code: string): Promise<{ orgId: string; mk: (n: string, role: string) => Promise<string> }> {
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name) values (${orgId}, ${uid('ST')}, ${`Store ${code}`}) returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return p!.id;
  };
  return { orgId, mk };
}

async function env(hint: string): Promise<Env> {
  const orgCode = uid(`S${hint}`);
  const pgCode = uid(`G${hint}`);
  const a = await mkOrg(orgCode);
  const b = await mkOrg(pgCode);
  const act = (orgId: string, personId: string): Actor => ({ orgId, personId });
  return {
    orgId: a.orgId,
    orgCode,
    pgOrgId: b.orgId,
    pgCode,
    map: parseStoreMap(mapCsv(orgCode, pgCode)),
    superA: act(a.orgId, await a.mk('Super', 'super_admin')),
    admin: act(a.orgId, await a.mk('Admin', 'admin')),
    manager: act(a.orgId, await a.mk('Manager', 'manager')),
    pgSuper: act(b.orgId, await b.mk('PG Super', 'super_admin')),
  };
}

type Rec = { id: string; store: string; name: string; kind?: string; baseUnit?: string; purchaseUnit?: string; conversionFactor?: number };
const snap = (items: Rec[]): Any => ({ version: 1, stores: [], items, suppliers: [], arCustomers: [], staff: [], staffIdentities: [] });
let rid = 0;
const rec = (store: string, name: string, baseUnit = 'kg', kind = 'raw_material', extra: Partial<Rec> = {}): Rec => ({
  id: `r${++rid}`, store, name, kind, baseUnit, ...extra,
});

type Apply = (a: Record<string, unknown>) => Promise<{ dryRun: boolean; created: number; linked: number; held: number }>;
async function applyFn(): Promise<Apply> {
  const mod: Any = await import('../../../../scripts/lib/master-data-apply');
  return mod.applyItems as Apply;
}
async function run(e: Env, snapshot: Any, over: Record<string, unknown> = {}) {
  const apply = await applyFn();
  return apply({
    snapshot, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.superA, apply: true, ...over,
  });
}
const planOf = (e: Env, snapshot: Any, over: Record<string, unknown> = {}): Any =>
  planItems({ snapshot, map: e.map, orgCode: e.orgCode, existing: [], links: [], answers: {}, ...over } as Any);

async function failure(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}

const items = (orgId: string) =>
  sql<Any[]>`select id, code, name, kind, base_unit, status, purchase_unit, purchase_factor, merged_into_id, updated_at from items where org_id = ${orgId} order by name`;
const links = (orgId: string) =>
  sql<Any[]>`select entity, v1_store_id, v1_id, v2_id, v1_unit, factor_to_base, created_by from v1_master_links where org_id = ${orgId} order by v1_id`;
const counters = async (orgId: string) =>
  (await sql<Any[]>`select stem, last_seq from item_code_counters where org_id = ${orgId} order by stem`).map((r) => `${r.stem}:${r.last_seq}`);
const loadAudits = (orgId: string) =>
  sql<Any[]>`select action, entity, after, source, actor_person_id from audit_log where org_id = ${orgId} and action = 'master_data.items_load' order by occurred_at, id`;
const allAuditCount = async (orgId: string) => Number((await sql<Any[]>`select count(*)::int as n from audit_log where org_id = ${orgId}`)[0]!.n);
const state = async (orgId: string) => ({
  items: await items(orgId), links: await links(orgId), counters: await counters(orgId), audit: await allAuditCount(orgId),
});

async function addItem(orgId: string, by: string, name: string, over: Record<string, unknown> = {}): Promise<string> {
  const o = { kind: 'raw_material', base_unit: 'kg', status: 'active', merged_into_id: null as string | null, ...over };
  const stem = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase().padEnd(4, 'X');
  const [r] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, status, merged_into_id, created_by)
    values (${orgId}, ${`${stem}-${String(900 + (++seq % 99))}`}, ${name}, ${o.kind as string}, ${o.base_unit as string}, ${o.status as string}, ${o.merged_into_id}, ${by})
    returning id`;
  return r!.id;
}

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('S3 apply - creates and links exactly the plan', () => {
  it(
    'creates every planned item with an allocated T-386 code, writes a link per record, one master_data_load audit row. Killing mutants: a create skipped; a link not written; the code passed as an override; no audit row. Red today: scripts/lib/master-data-apply does not exist',
    async () => {
      const e = await env('A');
      const s = snap([
        rec(L, 'Pork Belly'), rec(M, 'pork belly '), rec(L, 'White Onion'), rec(M, 'White Onion'), rec(B, 'Soy Sauce', 'ltr'), rec(L, 'Garlic', 'kg'),
      ]);
      const plan = planOf(e, s);
      const wantCreates = plan.writes.filter((w: Any) => w.op === 'create');
      const wantLinks = wantCreates.reduce((n: number, w: Any) => n + w.links.length, 0);
      expect(plan.held).toBe(0);
      expect(wantCreates.length).toBe(4);

      const r = await run(e, s);
      expect(r).toMatchObject({ dryRun: false, created: 4, linked: wantLinks, held: 0 });

      const got = await items(e.orgId);
      expect(got.map((i) => key(i.name)).sort()).toEqual(wantCreates.map((w: Any) => key(w.name)).sort());
      for (const i of got) {
        expect(i.code).toMatch(/^[A-Z0-9]{4}-\d{3}$/); // T-386 shape: allocated, not typed
        expect(i.status).toBe('active');
      }
      expect(new Set(got.map((i) => i.code)).size).toBe(got.length);
      expect((await counters(e.orgId)).length).toBeGreaterThan(0);

      const ls = await links(e.orgId);
      expect(ls).toHaveLength(wantLinks);
      const byId = new Map(got.map((i) => [i.id, i]));
      for (const l of ls) {
        expect(l.entity).toBe('item');
        expect(byId.has(l.v2_id)).toBe(true); // I4: resolves, same org
        expect(l.created_by).toBe(e.superA.personId);
      }
      const onion = got.find((i) => key(i.name) === 'white onion')!;
      expect(ls.filter((l) => l.v2_id === onion.id).map((l) => l.v1_store_id).sort()).toEqual([L, M].sort());

      const audits = await loadAudits(e.orgId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'master_data.items_load', entity: 'items', actor_person_id: e.superA.personId });
      expect(audits[0].entity).toBe('items');
      expect(audits[0].after).toMatchObject({ snapshotSha: SHA, created: 4, linked: wantLinks, held: 0 });
      expect(JSON.stringify(audits[0].after.stores)).toMatch(/LIPA/);
    },
    60_000,
  );

  it(
    'the audit row names a source the audit_log CHECK allows. Ruled: source is etl (audit_log_source_check has no script). Killing mutant: a source outside the list (the insert is refused and the apply fails)',
    async () => {
      const e = await env('AS');
      await run(e, snap([rec(L, 'Rice')]));
      const [a] = await loadAudits(e.orgId);
      expect(a!.source).toBe('etl');
    },
    60_000,
  );

  it(
    'a box-counted item gets its buying unit from the items-box answer: base unit pcs, purchase unit box x24, link factor 24, one set_item_purchase_unit audit row. Killing mutants: purchase unit never set; the box used as the base unit; setItemPurchaseUnit bypassed (no audit row)',
    async () => {
      const e = await env('BX');
      const s = snap([
        rec(L, 'Paper Cups', 'box', 'supply', { purchaseUnit: 'pcs', conversionFactor: 24 }),
        rec(M, 'Paper Cups', 'box', 'supply', { purchaseUnit: 'pcs', conversionFactor: 24 }),
      ]);
      const first = planOf(e, s);
      expect(first.held).toBeGreaterThan(0);
      const row = first.sheets['items-box'][0];
      expect(row).toBeTruthy();
      const answers = { 'items-box': [{ ...row, inside_unit: 'pcs', how_many: '24' }] };

      expect(String(((await failure(run(e, s))) as Error).message)).toMatch(/held/i); // unanswered
      expect(await items(e.orgId)).toHaveLength(0);

      const r = await run(e, s, { answers });
      expect(r).toMatchObject({ created: 1, linked: 2, held: 0 });
      const [cups] = await items(e.orgId);
      expect(cups!.base_unit).toBe('pcs');
      expect(cups!.purchase_unit).toBe('box');
      expect(Number(cups!.purchase_factor)).toBe(24);
      const ls = await links(e.orgId);
      expect(ls.map((l) => [l.v1_unit, Number(l.factor_to_base)])).toEqual([['box', 24], ['box', 24]]);
      const a = await sql<Any[]>`select actor_person_id from audit_log where org_id = ${e.orgId} and action = 'set_item_purchase_unit' and entity_id = ${cups!.id}`;
      expect(a).toHaveLength(1);
      expect(a[0]!.actor_person_id).toBe(e.superA.personId);
    },
    60_000,
  );

  it(
    'a unit mismatch against an existing v2 item is HELD until a factor is given; with the factor it links, and the existing item is not touched (I7). Killing mutants: link at factor 1 without an answer; updateItem/unit change on mismatch',
    async () => {
      const e = await env('MM');
      const sugar = await addItem(e.orgId, e.superA.personId, 'Sugar', { base_unit: 'kg' });
      const before = (await items(e.orgId))[0];
      const s = snap([rec(L, 'Sugar', 'pcs')]);
      const first = planOf(e, s, { existing: [{ id: sugar, name: 'Sugar', status: 'active', baseUnit: 'kg', kind: 'raw_material', mergedIntoId: null }] });
      expect(first.held).toBeGreaterThan(0);
      const row = first.sheets['items-units'][0];

      expect(String(((await failure(run(e, s))) as Error).message)).toMatch(/held/i);
      expect(await links(e.orgId)).toHaveLength(0);

      const r = await run(e, s, { answers: { 'items-units': [{ ...row, factor: '0.5' }] } });
      expect(r).toMatchObject({ created: 0, linked: 1, held: 0 });
      const [l] = await links(e.orgId);
      expect(l!.v2_id).toBe(sugar);
      expect(l!.v1_unit).toBe('pcs');
      expect(Number(l!.factor_to_base)).toBe(0.5);
      const after = await items(e.orgId);
      expect(after).toHaveLength(1);
      expect(after[0]).toEqual(before);
    },
    60_000,
  );

  it(
    'a merged item is followed to its winner (never linked to the loser); an inactive one is held and never re-created. Killing mutants: link to the merged loser; create a second item for a retired name',
    async () => {
      const e = await env('MG');
      const win = await addItem(e.orgId, e.superA.personId, 'Jasmine Rice');
      const lose = await addItem(e.orgId, e.superA.personId, 'Old Rice', { status: 'merged', merged_into_id: win });
      await addItem(e.orgId, e.superA.personId, 'Retired Napkin', { status: 'inactive', base_unit: 'pcs', kind: 'supply' });
      const before = await items(e.orgId);

      const merged = snap([rec(L, 'Old Rice')]);
      const r = await run(e, merged);
      expect(r).toMatchObject({ created: 0, linked: 1 });
      const [l] = await links(e.orgId);
      expect(l!.v2_id).toBe(win);
      expect(l!.v2_id).not.toBe(lose);

      const retired = snap([rec(M, 'Retired Napkin', 'pcs', 'supply')]);
      expect(String(((await failure(run(e, retired))) as Error).message)).toMatch(/held/i); // held for link_inactive
      const after = await items(e.orgId);
      expect(after).toHaveLength(before.length);
      expect(after.filter((i) => key(i.name) === 'retired napkin')).toHaveLength(1);
      expect(await links(e.orgId)).toHaveLength(1);
    },
    60_000,
  );

  it(
    'a look-alike of an existing v2 name is held, not created next to it. Killing mutant: the twin check ignores existing v2 names (a second "Coke 1.5" next to "Coke 15")',
    async () => {
      const e = await env('LK');
      await addItem(e.orgId, e.superA.personId, 'Coke 15', { base_unit: 'ltr' });
      const err = await failure(run(e, snap([rec(L, 'Coke 1.5', 'ltr')])));
      expect(String((err as Error).message)).toMatch(/held/i);
      expect(await items(e.orgId)).toHaveLength(1);
      expect(await links(e.orgId)).toHaveLength(0);
    },
    60_000,
  );
});

describe('S3 apply - idempotence, dry run, held', () => {
  it(
    'a second apply changes nothing: no item, no link, counters unchanged, no new audit row except the apply row itself. Killing mutants: the code allocated before the existing-name check; links re-inserted',
    async () => {
      const e = await env('ID');
      const s = snap([rec(L, 'Pork Belly'), rec(M, 'Pork Belly'), rec(L, 'Flour'), rec(B, 'Soy Sauce', 'ltr')]);
      await run(e, s);
      const one = await state(e.orgId);
      expect(one.items.length).toBe(3);

      const r = await run(e, s);
      expect(r).toMatchObject({ created: 0, linked: 0, held: 0 });
      const two = await state(e.orgId);
      expect(two.items).toEqual(one.items);
      expect(two.links).toEqual(one.links);
      expect(two.counters).toEqual(one.counters); // I2: no code consumed
      expect(two.audit - one.audit).toBe(1); // the second apply row, nothing else
      const audits = await loadAudits(e.orgId);
      expect(audits).toHaveLength(2);
      expect(audits[1]!.after).toMatchObject({ created: 0, linked: 0 });
    },
    60_000,
  );

  it(
    'a dry run commits nothing (items, links, counters, audit all unchanged) and reports the counts the following apply writes. Killing mutant: commit in the dry run',
    async () => {
      const e = await env('DR');
      const s = snap([rec(L, 'Pork Belly'), rec(M, 'Pork Belly'), rec(L, 'Flour')]);
      const before = await state(e.orgId);
      const dry = await run(e, s, { apply: false });
      expect(dry.dryRun).toBe(true);
      expect(await state(e.orgId)).toEqual(before);
      const real = await run(e, s);
      expect({ created: dry.created, linked: dry.linked, held: dry.held }).toEqual({ created: real.created, linked: real.linked, held: real.held });
      expect(real.created).toBe(2);
    },
    60_000,
  );

  it(
    'anything held refuses the whole apply and writes nothing, not even the clean items. Killing mutant: apply what is ready, skip the held',
    async () => {
      const e = await env('HD');
      const s = snap([rec(L, 'Garlic Powder', 'kg'), rec(M, 'Garlic Powder', 'g'), rec(L, 'Flour')]); // a 1-1 unit tie
      expect(planOf(e, s).held).toBeGreaterThan(0);
      const before = await state(e.orgId);
      const err = await failure(run(e, s));
      expect(String((err as Error).message)).toMatch(/held/i);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );
});

describe('S3 apply - scope per store', () => {
  it(
    "--stores LIPA then --stores MLVR: Malvar links to Lipa's item, no duplicate, only Malvar-only names are created; out-of-scope records are never linked. Killing mutant: the exact key made per store",
    async () => {
      const e = await env('SC');
      const s = snap([rec(L, 'Garlic'), rec(M, 'Garlic'), rec(L, 'Cabbage'), rec(M, 'Tomato'), rec(B, 'Ginger')]);

      const r1 = await run(e, s, { storeCodes: ['LIPA'] });
      expect(r1.created).toBe(2); // Garlic (Lipa's record) and Cabbage
      const ls1 = await links(e.orgId);
      expect(ls1.every((l) => l.v1_store_id === L)).toBe(true);
      expect((await items(e.orgId)).map((i) => i.name).sort()).toEqual(['Cabbage', 'Garlic']);

      const r2 = await run(e, s, { storeCodes: ['MLVR'] });
      expect(r2.created).toBe(1); // Tomato only
      const got = await items(e.orgId);
      expect(got.map((i) => i.name).sort()).toEqual(['Cabbage', 'Garlic', 'Tomato']); // no second Garlic
      const garlic = got.find((i) => i.name === 'Garlic')!;
      const ls2 = await links(e.orgId);
      expect(ls2.filter((l) => l.v2_id === garlic.id).map((l) => l.v1_store_id).sort()).toEqual([L, M].sort());
      expect(ls2.some((l) => l.v1_store_id === B)).toBe(false); // Banay-Banay was never in scope
      expect(got.find((i) => i.name === 'Ginger')).toBeUndefined();
    },
    60_000,
  );
});

describe('S3 apply - org boundary and actor', () => {
  it(
    "a run on the main org never writes a Padre Garcia record; a run on the PG org with the PG map row writes only PG's (I1). Killing mutant: the role filter removed",
    async () => {
      const e = await env('OB');
      const s = snap([rec(L, 'Charcoal', 'kg', 'supply'), rec(P, 'Franchise Napkin', 'pcs', 'supply'), rec(P, 'Charcoal', 'kg', 'supply')]);

      await run(e, s);
      expect((await items(e.orgId)).map((i) => i.name)).toEqual(['Charcoal']);
      expect((await links(e.orgId)).map((l) => l.v1_store_id)).toEqual([L]);
      expect(await items(e.pgOrgId)).toHaveLength(0);

      const r = await run(e, s, { orgId: e.pgOrgId, orgCode: e.pgCode, actor: e.pgSuper });
      expect(r.created).toBe(2);
      expect((await items(e.pgOrgId)).map((i) => i.name).sort()).toEqual(['Charcoal', 'Franchise Napkin']);
      expect((await links(e.pgOrgId)).every((l) => l.v1_store_id === P)).toBe(true);
      expect(await items(e.orgId)).toHaveLength(1); // the main org gained nothing from the PG run
    },
    60_000,
  );

  it(
    "the PG org-code pointed at the main org's id is refused before any write (assertRunTarget). Killing mutant: the target check dropped",
    async () => {
      const e = await env('RT');
      const s = snap([rec(P, 'Franchise Napkin', 'pcs', 'supply')]);
      const before = await state(e.orgId);
      const err = await failure(run(e, s, { orgCode: e.pgCode }));
      expect(String((err as Error).message)).toMatch(/refused|--org/i);
      expect(await state(e.orgId)).toEqual(before);
      expect(await items(e.pgOrgId)).toHaveLength(0);
    },
    60_000,
  );

  it.each(['admin', 'manager'] as const)(
    '%s lacks approve_item: the domain gate refuses (AuthorizationError), nothing is written. Killing mutant: a repo insert that skips createItem',
    async (who) => {
      const e = await env(`AU${who[0]}`);
      const before = await state(e.orgId);
      const err = await failure(run(e, snap([rec(L, 'Flour')]), { actor: e[who] }));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );

  it(
    "no actor, or an actor of another org, is refused and nothing is written. Killing mutants: a default actor (firstPersonId); the actor's org not compared with --org",
    async () => {
      const e = await env('NA');
      const s = snap([rec(L, 'Flour')]);
      const before = await state(e.orgId);
      expect(String(((await failure(run(e, s, { actor: undefined }))) as Error).message)).toMatch(/actor/i);
      expect(String(((await failure(run(e, s, { actor: e.pgSuper }))) as Error).message)).toMatch(/actor|org/i);
      expect(await state(e.orgId)).toEqual(before);
      expect(await items(e.pgOrgId)).toHaveLength(0);
    },
    60_000,
  );
});

describe('S3 apply - one apply at a time per org (R16)', () => {
  it(
    'holding the org lock (pg_advisory_xact_lock(hashtext of master-data: + org_id)) on another connection blocks an apply; it completes after release with each item created once. Killing mutant: the lock removed, a different key, or the plan read before taking it',
    async () => {
      const e = await env('LC');
      const s = snap(Array.from({ length: 6 }, (_, i) => `Lock Item ${i}`).flatMap((n) => [rec(L, n), rec(M, n)]));
      const apply = await applyFn();
      const holder = postgres(url!, { max: 1 });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const gotLock = new Promise<void>((r) => (locked = r));
      const held = holder.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('master-data:' || ${e.orgId}::text))`;
        locked();
        await gate;
      });
      await gotLock;
      let done = false;
      const p = apply({ snapshot: s, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.superA, apply: true }).then((r) => {
        done = true;
        return r;
      });
      p.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 2500));
      expect(done).toBe(false);
      expect(await items(e.orgId)).toHaveLength(0);
      release();
      await held;
      await holder.end({ timeout: 5 });
      const r = await p;
      expect(r.created).toBe(6);
      expect(await items(e.orgId)).toHaveLength(6);
      expect(await links(e.orgId)).toHaveLength(12);
    },
    60_000,
  );

  it(
    'two overlapping applies create each item once: the second waits, then finds the links and writes nothing (created 0). Never a unique violation, never a refusal. Killing mutant: lock removed',
    async () => {
      const e = await env('LD');
      const s = snap(Array.from({ length: 30 }, (_, i) => `Dup Item ${i}`).flatMap((n) => [rec(L, n), rec(M, n)]));
      const apply = await applyFn();
      const go = () => apply({ snapshot: s, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.superA, apply: true });
      const rs = await Promise.all([go(), go()]);
      expect(rs.map((r) => r.created).sort((a, b) => a - b)).toEqual([0, 30]);
      expect(await items(e.orgId)).toHaveLength(30);
      expect(await links(e.orgId)).toHaveLength(60);
      expect(await loadAudits(e.orgId)).toHaveLength(2);
    },
    120_000,
  );
});
