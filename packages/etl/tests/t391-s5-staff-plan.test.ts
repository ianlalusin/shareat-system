/**
 * T-391 S5 (TESTER) - the POSITIONS + STAFF planner. Pure: no database.
 * docs/tasks/391-production-master-data-load.md, rulings S1-S9 (+R4, R7, R11, R12, R15), test 14, invariants I1, I7, I9.
 *
 * CONTRACT these tests pin (the spec names the file, not the signature - the builder builds to this):
 *   packages/etl/src/master-data/staff-plan.ts
 *     planStaff({ snapshot, map, orgCode, storeCodes?, existingPositions, existingPersons, links, answers })
 *       -> { writes, sheets, stale, drift, held, listed }
 *       snapshot          : R10 shape; staff[] = { id, store, staffCode, fullName, positions: string[], employmentStatus, dateHired, isActive }
 *                           staffIdentities[] = { id, staffRefs: [{ storeId, staffId }] }
 *       existingPositions : [{ id, name, storeCode: string | null }]   (null = canonical, org-wide)
 *       existingPersons   : [{ id, displayName }]                       (the org's v2 persons)
 *       links             : [{ entity: 'person'|'employment'|'position', v1StoreId, v1Id, v2Id }]
 *                           (employment link: v1StoreId = the v1 store, v1Id = the v1 staff id; the person link of an identity
 *                            group has v1StoreId '' and v1Id = the group id)
 *       answers           : { [sheetName]: Row[] }
 *     writes (the ONLY ops; none carries a role, grant, pin or credential key - S2/I9):
 *       { op:'create', entity:'position', storeCode, name }                                  a `new:<name>` answer, once per store+name
 *       { op:'create', entity:'person', personRef, fullName, employments: Emp[] }
 *       { op:'employ', entity:'person', personId, personRef, employments: Emp[] }            an existing v2 person answered `same`
 *       Emp = { storeCode, v1StoreId, v1StaffId, startedOn 'YYYY-MM-DD' (Manila), employmentStatus,
 *               positions: string[] (v2 names, resolved only), primaryPosition: string | null (first resolved) }   (T-464: no staffCode)
 *       T-464: v2 numbers every hire itself; a v1 staffCode is never planned.
 *     sheets (all four always present, as arrays):
 *       'positions'         : ['row_key','store_code','v1_position','v2_position','note']          Ian fills v2_position: a canonical name, 'new:<name>' or 'none'
 *       'staff-same-person' : ['row_key','full_name','stores','same_or_different','note']
 *       'access-to-grant'   : ['row_key','full_name','store_code','v1_position','note']             management-looking positions answered 'none'
 *       'staff-roster'      : ['row_key','person_ref','full_name','store_code','positions','primary_position','employment_status','started_on',
 *                              'staff_code','sss_no','philhealth_no','pagibig_no','tin','pay_basis','rate','rate_effective_from','hr_note']
 *                             one row per person; started_on blank when v1 has no dateHired (HR/Ian fills it, the answer applies on the row_key)
 *     held  : number of rows Ian still has to answer (positions, same-person, a missing started_on). 0 = nothing held.
 *     listed: array of notes that need no answer (a v1 staff code that fell back to allocation, a position name left unresolved).
 *
 * Red today: the module does not exist, so each test fails on its dynamic import, inside the test.
 */
import { describe, expect, it } from 'vitest';
import { parseStoreMap } from '../src/master-data/store-map';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const P = 'y1DMgfisuTHBF57cNL6i';

const MAP_CSV = [
  'v1_store_id,name,role,org_code,store_code',
  `${L},SharEat Lipa,own,SE,LIPA`,
  `${M},SharEat Malvar,own,SE,MLVR`,
  `${P},SharEat Padre Garcia,franchise,SEPG,PGAR`,
].join('\r\n');

const CANON = ['Cashier', 'Kitchen Staff', 'Server', 'Dishwasher', 'Slicer', 'Inventory Staff'].map((name, i) => ({ id: `pos-${i}`, name, storeCode: null }));

let n = 0;
const stf = (store: string, name: string, over: Record<string, unknown> = {}): Any => ({
  id: `st${++n}`,
  store,
  staffCode: `SE-${String(n).padStart(3, '0')}`,
  fullName: name,
  positions: ['Cook'],
  employmentStatus: 'regular',
  dateHired: '2026-01-05T00:00:00.000Z',
  isActive: true,
  ...over,
});
const snap = (staff: Any[] = [], staffIdentities: Any[] = []): Any => ({
  version: 1, stores: [], items: [], suppliers: [], arCustomers: [], staff, staffIdentities,
});

async function plan(snapshot: Any, over: Record<string, unknown> = {}): Promise<Any> {
  const mod: Any = await import('../src/master-data/staff-plan');
  return mod.planStaff({
    snapshot,
    map: parseStoreMap(MAP_CSV),
    orgCode: 'SE',
    existingPositions: CANON,
    existingPersons: [],
    links: [],
    answers: {},
    ...over,
  });
}

const lc = (s: string): string => s.trim().toLowerCase();
const persons = (p: Any): Any[] => p.writes.filter((w: Any) => w.entity === 'person');
const personOf = (p: Any, name: string): Any => persons(p).find((w: Any) => lc(w.fullName ?? '') === lc(name));
const emps = (p: Any): Any[] => persons(p).flatMap((w: Any) => (w.employments ?? []).map((e: Any) => ({ ...e, fullName: w.fullName })));
const empOf = (p: Any, name: string, store?: string): Any =>
  emps(p).find((e: Any) => lc(e.fullName ?? '') === lc(name) && (!store || e.storeCode === store));
const posWrites = (p: Any): Any[] => p.writes.filter((w: Any) => w.entity === 'position');
const sheet = (p: Any, name: string): Any[] => p.sheets?.[name] ?? [];
const answer = (rows: Any[], fill: Record<string, string>): Any[] => rows.map((r: Any) => ({ ...r, ...fill }));

describe('14a. S4 / R7 one person per human, split at the org boundary', () => {
  it('an identity group across Lipa and Malvar is ONE person with TWO employments. Mutant: one person per store record', async () => {
    const a = stf(L, 'Ana Reyes');
    const b = stf(M, 'Ana M. Reyes');
    const p = await plan(snap([a, b], [{ id: 'idg1', staffRefs: [{ storeId: L, staffId: a.id }, { storeId: M, staffId: b.id }] }]));
    expect(persons(p)).toHaveLength(1);
    expect(persons(p)[0].employments.map((e: Any) => e.storeCode).sort()).toEqual(['LIPA', 'MLVR']);
    expect(p.held).toBe(0);
  });

  it('a group across Lipa and Padre Garcia gives Ian\'s org ONE employment (Lipa) and NOTHING for Padre Garcia; the PG org run gets its own separate person. Mutant: the PG leg written', async () => {
    const a = stf(L, 'Ben Cruz');
    const b = stf(P, 'Ben Cruz');
    const s = snap([a, b], [{ id: 'idg2', staffRefs: [{ storeId: L, staffId: a.id }, { storeId: P, staffId: b.id }] }]);
    const se = await plan(s);
    expect(persons(se)).toHaveLength(1);
    expect(emps(se).map((e: Any) => e.storeCode)).toEqual(['LIPA']);
    expect(JSON.stringify(se.writes)).not.toContain('PGAR');
    expect(JSON.stringify(se.writes)).not.toContain(P);
    expect(se.held).toBe(0);

    const pg = await plan(s, { orgCode: 'SEPG', storeCodes: ['PGAR'], existingPositions: CANON });
    expect(persons(pg)).toHaveLength(1);
    expect(emps(pg).map((e: Any) => e.storeCode)).toEqual(['PGAR']);
    expect(JSON.stringify(pg.writes)).not.toContain('LIPA');
  });

  it('a franchise-store staff member with no group is never planned for Ian\'s org (I1)', async () => {
    const p = await plan(snap([stf(P, 'Pat Franchise'), stf(L, 'Lia Lipa')]));
    expect(persons(p).map((w: Any) => lc(w.fullName))).toEqual(['lia lipa']);
  });

  it('the same exact name at two stores, not in a group: held on staff-same-person, nothing written for them; `same` is one person with two employments, `different` two persons. Mutants: auto-merge on name; auto-split', async () => {
    const s = snap([stf(L, 'Carla Dizon'), stf(M, 'carla  dizon ')]);
    const held = await plan(s);
    expect(held.held).toBeGreaterThan(0);
    expect(persons(held)).toHaveLength(0);
    const rows = sheet(held, 'staff-same-person');
    expect(rows).toHaveLength(1);
    const same = await plan(s, { answers: { 'staff-same-person': answer(rows, { same_or_different: 'same' }) } });
    expect(same.held).toBe(0);
    expect(persons(same)).toHaveLength(1);
    expect(persons(same)[0].employments).toHaveLength(2);
    const diff = await plan(s, { answers: { 'staff-same-person': answer(rows, { same_or_different: 'different' }) } });
    expect(diff.held).toBe(0);
    expect(persons(diff)).toHaveLength(2);
  });

  it('the same name as an EXISTING v2 person is held; `same` employs that person (op employ, no new person), `different` creates a new one. Mutant: existing persons left out of the scan', async () => {
    const s = snap([stf(L, 'Dino Evangelista')]);
    const ex = { existingPersons: [{ id: 'v2-person-1', displayName: 'Dino Evangelista' }] };
    const held = await plan(s, ex);
    expect(held.held).toBeGreaterThan(0);
    expect(emps(held)).toHaveLength(0);
    const rows = sheet(held, 'staff-same-person');
    expect(rows).toHaveLength(1);
    const same = await plan(s, { ...ex, answers: { 'staff-same-person': answer(rows, { same_or_different: 'same' }) } });
    const w = same.writes.find((x: Any) => x.entity === 'person');
    expect(w.op).toBe('employ');
    expect(w.personId).toBe('v2-person-1');
    expect(same.held).toBe(0);
    const diff = await plan(s, { ...ex, answers: { 'staff-same-person': answer(rows, { same_or_different: 'different' }) } });
    expect(diff.writes.find((x: Any) => x.entity === 'person').op).toBe('create');
  });
});

describe('14b. S3 only active staff are hired', () => {
  it('isActive false, resigned, terminated and inactive are not hired; active ones are. Mutant: ended staff hired', async () => {
    const p = await plan(
      snap([
        stf(L, 'Active Anna'),
        stf(L, 'Gone Gina', { isActive: false }),
        stf(L, 'Quit Quentin', { employmentStatus: 'resigned' }),
        stf(L, 'Fired Fred', { employmentStatus: 'terminated' }),
        stf(L, 'Idle Ida', { employmentStatus: 'inactive' }),
      ]),
    );
    expect(persons(p).map((w: Any) => w.fullName)).toEqual(['Active Anna']);
    expect(p.held).toBe(0);
  });

  it('S5: employment_status maps one to one (part-time stays part-time)', async () => {
    const p = await plan(snap([stf(L, 'Pat Timer', { employmentStatus: 'part-time' }), stf(L, 'Prob Pia', { employmentStatus: 'probationary' })]));
    expect(empOf(p, 'Pat Timer').employmentStatus).toBe('part-time');
    expect(empOf(p, 'Prob Pia').employmentStatus).toBe('probationary');
  });
});

describe('14c. S1 / S2 / S6 positions', () => {
  it('a canonical name resolves case- and spacing-blind with no sheet row: "Cashier ", "cook", "Inventory  Staff"', async () => {
    const p = await plan(snap([stf(L, 'Una', { positions: ['Cashier '] }), stf(L, 'Dos', { positions: ['cook'] }), stf(L, 'Tres', { positions: ['Inventory  Staff'] })]));
    expect(empOf(p, 'Una').positions).toEqual(['Cashier']);
    expect(empOf(p, 'Dos').positions).toEqual(['Kitchen Staff']);
    expect(empOf(p, 'Tres').positions).toEqual(['Inventory Staff']);
    expect(sheet(p, 'positions')).toHaveLength(0);
    expect(p.held).toBe(0);
  });

  it('v1 "Cook" resolves to canonical "Kitchen Staff" by alias, with no sheet row. Mutant: alias missing (Cook held as unknown)', async () => {
    const p = await plan(snap([stf(L, 'Alias Al', { positions: ['Cook'] }), stf(L, 'Alias Bo', { positions: [' COOK '] })]));
    expect(empOf(p, 'Alias Al')).toMatchObject({ positions: ['Kitchen Staff'], primaryPosition: 'Kitchen Staff' });
    expect(empOf(p, 'Alias Bo').positions).toEqual(['Kitchen Staff']);
    expect(sheet(p, 'positions')).toHaveLength(0);
    expect(p.held).toBe(0);
  });

  it('a name that is not canonical goes to positions.csv once per store and is held; a canonical answer applies it. Mutant: unknown name silently dropped', async () => {
    const s = snap([stf(L, 'Gil One', { positions: ['Griller'] }), stf(L, 'Gil Two', { positions: ['griller'] })]);
    const p = await plan(s);
    expect(p.held).toBeGreaterThan(0);
    const rows = sheet(p, 'positions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ store_code: 'LIPA' });
    const ok = await plan(s, { answers: { positions: answer(rows, { v2_position: 'Kitchen Staff' }) } });
    expect(ok.held).toBe(0);
    expect(empOf(ok, 'Gil One').positions).toEqual(['Kitchen Staff']);
    expect(empOf(ok, 'Gil Two').positions).toEqual(['Kitchen Staff']);
  });

  it('`new:<name>` plans ONE store-position create at that store only, and the staff get it. Mutant: one create per staff member / created org-wide', async () => {
    const s = snap([stf(L, 'Gil One', { positions: ['Griller'] }), stf(L, 'Gil Two', { positions: ['Griller'] }), stf(M, 'Mal Three', { positions: ['Cook'] })]);
    const rows = sheet(await plan(s), 'positions');
    const p = await plan(s, { answers: { positions: answer(rows, { v2_position: 'new:Grill Master' }) } });
    expect(p.held).toBe(0);
    expect(posWrites(p)).toHaveLength(1);
    expect(posWrites(p)[0]).toMatchObject({ op: 'create', entity: 'position', storeCode: 'LIPA', name: 'Grill Master' });
    expect(empOf(p, 'Gil One').positions).toEqual(['Grill Master']);
  });

  it('an existing v2 store position of that name is used, not created again', async () => {
    const s = snap([stf(L, 'Gil One', { positions: ['Griller'] })]);
    const rows = sheet(await plan(s), 'positions');
    const p = await plan(s, {
      existingPositions: [...CANON, { id: 'pos-x', name: 'Grill Master', storeCode: 'LIPA' }],
      answers: { positions: answer(rows, { v2_position: 'new:Grill Master' }) },
    });
    expect(posWrites(p)).toHaveLength(0);
    expect(empOf(p, 'Gil One').positions).toEqual(['Grill Master']);
  });

  it('S2: `Manager` unanswered is held; answered `none` the person is hired WITHOUT it and is listed on access-to-grant. Mutant: a management position resolved to something that grants access', async () => {
    const s = snap([stf(L, 'Mia Boss', { positions: ['Manager'] })]);
    const p = await plan(s);
    expect(p.held).toBeGreaterThan(0);
    const rows = sheet(p, 'positions');
    expect(rows).toHaveLength(1);
    const none = await plan(s, { answers: { positions: answer(rows, { v2_position: 'none' }) } });
    expect(none.held).toBe(0);
    expect(empOf(none, 'Mia Boss')).toMatchObject({ positions: [], primaryPosition: null });
    const g = sheet(none, 'access-to-grant');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ full_name: 'Mia Boss', store_code: 'LIPA', v1_position: 'Manager' });
  });

  it.each(['Supervisor', 'OIC', 'Manager'])('S2: a v1 %s answered none lands on access-to-grant', async (v1pos) => {
    const s = snap([stf(L, 'Lead Lou', { positions: [v1pos] })]);
    const rows = sheet(await plan(s), 'positions');
    const none = await plan(s, { answers: { positions: answer(rows, { v2_position: 'none' }) } });
    expect(sheet(none, 'access-to-grant').map((r: Any) => r.v1_position)).toEqual([v1pos]);
  });

  it('S2/I9 at the plan level: no write carries a role, grant, pin or credential key, whatever the v1 positions are', async () => {
    const s = snap([stf(L, 'Mia Boss', { positions: ['Manager'] }), stf(L, 'Cy Cook', { positions: ['Cook'] })]);
    const rows = sheet(await plan(s), 'positions');
    const p = await plan(s, { answers: { positions: answer(rows, { v2_position: 'none' }) } });
    expect(p.writes.length).toBeGreaterThan(0);
    expect(JSON.stringify(p.writes)).not.toMatch(/"(role|roles|grant|grants|capabilit\w*|pin|passcode|credential\w*|password)"/i);
  });

  it('S6: several positions: the first RESOLVED is primary, unresolved ones are left out and listed. With none at all: positions [] (createEmployment defaults to Server)', async () => {
    const s = snap([stf(L, 'Multi Mo', { positions: ['Griller', 'Cook', 'Cashier'] }), stf(L, 'Nopos Nel', { positions: [] })]);
    const rows = sheet(await plan(s), 'positions');
    const p = await plan(s, { answers: { positions: answer(rows, { v2_position: 'none' }) } });
    expect(p.held).toBe(0);
    expect(empOf(p, 'Multi Mo')).toMatchObject({ positions: ['Kitchen Staff', 'Cashier'], primaryPosition: 'Kitchen Staff' });
    expect(empOf(p, 'Nopos Nel')).toMatchObject({ positions: [], primaryPosition: null });
    expect(JSON.stringify(p.listed)).toMatch(/Griller/);
  });
});

describe('14c2. S10 unanswered positions', () => {
  it('a person whose v1 positions are ALL unanswered is held and nothing is written for them; one with at least one resolved position is hired with those and the unanswered names are listed. Mutant: hired with the default Server / unresolved silently dropped', async () => {
    const s = snap([stf(L, 'All Open', { positions: ['Griller'] }), stf(L, 'Some Open', { positions: ['Griller', 'Cook'] })]);
    const p = await plan(s);
    expect(p.held).toBeGreaterThan(0);
    expect(empOf(p, 'All Open')).toBeUndefined();
    expect(empOf(p, 'Some Open')).toMatchObject({ positions: ['Kitchen Staff'], primaryPosition: 'Kitchen Staff' });
    expect(JSON.stringify(p.listed)).toContain('Griller');
  });
});

describe('14d2. S12 dateHired forms and S13 person_ref', () => {
  it('a date-only YYYY-MM-DD is accepted as that Manila date; any other form is held on staff-roster like a missing date', async () => {
    const p = await plan(snap([stf(L, 'Dateonly Dee', { dateHired: '2026-03-05' }), stf(L, 'Slash Sal', { dateHired: '03/05/2026' }), stf(L, 'Junk Jo', { dateHired: 'last spring' })]));
    expect(empOf(p, 'Dateonly Dee').startedOn).toBe('2026-03-05');
    expect(empOf(p, 'Slash Sal')).toBeUndefined();
    expect(empOf(p, 'Junk Jo')).toBeUndefined();
    expect(p.held).toBe(2);
    expect(sheet(p, 'staff-roster').filter((r: Any) => r.started_on === '')).toHaveLength(2);
  });

  it('person_ref is the identity group key for a grouped person, else the v1 staff id', async () => {
    const a = stf(L, 'Grp Gia', { id: 'g-a' });
    const b = stf(M, 'Grp Gia', { id: 'g-b' });
    const solo = stf(L, 'Solo Sue', { id: 'solo-1' });
    const p = await plan(snap([a, b, solo], [{ id: 'grpkey7', staffRefs: [{ storeId: L, staffId: 'g-a' }, { storeId: M, staffId: 'g-b' }] }]));
    const r = sheet(p, 'staff-roster');
    expect(r.find((x: Any) => x.full_name === 'Grp Gia').person_ref).toBe('grpkey7');
    expect(r.find((x: Any) => x.full_name === 'Solo Sue').person_ref).toBe('solo-1');
  });
});

describe('S14d / S14e access-to-grant', () => {
  it.each(['Manager', 'Supervisor', 'OIC'])('S14d: an UNANSWERED %s on a person who also has a resolved position: hired with the resolved one AND on access-to-grant, marked pending. Mutant: only listed after an answer', async (mgmt) => {
    const p = await plan(snap([stf(L, 'Half Hal', { positions: [mgmt, 'Cook'] })]));
    expect(empOf(p, 'Half Hal')).toMatchObject({ positions: ['Kitchen Staff'], primaryPosition: 'Kitchen Staff' });
    const g = sheet(p, 'access-to-grant');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ full_name: 'Half Hal', store_code: 'LIPA', v1_position: mgmt });
    expect(g[0].note).toMatch(/pending/i);
  });

  it('S14e (helper seam: staff-plan.ts exports mergeAccessToGrant(prev, next) -> rows): rows from a previous run survive a run whose new list is non-empty, merged by row_key', async () => {
    const mod: Any = await import('../src/master-data/staff-plan');
    const lipa = { row_key: 'k1', full_name: 'Mia Boss', store_code: 'LIPA', v1_position: 'Manager', note: '' };
    const malvar = { row_key: 'k2', full_name: 'Moe Lead', store_code: 'MLVR', v1_position: 'Supervisor', note: '' };
    const merged: Any[] = mod.mergeAccessToGrant([lipa], [malvar]);
    expect(merged.map((r: Any) => r.row_key).sort()).toEqual(['k1', 'k2']);
    expect(mod.mergeAccessToGrant([lipa], []).map((r: Any) => r.row_key)).toEqual(['k1']);
    expect(mod.mergeAccessToGrant([], [malvar]).map((r: Any) => r.row_key)).toEqual(['k2']);
    const again: Any[] = mod.mergeAccessToGrant([lipa, malvar], [{ ...malvar, note: 'pending' }]);
    expect(again).toHaveLength(2);
    expect(again.find((r: Any) => r.row_key === 'k2').note).toBe('pending');
  });
});

describe('14d. S5 started_on', () => {
  it('dateHired is read as a MANILA date: 17:00Z is the next day, 15:59Z is the same day. Mutant: the UTC date', async () => {
    const p = await plan(snap([stf(L, 'Late Lee', { dateHired: '2026-03-01T17:00:00.000Z' }), stf(L, 'Early Eli', { dateHired: '2026-03-01T15:59:00.000Z' })]));
    expect(empOf(p, 'Late Lee').startedOn).toBe('2026-03-02');
    expect(empOf(p, 'Early Eli').startedOn).toBe('2026-03-01');
  });

  it('a missing dateHired holds that person on staff-roster (started_on blank); the answer on the matching row_key hires them. Unrelated rows are not held (R12)', async () => {
    const s = snap([stf(L, 'No Date Dan', { dateHired: null }), stf(L, 'Fine Fay')]);
    const p = await plan(s);
    expect(p.held).toBe(1);
    expect(empOf(p, 'No Date Dan')).toBeUndefined();
    expect(empOf(p, 'Fine Fay')).toBeDefined();
    const row = sheet(p, 'staff-roster').find((r: Any) => r.full_name === 'No Date Dan');
    expect(row.started_on).toBe('');
    const ok = await plan(s, { answers: { 'staff-roster': [{ ...row, started_on: '2026-02-10' }] } });
    expect(ok.held).toBe(0);
    expect(empOf(ok, 'No Date Dan').startedOn).toBe('2026-02-10');
  });
});

describe('14e. staff codes (T-464: v2 numbers everyone fresh)', () => {
  it('no v1 staffCode is carried over, whatever it looks like: every planned employment leaves the code to v2 (the field is gone), and nothing is listed about codes. Mutants: a v1 code planned again; a note per code', async () => {
    const p = await plan(
      snap([
        stf(L, 'Keep Kim', { staffCode: 'SE-014' }),
        stf(L, 'Blank Bea', { staffCode: '' }),
        stf(L, 'Bad Bob', { staffCode: 'EMP-7' }),
        stf(M, 'Short Sol', { staffCode: 'SE-14' }),
        stf(L, 'Dup Late', { staffCode: 'SE-020', dateHired: '2026-05-01T00:00:00.000Z' }),
        stf(L, 'Dup Early', { staffCode: 'SE-020', dateHired: '2026-02-01T00:00:00.000Z' }),
      ]),
    );
    for (const nm of ['Keep Kim', 'Blank Bea', 'Bad Bob', 'Short Sol', 'Dup Late', 'Dup Early']) {
      const e = empOf(p, nm);
      expect(e, nm).toBeDefined();
      expect('staffCode' in e, `${nm}: mutant - a staffCode is planned again`).toBe(false);
    }
    expect(JSON.stringify(p.listed), 'no per-code note any more').not.toMatch(/staff code/i);
    // the HR sheet's staff_code column is blank: v2 allocates it at hire
    expect(sheet(p, 'staff-roster').every((r: Any) => r.staff_code === '')).toBe(true);
  });
});

describe('14f. R4 / R11 / R12 / R13 / R15 and the sheets', () => {
  it('R4: a v1 staff record with an employment link writes nothing; a re-run is empty', async () => {
    const a = stf(L, 'Linked Lyn');
    const p = await plan(snap([a]), {
      links: [{ entity: 'employment', v1StoreId: L, v1Id: a.id, v2Id: 'e1' }, { entity: 'person', v1StoreId: L, v1Id: a.id, v2Id: 'p1' }],
      existingPersons: [{ id: 'p1', displayName: 'Linked Lyn' }],
    });
    expect(p.writes).toHaveLength(0);
    expect(p.held).toBe(0);
  });

  it('R13: a linked person whose v1 name changed is reported as drift and never written', async () => {
    const a = stf(L, 'Renamed Rina');
    const p = await plan(snap([a]), {
      links: [{ entity: 'employment', v1StoreId: L, v1Id: a.id, v2Id: 'e1' }, { entity: 'person', v1StoreId: L, v1Id: a.id, v2Id: 'p1' }],
      existingPersons: [{ id: 'p1', displayName: 'Old Name Rina' }],
    });
    expect(p.writes).toHaveLength(0);
    expect(p.drift.length).toBe(1);
  });

  it('R11: an answer whose row_key no longer matches is ignored, listed stale, and the row is held again', async () => {
    const s = snap([stf(L, 'Gil One', { positions: ['Griller'] })]);
    const row = sheet(await plan(s), 'positions')[0];
    const p = await plan(s, { answers: { positions: [{ ...row, row_key: 'kdeadbeef0000', v2_position: 'Kitchen Staff' }] } });
    expect(p.stale.length).toBeGreaterThan(0);
    expect(p.held).toBeGreaterThan(0);
    expect(empOf(p, 'Gil One')).toBeUndefined();
  });

  it('R5: --stores LIPA writes only Lipa employments (a Lipa+Malvar group gives its Lipa employment only)', async () => {
    const a = stf(L, 'Ana Reyes');
    const b = stf(M, 'Ana Reyes');
    const solo = stf(M, 'Malvar Only');
    const p = await plan(snap([a, b, solo], [{ id: 'idg3', staffRefs: [{ storeId: L, staffId: a.id }, { storeId: M, staffId: b.id }] }]), { storeCodes: ['LIPA'] });
    expect(emps(p).map((e: Any) => `${e.fullName}@${e.storeCode}`)).toEqual(['Ana Reyes@LIPA']);
  });

  it('all four sheets are always present, as arrays, and the roster has one row per person with the contract columns', async () => {
    const a = stf(L, 'Ana Reyes');
    const b = stf(M, 'Ana Reyes');
    const p = await plan(snap([a, b, stf(L, 'Solo Sam')], [{ id: 'idg4', staffRefs: [{ storeId: L, staffId: a.id }, { storeId: M, staffId: b.id }] }]));
    for (const k of ['positions', 'staff-same-person', 'access-to-grant', 'staff-roster']) expect(Array.isArray(p.sheets?.[k])).toBe(true);
    const r = sheet(p, 'staff-roster');
    expect(r).toHaveLength(2);
    for (const col of ['row_key', 'person_ref', 'full_name', 'store_code', 'positions', 'primary_position', 'employment_status', 'started_on', 'staff_code', 'sss_no', 'philhealth_no', 'pagibig_no', 'tin', 'pay_basis', 'rate', 'rate_effective_from', 'hr_note']) {
      expect(Object.keys(r[0])).toContain(col);
    }
    expect(r.find((x: Any) => x.full_name === 'Solo Sam')).toMatchObject({ person_ref: expect.any(String), store_code: 'LIPA', started_on: '2026-01-05' });
  });

  it('R15 / I8: stray pay or birthday fields on a snapshot staff record reach neither a write nor a sheet. Mutant: the record spread into the output', async () => {
    const s = snap([stf(L, 'Rate Rae', { dailyRate: '777.77', hourlyRate: '99.99', payType: 'daily', birthday: '1990-04-04', sssNo: '3412345678' })]);
    const p = await plan(s);
    const out = JSON.stringify({ w: p.writes, s: p.sheets, l: p.listed, d: p.drift });
    for (const secret of ['777.77', '99.99', '1990-04-04', '3412345678']) expect(out).not.toContain(secret);
  });
});
