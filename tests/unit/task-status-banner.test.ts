/**
 * T-312 / DEF-348 — a task the roadmap marks `t-done` must not have, as its LEADING status claim,
 * a statement that it is unstarted.
 *
 * DEF-122 fixed one instance of this by hand (2026-09-02) with no guard, and DEF-348 found it had
 * rotted back to wrong twelve days later while nobody was watching. This is the guard.
 *
 * ⚠️ **Not "must not contain the phrase anywhere"** — DEF-348's own sweep matched the whole banner
 * and over-counted by measuring seven files that already lead with a correct SHIPPED/BUILT status
 * and only phrase-match because they QUOTE their own former stale banner further down, either
 * inline in `"…"` or under an explicit `ORIGINAL STATUS:` label — a convention this corpus already
 * uses for exactly that purpose. `leadingClaim()` below strips both before matching.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROADMAP_PATH = join(REPO_ROOT, 'docs', 'ROADMAP.html');
const TASKS_DIR = join(REPO_ROOT, 'docs', 'tasks');

const PHRASE_RE =
  /AWAITING APPROVAL|SPEC NOT YET WRITTEN|NUMBER RESERVED|not yet implemented|awaiting APPROVED|Number reserved/i;

// ⛔ DEF-179: this repo checks out CRLF and `.` does not match `\r`, so every line-oriented regex
// below runs against CRLF-normalised text first — never the raw read.
function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** Every `T-\d+` id the roadmap marks `t-done`. A row may name more than one id (`T-303 · T-304`). */
function doneIds(): Set<string> {
  const html = normalise(readFileSync(ROADMAP_PATH, 'utf8'));
  const done = new Set<string>();
  const taskDivRe = /<div class="task( t-done)?"><div class="task-id">(?:<span class="dot"><\/span>)?([^<]+)<\/div>/g;
  for (const m of html.matchAll(taskDivRe)) {
    if (!m[1]) continue; // not t-done
    for (const id of m[2]!.match(/T-\d+/g) ?? []) done.add(id);
  }
  return done;
}

interface TaskFile {
  readonly id: string;
  readonly file: string;
}

function taskFiles(): TaskFile[] {
  const out: TaskFile[] = [];
  for (const file of readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md'))) {
    const m = /^(\d+)-/.exec(file);
    if (!m) continue;
    out.push({ id: `T-${m[1]}`, file });
  }
  return out;
}

/**
 * The leading run of `>`-blockquote lines directly under the `# T-NNN` title, with each line's
 * `> ` marker stripped BEFORE joining. Stripping after joining is wrong: a naive join of raw
 * lines re-inserts the marker between the two halves of a phrase split across a soft-wrapped
 * blockquote line (`…said "SPEC — awaiting` / `> APPROVED …`), producing `"…awaiting > APPROVED…"`,
 * which the phrase regex does not match — measured directly against `256-*.md` while building
 * this guard.
 */
function bannerBlock(text: string): string {
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
function leadingClaim(banner: string): string {
  const noQuotes = banner.replace(/["“][^"”]*["”]/g, '');
  const cut = noQuotes.search(/original status/i);
  return cut === -1 ? noQuotes : noQuotes.slice(0, cut);
}

function isUnstartedClaim(text: string): boolean {
  return PHRASE_RE.test(text);
}

describe('T-312 / DEF-348 — a shipped task must not lead with an unstarted claim', () => {
  it('⭐ non-vacuity: the scan found real ids and real files (DEF-179s own lesson)', () => {
    // A scanner silently finding zero of either would report a spotless guard for the worst
    // possible reason — exactly the shape DEF-179 hid in (a CRLF checkout made `.` never reach
    // end-of-string, so a guard "found" nothing and passed).
    expect(doneIds().size).toBeGreaterThan(0);
    expect(taskFiles().length).toBeGreaterThan(0);
  });

  it('⛔ no roadmap-t-done task file leads with an unstarted claim', () => {
    const done = doneIds();
    const failures: string[] = [];
    for (const { id, file } of taskFiles()) {
      if (!done.has(id)) continue;
      const claim = leadingClaim(bannerBlock(readFileSync(join(TASKS_DIR, file), 'utf8')));
      const match = claim.match(PHRASE_RE);
      if (match) {
        failures.push(
          `${id} (${file}) leads with an unstarted claim ("${match[0]}") while the roadmap marks ` +
            'it done. Fix one of two ways: (1) if the leading claim is genuinely stale, repair it ' +
            'to "Status: SHIPPED. See docs/ROADMAP.html (search ' +
            `${id}) for the commit, date and outcome."; (2) if this text is historical — a ` +
            'quotation of what the banner used to say — mark it the way this corpus marks history ' +
            'so it stops reading as the present claim: wrap it in quotes ("…") or place it after ' +
            'an ORIGINAL STATUS: label. This guard treats both as historical and ignores them.',
        );
      }
    }
    expect(failures, failures.join('\n\n')).toEqual([]);
  });

  it('⭐ MUST-NOT-FIRE control: seven shipped files that quote their own former banner stay silent', () => {
    // The control v1 of this guard's spec did not have, and should have: a detector narrowed
    // enough to pass these seven must not have been narrowed into passing everything. Each is
    // named with the one-line reason it is safe, checked against the real file, not a fixture —
    // if any of these seven ever regresses to a genuinely-unstarted leading claim, this control
    // starts failing exactly like the main assertion above would.
    const safe: ReadonlyArray<{ id: string; file: string; reason: string }> = [
      { id: 'T-130', file: '130-accounts-payable.md', reason: 'quotes its former line' },
      { id: 'T-256', file: '256-def-247-grant-provenance-on-screen.md', reason: 'quotes its former header' },
      { id: 'T-257', file: '257-def-259-sign-out.md', reason: 'carries an ORIGINAL STATUS: label' },
      { id: 'T-258', file: '258-def-244-tappable-rows.md', reason: 'carries an ORIGINAL STATUS: label' },
      { id: 'T-259', file: '259-def-235-deploy-preflight.md', reason: 'carries an ORIGINAL STATUS: label' },
      { id: 'T-260', file: '260-def-272-money-input-parsing.md', reason: 'carries an ORIGINAL STATUS: label' },
      { id: 'T-304', file: '304-two-layer-terminal-sign-in.md', reason: 'quotes its former line' },
    ];
    const done = doneIds();
    const regressed: string[] = [];
    for (const { id, file, reason } of safe) {
      expect(done.has(id), `${id} is expected to be t-done on the roadmap for this control to mean anything`).toBe(true);
      const claim = leadingClaim(bannerBlock(readFileSync(join(TASKS_DIR, file), 'utf8')));
      if (isUnstartedClaim(claim)) {
        regressed.push(`${id} (${file}) should stay silent (${reason}) but now flags — its leading claim changed`);
      }
    }
    expect(regressed, regressed.join('\n')).toEqual([]);
  });

  it('CONTROL: the detector still fires on a real, unquoted, unlabelled positive', () => {
    // Guards the opposite failure from the must-not-fire control above: a detector narrowed
    // enough to pass the seven false positives must not have been narrowed into passing
    // everything. A guard that cannot be observed failing is DEF-338/DEF-345's "a tool that
    // cannot distinguish two causes must not name one" risk wearing a different hat.
    const banner = bannerBlock('> **Status: RESERVED by the orchestrator, 2026-09-09.**\n> Number reserved so no peer takes it. Nothing below is built.');
    expect(isUnstartedClaim(leadingClaim(banner))).toBe(true);
  });

  it('CONTROL: the repaired convention itself reads clean', () => {
    // Pins the convention so a later edit to the phrase list can't silently make the "fixed"
    // wording fail again.
    const repaired =
      '**Status: SHIPPED.** See `docs/ROADMAP.html` (search `T-196`) for the commit, date and ' +
      'outcome — the roadmap is the maintained record.';
    expect(isUnstartedClaim(leadingClaim(bannerBlock(`> ${repaired}`)))).toBe(false);
  });

  it('multi-id roadmap rows: both ids in "T-303 · T-304" are recognised as t-done', () => {
    // Regression pin for the exact shape DEF-348 called out: one <div class="task t-done"> row
    // can name more than one task id.
    const html = `
      <div class="tasks">
        <div class="task t-done"><div class="task-id"><span class="dot"></span>T-303 &middot; T-304</div><div class="task-what">x</div></div>
      </div>`.trim();
    const done = new Set<string>();
    const taskDivRe = /<div class="task( t-done)?"><div class="task-id">(?:<span class="dot"><\/span>)?([^<]+)<\/div>/g;
    for (const m of html.matchAll(taskDivRe)) {
      if (!m[1]) continue;
      for (const id of m[2]!.match(/T-\d+/g) ?? []) done.add(id);
    }
    expect(done.has('T-303')).toBe(true);
    expect(done.has('T-304')).toBe(true);
  });

  it('⛔ CRLF regression (DEF-179): identical text once as LF, once as CRLF, extracts the same claim', () => {
    const lf = '# T-1\n\n> **Status: SPEC — awaiting APPROVED.**\n> More detail on the next line.\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(leadingClaim(bannerBlock(crlf))).toBe(leadingClaim(bannerBlock(lf)));
    expect(isUnstartedClaim(leadingClaim(bannerBlock(crlf)))).toBe(true);
  });

  it('blockquote-join regression: a quoted phrase split across two lines stays silent; the same phrase unquoted does not', () => {
    // One fixture pair pins the join fix and the quote-strip fix as INDEPENDENT: the join fix
    // alone would flag both banners below (it recovers "awaiting APPROVED" from the soft wrap in
    // either case); the quote-strip fix alone, without the join fix, would flag neither (it would
    // never even see the joined phrase to decide whether to strip it).
    const quoted = [
      '# T-9',
      '',
      '> **Status: SHIPPED `abc1234`, 2026-09-10 — lane E.** This header said "SPEC — awaiting',
      '> APPROVED … nothing below is built" until it was corrected.',
    ].join('\n');
    const unquoted = [
      '# T-9',
      '',
      '> **Status: SHIPPED `abc1234`, 2026-09-10 — lane E.** This header used to read SPEC — awaiting',
      '> APPROVED, nothing below is built, until it was corrected.',
    ].join('\n');

    expect(isUnstartedClaim(leadingClaim(bannerBlock(quoted)))).toBe(false);
    expect(isUnstartedClaim(leadingClaim(bannerBlock(unquoted)))).toBe(true);
  });
});
