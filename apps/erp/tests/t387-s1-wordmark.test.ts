/**
 * T-387 S1: the logo and the "SharEat" wordmark in the shell chrome.
 *
 * Source pins rather than a render: Sidebar is a client component behind a context provider, and
 * Vitest here runs in node with no jsdom (L6). What these guard is the part a render would not
 * catch cheaply anyway: the collapsed rail shows only the logo, so its link name comes from an
 * `sr-only` span — delete that span and the rail's home link has no accessible name, with every
 * other test still green (audit finding 1).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const strip = (s: string): string => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const sidebar = strip(readFileSync(`${here}../src/components/shell/Sidebar.tsx`, 'utf8'));
const topBar = strip(readFileSync(`${here}../src/components/shell/TopBar.tsx`, 'utf8'));

const WORDMARK = /Shar<span className="text-brand-ink">E<\/span>at/;
const LOGO = /<img src="\/brand\/logo-icon\.png" alt="" width=\{32\} height=\{32\}/;

function wordmarkFn(src: string): string {
  return src.match(/function Wordmark\(\)[\s\S]*?\n\}/)?.[0] ?? '';
}

describe('T-387 S1 — the sidebar wordmark', () => {
  const fn = wordmarkFn(sidebar);

  it('the Wordmark component exists', () => {
    expect(fn).not.toBe('');
  });

  it('shows the 32px logo, decorative, at every width', () => {
    expect(fn).toMatch(LOGO);
  });

  it('the text wordmark is expanded-only and in the display face, with the E in brand-ink', () => {
    expect(fn).toMatch(/className="shell-sidebar-expanded-only[^"]*font-display/);
    expect(fn).toMatch(WORDMARK);
  });

  it('⛔ the collapsed rail keeps an accessible name — an sr-only "SharEat", not the old "S" glyph', () => {
    expect(fn).toMatch(/className="sr-only shell-sidebar-collapsed-only">SharEat</);
    expect(fn).not.toMatch(/>S<\/span>/);
  });

  it('the mobile drawer header carries the logo and the wordmark', () => {
    const drawer = sidebar.match(/function Drawer\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(drawer).toMatch(LOGO);
    expect(drawer).toMatch(WORDMARK);
  });
});

describe('T-387 S1 — the logo stays visible on Grill Night', () => {
  const css = readFileSync(`${here}../src/app/globals.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('every logo carries brand-logo, and dark mode sits it on a cream (--ink) disc', () => {
    // Black ink on a transparent PNG: without the disc only the red "S" shows on charcoal.
    expect(sidebar.match(/className="brand-logo /g)?.length).toBe(2);
    expect(topBar).toMatch(/className="brand-logo /);
    const rule = css.match(/:root\[data-theme='dark'\] \.brand-logo\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/background:\s*var\(--ink\)/);
    expect(rule).toMatch(/border-radius:\s*9999px/);
  });
});

describe('T-387 S1 — the mobile top bar', () => {
  it('carries the logo and the wordmark in the display face', () => {
    expect(topBar).toMatch(LOGO);
    expect(topBar).toMatch(WORDMARK);
    expect(topBar).toMatch(/className="font-display[^"]*"/);
  });
});
