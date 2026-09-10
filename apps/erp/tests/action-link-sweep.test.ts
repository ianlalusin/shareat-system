/**
 * T-262 / DEF-269 — replaces the old text-matcher (`text-xs` + bare `underline`) with an
 * authored-box-geometry guard. See `touch-target-geometry.ts` for the model and the two
 * definitions (interactive control, opaque-component allowlist) it states explicitly.
 *
 * `text-xs` stops being the subject; `underline` stops being mentioned at all — both were spelling,
 * never the actual WCAG 2.5.8 rule (a box height). DEF-239/DEF-243/DEF-269 are all subsumed: each
 * was "a box under 24px", found three different ways by three different bare-text matchers.
 *
 * Every interactive control lands in exactly one bucket — PASS (≥24px), FAIL (<24px), or
 * UNRESOLVED (box not resolvable from source) — and UNRESOLVED FAILS. That partition, not the
 * census itself, is the actual fix: the old guard could not tell "checked and it's fine" from
 * "couldn't see it", and reported both as green.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLOOR_PX, runCensus, stylesheetsUnderApp } from './touch-target-geometry';
import baseline from './touch-target-baseline.json';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');
const appRoot = resolve(here, '..', 'src', 'app');
const globalsCssPath = resolve(appRoot, 'globals.css');
const actionLinkPath = resolve(srcRoot, 'components', 'action-link.ts');

const TARGET_FILES = [
  'app/admin/stores/[id]/page.tsx',
  'app/customers/[customerId]/page.tsx',
  'app/settings/expense-categories/page.tsx',
  'app/cutover/count/page.tsx',
  'app/cutover/opening/page.tsx',
  'app/settings/sales-channels/page.tsx',
  'app/staff/[employmentId]/credentials/page.tsx',
];

const { files, results } = runCensus(srcRoot, globalsCssPath);
const failResults = results.filter((r) => r.status === 'fail');
const unresolvedResults = results.filter((r) => r.status === 'unresolved');

describe('ACTION_LINK sweep — DEF-239 / T-249 (unchanged invariants)', () => {
  it('non-zero control: the walk actually scans a real number of files', () => {
    // Printed first so a broken walk (wrong root, wrong extension) cannot report "0 hits" and
    // look identical to a correctly-fixed tree.
    expect(files.length).toBeGreaterThan(100);
  });

  it('each target file uses ACTION_LINK', () => {
    // §6.7: TARGET_FILES stays exactly as it is — DEF-270 records that dropping a page from it
    // would have a UI task quietly weakening a guard, judged strictly worse than the bundling it
    // avoided.
    for (const rel of TARGET_FILES) {
      const content = readFileSync(resolve(srcRoot, rel), 'utf8');
      expect(content).toContain('ACTION_LINK');
    }
  });

  it('ACTION_LINK stays a real, self-cancelling tap target — a drift guard on the shared constant', () => {
    const content = readFileSync(actionLinkPath, 'utf8');
    expect(content).toContain('py-2');
    expect(content).toMatch(/-my-2\b/);
  });
});

describe('T-262 — the guard\'s own inputs (fail-closed applies to them too, §6.7)', () => {
  it('globals.css is the only stylesheet under apps/erp — step 2b depends on it', () => {
    // If a second stylesheet ever appears, this must go red LOUDLY rather than let the resolver
    // keep computing geometry against a partial picture of the app's CSS.
    const sheets = stylesheetsUnderApp(appRoot).map((p) => p.replace(/\\/g, '/'));
    expect(sheets).toEqual([globalsCssPath.replace(/\\/g, '/')]);
  });
});

describe('T-262 — geometry model self-check (§6.2 step 4, measured in a real browser at 390×844)', () => {
  it('app/customers/page.tsx:131 <button className="px-2 py-0.5 text-xs …"> models to 22px, under the 24px floor (measured 56×22 exact)', () => {
    const hit = results.find((r) => r.file === 'app/customers/page.tsx' && r.line === 131 && r.tag === 'button');
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ status: 'fail', px: 22 });
  });

  it('app/customers/page.tsx:93 <Link> inheriting text-sm models to 20px, under the 24px floor (measured 196×19 — 1px is inline content-height, not model error)', () => {
    const hit = results.find((r) => r.file === 'app/customers/page.tsx' && r.line === 93 && r.tag === 'Link');
    expect(hit).toBeDefined();
    expect(hit).toMatchObject({ status: 'fail', px: 20 });
  });
});

describe('T-262 — the two non-zero controls required by §6.7(b)', () => {
  it('the file walk still sees more than 100 files (non-zero control (a))', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('the resolver positively identifies all 8 known ACTION_LINK sites at 32px PASS (non-zero control (b))', () => {
    // A resolver that resolves nothing reports "0 undersized" and is indistinguishable from a
    // clean tree — this is the check that tells the two apart. 5 of these 8 sites use ACTION_LINK
    // inside a template substitution (`` `${ACTION_LINK} ...` ``), which is why className
    // resolution must resolve template substitutions, not just concatenate literal spans.
    const actionLinkSites = results.filter((r) => r.status !== 'unresolved' && r.px === 32);
    expect(actionLinkSites.length).toBeGreaterThanOrEqual(8);
    for (const site of actionLinkSites) {
      expect(site.status).toBe('pass');
    }
  });
});

/**
 * T-262 accepted baseline (orchestrator override of §6.9, recorded in the spec doc): the census
 * ships GREEN against `touch-target-baseline.json` rather than permanently red. §6.4's own ruling —
 * 151 candidates is not 151 defects, ~127 are WCAG-exempt inline links — means a permanent red
 * would teach every other lane sharing this tree to say "that red is expected", which is exactly
 * how a real regression gets waved through (RULES §9's definition of done applies to every lane,
 * not just this one). Shrinking the baseline is T-262 spec §6.4's separately-scoped follow-up.
 *
 * Keyed as a per-file MULTISET of modelled heights / unresolved reasons, not `file:line` — see the
 * `_note` in `touch-target-baseline.json` for why, and the trade-off accepted in exchange (a fix and
 * a new defect at the identical height/reason in the same file could theoretically cancel out;
 * judged an acceptable residual risk, far narrower than a whole-tree total, which is explicitly
 * banned — that would let ANY fix mask ANY new defect anywhere in the tree).
 *
 * Three ways this test goes red, all deliberate:
 *   - a control newly appears that isn't in the baseline for its file/height (or file/reason) —
 *     a regression, or an intentionally-accepted addition that needs the baseline file updated;
 *   - a baseline entry is no longer reproduced — the control this size/reason described is gone,
 *     which usually means it is now COMPLIANT and should be removed from the baseline (do not
 *     "fix" this by deleting the baseline entry without checking why first — the control could
 *     also have been deleted, renamed, or moved to a file that no longer matches);
 *   - the accepted-baseline totals stop matching 151 FAIL / 53 UNRESOLVED — a cheap early signal
 *     before the itemised diff below even runs.
 */
function multisetDiff(baselineItems: readonly (string | number)[], actualItems: readonly (string | number)[]) {
  const remaining = [...baselineItems];
  const extra: (string | number)[] = [];
  for (const item of actualItems) {
    const idx = remaining.indexOf(item);
    if (idx === -1) extra.push(item);
    else remaining.splice(idx, 1);
  }
  return { missing: remaining, extra }; // `remaining` = baseline entries never matched
}

describe('T-262 / DEF-269 — every interactive control matches the accepted baseline', () => {
  it('accepted-baseline totals: 151 FAIL / 53 UNRESOLVED', () => {
    expect({ fail: failResults.length, unresolved: unresolvedResults.length }).toEqual({ fail: 151, unresolved: 53 });
  });

  it('no control is undersized or unresolved outside the accepted baseline', () => {
    const baselineFail: Record<string, number[]> = baseline.fail;
    const baselineUnresolved: Record<string, string[]> = baseline.unresolved;
    const failByFile: Record<string, number[]> = {};
    const unresolvedByFile: Record<string, string[]> = {};
    for (const r of failResults) (failByFile[r.file] ??= []).push(r.px);
    for (const r of unresolvedResults) (unresolvedByFile[r.file] ??= []).push(r.reason);

    const report: string[] = [];
    const allFailFiles = new Set([...Object.keys(baselineFail), ...Object.keys(failByFile)]);
    for (const file of allFailFiles) {
      const { missing, extra } = multisetDiff(baselineFail[file] ?? [], failByFile[file] ?? []);
      for (const px of extra) report.push(`NEW FAIL not in baseline: ${file} ${px}px (floor ${FLOOR_PX}px)`);
      for (const px of missing) report.push(`baseline FAIL no longer reproduced (now compliant?): ${file} ${px}px`);
    }
    const allUnresolvedFiles = new Set([...Object.keys(baselineUnresolved), ...Object.keys(unresolvedByFile)]);
    for (const file of allUnresolvedFiles) {
      const { missing, extra } = multisetDiff(baselineUnresolved[file] ?? [], unresolvedByFile[file] ?? []);
      for (const reason of extra) report.push(`NEW UNRESOLVED not in baseline: ${file} — ${reason}`);
      for (const reason of missing) report.push(`baseline UNRESOLVED no longer reproduced (now resolvable?): ${file} — ${reason}`);
    }
    expect(report.sort()).toEqual([]);
  });
});
