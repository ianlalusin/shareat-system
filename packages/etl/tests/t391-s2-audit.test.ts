/**
 * T-391 S2 (TESTER) - audit-round legs (items 1-11 of the coordinator's audit message).
 * Every leg here is red until the builder adds the named export or behaviour. New names pinned:
 *   store-map.ts  assertRunTarget(map, { orgCode, orgRowCode })      - throws when the --org row's code differs from --org-code
 *   items-plan.ts staleAnswersCsv(stale) -> csv text; each stale entry carries `answer` (the row Ian filled)
 *                 ExistingItem gains optional purchaseUnit / purchaseFactor
 *   snapshot.ts   maskAccount(n), parseServiceAccountKey(raw), verifySnapshotSha(snapshotPath) -> hex,
 *                 runExtract(client, { outDir, ratesDir, env }) - the rates file lives in ratesDir, never under outDir
 *   sheets.ts     assertSheetsOutsideRepo(dir, repoRoot) resolves symlinks/junctions and refuses ANY checkout of the repo
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { key } from '../src/master-data/keys';
import { assertSheetsOutsideRepo, parseCsv, rowKey } from '../src/master-data/sheets';
import { assertRunTarget, parseStoreMap } from '../src/master-data/store-map';
import { planItems, staleAnswersCsv } from '../src/master-data/items-plan';
import {
  makeReadOnlyV1Client,
  maskAccount,
  parseServiceAccountKey,
  runExtract,
  verifySnapshotSha,
} from '../src/master-data/snapshot';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const ROOT = join(__dirname, '..', '..', '..');
const L = 'b9DzsnPbr1BUnY88lyT4';
const M = 'dZUyvX4q824JBSVDAfE9';
const B = 'iGOW7q2pZbeHWV832UNh';
const D = 'eVYKj6wABdakk8RgEotW';
const P = 'y1DMgfisuTHBF57cNL6i';
const T1 = 'XbkyEgZqunmj2wzhicNf';
const T2 = 'TEST';
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
const fixture = (): Any => JSON.parse(readFileSync(join(__dirname, 'fixtures', 't391-v1-snapshot.json'), 'utf8'));
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
    snapshot: fixture(), map: parseStoreMap(MAP_CSV), orgCode: 'SE', existing: V2(), links: [], answers: {}, ...over,
  } as Any);
}
const creates = (p: Any): Any[] => p.writes.filter((w: Any) => w.op === 'create');
const linksW = (p: Any): Any[] => p.writes.filter((w: Any) => w.op === 'link');
const createOf = (p: Any, n: string): Any => creates(p).find((w: Any) => key(w.name) === key(n));
const rowsOf = (p: Any, sheet: string, item: string, field = 'item'): Any[] =>
  (p.sheets[sheet] ?? []).filter((r: Any) => key(r[field] ?? '') === key(item));
const recId = (snap: Any, store: string, name: string): string =>
  snap.items.find((i: Any) => i.store === store && key(i.name) === key(name)).id;
const answered = (row: Any, a: Record<string, string>): Any => ({ ...row, ...a });
const sheetsText = (p: Any): string => JSON.stringify(p.sheets);

describe('audit 1: run refuses a mismatched org', () => {
  const map = parseStoreMap(MAP_CSV);
  it('the --org row\'s code must equal --org-code', () => {
    expect(() => assertRunTarget(map, { orgCode: 'SE', orgRowCode: 'SEPG' })).toThrow();
    expect(() => assertRunTarget(map, { orgCode: 'SE', orgRowCode: 'OTHER' })).toThrow();
    expect(() => assertRunTarget(map, { orgCode: 'SE', orgRowCode: 'SE' })).not.toThrow();
  });
  it('a franchise-role org code with an --org that is not that franchise org is refused', () => {
    expect(() => assertRunTarget(map, { orgCode: 'SEPG', orgRowCode: 'SE' })).toThrow();
    expect(() => assertRunTarget(map, { orgCode: 'SEPG', orgRowCode: 'SEPG' })).not.toThrow();
  });
  it('an org code the map does not know is refused', () => {
    expect(() => assertRunTarget(map, { orgCode: 'NOPE', orgRowCode: 'NOPE' })).toThrow();
  });
  it('scripts/master-data.ts calls it', () => {
    expect(readFileSync(join(ROOT, 'scripts', 'master-data.ts'), 'utf8')).toContain('assertRunTarget');
  });
});

describe('audit 2: stale answers are never lost', () => {
  const p0 = plan();
  const [r] = rowsOf(p0, 'items-box', 'Paper Cups');
  const answers = { 'items-box': [answered(r, { inside_unit: 'pcs', how_many: '24' })] };
  const snap = fixture();
  snap.items.find((i: Any) => i.name === 'Paper Cups').conversionFactor = 12;
  const p1 = plan({ snapshot: snap, answers });

  it('the stale entry carries the answer Ian typed, and staleAnswersCsv holds it with the old row_key', () => {
    const s = p1.stale.find((x: Any) => x.row_key === r.row_key);
    expect(s).toBeTruthy();
    expect(s.answer).toMatchObject({ inside_unit: 'pcs', how_many: '24' });
    const text = staleAnswersCsv(p1.stale);
    expect(text).toContain(r.row_key);
    expect(text).toContain('24');
    expect(text).toContain('pcs');
    const rows = parseCsv(text);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
  it('the command writes items-stale.csv BEFORE it rewrites the sheets', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'master-data.ts'), 'utf8');
    const a = src.indexOf('items-stale.csv');
    const b = src.indexOf('ITEM_SHEET_COLUMNS[s]');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(src).toContain('staleAnswersCsv');
  });
});

describe('audit 3: row_key cannot look like a number', () => {
  it('every key starts with a letter, for any input', () => {
    for (let i = 0; i < 300; i++) expect(rowKey('x', i)).toMatch(/^[a-z][0-9a-f]{12}$/);
    const p = plan();
    for (const rows of Object.values(p.sheets) as Any[][]) for (const r of rows) expect(r.row_key).toMatch(/^[a-z][0-9a-f]{12}$/);
  });
});

describe('audit 4: twin keep_name', () => {
  const p = plan();
  const snap = fixture();
  const rows = () => rowsOf(p, 'items-twins', '3D W/LID', 'name').concat(rowsOf(p, 'items-twins', '3D W/LID.', 'name'));
  const pre = rows()[0]?.keep_name as string;
  const other = ['3D W/LID', '3D W/LID.'].find((n) => n !== pre) as string;
  const twinCreates = (q: Any) => creates(q).filter((c) => c.name.startsWith('3D W/LID'));

  it('the pre-fill is one of the group\'s names', () => {
    expect(['3D W/LID', '3D W/LID.']).toContain(pre);
  });
  for (const editedIndex of [0, 1]) {
    it(`the keep_name Ian edited (row ${editedIndex}, differs from the pre-fill) wins`, () => {
      const ans = rows().map((r: Any, i: number) =>
        answered(r, { same_or_different: 'same', keep_name: i === editedIndex ? other : pre }),
      );
      const q = plan({ answers: { 'items-twins': ans } });
      expect(twinCreates(q)).toHaveLength(1);
      expect(twinCreates(q)[0].name).toBe(other);
      expect(twinCreates(q)[0].links).toHaveLength(2);
    });
  }
  it('rows that disagree (same on one, different on the other) are held: no create, held counted', () => {
    const [a, b] = rows();
    const q = plan({ answers: { 'items-twins': [answered(a, { same_or_different: 'same', keep_name: pre }), answered(b, { same_or_different: 'different' })] } });
    expect(twinCreates(q)).toHaveLength(0);
    expect(q.held).toBeGreaterThanOrEqual(p.held);
    expect(q.sheets['items-twins'].length).toBeGreaterThanOrEqual(2);
  });
  it('a keep_name outside the group is refused: nothing created, nothing linked, still held', () => {
    const ans = rows().map((r: Any) => answered(r, { same_or_different: 'same', keep_name: 'Totally Other' }));
    const q = plan({ answers: { 'items-twins': ans } });
    expect(twinCreates(q)).toHaveLength(0);
    expect(creates(q).some((c) => key(c.name) === 'totally other')).toBe(false);
    expect(q.held).toBe(p.held);
  });
  it('a keep_name that is ANOTHER v2 item never links the record to it', () => {
    const rs = rowsOf(p, 'items-twins', 'Soy Sauce 15', 'name').concat(rowsOf(p, 'items-twins', 'Soy Sauce 1.5', 'name'));
    const ans = rs.map((r: Any) => answered(r, { same_or_different: 'same', keep_name: 'Sugar' }));
    const q = plan({ answers: { 'items-twins': ans } });
    expect(linksW(q).some((w) => w.itemId === 'v2-sugar' && w.links.some((l: Any) => l.v1Id === recId(snap, L, 'Soy Sauce 15')))).toBe(false);
    expect(linksW(q).some((w) => w.itemId === 'v2-soy')).toBe(false);
    expect(createOf(q, 'Soy Sauce 15')).toBeUndefined();
  });
});

describe('audit 5/6: every dropped record is held and listed', () => {
  const H0 = plan().held;

  it('a tie record with a blank factor is held (and still listed on items-units)', () => {
    const rows = rowsOf(plan(), 'items-units', 'Garlic Powder');
    const withFactor = plan({ answers: { 'items-units': rows.map((r: Any) => answered(r, { unit: 'kg', factor: r.store === 'MLVR' ? '0.001' : '' })) } });
    const blank = plan({ answers: { 'items-units': rows.map((r: Any) => answered(r, { unit: 'kg' })) } });
    expect(createOf(blank, 'Garlic Powder')).toBeTruthy();
    expect(blank.held).toBe(withFactor.held + 1);
    expect(rowsOf(blank, 'items-units', 'Garlic Powder').some((r: Any) => r.store === 'MLVR')).toBe(true);
  });
  it('a minority record with a blank factor is held', () => {
    const [r] = rowsOf(plan(), 'items-units', 'White Onion');
    const filled = plan({ answers: { 'items-units': [answered(r, { factor: '0.5' })] } });
    expect(plan().held).toBe(filled.held + 1);
  });
  it('a merged chain that never ends is held and listed, not linked', () => {
    const ex = V2().map((e) => (e.id === 'v2-oldrice' ? { ...e, mergedIntoId: 'v2-loop' } : e));
    ex.push({ id: 'v2-loop', name: 'Loop Item', status: 'merged', baseUnit: 'kg', kind: 'raw_material', mergedIntoId: 'v2-oldrice' });
    const q = plan({ existing: ex });
    expect(q.held).toBe(H0 + 1);
    expect(linksW(q).some((w) => w.links.some((l: Any) => l.v1Id === recId(fixture(), L, 'Old Rice')))).toBe(false);
    expect(sheetsText(q)).toContain('Old Rice');
  });
  it('a merged item whose winner is missing from existing is held and listed', () => {
    const ex = V2().map((e) => (e.id === 'v2-oldrice' ? { ...e, mergedIntoId: 'v2-gone' } : e));
    const q = plan({ existing: ex });
    expect(q.held).toBe(H0 + 1);
    expect(linksW(q).some((w) => w.links.some((l: Any) => l.v1Id === recId(fixture(), L, 'Old Rice')))).toBe(false);
    expect(sheetsText(q)).toContain('Old Rice');
  });
  it('a record linked to an invisible v2 item is held and listed', () => {
    const snap = fixture();
    const links = [{ entity: 'item', v1StoreId: L, v1Id: recId(snap, L, 'Sugar'), v2Id: 'v2-ghost', v1Unit: 'kg', factorToBase: 1 }];
    const q = plan({ links });
    expect(q.held).toBe(H0 + 1);
    expect(sheetsText(q)).toContain('Sugar');
  });
  it('nameless v1 records are listed on items-not-imported, never created', () => {
    const snap = fixture();
    snap.items.push({ id: 'nameless-1', store: L, kind: 'supply', baseUnit: 'pcs' });
    snap.items.push({ id: 'nameless-2', store: M, name: '   ', kind: 'supply', baseUnit: 'pcs' });
    const q = plan({ snapshot: snap });
    const listed = JSON.stringify(q.sheets['items-not-imported']);
    expect(listed).toContain('nameless-1');
    expect(listed).toContain('nameless-2');
    expect(creates(q).length).toBe(creates(plan()).length);
  });
});

describe('audit 11: a later store links box records to an item that already has the matching buying unit', () => {
  const snap = fixture();
  const cups = (over: Record<string, unknown>) => ({
    id: 'v2-cups', name: 'Paper Cups', status: 'active', baseUnit: 'pcs', kind: 'supply', mergedIntoId: null, ...over,
  });
  it('matching buying unit (box / 24): linked at factor 24, no box row, no units row, one fewer held', () => {
    const H0 = plan().held;
    const q = plan({ existing: [...V2(), cups({ purchaseUnit: 'box', purchaseFactor: 24 })] });
    const lk = linksW(q).find((w) => w.itemId === 'v2-cups');
    expect(lk.links).toEqual([{ v1StoreId: L, v1Id: recId(snap, L, 'Paper Cups'), v1Unit: 'box', factorToBase: 24 }]);
    expect(rowsOf(q, 'items-box', 'Paper Cups')).toHaveLength(0);
    expect(rowsOf(q, 'items-units', 'Paper Cups')).toHaveLength(0);
    expect(q.held).toBe(H0 - 1);
  });
  it('a different buying unit is NOT auto-linked', () => {
    const q = plan({ existing: [...V2(), cups({ purchaseUnit: 'pack', purchaseFactor: 24 })] });
    expect(linksW(q).some((w) => w.itemId === 'v2-cups')).toBe(false);
    expect(createOf(q, 'Paper Cups')).toBeUndefined();
  });
});

describe('audit 7: supplier fields, maskAccount', () => {
  it('maskAccount never reveals more than the last 4; under 8 digits it is fully masked', () => {
    const m = maskAccount('001122334455') as string;
    expect(m.endsWith('4455')).toBe(true);
    expect(m.replace(/\D/g, '')).toBe('4455');
    expect(maskAccount('12345678')).toMatch(/^\*+5678$/);
    expect(maskAccount('1234567')).toBe('****');
    expect(maskAccount('12')).toBe('****');
    expect(maskAccount('')).toBeUndefined();
    expect(maskAccount(undefined)).toBeUndefined();
    expect(maskAccount('0011-2233-4455')!.replace(/\D/g, '')).toBe('4455');
  });
  it('contacts are filtered to a whitelist (no nested passthrough); tin kept; a short bank number is fully masked', async () => {
    const data: Record<string, Any[]> = {
      stores: [{ id: L, data: { name: 'SharEat Lipa' } }],
      [`stores/${L}/suppliers`]: [{
        id: 's1',
        data: {
          businessName: 'Acme Meats', vatRegistrationNo: '123-456-789-000', email: 'sup@example.invalid', representative: 'Rep Name',
          contacts: [{ name: 'Ana Cruz', phone: '09171234567', secret: 'CONTACT_SENTINEL', nested: { deep: 'DEEP_SENTINEL' } }],
          bankAccounts: [{ bankName: 'BDO', accountNumber: '5588331' }],
        },
      }],
    };
    const fs = { collection: (path: string) => ({ get: async () => ({ docs: (data[path] ?? []).map((d) => ({ id: d.id, data: () => d.data })) }) }) };
    const dir = mkdtempSync(join(tmpdir(), 't391-audit7-'));
    await runExtract(makeReadOnlyV1Client(fs as Any), { outDir: dir, ratesDir: `${dir}-rates`, env: { NODE_ENV: 'development' } });
    const text = readFileSync(join(dir, 'v1-snapshot.json'), 'utf8');
    for (const s of ['CONTACT_SENTINEL', 'DEEP_SENTINEL', '5588331']) expect(text, s).not.toContain(s);
    for (const s of ['Ana Cruz', '09171234567', '123-456-789-000', '****']) expect(text, s).toContain(s);
  });
});

describe('audit 8: rates directory, realpath, any checkout', () => {
  const emptyClient = makeReadOnlyV1Client({
    collection: (p: string) => ({ get: async () => ({ docs: p === 'stores' ? [{ id: 's', data: () => ({ name: 'S' }) }] : [] }) }),
  } as Any);
  it('runExtract refuses a ratesDir equal to or inside outDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't391-audit8-'));
    await expect(runExtract(emptyClient, { outDir: dir, ratesDir: dir, env: {} })).rejects.toThrow();
    await expect(runExtract(emptyClient, { outDir: dir, ratesDir: join(dir, 'rates'), env: {} })).rejects.toThrow();
  });
  it('the rates file is in ratesDir and not in outDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't391-audit8b-'));
    await runExtract(emptyClient, { outDir: dir, ratesDir: `${dir}-rates`, env: {} });
    expect(existsSync(join(dir, 'v1-staff-rates.local.csv'))).toBe(false);
    expect(existsSync(join(`${dir}-rates`, 'v1-staff-rates.local.csv'))).toBe(true);
  });
  it('a junction/symlink into the repo is refused, even for a directory that does not exist yet', () => {
    const base = mkdtempSync(join(tmpdir(), 't391-audit8c-'));
    const repo = join(base, 'repo');
    mkdirSync(repo);
    const alias = join(base, 'alias');
    symlinkSync(repo, alias, 'junction');
    expect(() => assertSheetsOutsideRepo(join(alias, 'newdir'), repo)).toThrow();
  });
  it('a path inside the MAIN checkout is refused when the run is in a worktree', () => {
    const dotgit = join(ROOT, '.git');
    if (!existsSync(dotgit) || statSync(dotgit).isDirectory()) return; // not a worktree: nothing to prove
    const m = /gitdir:\s*(.+)/.exec(readFileSync(dotgit, 'utf8'));
    const mainTree = dirname(resolve(m![1]!.trim(), '..', '..'));
    expect(mainTree.toLowerCase()).not.toBe(resolve(ROOT).toLowerCase());
    expect(() => assertSheetsOutsideRepo(join(mainTree, 'docs', 'sheets'), ROOT)).toThrow();
  });
});

describe('audit 9: an unparseable key prints a fixed message', () => {
  it('no input fragment in the message; both encodings of a good key still parse', () => {
    const msgs = ['garbage-AAA-FRAGMENT', 'zzz{BBB-FRAGMENT2'].map((raw) => {
      try {
        parseServiceAccountKey(raw);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('should have thrown');
    });
    expect(msgs[0]).toBe(msgs[1]);
    for (const m of msgs) {
      expect(m).not.toMatch(/FRAGMENT|AAA|BBB|Unexpected token/);
    }
    const good = { private_key: 'k', client_email: 'e' };
    expect(parseServiceAccountKey(JSON.stringify(good))).toEqual(good);
    expect(parseServiceAccountKey(Buffer.from(JSON.stringify(good)).toString('base64'))).toEqual(good);
  });
});

describe('audit 10: run verifies the snapshot sha256', () => {
  const client = makeReadOnlyV1Client({
    collection: (p: string) => ({ get: async () => ({ docs: p === 'stores' ? [{ id: 's', data: () => ({ name: 'S' }) }] : [] }) }),
  } as Any);
  it('returns the hash when it matches; refuses a tampered snapshot and a missing sha file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 't391-audit10-'));
    await runExtract(client, { outDir: dir, ratesDir: `${dir}-rates`, env: {} });
    const snap = join(dir, 'v1-snapshot.json');
    const sha = readFileSync(join(dir, 'v1-snapshot.sha256'), 'utf8').trim().split(/\s+/)[0];
    expect(verifySnapshotSha(snap)).toBe(sha);
    writeFileSync(snap, readFileSync(snap, 'utf8') + ' ');
    expect(() => verifySnapshotSha(snap)).toThrow();
    const dir2 = mkdtempSync(join(tmpdir(), 't391-audit10b-'));
    writeFileSync(join(dir2, 'v1-snapshot.json'), '{}');
    expect(() => verifySnapshotSha(join(dir2, 'v1-snapshot.json'))).toThrow();
    expect(readdirSync(dir2)).toEqual(['v1-snapshot.json']);
  });
  it('the command calls it', () => {
    expect(readFileSync(join(ROOT, 'scripts', 'master-data.ts'), 'utf8')).toContain('verifySnapshotSha');
  });
});

describe('audit 11: import-items.ts no longer exports a writer', () => {
  it('it neither allocates codes nor inserts items', () => {
    const src = readFileSync(join(ROOT, 'scripts', 'import-items.ts'), 'utf8');
    expect(src).not.toContain('insertItem(');
    expect(src).not.toContain('allocateItemCode');
    expect(src).not.toMatch(/export (async )?function insertCleanItems/);
  });
});
