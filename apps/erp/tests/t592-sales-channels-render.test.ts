import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * T-592 S2 - what the /settings/sales-channels page DRAWS for each kind of channel. The page is rendered for real (server component to
 * static markup); only the data reads, the actions and the session are stubbed, so no database is needed. The by-role, by-store proof
 * against a real database is t511-s2b-render.test.ts.
 */
const h = vi.hoisted(() => ({
  channels: [] as unknown[],
  canSet: true,
}));

vi.mock('next/navigation', async () => (await import('./helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../src/lib/session', () => ({ requireActor: vi.fn(), requireSession: vi.fn() }));
vi.mock('../src/lib/page-access', () => ({ requirePageAccess: async () => ({ actor: { personId: 'p1', orgId: 'o1' }, refusal: null }) }));
vi.mock('../src/app/expenses/lib', () => ({ listStores: async () => [{ id: 'store-1', name: 'Lipa', code: 'LIP' }] }));
vi.mock('../src/app/settings/sales-channels/actions', () => {
  const noop = async () => {};
  return { createSalesChannelAction: noop, setPlatformCodeAction: noop, setSalesChannelActiveAction: noop, updateSalesChannelAction: noop };
});
vi.mock('../src/app/settings/sales-channels/lib', () => ({
  channelsForStore: async () => h.channels,
  receivableOptions: async () => [{ code: '1220', name: 'Platform receivables' }],
  moneyAccountNames: async () => new Map<string, string>(),
  canEditPlatformCode: async () => h.canSet,
}));

type Page = (props: never) => Promise<unknown>;
let SalesChannelsPage: Page;
beforeAll(async () => {
  SalesChannelsPage = (await import('../src/app/settings/sales-channels/page')).default as unknown as Page;
}, 120_000);

const channel = (over: Record<string, unknown>) => ({
  id: 'c', name: 'Channel', isActive: true, isRemittedDaily: true, receivableAccountCode: null, wastageTypeMode: 'tracked',
  platform: null, platformStoreCode: null, destinationMoneyAccountId: null, bankHints: [], ...over,
});
const daily = channel({ id: 'c-walk', name: 'Walk-in Lipa' });
const foodpanda = channel({ id: 'c-fp', name: 'Foodpanda Lipa', isRemittedDaily: false, receivableAccountCode: '1220', platform: 'foodpanda', platformStoreCode: 'ABC1' });
const grabNoPlatform = channel({ id: 'c-gr', name: 'Grab Lipa', isRemittedDaily: false, receivableAccountCode: '1220' });

async function render(channels: unknown[], canSet = true) {
  h.channels = channels;
  h.canSet = canSet;
  return renderToStaticMarkup((await SalesChannelsPage({ searchParams: Promise.resolve({ store: 'store-1' }) } as never)) as never);
}
const forms = (html: string) => html.match(/<form\b[\s\S]*?<\/form>/g) ?? [];
const withName = (seg: string, name: string) => new RegExp(`\\sname="${name}"`).test(seg);
const codeForms = (html: string) => forms(html).filter((s) => withName(s, 'code'));

describe('T-592 /settings/sales-channels - the store code is drawn only where it belongs', () => {
  it('a daily channel renders no input named code and no store-code zone', async () => {
    const html = await render([daily]);
    expect(html).toContain('Walk-in Lipa');
    expect(withName(html, 'code')).toBe(false);
    expect(withName(html, 'platform')).toBe(false);
    expect(html).not.toContain('Store code');
  });

  it('a Foodpanda settle-later channel has one box labelled "Foodpanda store code", prefilled, a hidden platform and no select named platform', async () => {
    const html = await render([daily, foodpanda]);
    const cf = codeForms(html);
    expect(cf, 'one store-code form: the daily channel has none').toHaveLength(1);
    expect(cf[0]).toContain('Foodpanda store code');
    expect(cf[0]).toMatch(/<input[^>]*\sname="code"[^>]*\svalue="ABC1"/);
    expect(cf[0]).toContain('<input type="hidden" name="platform" value="foodpanda"');
    expect(new RegExp('<select[^>]*\\sname="platform"').test(html)).toBe(false);
    expect(html, 'the saved code is no longer shown twice: the band has the form, not the summary').not.toContain('Store code: ABC1');
  });

  it('a settle-later channel with no platform shows two radio rows plus the box, no select, no "None"', async () => {
    const html = await render([grabNoPlatform]);
    const cf = codeForms(html);
    expect(cf).toHaveLength(1);
    const radios = cf[0]!.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios.map((r) => /\svalue="([^"]*)"/.exec(r)?.[1]).sort()).toEqual(['foodpanda', 'grab']);
    expect(cf[0]).not.toContain('<select');
    expect(cf[0]).not.toContain('None');
    expect(html).toContain('Not set — payout files cannot be matched to this channel until it is.');
  });

  it('a non-admin sees the saved code read-only and no store-code form', async () => {
    const html = await render([foodpanda, grabNoPlatform], false);
    expect(html).toContain('Store code: ABC1');
    expect(codeForms(html)).toHaveLength(0);
    expect(withName(html, 'platform')).toBe(false);
  });

  it('the page has no settlement wiring or bank-names inputs and no statement-matching section (T-592 R4)', async () => {
    const html = await render([daily, foodpanda, grabNoPlatform]);
    for (const n of ['storeKey', 'matchLabels', 'fileHints', 'bankHints', 'wastageEmailIngestEnabled']) expect(withName(html, n), n).toBe(false);
    expect(html).not.toContain('<details');
    expect(html).not.toContain('Statement matching');
    expect(html).not.toContain('Settlement wiring');
  });
});
