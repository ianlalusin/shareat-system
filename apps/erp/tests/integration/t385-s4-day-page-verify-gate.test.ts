import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-385 S4 - the day page shows "Verify & post" only on a SUBMITTED day. `docs/tasks/385-verify-only-after-submit.md` S4
 * tests P1-P4 (Ian 2026-10-09: "verify and post must be blocked until submitted"). The domain refusal (S1) and the
 * trigger (S2) are tested elsewhere; this is the screen, plus the forged-POST path through the real server action.
 *
 * TESTER, not BUILDER. Real Postgres and the REAL domain underneath; only the session, Next's navigation helpers and the
 * `Page` shell are doubled (the T-375 S4 day-page test's pattern).
 *
 * ## State at HEAD (red first)
 *  - P1 RED: the page offers "Verify & post" on an open day, and the Submit card has no "Verify & post comes after this"
 *    line. Mutant: the condition back to `open || submitted` -> red.
 *  - P3 RED: the Verify form has no `can.verify` probe, so a staff member who may not verify still sees it. Mutant: drop
 *    `can.verify` -> red.
 *  - P2 (control) passes today. P4 is RED: the forged POST on an open day verifies it instead of flashing the sentence.
 *
 * ## Pinned where the spec is silent
 *  - "no Verify form" is pinned by the visible heading/button text "Verify & post" being absent (a server-action `action`
 *    prop does not serialise into static markup), plus the stronger P4 for the action itself.
 *  - the R4a line is asserted verbatim: "Verify & post comes after this, on the submitted day."
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

class Redirected extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT ${target}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new Redirected(target);
  },
  notFound: () => {
    throw new Error('notFound() called - fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({
    actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { submitSalesDay } from '../../../../packages/domain/src/sales-days/verify';
import { s6Fixture, asOrgOn } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { mkTypedDay } from '../../../../packages/domain/tests/integration/_fixtures/sales-day-flow';
import SalesDayDetailPage from '../../src/app/sales-days/[id]/page';
import { verifySalesDayAction } from '../../src/app/sales-days/actions';
import { urlOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const NOT_SUBMITTED = "This sales day hasn't been submitted yet. Submit it first; it can be verified and posted after that.";
const COMES_AFTER = 'Verify & post comes after this, on the submitted day.';

/** React escapes quotes and ampersands; the sentences are asserted as a person reads them. */
const text = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

async function setup(hint: string) {
  const f = await s6Fixture(sql, `t385s4-${hint}`);
  const typed = await mkTypedDay(sql, f, [f.managerId, f.adminId, f.plainStaffId]);
  return { f, dayId: typed.id, storeId: typed.storeId };
}
async function render(f: { orgId: string }, as: { personId: string; orgId: string }, id: string, storeId: string): Promise<string> {
  h.actor = as;
  const el = await SalesDayDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ store: storeId }) });
  return text(renderToStaticMarkup(el as never));
}
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from sales_days where id = ${id}`)[0]!.status;

describe('T-385 S4 - the day page offers Verify & post only on a submitted day', () => {
  it('P1: an OPEN day, as a manager: the Submit card with the "comes after" line, and NO Verify & post', async () => {
    const { f, dayId, storeId } = await setup('p1');
    const html = await render(f, f.manager, dayId, storeId);
    expect(html, 'the Submit card is there').toContain('<h2 class="font-medium">Submit</h2>');
    expect(html, 'the one explanatory line under the Submit text').toContain(COMES_AFTER);
    // the line itself mentions "Verify & post", so strip it before asserting the heading and button are gone
    const withoutLine = html.replace(COMES_AFTER, '');
    expect(withoutLine, 'no Verify & post heading or button on an open day').not.toContain('Verify & post');
  });

  it('P2: a SUBMITTED day, as a manager: the Verify & post card is present (control), and the open-day line is not', async () => {
    const { f, dayId, storeId } = await setup('p2');
    await asOrgOn(f.orgId, (tx) => submitSalesDay(tx, f.admin, dayId));
    const html = await render(f, f.manager, dayId, storeId);
    expect(html).toContain('<h2 class="font-medium">Verify & post</h2>');
    expect(html).not.toContain(COMES_AFTER);
  });

  it('P3: a SUBMITTED day, as staff WITHOUT verify_sales_day: no Verify & post', async () => {
    const { f, dayId, storeId } = await setup('p3');
    await asOrgOn(f.orgId, (tx) => submitSalesDay(tx, f.admin, dayId));
    const html = await render(f, f.plainStaff, dayId, storeId);
    expect(html).not.toContain('Verify & post');
  });

  it('P4: a forged verifySalesDayAction on an OPEN day redirects with the refusal sentence in the flash; the day stays open', async () => {
    const { f, dayId } = await setup('p4');
    h.actor = f.manager;
    const fd = new FormData();
    fd.set('salesDayId', dayId);
    const err = await Promise.resolve()
      .then(() => verifySalesDayAction(fd))
      .then(() => null, (e) => e);
    expect(err, 'the action ends by redirecting').toBeInstanceOf(Redirected);
    const to = urlOf((err as Redirected).target);
    expect(to.pathname).toBe(`/sales-days/${dayId}`);
    expect(to.searchParams.get('error')).toBe(NOT_SUBMITTED);
    expect(await statusOf(dayId)).toBe('open');
  });
});
