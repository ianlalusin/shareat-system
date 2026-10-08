import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-375 S6, W2 - the Corrections section of the sales-day page and `postPosCorrectionAction`.
 * `docs/tasks/375-pos-v1-day-feed.md` S6 ("day page: a Corrections section ... Post correction").
 *
 * TESTER, not BUILDER. Real Postgres and the REAL domain; the session, navigation helpers and `Page` shell are doubled
 * (the S4 day-page test's pattern). Red on HEAD: no Corrections section, no `postPosCorrectionAction`.
 *
 * Pinned (coordinator): `postPosCorrectionAction(formData)` in `apps/erp/src/app/sales-days/actions.ts` reads
 * `salesDayId`, `feedId`, `entryDate`, `reason`, always ends in a redirect (a refusal carries `?error=`). The section is
 * an `<h2>Corrections</h2>`; the control is the text "Post correction", shown only to someone holding
 * verify_sales_day and only while the day has a drift; after posting, the section lists the correction (its reason).
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

import { importTestDay } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { asOrgOn, DAY, insertSalesRecheck, R1_FIGURES, s6Fixture, type S6F } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { submitThenVerify } from '../../../../packages/domain/tests/integration/_fixtures/sales-day-flow';
import * as actions from '../../src/app/sales-days/actions';
import SalesDayDetailPage from '../../src/app/sales-days/[id]/page';
import { urlOf } from '../helpers/flash-jar';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

const text = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
const CORRECTIONS_H2 = /<h2[^>]*>Corrections<\/h2>/;
const REASON = 'POS voided a cash receipt';

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
async function run(as: { personId: string; orgId: string }, fd: FormData): Promise<URL> {
  h.actor = as;
  const action = (actions as unknown as Record<string, unknown>).postPosCorrectionAction;
  expect(typeof action, 'postPosCorrectionAction must exist').toBe('function');
  const err = await Promise.resolve()
    .then(() => (action as (fd: FormData) => Promise<void>)(fd))
    .then(() => null, (e) => e);
  expect(err, 'the action ends by redirecting').toBeInstanceOf(Redirected);
  return urlOf((err as Redirected).target);
}
const renderDay = async (who: { personId: string; orgId: string }, f: S6F, id: string): Promise<string> => {
  h.actor = who;
  const el = await SalesDayDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ store: f.storeId }) });
  return text(renderToStaticMarkup(el as never));
};

async function setup(hint: string, o: { drift?: boolean } = {}) {
  const f = await s6Fixture(sql, hint);
  const { id: dayId } = await asOrgOn(f.orgId, (tx) => importTestDay(tx, f.manager, { storeId: f.storeId, businessDate: DAY }));
  await asOrgOn(f.orgId, (tx) => submitThenVerify(tx, f.manager, dayId, f.admin));
  let feedId = '';
  if (o.drift !== false) {
    feedId = (
      await asOrgOn(f.orgId, (tx) =>
        insertSalesRecheck(tx, { orgId: f.orgId, storeId: f.storeId, businessDate: DAY, posStoreId: f.posStoreId, fetchedBy: f.managerId, figures: R1_FIGURES }),
      )
    ).ids.sales!;
  }
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Staffer') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${f.orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${f.storeId})`;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${f.orgId}, ${f.storeId}, ${p!.id}, ${`SE-${Date.now()}`}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId: f.orgId, storeId: f.storeId, employmentId: emp!.id, personId: p!.id, setBy: f.managerId });
  return { f, dayId, feedId, staff: { personId: p!.id, orgId: f.orgId } };
}
const corrections = (dayId: string) =>
  sql<{ id: string; journal_entry_id: string; reason: string }[]>`select id, journal_entry_id, reason from sales_day_pos_corrections where sales_day_id = ${dayId}`;

describe('W2 - the Corrections section and Post correction', () => {
  it('a manager sees the section and Post correction on a drifted verified day; a staff sees no Post correction; control: a day with no drift offers none', async () => {
    const { f, dayId, staff } = await setup('w2a');
    const mgr = await renderDay(f.manager, f, dayId);
    expect(mgr, 'a Corrections section').toMatch(CORRECTIONS_H2);
    expect(mgr).toContain('Post correction');
    const st = await renderDay(staff, f, dayId);
    expect(st, 'staff cannot post a correction').not.toContain('Post correction');

    const calm = await setup('w2b', { drift: false });
    expect(await renderDay(calm.f.manager, calm.f, calm.dayId), 'no drift, nothing to post').not.toContain('Post correction');
  });

  it('the manager submits the action: the correction row and its entry (Dr 4100 50.00 / Cr 1110 50.00) exist, it redirects without an error, and the section then lists the correction', async () => {
    const { f, dayId, feedId } = await setup('w2c');
    const to = await run(f.manager, form({ salesDayId: dayId, feedId, entryDate: '2027-01-20', reason: REASON }));
    expect(to.searchParams.get('error')).toBeNull();

    const rows = await corrections(dayId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe(REASON);
    const lines = await sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, jl.debit, jl.credit from journal_lines jl join accounts a on a.id = jl.account_id where jl.entry_id = ${rows[0]!.journal_entry_id}`;
    expect(lines.map((l) => (Number(l.debit) > 0 ? `Dr ${l.code} ${Number(l.debit).toFixed(2)}` : `Cr ${l.code} ${Number(l.credit).toFixed(2)}`)).sort()).toEqual([
      'Cr 1110 50.00', 'Dr 4100 50.00',
    ]);

    const html = await renderDay(f.manager, f, dayId);
    expect(html).toMatch(CORRECTIONS_H2);
    expect(html, 'the section lists the correction').toContain(REASON);
  });

  it('a staff submitting the action is refused (a redirect with an error) and nothing is posted', async () => {
    const { dayId, feedId, staff } = await setup('w2d');
    const to = await run(staff, form({ salesDayId: dayId, feedId, entryDate: '2027-01-20', reason: REASON }));
    expect(to.searchParams.get('error'), 'a sentence, not silence').toBeTruthy();
    expect(await corrections(dayId)).toHaveLength(0);
  });
});
