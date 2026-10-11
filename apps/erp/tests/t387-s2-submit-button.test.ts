/**
 * T-387 S2 — SubmitButton (docs/tasks/387-warm-theme-and-grill-night-dark.md "### S2").
 *
 * SubmitButton reads `useFormStatus()`. ⚠️ Vitest loads the workspace's react-dom 18.3.1, which has
 * no such hook; the App Router runs Next's bundled React 19 canary, which does (see the component's
 * header). So the hook is mocked here, and the mock is CONTROLLABLE: the tests render both the idle
 * and the pending state through the real component, not just the pure helper.
 *
 * `.ts`, not `.tsx` (vitest unit include glob is `*.test.ts`); `createElement` + `renderToStaticMarkup`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const formStatus = vi.hoisted(() => ({ pending: false }));
vi.mock('react-dom', async (orig) => ({
  ...(await orig<typeof import('react-dom')>()),
  useFormStatus: () => ({ pending: formStatus.pending, data: null, method: null, action: null }),
}));
import { submitButtonState } from '../src/components/feedback/submit-button-state';
import { SubmitButton } from '../src/components/feedback/SubmitButton';

const ERP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEEDBACK_SRC = path.join(ERP, 'src/components/feedback/SubmitButton.tsx');
const UI_SRC = path.join(ERP, 'src/components/ui/SubmitButton.tsx');

function classTokens(html: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) for (const t of (m[1] ?? '').split(/\s+/)) if (t) tokens.add(t);
  return tokens;
}

describe('submitButtonState — pure label/ARIA logic (API: { pending, label, pendingLabel? } -> { label, ariaBusy, disabled })', () => {
  it('not pending: the label as given, not busy, not disabled', () => {
    expect(submitButtonState({ pending: false, label: 'Save' })).toEqual({ label: 'Save', ariaBusy: false, disabled: false });
  });

  it('pending: the default pendingLabel is "Saving…" (U+2026), busy and disabled', () => {
    expect(submitButtonState({ pending: true, label: 'Save' })).toEqual({ label: 'Saving…', ariaBusy: true, disabled: true });
  });

  it('pending with a custom pendingLabel uses it; not pending ignores it', () => {
    expect(submitButtonState({ pending: true, label: 'Post', pendingLabel: 'Posting…' }).label).toBe('Posting…');
    expect(submitButtonState({ pending: false, label: 'Post', pendingLabel: 'Posting…' }).label).toBe('Post');
  });

  it('mutation control: the two states differ in all three fields (an always-idle or always-busy impl cannot pass)', () => {
    const idle = submitButtonState({ pending: false, label: 'Save' });
    const busy = submitButtonState({ pending: true, label: 'Save' });
    expect(idle.label).not.toBe(busy.label);
    expect(idle.ariaBusy).not.toBe(busy.ariaBusy);
    expect(idle.disabled).not.toBe(busy.disabled);
  });
});

describe('<SubmitButton> SSR (outside any form, not pending)', () => {
  const html = renderToStaticMarkup(createElement(SubmitButton, { children: 'Save' }));

  it('shows its label, is not aria-busy="true", is not disabled', () => {
    expect(html).toContain('Save');
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Saving…');
  });

  it('is a submit button rendered through the kit Button: primary classes, rounded-[12px], min-h-11, no rounded-full', () => {
    expect(html).toMatch(/type="submit"/);
    const t = classTokens(html);
    for (const need of ['bg-brand', 'text-white', 'hover:bg-brand-hover', 'rounded-[12px]', 'min-h-11', 'font-semibold']) {
      expect(t.has(need), need).toBe(true);
    }
    expect(t.has('rounded-full')).toBe(false);
    expect(html).not.toContain('<svg'); // spinner only while pending
  });
});

describe('placement and mechanism guards', () => {
  it('SubmitButton.tsx lives in components/feedback (may be a client component), NOT components/ui (Guard 9/10 keep ui server-safe)', () => {
    expect(existsSync(FEEDBACK_SRC)).toBe(true);
    expect(existsSync(UI_SRC)).toBe(false);
  });

  it("SubmitButton.tsx is a client component ('use client' first statement) and wraps the kit Button from the ui barrel or file", () => {
    const src = readFileSync(FEEDBACK_SRC, 'utf8');
    expect(src.trimStart().startsWith("'use client'") || src.trimStart().startsWith('"use client"') || /^\s*\/\*[\s\S]*?\*\/\s*['"]use client['"]/.test(src)).toBe(true);
    expect(src).toMatch(/from\s+['"](@\/components\/ui(\/Button)?|\.\.\/ui(\/Button)?)['"]/);
    expect(src).toMatch(/submit-button-state/);
  });

  it('drives pending from useFormStatus (React owns the action lifecycle; no submit listener to get stuck)', () => {
    const src = readFileSync(FEEDBACK_SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).toMatch(/import \{ useFormStatus \} from 'react-dom'/);
    expect(src).toMatch(/const \{ pending \} = useFormStatus\(\)/);
    expect(src).not.toMatch(/addEventListener\('submit'/);
  });
});

describe('<SubmitButton> while its action is pending (useFormStatus mocked pending)', () => {
  it('is disabled, aria-busy="true", shows the spinner and the pending label', () => {
    formStatus.pending = true;
    try {
      const html = renderToStaticMarkup(createElement(SubmitButton, { children: 'Post', pendingLabel: 'Posting…' }));
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('disabled=""');
      expect(html).toContain('<svg');
      expect(html).toContain('Posting…');
      expect(html).not.toContain('>Post<');
    } finally {
      formStatus.pending = false;
    }
  });
});

describe('<SubmitButton variant> — a repeated Save is secondary, not a second red primary (Ian, 2026-10-11)', () => {
  it('defaults to primary', () => {
    const t = classTokens(renderToStaticMarkup(createElement(SubmitButton, { children: 'Save' })));
    expect(t.has('bg-brand')).toBe(true);
  });
  it('variant="secondary" renders the kit secondary and keeps the pending behaviour', () => {
    const idle = classTokens(renderToStaticMarkup(createElement(SubmitButton, { children: 'Save', variant: 'secondary' })));
    expect(idle.has('bg-brand')).toBe(false);
    expect(idle.has('bg-surface')).toBe(true);
    formStatus.pending = true;
    try {
      const busy = renderToStaticMarkup(createElement(SubmitButton, { children: 'Save', variant: 'secondary' }));
      expect(busy).toContain('aria-busy="true"');
      expect(busy).toContain('Saving…');
    } finally {
      formStatus.pending = false;
    }
  });
});

describe('budgets: one Save per category is secondary (no second red primary per view)', () => {
  it('the per-category SubmitButton passes variant="secondary"', () => {
    const src = readFileSync(path.join(ERP, 'src/app/budgets/page.tsx'), 'utf8');
    expect(src).toMatch(/<SubmitButton[^>]*variant="secondary"/);
  });
});
