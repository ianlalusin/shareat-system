/**
 * T-537 — "Skip to content" on every ERP page (WCAG 2.4.1; impeccable audit 2026-11-03, finding 8).
 *
 * Before this, a keyboard or screen-reader user pressed Tab about 40 times to walk the sidebar
 * before reaching the page itself. Two halves have to hold, and neither is visible to a rendered
 * assertion at build time:
 *
 *   1. the link is the FIRST focusable thing in the shell and points at the page's `<main>`;
 *   2. it is parked off-screen until focused — a "Skip to content" bar sitting visibly on every
 *      screen at all times would be its own defect.
 *
 * Source-level, in the same style as the other shell guards: `postcss` reads the real rules rather
 * than a substring of the file, so a comment or another selector mentioning the class cannot
 * satisfy it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const shellPath = resolve(here, '..', 'src', 'components', 'shell', 'AppShell.tsx');
const globalsCssPath = resolve(here, '..', 'src', 'app', 'globals.css');

/** Every declaration of the ONE top-level rule with this exact selector, later values winning. */
function ruleDeclarations(css: string, selector: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.replace(/\s+/g, ' ').trim() !== selector) return;
    rule.walkDecls((declaration) => {
      declarations[declaration.prop] = declaration.value;
    });
  });
  return declarations;
}

describe('T-537 — the skip link', () => {
  it('the skip link is the first element and targets main', () => {
    // Comment blocks are stripped before scanning: this file's own header prose and the shell's
    // notes both say things like "the single `<main>`", and a scan that reads prose as markup
    // would pass on a comment alone.
    const shell = readFileSync(shellPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    const linkAt = shell.indexOf('<a href="#erp-main"');
    expect(linkAt, 'AppShell.tsx has no <a href="#erp-main">').toBeGreaterThan(-1);
    expect(shell.slice(linkAt, linkAt + 160)).toContain('Skip to content');

    // The ordering IS the fix: first in the DOM is first in the Tab order, which is what puts the
    // staff member past the sidebar before they have tabbed into it even once.
    const sidebarAt = shell.indexOf('<Sidebar allowedHrefs');
    expect(sidebarAt, 'AppShell.tsx no longer renders <Sidebar allowedHrefs').toBeGreaterThan(-1);
    expect(linkAt).toBeLessThan(sidebarAt);

    // The target must be focusable, or the browser moves the scroll position but leaves focus
    // where it was and the next Tab goes back into the sidebar.
    const mainAt = shell.indexOf('<main');
    expect(mainAt, 'AppShell.tsx has no <main>').toBeGreaterThan(-1);
    const mainTag = shell.slice(mainAt, shell.indexOf('>', mainAt) + 1);
    expect(mainTag).toContain('id="erp-main"');
    expect(mainTag).toContain('tabIndex={-1}');
  });

  it('the skip link is hidden until focused', () => {
    const css = readFileSync(globalsCssPath, 'utf8');

    const base = ruleDeclarations(css, '.erp-skip-link');
    expect(Object.keys(base), 'globals.css has no .erp-skip-link rule').not.toHaveLength(0);
    // Parked out of the page's own top edge, so it takes no space and covers nothing.
    expect(base['position']).toBe('absolute');
    expect(base['transform']).toBe('translateY(-200%)');
    // A REAL 44px box when it does appear — and the same number the touch-target census resolves
    // this class to (tests/touch-target-geometry.ts, step 2b reads `min-height`).
    expect(base['min-height']).toBe('44px');
    // Above the shell it jumps over, not beneath it.
    expect(Number(base['z-index'])).toBeGreaterThanOrEqual(50);

    const focused = ruleDeclarations(css, '.erp-skip-link:focus-visible');
    expect(Object.keys(focused), 'globals.css has no .erp-skip-link:focus-visible rule').not.toHaveLength(0);
    // Focus is what un-parks it; nothing else may.
    expect(focused['transform']).toBe('none');
    expect(focused['outline']).toContain('var(--brand-ink)');

    // The skip target is focused programmatically, so it must not draw a focus box around the
    // whole workspace — the visible outcome is the scroll itself.
    expect(ruleDeclarations(css, '#erp-main:focus')['outline']).toBe('none');
  });
});
