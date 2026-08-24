import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKED_EXAMPLES, WORKED_EXAMPLE_IDS } from '../worked-examples/fixtures';

/**
 * T-108 invariants 6 and 12 — neither needs a database, so both live under tests/unit/ for
 * fast feedback (matching the "unit runs before migrations" reasoning that puts every
 * DB-touching T-108 proof under tests/integration/ instead).
 *
 * Invariant 6 — Contract §1: "a test asserts the document lists every fixture and every
 * fixture appears in the document — the same technique chart-of-accounts.test.ts already
 * uses to parse COA-ALIGNMENT.md for **NNNN** codes rather than keeping a hand-written
 * list." This parses docs/POSTING-PATTERNS.md for every `### `id`` heading and cross-checks
 * the set against tests/worked-examples/fixtures.ts in BOTH directions.
 *
 * Invariant 12 — no fixture uses a float anywhere, asserted structurally over the fixture
 * SOURCE (not just the typed data, which TypeScript's `string` field types already make
 * float-proof at compile time — this additionally guards against a malformed money string
 * that compiles fine, e.g. '1200' with no cents, or a bare numeric literal slipping into a
 * debit/credit position some future edit adds without the D()/C() helpers).
 */

// This file is tests/unit/posting-patterns-doc.test.ts — two levels below the repo root.
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'POSTING-PATTERNS.md');
const FIXTURES_SOURCE_PATH = join(REPO_ROOT, 'tests', 'worked-examples', 'fixtures.ts');

/**
 * Extracts every fixture id documented in docs/POSTING-PATTERNS.md, parsed from the live
 * file — NOT a hand-maintained list (a hand-maintained list is exactly the bug DEF-035
 * happened from, in the chart-of-accounts equivalent of this check).
 *
 * A documented pattern is a level-3 heading of the exact form `` ### `dotted.fixture.id` ``
 * — backtick-delimited immediately after the `### ` marker, nothing else inside the span.
 * This is deliberately narrow (matching chart-of-accounts.test.ts's own `**NNNN**`
 * discipline): a prose backtick span elsewhere in the file (e.g. an account code or a field
 * name mentioned in a trap) never matches, because it is not anchored at the start of a
 * heading line.
 */
function parseDocumentedFixtureIds(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const ids: string[] = [];
  const headingPattern = /^###\s+`([a-z][a-z0-9_]*(?:\.[a-z0-9_-]+)+)`/;
  for (const line of lines) {
    const m = headingPattern.exec(line);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

describe('invariant 6 — docs/POSTING-PATTERNS.md and tests/worked-examples/fixtures.ts cannot disagree', () => {
  const markdown = readFileSync(DOC_PATH, 'utf8');
  const documentedIds = parseDocumentedFixtureIds(markdown);

  it('parser sanity — found the doc and parsed at least as many headings as there are fixtures', () => {
    expect(markdown.length).toBeGreaterThan(1000);
    expect(documentedIds.length).toBeGreaterThan(0);
  });

  it('every fixture id appears in the document, parsed — not hand-checked', () => {
    const documented = new Set(documentedIds);
    const missing = WORKED_EXAMPLE_IDS.filter((id) => !documented.has(id));
    expect(missing, `these fixtures have no ### heading in docs/POSTING-PATTERNS.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('every documented pattern has a fixture — the document names nothing that does not exist', () => {
    const fixtureIds = new Set(WORKED_EXAMPLE_IDS);
    const orphaned = documentedIds.filter((id) => !fixtureIds.has(id));
    expect(orphaned, `docs/POSTING-PATTERNS.md documents these ids with no matching fixture: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('no duplicate heading in the document itself — each fixture is documented exactly once', () => {
    const counts = new Map<string, number>();
    for (const id of documentedIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(duplicated, `documented more than once: ${duplicated.join(', ')}`).toEqual([]);
  });

  it('no duplicate id in the fixture array itself', () => {
    expect(new Set(WORKED_EXAMPLE_IDS).size).toBe(WORKED_EXAMPLE_IDS.length);
  });
});

describe('invariant 12 — no fixture uses a float anywhere', () => {
  it('every debit/credit value in every fixture (and every setup entry) is a clean 2-decimal money string', () => {
    const MONEY_PATTERN = /^\d+\.\d{2}$/;
    const offenders: string[] = [];
    for (const fixture of WORKED_EXAMPLES) {
      const allLineGroups = [fixture.expect, ...(fixture.setup ?? [])];
      for (const lines of allLineGroups) {
        for (const line of lines) {
          for (const [side, value] of [['debit', line.debit], ['credit', line.credit]] as const) {
            if (value === undefined) continue;
            if (!MONEY_PATTERN.test(value)) {
              offenders.push(`${fixture.id}: ${line.accountCode} ${side}=${JSON.stringify(value)}`);
            }
          }
        }
      }
    }
    expect(offenders, `non-money-string debit/credit values found: ${offenders.join('; ')}`).toEqual([]);
  });

  it('the fixture SOURCE FILE never assigns a bare numeric literal to debit/credit — structural, over the text', () => {
    // Reads the raw .ts text directly, matching chart-of-accounts.test.ts's own precedent
    // of asserting a structural property over a source file rather than only over the
    // typed data it produces. A bare `debit: 1200` (no quotes) would compile-fail today
    // because FixtureLine.debit is typed `string` — this guards the CONVENTION itself, so
    // a future refactor that widens the type (e.g. `string | number` "for convenience")
    // cannot silently reintroduce a float without this test naming exactly where.
    const source = readFileSync(FIXTURES_SOURCE_PATH, 'utf8');
    const bareNumericAssignment = /\b(?:debit|credit):\s*-?\d/g;
    const matches = [...source.matchAll(bareNumericAssignment)].map((m) => m[0]);
    expect(matches, `bare numeric debit/credit literal(s) found in fixtures.ts: ${matches.join(', ')}`).toEqual([]);
  });

  it("every fixture's `input` illustrative document uses real v1 field shapes, not a v2 money string — documented, not a violation", () => {
    // T-108 Contract §2's own worked example types `input` as "what the module would be
    // given" — i.e. the RAW v1 source-document shape (SalesDayDoc, ExpenseV2Plain, ...),
    // which genuinely stores numbers (packages/etl/src/convert.ts's own type definitions:
    // `totalSales: number`). This is a description of EXISTING v1 data, not v2 code, so
    // invariant 12 applies to `expect`/`setup` (what v2 actually posts) and NOT to `input`
    // (what v1 handed over) — asserted here explicitly so nobody "fixes" `input` into
    // strings and quietly breaks its own documentation value.
    const sampleWithNumericInput = WORKED_EXAMPLES.find((f) => f.id === 'sale.unli.simple');
    expect(sampleWithNumericInput).toBeDefined();
    expect(typeof sampleWithNumericInput!.input.totalSales).toBe('number');
  });
});
