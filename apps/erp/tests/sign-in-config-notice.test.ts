/**
 * `EmailSignInForm`'s configuration notice — Contract 3 (T-323, DEF-368). Once T-303/T-304 gave
 * the terminal PIN path the same `publicEnv()` dependency, "PIN sign-in is unaffected" stopped
 * being true; the heading now has to say the outage covers both paths, not just email.
 *
 * ⚠️ `EmailSignInForm.tsx:37` imports `./actions`, a `'use server'` module reaching `@shareat/auth`
 * → `@shareat/db` → `next/headers` — `sign-in-safe-next.test.ts:20-23` measured that tree at
 * ~4.6s cold, which alone blows the unit project's 5s default timeout. Mocked below rather than
 * raising the timeout: nothing in this file ever submits the form, so the real action is never
 * called either way.
 *
 * ⛔⛔ `.github/workflows/ci.yml` sets all five `NEXT_PUBLIC_FIREBASE_*` values to `ci` as job-level
 * env for the whole verify job, including `npm run test`. `beforeEach` replaces `process.env`
 * outright rather than trusting an ambient absence, so this suite means the same thing in CI as
 * it does here — the DEF-363 shape this task exists to end is a bare `not.toContain` passing
 * against a rendered login form because the notice never rendered at all.
 *
 * ⭐ Rendering is ruled in for this component specifically: `EmailSignInForm` is pure `'use
 * client'` with no Server Component in its tree, so `renderToStaticMarkup` needs no DOM — unlike
 * `TopBar`/`Sidebar` (`sign-out-control.test.ts:7-13`), which mix Server and Client Components and
 * genuinely cannot render in a plain `node` environment. `filter-row.test.ts` is this project's
 * existing precedent for rendering a real component the same way.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailSignInForm } from '../src/app/sign-in/EmailSignInForm';

vi.mock('../src/app/sign-in/actions', () => ({
  signInWithEmailAction: vi.fn(),
}));

/** `process.env.NODE_ENV` is typed readonly once Next's types are in scope — same accessor
 *  `tests/unit/env.test.ts` uses, for the same reason. */
type MutableEnv = Record<string, string | undefined>;
const E = () => process.env as unknown as MutableEnv;

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = process.env;
  // No NEXT_PUBLIC_FIREBASE_* keys at all — publicEnv() must throw for this suite to test what it
  // says it tests.
  process.env = { NODE_ENV: 'test' } as unknown as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = saved;
});

/**
 * A narrow, EXPLICIT-SET entity decode — not a general HTML decoder. `renderToStaticMarkup`
 * escapes every apostrophe in a text node to `&#x27;` (react-dom's `escapeTextForBrowser`),
 * identically whether the source JSX holds a raw apostrophe, `&apos;` or `&#39;` — so no
 * implementation that renders Contract 3's sentence as ordinary JSX text can ever satisfy an
 * exact match against the raw string, and the fix belongs here, not in the rendered sentence
 * (measured against the real builder output, 2026-09-18). Kept to exactly the entities this
 * file's own strings can contain; a general-purpose decoder here would quietly widen what future
 * text is allowed to match.
 */
function decodeEntities(s: string): string {
  return s.replace(/&#x27;|&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Whitespace-normalised (the formatter wraps the JSX text node across lines) and entity-decoded,
 *  so this can't be "fixed" by weakening it into a substring check or by asserting the escaped
 *  form either. */
function normalize(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

const CORRECTED_HEADING =
  "No sign-in method is available: both email and terminal PIN sign-in need this server's Firebase identity values.";

describe('EmailSignInForm — the unconfigured notice, Contract 3', () => {
  it('⛔⛔ with the three identity values unset: no form renders, and the heading covers both sign-in paths — not just email', () => {
    const html = renderToStaticMarkup(createElement(EmailSignInForm, { next: '/' }));
    // Deny-list decoded too: none of today's phrases contains an apostrophe, but a future one
    // added to this list could, and an un-decoded compare would then silently stop matching.
    const decodedHtml = decodeEntities(html);

    // (a) positive anchor — proves the notice branch actually rendered, not merely "the old
    // sentence happens to be absent from whatever screen this is."
    expect(html).not.toContain('<form');
    expect(html).toContain('border-dashed');

    // (b) exact, whitespace-normalised, entity-decoded match on the full corrected heading.
    const heading = html.match(/<strong[^>]*>([\s\S]*?)<\/strong>/);
    expect(heading).not.toBeNull();
    // Both `!` are safe: `heading` was just asserted non-null above, and the pattern has exactly
    // one capture group with no alternation, so it always participates once the outer match
    // succeeds — there is no optional branch that could leave it undefined.
    const headingText = heading![1]!;
    expect(normalize(headingText)).toBe(CORRECTED_HEADING);

    // (c) deny-list: phrasings that would restrict the outage to email or promise another route
    // still works — including the OLD heading's own restriction, so a freshly-written heading
    // that still names only email cannot go green by accident.
    expect(decodedHtml).not.toContain('unaffected');
    expect(decodedHtml).not.toContain('still works');
    expect(decodedHtml).not.toContain('is not affected');
    expect(decodedHtml).not.toContain('Email sign-in is not configured');
  });

  it('regression guard, not red — unchanged, correct code: in production the raw config error stays hidden behind the admin note', () => {
    E().NODE_ENV = 'production';

    const html = renderToStaticMarkup(createElement(EmailSignInForm, { next: '/' }));

    expect(html).not.toContain('Public Firebase config is incomplete');
    expect(html).toContain('.env.example');
  });
});
