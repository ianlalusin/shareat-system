/**
 * T-317 — shared resolution for two questions the repo already answers, extracted so a third
 * guard can reuse them rather than writing a second implementation (invariant 6).
 *
 * ⛔ **Not a `.test.ts` file, and that is load-bearing, not a naming preference.**
 * `tests/unit/domain-actions-have-callers.test.ts` and `tests/unit/task-status-banner.test.ts`
 * are themselves collected by the unit project's `tests/unit/**\/*.test.ts` include glob, and their
 * `describe()` calls run at module evaluation. Importing either into a new `.test.ts` file would
 * evaluate it a second time and register its suites again inside the importing file — the
 * assertions would run twice, and a real failure would appear in two places, one of them about
 * something else entirely. Moving the pure logic here, with no `describe`/`it` of its own, is what
 * makes the reuse safe. (Confirmed this path is not itself expected to hold tests: DEF-081/DEF-221's
 * class is a directory silently uncovered by every project's include glob; a `lib/` file with no
 * `.test.` in its name is simply never collected, which is the opposite failure and not a risk here.)
 *
 * The two functions below are moved verbatim from their source files — same logic, same comments
 * where the reasoning is specific to the mechanism, only relocated. Each source file now imports
 * back from here instead of defining its own copy; T-317's READY message records that neither
 * file's test count or pass/fail changed, and that each file's own destructive control still
 * fires through the moved code.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

// =====================================================================================
// From `domain-actions-have-callers.test.ts` (T-227) — "is this symbol reachable from apps/".
// =====================================================================================

/**
 * ⛔ `git ls-files`, never a directory walk. `apps/erp/.next` holds turbopack copies of the domain
 * barrel and matches **every** symbol in it, so a walk would report every export as called and pass
 * for ever. `.next` is gitignored, so enumerating from git cannot see it — structural, not a rule
 * anyone has to remember. (`docs/CAPABILITY-GAPS.md`, the sweep's first trap.)
 *
 * ⭐ `--others --exclude-standard` includes files not yet staged — a service written five
 * minutes ago is exactly the one at risk of shipping uncalled — while still honouring
 * `.gitignore`, so `.next` remains invisible.
 */
export function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * ⛔ Comments stripped before matching. Names are mentioned constantly in this codebase's prose —
 * `reconcileSupplier` appears in three of its own error strings and a doc block — and a raw text
 * match would call a dead export live. ⚠️ CRLF is normalised first: this repo checks out CRLF and
 * `.` does not match `\r`, so a line-oriented scan can match nothing and pass (DEF-179).
 */
export function codeOnly(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

const isTestFile = (f: string) => /\.test\.tsx?$/.test(f) || f.includes('/tests/');
const readSource = (repoRelative: string) => codeOnly(readFileSync(path.join(repoRoot, repoRelative), 'utf8'));

/** Every non-test `apps/**` source file, concatenated. What "reachable from a screen" is read against. */
export function appProductionSource(): string {
  return trackedFiles()
    .filter((f) => f.startsWith('apps/') && /\.(ts|tsx)$/.test(f) && !isTestFile(f))
    .map(readSource)
    .join('\n');
}

/** Whole-word match — the same boundary test `domain-actions-have-callers.test.ts` uses inline. */
export function isCalledInSource(appSource: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(appSource);
}

// =====================================================================================
// From `task-status-banner.test.ts` (T-312) — the leading-claim extractor.
// =====================================================================================

const ROADMAP_PATH = path.join(repoRoot, 'docs', 'ROADMAP.html');

// ⛔ DEF-179: this repo checks out CRLF and `.` does not match `\r`, so every line-oriented regex
// below runs against CRLF-normalised text first — never the raw read.
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Every `T-\d+` id the roadmap marks `t-done`. A row may name more than one id (`T-303 · T-304`). */
export function doneIds(): Set<string> {
  const html = normalise(readFileSync(ROADMAP_PATH, 'utf8'));
  const done = new Set<string>();
  const taskDivRe = /<div class="task( t-done)?"><div class="task-id">(?:<span class="dot"><\/span>)?([^<]+)<\/div>/g;
  for (const m of html.matchAll(taskDivRe)) {
    if (!m[1]) continue; // not t-done
    for (const id of m[2]!.match(/T-\d+/g) ?? []) done.add(id);
  }
  return done;
}

/**
 * The leading run of `>`-blockquote lines directly under the `# T-NNN` title, with each line's
 * `> ` marker stripped BEFORE joining. Stripping after joining is wrong: a naive join of raw
 * lines re-inserts the marker between the two halves of a phrase split across a soft-wrapped
 * blockquote line (`…said "SPEC — awaiting` / `> APPROVED …`), producing `"…awaiting > APPROVED…"`,
 * which the phrase regex does not match — measured directly against `256-*.md` while building
 * this guard.
 */
export function bannerBlock(text: string): string {
  const lines = normalise(text).split('\n');
  let i = 0;
  while (i < lines.length && !/^>/.test(lines[i]!)) i++;
  const start = i;
  while (i < lines.length && (/^>/.test(lines[i]!) || lines[i]!.trim() === '')) {
    if (lines[i]!.trim() === '') {
      const next = lines[i + 1];
      if (next === undefined || !/^>/.test(next)) break;
    }
    i++;
  }
  return lines
    .slice(start, i)
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ');
}

/**
 * The file's own present-tense claim, as distinct from a quotation of its former one. This corpus
 * uses two conventions to keep a corrected banner's history without it being read as current: an
 * inline quotation in `"…"`/`"…"`, and an explicit `ORIGINAL STATUS:` (or "kept for the record")
 * label. Both are stripped before the phrase list is matched.
 *
 * ⚠️ **Known accepted limitation** (recorded, not coded around — see T-312's spec, "Known
 * limitation"): a genuinely stale leading claim written INSIDE quotes for emphasis, with no
 * `ORIGINAL STATUS` label, would be stripped and missed. Measured zero such instances across the
 * full 157-id done-set this guard runs against. The alternative — trying to find "the first
 * sentence" by punctuation alone — was tried and is wrong in both directions: it over-extends on
 * `130-accounts-payable.md` (a quoted phrase's own internal period isn't followed by whitespace,
 * so the split runs past it into the real trigger text) and under-extends on files like
 * `235-def-222-pre-session-error-messages.md`, whose genuine leading claim is a short paragraph of
 * several sentences inside one bold span, not one sentence.
 */
export function leadingClaim(banner: string): string {
  const noQuotes = banner.replace(/["“][^"”]*["”]/g, '');
  const cut = noQuotes.search(/original status/i);
  return cut === -1 ? noQuotes : noQuotes.slice(0, cut);
}

// =====================================================================================
// From `register-row-shape.test.ts` (T-313) — count pipes that actually separate table cells.
// =====================================================================================

/** A pipe not immediately preceded by a backslash. A `\|` renders inside a cell and splits
 *  nothing — the naive `split('|')` version of this check reported 83 malformed register rows
 *  and was wrong by about fifty (DEF-353). */
export function unescapedPipeCount(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && line[i - 1] !== '\\') count++;
  }
  return count;
}

export { repoRoot, normalise };
