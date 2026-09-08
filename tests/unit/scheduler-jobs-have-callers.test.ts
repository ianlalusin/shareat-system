/**
 * T-236 — **a scheduler job that exists but that nothing on any host actually calls is
 * indistinguishable, from the outside, from a job that was never built (DEF-186's shape).**
 *
 * `docs/tasks/236-def-226-order-wastage-backstop-caller.md`. DEF-226:
 * `runOrderWastageBackstopSweep` (`scheduler/index.ts:585`) shipped with no `scripts/*.ts` entry
 * point, no `package.json` line and no systemd unit — the second time this shape has happened
 * (DEF-186 was the first, a different module).
 *
 * ## Why this is a NEW file and not an addition to `domain-actions-have-callers.test.ts`
 *
 * That guard's population is exports shaped `(tx, ..., actor: Actor, ...)` — a function that
 * **authorizes a human act**. Its own header says the population is deliberately narrow, and that
 * a state-moving function with no `actor` is out of scope, "either called by one that does take an
 * actor, or ... a scheduler entry point with its own registration guard." This file IS that other
 * guard. The two populations do not overlap: a scheduler job entry never takes an `actor` (an
 * `options` bag alone, or a driver argument plus one), and is reached by a script/timer, never by
 * a person clicking a screen. Widening the existing guard's population to cover both would blur
 * what each failure means.
 *
 * ⭐ `trackedFiles()` and `codeOnly()` below are copied from `domain-actions-have-callers.test.ts`
 * on purpose, not imported: that file exports neither, and the two guards' populations are
 * different enough that reaching into it to share two small helpers would be an edit outside this
 * task's scope. Keep them in sync by hand if the copying trap they guard against changes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const SCHEDULER_FILE = 'packages/domain/src/scheduler/index.ts';

/**
 * ⛔ `git ls-files`, never a directory walk — `apps/erp/.next` holds turbopack copies of the
 * domain barrel and would report every export as called forever. `--others --exclude-standard`
 * includes files not yet staged, so a script written five minutes ago is seen. (Same reasoning as
 * `domain-actions-have-callers.test.ts`.)
 */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

/**
 * ⛔ Comments stripped before matching, CRLF normalised first — this repo checks out CRLF and `.`
 * does not match `\r`, so a line-oriented scan can match nothing and pass silently (DEF-179).
 */
function codeOnly(src: string): string {
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

const read = (repoRelative: string) => codeOnly(readFileSync(path.join(repoRoot, repoRelative), 'utf8'));
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.includes('/tests/');

/** The parameter list, by balancing parentheses — a regex cannot survive a nested object type. */
function paramsFrom(src: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(openParenIndex + 1, i);
  }
  return '';
}

/**
 * name -> declaring file (always `SCHEDULER_FILE`, kept as a map for shape-parity with
 * `domain-actions-have-callers.test.ts`'s `actionShapedExports()`), for every `async` export in
 * `scheduler/index.ts` named `run*` whose first parameter is NOT `org`/`tx`/`trx` — the six
 * top-level job entries (`runMonthEnd`, `runAttendanceSweep`, `runFirestoreRelay`,
 * `runOrderWastageBackstopSweep`, `runFindingObservation`, `runBudgetReissue`).
 *
 * ⛔ **First cut of this guard filtered on the first param being literally named `options`, and it
 * was wrong** — `runFirestoreRelay(drivers, options)` takes TWO parameters, `drivers` first, so
 * that filter silently dropped it: delete `scripts/firestore-relay.ts` and the old version stayed
 * green. Filtering on shape instead (first param not `org`/`tx`/`trx`) is what distinguishes these
 * six from `runJobForOrg` (first param `org`, the per-org helper every job calls through) and from
 * `lastCompletedPeriod` (not `async`, first param `today`) without depending on a name a future job
 * entry is free to spell differently.
 *
 * ⚠️ Deliberately NOT a line number: `codeOnly()` strips block comments (including the multi-line
 * doc comment above most of these functions), which shifts the stripped source's line count below
 * the real file's. Reporting a computed line here would be confidently wrong.
 *
 * ⚠️ **This guard's population is DECLARATION-shaped, and that is a stated limit, not an oversight**
 * (Opus re-check, T-236 slice 2): the regex matches `export (async )?function run<Name>(`.
 * `export const runX = async (...) => {}` and a re-export of a job under a new name would both
 * escape it silently. Every job entry in this file is a `function` declaration today, so the gap is
 * real but currently empty — if a future job entry is ever written as a const/arrow or re-exported,
 * widen this regex first, the way T-227's own guard widens on the next thing it misses.
 */
function jobEntryExports(): Map<string, string> {
  const found = new Map<string, string>();
  const src = read(SCHEDULER_FILE);
  for (const m of src.matchAll(/^export (async )?function (run[A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/gm)) {
    if (!m[1]) continue; // not `async` — excludes `lastCompletedPeriod`
    const params = paramsFrom(src, m.index! + m[0].length - 1).trim();
    if (/^_?(org|tx|trx)\s*:/.test(params)) continue; // the per-org / per-tx helper shape
    found.set(m[2]!, SCHEDULER_FILE);
  }
  return found;
}

/**
 * ⭐ The set above is also PINNED here, not just floored — a regex can silently start matching
 * fewer names (BLOCKER 1's exact failure: the old filter's floor of 5 equalled its broken count of
 * 5, so the control could not see the hole) or, just as silently, start matching MORE than the real
 * job entries. Comparing against this fixed list catches both a regression and an unregistered new
 * job. Adding a seventh scheduler job entry point? Add its name here too, in the same commit.
 */
const KNOWN_JOB_NAMES = [
  'runAttendanceSweep',
  'runBudgetReissue',
  'runFindingObservation',
  'runFirestoreRelay',
  'runMonthEnd',
  'runOrderWastageBackstopSweep',
].sort();

function scriptsSource(): string {
  return trackedFiles()
    .filter((f) => f.startsWith('scripts/') && f.endsWith('.ts') && !isTest(f))
    .map(read)
    .join('\n');
}

/**
 * ⛔ An import alone must NOT pass — `\b${name}\b` (the first cut) matches a bare
 * `import { runX } from '@shareat/domain'` with no call anywhere, which is exactly the shape of a
 * job that is imported for its type and still never invoked. Requiring the open paren means the
 * name must be CALLED, not merely mentioned. Takes `source` as a parameter (rather than closing
 * over `scriptsSource()`) so the ✗ case below can exercise it against a synthetic string.
 */
function isCalled(name: string, source: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(source);
}

/**
 * ⛔ Every reason must say which kind it is and name the other half — same discipline as
 * `domain-actions-have-callers.test.ts`'s EXEMPT, a confession, not a config knob.
 *
 *   1. JOB     — a `scripts/*.ts` entry point calls it; **name the script**. (The normal case — an
 *      entry that reaches this map at all and has a script is never exempted, it just passes.)
 *   2. UNARMED — a script exists and calls it, but no systemd unit is installed yet; **cite the
 *      task or defect that owns arming it**. Still has a caller, so still not exempted — this kind
 *      exists for a future entry that ships its script ahead of its unit, which this guard does
 *      not police (installing/arming is ops, out of a domain guard's reach).
 *   3. UNWIRED — nothing calls it and that is a gap; **cite the task or defect that owns it**.
 */
const EXEMPT: Record<string, string> = {};

describe('T-236 — every scheduler job entry export is reachable from a scripts/ caller', () => {
  const jobs = jobEntryExports();
  const scriptSrc = scriptsSource();
  const called = (name: string) => isCalled(name, scriptSrc);

  it('⭐ finds the job entries and the scripts source at all (DEF-179 — a scan of nothing passes)', () => {
    // A floor, not ceremony: collapses to zero if the extraction regex breaks, a wrong root, or a
    // failed `git ls-files` — reference_sweep_needs_nonzero_control. Raised to 6 after BLOCKER 1:
    // the old floor of 5 equalled the old filter's broken count, so it could not see the hole.
    expect(jobs.size).toBeGreaterThanOrEqual(6);
    expect(scriptSrc.length).toBeGreaterThan(1000);
  });

  it('⭐ the extracted set is exactly the pinned six job entries — a new job updates KNOWN_JOB_NAMES', () => {
    const extracted = [...jobs.keys()].sort();
    const missingFromExtraction = KNOWN_JOB_NAMES.filter((n) => !extracted.includes(n));
    const notInPinnedList = extracted.filter((n) => !KNOWN_JOB_NAMES.includes(n));
    expect({ missingFromExtraction, notInPinnedList }).toEqual({
      missingFromExtraction: [],
      notInPinnedList: [],
    });
  });

  it('⚠️ the caller predicate requires an invocation, not just an import', () => {
    // The exact BLOCKER 2 shape: a job imported for its type (or by a barrel re-export) and never
    // actually called must NOT read as "has a caller".
    const importOnly = "import { runMonthEnd } from '@shareat/domain';\n";
    const importAndCall = `${importOnly}await runMonthEnd({ trigger: 'manual' });\n`;
    expect(isCalled('runMonthEnd', importOnly)).toBe(false);
    expect(isCalled('runMonthEnd', importAndCall)).toBe(true);
  });

  it('⛔ every scheduler job entry export has a scripts/ caller or a written exemption', () => {
    const orphans = [...jobs]
      .filter(([name]) => !called(name) && EXEMPT[name] === undefined)
      .map(
        ([name, file]) =>
          `${name} (${file}) is a scheduler job entry point, so nothing on any host calls it unless ` +
          'a scripts/*.ts file does. Give it a script, or add an EXEMPT entry naming which kind it ' +
          'is (job / unarmed / unwired) and the other half.',
      )
      .sort();
    expect(orphans).toEqual([]);
  });

  it('⛔ no exemption outlives its reason — an entry whose export IS called must be deleted', () => {
    const stale = Object.keys(EXEMPT)
      .map((name) => {
        if (!jobs.has(name)) {
          return `${name} — exempted but no longer a scheduler job entry export. Delete the row.`;
        }
        if (called(name)) {
          return `${name} — exempted as having no caller, and scripts/ now calls it. Delete the ` +
            'row; that is the whole point of the exemption being a confession rather than a setting.';
        }
        return null;
      })
      .filter((m): m is string => m !== null)
      .sort();
    expect(stale).toEqual([]);
  });

  it('⚠️ every exemption reason names its kind and says something', () => {
    const KINDS = /^(JOB|UNARMED|UNWIRED) —/;
    const weak = Object.entries(EXEMPT)
      .filter(([, reason]) => !KINDS.test(reason) || reason.trim().length < 40)
      .map(([name]) => `${name} — the reason must open with JOB/UNARMED/UNWIRED and say why`)
      .sort();
    expect(weak).toEqual([]);
  });
});
