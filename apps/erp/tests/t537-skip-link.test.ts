/**
 * T-537 - "Skip to content" on every ERP page (WCAG 2.4.1; impeccable audit 2026-11-03, finding 8).
 *
 * Keyboard users used to Tab ~40 sidebar links before reaching the page. Two halves must hold:
 *   1. the link is the FIRST focusable thing in the shell and points at a focusable `<main>`;
 *   2. it is parked off-screen until focused (a bar visible on every screen would be its own defect).
 *
 * Source-level, like the other shell guards. Each check is a function run against the real source
 * AND against a mutant of it; the mutant must make it fail, so a check that can never fail is caught.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const shellSrc = readFileSync(resolve(here, '..', 'src', 'components', 'shell', 'AppShell.tsx'), 'utf8');
const cssSrc = readFileSync(resolve(here, '..', 'src', 'app', 'globals.css'), 'utf8');

const LINK = '<a href="#erp-main" className="erp-skip-link">Skip to content</a>';
const SIDEBAR = '<Sidebar allowedHrefs={allowedHrefs} signedInAs={signedInAs} />';

/** Declarations of the top-level rule with this exact selector, later values winning. */
function decls(css: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector.split(/\s+/).join(' ').trim() !== selector) return;
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
  });
  return out;
}

/** Throws when the shell source is wrong. Comments are stripped so prose cannot satisfy it. */
function checkShell(src: string): void {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const linkAt = code.indexOf('<a href="#erp-main"');
  expect(linkAt, 'no <a href="#erp-main">').toBeGreaterThan(-1);
  expect(code.slice(linkAt, linkAt + 160)).toContain('Skip to content');
  const sidebarAt = code.indexOf('<Sidebar allowedHrefs');
  expect(sidebarAt, 'no <Sidebar allowedHrefs').toBeGreaterThan(-1);
  expect(linkAt).toBeLessThan(sidebarAt); // first in DOM = first Tab stop
  const mainAt = code.indexOf('<main');
  expect(mainAt, 'no <main>').toBeGreaterThan(-1);
  const mainTag = code.slice(mainAt, code.indexOf('>', mainAt) + 1);
  expect(mainTag).toContain('id="erp-main"');
  expect(mainTag).toContain('tabIndex={-1}'); // else focus stays in the sidebar after the jump
}

/** Throws when the stylesheet is wrong. */
function checkCss(css: string): void {
  const base = decls(css, '.erp-skip-link');
  expect(Object.keys(base), 'no .erp-skip-link rule').not.toHaveLength(0);
  expect(base['position']).toBe('fixed');
  expect(base['transform']).toBe('translateY(-200%)'); // parked above the viewport
  expect(base['min-height']).toBe('44px'); // real box; the touch-target census reads this
  expect(Number(base['z-index'])).toBeGreaterThanOrEqual(50);
  const focused = decls(css, '.erp-skip-link:focus-visible');
  expect(Object.keys(focused), 'no .erp-skip-link:focus-visible rule').not.toHaveLength(0);
  expect(focused['transform']).toBe('none'); // focus un-parks it
  expect(focused['outline']).toContain('var(--ink)'); // visible focus ring
  expect(decls(css, '#erp-main:focus')['outline']).toBe('none');
}

function mutate(src: string, from: string, to: string): string {
  expect(src, `mutant anchor missing: ${from}`).toContain(from);
  return src.replace(from, to);
}

describe('T-537 - the skip link', () => {
  it('the real shell and stylesheet pass', () => {
    checkShell(shellSrc);
    checkCss(cssSrc);
  });

  it('shell mutants fail', () => {
    const noLink = mutate(shellSrc, LINK, '');
    expect(() => checkShell(noLink)).toThrow(); // link removed
    expect(() => checkShell(mutate(noLink, SIDEBAR, SIDEBAR + LINK))).toThrow(); // link after the sidebar
    expect(() => checkShell(mutate(shellSrc, 'id="erp-main" ', ''))).toThrow(); // target id dropped
    expect(() => checkShell(mutate(shellSrc, ' tabIndex={-1}', ''))).toThrow(); // target not focusable
    expect(() => checkShell(mutate(shellSrc, 'Skip to content</a>', 'Menu</a>'))).toThrow(); // wrong label
  });

  it('stylesheet mutants fail', () => {
    expect(() => checkCss(mutate(cssSrc, 'transform: translateY(-200%);', 'transform: none;'))).toThrow(); // never parked
    expect(() =>
      checkCss(mutate(cssSrc, '  transform: none;\n  outline: 3px', '  transform: translateY(-200%);\n  outline: 3px')),
    ).toThrow(); // focus does not un-park it
    expect(() => checkCss(mutate(cssSrc, 'min-height: 44px;\n  padding-inline: 1rem;', 'min-height: 20px;\n  padding-inline: 1rem;'))).toThrow(); // target too small
    expect(() => checkCss(mutate(cssSrc, 'z-index: 100;\n  display: inline-flex;', 'z-index: 1;\n  display: inline-flex;'))).toThrow(); // buried under the shell
    expect(() => checkCss(mutate(cssSrc, 'outline: 3px solid var(--ink);', 'outline: none;'))).toThrow(); // no focus ring
    expect(() => checkCss(mutate(cssSrc, '#erp-main:focus { outline: none; }', '#erp-main:focus { outline: 2px solid red; }'))).toThrow(); // box round the workspace
  });
});
