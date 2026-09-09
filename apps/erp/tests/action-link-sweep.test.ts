/**
 * DEF-239 / T-249 — every undersized `text-xs underline underline-offset-2` action link/button in
 * `apps/erp/src` has been replaced by the shared `ACTION_LINK` class, and the shared class stays a
 * real tap target. DEF-243 / T-250 extends this to a SHAPE guard: DEF-239's own population was an
 * exact-literal grep and undercounted by more than half — 5 more instances spliced in
 * `text-neutral-500`, breaking the substring match but not the geometry. The lesson was "count the
 * shape, not the spelling"; a guard that stayed spelling-based would have shipped that exact hole.
 *
 * ⚠️ Walks the filesystem and reads TEXT rather than rendering anything: the actual rendered box
 * height and overlap behaviour are not unit-testable (§9 of `docs/tasks/249-…md` — no harness here
 * renders real Tailwind-generated CSS), so this guard checks the one thing that IS mechanical: the
 * bare undersized literal (and now the bare undersized SHAPE) is gone, and the shared constant that
 * replaced it hasn't drifted back toward it.
 *
 * A file quietly dropped from the sweep, or a future author retyping the bare combo by hand, is
 * exactly how DEF-239 reached 4 instances and DEF-243 reached 5 more in the first place.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');
const actionLinkPath = resolve(srcRoot, 'components', 'action-link.ts');

const BARE_LITERAL = 'text-xs underline underline-offset-2';

// The value of one `className=` attribute — `"..."`, `'...'`, or `{`...`}` — is the actual defect
// surface; a first attempt paired ANY two quoted/backtick strings in the file and false-positived
// on 11 unrelated files, because this codebase's prose comments are full of apostrophes ("isn't",
// "T-249's") that read as string delimiters to a naive scanner and silently glue unrelated code
// together into one bogus "segment". Anchoring on `className=` removes the ambiguity instead of
// trying to out-clever it. Testing each attribute's value once for BOTH tokens (rather than one
// regex requiring `text-xs` to precede `underline`) is what makes the shape order-independent:
// Tailwind class order is arbitrary, and an order-anchored regex would repeat DEF-243's own mistake
// one level up — still matching a spelling, just a looser one.
//
// ⚠️ Known blind spot, stated rather than silently accepted: a future className extracted into its
// OWN named constant (this app's existing `SUBMIT_BTN`/`BTN_SM`/`BTN`/`FIELD` convention) rather
// than composed inline would not be seen here — this guard reads `className=` call sites, not
// constant definitions. None of DEF-239's 4 or DEF-243's 5 used that shape; T-249 §7 scoped a
// shared component/class as out of this task's size, and chasing every possible indirection is the
// same overreach one level further.
const CLASSNAME_ATTR_RE = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*`([^`]*)`\s*\})/g;
const HAS_TEXT_XS = /\btext-xs\b/;
// `(?<!no-)` and `(?!-)` exclude `hover:no-underline` and `underline-offset-*` — both contain the
// substring "underline" but neither is the bare class that shrinks a tap target.
const HAS_BARE_UNDERLINE = /(?<!no-)\bunderline\b(?!-)/;

function hasUndersizedActionLinkShape(content: string): boolean {
  for (const m of content.matchAll(CLASSNAME_ATTR_RE)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (HAS_TEXT_XS.test(value) && HAS_BARE_UNDERLINE.test(value)) return true;
  }
  return false;
}

// Files permitted to pair `text-xs` with a bare `underline` outside `ACTION_LINK` — each entry
// must carry its own reason inline, so an exemption is visible in the diff and never silent.
// Empty on purpose (DEF-243/T-250): nothing in the app legitimately needs one today. Do not
// pre-populate this "just in case" — an empty list is the honest statement of the current tree.
const SHAPE_ALLOWLIST: string[] = [];

const TARGET_FILES = [
  'app/admin/stores/[id]/page.tsx',
  'app/customers/[customerId]/page.tsx',
  'app/settings/expense-categories/page.tsx',
  'app/cutover/count/page.tsx',
  'app/cutover/opening/page.tsx',
  'app/settings/sales-channels/page.tsx',
  'app/staff/[employmentId]/credentials/page.tsx',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

describe('ACTION_LINK sweep — DEF-239 / T-249', () => {
  const files = walk(srcRoot);

  it('non-zero control: the walk actually scans a real number of files', () => {
    // Printed first so a broken walk (wrong root, wrong extension) cannot report "0 hits" and
    // look identical to a correctly-fixed tree (reference_sweep_needs_nonzero_control).
    expect(files.length).toBeGreaterThan(100);
  });

  it('the bare undersized literal is gone from apps/erp/src', () => {
    // action-link.ts itself names the bare literal in prose, explaining what NOT to type — that
    // mention is the guard's own documentation, not a usage, so it is the one deliberate exclusion.
    const hits = files
      .filter((f) => f !== actionLinkPath)
      .filter((f) => readFileSync(f, 'utf8').includes(BARE_LITERAL));
    expect(hits.map((f) => f.slice(srcRoot.length))).toEqual([]);
  });

  it('each target file uses ACTION_LINK', () => {
    for (const rel of TARGET_FILES) {
      const content = readFileSync(resolve(srcRoot, rel), 'utf8');
      expect(content).toContain('ACTION_LINK');
    }
  });

  it('no file outside the shape allowlist pairs text-xs with a bare underline (DEF-243 shape guard, order-independent)', () => {
    const hits = files
      .filter((f) => f !== actionLinkPath)
      .filter((f) => hasUndersizedActionLinkShape(readFileSync(f, 'utf8')))
      .map((f) => f.slice(srcRoot.length).replace(/\\/g, '/').replace(/^\//, ''))
      .filter((rel) => !SHAPE_ALLOWLIST.includes(rel));
    expect(hits).toEqual([]);
  });

  it('ACTION_LINK stays a real, self-cancelling tap target — a drift guard on the shared constant', () => {
    const content = readFileSync(actionLinkPath, 'utf8');
    expect(content).toContain('py-2');
    expect(content).toMatch(/-my-2\b/);
  });
});
