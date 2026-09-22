/**
 * Card — T-334 slice 2 component contract (docs/tasks/334-slice-2-component-contract.md §3, §4).
 *
 * ⚠️ `.ts`, not `.tsx` — see `ui-button.test.ts`'s header for the full reason (DEF-081/DEF-221
 * shape). Same pattern as `filter-row.test.ts`: `createElement` + `renderToStaticMarkup`,
 * `environment: 'node'`.
 *
 * Card is currently a STUB (`export function Card(): null`) pre-wired by the orchestrator so red
 * here is an assertion failure, not a module-not-found.
 *
 * ⛔ §9 R5: Card is invisible to `tests/unit/production-caller-ratchet.test.ts` (DEF-403 — the
 * census counts the word "Card" in unrelated JSX/comment prose as a production caller). That is
 * the orchestrator's to fix by regenerating the baseline, not this file's concern.
 *
 * §4 names only the className-append behaviour (case 6) as a required assertion for Card; §3's
 * `bg-surface border border-surface-border` rounding/padding description is not in the enumerated
 * test list, so no literal test for it is added here (RULES.md: stay inside what the spec asks).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Card } from '../src/components/ui/Card';

function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    // Guard, not `!`: noUncheckedIndexedAccess types a capture group as possibly undefined even
    // though this regex always has group 1 on a match; `?? ''` degrades to a no-op split instead.
    for (const t of (m[1] ?? '').split(/\s+/)) if (t) tokens.add(t);
  }
  return tokens;
}

describe('Card — T-334 slice 2 contract', () => {
  it('appends a passed className to its own classes rather than replacing them (§4.6)', () => {
    // §3 names Card's own classes literally (bg-surface, border-surface-border), unlike the other
    // two components' base states, so those literals double as the append-not-replace proof: a
    // REPLACE implementation would drop them.
    const html = renderToStaticMarkup(createElement(Card, { className: 'mt-2', children: 'x' }));
    const tokens = classTokens(html);
    expect(tokens.has('mt-2')).toBe(true);
    expect(tokens.has('bg-surface')).toBe(true);
    expect(tokens.has('border-surface-border')).toBe(true);
  });

  it('renders its children — asserted on real content, not emptiness (§11.1, §11.4)', () => {
    // §4 enumerated what to assert on classes and never required the component to render what it
    // was given: the audit's mutant (no {children}) passed every prior assertion. Not optional for
    // Card even though it takes no other rest props (§11.4).
    const html = renderToStaticMarkup(createElement(Card, { children: 'Real card content' }));
    expect(html).toContain('Real card content');

    // Negative half (round 3 finding): the line above alone is satisfied by a Card that hardcodes
    // "Real card content" regardless of props. Different children must produce different output.
    const otherHtml = renderToStaticMarkup(createElement(Card, { children: 'Different content' }));
    expect(otherHtml).toContain('Different content');
    expect(otherHtml).not.toContain('Real card content');
  });
});
