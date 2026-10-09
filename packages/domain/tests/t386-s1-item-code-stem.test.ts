import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-386 S1 - `docs/tasks/386-item-code-auto-suggest.md` S1 / R1 / R2. TESTER file. Pure unit, no database.
 *
 * The module under test, `packages/domain/src/items/code.ts`, does not exist at HEAD. It is loaded through a variable path so that
 * a missing module fails EACH test with "Cannot find module" on its own line instead of failing the whole file at transform time
 * (the T-383 `renameItem` idiom). Every test below is red today for that one reason, and each says which mutant it kills.
 *
 * The expected stems are the spec's R2 worked-example table plus the S1 "more real names" list, verified against an independent
 * reference implementation of rules 1-8 before this file was written (every row agrees).
 */
type CodeModule = {
  itemCodeStem: (name: string) => string | null;
  abbr: (word: string, n: number) => string;
  ITEM_CODE_RE: RegExp;
  formatItemCode: (stem: string, seq: number) => string;
  parseItemCode: (code: string) => { stem: string; seq: number } | null;
};
const MODULE_PATH = '../src/items/code';
const load = async (): Promise<CodeModule> => (await import(/* @vite-ignore */ MODULE_PATH)) as CodeModule;

/** R2's table, in the order listed (so the comment on each collision matches the codes the spec assigns). */
const R2_TABLE: [name: string, stem: string][] = [
  ['Chicken wings', 'CHWN'],
  ['Chicken winglets', 'CHWN'], // collision with the row above
  ['Pork belly', 'PRBL'], // LL counts once
  ['Pork belly sliced', 'PRBS'],
  ['Soy sauce', 'SYSC'], // Y is a consonant
  ['Coke 1.5', 'CK15'], // decimal join
  ['Coke 1.5L', 'CK15'], // collision
  ['Coke 15', 'CK15'], // collision, flagged never blocked
  ['Coke 330ml', 'CK33'], // digits are never skipped
  ['Charcoal', 'CHRC'],
  ['Samgyup bento box', 'SMBB'],
  ['3D W/LID', '3DLD'], // W is a stop-word
  ['3D W/LID.', '3DLD'], // v1's real duplicate pair
  ['Beef Premium 5kg pack', 'BP5P'],
  ['Jalapeño', 'JLPN'], // NFKD fold
  ['Tissue', 'TISS'], // SS once, then the earliest unused positions
  ['Ice', 'ICEX'], // whole word + pad
  ['U bolt', 'UBLT'], // carry
  ['Salt & pepper', 'SLPP'],
  ["Hershey's", 'HRSH'], // apostrophe vanishes
  ['Coke 1.5 (old)', 'CK1O'], // the rename suggestion
];
const MORE_REAL_NAMES: [name: string, stem: string][] = [
  ['Kimchi', 'KMCH'],
  ['Gochujang', 'GCHJ'],
  ['Calamansi', 'CLMN'],
  ['Coffee', 'COFF'],
  ['Gloves', 'GLVS'],
  ['Milkis', 'MLKS'],
  ['Egg', 'EGGX'],
  ['A4 bond paper', 'A4BP'], // A4 is not the stop-word A
  ['The', 'THEX'], // all stop-words -> keep the original tokens
  ['Pre-cut', 'PRCT'], // hyphen separates
  ['Mozzarella', 'MZRL'],
  ['Pepper', 'PEPR'],
  ['Beef 2.5kg pack', 'BF2P'],
];
/** Names the S3/S4 legs rely on; pinned here so a rule change cannot silently re-letter them. */
const LATER_SLICE_NAMES: [name: string, stem: string][] = [
  ['Chicken wing tips', 'CHWT'],
  ['Pork belly (old)', 'PRBO'],
  ['Pork Belly', 'PRBL'],
  ['Coke 2', 'CK2X'],
];

describe('T1 - itemCodeStem: the table', () => {
  it.each(R2_TABLE)(
    'R2 row %j -> %s. Killing mutants (each red on the row named): Y as a vowel (Soy sauce SOSC); skip doubled digits (Coke 330ml CK30); no carry (U bolt UBLX); no NFKD fold (Jalapeno); apostrophe as a separator (Hershey\'s HRSX); W not a stop-word (3D W/LID 3DWL). Red today: the module does not exist',
    async (name, stem) => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem(name)).toBe(stem);
    },
  );

  it.each(MORE_REAL_NAMES)(
    'real name %j -> %s. Kills: drop the doubled-letter skip (Mozzarella MZZR, Pepper PPPR); no decimal join (Beef 2.5kg pack B25P - "Coke 1.5" alone would NOT catch it, CK+1+5 is still CK15). Red today: the module does not exist',
    async (name, stem) => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem(name)).toBe(stem);
    },
  );

  it.each(LATER_SLICE_NAMES)(
    'name used by the S3/S4 legs %j -> %s. Red today: the module does not exist',
    async (name, stem) => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem(name)).toBe(stem);
    },
  );

  it(
    'collisions the form must show: Chicken wings / winglets share CHWN; Coke 1.5 / 1.5L / 15 share CK15; 3D W/LID and 3D W/LID. share 3DLD; 330ml does NOT share CK15. Red today: the module does not exist',
    async () => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem('Chicken wings')).toBe(itemCodeStem('Chicken winglets'));
      expect(new Set(['Coke 1.5', 'Coke 1.5L', 'Coke 15'].map(itemCodeStem)).size).toBe(1);
      expect(itemCodeStem('3D W/LID')).toBe(itemCodeStem('3D W/LID.'));
      expect(itemCodeStem('Coke 330ml')).not.toBe(itemCodeStem('Coke 15'));
    },
  );

  it(
    'every stem is 4 characters of A-Z 0-9 (the shape the DB trigger and ITEM_CODE_RE rely on), whatever the input: very long names, many tokens, digits only, accents, lone letters. Kills: forgetting the X pad; taking more than the first four tokens. Red today: the module does not exist',
    async () => {
      const { itemCodeStem } = await load();
      const names = [
        'Extra large premium frozen imported boneless skinless chicken thigh fillet pack',
        '12345678', '7', 'é', 'Crème brûlée', 'ÅÄÖ', 'a b c d e f g', 'x', '3D', '1,000', '1.5', "O'Brien's", 'Bag - 5 kg / 10 pcs',
      ];
      for (const n of names) expect(itemCodeStem(n), n).toMatch(/^[A-Z0-9]{4}$/);
    },
  );

  it(
    'decimal joins: "1,000" and "1.000" join to 1000 (RICE -> RC, 1000 -> 10); a full stop between letters separates. Kills: no join; join on any punctuation. Red today: the module does not exist',
    async () => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem('Rice 1,000')).toBe('RC10');
      expect(itemCodeStem('Rice 1.000')).toBe('RC10');
      expect(itemCodeStem('Salt.pepper')).toBe(itemCodeStem('Salt pepper'));
    },
  );

  it(
    'stop-words are whole tokens only: "A4" and "WITHOUT" are kept; "Salt and pepper" == "Salt & pepper"; "Chicken with rice" drops WITH. Kills: stop-word as a prefix match. Red today: the module does not exist',
    async () => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem('Salt and pepper')).toBe(itemCodeStem('Salt & pepper'));
      expect(itemCodeStem('Bread for the table')).toBe(itemCodeStem('Bread table'));
      expect(itemCodeStem('A4 paper')).toBe('A4PP');
      expect(itemCodeStem('Chicken without rice')).not.toBe(itemCodeStem('Chicken rice'));
      expect(itemCodeStem('Chicken with rice')).toBe(itemCodeStem('Chicken rice'));
    },
  );

  it(
    'accents fold, nothing else changes: Jalapeño == Jalapeno, Crème brûlée == Creme brulee, full-width letters fold through NFKD, a curly apostrophe vanishes like a straight one. Kills: a hand-rolled accent table missing a letter. Red today: the module does not exist',
    async () => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem('Jalapeño')).toBe(itemCodeStem('Jalapeno'));
      expect(itemCodeStem('Crème brûlée')).toBe(itemCodeStem('Creme brulee'));
      expect(itemCodeStem('Ｃｏｋｅ 1.5')).toBe(itemCodeStem('Coke 1.5'));
      expect(itemCodeStem('Hershey’s')).toBe(itemCodeStem("Hershey's"));
    },
  );
});

describe('T2 - no letters or numbers: null (the caller refuses)', () => {
  it.each(['--', '   ', '&/.', '', "'", '()', '—'])(
    'itemCodeStem(%j) is null. Kills: returning "XXXX" for an empty token list. Red today: the module does not exist',
    async (name) => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem(name)).toBeNull();
    },
  );
});

describe('T3 - deterministic', () => {
  it(
    'the same name twice, and the name in other cases / extra spaces / tabs / hyphens, give the same stem. Kills: any time- or random-dependent step; case-sensitive tokens. Red today: the module does not exist',
    async () => {
      const { itemCodeStem } = await load();
      expect(itemCodeStem('Chicken wings')).toBe(itemCodeStem('Chicken wings'));
      expect(itemCodeStem('  chicken   WINGS ')).toBe('CHWN');
      expect(itemCodeStem('chicken\twings')).toBe('CHWN');
      expect(itemCodeStem('CHICKEN-WINGS')).toBe('CHWN');
    },
  );
});

describe('T3b - abbr (exported for the test)', () => {
  it.each([
    ['CHICKEN', 2, 'CH'],
    ['WINGS', 2, 'WN'],
    ['BELLY', 2, 'BL'],
    ['MOZZARELLA', 4, 'MZRL'],
    ['PEPPER', 4, 'PEPR'],
    ['SOY', 2, 'SY'], // Y is a consonant
    ['AEIOUA', 3, 'AEI'], // no consonant at all: the earliest positions
    ['TISSUE', 4, 'TISS'],
    ['330ML', 2, '33'], // digits are consonants and never skipped as doubles
    ['ICE', 4, 'ICE'], // whole word when it fits
    ['U', 2, 'U'],
    ['CHARCOAL', 4, 'CHRC'],
  ] as [string, number, string][])(
    'abbr(%j, %i) = %s. Kills: choosing positions out of word order; vowels preferred over consonants; Y as a vowel. Red today: the module does not exist',
    async (word, n, expected) => {
      const { abbr } = await load();
      expect(abbr(word, n)).toBe(expected);
    },
  );
});

describe('T4 - ITEM_CODE_RE', () => {
  it(
    'accepts CHWN-001, 3DLD-999, A4BP-100; refuses lower case, 000, short/long numbers, short/long stems, no dash, spaces, trailing text. Kills: dropping the (?!000) lookahead; {3,} instead of {3}; missing anchors. Red today: the module does not exist',
    async () => {
      const { ITEM_CODE_RE } = await load();
      for (const ok of ['CHWN-001', '3DLD-999', 'A4BP-100', 'CK15-010']) expect(ITEM_CODE_RE.test(ok), ok).toBe(true);
      for (const bad of [
        'chwn-001', 'CHWN-000', 'CHWN-01', 'CHW-001', 'CHWN001', 'CHWN-0001', 'CH N-001', 'CHWNX-001', 'CHWN-001 ', ' CHWN-001',
        'CHWN-001x', 'CHWN_001', 'CHWN-00A', 'PORK-BELLY', '',
      ]) {
        expect(ITEM_CODE_RE.test(bad), JSON.stringify(bad)).toBe(false);
      }
    },
  );

  it(
    'is not a global/sticky regex (test() twice gives the same answer). Kills: the /g flag, whose lastIndex makes alternate calls flip. Red today: the module does not exist',
    async () => {
      const { ITEM_CODE_RE } = await load();
      expect(ITEM_CODE_RE.test('CHWN-001')).toBe(true);
      expect(ITEM_CODE_RE.test('CHWN-001')).toBe(true);
    },
  );
});

describe('T5 - formatItemCode / parseItemCode', () => {
  it(
    'formatItemCode("CHWN", 7) = CHWN-007; (..., 123) = CHWN-123; parseItemCode round-trips and refuses legacy codes. Kills: no zero pad; parse accepting PORK-BELLY. Red today: the module does not exist',
    async () => {
      const { formatItemCode, parseItemCode } = await load();
      expect(formatItemCode('CHWN', 7)).toBe('CHWN-007');
      expect(formatItemCode('CHWN', 123)).toBe('CHWN-123');
      expect(formatItemCode('3DLD', 999)).toBe('3DLD-999');
      expect(parseItemCode('CHWN-007')).toEqual({ stem: 'CHWN', seq: 7 });
      expect(parseItemCode('3DLD-999')).toEqual({ stem: '3DLD', seq: 999 });
      expect(parseItemCode('PORK-BELLY')).toBeNull();
      expect(parseItemCode('chwn-007')).toBeNull();
      expect(parseItemCode('CHWN-000')).toBeNull();
      expect(parseItemCode('')).toBeNull();
    },
  );
});

describe('T6 - the file ships to the browser: it imports nothing', () => {
  const source = (): string => readFileSync(fileURLToPath(new URL('../src/items/code.ts', import.meta.url)), 'utf8');

  it(
    'code.ts has no import/require and no dynamic import (I5, R10: ItemCodeField imports it as @shareat/domain/item-code, so it may not reach @shareat/db or ../shared/*). Kills: importing refuse(), the db client. Red today: the file does not exist',
    () => {
      const text = source();
      // Strip comments so prose that mentions "import" cannot trip the leg.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      expect(code).not.toMatch(/^\s*import\b/m);
      expect(code).not.toMatch(/\brequire\s*\(/);
      expect(code).not.toMatch(/\bimport\s*\(/);
      expect(code).not.toMatch(/from\s+['"][^'"]+['"]/);
    },
  );

  it(
    'code.ts declares itemCodeStem (I5: one implementation, the form and the server import the same function). Red today: the file does not exist',
    () => {
      expect(source()).toMatch(/export\s+(async\s+)?function\s+itemCodeStem\b|export\s+const\s+itemCodeStem\b/);
    },
  );
});
