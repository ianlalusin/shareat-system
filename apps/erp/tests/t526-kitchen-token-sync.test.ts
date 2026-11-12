/**
 * T-526 R1 - the Kitchen's dark tokens are a COPY of the `:root[data-theme='dark']` block (that block cannot take a second selector: other suites
 * match its text exactly). This fails when the two drift, so the kitchen can never be a different dark from the rest of the app.
 */
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const css = postcss.parse(readFileSync('apps/erp/src/app/globals.css', 'utf8'));
function declarations(selector: string): Record<string, string> {
  const values: Record<string, string> = {};
  css.walkRules((rule) => {
    if (rule.selector === selector) rule.walkDecls((d) => void (values[d.prop] = d.value));
  });
  return values;
}

describe('T-526 - kitchen dark tokens equal the app dark tokens', () => {
  const app = declarations(":root[data-theme='dark']");
  const kitchen = declarations(":root:has(.pos-theme[data-theme='dark'])");

  it('both blocks exist and are not empty (a scan that finds nothing must not pass)', () => {
    expect(Object.keys(app).length).toBeGreaterThan(20);
    expect(Object.keys(kitchen).length).toBeGreaterThan(20);
  });
  it('every declaration matches', () => {
    expect(kitchen).toEqual(app);
  });
});
