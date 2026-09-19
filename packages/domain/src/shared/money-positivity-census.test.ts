import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  censusKey,
  extractComparison,
  normaliseComparison,
  scanMoneyPositivitySites,
  stripComments,
  type CensusSite,
} from './money-positivity-census';

/**
 * T-325/DEF-376, revision 2 — unit tests for the extracted census module. `money-positivity-guard.test.ts`
 * keeps the hand-maintained CLASSIFIED table and scans the real `packages/domain/src`; this file
 * proves the SCANNER's own behaviour against disposable fixture directories — never against the
 * real domain source.
 *
 * ⭐ The key is the COMPARISON, not the line — `if (Number(amount) <= 0) throw new Error('x'); // y`
 * and `if (Number(amount) <= 0) throw new Error('z');` key identically, because only
 * `Number(amount) <= 0` is hashed. Everything else on the line — an error message, a template
 * literal, a trailing comment — is payload, and DEF-376's whole point is that payload must not be
 * able to move a site out of `CLASSIFIED`.
 */

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'money-positivity-census-'));
});

afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

function writeFixture(relPath: string, contents: string): void {
  const abs = join(fixtureDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
}

/**
 * `noUncheckedIndexedAccess` makes every `sites[0]` a possible `undefined`, and a fixture that
 * scans to zero or two sites when a test expects exactly one is a fixture bug, not an assertion to
 * silence with `!`. RULES.md §13 row 206: prefer a guard over `!`, and DEF-179's "a scan of nothing
 * passes" applies to a test's own fixtures as much as to the real census — so this throws with the
 * fixture named as the suspect, rather than letting a wrong array length fail on some confusing
 * downstream property access (or, worse, pass vacuously).
 */
function onlySite(sites: CensusSite[], context: string): CensusSite {
  if (sites.length !== 1) {
    throw new Error(
      `${context}: expected exactly 1 site, found ${sites.length} — the fixture is wrong, not the assertion.`,
    );
  }
  const site = sites[0];
  if (!site) {
    throw new Error(`${context}: sites.length was 1 but sites[0] is missing — should be impossible.`);
  }
  return site;
}

/** Same reasoning as `onlySite`, for the one T4 case that needs exactly two. */
function exactlyTwoSites(sites: CensusSite[], context: string): [CensusSite, CensusSite] {
  if (sites.length !== 2) {
    throw new Error(
      `${context}: expected exactly 2 sites, found ${sites.length} — the fixture is wrong, not the assertion.`,
    );
  }
  const [a, b] = sites;
  if (!a || !b) {
    throw new Error(`${context}: sites.length was 2 but an element is missing — should be impossible.`);
  }
  return [a, b];
}

const SITE = [
  'export function checkAmount(amount: string) {',
  '  if (Number(amount) <= 0) {',
  "    throw new Error('amount must be positive');",
  '  }',
  '}',
  '',
].join('\n');

describe('scanMoneyPositivitySites — census module (T-325/DEF-376, revision 2)', () => {
  it('T1 — the same comparison keeps its key when unrelated lines move above it (Invariant 1)', () => {
    writeFixture('site.ts', SITE);
    const siteBefore = onlySite(scanMoneyPositivitySites(fixtureDir), 'T1 before');

    writeFixture(
      'site.ts',
      ['// comment 1', '// comment 2', '// comment 3', '// comment 4', '// comment 5', SITE].join(
        '\n',
      ),
    );
    const siteAfter = onlySite(scanMoneyPositivitySites(fixtureDir), 'T1 after');

    // ⭐ both halves matter: the key surviving is the point, but a key that "survives" only
    // because the fixture never actually moved would prove nothing (spec, T1).
    expect(siteAfter.key).toBe(siteBefore.key);
    expect(siteAfter.line).not.toBe(siteBefore.line);
  });

  it('T2 — the key changes when the operator changes (Invariant 2)', () => {
    writeFixture('site.ts', SITE);
    const original = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2 operator: original');

    writeFixture('site.ts', SITE.replace('<= 0', '< 0'));
    const operatorChanged = onlySite(
      scanMoneyPositivitySites(fixtureDir),
      'T2 operator: changed',
    );

    expect(operatorChanged.key).not.toBe(original.key);
  });

  it('T2 — the key changes when the operand changes (Invariant 2)', () => {
    writeFixture('site.ts', SITE);
    const original = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2 operand: original');

    writeFixture('site.ts', SITE.replace('Number(amount)', 'Number(total)'));
    const operandChanged = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2 operand: changed');

    expect(operandChanged.key).not.toBe(original.key);
  });

  it('T2 — the key changes when a tolerance literal changes, e.g. 0.005 -> 0 (Invariant 2, revision 2)', () => {
    // ⭐ the case revision 2 exists for: the matching regex stops at the bare `0`, but the KEY must
    // carry the full numeric literal or a tolerance edit is invisible to the guard.
    writeFixture('site.ts', SITE.replace('<= 0)', '<= 0.005)'));
    const tolerance = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2 tolerance: 0.005');

    writeFixture('site.ts', SITE.replace('<= 0)', '<= 0)'));
    const bareZero = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2 tolerance: bare 0');

    expect(tolerance.key).not.toBe(bareZero.key);
    expect(tolerance.key).toContain('0.005');
  });

  it('T2 — the key changes when a `!(...)` negation is removed, even though the inner comparison is untouched (precedence ruling)', () => {
    // ⭐ THE PRECEDENCE RULING: when both shapes match one line (a `Number(...)` comparison
    // wrapped in `!( ... > N )`), the key is built from the OUTER match, never the inner one.
    // Deleting the `!` inverts a money guard's meaning — "refuse a non-positive value" becomes
    // "refuse a positive one" — and only a key built from the outer text moves when that happens.
    // This is the regression test for that ruling; the real site is
    // `cutover/opening.ts`'s `if (!(Number(amount) > 0)) throw ...`.
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        '  if (!(Number(amount) > 0)) {',
        "    throw new Error('amount must be positive');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const negated = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2 negation: with !');
    expect(negated.key).toBe(censusKey('site.ts', '!(Number(amount) > 0)'));

    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        '  if (Number(amount) > 0) {',
        "    throw new Error('amount must be positive');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const bangRemoved = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2 negation: ! removed');

    expect(bangRemoved.key).not.toBe(negated.key);
  });

  it('T2b — payload beyond the comparison is not part of the key (Invariant 3, revision 2)', () => {
    // comparison + a throw'n error message + a trailing comment, all on one line.
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        "  if (Number(amount) <= 0) throw new Error('amount must be positive'); // must be > 0",
        '}',
        '',
      ].join('\n'),
    );
    const original = onlySite(scanMoneyPositivitySites(fixtureDir), 'T2b: original');

    // reword ONLY the error message
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        "  if (Number(amount) <= 0) throw new Error('amount has to be strictly positive, no exceptions'); // must be > 0",
        '}',
        '',
      ].join('\n'),
    );
    const messageReworded = onlySite(
      scanMoneyPositivitySites(fixtureDir),
      'T2b: message reworded',
    );
    expect(messageReworded.key).toBe(original.key);

    // reword ONLY the trailing comment (message stays as reworded above)
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        "  if (Number(amount) <= 0) throw new Error('amount has to be strictly positive, no exceptions'); // reworded: has to be greater than zero, no exceptions",
        '}',
        '',
      ].join('\n'),
    );
    const commentReworded = onlySite(
      scanMoneyPositivitySites(fixtureDir),
      'T2b: comment reworded',
    );
    expect(commentReworded.key).toBe(original.key);

    // delete the comment entirely
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        "  if (Number(amount) <= 0) throw new Error('amount has to be strictly positive, no exceptions');",
        '}',
        '',
      ].join('\n'),
    );
    const commentDeleted = onlySite(
      scanMoneyPositivitySites(fixtureDir),
      'T2b: comment deleted',
    );
    expect(commentDeleted.key).toBe(original.key);

    // the naive "key on the raw/reported line" implementation would have failed every assertion
    // above — the display `raw` field really does still carry the payload, only the key does not.
    expect(original.raw).toContain('amount must be positive');
    expect(original.raw).toContain('must be > 0');
  });

  it('T3 — whitespace is not a change: re-indentation and reflowed internal spacing keep the key (Invariant 3)', () => {
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        '  if (Number(amount)  <=  0) {',
        "    throw new Error('amount must be positive');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const spaced = onlySite(scanMoneyPositivitySites(fixtureDir), 'T3 whitespace: spaced');

    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        '\tif (Number(amount) <= 0) {',
        "\t\tthrow new Error('amount must be positive');",
        '\t}',
        '}',
        '',
      ].join('\n'),
    );
    const reindented = onlySite(
      scanMoneyPositivitySites(fixtureDir),
      'T3 whitespace: reindented',
    );

    expect(reindented.key).toBe(spaced.key);
  });

  it('T3 — reflowing the comparison onto its own line within a multi-line statement keeps the key (Invariant 3, revision 2)', () => {
    writeFixture('site.ts', SITE);
    const inline = onlySite(scanMoneyPositivitySites(fixtureDir), 'T3 reflow: inline');

    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        '  if (',
        '    Number(amount) <= 0',
        '  ) {',
        "    throw new Error('amount must be positive');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const reflowed = onlySite(scanMoneyPositivitySites(fixtureDir), 'T3 reflow: reflowed');

    expect(reflowed.key).toBe(inline.key);
  });

  it('T4 — the same comparison text in two different files produces two different keys', () => {
    writeFixture('a.ts', SITE);
    writeFixture('b.ts', SITE);

    const sites = scanMoneyPositivitySites(fixtureDir);
    const [siteA, siteB] = exactlyTwoSites(
      [...sites].sort((x, y) => x.file.localeCompare(y.file)),
      'T4',
    );
    expect(siteA.file).not.toBe(siteB.file);
    expect(siteA.key).not.toBe(siteB.key);
    // the comparison text itself really is identical — the file is the only differentiator
    expect(normaliseComparison(siteA.comparison)).toBe(normaliseComparison(siteB.comparison));
  });

  it('T5 — a commented-out comparison is not found (line comment)', () => {
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        "  // if (Number(amount) <= 0) { throw new Error('bad'); }",
        '  return true;',
        '}',
        '',
      ].join('\n'),
    );
    expect(scanMoneyPositivitySites(fixtureDir)).toHaveLength(0);
  });

  it('T5 — a commented-out comparison is not found (block comment)', () => {
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        "  /* if (Number(amount) <= 0) { throw new Error('bad'); } */",
        '  return true;',
        '}',
        '',
      ].join('\n'),
    );
    expect(scanMoneyPositivitySites(fixtureDir)).toHaveLength(0);
  });

  it('T5 — a block comment opened on the SAME line as a live comparison leaves it found, key unchanged (boundary case)', () => {
    // ⭐ raised by the auditor as reasoned-about-but-untested in revision 1: the stripper blanks
    // from the comment opener ONWARD, so a comparison that comes BEFORE the `/*` on its line must
    // still be found — this is the boundary the other two T5 cases don't exercise.
    writeFixture('site.ts', SITE);
    const baseline = onlySite(scanMoneyPositivitySites(fixtureDir), 'T5 boundary: baseline');

    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: string) {',
        '  if (Number(amount) <= 0) { /* this block comment',
        '     spans multiple lines',
        '     before it closes */',
        "    throw new Error('amount must be positive');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const afterComment = onlySite(
      scanMoneyPositivitySites(fixtureDir),
      'T5 boundary: after same-line block comment',
    );
    expect(afterComment.key).toBe(baseline.key);
  });

  it('a NEG_PAREN_GT-shaped site is also found, keyed the same way', () => {
    writeFixture(
      'site.ts',
      [
        'export function checkAmount(amount: number) {',
        '  if (!(amount > 0)) {',
        "    throw new Error('amount must be positive');",
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const site = onlySite(scanMoneyPositivitySites(fixtureDir), 'NEG_PAREN_GT shape');
    expect(site.key).toBe(censusKey('site.ts', '!(amount > 0)'));
  });
});

describe('extractComparison', () => {
  it('extracts the Number(...) comparison, including the full numeric literal', () => {
    expect(extractComparison('if (Number(amount) <= 0.005) {')).toBe('Number(amount) <= 0.005');
  });

  it('extracts the !(...) comparison', () => {
    expect(extractComparison('if (!(amount > 0)) {')).toBe('!(amount > 0)');
  });

  it('returns null when the line has neither shape', () => {
    expect(extractComparison('const x = amount + 1;')).toBeNull();
  });

  it('does not capture payload beyond the comparison — an error message or trailing comment is excluded', () => {
    const line = "if (Number(amount) <= 0) throw new Error('bad'); // note";
    expect(extractComparison(line)).toBe('Number(amount) <= 0');
  });

  it('prefers the OUTER match when a Number(...) comparison is wrapped in !( ... > N ) (precedence ruling)', () => {
    expect(extractComparison('if (!(Number(amount) > 0)) {')).toBe('!(Number(amount) > 0)');
  });

  it('keys the GUARDED comparison, not another Number(...) on the same line (anchoring fix)', () => {
    // ⛔ Before this fix, the key regex researched the whole line independently of which
    // comparison membership actually found — so on a line with two `Number(...)` calls, the key
    // could settle on the WRONG one. `Number(cap) > 5` is not a membership match (NUMBER_CMP
    // requires a literal `0` tail); `Number(amount) > 0`/`>= 0` are. Before the anchoring fix both
    // lines below extracted `'Number(cap) > 5'` — identical — so the real guard's operator could
    // change from `>` to `>=` with the key unchanged: a false green in exactly the direction this
    // module exists to prevent.
    const strict = extractComparison('if (Number(cap) > 5 || Number(amount) > 0) {');
    const orEqual = extractComparison('if (Number(cap) > 5 || Number(amount) >= 0) {');

    expect(strict).toBe('Number(amount) > 0');
    expect(orEqual).toBe('Number(amount) >= 0');
    expect(strict).not.toBe(orEqual);
  });

  it('the anchoring fix did not move what must stay pinned — precedence still outer, two-deep nesting still falls through', () => {
    // pin 1: the precedence ruling still holds where the regex can reach it.
    expect(extractComparison('if (!(Number(amount) > 0)) throw new Error(1);')).toBe(
      '!(Number(amount) > 0)',
    );
    // pin 2: blind spot (8) — two-deep nesting — is a pre-existing, DELIBERATELY unfixed gap
    // (Invariant 4 forbids widening either MATCHING regex in this task). A test that pins what
    // must stay broken confirms the anchoring fix did not accidentally close it.
    expect(extractComparison('if (!(Number.isFinite(Number(f)) && Number(f) > 0)) {')).toBe(
      'Number(f) > 0',
    );
  });
});

describe('normaliseComparison', () => {
  it('collapses whitespace runs to one space and trims — nothing else', () => {
    expect(normaliseComparison('  Number(amount)   <=   0.005  ')).toBe('Number(amount) <= 0.005');
  });

  it('does not lowercase', () => {
    expect(normaliseComparison('NUMBER(Amount) <= 0')).toBe('NUMBER(Amount) <= 0');
  });

  it('does not fold quotes or strip punctuation', () => {
    const raw = `it's "fine", (really).`;
    expect(normaliseComparison(raw)).toBe(raw);
  });
});

describe('censusKey', () => {
  it('is file + "::" + the normalised comparison', () => {
    expect(censusKey('loans/index.ts', '  Number(amount)  <=  0  ')).toBe(
      'loans/index.ts::Number(amount) <= 0',
    );
  });

  it('keeps two different files distinct for the identical comparison text', () => {
    const key1 = censusKey('a.ts', 'Number(amount) <= 0');
    const key2 = censusKey('b.ts', 'Number(amount) <= 0');
    expect(key1).not.toBe(key2);
  });

  it('keeps two different literals distinct in the same file (the tolerance case)', () => {
    const key1 = censusKey('cash-requests/index.ts', 'Number(after.outstanding) <= 0');
    const key2 = censusKey('cash-requests/index.ts', 'Number(after.outstanding) <= 0.005');
    expect(key1).not.toBe(key2);
  });
});

describe('stripComments — moved verbatim', () => {
  it('blanks a genuine line comment and a genuine block comment', () => {
    const src = ['// a comment', 'const n = 1;', '/* block comment */ const m = 2;'].join('\n');
    const stripped = stripComments(src);
    expect(stripped).not.toContain('a comment');
    expect(stripped).not.toContain('block comment');
    expect(stripped).toContain('const n = 1;');
    expect(stripped).toContain('const m = 2;');
  });

  it('preserves line count so reported line numbers stay accurate', () => {
    const src = '/* multi\nline\nblock */\nconst n = 1;\n';
    expect(stripComments(src).split('\n')).toHaveLength(src.split('\n').length);
  });

  it('does NOT special-case string literals — a `//` inside a string still opens a real blank (blind spot 6)', () => {
    // ⛔ the header's "strings are left alone" describes the IMPLEMENTATION CHOICE — no tokenizer
    // that understands string boundaries — not a guarantee that content inside a string survives.
    // Real code after a `//` embedded in an earlier string, on the same line, is genuinely lost.
    const src = "const u = 'http://a'; const n = 1;";
    const stripped = stripComments(src);
    // negative: the real code after the embedded `//` is genuinely lost...
    expect(stripped).not.toContain('const n = 1;');
    // ...but positive: this is not a degenerate empty/garbage result — the text before the `//`
    // survives, and the line count is preserved (what T1's `line` assertion relies on elsewhere).
    expect(stripped).toContain("const u = 'http:");
    expect(stripped.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('does NOT special-case string literals — a `/*` inside a string still opens a range (blind spot 7)', () => {
    const src = ["const s = '/*';", 'const n = 1;', "const t = '*/';"].join('\n');
    const stripped = stripComments(src);
    // negative: the `/*` embedded in the first string opens a range that runs to the next `*/` —
    // itself embedded in the third string — blanking the genuine code line between them...
    expect(stripped).not.toContain('const n = 1;');
    // ...but positive: the text before the opening `/*` and the text after the closing `*/` both
    // survive, and the line count is preserved — not a degenerate empty result.
    expect(stripped).toContain("const s = '");
    expect(stripped).toContain("';");
    expect(stripped.split('\n')).toHaveLength(src.split('\n').length);
  });
});
