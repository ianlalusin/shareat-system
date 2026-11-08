/**
 * T-544 - channel settlements: one sidebar entry with tabs, and recording a settlement as a page.
 * `docs/tasks/544-channel-settlements-tabs-and-record-page.md`.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { visibleSettlementTabs } from '../src/app/channel-settlements/tabs';

let pathname = '/channel-settlements';
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  usePathname: () => pathname,
}));

const requireSessionMock = vi.fn();
vi.mock('../src/lib/session', () => ({
  requireSession: (...a: unknown[]) => requireSessionMock(...a),
  requireActor: async (...a: unknown[]) => (await requireSessionMock(...a)).actor,
}));
vi.mock('../src/app/channel-settlements/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/app/channel-settlements/lib')>()),
  listChannels: async () => [],
  listWaitingDays: async () => [],
  listRecentSettlements: async () => [],
  listActiveLoans: async () => [],
  listDestinationAccounts: async () => [],
  withOrgPrincipal: async (_orgId: string, fn: (tx: null) => unknown) => fn(null),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const labels = (held: string[]) => visibleSettlementTabs(new Set(held)).map((t) => t.label);

describe('T-544 - which tabs an actor is shown', () => {
  it('everyone gets Overview; Upload files needs upload_settlement_files; Review days needs record_ar_collection [kills: a tab shown to someone the route refuses]', () => {
    expect(labels([])).toEqual(['Overview']);
    expect(labels(['record_ar_collection'])).toEqual(['Overview', 'Review days']);
    expect(labels(['upload_settlement_files'])).toEqual(['Overview', 'Upload files']);
    expect(labels(['upload_settlement_files', 'record_ar_collection'])).toEqual(['Overview', 'Upload files', 'Review days']);
  });

  it('the capability words are the ones ROUTE_CAPABILITY gates the same routes with [kills: tab and route drifting apart]', () => {
    const rc = read('apps/erp/src/lib/route-capability.ts');
    expect(rc).toMatch(/'\/channel-settlements\/upload': 'upload_settlement_files'/);
    expect(rc).toMatch(/'\/channel-settlements\/review': 'record_ar_collection'/);
    expect(rc).not.toMatch(/'\/channel-settlements(\/record)?':/); // the overview and the record page stay open to a signed-in actor
  });
});

describe('T-544 - the tab strip', () => {
  async function strip(path: string, held: string[]) {
    pathname = path;
    const { SettlementTabs } = await import('../src/app/channel-settlements/SettlementTabs');
    return renderToStaticMarkup(createElement(SettlementTabs, { items: visibleSettlementTabs(new Set(held)) }));
  }

  it('renders nothing on the record page [kills: tabs above a task page]', async () => {
    expect(await strip('/channel-settlements/record', ['upload_settlement_files', 'record_ar_collection'])).toBe('');
  });

  it('marks the current tab, including from a nested route, and only that one', async () => {
    const html = await strip('/channel-settlements/review/some-day', ['upload_settlement_files', 'record_ar_collection']);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page"[^>]*>Review days</);
    expect(html).not.toMatch(/Record/);
  });

  it('on the overview, only the Overview tab is current; a hidden tab is not in the markup', async () => {
    const html = await strip('/channel-settlements', []);
    expect(html).toMatch(/aria-current="page"[^>]*>Overview</);
    expect(html).not.toContain('Upload files');
    expect(html).not.toContain('Review days');
  });
});

describe('T-544 - the overview hands recording to the record page', () => {
  beforeEach(() => requireSessionMock.mockResolvedValue({ actor: { orgId: 'org-1', personId: 'p-1' } }));

  let Page: typeof import('../src/app/channel-settlements/page').default;
  // The page pulls in most of the app; the first import is slow on a cold disk.
  beforeAll(async () => {
    Page = (await import('../src/app/channel-settlements/page')).default;
  }, 120_000);

  const overview = (sp: Record<string, string>) => Page({ searchParams: Promise.resolve(sp) });
  const redirectTarget = async (sp: Record<string, string>) => {
    try {
      await overview(sp);
    } catch (e) {
      return String((e as { digest?: string }).digest ?? e);
    }
    return undefined;
  };

  const CHAN = '00000000-0000-4000-8000-0000000000c1';
  const DAY = '00000000-0000-4000-8000-0000000000d9';

  it('?channel=X&day=Y redirects to /record with the same query [kills: an old bookmark or the aging report landing on a page with no form]', async () => {
    const d = await redirectTarget({ channel: CHAN, day: DAY });
    expect(d).toContain('NEXT_REDIRECT');
    expect(d).toContain(`/channel-settlements/record?channel=${CHAN}&day=${DAY}`);
  });

  it('?channel=X alone redirects with just the channel', async () => {
    const d = await redirectTarget({ channel: CHAN });
    expect(d).toContain(`/channel-settlements/record?channel=${CHAN}`);
    expect(d).not.toContain('day=');
  });

  it('the modal is gone: a link-button to /record, and the Settle links go to /record?channel=&day=', () => {
    const src = read('apps/erp/src/app/channel-settlements/page.tsx');
    expect(src).not.toContain('FormModal');
    expect(src).not.toContain('<SettlementForm');
    expect(src).toMatch(/href="\/channel-settlements\/record"[\s\S]{0,260}\+ Record settlement/);
    expect(src).toContain('/channel-settlements/record?channel=${d.channelId}&day=${d.salesDayId}');
    expect(src).not.toContain('#record');
  });

  it('the redirect runs before withFlash, so a waiting flash cookie is not spent on it', () => {
    const src = read('apps/erp/src/app/channel-settlements/page.tsx');
    const at = src.indexOf("redirectWithFlash('/channel-settlements/record'");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf('await withFlash('));
  });
});

describe('T-544 - the sidebar has one settlements entry', () => {
  it('nav.tsx lists only /channel-settlements; the other two are tabs', () => {
    const nav = read('apps/erp/src/components/nav.tsx');
    expect(nav).toContain("href: '/channel-settlements',");
    expect(nav).not.toContain("href: '/channel-settlements/upload'");
    expect(nav).not.toContain("href: '/channel-settlements/review'");
  });
});
