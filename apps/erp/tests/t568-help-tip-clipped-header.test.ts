import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '..', 'src', 'app', 'globals.css'), 'utf8');

describe('T-568 UI-009 - a help tip in a clipped phone-card header', () => {
  it('leaves the tab order: the clipped thead hides its help tips with visibility:hidden', () => {
    // The thead is clip-path:inset(50%) on a phone. A focusable control inside it takes focus with no visible ring.
    const rule = css.match(/table\[data-phone-cards\] > thead:not\(\[data-card-controls\]\) \.erp-help-tip-wrap \{([^}]*)\}/);
    expect(rule, 'help-tip rule for the clipped header is missing').not.toBeNull();
    expect(rule?.[1]).toContain('visibility: hidden');
  });

  it('only applies inside the phone-card block (below the tablet breakpoint)', () => {
    const at = css.indexOf('.erp-help-tip-wrap { visibility: hidden; }');
    const clipped = css.indexOf('thead:not([data-card-controls]) {\n    position: absolute');
    expect(at).toBeGreaterThan(clipped);
    expect(at - clipped).toBeLessThan(900);
  });
});
