import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-380 S4 - W-C3 / DEF-604 (docs/tasks/380-no-typed-values-in-urls.md C3, R8) and the sales-days `returnTo` (R6, REV-9).
 * TESTER, not BUILDER. Harness from `t375-s6-reconciliation-web.test.ts` (real Postgres and domain; POS bridge stubbed).
 *
 *  W-C3  A POS recheck refused from `/reports/pos-reconciliation?store&date` comes back to that page, and the page SHOWS the
 *        refusal sentence. The page is rendered from the redirect's own query string plus the jar, i.e. what a browser would do.
 *        RED on HEAD: the page reads only `store`/`date` and renders no banner. (After S4 the sentence is in the flash, the
 *        page reads it through `withFlash`.) Mutant: drop the new banner markup -> red.
 *  RT-1  `returnTo` = the reconciliation page with extra keys (`x=hi`): the path and the `store`/`date` nav survive, `x` does not.
 *        RED on HEAD (the whole string is kept). Mutant: pass `returnTo` through unchecked -> red.
 *  RT-2  a hostile `returnTo` (off-site, `//`, control characters) -> the day's own page `/sales-days/<id>`, never off-site.
 *        Green on HEAD (the `startsWith` check already falls back) apart from the sentence riding in `?error=`: asserted too.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({
    actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@shareat/core/env', async (orig) => {
  const real = await orig<typeof import('@shareat/core/env')>();
  return { ...real, env: () => ({ ...real.env(), POS_API_URL: 'https://pos.example.test', POS_API_KEY: 'test-key' }) };
});

import { POS_V1_FEED_PATHS } from '@shareat/db';
import { verifySalesDay } from '../../../../packages/domain/src/sales-days/verify';
import { posV1SalesBody, posV1SoldItemsBody } from '../../../../packages/db/src/pos-v1/fixtures';
import { D1_FIGURES, D1_SOLD_ITEMS, importTestDay } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { asOrgOn, DAY, s6Fixture, type S6F } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import * as actions from '../../src/app/sales-days/actions';
import PosReconciliationPage from '../../src/app/reports/pos-reconciliation/page';
import { captureRedirect, currentJar, outcomeOf, resetJar } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const u = new URL(String(input));
    const sold = u.pathname.endsWith(POS_V1_FEED_PATHS.sold_items);
    return new Response(JSON.stringify(sold ? posV1SoldItemsBody(D1_SOLD_ITEMS) : posV1SalesBody(D1_FIGURES)), { status: 200 });
  }));
  resetJar();
  return () => vi.unstubAllGlobals();
});

const recheck = (actions as unknown as { recheckPosDayAction: (fd: FormData) => Promise<void> }).recheckPosDayAction;
const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const text = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/\s+/g, ' ');
const decoded = (raw: string): string => decodeURIComponent(raw.replace(/\+/g, ' '));

async function dayFixture(hint: string): Promise<{ f: S6F; dayId: string }> {
  const f = await s6Fixture(sql, hint);
  const { id } = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: DAY }));
  await asOrgOn(f.orgId, (tx) => verifySalesDay(tx, f.manager, id));
  return { f, dayId: id };
}

async function runAs(who: { personId: string; orgId: string }, fd: FormData) {
  h.actor = who;
  const signal = await captureRedirect(() => recheck(fd));
  return { raw: signal.url, out: outcomeOf(signal) };
}

describe('W-C3 / DEF-604 - a refused POS recheck is shown on the reconciliation page', () => {
  it('W-C3: the refusal sentence is not in the address; store and date are', async () => {
    const { f, dayId } = await dayFixture('wc3');
    const returnTo = `/reports/pos-reconciliation?store=${f.storeId}&date=${DAY}`;
    // A person who may not verify a sales day: the domain refuses the recheck with a sentence.
    const { raw, out } = await runAs(f.plainStaff, form({ salesDayId: dayId, returnTo }));
    expect(out.path, 'back on the reconciliation page').toBe('/reports/pos-reconciliation');
    expect(out.nav.get('store')).toBe(f.storeId);
    expect(out.nav.get('date')).toBe(DAY);
    const sentence = out.flash.error;
    expect(sentence, 'the refusal exists (fixture check)').toBeTruthy();
    expect(decoded(raw), `the sentence is not in the address (saw: ${raw})`).not.toContain(sentence!);
  });

  it('DEF-604: the page the redirect lands on SHOWS the refusal sentence (rendered from the redirect query + jar)', async () => {
    const { f, dayId } = await dayFixture('wc3b');
    const returnTo = `/reports/pos-reconciliation?store=${f.storeId}&date=${DAY}`;
    const { raw, out } = await runAs(f.plainStaff, form({ salesDayId: dayId, returnTo }));
    const sentence = out.flash.error;
    expect(sentence, 'the refusal exists (fixture check)').toBeTruthy();
    // What the browser does next: GET the redirect target, with the jar holding the flash cookie.
    h.actor = f.admin;
    const sp = Object.fromEntries(new URL(raw, 'http://flash.test').searchParams);
    const page = text(renderToStaticMarkup(await PosReconciliationPage({ searchParams: Promise.resolve(sp) })));
    expect(page, 'the page shows the refusal').toContain(sentence!);
  });

  it('control: a page reached with no flash shows no banner', async () => {
    const { f } = await dayFixture('wc3c');
    h.actor = f.admin;
    const page = text(renderToStaticMarkup(await PosReconciliationPage({ searchParams: Promise.resolve({ store: f.storeId, date: DAY }) })));
    expect(page).not.toMatch(/could not|not allowed|may not/i);
    expect(currentJar().sets).toHaveLength(0);
  });
});

describe('RT - recheckPosDayAction returnTo', () => {
  it('RT-1: the reconciliation page keeps store and date and drops any other key', async () => {
    const { f, dayId } = await dayFixture('rt1');
    const { raw, out } = await runAs(f.plainStaff, form({ salesDayId: dayId, returnTo: `/reports/pos-reconciliation?store=${f.storeId}&date=${DAY}&x=hi` }));
    expect(out.path).toBe('/reports/pos-reconciliation');
    expect([...out.nav.keys()].sort()).toEqual(['date', 'store']);
    expect(decoded(raw)).not.toMatch(/x=hi|error=/);
  });

  it.each([
    ['off-site', 'https://evil.example/reports/pos-reconciliation?store=1'],
    ['protocol-relative', '//evil.example'],
    ['newline', '/reports/pos-reconciliation?store=1\nSet-Cookie: a=b'],
    ['backslash', '/\\evil.example'],
  ])('RT-2: %s returnTo goes to the day page', async (_n, hostile) => {
    const { f, dayId } = await dayFixture('rt2');
    const { raw, out } = await runAs(f.plainStaff, form({ salesDayId: dayId, returnTo: hostile }));
    expect(raw).toMatch(/^\/(?![/\\])/);
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(out.path).toBe(`/sales-days/${dayId}`);
    expect(decoded(raw), `the sentence is not in the address (saw: ${raw})`).not.toMatch(/error=/);
  });
});
