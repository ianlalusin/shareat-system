import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Page } from '../src/components/shell/Page';
import { MetricStrip } from '../src/components/dashboard/MetricStrip';
import Loading from '../src/app/loading';

const root = join(import.meta.dirname, '..', 'src');
function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? pages(join(dir, e.name)) : e.name === 'page.tsx' ? [join(dir, e.name)] : []);
}

describe('T-448 responsive dashboards and record details', () => {
  it('shows a neutral loading state without inventing balances or record data', () => {
    const html = renderToStaticMarkup(h(Loading));
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading page');
    expect(html).not.toMatch(/₱|0\.00/);
  });
  it('marks a detail page without adding a second main or changing content order', () => {
    const html = renderToStaticMarkup(h(Page, { density: 'table', view: 'detail', children: [h('h1', { key: 'h' }, 'Loan'), h('p', { key: 'p' }, '9,999,999.99')] }));
    expect(html).toContain('data-view="detail"');
    expect(html).not.toContain('<main');
    expect(html.indexOf('Loan')).toBeLessThan(html.indexOf('9,999,999.99'));
    expect(html).not.toMatch(/truncate|aria-hidden/);
  });
  it('keeps every metric in server output and exposes named keyboard scrolling', () => {
    const html = renderToStaticMarkup(h(MetricStrip, { label: 'Financial position', children: [h('a', { href: '/reports/ar-aging', key: 1 }, 'AR 9,999,999.99'), h('a', { href: '/reports/ap-aging', key: 2 }, 'AP 0.01')] }));
    expect(html).toContain('aria-label="Financial position"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('AR 9,999,999.99');
    expect(html).toContain('AP 0.01');
    expect(html).not.toMatch(/aria-hidden|truncate/);
  });
  it('covers the dashboard and every entity detail, excluding the weekly report drilldown', () => {
    expect(readFileSync(join(root, 'app/page.tsx'), 'utf8')).toContain('view="dashboard"');
    const details = pages(join(root, 'app')).filter((p) => /\[[^/\\]+\][\\/]page\.tsx$/.test(p) && !p.includes(`${join('reports', 'dual-run')}`));
    expect(details.length).toBe(26);
    for (const p of details) {
      const src = readFileSync(p, 'utf8');
      expect(src, p).toContain('view="detail"');
      if (!/<DetailLayout|<SplitWorkspace/.test(src)) expect(src, p).toContain('sectioned');
    }
  });
  it('uses mobile metric snapping and keeps financial text unclipped', () => {
    const css = readFileSync(join(root, 'app/globals.css'), 'utf8');
    expect(css).toMatch(/\.erp-metric-strip[\s\S]*?scroll-snap-type:\s*x proximity/);
    expect(css).toMatch(/\.erp-metric-strip[\s\S]*?overflow-x:\s*auto/);
    expect(css).toMatch(/\.erp-detail-layout[\s\S]*?min-width:\s*0/);
    expect(css).toMatch(/@media \(min-width: 768px\) and \(max-width: 1023px\)[\s\S]*?min-height:\s*44px/);
  });
  it('sizes chart containers fluidly and wraps the channel legend without clipping money', () => {
    const sales = readFileSync(join(root, 'components/dashboard/SalesLine.tsx'), 'utf8');
    const channel = readFileSync(join(root, 'components/dashboard/ChannelDonut.tsx'), 'utf8');
    expect(sales).not.toMatch(/h-\[(300|360)px\]/);
    expect(channel).not.toMatch(/(?:h|w)-\[200px\]|min-w-\[180px\]/);
    expect(channel).toContain('erp-channel-legend');
  });
});
