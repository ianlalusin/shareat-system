import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-328 Test 3 — docs/tasks/328-every-typed-amount-reaches-the-parser-that-already-exists.md
 * §Tests item 3, as hardened by the orchestrator after the auditor found a 6th spelling
 * (`strs(fd, key)` — `str`'s plural, validating nothing, measured 10 files / 35 call sites) that
 * is invisible to all five earlier shapes for one character's reason, AND lives inside files that
 * already LOOK covered because each also defines a local `function str(` — so a FILE-level check
 * reports them present while the individual SITES inside them were never enumerated. This test
 * asserts at SITE granularity, not file granularity.
 *
 * ⭐⭐ RE-KEYED, ORCHESTRATOR'S RULING: NOT BY LINE NUMBER. A first version of this test keyed
 * sites on `(file, line)`, and two real sites drifted out from under it — `ap/actions.ts`'s
 * `allocateAmount_${expenseId}` moved from the enumeration's L244 to L249 when the builder added a
 * comment above it while investigating the "7th shape" in the same file, concurrently. Bible §13
 * row 204: "PREFER A NAME TO A POSITION. An identifier survives every edit above it; a line number
 * does not." The spec's own anchor table already said this ("GREP THESE, NEVER A LINE NUMBER") and
 * it was not carried into the enumeration format. So: this test keys every site on
 * `(file, distinctive literal token)` — the field-name string or template-literal segment the call
 * itself carries — never a position, and matches it against the enumeration by SUBSTRING, so it
 * reads correctly whether a row cites `` `key` L123 `` (today's format, the position is ignored)
 * or a pure anchor-token column (whatever the builder lands next).
 *
 * ⭐ DERIVE FROM SHAPE, NOT SPELLING (local-errormessage-convergence.test.ts's own lesson, cited
 * by this task's spec). Each site pattern matches the STRUCTURE of a call — an identifier applied
 * to `fd`/`formData` followed by a comma, i.e. an actual call argument list — never the specific
 * helper's own name. A definition (`function str(fd: FormData, key: string)`) is excluded on
 * purpose: after `fd` comes a colon in a definition and a comma in a call.
 *
 * ⛔ SCOPED TO SITE-GRANULARITY SPELLINGS ONLY — plain-string `str(fd, 'name')` (spelling 1/2) is
 * DELIBERATELY EXCLUDED. It is the general-purpose form-value getter, used for ids, names, dates
 * and booleans as often as money; the spec (and docs/discovery/t328-enumeration.md's own
 * "Enumeration — site granularity" section) treats it as a FILE-level denominator cross-check (the
 * "56 files" figure), never as a per-call-site money candidate. An earlier version of this sweep
 * matched every `str(fd, 'anyKey')` and produced 851 "candidates" against a real population that
 * turned out to be ~85 — caught only because 851 was absurd against a known rough figure kept in
 * mind while writing it (bible §12 row 181: a sweep reporting a total needs a control it can be
 * checked against, not blind trust in whatever count falls out).
 *
 * What this sweep matches, all named in the spec or its anchor table:
 *   1. `str(fd, \`...\`)` / `str(formData, \`...\`)` — spelling 4, template-literal keys ONLY.
 *   2. `strs(fd, ...)` / `list(fd, ...)` (and the `formData` spelling of each) — the 6th spelling.
 *      `list` is the identical `str`'s-plural shape under a NINTH name, `inventory/counts/actions.ts`
 *      only — found by comparing this sweep's own count (34) against the enumeration's own stated
 *      35 rather than accepting a near-miss; the doc's heading already read "strs/list".
 *   3. `money(fd, ...)` / `money(formData, ...)` — the channel-settlements shadow named in the
 *      spec's own anchor table.
 *   4. `amount(fd, ...)` / `amount(formData, ...)` — the 5th spelling's local-helper half.
 *   5. `Number(str(...)` / `Number(fd.get(...)` / `Number(formData.get(...)` — spelling 3.
 *   6. `key.startsWith('<prefix>')` inside a `.entries()` loop — the 5th spelling's loop half,
 *      keyed on the prefix literal itself (`'tender_'`, `'channel_'`, `'count:'`) rather than the
 *      `for (...)` line, since the prefix is what actually identifies which field-group the loop
 *      is reading and is exactly what the enumeration's own "tender_* loop" rows already say.
 *
 * ⚠️ NOT covered, and why: DEF-379's app-layer `money()` IMPORTS (needs an import-graph check, not
 * a line shape) and the "7th shape" (`.filter(...)` silently dropping a line — found by manual
 * trace). Re-deriving either here would be inventing an untested heuristic, not checking a
 * documented one. Stated so this sweep's silence on them is not read as "checked and clean".
 *
 * ⛔ NO COUNT IN A TEST NAME (spec §Tests item 3) — every denominator is measured at runtime and
 * printed in the failure message, never asserted as a literal.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const appsRoot = resolve(repoRoot, 'apps');
const enumerationPath = resolve(repoRoot, 'docs', 'discovery', 't328-enumeration.md');

function posix(absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join('/');
}

/**
 * ⭐ --exclude-dir=node_modules --exclude-dir=.next, in-process — spec §Population, `[A-2026-09-20]`.
 * ⛔ ALSO excludes every `tests/` directory and `.test.ts(x)` file — the population is application
 * code reaching a database column, never test code, and without this exclusion this file's own
 * regex SOURCE matches its own sweep.
 */
function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'tests') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

interface CandidateSite {
  file: string;
  anchor: string;
  shape: string;
  snippet: string;
}

/**
 * A declaration line — never a call site, even though `fd` follows the identifier's `(`.
 * ⚠️ `list` is here on purpose: `inventory/counts/actions.ts` names the identical `str`'s-plural
 * shape `list(fd, key)` instead of `strs` — same helper, ninth name, found by comparing this
 * sweep's own count (34) against the enumeration doc's stated 35 and tracing the one-off gap
 * rather than accepting a near-miss, which is exactly the discipline the 6th-spelling lesson is
 * about. The doc's own heading already said "strs/list"; this sweep had only matched the first.
 */
const IS_DECLARATION = /^\s*(?:export\s+)?(?:async\s+)?function\s+(?:str|strs|list|amount|money)\s*\(/;

const QUOTED = `('[^']*'|"[^"]*"|` + '`[^`]*`)';

/** Call-shaped sites: identifier(fd|formData, <quoted key>) — key captured for the anchor. */
const CALL_PATTERNS: Array<{ shape: string; re: RegExp }> = [
  { shape: 'str(fd|formData, `template`)', re: new RegExp('\\bstr\\(\\s*(?:fd|formData)\\s*,\\s*(`[^`]*`)', 'g') },
  { shape: 'strs|list(fd|formData, ...)', re: new RegExp('\\b(?:strs|list)\\(\\s*(?:fd|formData)\\s*,\\s*' + QUOTED, 'g') },
  { shape: 'money(fd|formData, ...) shadow', re: new RegExp('\\bmoney\\(\\s*(?:fd|formData)\\s*,\\s*' + QUOTED, 'g') },
  { shape: 'amount(fd|formData, ...)', re: new RegExp('\\bamount\\(\\s*(?:fd|formData)\\s*,\\s*' + QUOTED, 'g') },
  {
    shape: 'Number(<form value>)',
    re: new RegExp(
      'Number\\(\\s*(?:str\\(\\s*(?:fd|formData)\\s*,\\s*|(?:fd|formData)\\.get\\(\\s*)' + QUOTED,
      'g',
    ),
  },
];

/** The loop-prefix shape — keyed on the prefix literal, not the `for (...) of entries()` line. */
const LOOP_PREFIX_PATTERN = new RegExp('key\\.startsWith\\(\\s*' + QUOTED, 'g');

/** Strip the surrounding quote/backtick, and for a template literal pick its longest static segment. */
function extractAnchor(quotedToken: string): string {
  const inner = quotedToken.slice(1, -1);
  if (quotedToken.startsWith('`') && inner.includes('${')) {
    const segments = inner
      .split(/\$\{[^}]*\}/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 3);
    segments.sort((a, b) => b.length - a.length);
    return segments[0] ?? inner;
  }
  return inner;
}

/**
 * The actual sweep, factored out from the filesystem so the control test below can hand it
 * fabricated source TEXT instead of a real file — proving the extraction+matching logic itself
 * discriminates, without writing anything into apps/ to do it.
 */
function extractSitesFromText(file: string, text: string): CandidateSite[] {
  const sites: CandidateSite[] = [];
  text.split('\n').forEach((lineText) => {
    if (IS_DECLARATION.test(lineText)) return;
    for (const { shape, re } of CALL_PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lineText))) {
        sites.push({ file, anchor: extractAnchor(m[1]!), shape, snippet: lineText.trim() });
      }
    }
    LOOP_PREFIX_PATTERN.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = LOOP_PREFIX_PATTERN.exec(lineText))) {
      sites.push({ file, anchor: extractAnchor(lm[1]!), shape: 'key.startsWith(prefix)', snippet: lineText.trim() });
    }
  });
  return sites;
}

function findCandidateSites(): CandidateSite[] {
  const sites: CandidateSite[] = [];
  for (const absolute of tsFilesUnder(appsRoot)) {
    // T-422: apps/pos is a verbatim copy of POS v1 (client Firestore code, no ERP FormData
    // actions); its money input is rewritten by T-423 (PC-4), not swept here. Remove when T-423 lands.
    if (/^apps\/pos\//.test(posix(absolute))) continue;
    sites.push(...extractSitesFromText(posix(absolute), readFileSync(absolute, 'utf8')));
  }
  return sites;
}

interface TableRow {
  site: string;
  file: string;
  disposition: string;
  reason: string;
}

function cellsOf(line: string): string[] {
  return line.trim().split('|').slice(1, -1).map((c) => c.trim());
}

/**
 * ⭐ THE DOCUMENT HOLDS MANY TABLES — a "Measure | Value | Command" census table, others besides —
 * and only the ones headed exactly `site | file | disposition | reason` are this test's data. A
 * table block runs from its header through its separator row to the next non-table line.
 */
function parseEnumerationTable(markdown: string): TableRow[] {
  const rows: TableRow[] = [];
  const lines = markdown.split('\n');
  let inTargetTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) {
      inTargetTable = false;
      continue;
    }
    const cells = cellsOf(line);
    const isHeader =
      cells.length >= 4 &&
      cells[0]!.toLowerCase() === 'site' &&
      cells[1]!.toLowerCase() === 'file' &&
      cells[2]!.toLowerCase() === 'disposition';
    if (isHeader) {
      inTargetTable = true;
      continue;
    }
    if (!inTargetTable) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells.length < 4) continue;
    const [site, file, disposition, ...rest] = cells;
    rows.push({ site: site!, file: file!, disposition: disposition!, reason: rest.join('|') });
  }
  return rows;
}

/** Does a table row, in the SAME file, carry this anchor as a literal substring of its site text? */
function findMatchingRows(rows: TableRow[], candidate: CandidateSite): TableRow[] {
  return rows.filter((r) => r.file === candidate.file && r.site.includes(candidate.anchor));
}

describe('T-328 Test 3 — the enumeration accounts for every site, not merely every file', () => {
  it('docs/discovery/t328-enumeration.md exists (the approved enumeration)', () => {
    let exists = true;
    try {
      readFileSync(enumerationPath, 'utf8');
    } catch {
      exists = false;
    }
    expect(
      exists,
      'docs/discovery/t328-enumeration.md does not exist yet — the builder has not produced the ' +
        'approved site enumeration Contract §1 requires before any conversion.',
    ).toBe(true);
  });

  it('every candidate site (str-template/strs-list/money/amount/Number/loop-prefix shapes) has a disposition in the enumeration, keyed by anchor not line', () => {
    const candidates = findCandidateSites();
    expect(
      candidates.length,
      'the shape sweep found nothing under apps/ — that would be a bug in this test, not a clean tree',
    ).toBeGreaterThan(0);
    // Sweep-control (bible §12 row 181): this population is a small, high-signal subset of the
    // repo (template-literal keys, strs(), the money() shadow, amount(), Number()-wraps and
    // .entries() loop prefixes) — nowhere near the file count, and nowhere near the 851 the
    // discarded plain-str() sweep produced. A three-digit jump here on an unrelated change is a
    // sign this sweep started matching something it should not, not that the repo grew that fast.
    expect(candidates.length).toBeLessThan(300);

    let markdown: string;
    try {
      markdown = readFileSync(enumerationPath, 'utf8');
    } catch {
      throw new Error(
        `docs/discovery/t328-enumeration.md does not exist, so ${candidates.length} candidate ` +
          'sites measured just now cannot be checked against it. See the previous test.',
      );
    }
    const rows = parseEnumerationTable(markdown);
    expect(
      rows.length,
      'the enumeration file exists but no table rows were parsed — check the | site | file | disposition | reason | block headers',
    ).toBeGreaterThan(0);

    const badDisposition = rows.filter((r) => r.disposition !== 'IN' && r.disposition !== 'OUT');
    expect(
      badDisposition.map((r) => `${r.file} (${r.site}): "${r.disposition}"`),
      "every row's disposition must be exactly IN or OUT",
    ).toEqual([]);

    const uncovered = candidates.filter((c) => findMatchingRows(rows, c).length === 0);
    expect(
      uncovered.map((c) => `${c.file} [${c.shape}] anchor="${c.anchor}" — ${c.snippet}`),
      `${uncovered.length} of ${candidates.length} measured candidate sites have no row in the same ` +
        'file whose site text contains their anchor token. Each must appear with a disposition (IN ' +
        'or OUT), never silently absent.',
    ).toEqual([]);
  });

  it('IN and OUT together account for the whole measured population', () => {
    const candidates = findCandidateSites();
    let markdown: string;
    try {
      markdown = readFileSync(enumerationPath, 'utf8');
    } catch {
      throw new Error('docs/discovery/t328-enumeration.md does not exist yet — see the first test in this file.');
    }
    const rows = parseEnumerationTable(markdown);

    const unaccounted = candidates.filter((c) => {
      const matches = findMatchingRows(rows, c);
      return !matches.some((r) => r.disposition === 'IN' || r.disposition === 'OUT');
    });
    expect(
      unaccounted.map((c) => `${c.file} anchor="${c.anchor}"`),
      `${unaccounted.length} of ${candidates.length} measured sites are neither IN nor OUT in the enumeration`,
    ).toEqual([]);
  });

  /**
   * ⭐⭐ THE CONTROL — bible §3.2, orchestrator's requirement after Test 3 came back green against
   * the real enumeration: a coverage guard that has only ever seen a clean result is
   * indistinguishable from one that checks nothing. This proves the checker DISCRIMINATES, not
   * just that today's real data happens to pass it — a known positive AND a known negative, built
   * entirely as an in-test fixture. ⛔ Never touches docs/discovery/t328-enumeration.md — that is
   * the builder's file, and mutating it to prove a point would be the exact collision the role
   * split exists to prevent.
   */
  describe('control — proving the checker can actually fail, not only pass', () => {
    const FABRICATED_SOURCE = [
      "const a = str(formData, `allocateAmount_${id}`);",
      "const b = strs(fd, 'unitCost');",
      "if (!key.startsWith('tender_')) continue;",
    ].join('\n');

    it('extractSitesFromText finds all three fabricated sites', () => {
      const sites = extractSitesFromText('fixture.ts', FABRICATED_SOURCE);
      expect(sites.map((s) => s.anchor).sort()).toEqual(['allocateAmount_', 'tender_', 'unitCost'].sort());
    });

    it('a site present in the fabricated table is reported covered', () => {
      const sites = extractSitesFromText('fixture.ts', FABRICATED_SOURCE);
      const complete = [
        '| site | file | disposition | reason |',
        '|---|---|---|---|',
        '| `allocateAmount_${id}` | fixture.ts | IN | test fixture |',
        "| `unitCost` | fixture.ts | OUT | test fixture |",
        "| `tender_` loop | fixture.ts | IN | test fixture |",
      ].join('\n');
      const rows = parseEnumerationTable(complete);
      const uncovered = sites.filter((c) => findMatchingRows(rows, c).length === 0);
      expect(uncovered, 'a fully-covered fabricated table must report zero uncovered sites').toEqual([]);
    });

    it("⭐ a site DELIBERATELY OMITTED from the fabricated table IS reported uncovered — the actual red this checker must be able to produce", () => {
      const sites = extractSitesFromText('fixture.ts', FABRICATED_SOURCE);
      // `unitCost` is deliberately left out — the only difference from the complete table above.
      const missingOne = [
        '| site | file | disposition | reason |',
        '|---|---|---|---|',
        '| `allocateAmount_${id}` | fixture.ts | IN | test fixture |',
        "| `tender_` loop | fixture.ts | IN | test fixture |",
      ].join('\n');
      const rows = parseEnumerationTable(missingOne);
      const uncovered = sites.filter((c) => findMatchingRows(rows, c).length === 0);
      expect(uncovered.map((c) => c.anchor)).toEqual(['unitCost']);
    });

    it('a site present but with no valid disposition is reported unaccounted, not covered', () => {
      const sites = extractSitesFromText('fixture.ts', FABRICATED_SOURCE);
      const badDisposition = [
        '| site | file | disposition | reason |',
        '|---|---|---|---|',
        '| `allocateAmount_${id}` | fixture.ts | IN | test fixture |',
        '| `unitCost` | fixture.ts | MAYBE | test fixture — not IN or OUT |',
        "| `tender_` loop | fixture.ts | IN | test fixture |",
      ].join('\n');
      const rows = parseEnumerationTable(badDisposition);
      const unaccounted = sites.filter((c) => {
        const matches = findMatchingRows(rows, c);
        return !matches.some((r) => r.disposition === 'IN' || r.disposition === 'OUT');
      });
      expect(unaccounted.map((c) => c.anchor)).toEqual(['unitCost']);
    });
  });
});
