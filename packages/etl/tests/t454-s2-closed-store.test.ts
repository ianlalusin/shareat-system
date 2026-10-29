/**
 * T-454 S2 (TESTER) - master data never loads Banay-Banay. docs/tasks/454-drop-banay-banay.md section 4 S2, tests T5, T6, T8.
 *
 * CONTRACT these tests pin (the spec names the symbols; the signatures are the tester's reading):
 *   store-map.ts  CLOSED_V1_STORES: Record<v1StoreId, label>   (has iGOW7q2pZbeHWV832UNh)
 *                 assertClosedStoresExcluded(rows: StoreMapRow[]): void
 *                   throws, in one plain sentence naming Banay-Banay, 31 Dec 2026 and bible row 377, when a closed id
 *                   has any role but 'exclude'; passes for 'exclude' or when the id is absent.
 *   snapshot.ts   roleOf (private) -> the `extract` skeleton stores.csv proposes 'exclude' for Banay-Banay.
 *
 * T8 is GREEN-AS-GUARD today: planItems already counts only non-exclude rows (selectTargetStores). It stays to kill the
 * regression "majority computed over every non-franchise row, exclude included".
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeReadOnlyV1Client, runExtract } from '../src/master-data/snapshot';
import { parseCsv } from '../src/master-data/sheets';
import { parseStoreMap } from '../src/master-data/store-map';
import * as storeMap from '../src/master-data/store-map';
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

const mapCsv = (bRole: string, bOrg = 'SE', bCode = 'BNBN'): string =>
  [
    'v1_store_id,name,role,org_code,store_code',
    `${L},SharEat Lipa,own,SE,LIPA`,
    `${M},SharEat Malvar,own,SE,MLVR`,
    `${B},SharEat Banay-Banay,${bRole},${bRole === 'exclude' ? '' : bOrg},${bRole === 'exclude' ? '' : bCode}`,
    `${D},SharEat Davao,own,SE,DAVO`,
    `${P},SharEat Padre Garcia,franchise,SEPG,PGAR`,
    `${T1},TEST,exclude,,`,
    `${T2},Test Commissary,exclude,,`,
  ].join('\r\n');

describe('T5. the extract skeleton stores.csv proposes exclude for Banay-Banay', () => {
  // mutant killed: roleOf still returns 'own' for Banay-Banay
  it('Banay-Banay exclude; Lipa/Malvar/Davao own; Padre Garcia franchise; test stores exclude', async () => {
    const stores = [
      [L, 'SharEat Lipa'], [M, 'SharEat Malvar'], [B, 'SharEat Banay-Banay'], [D, 'SharEat Davao'],
      [P, 'SharEat Padre Garcia'], [T1, 'TEST'], [T2, 'Test Commissary'],
    ];
    const fs: Any = {
      collection: (path: string) => ({
        get: async () => ({
          docs: path === 'stores' ? stores.map(([id, name]) => ({ id: id!, data: () => ({ name }) })) : [],
        }),
      }),
    };
    const dir = mkdtempSync(join(tmpdir(), 't454-extract-'));
    await runExtract(makeReadOnlyV1Client(fs), {
      outDir: dir,
      ratesDir: `${dir}-rates`,
      env: { NODE_ENV: 'development', FIREBASE_SERVICE_ACCOUNT_KEY: '{}' },
    });
    const role = Object.fromEntries(parseCsv(readFileSync(join(dir, 'stores.csv'), 'utf8')).map((r) => [r.v1_store_id, r.role]));
    expect(role).toEqual({ [L]: 'own', [M]: 'own', [B]: 'exclude', [D]: 'own', [P]: 'franchise', [T1]: 'exclude', [T2]: 'exclude' });
  });
});

describe('T6. assertClosedStoresExcluded', () => {
  const guard = (): Any => (storeMap as Any).assertClosedStoresExcluded;
  const rows = (role: string, org?: string) => parseStoreMap(mapCsv(role, org));

  it('exports the closed-store table with Banay-Banay in it', () => {
    expect(Object.keys((storeMap as Any).CLOSED_V1_STORES ?? {})).toContain(B);
  });
  // mutant killed: guard removed (nothing refused)
  it('refuses Banay-Banay as own, naming Banay-Banay and bible row 377', () => {
    expect(() => guard()(rows('own'))).toThrow(/Banay-Banay/);
    expect(() => guard()(rows('own'))).toThrow(/377/);
    expect(() => guard()(rows('own'))).toThrow(/exclude/);
  });
  // mutant killed: guard checks only role === 'own'
  it('refuses Banay-Banay as franchise too', () => {
    expect(() => guard()(rows('franchise', 'SEBB'))).toThrow(/Banay-Banay/);
    expect(() => guard()(rows('franchise', 'SEBB'))).toThrow(/377/);
  });
  it('passes when Banay-Banay is exclude', () => {
    expect(() => guard()(rows('exclude'))).not.toThrow();
  });
  it('passes when Banay-Banay is absent from the map', () => {
    const absent = parseStoreMap(mapCsv('exclude').split('\r\n').filter((l) => !l.startsWith(B)).join('\r\n'));
    expect(() => guard()(absent)).not.toThrow();
  });
  // fence: parseStoreMap's behaviour does not change (t391 fixtures use the id as a generic own store)
  it('parseStoreMap still accepts Banay-Banay as own (the guard lives in the CLI path)', () => {
    expect(() => rows('own')).not.toThrow();
  });
});

describe('T8. the unit majority ignores an excluded Banay-Banay', () => {
  // Tomato: pcs at Malvar and Banay-Banay, kg at Lipa and Davao.
  // Over the three own stores kg wins 2-1. If Banay-Banay were counted it would be a 2-2 tie with no majority.
  // mutant killed: majority computed over every non-franchise row, exclude included
  const snapshot: Any = {
    version: 1,
    items: [
      { id: 'tl', store: L, name: 'Tomato', kind: 'raw_material', baseUnit: 'kg' },
      { id: 'td', store: D, name: 'Tomato', kind: 'raw_material', baseUnit: 'kg' },
      { id: 'tm', store: M, name: 'Tomato', kind: 'raw_material', baseUnit: 'pcs' },
      { id: 'tb', store: B, name: 'Tomato', kind: 'raw_material', baseUnit: 'pcs' },
    ],
  };
  it('kg is the majority, and no sheet row mentions Banay-Banay', () => {
    const p: Any = planItems({ snapshot, map: parseStoreMap(mapCsv('exclude')), orgCode: 'SE', existing: [], links: [], answers: {} } as Any);
    const units: Any[] = p.sheets['items-units'] ?? [];
    expect(units.length).toBeGreaterThan(0); // Malvar's pcs record waits for a factor against the kg majority
    for (const r of units) {
      expect(r.majority_unit).toBe('kg');
      expect(r.store).not.toBe(B);
    }
    expect(JSON.stringify(p)).not.toContain('"tb"');
  });
});
