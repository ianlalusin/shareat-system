/**
 * T-387 S3 — Banner and FlashBanner (components/ui/Banner.tsx, components/ui/FlashBanner.tsx).
 *
 * API pinned:
 *   Banner({ tone: 'error'|'warning'|'success'|'info', children, fieldId?, fieldLabel? })
 *     role="alert" for error, role="status" for the rest; an inline aria-hidden svg per tone (4 different svgs);
 *     the "Go to <fieldLabel>" anchor renders only when BOTH fieldId and fieldLabel are given.
 *   FlashBanner({ flash }): error -> Banner error, warning -> Banner warning, notice -> Banner info; `ok` is NOT
 *     rendered (the Toaster shows it, S4). Order: error, warning, notice. Nothing set -> empty markup.
 *     It imports the Flash type with `import type` only (the flash module pulls next/headers).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Banner } from '../src/components/ui/Banner';
import { FlashBanner } from '../src/components/ui/FlashBanner';

const rootTokens = (html: string): string[] => ((/class="([^"]*)"/.exec(html)?.[1]) ?? '').split(/\s+/).filter(Boolean);
const banner = (p: Record<string, unknown>, text = 'Message') =>
  renderToStaticMarkup(createElement(Banner as never, p as never, text));
const flashHtml = (flash: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(FlashBanner as never, { flash } as never));

const TONES: Record<string, { role: string; classes: string[] }> = {
  error: { role: 'alert', classes: ['bg-danger-surface', 'text-danger'] },
  warning: { role: 'status', classes: ['bg-warning-soft', 'text-warning-ink'] },
  success: { role: 'status', classes: ['bg-success-soft', 'text-success'] },
  info: { role: 'status', classes: ['bg-info-soft', 'text-info'] },
};

describe('Banner', () => {
  it.each(Object.keys(TONES))('%s: the right role, token classes, an inline svg icon, the message', (tone) => {
    const html = banner({ tone });
    expect(html).toContain(`role="${TONES[tone]?.role}"`);
    for (const c of TONES[tone]?.classes ?? []) expect(rootTokens(html), c).toContain(c);
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain('Message');
  });
  it('only error is role="alert"; the other three are never alert', () => {
    for (const tone of ['warning', 'success', 'info']) expect(banner({ tone })).not.toContain('role="alert"');
    expect(banner({ tone: 'error' })).not.toContain('role="status"');
  });
  it('each tone has its own icon: four different svgs', () => {
    const svgs = Object.keys(TONES).map((t) => /<svg[\s\S]*?<\/svg>/.exec(banner({ tone: t }))?.[0] ?? '');
    for (const s of svgs) expect(s.length).toBeGreaterThan(0);
    expect(new Set(svgs).size).toBe(4);
  });
  it('warning text is the ink, never `text-warning`; no solid `bg-danger`', () => {
    expect(rootTokens(banner({ tone: 'warning' }))).not.toContain('text-warning');
    expect(rootTokens(banner({ tone: 'error' }))).not.toContain('bg-danger');
  });
  it('no raw hex and no stock hue in the markup (tokens only)', () => {
    for (const tone of Object.keys(TONES)) {
      const html = banner({ tone });
      expect(html, tone).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html, tone).not.toMatch(/\b(?:red|green|blue|amber|yellow|orange|slate|gray|zinc|neutral)-\d{2,3}\b/);
    }
  });
  it('fieldId + fieldLabel renders <a href="#fieldId">Go to <label></a>', () => {
    const html = banner({ tone: 'error', fieldId: 'amount', fieldLabel: 'Amount' });
    expect(html).toMatch(/<a [^>]*href="#amount"[^>]*>Go to Amount<\/a>/);
  });
  it('NEGATIVE: no anchor without a fieldId, and none with a fieldId but no label', () => {
    expect(banner({ tone: 'error' })).not.toContain('<a ');
    expect(banner({ tone: 'error', fieldId: 'amount' })).not.toContain('<a ');
  });
  it('the field label is escaped', () => {
    const html = banner({ tone: 'error', fieldId: 'x', fieldLabel: '<b>Amt</b>' });
    expect(html).not.toContain('<b>Amt</b>');
    expect(html).toContain('&lt;b&gt;Amt&lt;/b&gt;');
  });
});

describe('FlashBanner', () => {
  it('error becomes an error Banner (role=alert) carrying the text', () => {
    const html = flashHtml({ error: 'Amount is required' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Amount is required');
  });
  it('warning becomes a warning Banner and notice an info Banner (both role=status)', () => {
    const w = flashHtml({ warning: 'Heads up' });
    expect(w).toContain('role="status"');
    expect(rootTokens(w)).toContain('bg-warning-soft');
    const n = flashHtml({ notice: 'FYI' });
    expect(n).toContain('role="status"');
    expect(rootTokens(n)).toContain('bg-info-soft');
  });
  it('NEGATIVE: `ok` is NOT rendered (the Toaster shows it)', () => {
    const html = flashHtml({ ok: 'Saved the expense' });
    expect(html).not.toContain('Saved the expense');
    expect(html.replace(/<!--.*?-->/g, '').trim()).toBe('');
  });
  it('an empty flash renders nothing', () => {
    expect(flashHtml({}).trim()).toBe('');
  });
  it('error, warning and notice together render three banners, in that order; ok beside them is still absent', () => {
    const html = flashHtml({ notice: 'N-text', ok: 'OK-text', warning: 'W-text', error: 'E-text' });
    expect([...html.matchAll(/role="(?:alert|status)"/g)]).toHaveLength(3);
    expect(html.indexOf('E-text')).toBeLessThan(html.indexOf('W-text'));
    expect(html.indexOf('W-text')).toBeLessThan(html.indexOf('N-text'));
    expect(html).not.toContain('OK-text');
  });
  it('flash text is escaped', () => {
    expect(flashHtml({ error: '<script>x</script>' })).not.toContain('<script>');
  });
});
