/**
 * T-387 S3 — StatusIcon (components/ui/StatusIcon.tsx) and its keyframes in app/globals.css.
 *
 * API pinned: `StatusIcon({ kind })`, kind one of the 11 OrderStatus-board icons:
 *   draft submitted preparing ready dispatched received disputed cancelled rejected void counting
 * Each renders an inline `<svg aria-hidden="true" class="status-icon status-icon-<kind>">`. The motion is CSS only
 * (no hooks, no 'use client': Guard 10). Every `@keyframes` in globals.css lives inside
 * `@media (prefers-reduced-motion: no-preference)`, and each kind has a `.status-icon-<kind>` rule that sets an
 * `animation` inside that block, so reduced motion gets still icons.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusIcon } from '../src/components/ui/StatusIcon';

const KINDS = ['draft', 'submitted', 'preparing', 'ready', 'dispatched', 'received', 'disputed', 'cancelled', 'rejected', 'void', 'counting'];
const here = path.dirname(fileURLToPath(import.meta.url));
const R = (kind: string) => renderToStaticMarkup(createElement(StatusIcon as never, { kind } as never));

const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** Returns the text of every top-level `@media (prefers-reduced-motion: no-preference) { ... }` body (brace matched). */
function reducedMotionBlocks(css: string): string[] {
  const out: string[] = [];
  const re = /@media\s*\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)\s*\{/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push(css.slice(start, i - 1));
  }
  return out;
}

describe('StatusIcon markup', () => {
  it.each(KINDS)('%s: an inline aria-hidden svg with its own class hook', (kind) => {
    const html = R(kind);
    expect(html).toMatch(/^<svg\b/);
    expect(html).toContain('aria-hidden="true"');
    const cls = (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(/\s+/);
    expect(cls).toContain('status-icon');
    expect(cls).toContain(`status-icon-${kind}`);
  });
  it('the 11 kinds are 11 different drawings', () => {
    const drawn = KINDS.map((k) => R(k).replace(/status-icon-[a-z]+/, ''));
    expect(new Set(drawn).size).toBe(11);
  });
  it('NEGATIVE: no raw hex, no stock hue, no inline style animation', () => {
    for (const k of KINDS) {
      const html = R(k);
      expect(html, k).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html, k).not.toMatch(/\b(?:red|green|blue|amber|slate|gray|zinc|neutral|violet)-\d{2,3}\b/);
      expect(html, k).not.toMatch(/style="[^"]*animation/);
    }
  });
});

describe('globals.css keyframes are scoped to prefers-reduced-motion: no-preference', () => {
  const css = stripCss(readFileSync(path.join(here, '..', 'src', 'app', 'globals.css'), 'utf8'));
  const blocks = reducedMotionBlocks(css);
  const inside = blocks.join('\n');
  const outside = blocks.reduce((rest, b) => rest.replace(b, ''), css);

  it('there is a no-preference block with at least one @keyframes', () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(inside).toMatch(/@keyframes\s+[\w-]+/);
  });
  it('NEGATIVE: no @keyframes anywhere OUTSIDE the block (reduced motion must get still icons)', () => {
    expect(outside).not.toMatch(/@keyframes/);
  });
  it.each(KINDS)('%s: its .status-icon-<kind> rule sets an animation inside the block', (kind) => {
    const rule = new RegExp(`\\.status-icon-${kind}\\b[^{}]*\\{[^}]*animation`);
    expect(inside, kind).toMatch(rule);
  });
  it('NEGATIVE: no `animation:` declaration on a .status-icon selector outside the block', () => {
    expect(outside).not.toMatch(/\.status-icon[\w-]*[^{}]*\{[^}]*animation/);
  });
});
