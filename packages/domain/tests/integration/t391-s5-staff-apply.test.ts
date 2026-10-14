import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-391 S5 - `docs/tasks/391-production-master-data-load.md`, tests 22 and 26 (+ S1-S9, R2, R4, R8, R15, R16, I1, I2, I4, I7, I9). TESTER file.
 * Real Postgres. The positions and staff APPLY, and createEmployment's staffCode override.
 *
 * CONTRACT these tests pin (the spec names files, not signatures - the builder builds to this):
 *   scripts/lib/master-data-apply.ts
 *     applyPositions(input) and applyStaff(input), each -> Promise<{ dryRun: boolean; created: number; linked: number; held: number }>
 *       input = applyItems' input ({ snapshot, snapshotSha, map, orgId, orgCode, storeCodes?, answers, actor, apply });
 *       the plan is planStaff(...) (packages/etl/src/master-data/staff-plan.ts, see t391-s5-staff-plan.test.ts) run INSIDE the locked
 *       transaction (same lock key as S3). applyPositions executes only the plan's position creates (upsertStorePosition, so
 *       `manage_store_settings` at that store); applyStaff executes the person and employment writes (createPerson + createEmployment,
 *       so `enrol_staff` at each store). `created` = EMPLOYMENTS created (applyStaff) / store positions created (applyPositions);
 *       `linked` = v1_master_links rows inserted (entity 'person' / 'employment' / 'position').
 *       Links: employment -> (v1_store_id = the v1 store, v1_id = the v1 staff id, v2_id = the employment);
 *              person     -> (v1_store_id '' and v1_id = the group id for an identity group; the store and staff id otherwise).
 *       Refuses (writes nothing, not even the clean rows) when held > 0 (/held/i), no actor, an actor of another org, assertRunTarget fails;
 *       AuthorizationError when the actor lacks enrol_staff at ANY store in scope, checked before the first write.
 *       One audit row per apply: action 'master_data_load', entity 'positions' | 'staff' (or the singular), source 'etl',
 *       after = { snapshotSha, stores, created, linked, held }, actor_person_id = the actor.
 *     applyMasterData({ ..., only?: ('items'|'suppliers'|'customers'|'positions'|'staff')[] }) gains 'positions' and 'staff' (R3 order:
 *       positions before staff) and returns them under result.positions / result.staff. In a DRY RUN the entities share ONE outer
 *       transaction (R2), so staff see the positions the same run planned, and the whole thing is rolled back.
 *   @shareat/domain: createEmployment(tx, actor, { ..., staffCode?: string })
 *       gated by enrol_staff (as today); shape SE-NNN (three digits) else refused; refused when the code is taken at that store;
 *       every refusal is an error carrying a non-empty `userReason`; ONE audit_log row (entity 'employments', entity_id = the employment)
 *       when the override is used, and none otherwise; later plain hires keep max + 1.
 *
 * Each test names its killing mutant. Red today: the apply functions do not exist; createEmployment ignores staffCode.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, withOrgPrincipal } from '@shareat/db';
import { AuthorizationError, type Actor } from '@shareat/auth';
import { parseStoreMap } from '../../../etl/src/master-data/store-map';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${++seq}`.toUpperCase();

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const P = 'y1DMgfisuTHBF57cNL6i';
const SHA = 'c'.repeat(64);

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
  stores: Record<string, string>;
  pgStoreId: string;
  map: Any[];
  superA: Actor;
  superPg: Actor;
  admin: Actor;
  manager: Actor; // manager scoped to LIPA only
  staff: Actor;
}

async function mkOrg(code: string, storeCodes: string[]) {
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  const stores: Record<string, string> = {};
  for (const sc of storeCodes) {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${sc}, ${`Store ${sc}`}) returning id`;
    stores[sc] = s!.id;
  }
  const first = Object.values(stores)[0]!;
  const mk = async (name: string, role: string, all = false) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const sid of all ? Object.values(stores) : [first]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${sid})`;
    return p!.id;
  };
  await withOrgPrincipal(orgId, async (tx: Any) => (await dom()).seedCanonicalPositions(tx, orgId));
  return { orgId, stores, mk };
}

async function env(hint: string): Promise<Env> {
  const orgCode = uid(`S${hint}`);
  const pgCode = uid(`G${hint}`);
  const a = await mkOrg(orgCode, ['LIPA', 'MLVR', 'BNBN']);
  const b = await mkOrg(pgCode, ['PGAR']);
  const act = (orgId: string, personId: string): Actor => ({ orgId, personId });
  return {
    orgId: a.orgId,
    orgCode,
    pgOrgId: b.orgId,
    pgCode,
    stores: a.stores,
    pgStoreId: b.stores.PGAR!,
    map: parseStoreMap(mapCsv(orgCode, pgCode)),
    superA: act(a.orgId, await a.mk('Super', 'super_admin', true)),
    superPg: act(b.orgId, await b.mk('SuperPg', 'super_admin', true)),
    admin: act(a.orgId, await a.mk('Admin', 'admin', true)),
    manager: act(a.orgId, await a.mk('Manager', 'manager')),
    staff: act(a.orgId, await a.mk('Staff', 'staff')),
  };
}

let rid = 0;
const stf = (store: string, name: string, over: Record<string, unknown> = {}): Any => ({
  id: `st${++rid}`, store, staffCode: '', fullName: name, positions: ['Cook'], employmentStatus: 'regular', dateHired: '2026-01-05T00:00:00.000Z', isActive: true, ...over,
});
const snap = (staff: Any[] = [], staffIdentities: Any[] = []): Any => ({
  version: 1, stores: [], items: [], suppliers: [], arCustomers: [], staff, staffIdentities,
});

type ApplyResult = { dryRun: boolean; created: number; linked: number; held: number };
async function apply(): Promise<Any> {
  return import('../../../../scripts/lib/master-data-apply');
}
async function dom(): Promise<Any> {
  return import('@shareat/domain');
}
/** The load, positions then staff, the way `run --only positions --only staff` does. */
async function run(e: Env, snapshot: Any, over: Record<string, unknown> = {}): Promise<{ positions: ApplyResult; staff: ApplyResult }> {
  const mod = await apply();
  return mod.applyMasterData({
    snapshot, snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, actor: e.superA, apply: true, only: ['positions', 'staff'], ...over,
  });
}
async function failure(p: PromiseLike<unknown>): Promise<any> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to be refused');
}
/** The sheet rows the planner emits for this snapshot, read against the org's real positions, then filled. */
async function sheetRows(e: Env, snapshot: Any, sheetName: string, over: Record<string, unknown> = {}): Promise<Any[]> {
  const mod: Any = await import('../../../etl/src/master-data/staff-plan');
  const byId = Object.fromEntries(Object.entries(e.stores).map(([code, id]) => [id, code]));
  const pos = await sql<Any[]>`select id, name, store_id from positions where org_id = ${e.orgId}`;
  const ps = await sql<Any[]>`select id, display_name from persons where org_id = ${e.orgId}`;
  const p = mod.planStaff({
    snapshot, map: e.map, orgCode: e.orgCode,
    existingPositions: pos.map((x) => ({ id: x.id, name: x.name, storeCode: x.store_id ? byId[x.store_id] ?? null : null })),
    existingPersons: ps.map((x) => ({ id: x.id, displayName: x.display_name })),
    links: [], answers: {}, ...over,
  });
  return p.sheets[sheetName] as Any[];
}
const fill = (rows: Any[], f: Record<string, string>): Any[] => rows.map((r) => ({ ...r, ...f }));

const personsOf = (orgId: string) => sql<Any[]>`select id, display_name, org_id from persons where org_id = ${orgId} and display_name not in ('Super','SuperPg','Admin','Manager','Staff') order by display_name`;
const emps = (orgId: string) =>
  sql<Any[]>`select e.id, e.person_id, e.staff_code, e.employment_status, e.started_on::text as started_on, e.ended_on, s.code as store_code, p.display_name
    from employments e join stores s on s.id = e.store_id join persons p on p.id = e.person_id
    where e.org_id = ${orgId} and p.display_name not in ('Super','SuperPg','Admin','Manager','Staff') order by p.display_name, s.code`;
const empPositions = (employmentId: string) =>
  sql<Any[]>`select po.name, ep.is_primary, po.store_id from employment_positions ep join positions po on po.id = ep.position_id where ep.employment_id = ${employmentId} order by po.name`;
const storePositions = (orgId: string) => sql<Any[]>`select po.name, s.code as store_code from positions po join stores s on s.id = po.store_id where po.org_id = ${orgId} order by po.name`;
const links = (orgId: string, entity: string) =>
  sql<Any[]>`select entity, v1_store_id, v1_id, v2_id, v1_unit, factor_to_base, created_by from v1_master_links where org_id = ${orgId} and entity = ${entity} order by v1_id`;
const audits = (orgId: string, action: string) =>
  sql<Any[]>`select action, entity, entity_id, before, after, source, actor_person_id from audit_log where org_id = ${orgId} and action = ${action} order by occurred_at, id`;
// T-402 S2: a refused authorize() now leaves a first-of-day `security.authorize_denied` row (written outside the refused
// transaction), so "nothing was written" counts every row except those; the denial rows are asserted explicitly where a test refuses.
const auditCount = async (orgId: string) =>
  Number((await sql<Any[]>`select count(*)::int as n from audit_log where org_id = ${orgId} and action <> 'security.authorize_denied'`)[0]!.n);
const denialCount = async (orgId: string) =>
  Number((await sql<Any[]>`select count(*)::int as n from audit_log where org_id = ${orgId} and action = 'security.authorize_denied'`)[0]!.n);
const count = async (table: string, orgId: string) => Number((await sql.unsafe(`select count(*)::int as n from ${table} where org_id = $1`, [orgId]))[0]!.n);
const state = async (orgId: string) => ({
  persons: await personsOf(orgId),
  emps: await emps(orgId),
  positions: await count('positions', orgId),
  links: await count('v1_master_links', orgId),
  audit: await auditCount(orgId),
  roles: await count('person_roles', orgId),
  scope: Number((await sql<Any[]>`select count(*)::int as n from person_store_scope pss join persons p on p.id = pss.person_id where p.org_id = ${orgId}`)[0]!.n),
});
/** Everything that grants a person access, normalised so two persons can be compared. */
async function access(personId: string): Promise<Any> {
  const roles = await sql<Any[]>`select role from person_roles where person_id = ${personId} and revoked_at is null order by role`;
  const scope = await sql<Any[]>`select s.code from person_store_scope pss join stores s on s.id = pss.store_id where pss.person_id = ${personId} order by s.code`;
  const grants = await sql<Any[]>`select grant_name, grant_source from person_grants where person_id = ${personId} and revoked_at is null order by grant_name`;
  return { roles: roles.map((r) => r.role), scope: scope.map((r) => r.code), grants: grants.map((r) => `${r.grant_name}/${r.grant_source}`) };
}
const lastCode = async (storeId: string): Promise<string | undefined> =>
  (await sql<Any[]>`select staff_code from employments where store_id = ${storeId} order by staff_code desc limit 1`)[0]?.staff_code;

async function call(orgId: string, name: string, actor: Actor, input: Record<string, unknown>): Promise<any> {
  const f = (await dom())[name];
  if (typeof f !== 'function') throw new Error(`@shareat/domain does not export ${name}`);
  return withOrgPrincipal(orgId, (tx: Any) => f(tx, actor, input));
}
async function newPerson(e: Env, name: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${e.orgId}, ${name}) returning id`;
  return p!.id;
}
const hire = (e: Env, actor: Actor, personId: string, storeCode: string, over: Record<string, unknown> = {}) =>
  call(e.orgId, 'createEmployment', actor, { storeId: e.stores[storeCode], personId, employmentStatus: 'regular', startedOn: '2026-01-05', ...over });

beforeAll(async () => {
  await sql`select 1`;
});
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('S5 apply - the staffCode override (S9)', () => {
  it(
    'a code is kept: the employment carries SE-014, ONE audit row names it, and the next plain hire at that store gets SE-015 (max + 1). Killing mutants: the override ignored; no audit row; the counter not following the override',
    async () => {
      const e = await env('OV');
      const a = await newPerson(e, 'Override One');
      const b = await newPerson(e, 'Plain Two');
      const emp = await hire(e, e.superA, a, 'LIPA', { staffCode: 'SE-014' });
      expect(emp.staffCode).toBe('SE-014');
      // T-402 S2: createEmployment also writes employment.created for the hire; the override row is still exactly one.
      const all = await sql<Any[]>`select action, after, actor_person_id from audit_log where org_id = ${e.orgId} and entity_id = ${emp.id}`;
      expect(all.map((r) => r.action).sort()).toEqual(['employment.created', 'set_staff_code']);
      const au = all.filter((r) => r.action === 'set_staff_code');
      expect(au).toHaveLength(1);
      expect(JSON.stringify(au[0]!.after)).toContain('SE-014');
      expect(au[0]!.actor_person_id).toBe(e.superA.personId);
      const next = await hire(e, e.superA, b, 'LIPA');
      expect(next.staffCode).toBe('SE-015');
    },
    60_000,
  );

  it(
    'a plain hire still allocates (SE-001) and writes NO override audit row. Killing mutant: the audit row written for every hire',
    async () => {
      const e = await env('NO');
      const emp = await hire(e, e.superA, await newPerson(e, 'Plain One'), 'LIPA');
      expect(emp.staffCode).toBe('SE-001');
      // T-402 S2: the hire writes employment.created, and nothing else (no override row).
      expect((await sql<Any[]>`select action from audit_log where org_id = ${e.orgId} and entity_id = ${emp.id}`).map((r) => r.action)).toEqual(['employment.created']);
    },
    60_000,
  );

  it(
    'a code TAKEN at that store is refused with a userReason; nothing is written (no employment, no audit row, no role). The same code at ANOTHER store is fine. Killing mutant: the override accepting a taken code',
    async () => {
      const e = await env('TK');
      await hire(e, e.superA, await newPerson(e, 'First Holder'), 'LIPA', { staffCode: 'SE-005' });
      const second = await newPerson(e, 'Second Claimant');
      const before = await auditCount(e.orgId);
      const err = await failure(hire(e, e.superA, second, 'LIPA', { staffCode: 'se-005' }));
      expect(typeof err.userReason).toBe('string');
      expect(err.userReason.length).toBeGreaterThan(0);
      expect(err.userReason).toMatch(/SE-005/i);
      expect(await sql<Any[]>`select 1 from employments where person_id = ${second}`).toHaveLength(0);
      expect(await sql<Any[]>`select 1 from person_roles where person_id = ${second}`).toHaveLength(0);
      expect(await auditCount(e.orgId)).toBe(before);
      const other = await hire(e, e.superA, second, 'MLVR', { staffCode: 'SE-005' });
      expect(other.staffCode).toBe('SE-005');
    },
    60_000,
  );

  it.each(['SE-14', 'SE-1000', 'EMP-014', '014', 'SE014', 'SE-0x4'])(
    'a malformed code %s is refused with a userReason and writes nothing. Killing mutant: no shape check',
    async (bad) => {
      const e = await env('SH');
      const p = await newPerson(e, 'Shape Sam');
      const err = await failure(hire(e, e.superA, p, 'LIPA', { staffCode: bad }));
      expect(typeof err.userReason).toBe('string');
      expect(err.userReason.length).toBeGreaterThan(0);
      expect(await sql<Any[]>`select 1 from employments where person_id = ${p}`).toHaveLength(0);
    },
    60_000,
  );

  it(
    'the override is gated on enrol_staff at that store: a staff actor, and a manager scoped to Lipa hiring at Malvar, are refused (AuthorizationError) with nothing written. Killing mutant: the gate skipped when staffCode is set',
    async () => {
      const e = await env('GT');
      const p = await newPerson(e, 'Gate Gus');
      const before = await auditCount(e.orgId);
      expect(await failure(hire(e, e.staff, p, 'LIPA', { staffCode: 'SE-009' }))).toBeInstanceOf(AuthorizationError);
      expect(await failure(hire(e, e.manager, p, 'MLVR', { staffCode: 'SE-009' }))).toBeInstanceOf(AuthorizationError);
      expect(await sql<Any[]>`select 1 from employments where person_id = ${p}`).toHaveLength(0);
      expect(await auditCount(e.orgId)).toBe(before);
      expect(await denialCount(e.orgId), 'T-402 S2: each refused actor leaves one denial row').toBe(2);
      const ok = await hire(e, e.manager, p, 'LIPA', { staffCode: 'SE-009' }); // a manager at their own store may
      expect(ok.staffCode).toBe('SE-009');
    },
    60_000,
  );
});

describe('S5 apply - persons, employments, positions, links, audit', () => {
  it(
    'positions and staff as planned: v1 codes kept, blank and duplicate codes allocated, status and Manila date stored, links and audit rows written. Killing mutants: a code not kept; a link not written; no audit row; UTC date',
    async () => {
      const e = await env('A');
      const s = snap([
        stf(L, 'Ana Reyes', { staffCode: 'SE-014', positions: ['Cashier'], dateHired: '2026-03-01T17:00:00.000Z' }),
        stf(L, 'Ben Cruz', { staffCode: '', positions: ['Cook', 'Server'], employmentStatus: 'part-time' }),
        stf(M, 'Cai Dela Rosa', { staffCode: 'SE-003', positions: ['Slicer'] }),
        stf(M, 'Dee Ocampo', { staffCode: 'SE-003', positions: ['Dishwasher'], dateHired: '2026-06-01T00:00:00.000Z' }),
        stf(L, 'Gone Gina', { isActive: false }),
        stf(L, 'Quit Quin', { employmentStatus: 'resigned' }),
      ]);
      const r = await run(e, s);
      expect(r.staff).toMatchObject({ dryRun: false, created: 4, held: 0 });

      const got = await emps(e.orgId);
      expect(got.map((x) => x.display_name)).toEqual(['Ana Reyes', 'Ben Cruz', 'Cai Dela Rosa', 'Dee Ocampo']);
      const ana = got.find((x) => x.display_name === 'Ana Reyes')!;
      expect(ana).toMatchObject({ staff_code: 'SE-014', started_on: '2026-03-02', store_code: 'LIPA', employment_status: 'regular' });
      expect(got.find((x) => x.display_name === 'Ben Cruz')).toMatchObject({ employment_status: 'part-time' });
      const malvar = got.filter((x) => x.store_code === 'MLVR');
      expect(new Set(malvar.map((x) => x.staff_code)).size).toBe(2); // the duplicate did not collide
      expect(malvar.find((x) => x.display_name === 'Cai Dela Rosa')!.staff_code).toBe('SE-003'); // S11: earliest dateHired keeps the duplicate
      expect((await empPositions(ana.id)).map((x) => x.name)).toEqual(['Cashier']);
      const ben = await empPositions(got.find((x) => x.display_name === 'Ben Cruz')!.id);
      expect(ben.map((x) => x.name)).toEqual(['Cook', 'Server']);
      expect(ben.filter((x) => x.is_primary).map((x) => x.name)).toEqual(['Cook']);

      const el = await links(e.orgId, 'employment');
      expect(el).toHaveLength(4);
      for (const l of el) {
        expect(l.v1_unit).toBeNull();
        expect(l.factor_to_base).toBeNull();
        expect(l.created_by).toBe(e.superA.personId);
        expect(got.some((x) => x.id === l.v2_id)).toBe(true); // I4
      }
      const pl = await links(e.orgId, 'person');
      expect(pl.length).toBeGreaterThanOrEqual(4);
      const pids = new Set((await personsOf(e.orgId)).map((x) => x.id));
      for (const l of pl) expect(pids.has(l.v2_id)).toBe(true); // I4

      const a = await audits(e.orgId, 'master_data.staff_load');
      const staffAudit = a.filter((x) => x.entity === 'staff');
      expect(staffAudit).toHaveLength(1);
      expect(staffAudit[0]).toMatchObject({ source: 'etl', actor_person_id: e.superA.personId });
      expect(staffAudit[0]!.after).toMatchObject({ snapshotSha: SHA, created: 4, held: 0 });
      expect(JSON.stringify(staffAudit[0]!.after.stores)).toMatch(/LIPA/);
      // the two kept codes (SE-014, SE-003) are audited by createEmployment itself
      // T-402 S2: plus the employment.created row every hire now writes.
      expect((await sql<Any[]>`select action from audit_log where org_id = ${e.orgId} and entity_id = ${ana.id}`).map((r) => r.action).sort()).toEqual(['employment.created', 'set_staff_code']);
    },
    90_000,
  );

  it(
    'a `new:` position is created at THAT store only (by the answer), the staff get it as primary, and a Malvar cook is untouched. Killing mutants: created org-wide or at every store; one create per staff member',
    async () => {
      const e = await env('NP');
      const s = snap([stf(L, 'Gil One', { positions: ['Griller'] }), stf(L, 'Gil Two', { positions: ['Griller'] }), stf(M, 'Mal Three', { positions: ['Cook'] })]);
      const rows = await sheetRows(e, s, 'positions');
      const answers = { positions: fill(rows, { v2_position: 'new:Grill Master' }) };
      const r = await run(e, s, { answers });
      expect(r.positions.created).toBe(1);
      expect(r.staff.created).toBe(3);
      expect(await storePositions(e.orgId)).toEqual([{ name: 'Grill Master', store_code: 'LIPA' }]);
      const got = await emps(e.orgId);
      for (const nm of ['Gil One', 'Gil Two']) {
        const ps = await empPositions(got.find((x) => x.display_name === nm)!.id);
        expect(ps.map((x) => x.name)).toEqual(['Grill Master']);
      }
      expect((await empPositions(got.find((x) => x.display_name === 'Mal Three')!.id)).map((x) => x.name)).toEqual(['Cook']);
      const pa = (await audits(e.orgId, 'master_data.positions_load')).filter((x) => x.entity === 'positions');
      expect(pa).toHaveLength(1);
    },
    90_000,
  );

  it(
    'S4: an identity group is ONE person with an employment at each store; a same-name pair stays held (the whole apply refuses, nothing written) until answered `same`. Killing mutants: one person per store record; the held pair written anyway',
    async () => {
      const e = await env('ID');
      const a = stf(L, 'Ana Reyes');
      const b = stf(M, 'Ana M Reyes');
      const grp = snap([a, b], [{ id: 'grp1', staffRefs: [{ storeId: L, staffId: a.id }, { storeId: M, staffId: b.id }] }]);
      await run(e, grp);
      expect(await personsOf(e.orgId)).toHaveLength(1);
      expect(await emps(e.orgId)).toHaveLength(2);
      expect((await links(e.orgId, 'person')).some((l) => l.v1_store_id === '' && l.v1_id === 'grp1')).toBe(true);

      const e2 = await env('ID2');
      const pair = snap([stf(L, 'Carla Dizon'), stf(M, 'Carla Dizon'), stf(L, 'Clean Cora')]);
      const before = await state(e2.orgId);
      expect((await failure(run(e2, pair))).message).toMatch(/held/i);
      expect(await state(e2.orgId)).toEqual(before); // not even Clean Cora
      const rows = await sheetRows(e2, pair, 'staff-same-person');
      await run(e2, pair, { answers: { 'staff-same-person': fill(rows, { same_or_different: 'same' }) } });
      expect((await personsOf(e2.orgId)).map((x) => x.display_name).sort()).toEqual(['Carla Dizon', 'Clean Cora']);
      expect(await emps(e2.orgId)).toHaveLength(3);
    },
    90_000,
  );

  it(
    'a same-name EXISTING v2 person answered `same` is employed, not duplicated (the hand-hired fallback of the Rollout). Killing mutant: a second person created',
    async () => {
      const e = await env('EX');
      const existing = await newPerson(e, 'Dino Evangelista');
      const s = snap([stf(L, 'Dino Evangelista')]);
      const rows = await sheetRows(e, s, 'staff-same-person');
      expect(rows).toHaveLength(1);
      await run(e, s, { answers: { 'staff-same-person': fill(rows, { same_or_different: 'same' }) } });
      expect(await sql<Any[]>`select id from persons where org_id = ${e.orgId} and display_name = 'Dino Evangelista'`).toHaveLength(1);
      const got = await emps(e.orgId);
      expect(got).toHaveLength(1);
      expect(got[0]!.person_id).toBe(existing);
    },
    60_000,
  );
});

describe('S5 apply - S2 / I9: nothing beyond the hire baseline', () => {
  it(
    'every imported person holds EXACTLY what a plain createEmployment hire holds (the staff role, the store scope, the position-default grants), whatever their v1 positions; no manager/admin/super_admin row, no PIN, no credential. Killing mutants: an access row written for `Manager`; a role or grant beyond the baseline; a credential issued',
    async () => {
      const e = await env('I9');
      const s = snap([
        stf(L, 'Mia Boss', { positions: ['Manager'] }),
        stf(L, 'Sup Sol', { positions: ['Supervisor', 'Cashier'] }),
        stf(L, 'Cy Cashier', { positions: ['Cashier'] }),
        stf(M, 'Max Cook', { positions: ['Cook'] }),
      ]);
      const rows = await sheetRows(e, s, 'positions');
      expect(rows.length).toBe(2); // Manager and Supervisor need an answer
      await run(e, s, { answers: { positions: fill(rows, { v2_position: 'none' }) } });
      // the control: the same positions hired through the plain domain call as the super admin
      const ctl: Record<string, Any> = {};
      for (const [nm, store, positions] of [['Cashier', 'LIPA', ['Cashier']], ['Cook', 'MLVR', ['Cook']], ['Default', 'LIPA', []]] as const) {
        const pid = await newPerson(e, `Control ${nm}`);
        const names = positions as readonly string[];
        const posIds = names.length
          ? (await sql<Any[]>`select id from positions where org_id = ${e.orgId} and store_id is null and name = any(${names as string[]})`).map((x) => x.id)
          : undefined;
        await hire(e, e.superA, pid, store, posIds ? { positionIds: posIds, primaryPositionId: posIds[0] } : {});
        ctl[nm] = await access(pid);
      }
      const got = await emps(e.orgId);
      const byName = (nm: string) => got.find((x) => x.display_name === nm)!;
      expect(await access(byName('Cy Cashier').person_id)).toEqual(ctl.Cashier);
      expect(await access(byName('Max Cook').person_id)).toEqual(ctl.Cook);
      expect(await access(byName('Mia Boss').person_id)).toEqual(ctl.Default); // Manager answered none: the Server default, no more
      expect((await access(byName('Sup Sol').person_id)).roles).toEqual(['staff']);
      for (const x of got) {
        const a = await access(x.person_id);
        expect(a.roles).toEqual(['staff']);
        expect(a.scope).toEqual([x.store_code]);
      }
      const ids = got.map((x) => x.person_id);
      expect((await sql<Any[]>`select 1 from person_roles where person_id = any(${ids}) and role <> 'staff'`)).toHaveLength(0);
      expect((await sql<Any[]>`select 1 from person_credentials where person_id = any(${ids})`)).toHaveLength(0);
      expect((await sql<Any[]>`select 1 from attendance_credentials where employment_id = any(${got.map((x) => x.id)})`)).toHaveLength(0);
      expect((await sql<Any[]>`select 1 from person_identities where person_id = any(${ids})`)).toHaveLength(0);
    },
    120_000,
  );

  it(
    'an actor without enrol_staff at Malvar (a manager scoped to Lipa only) applying a snapshot with Lipa AND Malvar staff is refused (AuthorizationError) BEFORE any write: no person, no employment, no position, no link, no audit. Killing mutants: the authorize call removed; checked per row after Lipa was written',
    async () => {
      const e = await env('AZ');
      const s = snap([stf(L, 'Lipa Lu'), stf(M, 'Malvar Mo')]);
      const before = await state(e.orgId);
      expect(await failure(run(e, s, { actor: e.manager }))).toBeInstanceOf(AuthorizationError);
      expect(await failure(run(e, s, { actor: e.staff }))).toBeInstanceOf(AuthorizationError);
      expect(await state(e.orgId)).toEqual(before);
      // the same manager may load a Lipa-only scope
      await run(e, s, { actor: e.manager, storeCodes: ['LIPA'] });
      expect((await emps(e.orgId)).map((x) => x.display_name)).toEqual(['Lipa Lu']);
    },
    90_000,
  );

  it(
    'R15: nothing of an HR roster answer (SSS, PhilHealth, Pag-IBIG, TIN, a pay rate) is stored anywhere in the org. Killing mutant: the roster row copied into notes or an audit payload',
    async () => {
      const e = await env('HR');
      const s = snap([stf(L, 'Hr Hana', { dateHired: null })]);
      const roster = (await sheetRows(e, s, 'staff-roster'))[0]!;
      expect(roster.started_on).toBe('');
      const secrets = ['3412345678', '123456789012', '987654321098', '111222333', '4321.55'];
      const row = { ...roster, started_on: '2026-02-10', sss_no: secrets[0], philhealth_no: secrets[1], pagibig_no: secrets[2], tin: secrets[3], pay_basis: 'daily', rate: secrets[4], hr_note: 'secret-note-xyz' };
      await run(e, s, { answers: { 'staff-roster': [row] } });
      expect((await emps(e.orgId))[0]).toMatchObject({ display_name: 'Hr Hana', started_on: '2026-02-10' });
      for (const t of ['employments', 'persons', 'audit_log', 'v1_master_links', 'person_grants', 'positions']) {
        const q = t === 'person_grants'
          ? `select to_jsonb(t)::text as j from ${t} t where person_id in (select id from persons where org_id = $1)`
          : `select to_jsonb(t)::text as j from ${t} t where ${t === 'persons' ? 'org_id' : 'org_id'} = $1`;
        const all = (await sql.unsafe(q, [e.orgId])).map((r: Any) => r.j).join('\n');
        for (const sct of [...secrets, 'secret-note-xyz']) expect(all).not.toContain(sct);
      }
    },
    60_000,
  );
});

describe('S5 apply - org boundary (R6, R7, I1, test 25)', () => {
  it(
    'a run on Ian\'s org never writes a Padre Garcia staff record and an identity group spanning Lipa and PG gives Ian\'s org one Lipa employment; a PG-org run writes only PG\'s, as a SEPARATE person. Killing mutants: the role filter removed; the PG leg written in Ian\'s org',
    async () => {
      const e = await env('OB');
      const a = stf(L, 'Ben Cruz');
      const b = stf(P, 'Ben Cruz');
      const s = snap([a, b, stf(P, 'Pat Only')], [{ id: 'grp9', staffRefs: [{ storeId: L, staffId: a.id }, { storeId: P, staffId: b.id }] }]);
      await run(e, s);
      expect((await emps(e.orgId)).map((x) => `${x.display_name}@${x.store_code}`)).toEqual(['Ben Cruz@LIPA']);
      expect(await emps(e.pgOrgId)).toHaveLength(0);

      await run(e, s, { orgId: e.pgOrgId, orgCode: e.pgCode, actor: e.superPg, storeCodes: ['PGAR'] });
      expect((await emps(e.pgOrgId)).map((x) => `${x.display_name}@${x.store_code}`).sort()).toEqual(['Ben Cruz@PGAR', 'Pat Only@PGAR']);
      expect((await emps(e.orgId)).map((x) => `${x.display_name}@${x.store_code}`)).toEqual(['Ben Cruz@LIPA']);
      const pa = (await personsOf(e.orgId)).find((x) => x.display_name === 'Ben Cruz')!;
      const pb = (await personsOf(e.pgOrgId)).find((x) => x.display_name === 'Ben Cruz')!;
      expect(pa.id).not.toBe(pb.id);
    },
    90_000,
  );

  it(
    'the actor of one org with --org of another is refused before any write, both ways. Killing mutant: the check removed (RLS alone would write under the actor\'s org)',
    async () => {
      const e = await env('AO');
      const s = snap([stf(L, 'Ana Reyes')]);
      const before = [await state(e.orgId), await state(e.pgOrgId)];
      expect(await failure(run(e, s, { actor: e.superPg }))).toBeTruthy();
      expect(await failure(run(e, s, { orgId: e.pgOrgId, orgCode: e.pgCode, actor: e.superA, storeCodes: ['PGAR'] }))).toBeTruthy();
      expect([await state(e.orgId), await state(e.pgOrgId)]).toEqual(before);
      // and the refusals were about the actor, not about a missing feature: the right actor loads the same snapshot
      await run(e, s);
      expect(await emps(e.orgId)).toHaveLength(1);
    },
    60_000,
  );
});

describe('S5 apply - idempotence, dry run, lock, dependencies', () => {
  it(
    'I2: a second apply of the same inputs writes no person, no employment, no link, no audit row of its own beyond the load row, and leaves every staff code where it was. Killing mutant: the code allocated before the link check',
    async () => {
      const e = await env('IDM');
      const s = snap([stf(L, 'Ana Reyes', { staffCode: 'SE-010' }), stf(L, 'Blank Bea', { staffCode: '' })]);
      await run(e, s);
      const first = await state(e.orgId);
      const code = await lastCode(e.stores.LIPA!);
      const again = await run(e, s);
      expect(again.staff).toMatchObject({ created: 0, linked: 0, held: 0 });
      const second = await state(e.orgId);
      expect(second.persons).toEqual(first.persons);
      expect(second.emps).toEqual(first.emps);
      expect(second.links).toBe(first.links);
      expect(second.roles).toBe(first.roles);
      expect(await lastCode(e.stores.LIPA!)).toBe(code);
      // a hand hire afterwards continues after the highest code, so the second run really consumed none
      const next = await hire(e, e.superA, await newPerson(e, 'Later Lou'), 'LIPA');
      expect(next.staffCode).toBe('SE-012');
    },
    90_000,
  );

  it(
    'R2 / test 26: a dry run plans AND executes the `new:` position and the employments in ONE outer transaction (staff see the position), reports both, and leaves zero rows; the following apply writes exactly what the dry run reported. Killing mutant: one independent transaction per entity in the dry run',
    async () => {
      const e = await env('DRY');
      const s = snap([stf(L, 'Gil One', { positions: ['Griller'] }), stf(L, 'Gil Two', { positions: ['Cook'] })]);
      const rows = await sheetRows(e, s, 'positions');
      const answers = { positions: fill(rows, { v2_position: 'new:Grill Master' }) };
      const before = await state(e.orgId);
      const dry = await run(e, s, { answers, apply: false });
      expect(dry.positions).toMatchObject({ dryRun: true, created: 1 });
      expect(dry.staff).toMatchObject({ dryRun: true, created: 2, held: 0 });
      expect(await state(e.orgId)).toEqual(before);
      expect(await count('positions', e.orgId)).toBe(before.positions);
      const real = await run(e, s, { answers });
      expect(real.positions).toMatchObject({ dryRun: false, created: dry.positions.created, linked: dry.positions.linked });
      expect(real.staff).toMatchObject({ dryRun: false, created: dry.staff.created, linked: dry.staff.linked });
    },
    90_000,
  );

  it(
    'R16: two concurrent applies of the same snapshot create each person once. Killing mutant: the advisory lock removed',
    async () => {
      const e = await env('CC');
      const s = snap([stf(L, 'Ana Reyes'), stf(M, 'Ben Cruz')]);
      await Promise.all([run(e, s), run(e, s)]);
      expect(await personsOf(e.orgId)).toHaveLength(2);
      expect(await emps(e.orgId)).toHaveLength(2);
      expect(await links(e.orgId, 'employment')).toHaveLength(2);
    },
    120_000,
  );

  it(
    'I7: an existing v2 employment is never updated by the load: a v1 record linked to a v2 employment whose status was changed since is left alone',
    async () => {
      const e = await env('NU');
      const s = snap([stf(L, 'Ana Reyes', { employmentStatus: 'probationary' })]);
      await run(e, s);
      const [emp] = await emps(e.orgId);
      await sql`update employments set employment_status = 'regular', notes = 'edited by a person' where id = ${emp!.id}`;
      await run(e, snap([{ ...s.staff[0], employmentStatus: 'contractual', fullName: 'Ana Reyes' }]));
      const [after] = await sql<Any[]>`select employment_status, notes from employments where id = ${emp!.id}`;
      expect(after).toMatchObject({ employment_status: 'regular', notes: 'edited by a person' });
      expect(await emps(e.orgId)).toHaveLength(1);
    },
    90_000,
  );

  it(
    'the apply functions exist as named exports (applyPositions, applyStaff) and refuse no actor. Killing mutant: an anonymous write',
    async () => {
      const mod = await apply();
      expect(typeof mod.applyPositions).toBe('function');
      expect(typeof mod.applyStaff).toBe('function');
      const e = await env('NA');
      const err = await failure(mod.applyStaff({ snapshot: snap([stf(L, 'Ana Reyes')]), snapshotSha: SHA, map: e.map, orgId: e.orgId, orgCode: e.orgCode, answers: {}, apply: true }));
      expect(String(err.message)).toMatch(/actor/i);
      expect(await emps(e.orgId)).toHaveLength(0);
    },
    60_000,
  );
});


describe('S14 apply - capabilities up front, and what a late refusal says', () => {
  it(
    'S14a: an actor with enrol_staff but NOT manage_store_settings, with a `new:` position in scope, is refused by applyMasterData BEFORE any write (no audit row, nothing), and the error names manage_store_settings. Killing mutant: positions authorized lazily inside the step',
    async () => {
      const e = await env('S14A');
      const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${e.orgId}, 'Enrol Only') returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${e.orgId}, 'staff')`;
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${e.stores.LIPA!})`;
      await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${p!.id}, 'enrol_staff', ${e.superA.personId}, 'grant')`;
      const enrolOnly: Actor = { orgId: e.orgId, personId: p!.id };
      const s = snap([stf(L, 'Gil One', { positions: ['Griller'] })]);
      const rows = await sheetRows(e, s, 'positions');
      const answers = { positions: fill(rows, { v2_position: 'new:Grill Master' }) };
      const before = await state(e.orgId);
      const err = await failure(run(e, s, { actor: enrolOnly, answers, storeCodes: ['LIPA'] }));
      expect(err).toBeInstanceOf(AuthorizationError);
      expect(String(err.message)).toMatch(/manage_store_settings/);
      expect(await state(e.orgId)).toEqual(before);
    },
    90_000,
  );

  it(
    'S14a: a same-org actor with no capability at all and ZERO positions to create is refused, nothing written. Killing mutant: the position gate skipped when there is nothing to create, and no staff gate either',
    async () => {
      const e = await env('S14B');
      const s = snap([stf(L, 'Ana Reyes', { positions: ['Cook'] })]);
      const before = await state(e.orgId);
      expect(await failure(run(e, s, { actor: e.staff, storeCodes: ['LIPA'] }))).toBeInstanceOf(AuthorizationError);
      expect(await state(e.orgId)).toEqual(before);
    },
    60_000,
  );

  it(
    'S14b: items commit, then staff is held: the error says "already committed", gives the per-entity counts and says "rerun". Killing mutant: a bare HeldError that hides the committed items',
    async () => {
      const e = await env('S14C');
      const s = snap([stf(L, 'Carla Dizon'), stf(M, 'Carla Dizon')]);
      s.items = [{ id: 'r901', store: L, name: 'Rice', kind: 'raw_material', baseUnit: 'kg' }];
      const err = await failure(run(e, s, { only: ['items', 'staff'] }));
      const msg = String(err.message);
      expect(msg).toMatch(/already committed/i);
      expect(msg).toMatch(/rerun/i);
      expect(msg).toMatch(/items\D{0,12}1/i);
      expect(msg).toMatch(/held/i);
      expect(Number((await sql<Any[]>`select count(*)::int as n from items where org_id = ${e.orgId}`)[0]!.n)).toBe(1);
      expect(await emps(e.orgId)).toHaveLength(0);
    },
    90_000,
  );
});
