/**
 * T-589 B5 (c) — /admin/users/[personId]: a capability is always its plain label, never its snake_case code.
 * The code stays in `value=` attributes (it is what the form posts). Every test names its MUTANT.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPABILITY_LABEL, capabilityTitle } from '@shareat/auth';

const page = readFileSync(join(__dirname, '..', 'src', 'app', 'admin', 'users', '[personId]', 'page.tsx'), 'utf8');

describe('user page prints labels, not capability codes', () => {
  // MUTANT: print `{g.grantName}` (or `{c}`) again in a <span> -> the code shows as visible text.
  it('no JSX text expression prints a bare capability code', () => {
    const jsxText = page.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => /^\s*\{[\w.]+\}\s*$/.test(l) || />\{[\w.]+\}</.test(l));
    expect(jsxText.filter((l) => /grantName|\{c\}/.test(l))).toEqual([]);
  });

  // MUTANT: capabilityTitle falls back to the raw code for a known capability -> a snake_case code reaches the screen.
  it('every capability has a label with no underscore, so the title is never a code', () => {
    for (const code of Object.keys(CAPABILITY_LABEL)) expect(capabilityTitle(code), code).not.toMatch(/_/);
  });

  it('the code is still what the forms post', () => {
    expect(page).toContain('name="capability" value={c}');
    expect(page).toContain('name="capability" value={g.grantName}');
  });
});
