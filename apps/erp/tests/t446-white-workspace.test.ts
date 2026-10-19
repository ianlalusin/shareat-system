import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(readFileSync('apps/erp/src/app/globals.css', 'utf8'));
function declarations(selector: string) {
  const values: Record<string, string> = {};
  css.walkRules(rule => {
    if (rule.selector === selector) rule.walkDecls(d => { values[d.prop] = d.value; });
  });
  return values;
}

describe('T-446 plain white content, existing sidebar', () => {
  it('declares a separate pure-white workspace and neutral table tokens', () => {
    const root = declarations(':root');
    expect(root['--workspace']).toBe('#ffffff');
    expect(root['--workspace-border']).toBe('#e5e5e5');
    expect(root['--workspace-stripe']).toBe('#f8f8f8');
    expect(root['--surface']).toBe('#fffdf8');
  });
  it('applies white to the full content landmark without a pattern', () => {
    const workspace = declarations('.erp-workspace');
    expect(workspace['background-color']).toBe('var(--workspace)');
    expect(workspace['background-image']).toBe('none');
    const shell = readFileSync('apps/erp/src/components/shell/AppShell.tsx', 'utf8');
    expect(shell).toContain('<main className="erp-workspace min-w-0 flex-1">');
    expect(shell.indexOf('<Sidebar allowedHrefs')).toBeLessThan(shell.indexOf('<main className="erp-workspace'));
  });
  it('makes content surfaces white without overriding semantic warning/error colors', () => {
    const page = declarations(":root:not([data-theme='dark']) .erp-page");
    expect(page).toEqual({ '--surface': 'var(--workspace)', '--surface-border': 'var(--workspace-border)' });
  });
  it('retains the existing opt-in dark palette', () => {
    const dark = declarations(":root[data-theme='dark']");
    expect(dark['--workspace']).toBe('var(--canvas)');
    expect(dark['--workspace-stripe']).toBe('var(--canvas)');
    expect(dark['--surface']).toBe('#1c1a18');
    expect(dark['--canvas']).toBe('#121110');
  });
  it('preserves visible neutral striping and header structure', () => {
    expect(declarations(':where(.erp-page tbody > tr:nth-child(even))').background).toBe('var(--workspace-stripe)');
    expect(declarations('.erp-page :where(thead th)').background).toBe('var(--workspace-stripe)');
  });
  it('uses a compact name hint and a container-based three-field item row', () => {
    expect(declarations('.erp-form-fields > *').flex).toBe('0 1 16rem');
    expect(declarations('.erp-field-name, .erp-form-fields > .erp-field-name')['flex-basis']).toBe('16rem');
    expect(declarations('.erp-item-identity')['max-width']).toBe('34rem');
    let columns: string | undefined;
    css.walkAtRules('container', at => {
      if (at.params === '(min-width: 21rem)') at.walkRules('.erp-item-identity', rule => rule.walkDecls('grid-template-columns', d => { columns = d.value; }));
    });
    expect(columns).toBe('minmax(0, 16rem) 7.5rem 5.5rem');
    const page = readFileSync('apps/erp/src/app/items/page.tsx', 'utf8');
    expect(page).toContain('className="erp-item-identity"');
    expect(page).toContain('width="name"');
    expect(page).toContain('className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"');
    expect(page).toContain('label="Buy"');
    expect(page).toContain('aria-label="Bought from suppliers"');
  });
});
