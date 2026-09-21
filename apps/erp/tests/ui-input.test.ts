/**
 * Input — T-334 slice 2 component contract (docs/tasks/334-slice-2-component-contract.md §3, §4).
 *
 * ⚠️ `.ts`, not `.tsx` — see `ui-button.test.ts`'s header for the full reason (DEF-081/DEF-221
 * shape: the unit project's include glob has no `.tsx` variant). Same pattern as
 * `filter-row.test.ts`: `createElement` + `renderToStaticMarkup`, `environment: 'node'`.
 *
 * Input is currently a STUB (`export function Input(): null`) pre-wired by the orchestrator so red
 * here is an assertion failure, not a module-not-found.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Input } from '../src/components/ui/Input';

function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    // Guard, not `!`: noUncheckedIndexedAccess types a capture group as possibly undefined even
    // though this regex always has group 1 on a match; `?? ''` degrades to a no-op split instead.
    for (const t of (m[1] ?? '').split(/\s+/)) if (t) tokens.add(t);
  }
  return tokens;
}

describe('Input — T-334 slice 2 contract', () => {
  it('invalid emits both border-danger and aria-invalid="true" — positive/negative control pair (§4.5)', () => {
    const invalidHtml = renderToStaticMarkup(createElement(Input, { invalid: true, name: 'email' }));
    const validHtml = renderToStaticMarkup(createElement(Input, { name: 'email' }));

    // Positive half — ⭐ the spec's own warning: "assert both; the ARIA half is the half that gets
    // dropped."
    expect(classTokens(invalidHtml).has('border-danger')).toBe(true);
    expect(invalidHtml).toMatch(/aria-invalid="true"/);

    // Negative half — same control-pair reasoning §9 R3 states for Button's icon: an assertion
    // that border-danger/aria-invalid appear when invalid, with no case proving they can ever be
    // absent, is satisfied by an Input that always renders them.
    expect(classTokens(validHtml).has('border-danger')).toBe(false);
    expect(validHtml).not.toMatch(/aria-invalid="true"/);
  });

  it('a caller-supplied aria-invalid cannot override the component\'s own when invalid is true (audit finding, §3/§4.5)', () => {
    // Colour is never the sole channel (§4.5): if a caller's own aria-invalid can win over the
    // component's, invalid renders a red border with nothing for a screen reader. Only
    // aria-invalid is at risk here — className is already destructured out of ...rest in Input,
    // and Button/Card don't accept an aria-invalid prop at all, so this case does not generalise.
    const html = renderToStaticMarkup(
      createElement(Input, { invalid: true, 'aria-invalid': 'false', name: 'email' }),
    );
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).not.toMatch(/aria-invalid="false"/);
  });

  it('appends a passed className to its own classes rather than replacing them (§4.6)', () => {
    // Combined with invalid=true so a REPLACE implementation (which would drop border-danger) is
    // caught — the contract never states Input's own base/layout classes literally.
    const html = renderToStaticMarkup(
      createElement(Input, { invalid: true, className: 'mt-2', name: 'email' }),
    );
    const tokens = classTokens(html);
    expect(tokens.has('mt-2')).toBe(true);
    expect(tokens.has('border-danger')).toBe(true);
  });
});
