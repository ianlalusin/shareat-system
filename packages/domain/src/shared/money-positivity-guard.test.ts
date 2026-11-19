import { afterAll, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { censusKey, scanMoneyPositivitySites } from './money-positivity-census';

/**
 * DEF-272 — the money-positivity census, now a SPELLING RATCHET.
 *
 * History: this scan was written (T-260, hardened by T-325/DEF-376) to find every `Number(X) <op> 0`
 * and `!(X > 0)` comparison under `packages/domain/src` and force a person to classify each one, because
 * `Number('abc') <= 0` is `false` — a NaN-blind positivity guard lets a malformed money string through.
 * It found 44 such sites, each hand-classified in a table.
 *
 * T-371 CLOSED THAT CLASS. Every NaN-blind money comparison in `packages/domain/src` was converted to
 * `compare()` / `isZero()` (and `compareQuantity` / `compareDecimal` on the quantity and factor axes) on
 * branded values minted by `decimal()` / `money()` / the quantity parser, so a non-finite value cannot
 * reach a comparison. The census therefore finds ZERO sites today, `CLASSIFIED_ENTRIES` is empty, and
 * the assertion is: the real tree contains no `Number(x) <cmp> 0` / `!(x > 0)` comparison at all.
 *
 * THE PRIMARY GUARD NOW IS T-371's G2: `tests/unit/t371-numeric-write-guard.test.ts` (type-checker based;
 * follows a string-derived `number` across helpers and flags string-vs-string relational comparisons, and
 * requires each hit to be rewritten to `compare*`/`isZero` on branded values or to carry a reason in its
 * EXEMPT map). That is the instrument that catches a NaN-blind comparison under ANY spelling.
 *
 * What THIS test still does: it is a cheap spelling ratchet. A NEW `Number(x) <cmp> 0` or `!(x > 0)`
 * added to `packages/domain/src` turns it red (T7), pointing at the exact line. The fix is to route the
 * value through `parseMoneyInput()` / `money()` and compare with `compare()` / `isZero()` — NOT to add a
 * `CLASSIFIED_ENTRIES` row to make it green. A row is for a site a person has read and judged to be
 * genuinely not a money-validity check (a display-only comparison, say), and must carry that reason.
 *
 * WHAT THIS RATCHET CANNOT SEE (the matching regexes in `money-positivity-census.ts` are not changed):
 * 1. Any other spelling: a bare local unwrapped earlier (`const x = Number(v); if (x < 0)`), a property
 *    path, a comparison against another value rather than a literal `0`. That is G2's job.
 * 2. It is textual, not type-resolved: comments are blanked, strings are not.
 * 3. A comparison split across lines stops matching (line-based scanner).
 * 4. A string containing a comment opener before a comparison can blank it (the stripper leaves strings
 *    alone). DEF-381 (nested-paren reach of `NEG_PAREN_GT`) and the one-site-per-line dedupe stay as
 *    recorded; they are out of scope here.
 * A clean run is a floor, not proof of "no NaN-blind compare" — that proof is G2.
 *
 * NON-VACUITY: a scanner that silently matches nothing would pass T7 forever. T6 therefore runs the SAME
 * scanner over a fixed fixture source (written to a temp directory) containing the known shapes and
 * asserts it finds exactly those, so a broken scanner fails here rather than reading as a clean tree.
 */

const DOMAIN_SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * The hand-maintained classification. EMPTY since T-371: every site the scanner used to find was
 * converted, not classified. Add an entry only after reading a new site and judging it NOT a
 * money-validity check; never regenerate it from scanner output. `checkFunctions` / `checkIdentifiers`
 * are a mechanically verifiable subset of a reason's claims, asserted in T11.
 */
const CLASSIFIED_ENTRIES: {
  file: string;
  comparison: string;
  reason: string;
  checkFunctions?: string[];
  checkIdentifiers?: string[];
}[] = [];

const CLASSIFIED: Record<string, string> = Object.fromEntries(
  CLASSIFIED_ENTRIES.map(({ file, comparison, reason }) => [censusKey(file, comparison), reason]),
);

/**
 * A key found at more than one site must be declared here with its exact multiplicity (the false-green
 * hole of keying on the comparison rather than the line). Empty: the real tree has no sites at all.
 */
const EXPECTED_SITE_COUNT: Record<string, number> = {};

function functionIsDeclaredIn(file: string, functionName: string): boolean {
  const source = readFileSync(join(DOMAIN_SRC, file), 'utf8');
  return new RegExp(`function\\s+${functionName}\\s*\\(`).test(source);
}

/** Invariant 5 — a computed key or comparison ending in `:<digits>` is a positional artifact. */
function hasPositionalKeySuffix(value: string): boolean {
  return /:\d+$/.test(value);
}

/** Invariant 5 — a reason citing `:<digits>` anywhere is a dangling line-number pointer. */
function hasPositionalPointer(value: string): boolean {
  return /:\d+\b/.test(value);
}

function countSourceFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== 'node_modules') n += countSourceFiles(p);
    } else if (/\.ts$/.test(e) && !/\.test\.ts$/.test(e) && !/\.d\.ts$/.test(e)) n++;
  }
  return n;
}

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'money-positivity-fixture-'));
afterAll(() => rmSync(FIXTURE_DIR, { recursive: true, force: true }));

/** The fixed fixture: shapes the scanner must find, plus lines it must NOT find. */
const FIXTURE_SOURCE = [
  'export function a(input: { amount: string }) {',
  "  if (Number(input.amount) <= 0) throw new Error('x');", // found: NUMBER_CMP
  "  if (!(Number(input.amount) > 0)) throw new Error('y');", // found: negated paren (outer wins)
  "  if (!(qty > 0)) throw new Error('z');", // found: NEG_PAREN_GT on a bare local
  "  if (Number(rate) < 0) throw new Error('w');", // found
  '  if (Number(fee) > 0.005) {}', // found: the tolerance literal is kept whole in the key
  '  // if (Number(commented) <= 0) {}', // NOT found: comment
  '  if (compare(ok, ZERO) <= 0) {}', // NOT found: the converted spelling
  '}',
  'const toNum = (s: string) => Number(s);',
  'export function b(s: string) {',
  '  return toNum(s) > 0 && Number(s) >= 0;', // found: Number(s) >= 0 only; the helper call is not
  '}',
  '',
].join('\n');

describe('DEF-272 — money-positivity spelling ratchet (census as a test, not a census)', () => {
  it('T6 — non-vacuity: the SAME scanner finds exactly the known shapes in a fixed fixture source', () => {
    mkdirSync(join(FIXTURE_DIR, 'fx'), { recursive: true });
    writeFileSync(join(FIXTURE_DIR, 'fx', 'sample.ts'), FIXTURE_SOURCE);
    const found = scanMoneyPositivitySites(FIXTURE_DIR).map((s) => s.key);
    expect(found).toEqual([
      'fx/sample.ts::Number(input.amount) <= 0',
      'fx/sample.ts::!(Number(input.amount) > 0)',
      'fx/sample.ts::!(qty > 0)',
      'fx/sample.ts::Number(rate) < 0',
      'fx/sample.ts::Number(fee) > 0.005',
      'fx/sample.ts::Number(s) >= 0',
    ]);
  });

  it('T9 — the real-tree scan walks a non-trivial number of source files (T7 is not vacuously green)', () => {
    // Derived at runtime from an independent walk; a wrong path or skip-list would make this 0.
    expect(countSourceFiles(DOMAIN_SRC)).toBeGreaterThan(50);
  });

  it('T7 — every match is classified — a new Number(x) <cmp> 0 is a NaN-blind money check until proven otherwise', () => {
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    const unexplained = sites.filter((s) => !(s.key in CLASSIFIED));
    if (unexplained.length > 0) {
      const detail = unexplained
        .map((s) => `  ${s.file}:${s.line}  ${s.raw}  [key: ${s.key}]`)
        .join('\n');
      throw new Error(
        `${unexplained.length} money-positivity comparison(s) are not in CLASSIFIED — T-371 converted ` +
          `every such site to compare()/isZero() on branded values. Route the value through ` +
          `parseMoneyInput()/money() and use compare()/isZero() instead of re-adding the old shape ` +
          `(CLASSIFIED is for a site a person has read and judged NOT a money-validity check):\n${detail}`,
      );
    }
    expect(unexplained).toEqual([]);
  });

  it('T8 — CLASSIFIED names no site the scanner no longer finds — a stale entry hides scanner drift', () => {
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    // "at least one", not "exactly one": a merged key legitimately covers several sites (see T12).
    const found = new Set(sites.map((s) => s.key));
    const stale = Object.keys(CLASSIFIED).filter((k) => !found.has(k));
    expect(stale).toEqual([]);
  });

  it('T10 — Invariant 5: no computed key/comparison carries a positional suffix, and no reason carries a positional pointer', () => {
    // Prove the predicates can fail first, fed fabricated values directly.
    expect(hasPositionalKeySuffix('some/file.ts::Number(amount) <= 0:42')).toBe(true);
    expect(hasPositionalKeySuffix('some/file.ts::Number(amount) <= 0')).toBe(false);
    expect(hasPositionalPointer('routed — same `refunded` as :405')).toBe(true);
    expect(hasPositionalPointer('routed — createCashRequest, `amount` above')).toBe(false);

    expect(Object.keys(CLASSIFIED).filter(hasPositionalKeySuffix)).toEqual([]);

    const positionalComparisons = CLASSIFIED_ENTRIES.filter((e) =>
      hasPositionalKeySuffix(e.comparison),
    ).map((e) => censusKey(e.file, e.comparison));
    expect(positionalComparisons).toEqual([]);

    const positionalReasons = CLASSIFIED_ENTRIES.filter((e) => hasPositionalPointer(e.reason)).map(
      (e) => censusKey(e.file, e.comparison),
    );
    expect(positionalReasons).toEqual([]);
  });

  it('T11 — the reason<->site pairing, on the mechanically checkable subset only', () => {
    // Trivially passes while CLASSIFIED_ENTRIES is empty (T-371); engages the moment an entry is added.
    for (const entry of CLASSIFIED_ENTRIES.filter((e) => e.checkFunctions?.length)) {
      for (const fn of entry.checkFunctions ?? []) {
        expect(functionIsDeclaredIn(entry.file, fn)).toBe(true);
      }
    }
    for (const entry of CLASSIFIED_ENTRIES.filter((e) => e.checkIdentifiers?.length)) {
      for (const id of entry.checkIdentifiers ?? []) {
        expect(entry.comparison).toContain(id);
      }
    }
  });

  it('T12 — EXPECTED_SITE_COUNT holds both directions (currently: the real tree has no sites)', () => {
    const sites = scanMoneyPositivitySites(DOMAIN_SRC);
    const sitesByKey = new Map<string, typeof sites>();
    for (const s of sites) {
      const list = sitesByKey.get(s.key) ?? [];
      list.push(s);
      sitesByKey.set(s.key, list);
    }

    const undeclaredOrMismatched: string[] = [];
    for (const [key, list] of sitesByKey) {
      if (list.length <= 1) continue;
      const declared = EXPECTED_SITE_COUNT[key];
      if (declared !== list.length) {
        const detail = list.map((s) => `    ${s.file}:${s.line}  ${s.comparison}`).join('\n');
        undeclaredOrMismatched.push(
          `  ${key} — found ${list.length} site(s), EXPECTED_SITE_COUNT says ` +
            `${declared ?? 'undeclared'}:\n${detail}`,
        );
      }
    }
    if (undeclaredOrMismatched.length > 0) {
      throw new Error(
        `${undeclaredOrMismatched.length} key(s) have an undeclared or mismatched multiplicity:\n` +
          undeclaredOrMismatched.join('\n'),
      );
    }
    expect(undeclaredOrMismatched).toEqual([]);

    const mismatchedDeclarations: string[] = [];
    for (const [key, expected] of Object.entries(EXPECTED_SITE_COUNT)) {
      const list = sitesByKey.get(key) ?? [];
      if (list.length !== expected) {
        const detail =
          list.map((s) => `    ${s.file}:${s.line}  ${s.comparison}`).join('\n') ||
          '    (no sites found at all)';
        mismatchedDeclarations.push(`  ${key} — declared ${expected}, found ${list.length}:\n${detail}`);
      }
    }
    if (mismatchedDeclarations.length > 0) {
      throw new Error(
        `${mismatchedDeclarations.length} EXPECTED_SITE_COUNT entr(y/ies) no longer match reality:\n` +
          mismatchedDeclarations.join('\n'),
      );
    }
    expect(mismatchedDeclarations).toEqual([]);
    // Both directions at the new real count: nothing declared, nothing found.
    expect(Object.keys(EXPECTED_SITE_COUNT)).toEqual([]);
    expect(sites).toEqual([]);
  });
});
