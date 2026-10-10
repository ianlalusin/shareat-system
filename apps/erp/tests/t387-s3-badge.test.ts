/**
 * T-387 S3 — Badge (components/ui/Badge.tsx). ADR-013 Amendment 7: a pill, a dot and a word; never colour alone.
 *
 * API pinned: `Badge({ tone, label })` or `Badge({ status })` (label and tone derived by statusLabel/statusTone).
 * An empty or blank label THROWS (a colour without a word is the failure this component exists to prevent).
 * The dot is `bg-current` (a solid `bg-danger` is forbidden by Guard 9, and `bg-current` follows the tone's text).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge } from '../src/components/ui/Badge';

const tokens = (html: string, which = 0): string[] => {
  const all = [...html.matchAll(/class="([^"]*)"/g)].map((m) => (m[1] ?? '').split(/\s+/).filter(Boolean));
  return all[which] ?? [];
};
const render = (p: Record<string, unknown>) => renderToStaticMarkup(createElement(Badge as never, p as never));

const TONE_CLASSES: Record<string, string[]> = {
  info: ['bg-info-soft', 'text-info'],
  warning: ['bg-warning-soft', 'text-warning-ink'],
  success: ['bg-success-soft', 'text-success'],
  progress: ['bg-progress-soft', 'text-progress'],
  danger: ['bg-danger-surface', 'text-danger'],
  closed: ['bg-closed-soft', 'text-closed'],
};

describe('Badge', () => {
  it.each(Object.keys(TONE_CLASSES))('%s: exact tone classes, pill, the word', (tone) => {
    const html = render({ tone, label: 'Thing' });
    const root = tokens(html, 0);
    expect(root).toContain('rounded-full');
    for (const c of TONE_CLASSES[tone] ?? []) expect(root, c).toContain(c);
    expect(html).toContain('Thing');
  });
  it('warning is never text: `text-warning` (the fill) does not appear, only `text-warning-ink`', () => {
    const root = tokens(render({ tone: 'warning', label: 'Waiting' }), 0);
    expect(root).not.toContain('text-warning');
    expect(root).toContain('text-warning-ink');
  });
  it('danger is never a solid fill: no `bg-danger` or `border-danger` token anywhere in the markup', () => {
    const html = render({ tone: 'danger', label: 'Voided' });
    const all = [...tokens(html, 0), ...tokens(html, 1)];
    expect(all).not.toContain('bg-danger');
    expect(all).not.toContain('border-danger');
  });
  it('has a dot (aria-hidden, rounded-full, bg-current) BEFORE the word, and no role attribute', () => {
    const html = render({ tone: 'success', label: 'Posted' });
    expect(html).not.toMatch(/\brole=/);
    const dot = /<span[^>]*aria-hidden="true"[^>]*class="([^"]*)"|<span[^>]*class="([^"]*)"[^>]*aria-hidden="true"/.exec(html);
    expect(dot).not.toBeNull();
    const cls = (dot?.[1] ?? dot?.[2] ?? '').split(/\s+/);
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('bg-current');
    expect(html.indexOf('aria-hidden')).toBeLessThan(html.indexOf('Posted'));
  });
  it('status shorthand: label and tone come from statusLabel / statusTone', () => {
    expect(render({ status: 'needs_review' })).toContain('Needs review');
    const v = render({ status: 'voided' });
    expect(v).toContain('Voided');
    expect(tokens(v, 0)).toContain('text-danger');
    expect(tokens(render({ status: 'posted' }), 0)).toContain('text-success');
  });
  it('NEGATIVE: never renders a colour without a word. An empty or blank label throws', () => {
    expect(() => render({ tone: 'info', label: '' })).toThrow();
    expect(() => render({ tone: 'info', label: '   ' })).toThrow();
    expect(() => render({ tone: 'info' })).toThrow();
  });
  it('an unmapped status renders the closed tone with a humanised word (never throws; lead ruling)', () => {
    const html = render({ status: 'zz_not_a_status' });
    expect(html).toContain('Zz not a status');
    expect(tokens(html, 0)).toContain('text-closed');
  });
  it('every tone yields exactly its visible word as text content', () => {
    for (const tone of Object.keys(TONE_CLASSES)) {
      const text = render({ tone, label: 'Word' }).replace(/<[^>]*>/g, '').trim();
      expect(text, tone).toBe('Word');
    }
  });
});
