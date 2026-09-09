/**
 * DEF-239 / T-249 — every undersized `text-xs underline underline-offset-2` action link/button in
 * `apps/erp/src` has been replaced by the shared `ACTION_LINK` class, and the shared class stays a
 * real tap target.
 *
 * ⚠️ Walks the filesystem and reads TEXT rather than rendering anything: the actual rendered box
 * height and overlap behaviour are not unit-testable (§9 of `docs/tasks/249-…md` — no harness here
 * renders real Tailwind-generated CSS), so this guard checks the one thing that IS mechanical: the
 * bare undersized literal is gone, and the shared constant that replaced it hasn't drifted back
 * toward it.
 *
 * A file quietly dropped from the sweep, or a future author retyping the bare combo by hand, is
 * exactly how DEF-239 reached 4 instances (and, found in passing building this task, 5 more —
 * DEF-243) in the first place.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');
const actionLinkPath = resolve(srcRoot, 'components', 'action-link.ts');

const BARE_LITERAL = 'text-xs underline underline-offset-2';

const TARGET_FILES = [
  'app/admin/stores/[id]/page.tsx',
  'app/customers/[customerId]/page.tsx',
  'app/settings/expense-categories/page.tsx',
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

  it('each of the 4 target files uses ACTION_LINK', () => {
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
