/**
 * T-317 — document-of-record guards: a document disagreeing with the code, the register, or its
 * own header fails the build instead of waiting for somebody to notice.
 *
 * Guard 1 (STALE-IF-REACHABLE, DEF-193) lives in `deferral-staleness.test.ts` — it already owns
 * that marker family (T-220) and stays there by design. This file holds guards 2 through 6.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bannerBlock, doneIds, leadingClaim, normalise, unescapedPipeCount } from './lib/document-facts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BIBLE_PATH = `${REPO_ROOT}PROJECT_BIBLE.md`;
const TASKS_DIR = join(REPO_ROOT, 'docs', 'tasks');

/**
 * A quotation is not a claim (DEF-348's ruling, reused for guards 2 and 3). Backtick,
 * double/curly-quote and single-quote spans are all stripped — line-scoped (`[^…\n]`), so a stray
 * apostrophe elsewhere on the same line cannot swallow unrelated prose across a line break. Order
 * matters: backtick first, since a backtick span may itself contain a single-quoted phrase
 * (`docs/HANDOFF-TODAY.md`'s own `'1 day away'`, discussing this very guard).
 * ⚠️ Known accepted limitation, same shape as `leadingClaim`'s own documented one: an apostrophe
 * (a contraction, a possessive) on a line that also carries an unrelated single-quoted phrase
 * later in the line can mis-pair and swallow more than intended, hiding rather than corrupting —
 * the effect is under-detection, never a false report. Measured zero such collisions across the
 * lines this file's guards actually scan.
 */
function stripQuotedSpans(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/`[^`\n]*`/g, '')
        .replace(/["“][^"”\n]*["”]/g, '')
        .replace(/'[^'\n]*'/g, ''),
    )
    .join('\n');
}

// =====================================================================================
// Guard 2 / DEF-350 — no relative-interval date in a document of record unless it is derived.
//
// ⭐ Q1 re-derivation, 2026-09-14 (superseding the spec's own margin note, which said "exactly two,
// both in ROADMAP.html" without re-deriving it): the real count is FOUR raw matches across the
// seven files, not two — two in `docs/ROADMAP.html` (both inside the `<script>` block DEF-350
// added) and two more in `docs/HANDOFF-TODAY.md` (today's own pickup note, quoting the guarded
// phrase `'1 day away'` twice while describing this very guard — once in a backtick span, once in
// plain single quotes). Ruling (system32-85, 2026-09-14): keep all seven files — `HANDOFF-TODAY.md`
// is deliberately NOT exempted from scanning by dropping the file, because it is the one document
// most likely to mislead a reader with no memory (DEF-360 happened the same day, for the same
// reason). Instead extend quote-stripping to cover backtick and single-quote spans generally
// (DEF-348's "recording, not committing" principle, not a new one), and give the ROADMAP.html
// `<script>` block its own structural exemption on different grounds — its contents are CODE, not
// prose, so a computed formatting literal there is not a hand-typed claim at all, independent of
// which quote character it happens to use.
// =====================================================================================

const RELATIVE_DATE_FILES = [
  'docs/ROADMAP.html',
  'PROJECT_BIBLE.md',
  'docs/RULES.md',
  'docs/CAPABILITY-GAPS.md',
  'docs/HANDOFF-TODAY.md',
  'HANDOFF.md',
  'docs/ops/README.md',
] as const;

const RELATIVE_DATE_RE = /~?\d+\s+weeks?\s+away|\d+\s+days?\s+away|~?\d+\s+months?\s+away|in\s+\d+\s+weeks?/g;

/**
 * Strip a `<script>…</script>` block's contents — a script block is code, not prose, so a
 * relative-date-shaped string it computes and formats at read time (`ROADMAP.html`'s countdown
 * rail, DEF-350's own fix) is not a hand-typed claim. Line-oriented, mirrors the existing
 * fenced-code-block skip convention (`deferral-staleness.test.ts`).
 */
function stripScriptBlocks(text: string): string {
  let inScript = false;
  return text
    .split('\n')
    .map((line) => {
      if (/<script[\s>]/.test(line)) {
        inScript = true;
        return '';
      }
      if (/<\/script>/.test(line)) {
        inScript = false;
        return '';
      }
      return inScript ? '' : line;
    })
    .join('\n');
}

interface RelativeDateHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function findRelativeDateClaims(): RelativeDateHit[] {
  const hits: RelativeDateHit[] = [];
  for (const rel of RELATIVE_DATE_FILES) {
    const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const cleaned = stripQuotedSpans(stripScriptBlocks(normalise(raw)));
    cleaned.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(RELATIVE_DATE_RE)) {
        hits.push({ file: rel, line: i + 1, text: m[0]! });
      }
    });
  }
  return hits;
}

function totalScannedChars(): number {
  return RELATIVE_DATE_FILES.reduce((n, rel) => n + readFileSync(join(REPO_ROOT, rel), 'utf8').length, 0);
}

describe('T-317 / DEF-350 — no relative-interval date in a document of record unless derived', () => {
  it('⭐ non-vacuity: the scan read real, substantial text across all seven files', () => {
    expect(totalScannedChars()).toBeGreaterThan(50_000);
  });

  it('⛔ no un-exempt relative-interval claim in any of the seven files', () => {
    const hits = findRelativeDateClaims();
    const message = hits.map((h) => `${h.file}:${h.line} — "${h.text}"`).join('\n');
    expect(hits, message).toEqual([]);
  });

  it('⭐ MUST-FIRE control, real-data fixture: DEF-350s own repaired instance still catches', () => {
    // DEF-350 is already fixed (the rail is now derived), so per invariant 1's second branch this
    // is a real-data fixture reproducing the exact historical text, not a synthetic string —
    // ROADMAP.html's own rail literally read this before the fix.
    const fixture = '<div class="rail">30 September gate: ~5 weeks away</div>';
    const cleaned = stripQuotedSpans(stripScriptBlocks(fixture));
    expect([...cleaned.matchAll(RELATIVE_DATE_RE)].map((m) => m[0])).toEqual(['~5 weeks away']);
  });

  // ⛔⛔ THIS CONTROL MAY ONLY ANCHOR TO FILES THAT ARE NOT REWRITTEN ON A SCHEDULE, AND IT LEARNED
  // THAT BY BREAKING. It originally pinned four instances, two of them inside
  // `docs/HANDOFF-TODAY.md` — a file the wrap-up ritual REGENERATES WHOLESALE every session. The
  // very next wrap-up rewrote that document, both needles vanished, and this control failed while
  // the guard it protects was working perfectly.
  //
  // ⭐ That is bible §13 row 204's shape living inside a test: an assertion naming a specific token
  // and asserting a present-tense fact about it, in a document nothing promises to keep. The fix is
  // not a fresher needle — the next wrap-up would delete that one too. It is to anchor only to
  // `docs/ROADMAP.html`, whose exempt instances are structural (a computed countdown's own
  // formatting literals) and survive every edit that does not rewrite the countdown itself.
  //
  // ⚠️ The guard still SCANS all seven files, HANDOFF-TODAY.md included — only this control's
  // anchors narrowed. A hand-typed interval in the handoff still fails the build, which is the
  // point: that file is the one a cold session acts on first.
  it('⭐ MUST-NOT-FIRE control, real files: the durable exempt instances stay silent', () => {
    const cases = [
      { file: 'docs/ROADMAP.html', needle: '~5 weeks away', reason: 'double-quoted, inside the <script> comment — quote-stripped' },
      { file: 'docs/ROADMAP.html', needle: "'1 day away'", reason: 'single-quoted JS literal, inside <script> — script-block-stripped' },
    ];
    for (const { file, needle, reason } of cases) {
      const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
      expect(raw.includes(needle), `${file} no longer contains "${needle}" (${reason}) — this control is stale, update it`).toBe(true);
    }
    // The real assertion above already proves the full scan is clean; this control additionally
    // pins that it is clean BECAUSE of these four specific, named, still-present instances, not
    // because they silently disappeared.
  });

  it('CONTROL: the detector fires on an unquoted, non-script real-file-shaped positive', () => {
    const fixture = 'The 1 January gate is 18 weeks away, underlined.';
    expect([...stripQuotedSpans(fixture).matchAll(RELATIVE_DATE_RE)].map((m) => m[0])).toEqual(['18 weeks away']);
  });

  it('⛔ CRLF regression (DEF-179): identical text once as LF, once as CRLF, finds the same hits', () => {
    const lf = 'the deploy is 3 weeks away, unquoted.\nsecond line.';
    const crlf = lf.replace(/\n/g, '\r\n');
    const scan = (t: string) => [...stripQuotedSpans(normalise(t)).matchAll(RELATIVE_DATE_RE)].map((m) => m[0]);
    expect(scan(crlf)).toEqual(scan(lf));
    expect(scan(lf)).toEqual(['3 weeks away']);
  });
});

// =====================================================================================
// Guard 3 / DEF-354 — an arming or status claim in docs/ops/README.md's "## The jobs" section
// lives only inside a quote recording history, never as a live present-tense claim.
//
// ⚠️ Deliberately narrow and file-specific, and narrower again than the spec first drafted it:
// scoped to ONE SECTION of ONE FILE, not the whole file. Two real, legitimate sentences outside
// this section ("Three jobs have now shipped unarmed" at ~:515 — past-tense narrative; "Only
// `shareat-erp.service` is enabled directly" at ~:540 — a durable install-vs-timer architectural
// fact) contain the same trigger words without being stale claims, and neither is quoted or
// otherwise structurally distinguishable from DEF-354's actual defect shape by a mechanical rule —
// :540's sentence is even bolded, the same markdown shape DEF-354's real defect used. Ruling
// (system32-85, 2026-09-14): a section boundary is structural and survives rewording; a
// hand-written exemption list of sentences is bible row 204 in its purest form — it names specific
// tokens and goes stale the day either sentence is reworded. DEF-354's actual defect and its
// repair both live in "## The jobs"; scoping there catches the instance that happened and claims
// nothing about the rest of the file — the general "does this document contradict itself" problem
// is not mechanisable (this task's own spec, guard 3's mechanism note).
// =====================================================================================

const ARMING_CLAIM_RE = /NOT YET ARMED|is armed|currently armed|not armed|is enabled|unarmed/i;

function opsJobsSection(): string {
  const text = normalise(readFileSync(join(REPO_ROOT, 'docs/ops/README.md'), 'utf8'));
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^## The jobs/.test(l));
  if (start === -1) throw new Error('docs/ops/README.md "## The jobs" section heading not found');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function armingClaims(section: string): string[] {
  return [...stripQuotedSpans(section).matchAll(new RegExp(ARMING_CLAIM_RE, 'gi'))].map((m) => m[0]);
}

describe('T-317 / DEF-354 — "## The jobs" makes no present-tense arming claim outside a quote', () => {
  it('⭐ non-vacuity: the section was found and is real, substantial text', () => {
    expect(opsJobsSection().length).toBeGreaterThan(500);
  });

  it('⛔ no un-quoted present-tense arming claim in "## The jobs"', () => {
    const claims = armingClaims(opsJobsSection());
    expect(claims).toEqual([]);
  });

  it('⭐ MUST-FIRE control, real-data fixture: DEF-354s own repaired paragraph still catches', () => {
    // DEF-354 is already fixed (the paragraph now points at the dated sections instead of
    // asserting a status), so per invariant 1's second branch this is a real-data fixture
    // reproducing the ACTUAL original sentence, not an invented one.
    const fixture =
      '## The jobs\n\nrecurring-expense-draft, order-wastage-backstop, orphan-file-sweep and ' +
      'budget-reissue all have unit files in this directory and are **NOT YET ARMED**.';
    expect(armingClaims(fixture)).toEqual(['NOT YET ARMED']);
  });

  it('⭐ MUST-NOT-FIRE control, real text: the quoted historical claim stays silent', () => {
    const section = opsJobsSection();
    expect(section.includes('NOT YET ARMED'), 'the quoted historical claim is gone — this control is stale, update it').toBe(true);
    expect(armingClaims(section)).toEqual([]);
  });

  it('CONTROL: the two real false-positive shapes outside this section are OUT OF THIS SCAN entirely', () => {
    // "Three jobs have now shipped unarmed" (~:515) and "Only shareat-erp.service is enabled
    // directly" (~:540) both contain a trigger word and are both legitimate — one past-tense
    // narrative, one a durable architectural fact — and neither is inside quotes. Pinning that the
    // full file contains them while the scoped section does not is the proof the section boundary,
    // not a lucky quote, is what keeps this guard green.
    const fullFile = readFileSync(join(REPO_ROOT, 'docs/ops/README.md'), 'utf8');
    expect(fullFile).toMatch(/shipped unarmed/);
    expect(fullFile).toMatch(/is enabled directly/);
    expect(opsJobsSection()).not.toMatch(/shipped unarmed/);
    expect(opsJobsSection()).not.toMatch(/is enabled directly/);
  });

  it('⛔ CRLF regression (DEF-179): identical text once as LF, once as CRLF, finds the same claims', () => {
    const lf = '## The jobs\n\nfour units are **currently armed** and nothing says otherwise.';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(armingClaims(normalise(crlf))).toEqual(armingClaims(lf));
    expect(armingClaims(lf)).toEqual(['currently armed']);
  });
});

// =====================================================================================
// Guard 6 / DEF-359 — every PROJECT_BIBLE.md §13 decision row matches its own table's header
// shape. DEF-359's own lesson: the count must come from the table's HEADER row, never a
// neighbouring data row — a hardcoded count would have been wrong exactly the way the insert
// script that found this defect was wrong. Reuses T-313's unescaped-pipe counter (invariant 6).
//
// ⚠️ KNOWN LIMIT, stated rather than coded around: a pipe COUNT cannot distinguish a stray pipe
// from a missing cell when both land on the same total — row 206 was 5 structural pipes (one cell
// boundary never written — a MISSING final cell) + 2 bare, landing on 7, the exact same total a
// row with 6 structural (every boundary present) + 1 bare (a pure STRAY, no cell missing) would
// produce. Had DEF-359's repair escaped row 206's stray pipes without also supplying the
// `Reversible?` cell it was independently found to be missing, this guard would have gone GREEN
// on a still-broken row — the count matched, the row did not. A count is not a diagnosis; this
// guard proves every row's column COUNT matches the header, not that every cell is correctly
// populated. (Found by a second, independent lane's cell-by-cell read during DEF-359's repair,
// 2026-09-14 — not by this guard, which cannot see the difference.)
//
// RED CAPTURE, 2026-09-14, before DEF-359's repair (kept verbatim as the evidence this guard was
// ever red — DEF-359's list and this guard's independently-derived set agreed exactly):
//   row 146 (PROJECT_BIBLE.md:1452) has 11 unescaped pipes; the §13 header has 6.
//   row 160 (PROJECT_BIBLE.md:1466) has 7 unescaped pipes; the §13 header has 6.
//   row 167 (PROJECT_BIBLE.md:1475) has 7 unescaped pipes; the §13 header has 6.
//   row 206 (PROJECT_BIBLE.md:1511) has 7 unescaped pipes; the §13 header has 6.
//   row 205 (PROJECT_BIBLE.md:1513) has 5 unescaped pipes; the §13 header has 6.
//   row 204 (PROJECT_BIBLE.md:1514) has 5 unescaped pipes; the §13 header has 6.
// =====================================================================================

interface BibleRowCheck {
  readonly row: string;
  readonly line: number;
  readonly count: number;
  readonly expected: number;
}

interface BibleDecisionLogResult {
  readonly expected: number;
  readonly rows: number;
  readonly failures: BibleRowCheck[];
}

function checkBibleDecisionLog(text: string): BibleDecisionLogResult {
  const lines = normalise(text).split('\n');
  const sectionStart = lines.findIndex((l) => /^## 13\. /.test(l));
  if (sectionStart === -1) throw new Error('PROJECT_BIBLE.md §13 (Decision log) heading not found');
  let sectionEnd = -1;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }
  if (sectionEnd === -1) sectionEnd = lines.length;

  let headerIdx = -1;
  for (let i = sectionStart; i < sectionEnd; i++) {
    if (/^\|\s*#\s*\|/.test(lines[i]!)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error('§13 table header row not found');
  const expected = unescapedPipeCount(lines[headerIdx]!);

  const rowRe = /^\|\s*(\d+)\s*\|/;
  const failures: BibleRowCheck[] = [];
  let rows = 0;
  for (let i = sectionStart; i < sectionEnd; i++) {
    const m = rowRe.exec(lines[i]!);
    if (!m) continue;
    rows++;
    const count = unescapedPipeCount(lines[i]!);
    if (count !== expected) failures.push({ row: m[1]!, line: i + 1, count, expected });
  }
  return { expected, rows, failures };
}

describe('T-317 / DEF-359 — every PROJECT_BIBLE.md §13 row matches its own header shape', () => {
  it('⭐ non-vacuity: the scan found the real header and real rows (DEF-179s own lesson)', () => {
    const text = readFileSync(BIBLE_PATH, 'utf8');
    const { expected, rows } = checkBibleDecisionLog(text);
    expect(expected).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
  });

  it('⭐ the expected column count comes from the header row, never a hardcoded number', () => {
    // DEF-359's own lesson: the insert script took its expected count from a NEIGHBOURING data
    // row (206, itself malformed) and refused a correct row for having too few bars — the header
    // is the schema, an adjacent row is only a sample, and a sample can be the defect. Pinning the
    // literal value here (5 columns — #, Date, Decision, Rationale, Reversible? — 6 pipes) is a
    // regression pin on the header text itself, not a second source of the expected count: the
    // count above is still read from `lines[headerIdx]`, this only proves that read is correct.
    const text = readFileSync(BIBLE_PATH, 'utf8');
    const { expected } = checkBibleDecisionLog(text);
    expect(expected).toBe(6);
  });

  it('⛔ no §13 decision row has a different pipe count than the table header', () => {
    const text = readFileSync(BIBLE_PATH, 'utf8');
    const { failures } = checkBibleDecisionLog(text);
    const message = failures
      .map(
        (f) =>
          `row ${f.row} (PROJECT_BIBLE.md:${f.line}) has ${f.count} unescaped pipes; the §13 ` +
          `header has ${f.expected}. Rationale and Reversible? are rendering in the wrong columns.`,
      )
      .join('\n');
    expect(failures, message).toEqual([]);
  });

  it('CONTROL: the detector fires on a real, obviously-malformed synthetic row', () => {
    const synthetic = [
      '## 13. Decision log',
      '',
      '| # | Date | Decision | Rationale | Reversible? |',
      '|---|---|---|---|---|',
      '| 1 | 2026-01-01 | a decision mentioning `a || b` inline | rationale | Yes |',
      '',
      '## 14. Amendment protocol',
    ].join('\n');
    const { failures } = checkBibleDecisionLog(synthetic);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.row).toBe('1');
  });

  it('CONTROL: the detector stays silent on a real, well-formed synthetic row, escaped pipe included', () => {
    const synthetic = [
      '## 13. Decision log',
      '',
      '| # | Date | Decision | Rationale | Reversible? |',
      '|---|---|---|---|---|',
      '| 1 | 2026-01-01 | a decision naming \\| an escaped pipe | rationale | Yes |',
      '',
      '## 14. Amendment protocol',
    ].join('\n');
    expect(checkBibleDecisionLog(synthetic).failures).toEqual([]);
  });

  it('⛔ CRLF regression (DEF-179): identical text once as LF, once as CRLF, finds the same failures', () => {
    const lf = [
      '## 13. Decision log',
      '',
      '| # | Date | Decision | Rationale | Reversible? |',
      '|---|---|---|---|---|',
      '| 1 | 2026-01-01 | a decision mentioning `a || b` inline | rationale | Yes |',
      '',
      '## 14. Amendment protocol',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(checkBibleDecisionLog(crlf).failures).toEqual(checkBibleDecisionLog(lf).failures);
    expect(checkBibleDecisionLog(lf).failures).toHaveLength(1);
  });
});

// =====================================================================================
// Guard 4 / DEF-349 — every roadmap-`t-done` task has a `docs/tasks/<id>-*.md` file.
//
// ⛔ The reverse question from T-312's `taskFiles()` (which id does THIS file have) and no
// existing function answers it (does a file exist for THIS id) — importing `taskFiles()` from
// `task-status-banner.test.ts` would double-register that file's own `describe()` suite (see this
// file's own header and `lib/document-facts.ts`'s header). Invariant 6 forbids a second
// implementation of a question the repo already answers; this is a different question with no
// existing answer, so it is not that.
// =====================================================================================

function taskFileIds(): Set<string> {
  const ids = new Set<string>();
  for (const f of readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md'))) {
    const m = /^(\d+)-/.exec(f);
    if (m) ids.add(`T-${m[1]}`);
  }
  return ids;
}

// ⛔ DEF-349: T-148 shipped (`90da2d6`, 2026-08-28) with no `docs/tasks/148-*.md` ever written —
// a real RULES §1 rule 8 violation. Its disposition FORBIDS a retrospective spec file: one written
// to satisfy this guard would be a second copy of the roadmap's own claim, not evidence, and would
// make this exact absence permanently undetectable. Named, cited exemption,
// `UNLINKED_BY_DESIGN`-shaped (`tests/unit/nav-route-reachability.test.ts`'s own convention).
const NO_SPEC_FILE_BY_DESIGN: Record<string, string> = {
  'T-148':
    'DEF-349: shipped 90da2d6, 2026-08-28, with no docs/tasks/148-*.md ever written ' +
    '(git log --diff-filter=A never created one). Disposition forbids a retrospective spec file.',
};

describe('T-317 / DEF-349 — every roadmap-t-done task has a docs/tasks spec file', () => {
  it('⭐ non-vacuity: real done ids, real task files (DEF-179s own lesson)', () => {
    expect(doneIds().size).toBeGreaterThan(0);
    expect(taskFileIds().size).toBeGreaterThan(0);
  });

  it('⛔ every t-done id has a matching docs/tasks/<id>-*.md file, T-148 named exempt', () => {
    const files = taskFileIds();
    const missing = [...doneIds()]
      .filter((id) => !files.has(id))
      .filter((id) => NO_SPEC_FILE_BY_DESIGN[id] === undefined)
      .sort();
    expect(missing, missing.join(', ')).toEqual([]);
  });

  it('⚠️ the T-148 exemption deletes itself the moment docs/tasks/148-*.md appears', () => {
    // T-220's lesson, reused: an exemption that outlives its reason is the next stale fact.
    const files = taskFileIds();
    for (const id of Object.keys(NO_SPEC_FILE_BY_DESIGN)) {
      expect(files.has(id), `${id} now has a task file — delete its NO_SPEC_FILE_BY_DESIGN entry`).toBe(false);
    }
  });

  it('⚠️ every NO_SPEC_FILE_BY_DESIGN entry is still actually t-done and still actually missing', () => {
    const done = doneIds();
    const files = taskFileIds();
    const stale = Object.keys(NO_SPEC_FILE_BY_DESIGN).filter((id) => !done.has(id) || files.has(id));
    expect(stale).toEqual([]);
  });

  it('CONTROL: the detector fires on a synthetic done id with no matching file', () => {
    const doneSet = new Set(['T-9999']);
    const files = new Set(['T-1', 'T-2']);
    const missing = [...doneSet].filter((id) => !files.has(id)).filter((id) => NO_SPEC_FILE_BY_DESIGN[id] === undefined);
    expect(missing).toEqual(['T-9999']);
  });
});

// =====================================================================================
// Guard 5 / DEF-352 — every `docs/tasks/*.md` whose LEADING claim says shipped/built/complete has
// its id present in `docs/ROADMAP.html`. Reuses T-312's leading-claim extractor verbatim
// (`bannerBlock` + `leadingClaim`, invariant 6) for EXTRACTION; the phrase list itself is new —
// T-312's `PHRASE_RE` answers the opposite question (is this claim UNSTARTED), so matching a
// SHIPPED-shaped claim here is not a second implementation of that question.
// =====================================================================================

// Excludes a negated claim ("NOT BUILT", "NOT SHIPPED") — a mechanical fix, not a judgement call:
// four SPEC-only files (T-314/316/317/318) say "NOT BUILT" in their own banner and a bare \bBUILT\b
// would have matched the word inside the negation.
const SHIPPED_RE = /(?<!NOT )(?<!not )\b(SHIPPED|BUILT|COMPLETE)\b/;

// A claim describing a SLICE or an explicitly PARTIAL/PARTLY completion is not a claim that the
// TASK — the roadmap's unit — is shipped. DEF-352 itself names T-136 and T-141 "self-declared
// PARTIAL", its own separate category from the 29 fully-shipped instances it also found.
const PARTIAL_RE = /\bPARTIAL\b|\bPARTLY\b|\bSLICE\b/i;

// T-141 (file upload brokering) is the same shape as T-136 without using the word PARTIAL/SLICE —
// "BUILT (service layer)... UI upload control and the live Firebase piece missing" — cited by
// DEF-352 itself as self-declared partial. Named, cited exemption.
const SHIPPED_CLAIM_BUT_NOT_WHOLE_TASK: Record<string, string> = {
  'T-141':
    "DEF-352: 'BUILT (service layer), 2026-08-27. UI upload control and the live Firebase " +
    "adapter are the remaining half' — a qualified, partial claim, not a whole-task shipped one.",
};

interface ShippedClaim {
  readonly id: string;
  readonly file: string;
  readonly claim: string;
}

function taskShippedClaims(): ShippedClaim[] {
  const out: ShippedClaim[] = [];
  for (const file of readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md'))) {
    const m = /^(\d+)-/.exec(file);
    if (!m) continue;
    const claim = leadingClaim(bannerBlock(readFileSync(join(TASKS_DIR, file), 'utf8')));
    if (SHIPPED_RE.test(claim) && !PARTIAL_RE.test(claim)) {
      out.push({ id: `T-${m[1]}`, file, claim });
    }
  }
  return out;
}

describe('T-317 / DEF-352 — a shipped task file must have a roadmap row', () => {
  it('⭐ non-vacuity: real shipped-claim population, real done ids (DEF-179s own lesson)', () => {
    expect(taskShippedClaims().length).toBeGreaterThan(0);
    expect(doneIds().size).toBeGreaterThan(0);
  });

  it('⛔ every shipped-claim task id is present in the roadmap, T-141 named exempt', () => {
    const done = doneIds();
    const failures = taskShippedClaims()
      .filter(({ id }) => !done.has(id))
      .filter(({ id }) => SHIPPED_CLAIM_BUT_NOT_WHOLE_TASK[id] === undefined)
      .map(({ id, file, claim }) => `${id} (${file}) claims shipped ("${claim.slice(0, 100)}…") but has no docs/ROADMAP.html row`);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('⚠️ the T-141 exemption deletes itself the moment it gets a roadmap row', () => {
    const done = doneIds();
    for (const id of Object.keys(SHIPPED_CLAIM_BUT_NOT_WHOLE_TASK)) {
      expect(done.has(id), `${id} is now in the roadmap — delete its exemption entry`).toBe(false);
    }
  });

  it('⭐ MUST-NOT-FIRE control, real files: three genuinely partial/slice claims stay silent', () => {
    // Each is named with the one-line reason it is safe, checked against the real file, not a
    // fixture — same shape as T-312's own seven-file must-not-fire control.
    const cases: ReadonlyArray<{ id: string; file: string; reason: string }> = [
      { id: 'T-136', file: '136-cash-custody.md', reason: 'self-declared PARTIAL (DEF-352)' },
      { id: 'T-141', file: '141-file-upload-brokering.md', reason: 'named exempt: BUILT (service layer) only (DEF-352)' },
      { id: 'T-308', file: '308-deployed-revision-lag-guard.md', reason: 'slice A shipped, slice B explicitly unbuilt' },
    ];
    const done = doneIds();
    const regressed: string[] = [];
    for (const { id, file, reason } of cases) {
      const claim = leadingClaim(bannerBlock(readFileSync(join(TASKS_DIR, file), 'utf8')));
      const wouldFire =
        SHIPPED_RE.test(claim) && !PARTIAL_RE.test(claim) && SHIPPED_CLAIM_BUT_NOT_WHOLE_TASK[id] === undefined;
      if (wouldFire && !done.has(id)) {
        regressed.push(`${id} (${reason}) should stay silent but now fires — its leading claim changed`);
      }
    }
    expect(regressed, regressed.join('\n')).toEqual([]);
  });

  it('CONTROL: the detector fires on a synthetic shipped claim with no roadmap id', () => {
    const fixture = '# T-9998\n\n> **Status: SHIPPED `abc1234`, 2026-01-01.** Nothing else matters.\n';
    const claim = leadingClaim(bannerBlock(fixture));
    expect(SHIPPED_RE.test(claim) && !PARTIAL_RE.test(claim)).toBe(true);
    expect(doneIds().has('T-9998')).toBe(false);
  });

  it('CONTROL: a NOT BUILT / spec-only claim stays silent', () => {
    const fixture = '# T-9997\n\n> **Status: SPEC APPROVED. NOT BUILT.**\n';
    const claim = leadingClaim(bannerBlock(fixture));
    expect(SHIPPED_RE.test(claim)).toBe(false);
  });

  it('CONTROL: a synthetic slice-partial claim (T-308s real shape) stays silent', () => {
    const fixture = '# T-9996\n\n> **STATUS: SLICE A IS SHIPPED AND VERIFIED. SLICE B IS UNBUILT.**\n';
    const claim = leadingClaim(bannerBlock(fixture));
    expect(SHIPPED_RE.test(claim) && !PARTIAL_RE.test(claim)).toBe(false);
  });

  it('⛔ CRLF regression (DEF-179): identical text once as LF, once as CRLF, extracts the same claim', () => {
    const lf = '# T-1\n\n> **Status: SHIPPED `abc1234`.**\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(leadingClaim(bannerBlock(crlf))).toBe(leadingClaim(bannerBlock(lf)));
  });
});
