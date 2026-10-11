/**
 * T-387 S6 - StatusHero (components/ui/StatusHero.tsx), server-safe (Guards 7-10: no 'use client', no hooks,
 * tokens only). Props `{ kind, word, step, steps, line, tone, children }`.
 *
 * Markup pinned (data attributes, so styling can change):
 *   root     data-status-hero  data-tone="<tone>"
 *   icon     the StatusIcon svg for `kind` (class status-icon-<kind>)
 *   word     [data-status-word]; tone danger puts `text-danger` on it
 *   cells    one [data-step-cell] per step, in order, data-step-state = done | current | todo; the step label is the text
 *   exit     tone 'danger' = a side exit at index `step`: cells before it `done`, the cell at `step` and every later
 *            cell `exited` (greyed); none `current`
 *   line     [data-status-line]
 *   action   [data-status-action] wraps `children`; absent when there are no children
 * `step` outside 0..steps.length-1, empty `steps`, or an empty word/line THROWS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusHero } from '../src/components/ui/StatusHero';

const here = path.dirname(fileURLToPath(import.meta.url));
const STEPS = ['draft', 'submitted', 'accepted', 'ready', 'dispatched', 'received'];
const base = { kind: 'preparing', word: 'Being packed', step: 2, steps: STEPS, line: 'The commissary is packing your order.', tone: 'progress' };
const R = (p: Record<string, unknown> = {}, children?: unknown) =>
  renderToStaticMarkup(createElement(StatusHero as never, { ...base, ...p } as never, children as never));
const states = (html: string) => [...html.matchAll(/data-step-state="([a-z]+)"/g)].map((m) => m[1]);

describe('StatusHero in progress', () => {
  const html = R();
  it('renders the root hook, the icon, the word and the line', () => {
    expect(html).toContain('data-status-hero');
    expect(html).toContain('data-tone="progress"');
    expect(html).toContain('status-icon-preparing');
    expect(html).toMatch(/data-status-word[^>]*>[^<]*Being packed/);
    expect(html).toMatch(/data-status-line[^>]*>[^<]*The commissary is packing your order\./);
  });
  it('renders one cell per step, in order, each with its label', () => {
    expect((html.match(/data-step-cell/g) ?? []).length).toBe(6);
    const text = html.slice(html.indexOf('data-step-cell')).replace(/<[^>]+>/g, ' ');
    let at = 0;
    for (const s of STEPS) {
      const i = text.toLowerCase().indexOf(s, at);
      expect(i, `step label ${s} in order`).toBeGreaterThanOrEqual(0);
      at = i + s.length;
    }
  });
  it('step 2: done, done, current, todo, todo, todo', () => {
    expect(states(html)).toEqual(['done', 'done', 'current', 'todo', 'todo', 'todo']);
  });
  it('step 0: current then all todo; last step: five done then current', () => {
    expect(states(R({ step: 0 }))).toEqual(['current', 'todo', 'todo', 'todo', 'todo', 'todo']);
    expect(states(R({ step: 5 }))).toEqual(['done', 'done', 'done', 'done', 'done', 'current']);
  });
  it('the word is not red unless the tone is danger', () => {
    expect(html).not.toContain('text-danger');
  });
  it('the action slot wraps the children; absent without children', () => {
    const withKids = R({}, createElement('button', { id: 'go' }, 'Mark ready'));
    expect(withKids).toMatch(/data-status-action[^>]*>[\s\S]*<button id="go">Mark ready<\/button>/);
    expect(html).not.toContain('data-status-action');
  });
});

describe('StatusHero side exit (tone danger)', () => {
  const html = R({ kind: 'rejected', word: 'Rejected', tone: 'danger', step: 1, line: 'The commissary rejected this order. You can order again.' });
  it('the word is red and the root carries the danger tone', () => {
    expect(html).toContain('data-tone="danger"');
    expect(html).toMatch(/data-status-word[^>]*text-danger|text-danger[^>]*data-status-word/);
    expect(html).toContain('status-icon-rejected');
  });
  it('chevrons: before the exit done, from the exit onward exited (greyed), none current', () => {
    expect(states(html)).toEqual(['done', 'exited', 'exited', 'exited', 'exited', 'exited']);
    expect(html).not.toContain('data-step-state="current"');
  });
  it('exit at the first step greys everything', () => {
    expect(states(R({ tone: 'danger', kind: 'cancelled', step: 0 }))).toEqual(['exited', 'exited', 'exited', 'exited', 'exited', 'exited']);
  });
});

describe('StatusHero negatives', () => {
  it.each([[-1], [6], [99]])('step %i out of range throws', (step) => expect(() => R({ step })).toThrow());
  it('empty steps throws', () => expect(() => R({ steps: [], step: 0 })).toThrow());
  it('an empty word or line throws (a colour without a word)', () => {
    expect(() => R({ word: '' })).toThrow();
    expect(() => R({ line: '  ' })).toThrow();
  });
});

describe('StatusHero source rules and barrel', () => {
  const ui = path.join(here, '..', 'src', 'components', 'ui');
  const src = readFileSync(path.join(ui, 'StatusHero.tsx'), 'utf8');
  it('server-safe: no use client, no hooks', () => {
    expect(src).not.toMatch(/['"]use client['"]/);
    expect(src).not.toMatch(/\buse(State|Effect|Ref|Memo|Callback|Reducer|LayoutEffect)\s*\(/);
  });
  it('uses the StatusIcon kit piece, tokens only', () => {
    expect(src).toMatch(/StatusIcon/);
    expect(src).not.toMatch(/\b(?:text|bg|border)-(?:red|green|blue|amber|yellow|orange|emerald|rose|sky)-\d/);
    expect(src).not.toMatch(/\bbg-danger(?!-)/);
  });
  it('the barrel exports StatusHero and the steps module', () => {
    const idx = readFileSync(path.join(ui, 'index.ts'), 'utf8');
    expect(idx).toMatch(/StatusHero/);
    expect(idx).toMatch(/status-steps/);
  });
});
