/**
 * T-313 / DEF-353 — every `DEF-NNN` row in `docs/DEFECTS-REGISTER.md` must carry the same number
 * of columns as its own section's header row.
 *
 * Closing DEF-346 and DEF-349 meant editing their cells by hand, so the orchestrator asserted
 * those two rows were well-formed first — and found thirty-three others that are not: they render
 * `State` and `Disposition` in the wrong columns, because a pipe character inside the row's own
 * prose split a cell that should have stayed whole. Every tool that has ever parsed this register
 * (including a human reading the rendered table) read those rows wrong.
 *
 * ⛔ **The column count is NEVER hardcoded.** Sections A–D and E genuinely have a different shape
 * (`# | Sev | App | Defect | State | Disposition` vs `# | Sev | Defect | State | Disposition`) —
 * a hardcoded 7 or 6 would have been wrong for the other half of the file. Each section's own
 * header row is parsed to learn its column count, so a sixth section with its own shape needs no
 * change here.
 *
 * ⚠️ **Count UNESCAPED pipes only.** A `\|` renders inside a cell and splits nothing — several
 * rows quote a shell pipeline or a `||` boolean-or verbatim in backticks (e.g. `ls docs/ops | grep
 * -i budget`), and every one of those pipes is a real character in the document, not a column
 * separator. A naive split on `|` over this file reports rows that are actually fine.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalise, unescapedPipeCount } from './lib/document-facts';

const REGISTER_PATH = fileURLToPath(new URL('../../docs/DEFECTS-REGISTER.md', import.meta.url));

interface Section {
  readonly letter: string;
  readonly start: number; // inclusive line index into `lines`
  readonly end: number; // exclusive
  readonly headerLine: string;
  readonly expectedPipes: number;
}

// ⛔ T-317: `normalise` and `unescapedPipeCount` moved to `./lib/document-facts` so guard 6
// (PROJECT_BIBLE.md §13's decision-row shape) can reuse this exact counter instead of writing a
// second one (invariant 6). Behaviour unchanged — same backslash check, same CRLF normalisation.

function parseSections(text: string): Section[] {
  const lines = normalise(text).split('\n');
  const sectionHeaderRe = /^## ([A-Z])\./;
  const starts: Array<{ letter: string; line: number }> = [];
  lines.forEach((l, i) => {
    const m = sectionHeaderRe.exec(l);
    if (m) starts.push({ letter: m[1]!, line: i });
  });

  const sections: Section[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s]!.line;
    const end = s + 1 < starts.length ? starts[s + 1]!.line : lines.length;
    // The section's own table header row — the first line in its range starting "| #".
    const headerLine = lines.slice(start, end).find((l) => /^\|\s*#\s*\|/.test(l));
    if (!headerLine) continue; // a section with no table (shouldn't happen; not this guard's job)
    sections.push({
      letter: starts[s]!.letter,
      start,
      end,
      headerLine,
      expectedPipes: unescapedPipeCount(headerLine),
    });
  }
  return sections;
}

interface RowCheck {
  readonly id: string;
  readonly section: string;
  readonly line: number; // 1-indexed
  readonly count: number;
  readonly expected: number;
}

function checkRows(text: string): RowCheck[] {
  const lines = normalise(text).split('\n');
  const sections = parseSections(text);
  const failures: RowCheck[] = [];
  const rowRe = /^\|\s*\*\*(DEF-\d+)\*\*\s*\|/;
  for (const s of sections) {
    for (let i = s.start; i < s.end; i++) {
      const m = rowRe.exec(lines[i]!);
      if (!m) continue;
      const count = unescapedPipeCount(lines[i]!);
      if (count !== s.expectedPipes) {
        failures.push({ id: m[1]!, section: s.letter, line: i + 1, count, expected: s.expectedPipes });
      }
    }
  }
  return failures;
}

describe('T-313 / DEF-353 — every register row matches its own section header shape', () => {
  it('⭐ non-vacuity: the scan found real sections and real rows (DEF-179s own lesson)', () => {
    // A DEF-179-shaped scanner that silently finds zero sections or zero rows would report a
    // spotless register for the worst possible reason.
    const text = readFileSync(REGISTER_PATH, 'utf8');
    const sections = parseSections(text);
    expect(sections.length).toBeGreaterThan(0);
    const totalRows = sections.reduce((n, s) => {
      const lines = normalise(text).split('\n');
      const rowRe = /^\|\s*\*\*DEF-\d+\*\*\s*\|/;
      let c = 0;
      for (let i = s.start; i < s.end; i++) if (rowRe.test(lines[i]!)) c++;
      return n + c;
    }, 0);
    expect(totalRows).toBeGreaterThan(0);
  });

  it('⭐ every section learns its column count from its OWN header row, not a hardcoded number', () => {
    // A–D and E genuinely differ (App column present vs absent). Pinning this prevents a future
    // edit from silently hardcoding one shape for every section — exactly how DEF-353's own first
    // audit condemned about fifty correct rows.
    const text = readFileSync(REGISTER_PATH, 'utf8');
    const sections = parseSections(text);
    const bySection = new Map(sections.map((s) => [s.letter, s.expectedPipes]));
    expect(bySection.get('A')).toBe(7);
    expect(bySection.get('B')).toBe(7);
    expect(bySection.get('C')).toBe(7);
    expect(bySection.get('D')).toBe(7);
    expect(bySection.get('E')).toBe(6);
  });

  it('⛔ no DEF- row has a different pipe count than its section header', () => {
    const text = readFileSync(REGISTER_PATH, 'utf8');
    const failures = checkRows(text);
    const message = failures
      .map(
        (f) =>
          `${f.id} (§${f.section}, docs/DEFECTS-REGISTER.md:${f.line}) has ${f.count} unescaped ` +
          `pipes; its section's own header row has ${f.expected}. State and Disposition are ` +
          'rendering in the wrong columns.',
      )
      .join('\n');
    expect(failures, message).toEqual([]);
  });

  it('CONTROL: an escaped pipe counts as ZERO — same result with it present or removed entirely', () => {
    // The naive version of this guard (a plain split on '|') reported 83 malformed rows and was
    // wrong by fifty, because it counted every `\|` as a real separator. This fixture is the
    // direct pin: a row with an escaped pipe must count identically to the same row with that
    // escaped pipe deleted outright, proving it contributes nothing to the count either way.
    const withEscaped = '| **DEF-999** | ⚠️ | a \\| b | `state` | disposition |';
    const withoutIt = '| **DEF-999** | ⚠️ | a  b | `state` | disposition |';
    expect(unescapedPipeCount(withEscaped)).toBe(unescapedPipeCount(withoutIt));
  });

  it('CONTROL: an unescaped pipe inside backticked prose (a quoted shell pipeline) still counts', () => {
    // The opposite control: unlike a `\|`, a literal `|` inside a backtick span is NOT protected —
    // GFM tables do not treat backtick spans as a shield, which is exactly why several real rows
    // quoting `||` or a shell pipeline verbatim in code trip this guard. The guard's fix is to
    // repair or escape those rows, never to make the counter blind to pipes inside backticks.
    const quoting = '| **DEF-998** | ⚠️ | runs `ls docs/ops | grep -i budget` | `state` | disp |';
    // 6 structural pipes (5 columns) plus the one live inside the backtick span = 7.
    expect(unescapedPipeCount(quoting)).toBe(7);
  });

  it('CONTROL: the detector fires on a real, obviously-malformed synthetic row', () => {
    // Guards the opposite failure from the two controls above: a counter narrowed enough to
    // ignore escaped pipes must not have been narrowed into ignoring real ones too.
    const synthetic = [
      '## Z. Synthetic test section',
      '',
      '| # | Sev | Defect | State | Disposition |',
      '|---|---|---|---|---|',
      '| **DEF-000** | ⚠️ | a defect mentioning `a || b` inline | `state` | disposition |',
    ].join('\n');
    const failures = checkRows(synthetic);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.id).toBe('DEF-000');
  });

  it('CONTROL: the detector stays silent on a real, well-formed synthetic row', () => {
    const synthetic = [
      '## Z. Synthetic test section',
      '',
      '| # | Sev | Defect | State | Disposition |',
      '|---|---|---|---|---|',
      '| **DEF-000** | ⚠️ | a defect naming \\| an escaped pipe | `state` | disposition |',
    ].join('\n');
    expect(checkRows(synthetic)).toEqual([]);
  });

  it('⛔ CRLF regression (DEF-179): identical text once as LF, once as CRLF, finds the same failures', () => {
    const lf = [
      '## Z. Synthetic test section',
      '',
      '| # | Sev | Defect | State | Disposition |',
      '|---|---|---|---|---|',
      '| **DEF-000** | ⚠️ | a defect mentioning `a || b` inline | `state` | disposition |',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(checkRows(crlf)).toEqual(checkRows(lf));
    expect(checkRows(lf)).toHaveLength(1);
  });
});
