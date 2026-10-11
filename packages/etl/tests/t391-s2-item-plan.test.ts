/**
 * T-391 S2 (TESTER) - the pure pieces of the master-data load: keys, CSV sheets, store map, item planner.
 * docs/tasks/391-production-master-data-load.md, tests 1-10 and 12, invariants I1, I5, I6, I7, I10.
 *
 * CONTRACT these tests pin (the spec names files, not signatures - the builder builds to this):
 *   keys.ts       key(name), loose(name), isJunkName(name)
 *   sheets.ts     parseCsv(text) -> Record<string,string>[]   (BOM, CRLF, quoted commas)
 *                 toCsv(columns, rows) -> string               (starts with a BOM)
 *                 rowKey(...inputs) -> 'k' + 12 lowercase hex  (sha256 prefix; letter first, audit 3)
 *                 assertSheetsOutsideRepo(dir, repoRoot)       (throws when dir is inside repoRoot)
 *   store-map.ts  PADRE_GARCIA_V1_STORE_ID, parseStoreMap(csvText) -> rows (throws on R6 violations),
 *                 selectTargetStores(rows, { orgCode, storeCodes? }) -> non-exclude rows of that org
 *   items-plan.ts planItems({ snapshot, map, orgCode, storeCodes?, existing, links, answers })
 *                   -> { writes, sheets, stale }
 *       writes: { op:'create', name, kind, baseUnit, purchase:null|{unit,factor},
 *                 links:[{ v1StoreId, v1Id, v1Unit, factorToBase }] }
 *             | { op:'link', itemId, links:[...] }            (no other op exists: I7)
 *       sheets: { 'items-units'|'items-box'|'items-pack-pack'|'items-twins'|'items-kind'|'items-not-imported': Row[] }
 *       stale : [{ sheet, row_key, ... }]
 *       existing: [{ id, name, status:'active'|'inactive'|'merged', baseUnit, kind, mergedIntoId }]
 *       links   : [{ entity:'item', v1StoreId, v1Id, v2Id, v1Unit, factorToBase }]
 *       answers : { [sheetName]: Row[] }   (parsed CSV rows; a tick is the value 'yes')
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isJunkName, key, loose } from '../src/master-data/keys';
import { assertSheetsOutsideRepo, parseCsv, rowKey, toCsv } from '../src/master-data/sheets';
import { PADRE_GARCIA_V1_STORE_ID, parseStoreMap, selectTargetStores } from '../src/master-data/store-map';
import { planItems } from '../src/master-data/items-plan';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const D = 'eVYKj6wABdakk8RgEotW';
const P = 'y1DMgfisuTHBF57cNL6i';
const T1 = 'XbkyEgZqunmj2wzhicNf';
const T2 = 'TEST';

const fixture = (): Any =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 't391-v1-snapshot.json'), 'utf8'));

const MAP_CSV = [
  'v1_store_id,name,role,org_code,store_code',
  `${L},SharEat Lipa,own,SE,LIPA`,
  `${M},SharEat Malvar,own,SE,MLVR`,
  `${B},SharEat Banay-Banay,own,SE,BNBN`,
  `${D},SharEat Davao,own,SE,DAVO`,
  `${P},SharEat Padre Garcia,franchise,SEPG,PGAR`,
  `${T1},TEST,exclude,,`,
  `${T2},Test Commissary,exclude,,`,
].join('\r\n');

const V2 = (): Any[] => [
  { id: 'v2-sugar', name: 'Sugar', status: 'active', baseUnit: 'kg', kind: 'raw_material', mergedIntoId: null },
  { id: 'v2-flour', name: 'Flour', status: 'active', baseUnit: 'kg', kind: 'raw_material', mergedIntoId: null },
  { id: 'v2-jasmine', name: 'Jasmine Rice', status: 'active', baseUnit: 'kg', kind: 'raw_material', mergedIntoId: null },
  { id: 'v2-oldrice', name: 'Old Rice', status: 'merged', baseUnit: 'kg', kind: 'raw_material', mergedIntoId: 'v2-jasmine' },
  { id: 'v2-napkin', name: 'Retired Napkin', status: 'inactive', baseUnit: 'pcs', kind: 'supply', mergedIntoId: null },
  { id: 'v2-soy', name: 'Soy Sauce 1.5', status: 'active', baseUnit: 'ltr', kind: 'raw_material', mergedIntoId: null },
];

function plan(over: Record<string, unknown> = {}): Any {
  return planItems({
    snapshot: fixture(),
    map: parseStoreMap(MAP_CSV),
    orgCode: 'SE',
    existing: V2(),
    links: [],
    answers: {},
    ...over,
  } as Any);
}

const creates = (p: Any): Any[] => p.writes.filter((w: Any) => w.op === 'create');
const linksW = (p: Any): Any[] => p.writes.filter((w: Any) => w.op === 'link');
const createOf = (p: Any, name: string): Any => creates(p).find((w: Any) => key(w.name) === key(name));
const rowsOf = (p: Any, sheet: string, item: string, field = 'item'): Any[] =>
  (p.sheets[sheet] ?? []).filter((r: Any) => key(r[field] ?? '') === key(item));
const recId = (snap: Any, store: string, name: string): string =>
  snap.items.find((i: Any) => i.store === store && key(i.name) === key(name)).id;
/** A row as the planner emitted it, with Ian's answers typed in. */
const answered = (row: Any, ans: Record<string, string>): Any => ({ ...row, ...ans });

describe('1. keys', () => {
  it('3D W/LID and 3D W/LID. are twins; Coke 1.5 and Coke 15 are twins and still different keys', () => {
    expect(loose('3D W/LID')).toBe(loose('3D W/LID.'));
    expect(loose('Coke 1.5')).toBe(loose('Coke 15'));
    expect(key('Coke 1.5')).not.toBe(key('Coke 15'));
    expect(key('3D W/LID')).not.toBe(key('3D W/LID.'));
  });
  it('Pork Belly and "pork belly " share the exact key', () => {
    expect(key('Pork Belly')).toBe(key('pork belly '));
  });
  it('2, -- and a single letter are junk; 7UP is not', () => {
    expect(isJunkName('2')).toBe(true);
    expect(isJunkName('--')).toBe(true);
    expect(isJunkName('A')).toBe(true);
    expect(isJunkName('7UP')).toBe(false);
  });
});

describe('10. CSV sheets', () => {
  const columns = ['row_key', 'item', 'note'];
  const rows = [
    { row_key: 'a1', item: 'Piña colada, large', note: 'ñandú' },
    { row_key: 'a2', item: 'plain', note: '' },
  ];
  it('starts with a BOM and round-trips', () => {
    const text = toCsv(columns, rows);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(parseCsv(text)).toEqual(rows);
  });
  it("survives Excel's re-save: BOM, CRLF, a quoted comma, a quoted quote", () => {
    const excel = '﻿row_key,item,note\r\na1,"Piña colada, large",ñandú\r\na2,"say ""hi""",\r\n';
    expect(parseCsv(excel)).toEqual([
      { row_key: 'a1', item: 'Piña colada, large', note: 'ñandú' },
      { row_key: 'a2', item: 'say "hi"', note: '' },
    ]);
  });
  it('rowKey is 12 lowercase hex, stable, and moves with any input', () => {
    const k = rowKey('Paper Cups', 'LIPA', 'box', 'pcs', '24');
    expect(k).toMatch(/^k[0-9a-f]{12}$/); // audit 3: starts with a letter so a spreadsheet keeps it text
    expect(rowKey('Paper Cups', 'LIPA', 'box', 'pcs', '24')).toBe(k);
    expect(rowKey('Paper Cups', 'LIPA', 'box', 'pcs', '12')).not.toBe(k);
  });
  it('R9: a sheets dir inside the work tree is refused, one outside is accepted', () => {
    const repo = join(tmpdir(), 't391-fake-repo');
    expect(() => assertSheetsOutsideRepo(join(repo, 'docs', 'sheets'), repo)).toThrow();
    expect(() => assertSheetsOutsideRepo(repo, repo)).toThrow();
    expect(() => assertSheetsOutsideRepo(join(tmpdir(), 't391-elsewhere'), repo)).not.toThrow();
  });
});

describe('12. store map (R6)', () => {
  const withRows = (...extra: string[]) =>
    ['v1_store_id,name,role,org_code,store_code', ...extra].join('\r\n');

  it('accepts the fixture map; exclude rows are never selected', () => {
    const rows = parseStoreMap(MAP_CSV);
    const sel = selectTargetStores(rows, { orgCode: 'SE' }) as Any[];
    expect(sel.map((r) => r.storeCode ?? r.store_code).sort()).toEqual(['BNBN', 'DAVO', 'LIPA', 'MLVR']);
    const pg = selectTargetStores(rows, { orgCode: 'SEPG' }) as Any[];
    expect(pg).toHaveLength(1);
  });
  it('a franchise row sharing an org_code with an own row is refused', () => {
    expect(() =>
      parseStoreMap(withRows(`${L},Lipa,own,SE,LIPA`, `${P},Padre Garcia,franchise,SE,PGAR`)),
    ).toThrow();
  });
  it('the hard-coded Padre Garcia id mapped as own or exclude is refused; as franchise accepted', () => {
    expect(PADRE_GARCIA_V1_STORE_ID).toBe(P);
    expect(() => parseStoreMap(withRows(`${P},Padre Garcia,own,SE,PGAR`))).toThrow();
    expect(() => parseStoreMap(withRows(`${P},Padre Garcia,exclude,,`))).toThrow();
    expect(() => parseStoreMap(withRows(`${P},Padre Garcia,franchise,SEPG,PGAR`))).not.toThrow();
  });
  it('a scoped store with a blank store_code is refused', () => {
    const rows = parseStoreMap(withRows(`${L},Lipa,own,SE,LIPA`, `${M},Malvar,own,SE,`));
    expect(() => selectTargetStores(rows, { orgCode: 'SE', storeCodes: ['MLVR'] })).toThrow();
    expect(() => selectTargetStores(rows, { orgCode: 'SE' })).toThrow();
  });
});

describe('2. majority unit (q5-1, I-b)', () => {
  const p = plan();
  const snap = fixture();

  it('White Onion: kg at Lipa and Malvar beats pcs at Banay-Banay; Padre Garcia (pcs) is not counted', () => {
    const w = createOf(p, 'White Onion');
    expect(w).toBeTruthy();
    expect(w.baseUnit).toBe('kg');
    const stores = w.links.map((l: Any) => l.v1StoreId).sort();
    expect(stores).toEqual([L, M].sort());
    for (const l of w.links) {
      expect(l.v1Unit).toBe('kg');
      expect(l.factorToBase).toBe(1);
    }
  });
  it('the minority store gets exactly one items-units row, factor blank, no row for Padre Garcia', () => {
    const rows = rowsOf(p, 'items-units', 'White Onion');
    expect(rows.map((r) => r.store)).toEqual(['BNBN']);
    expect(rows[0].majority_unit).toBe('kg');
    expect(rows[0].v1_unit).toBe('pcs');
    expect(rows[0].factor).toBe('');
    expect(rows[0].row_key).toMatch(/^k[0-9a-f]{12}$/);
  });
  it('a 1-1 tie (kg at Lipa, g at Malvar) is held: no item, rows carry a blank unit column', () => {
    expect(createOf(p, 'Garlic Powder')).toBeUndefined();
    const rows = rowsOf(p, 'items-units', 'Garlic Powder');
    expect(rows.map((r) => r.store).sort()).toEqual(['LIPA', 'MLVR']);
    for (const r of rows) {
      expect(Object.keys(r)).toContain('unit');
      expect(r.unit).toBe('');
    }
  });
  it('a tie answered with a unit creates the item; the other unit links only with its factor', () => {
    const rows = rowsOf(p, 'items-units', 'Garlic Powder');
    const ans = rows.map((r) =>
      answered(r, { unit: 'kg', factor: r.store === 'MLVR' ? '0.001' : '' }),
    );
    const q = plan({ answers: { 'items-units': ans } });
    const g = createOf(q, 'Garlic Powder');
    expect(g.baseUnit).toBe('kg');
    const byStore = Object.fromEntries(g.links.map((l: Any) => [l.v1StoreId, l]));
    expect(byStore[L].factorToBase).toBe(1);
    expect(byStore[M].factorToBase).toBeCloseTo(0.001, 9);
    expect(byStore[M].v1Unit).toBe('g');
  });
  it('4. minority store: a factor links it with that factor and v1_unit; blank links nothing and the item is still created', () => {
    expect(createOf(p, 'White Onion')).toBeTruthy();
    const row = rowsOf(p, 'items-units', 'White Onion')[0];
    const q = plan({ answers: { 'items-units': [answered(row, { factor: '0.5' })] } });
    const l = createOf(q, 'White Onion').links.find((x: Any) => x.v1StoreId === B);
    expect(l).toBeTruthy();
    expect(l.v1Unit).toBe('pcs');
    expect(l.factorToBase).toBeCloseTo(0.5, 9);
    expect(l.v1Id).toBe(recId(snap, B, 'White Onion'));
    // zero, negative and non-numeric factors are not answers
    for (const bad of ['0', '-1', 'abc']) {
      const r = plan({ answers: { 'items-units': [answered(row, { factor: bad })] } });
      expect(createOf(r, 'White Onion').links.some((x: Any) => x.v1StoreId === B)).toBe(false);
    }
  });
});

describe('3. scope independence (R5, I10)', () => {
  const all = plan();
  it('--stores LIPA plans the same unit and kind as all stores, for every item it plans', () => {
    const lipa = plan({ storeCodes: ['LIPA'] });
    expect(creates(lipa).length).toBeGreaterThan(0);
    for (const c of creates(lipa)) {
      const full = createOf(all, c.name);
      expect(full, c.name).toBeTruthy();
      expect(c.baseUnit).toBe(full.baseUnit);
      expect(c.kind).toBe(full.kind);
      for (const l of c.links) expect(l.v1StoreId).toBe(L);
    }
  });
  it('Tomato is kg at Lipa but pcs org-wide (Malvar, Banay-Banay); a Lipa-only run still makes it pcs', () => {
    const lipa = plan({ storeCodes: ['LIPA'] });
    const t = createOf(lipa, 'Tomato');
    expect(t.baseUnit).toBe('pcs'); // mutant: majority over the scoped stores gives kg
    expect(t.links).toEqual([]); // Lipa's kg record is a minority with no factor
    expect(rowsOf(lipa, 'items-units', 'Tomato').map((r) => r.store)).toEqual(['LIPA']);
    expect(createOf(all, 'Tomato').baseUnit).toBe('pcs'); // mutant: every store in the map counted -> 2-2 tie, held
  });
  it('a store-scoped run writes nothing for names the store does not hold', () => {
    const lipa = plan({ storeCodes: ['LIPA'] });
    expect(createOf(lipa, 'Malvar Only Chili')).toBeUndefined();
    expect(createOf(all, 'Malvar Only Chili')).toBeTruthy();
  });
  it('a run targeting the PG org counts only PG, and writes only PG records', () => {
    const pg = plan({ orgCode: 'SEPG', storeCodes: ['PGAR'], existing: [] });
    expect(creates(pg).map((c) => c.name).sort()).toEqual(['Franchise Special Tea', 'Tomato', 'White Onion']);
    expect(createOf(pg, 'White Onion').baseUnit).toBe('pcs');
    expect(createOf(pg, 'Tomato').baseUnit).toBe('kg');
    for (const c of creates(pg)) for (const l of c.links) expect(l.v1StoreId).toBe(P);
  });
  it('Lipa first, Malvar after: Malvar links to the item Lipa made, and creates only its own names', () => {
    const snap = fixture();
    const lipaRun = plan({ storeCodes: ['LIPA'] });
    const pb = createOf(lipaRun, 'Pork Belly');
    const existing = [...V2(), { id: 'v2-pork', name: pb.name, status: 'active', baseUnit: pb.baseUnit, kind: pb.kind, mergedIntoId: null }];
    const links = pb.links.map((l: Any) => ({ entity: 'item', v2Id: 'v2-pork', ...l }));
    const malvar = plan({ storeCodes: ['MLVR'], existing, links });
    expect(createOf(malvar, 'Pork Belly')).toBeUndefined();
    const lk = linksW(malvar).find((w) => w.itemId === 'v2-pork');
    expect(lk.links.map((l: Any) => l.v1Id)).toEqual([recId(snap, M, 'pork belly ')]);
    expect(createOf(malvar, 'Malvar Only Chili')).toBeTruthy();
  });
});

describe('I1 org boundary and I-a', () => {
  const p = plan();
  it('Ian\'s org never writes a Padre Garcia or excluded-store record', () => {
    expect(createOf(p, 'Franchise Special Tea')).toBeUndefined();
    expect(createOf(p, 'Test Only Item')).toBeUndefined();
    for (const w of p.writes) for (const l of w.links) expect([P, T1, T2]).not.toContain(l.v1StoreId);
  });
  it('I-a: Pork Belly across Lipa and Malvar is one item, both linked at factor 1', () => {
    const pb = creates(p).filter((c) => key(c.name) === 'pork belly');
    expect(pb).toHaveLength(1);
    expect(pb[0].name).toBe(pb[0].name.trim());
    expect(pb[0].baseUnit).toBe('kg');
    expect(pb[0].links.map((l: Any) => l.v1StoreId).sort()).toEqual([L, M].sort());
    expect(pb[0].links.every((l: Any) => l.factorToBase === 1 && l.v1Unit === 'kg')).toBe(true);
  });
  it('I7: the planner emits only create and link writes', () => {
    expect(new Set(p.writes.map((w: Any) => w.op))).toEqual(new Set(['create', 'link']));
  });
  it('R4: records already linked are never written again', () => {
    const snap = fixture();
    const links = snap.items
      .filter((i: Any) => [L, M, B, D].includes(i.store))
      .map((i: Any) => ({ entity: 'item', v1StoreId: i.store, v1Id: i.id, v2Id: 'x', v1Unit: i.baseUnit, factorToBase: 1 }));
    expect(plan({ links }).writes).toEqual([]);
  });
});

describe('5. box / pack counted in what is inside (q5-2, I-c, I5)', () => {
  const p = plan();
  it('base box is held; the row pre-fills inside_unit from a real v1 purchase unit, how_many blank', () => {
    expect(createOf(p, 'Paper Cups')).toBeUndefined();
    const [r] = rowsOf(p, 'items-box', 'Paper Cups');
    expect(r.v1_unit).toBe('box');
    expect(r.inside_unit).toBe('pcs');
    expect(r.how_many).toBe('');
    const [s] = rowsOf(p, 'items-box', 'Straw Pack');
    expect(s.v1_unit).toBe('pack');
    expect(s.inside_unit).toBe(''); // v1 purchaseUnit 'box' is not a real unit
  });
  it('no create ever has a container base unit', () => {
    for (const c of creates(p)) expect(['box', 'pack', 'case', 'sack', 'tray', 'dozen']).not.toContain(c.baseUnit);
  });
  it('inside pcs, 24 in a box: base pcs, buying unit box/24, link factor 24 (not 1/24)', () => {
    const [r] = rowsOf(p, 'items-box', 'Paper Cups');
    const q = plan({ answers: { 'items-box': [answered(r, { inside_unit: 'pcs', how_many: '24' })] } });
    const c = createOf(q, 'Paper Cups');
    expect(c.baseUnit).toBe('pcs');
    expect(c.purchase).toEqual({ unit: 'box', factor: 24 });
    expect(c.links).toHaveLength(1);
    expect(c.links[0].v1Unit).toBe('box');
    expect(c.links[0].factorToBase).toBe(24);
  });
  it('how_many 0, blank, or a container as the inside unit stays held', () => {
    const [r] = rowsOf(p, 'items-box', 'Paper Cups');
    for (const a of [
      { inside_unit: 'pcs', how_many: '0' },
      { inside_unit: 'pcs', how_many: '' },
      { inside_unit: '', how_many: '24' },
      { inside_unit: 'box', how_many: '3' },
    ]) {
      expect(createOf(plan({ answers: { 'items-box': [answered(r, a)] } }), 'Paper Cups'), JSON.stringify(a)).toBeUndefined();
    }
  });
});

describe('6. pack to pack (q5-3, I-d)', () => {
  const p = plan();
  it('is pre-filled pcs and v1\'s N, and held until ticked', () => {
    expect(createOf(p, 'Tissue Pack')).toBeUndefined();
    const [r] = rowsOf(p, 'items-pack-pack', 'Tissue Pack');
    expect(r.base_unit).toBe('pcs');
    expect(r.per_pack).toBe('12');
    expect(r.ok).toBe('');
    // it is a pack-pack row, not also a box row
    expect(rowsOf(p, 'items-box', 'Tissue Pack')).toHaveLength(0);
  });
  it('ticked: pcs, buying unit pack/12, link factor 12', () => {
    const [r] = rowsOf(p, 'items-pack-pack', 'Tissue Pack');
    const c = createOf(plan({ answers: { 'items-pack-pack': [answered(r, { ok: 'yes' })] } }), 'Tissue Pack');
    expect(c.baseUnit).toBe('pcs');
    expect(c.purchase).toEqual({ unit: 'pack', factor: 12 });
    expect(c.links[0].factorToBase).toBe(12);
    expect(c.links[0].v1Unit).toBe('pack');
  });
  it('a corrected per_pack wins over v1\'s N', () => {
    const [r] = rowsOf(p, 'items-pack-pack', 'Tissue Pack');
    const c = createOf(plan({ answers: { 'items-pack-pack': [answered(r, { ok: 'yes', per_pack: '10' })] } }), 'Tissue Pack');
    expect(c.purchase).toEqual({ unit: 'pack', factor: 10 });
    expect(c.links[0].factorToBase).toBe(10);
  });
});

describe('7. punctuation twins (q5-4, I-e)', () => {
  const p = plan();
  const snap = fixture();
  const threeD = () => rowsOf(p, 'items-twins', '3D W/LID', 'name').concat(rowsOf(p, 'items-twins', '3D W/LID.', 'name'));

  it('blank answers hold every name of a group: nothing auto-merged, nothing created', () => {
    for (const n of ['3D W/LID', '3D W/LID.', 'Coke 1.5', 'Coke 15', 'Soy Sauce 15']) {
      expect(createOf(p, n), n).toBeUndefined();
    }
    const rows = threeD();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: Any) => r.group)).size).toBe(1);
    expect(rows[0].same_or_different).toBe('');
    expect(Object.keys(rows[0])).toContain('keep_name');
  });
  it('same: one item named keep_name, every record linked', () => {
    const ans = threeD().map((r: Any) => answered(r, { same_or_different: 'same', keep_name: '3D W/LID' }));
    const q = plan({ answers: { 'items-twins': ans } });
    const c = creates(q).filter((x) => loose(x.name) === loose('3D W/LID'));
    expect(c).toHaveLength(1);
    expect(c[0].name).toBe('3D W/LID');
    expect(c[0].links.map((l: Any) => l.v1Id).sort()).toEqual([recId(snap, L, '3D W/LID'), recId(snap, M, '3D W/LID.')].sort());
  });
  it('different: each name is its own item', () => {
    const coke = rowsOf(p, 'items-twins', 'Coke 1.5', 'name').concat(rowsOf(p, 'items-twins', 'Coke 15', 'name'));
    expect(coke).toHaveLength(2);
    const ans = coke.map((r: Any) => answered(r, { same_or_different: 'different' }));
    const q = plan({ answers: { 'items-twins': ans } });
    expect(createOf(q, 'Coke 1.5')).toBeTruthy();
    expect(createOf(q, 'Coke 15')).toBeTruthy();
    expect(createOf(q, 'Coke 1.5').links).toHaveLength(1);
  });
  it('an existing v2 name is part of the scan: Soy Sauce 15 vs v2 "Soy Sauce 1.5"', () => {
    const rows = rowsOf(p, 'items-twins', 'Soy Sauce 15', 'name').concat(rowsOf(p, 'items-twins', 'Soy Sauce 1.5', 'name'));
    expect(rows).toHaveLength(2);
    const v2row = rows.find((r: Any) => key(r.name) === key('Soy Sauce 1.5'));
    expect(String(v2row.stores).toLowerCase()).toContain('in v2');
    for (const r of rows) expect(r.keep_name).toBe('Soy Sauce 1.5'); // pre-filled with the existing v2 name
  });
  it('same with a v2 twin: the v1 record links to the existing v2 item, nothing is created', () => {
    const rows = rowsOf(p, 'items-twins', 'Soy Sauce 15', 'name').concat(rowsOf(p, 'items-twins', 'Soy Sauce 1.5', 'name'));
    const ans = rows.map((r: Any) => answered(r, { same_or_different: 'same' }));
    const q = plan({ answers: { 'items-twins': ans } });
    expect(creates(q).some((c) => loose(c.name) === loose('Soy Sauce 1.5'))).toBe(false);
    const lk = linksW(q).find((w) => w.itemId === 'v2-soy');
    expect(lk.links.map((l: Any) => l.v1Id)).toEqual([recId(snap, L, 'Soy Sauce 15')]);
  });
});

describe('8. kind (I-g, I-h)', () => {
  const p = plan();
  it('no kind and an unknown kind are held, listed with their v1 kinds', () => {
    expect(createOf(p, 'Mystery Item')).toBeUndefined();
    expect(createOf(p, 'Odd Thing')).toBeUndefined();
    const [r] = rowsOf(p, 'items-kind', 'Odd Thing');
    expect(r.v1_kinds).toContain('gadget');
    expect(r.kind).toBe('');
  });
  it('a kind filled in imports the item; blank does not', () => {
    const [r] = rowsOf(p, 'items-kind', 'Mystery Item');
    const q = plan({ answers: { 'items-kind': [answered(r, { kind: 'supply' })] } });
    expect(createOf(q, 'Mystery Item').kind).toBe('supply');
    expect(createOf(plan({ answers: { 'items-kind': [answered(r, { kind: '' })] } }), 'Mystery Item')).toBeUndefined();
  });
  it('kinds that differ across stores: majority pre-filled, applied only once ok is ticked', () => {
    expect(createOf(p, 'Dish Soap')).toBeUndefined(); // mutant: first wins creates it unasked
    const [r] = rowsOf(p, 'items-kind', 'Dish Soap');
    expect(r.kind).toBe('supply'); // Lipa and Banay-Banay vs Malvar
    expect(r.ok).toBe('');
    const ok = plan({ answers: { 'items-kind': [answered(r, { ok: 'yes' })] } });
    expect(createOf(ok, 'Dish Soap').kind).toBe('supply');
    const changed = plan({ answers: { 'items-kind': [answered(r, { ok: 'yes', kind: 'retail' })] } });
    expect(createOf(changed, 'Dish Soap').kind).toBe('retail');
  });
});

describe('I-f junk names (q5-5, R14)', () => {
  it('"2" (at two stores) and "--" are never created and each is listed once', () => {
    const p = plan();
    expect(creates(p).some((c) => isJunkName(c.name))).toBe(false);
    const listed = p.sheets['items-not-imported'] as Any[];
    expect(listed.filter((r) => r.item === '2')).toHaveLength(1);
    expect(listed.filter((r) => r.item === '--')).toHaveLength(1);
    expect(listed.some((r) => r.item === 'Pork Belly')).toBe(false);
  });
});

describe('I-i names already in v2', () => {
  const p = plan();
  const snap = fixture();
  it('active with the same unit: linked at factor 1, not created', () => {
    expect(createOf(p, 'Sugar')).toBeUndefined();
    const lk = linksW(p).find((w) => w.itemId === 'v2-sugar');
    expect(lk.links).toEqual([{ v1StoreId: L, v1Id: recId(snap, L, 'Sugar'), v1Unit: 'kg', factorToBase: 1 }]);
  });
  it('unit differs: held until a factor is given, the v2 item is never changed', () => {
    expect(createOf(p, 'Flour')).toBeUndefined();
    expect(linksW(p).some((w) => w.itemId === 'v2-flour')).toBe(false);
    const [r] = rowsOf(p, 'items-units', 'Flour');
    expect(r.v1_unit).toBe('g');
    expect(String(r.note).toLowerCase()).toContain('already in v2');
    const q = plan({ answers: { 'items-units': [answered(r, { factor: '0.001' })] } });
    const lk = linksW(q).find((w) => w.itemId === 'v2-flour');
    expect(lk.links[0].factorToBase).toBeCloseTo(0.001, 9);
    expect(lk.links[0].v1Unit).toBe('g');
    expect(creates(q).some((c) => key(c.name) === 'flour')).toBe(false);
  });
  it('merged: linked to the winner, never the loser', () => {
    expect(createOf(p, 'Old Rice')).toBeUndefined();
    expect(linksW(p).some((w) => w.itemId === 'v2-oldrice')).toBe(false);
    const lk = linksW(p).find((w) => w.itemId === 'v2-jasmine');
    expect(lk.links.map((l: Any) => l.v1Id)).toEqual([recId(snap, L, 'Old Rice')]);
  });
  it('inactive: held with link_inactive, never re-created; yes links, no does not', () => {
    expect(createOf(p, 'Retired Napkin')).toBeUndefined();
    expect(linksW(p).some((w) => w.itemId === 'v2-napkin')).toBe(false);
    const [r] = rowsOf(p, 'items-units', 'Retired Napkin');
    expect(Object.keys(r)).toContain('link_inactive');
    const yes = plan({ answers: { 'items-units': [answered(r, { link_inactive: 'yes' })] } });
    expect(linksW(yes).some((w) => w.itemId === 'v2-napkin')).toBe(true);
    const no = plan({ answers: { 'items-units': [answered(r, { link_inactive: 'no' })] } });
    expect(linksW(no).some((w) => w.itemId === 'v2-napkin')).toBe(false);
    expect(createOf(no, 'Retired Napkin')).toBeUndefined();
  });
});

describe('9. stale answers (R11, I6)', () => {
  it('an answer whose v1 inputs changed is ignored, re-emitted blank, and listed stale', () => {
    const p0 = plan();
    const [r] = rowsOf(p0, 'items-box', 'Paper Cups');
    const answers = { 'items-box': [answered(r, { inside_unit: 'pcs', how_many: '24' })] };
    expect(createOf(plan({ answers }), 'Paper Cups')).toBeTruthy(); // fresh: applies

    const snap = fixture();
    snap.items.find((i: Any) => i.name === 'Paper Cups').conversionFactor = 12; // v1 moved on
    const p1 = plan({ snapshot: snap, answers });
    expect(createOf(p1, 'Paper Cups')).toBeUndefined(); // mutant: answers matched by item name applies it
    const [again] = rowsOf(p1, 'items-box', 'Paper Cups');
    expect(again.how_many).toBe('');
    expect(again.row_key).not.toBe(r.row_key);
    expect(p1.stale.some((s: Any) => s.sheet === 'items-box' && s.row_key === r.row_key)).toBe(true);
  });
  it('an answer under a made-up row_key is ignored', () => {
    const [r] = rowsOf(plan(), 'items-pack-pack', 'Tissue Pack');
    const q = plan({ answers: { 'items-pack-pack': [answered(r, { ok: 'yes', row_key: 'deadbeef0000' })] } });
    expect(createOf(q, 'Tissue Pack')).toBeUndefined();
  });
});
