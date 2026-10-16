/**
 * T-380 S6 - R9, the URL door is closed (docs/tasks/380-no-typed-values-in-urls.md S6, X1 / X3).
 * TESTER, not BUILDER. Pages are rendered with `renderToStaticMarkup`, no cookie in the jar.
 *
 *  X1  `/ap?error=Call%200917...` with no cookie -> the HTML holds no banner text. RED before S6 (the page
 *      reads `sp.error` straight off the URL). Mutant: `withFlash` returns the URL params untouched (no strip) -> red.
 *  X3  `/prepaid/<id>?reason=hi` with no cookie -> the reason box is empty. RED before S6. Same mutant.
 *  Controls (green before and after S6): the same params arriving WITH a real signed flash and its `f` token
 *      still render. Mutant: strip everything, flash included -> red.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetJar, seedSearch } from '../helpers/flash-jar';

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  notFound: () => {
    throw new Error('notFound() called unexpectedly');
  },
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));

const ACTOR = { orgId: 'org-1', personId: 'actor-admin-1' };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR),
  requireSession: vi.fn(async () => ({ actor: ACTOR, sessionId: 's1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('../../src/lib/page-access', () => ({
  requirePageAccess: vi.fn(async () => ({ actor: ACTOR, refusal: null })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/PhotoInput', () => ({ PhotoInput: () => null }));
vi.mock('@/components/shell/DetailLayout', () => ({
  DetailLayout: ({ summary, children }: { summary: unknown; children: unknown }) => [summary, children],
}));

vi.mock('../../src/app/ap/lib', async (orig) => {
  const actual = await orig<typeof import('../../src/app/ap/lib')>();
  return { ...actual, listSuppliersWithPosition: async () => [], listInvoices: async () => [], listStores: async () => [] };
});
vi.mock('../../src/app/prepaid/lib', async (orig) => {
  const actual = await orig<typeof import('../../src/app/prepaid/lib')>();
  return {
    ...actual,
    getDetail: async () => ({
      id: 'item-1', orgId: 'org-1', storeId: 'store-1', name: 'Fire insurance 2026', category: 'insurance',
      coverageStartDate: '2026-01-01', coverageMonths: 12, totalCost: '24000.00', status: 'active', needsReview: false,
      sourceExpenseId: null, writtenOffOn: null, writeOffReason: null, notes: null, createdAt: new Date('2026-01-01T00:00:00Z'),
      amortised: '0.00', remaining: '24000.00', monthsPosted: 0, schedule: [],
    }),
  };
});

const SEP = vi.hoisted(() => ({
  preview: vi.fn(async () => ({ error: 'stub preview' })),
  worklistFor: vi.fn(async () => [{ employmentId: 'emp-1', personName: 'Ana Cruz', employmentStatus: 'ended', endedOn: '2026-09-30' }]),
}));
const STORE_A = '11111111-1111-4111-8111-111111111111';
const STORE_B = '22222222-2222-4222-8222-222222222222';
vi.mock('../../src/app/payroll/separations/actions', () => ({ postSeparationAction: async () => undefined, voidSeparationAction: async () => undefined }));
vi.mock('../../src/app/payroll/separations/lib', () => ({
  peso: (n: number) => String(n),
  listStores: async () => [{ id: STORE_A, name: 'Store A' }, { id: STORE_B, name: 'Store B' }],
  payrollStoresFor: async () => [{ id: STORE_A, name: 'Store A' }, { id: STORE_B, name: 'Store B' }],
  cashAccountsFor: async () => [],
  separationsFor: async () => [],
  worklistFor: SEP.worklistFor,
  preview: SEP.preview,
}));

const CRAFTED = 'Call 0917 555 0100 to claim your refund';
let ApPage: typeof import('../../src/app/ap/page').default;
let SeparationsPage: typeof import('../../src/app/payroll/separations/page').default;
let PrepaidItemPage: typeof import('../../src/app/prepaid/[id]/page').default;

beforeAll(async () => {
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:pw@localhost:5435/shareat_dev';
  process.env['SESSION_SECRET'] ??= 'x'.repeat(48);
  process.env['APP_TIMEZONE'] ??= 'Asia/Manila';
  ApPage = (await import('../../src/app/ap/page')).default;
  SeparationsPage = (await import('../../src/app/payroll/separations/page')).default;
  PrepaidItemPage = (await import('../../src/app/prepaid/[id]/page')).default;
}, 30_000);
beforeEach(() => {
  resetJar();
  SEP.preview.mockClear();
  SEP.worklistFor.mockClear();
});

const renderAp = async (sp: Record<string, string>) =>
  renderToStaticMarkup((await ApPage({ searchParams: Promise.resolve(sp) })) as never);
const renderPrepaid = async (sp: Record<string, string>) =>
  renderToStaticMarkup((await PrepaidItemPage({ params: Promise.resolve({ id: 'item-1' }), searchParams: Promise.resolve(sp) })) as never);
const reasonValue = (html: string): string | undefined => /<input\b[^>]*name="reason"[^>]*>/.exec(html)?.[0].match(/value="([^"]*)"/)?.[1];

describe('X1 - /ap shows no banner from a crafted URL', () => {
  it('?error= with no cookie: no banner text', async () => {
    const html = await renderAp({ error: CRAFTED });
    expect(html).not.toContain('0917');
    expect(html).not.toContain('claim your refund');
  });
  it('?ok= and ?warning= with no cookie: no banner text', async () => {
    const html = await renderAp({ ok: 'Payment received', warning: 'Send money to 0917' });
    expect(html).not.toContain('Payment received');
    expect(html).not.toContain('Send money');
  });
  it('an f token with no cookie behind it: still nothing', async () => {
    const html = await renderAp({ error: CRAFTED, f: 'abcdefghijklmnop' });
    expect(html).not.toContain('0917');
  });
  it('control: a real signed flash with its f token still renders its banner', async () => {
    const sp = await seedSearch({ error: 'The invoice was refused for a real reason' });
    const html = await renderAp({ f: sp.f! });
    expect(html).toContain('The invoice was refused for a real reason');
  });
});

describe('X3 - /prepaid/<id> shows no refill from a crafted URL', () => {
  it('?reason=hi with no cookie: the reason box is empty', async () => {
    const html = await renderPrepaid({ reason: 'hi' });
    expect(html).toMatch(/name="reason"/);
    expect(reasonValue(html) ?? '').toBe('');
    expect(html).not.toContain('value="hi"');
  });
  it('?error= with no cookie: no banner text', async () => {
    const html = await renderPrepaid({ error: CRAFTED });
    expect(html).not.toContain('0917');
  });
  it('control: a real signed flash with its f token refills the reason box', async () => {
    const sp = await seedSearch({ reason: 'hi' });
    const html = await renderPrepaid({ f: sp.f! });
    expect(reasonValue(html)).toBe('hi');
  });
});

describe('R2 - GET inputs and nav keys survive the strip (no cookie)', () => {
  const renderSep = async (sp: Record<string, string>) =>
    renderToStaticMarkup((await SeparationsPage({ searchParams: Promise.resolve(sp) })) as never);
  const previewArgs = (): Record<string, unknown> | undefined => (SEP.preview.mock.calls[0] as unknown[] | undefined)?.[2] as Record<string, unknown> | undefined;

  // GET sweep of every page under app/: the ONLY page that carries a KEEP key through a GET form or deep link is
  // payroll/separations (Preview form :131, deep link :116, read :64). Mutant: strip every keep key, no allow-list -> red.
  it('separations Preview with ?separationDate=<not endedOn> and no cookie previews THAT date', async () => {
    const html = await renderSep({ store: STORE_A, employmentId: 'emp-1', separationDate: '2026-10-05' });
    expect(previewArgs()?.separationDate).toBe('2026-10-05');
    expect(html).toMatch(/name="separationDate"[^>]*value="2026-10-05"/);
  });
  it('control: with no separationDate it falls back to the worklist endedOn', async () => {
    await renderSep({ store: STORE_A, employmentId: 'emp-1' });
    expect(previewArgs()?.separationDate).toBe('2026-09-30');
  });
  it('nav key survives: ?store=<uuid> deep link still scopes the page with no cookie', async () => {
    await renderSep({ store: STORE_B, employmentId: 'emp-1' });
    expect(SEP.worklistFor).toHaveBeenCalledWith(ACTOR, STORE_B);
  });
  it('the allow-list is only for GET inputs: a crafted ?error= on separations still shows nothing', async () => {
    const html = await renderSep({ store: STORE_A, error: CRAFTED, separationDate: '2026-10-05' });
    expect(html).not.toContain('0917');
  });
});
