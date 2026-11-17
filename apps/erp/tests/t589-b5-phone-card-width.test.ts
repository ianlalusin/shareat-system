/**
 * T-589 B5 (a) — the phone record card keeps a real width for the name. Every test names the MUTANT it kills.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'globals.css'), 'utf8');
const rules: Rule[] = [];
postcss.parse(css).walkRules(r => { rules.push(r); });
const flat = (r: Rule) => r.selector.replace(/\s+/g, ' ');
const decls = (r: Rule, prop: string) => { const out: string[] = []; r.walkDecls(prop, d => { out.push(d.value); }); return out; };
const slot = (name: string) => rules.filter(r => flat(r).includes(`[data-card-slot="${name}"]`) && flat(r).startsWith('[data-phone-table-root] [data-card-slot'));

describe('phone record card width', () => {
  // MUTANT: put `minmax(0, 1fr)` back into any one summary grid variant -> the name column can collapse to one letter.
  it('the title track of every summary-card grid has a non-zero minimum', () => {
    const grids = rules.filter(r => flat(r).includes('[data-phone-table-root]') && flat(r).includes('tr[data-card-kind="summary"]') || flat(r).includes('tr[data-card-has-')).flatMap(r => decls(r, 'grid-template-columns'));
    expect(grids.length).toBeGreaterThanOrEqual(8);
    for (const g of grids) { expect(g, g).toContain('minmax(min('); expect(g, g).not.toContain('minmax(0'); }
  });

  // MUTANT: put `overflow-wrap: anywhere` back on the title or subtitle rule -> ordinary words break letter by letter.
  it('title and subtitle wrap at word breaks, not anywhere', () => {
    for (const name of ['title', 'subtitle']) {
      const values = slot(name).flatMap(r => decls(r, 'overflow-wrap'));
      expect(values.length).toBeGreaterThan(0);
      expect(values).not.toContain('anywhere');
    }
  });

  // MUTANT: delete the @container rule (or the `grid-column: 2 / -1`) -> the figures stay beside the name on a narrow card.
  it('a narrow card moves the figures to a row of their own', () => {
    const inner: Rule[] = [];
    postcss.parse(css).walkAtRules('container', at => { if (at.params.includes('max-width: 24rem')) at.walkRules(r => { inner.push(r); }); });
    expect(inner.some(r => flat(r).includes('[data-card-slot="key"]') && decls(r, 'grid-column').includes('2 / -1'))).toBe(true);
    // MUTANT: put `white-space: nowrap` back on the key cell -> the label cannot wrap and the page scrolls sideways.
    for (const r of inner) expect(decls(r, 'white-space').join(' ')).not.toContain('nowrap');
    expect(rules.some(r => flat(r).includes('table[data-phone-cards]') && decls(r, 'container-type').includes('inline-size'))).toBe(true);
  });
});
