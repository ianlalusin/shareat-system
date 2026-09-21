#!/usr/bin/env node
/**
 * The production-caller census — which exported functions are called ONLY by tests?
 *
 * `docs/discovery/32-production-caller-census.md` is this script's write-up; DEF-249 is why it
 * exists. Run it at a phase boundary and diff the name list against the committed baseline: the
 * signal is a NEW name joining the set, not the size of the set.
 *
 *     node scripts/production-caller-census.mjs             # census (JSON), controls enforced
 *     node scripts/production-caller-census.mjs --names     # just the names, for the baseline
 *     node scripts/production-caller-census.mjs --probe a,b # diagnose one symbol; emits NO census
 *
 * ## THE CONTROL IS PART OF THIS SCRIPT AND CANNOT BE SKIPPED
 *
 * This scanner was wrong twice before it was right, and **both times it printed a complete,
 * plausible, wrong list rather than an error** — neither failure was visible in the output. So the
 * control is not something a caller does around this script; it runs first, and **no census is
 * emitted unless it passes**. A scanner that can emit a wrong list is a scanner someone will
 * believe.
 *
 * The two failures, recorded so nobody reintroduces them:
 *
 *   1. **Prose counted as a call site.** The first run credited the attendance-config seeding
 *      function with a production caller from a COMMENT in the db schema — and the very comment
 *      DEF-249 exists to call untrue. Note the direction: this flaw HIDES test-only functions by
 *      crediting them with imaginary callers, so an uncontrolled run reports a comfortingly small
 *      number.
 *   2. **The fix for (1) silently voided the whole scan.** Blanking string literals also blanked
 *      the quotes in `from '...'`, so the import-detector's exit condition never matched,
 *      `inImport` latched true at the first import, and every remaining line of every file was
 *      discarded as an import. Four functions with known production callers came back "test-only".
 *
 * ## Three things this script MUST keep doing, or it reports the wrong answer
 *
 *   - **Strip comments and string literals BEFORE matching**, or prose counts as a caller (1).
 *   - **Detect imports and re-exports from the RAW text**, never the stripped text (2).
 *   - **`scripts/` and the scheduler are PRODUCTION.** A scheduler-only caller is a production
 *     caller — the attendance sweep's per-store function is reached only from the scheduler, and
 *     flagging a correct function is how a guard loses its authority.
 *
 * Known limits, stated so the number is not over-read: this is textual analysis, not a
 * type-resolved call graph. Two exported functions sharing a name are merged, which can make a
 * test-only function look reachable — so the count is a FLOOR, not an exact figure. A bare
 * reference counts as a call site (a Next.js server action reaches a form as `action={fooAction}`,
 * never as `fooAction(`), so a parenthesis-only matcher would invent orphans.
 *
 * READ-ONLY: this script reads files and prints. It writes nothing.
 *
 * ⭐ **Does this file's own prose poison its own scan?** No, and for a structural reason rather
 * than a lucky one: the walker matches only `.ts`/`.tsx`/`.mts`/`.cts`, so a `.mjs` script is
 * invisible to its own census — and the control names below are string literals, which the
 * stripper blanks anyway. Verified in-repo on 2026-09-10: controls passed, 802 files / 1662
 * exports / 59 test-only, matching the scratchpad run that produced doc 32. ⚠️ If this file is
 * ever renamed to `.mts` or the extension filter widens, re-run it and check the controls still
 * pass — at that point its prose becomes scannable and it would credit DEF-249's own function
 * first, which is exactly the phantom-caller failure it warns about.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// =====================================================================================
// Control fixtures. Hard-coded on purpose: a control you can pass in is a control you can turn off.
// =====================================================================================

/**
 * MUST come back test-only.
 *
 * ⛔ WAS `seedAttendanceConfig` until 2026-09-21, and that choice was a latent bug in this guard:
 * the function was test-only ONLY BECAUSE DEF-249 was open — nothing in production seeded a
 * store's attendance config. T-332 fixed DEF-249, gave it two production callers, and this
 * control became permanently false BY DESIGN. The guard did the right thing (failed closed and
 * withheld its list rather than emit a wrong one), but it had to be repaired before it could pass
 * again. ⭐ THE LESSON: a control fixture calibrated against an OPEN DEFECT expires the day the
 * defect is fixed. Pick a control whose test-only status is guaranteed by its own CONTRACT.
 *
 * `__setPhase5AvailableForTests` (packages/domain/src/wastage/orders.ts:76) is that: its NAME
 * declares it test-only, so a production call site would itself be the bug, and it cannot be
 * quietly falsified by fixing something else.
 *
 * ⚠️ BUT IT IS A NAMING CONVENTION, NOT A MECHANISM. Nothing in this repo REFUSES a production
 * call to a `__`-prefixed function. This control is strictly stronger than one calibrated against
 * an open defect — it is not absolute, and an earlier draft of this comment read as though it
 * were. Verified non-vacuous on 2026-09-21: three real test call sites (order-wastage.test.ts:33,
 * 172, 396), zero production callers, present in the baseline. ⛔ A control naming a function with
 * NO call sites at all would pass while controlling nothing, so check that before swapping it.
 */
const CONTROL_POSITIVE = ['__setPhase5AvailableForTests'];

/**
 * MUST come back production-reachable. Each has a call site established in discovery doc 31.
 *
 * ⚠️ There are NINE of these and that is deliberate, not belt-and-braces. When failure mode (2)
 * was re-injected to prove the control fails closed, EIGHT of the nine fired — `derivePeriods`
 * did not, because its file's import layout happens to survive the latch. A single-negative
 * control would have passed that fault and emitted a wrong census.
 */
const CONTROL_NEGATIVE = [
  'adjudicateDay',      // sync/ingestor.ts, attendance/adjustments.ts
  'previewPayRun',      // apps/erp/src/app/payroll/lib.ts
  'recordPunch',        // sync/ingestor.ts — the ONLY production caller
  'sweepStore',         // scheduler/index.ts — scheduler-only, and that counts
  'supersedeConfig',    // apps/erp/src/app/settings/attendance/actions.ts
  'derivePeriods',      // apps/erp/src/app/payroll/lib.ts
  'getLiveConfig',      // config.ts itself, via supersedeConfig — same-file reachability
  'postEntry',          // ~46 call sites
  'authorize',          // ~263 call sites
];

/**
 * Floors on the scan itself, so a refactor that makes the matcher match NOTHING exits red
 * instead of reporting a clean tree. Measured 2026-09-10: 802 files, 1660 exported functions.
 * Set well below that — they should only ever be tripped by a broken scanner, never by real churn.
 * ⚠️ Raise them if the tree grows a lot; do NOT raise them to just-below-current.
 */
const FLOOR_FILES = 600;
const FLOOR_EXPORTS = 1200;

// =====================================================================================

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const ROOT = (args.find((a) => !a.startsWith('--')) || process.cwd()).replace(/\\/g, '/');
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', '.turbo', 'coverage', '.git']);

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIR.has(e)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(e) && !/\.d\.ts$/.test(e)) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(ROOT, []).map((p) => relative(ROOT, p).split(sep).join('/'));

/** `scripts/` and the scheduler are PRODUCTION. Only these paths are tests. */
const isTest = (f) =>
  /(^|\/)tests?\//.test(f) ||
  /\.(test|spec)\.(ts|tsx|mts|cts)$/.test(f) ||
  /(^|\/)__tests__\//.test(f) ||
  /(^|\/)test-utils?\//.test(f);
const isSpike = (f) => f.startsWith('spike/');

/**
 * Blank comments and string literals, preserving line and column positions so reported line
 * numbers stay true. `${...}` inside a template literal is KEPT — it is real code.
 * Failure mode 1 lives here. Do not remove.
 */
function stripNonCode(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue; }
    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n)); i = j + 2; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; if (src[j] === '\n') break; j++; }
      blank(i, Math.min(j + 1, n)); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1, start = i;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { blank(start, j + 1); j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          blank(start, j);
          let depth = 1, k = j + 2;
          while (k < n && depth > 0) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; }
          j = k; start = k; continue;
        }
        j++;
      }
      i = j; continue;
    }
    i++;
  }
  return out.join('');
}

const code = new Map();  // stripped — what symbols are matched against
const raw = new Map();   // original — what import/re-export detection reads
for (const f of files) {
  try {
    const text = readFileSync(join(ROOT, f), 'utf8');
    raw.set(f, text.split(/\r?\n/));
    code.set(f, stripNonCode(text).split(/\r?\n/));
  } catch { /* unreadable — skip */ }
}

// ---- exported function declarations, from non-test non-spike files ------------------
const DECL = [
  /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^export\s+(?:async\s+)?function\*\s*([A-Za-z_$][\w$]*)/,
  /^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\(|function|<)/,
];
const DEFAULT_FN = /^export\s+default\s+(?:async\s+)?function/;

const decls = new Map();
for (const f of files) {
  if (isTest(f) || isSpike(f)) continue;
  (code.get(f) || []).forEach((line, i) => {
    if (DEFAULT_FN.test(line)) return;              // framework entry point, not a named export
    for (const re of DECL) {
      const m = line.match(re);
      if (m && m[1]) {
        if (!decls.has(m[1])) decls.set(m[1], []);
        decls.get(m[1]).push({ file: f, line: i + 1 });
        return;
      }
    }
  });
}

/**
 * Per line: is it inside an import, or a re-export?
 * Reads RAW, never stripped. Failure mode 2 lives here: stripping blanks the quotes in
 * `from '...'`, so an import-state machine run over stripped text never exits and swallows the
 * rest of the file.
 */
const kindCache = new Map();
function lineKinds(f) {
  if (kindCache.has(f)) return kindCache.get(f);
  const lines = raw.get(f) || [];
  const kinds = new Array(lines.length).fill('code');
  let inImport = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inImport) {
      kinds[i] = 'import';
      if (/from\s*['"]/.test(t) || t.endsWith("';") || t.endsWith('";')) inImport = false;
      continue;
    }
    if (/^import\b/.test(t)) {
      kinds[i] = 'import';
      if (!/from\s*['"]/.test(t) && !/^import\s*['"]/.test(t)) inImport = true;
      continue;
    }
    if (/^export\s+\*/.test(t)) { kinds[i] = 'reexport'; continue; }
    if (/^export\s+(?:type\s+)?\{/.test(t)) {
      kinds[i] = 'reexport';
      if (!/\}/.test(t)) {
        let j = i + 1;
        while (j < lines.length && !/\}/.test(lines[j])) kinds[j++] = 'reexport';
        if (j < lines.length) kinds[j] = 'reexport';
        i = j;
      }
    }
  }
  kindCache.set(f, kinds);
  return kinds;
}

// ---- classify every reference -------------------------------------------------------
const reCache = new Map();
const wordRe = (n) => {
  if (!reCache.has(n)) reCache.set(n, new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`));
  return reCache.get(n);
};

const results = [];
for (const [name, sites] of decls) {
  const declFiles = new Set(sites.map((s) => s.file));
  const declLines = new Set(sites.map((s) => `${s.file}:${s.line}`));
  const r = { name, sites, prodOther: [], prodSelf: [], test: [], spike: [], reexport: 0, importOnly: 0 };
  const re = wordRe(name);

  for (const f of files) {
    const lines = code.get(f) || [];
    const kinds = lineKinds(f);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      if (declLines.has(`${f}:${i + 1}`)) continue;
      const kind = kinds[i];
      const site = `${f}:${i + 1}`;
      if (kind === 'reexport') { r.reexport++; continue; }
      if (isTest(f)) { r.test.push(site); continue; }
      if (isSpike(f)) { r.spike.push(site); continue; }
      if (kind === 'import') { r.importOnly++; continue; }
      if (declFiles.has(f)) r.prodSelf.push(site);
      else r.prodOther.push(site);
    }
  }
  results.push(r);
}

const reachable = (r) => r.prodOther.length > 0 || r.prodSelf.length > 0;
const byName = new Map(results.map((r) => [r.name, r]));

// =====================================================================================
// CONTROLS RUN FIRST. No census is printed unless every one of them passes.
// =====================================================================================
function runControls() {
  const failures = [];

  if (files.length < FLOOR_FILES) {
    failures.push(`SCAN FLOOR: found ${files.length} files, expected at least ${FLOOR_FILES}. ` +
      'The walker matched almost nothing — check ROOT and the extension filter.');
  }
  if (results.length < FLOOR_EXPORTS) {
    failures.push(`EXPORT FLOOR: found ${results.length} exported functions, expected at least ` +
      `${FLOOR_EXPORTS}. The declaration patterns matched almost nothing.`);
  }

  for (const name of CONTROL_POSITIVE) {
    const r = byName.get(name);
    if (!r) { failures.push(`POSITIVE CONTROL MISSING: "${name}" was not found as an exported function at all.`); continue; }
    if (reachable(r)) {
      failures.push(
        `POSITIVE CONTROL FAILED: "${name}" must be test-only and came back production-reachable ` +
        `via ${[...r.prodOther, ...r.prodSelf].slice(0, 3).join(', ')}. ` +
        'Most likely the comment/string stripper is not running — prose is being counted as a call site.');
    }
  }

  for (const name of CONTROL_NEGATIVE) {
    const r = byName.get(name);
    if (!r) { failures.push(`NEGATIVE CONTROL MISSING: "${name}" was not found as an exported function at all.`); continue; }
    if (!reachable(r)) {
      failures.push(
        `NEGATIVE CONTROL FAILED: "${name}" has a known production caller and came back test-only ` +
        `(test refs: ${r.test.length}, import-classified lines: ${r.importOnly}). ` +
        'Most likely import detection is reading stripped text instead of raw, and has swallowed the file.');
    }
  }
  return failures;
}

const failures = runControls();

if (flag('--probe')) {
  // Diagnostic path. Prints per-symbol detail and NEVER a census, controls passing or not.
  const wanted = (args[args.indexOf('--probe') + 1] || '').split(',').filter(Boolean);
  console.error(`[probe] diagnostic mode — no census is emitted. Controls: ${failures.length ? 'FAILING' : 'passing'}`);
  for (const w of wanted) {
    const r = byName.get(w);
    console.log(JSON.stringify(r ? {
      name: r.name,
      decl: r.sites.map((s) => `${s.file}:${s.line}`),
      prodOther: r.prodOther.slice(0, 8), prodOtherN: r.prodOther.length,
      prodSelfN: r.prodSelf.length, testN: r.test.length,
      importOnly: r.importOnly, reexport: r.reexport,
      verdict: reachable(r) ? 'production-reachable' : (r.test.length ? 'TEST-ONLY' : 'NO-REFS'),
    } : { name: w, MISSING: true }, null, 1));
  }
  process.exit(failures.length ? 1 : 0);
}

if (failures.length) {
  console.error('\nCENSUS CONTROL FAILED — no census emitted.\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error(
    'This scanner has twice produced a complete, plausible, WRONG list rather than an error.\n' +
    'That is why the list is withheld: a wrong census is worse than none, because someone will\n' +
    'believe it. Fix the scanner, re-run, and only then read the number.\n' +
    'Diagnose one symbol with:  --probe seedAttendanceConfig,recordPunch\n');
  process.exit(1);
}

// ---- controls passed; emit ----------------------------------------------------------
const testOnly = results.filter((r) => r.test.length > 0 && !reachable(r));
const noRefs = results.filter((r) => r.test.length === 0 && !reachable(r) && r.spike.length === 0);

if (flag('--names')) {
  // The ratchet baseline. Regenerate with this flag; never hand-edit — a hand-maintained list
  // beside a generated one is the half that rots (DEF-231, DEF-240).
  for (const r of [...testOnly, ...noRefs].map((r) => r.name).sort()) console.log(r);
  process.exit(0);
}

console.log(JSON.stringify({
  controls: 'passed',
  scanned: { files: files.length, testFiles: files.filter(isTest).length, exportedFunctions: results.length },
  counts: { testOnly: testOnly.length, noRefsAnywhere: noRefs.length },
  testOnly: testOnly
    .map((r) => ({
      name: r.name,
      decl: r.sites.map((s) => `${s.file}:${s.line}`),
      testRefs: r.test.length,
      testFiles: [...new Set(r.test.map((s) => s.split(':')[0]))].length,
    }))
    .sort((a, b) => b.testRefs - a.testRefs || a.name.localeCompare(b.name)),
  noRefsAnywhere: noRefs
    .map((r) => ({ name: r.name, decl: r.sites.map((s) => `${s.file}:${s.line}`) }))
    .sort((a, b) => a.decl[0].localeCompare(b.decl[0])),
}, null, 1));
