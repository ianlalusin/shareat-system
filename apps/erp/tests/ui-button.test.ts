/**
 * Button — T-334 slice 2 component contract (docs/tasks/334-slice-2-component-contract.md §3, §4,
 * §9 R1-R3).
 *
 * ⚠️ `.ts`, not `.tsx`, on purpose: the unit project's include glob (`vitest.config.mts`) is
 * `apps/**\/*.test.ts` — no `.tsx` variant. A `.test.tsx` here would match nothing and pass
 * silently (DEF-081/DEF-221 shape). `createElement` stands in for JSX, copying
 * `filter-row.test.ts`'s proven pattern exactly — no jsdom, no @testing-library, `environment:
 * 'node'`, `renderToStaticMarkup`.
 *
 * Button is currently a STUB (`export function Button(): null`) pre-wired by the orchestrator so
 * red here is an assertion failure, not a module-not-found.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/ui/Button';

/** Every `class="..."` attribute in the html, flattened into one token set — §4's own warning:
 *  "an unanchored substring match cannot tell `bg-danger` from `bg-danger-surface` apart; assert
 *  on the class token, not on a substring." */
function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    // Guard, not `!`: noUncheckedIndexedAccess types a capture group as possibly undefined even
    // though this regex always has group 1 on a match; `?? ''` degrades to a no-op split instead.
    for (const t of (m[1] ?? '').split(/\s+/)) if (t) tokens.add(t);
  }
  return tokens;
}

describe('Button — T-334 slice 2 contract', () => {
  it('primary emits a solid brand fill and a hover class (§4.1)', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'primary', children: 'Save' }));
    const tokens = classTokens(html);
    expect(tokens.has('bg-brand')).toBe(true);
    expect(tokens.has('hover:bg-brand-hover')).toBe(true);
    // §9 R1: text-white is the named, permitted exception to token discipline for this one position.
    expect(tokens.has('text-white')).toBe(true);
  });

  it('secondary is the default when no variant is passed, asserted as a literal (§4.2)', () => {
    const defaultHtml = renderToStaticMarkup(createElement(Button, { children: 'Cancel' }));
    const secondaryHtml = renderToStaticMarkup(
      createElement(Button, { variant: 'secondary', children: 'Cancel' }),
    );
    // The positive literal: §3's own prose names `text-ink` for secondary. Absence-only assertions
    // (no bg-brand, no border-danger) would be satisfied by the null stub, which is why this line —
    // not the equality below — is what must fail first at RED.
    expect(classTokens(defaultHtml).has('text-ink')).toBe(true);
    // The literal: default output must be byte-identical to explicit variant="secondary" output.
    expect(defaultHtml).toBe(secondaryHtml);
    expect(classTokens(defaultHtml).has('bg-brand')).toBe(false);
    expect(classTokens(defaultHtml).has('border-danger')).toBe(false);
  });

  it('danger emits no solid brand/danger fill and does emit an outline (§4.3)', () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: 'danger', children: 'Delete' }));
    const tokens = classTokens(html);
    expect(tokens.has('bg-brand')).toBe(false);
    // Token, not substring: bg-danger-surface must not make this assertion vacuous either way —
    // Button's danger treatment (§3) never uses a surface fill at all.
    expect(tokens.has('bg-danger')).toBe(false);
    expect(tokens.has('bg-danger-surface')).toBe(false);
    expect(tokens.has('border-danger')).toBe(true);
  });

  it('danger has no dark-mode text treatment yet — pins ADR-013 §7\'s open gap (audit item 5)', () => {
    // ⛔ DO NOT "fix" this by adding a dark: class here or to Button.tsx. #a00606 measures 2.52:1
    // on black (ADR-013 §7) — fails AA — and which red replaces it in dark mode is Ian's ruling to
    // make, not ours (parent task §7, ADR-013 §7 "what is NOT decided"). This test pins the CURRENT
    // state so slice 3 cannot adopt danger into dark mode without tripping it: closing this gap
    // needs a deliberate, conscious update here, made only after Ian rules on the dark-mode danger
    // colour — mirroring how globals.css already pins its own version of this same open gap.
    const html = renderToStaticMarkup(createElement(Button, { variant: 'danger', children: 'Delete' }));
    const tokens = classTokens(html);
    const hasDarkTextOverride = [...tokens].some((t) => /^dark:text-/.test(t));
    expect(hasDarkTextOverride).toBe(false);
  });

  it('renders a hand-drawn icon only for the danger variant — positive/negative control pair (§9 R3)', () => {
    const danger = renderToStaticMarkup(createElement(Button, { variant: 'danger', children: 'Delete' }));
    const primary = renderToStaticMarkup(createElement(Button, { variant: 'primary', children: 'Save' }));
    const secondary = renderToStaticMarkup(createElement(Button, { variant: 'secondary', children: 'Cancel' }));

    // Positive half.
    expect(danger).toContain('<svg');
    expect(danger).toMatch(/aria-hidden="true"/);

    // Negative half — R3: "the negative half is what gives the positive half meaning. An
    // assertion that an icon is present, with no case proving it can ever be absent, is satisfied
    // by a component that always renders one."
    expect(primary).not.toContain('<svg');
    expect(secondary).not.toContain('<svg');
  });

  it('defaults type to "button", and an explicit type="submit" survives (§4.4)', () => {
    const defaultHtml = renderToStaticMarkup(createElement(Button, { children: 'Save' }));
    expect(defaultHtml).toMatch(/type="button"/);

    const submitHtml = renderToStaticMarkup(createElement(Button, { type: 'submit', children: 'Save' }));
    expect(submitHtml).toMatch(/type="submit"/);
    expect(submitHtml).not.toMatch(/type="button"/);
  });

  it('appends a passed className to its own classes rather than replacing them (§4.6)', () => {
    // Combined with variant="primary" so a REPLACE implementation (which would drop bg-brand) is
    // caught — the contract never states Button's own base/layout classes literally, so token
    // co-presence is the assertion available without inventing an unstated literal.
    const html = renderToStaticMarkup(
      createElement(Button, { variant: 'primary', className: 'mt-2', children: 'Save' }),
    );
    const tokens = classTokens(html);
    expect(tokens.has('mt-2')).toBe(true);
    expect(tokens.has('bg-brand')).toBe(true);
  });

  it('renders its children — asserted on real content, not emptiness (§11.1)', () => {
    // §4 enumerated what to assert on classes/attributes and never required the component to BE a
    // component: the audit's mutant (no {children}, no {...rest}) passed all 11 prior assertions.
    // This is the check the enumeration left out.
    const html = renderToStaticMarkup(createElement(Button, { children: 'Save changes' }));
    expect(html).toContain('Save changes');

    // Negative half (round 3 finding): the line above alone is satisfied by a Button that
    // hardcodes "Save changes" regardless of props — same control-pair shape §9 R3 requires for
    // the danger icon. Different children must produce different output.
    const otherHtml = renderToStaticMarkup(createElement(Button, { children: 'Cancel' }));
    expect(otherHtml).toContain('Cancel');
    expect(otherHtml).not.toContain('Save changes');
  });

  it('forwards disabled through {...rest} (§11.2)', () => {
    // ⚠️ Caught by my own mutant-dies check: `\bdisabled\b` also matches the static Tailwind
    // variant classes `disabled:pointer-events-none`/`disabled:opacity-50`, which are present on
    // every render whether or not the element is actually disabled — a vacuous assertion, same
    // shape as matching a substring instead of a token. `disabled=""` is the literal, unambiguous
    // serialisation of the real boolean attribute (verified against the real component's output);
    // the CSS variant prefix is followed by `:`, never `=""`, so this cannot collide with it.
    const html = renderToStaticMarkup(createElement(Button, { disabled: true, children: 'Save' }));
    expect(html).toContain('disabled=""');

    // Negative half (round 3 finding): the line above alone is satisfied by a Button that is
    // unconditionally disabled — exactly the real defect a reviewer planted and reverted today.
    const notDisabledHtml = renderToStaticMarkup(createElement(Button, { children: 'Save' }));
    expect(notDisabledHtml).not.toContain('disabled=""');
  });

  it('forwards onClick through {...rest} (§11.2)', () => {
    // onClick cannot appear in static HTML — React never serialises event handlers into markup —
    // so this is the one case in this file that does not use renderToStaticMarkup. Button is a
    // plain function component (guard 10: no hooks), so calling it directly and reading the
    // React element it returns is the only way to observe prop forwarding that never reaches the
    // DOM. `any` here is deliberate: asserting Button's exact prop type would mean engaging with
    // its implementation, which is the auditor's lane, not this file's.
    const handleClick = () => {};
    const element: any = Button({ onClick: handleClick, children: 'Save' } as any);
    expect(element.props.onClick).toBe(handleClick);
  });
});
