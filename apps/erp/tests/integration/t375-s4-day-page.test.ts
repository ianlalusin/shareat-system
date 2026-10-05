import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-375 S4 - the day page on a linked store, and the four lock sentences. `docs/tasks/375-pos-v1-day-feed.md` S4
 * tests W1 and K7 (the database half of the lock is `packages/db/tests/integration/t375-s4-lock.test.ts`).
 *
 * TESTER, not BUILDER. Real Postgres and the REAL domain underneath; only the session, Next's navigation helpers and
 * the `Page` shell are doubled (the S3 web test's pattern).
 *
 * ## Why these are red on HEAD
 *  - K7: the four constraint names are not in `CONSTRAINT_MESSAGES`, so `errorMessage()` returns a generic sentence.
 *  - W1 "Platform sales": the section does not exist. NOTE the day page already says "Platform sales you entered stay
 *    as they are" inside the re-import blurb, so the section is pinned by its HEADING (`<h2>Platform sales</h2>`), not
 *    by the words.
 *  - W1 "no Edit link" / "edit page refuses" are S3's behaviour and PASS today: they are the guards a regression in
 *    S4 must not break. The typed-day control (an unlinked store keeps "Edit this day" and the edit form) passes too.
 *
 * ## Pinned where the spec is silent
 *  - the section is an `<h2>` reading exactly "Platform sales" on a feed day that is open or submitted and shown to a
 *    viewer who can edit; it lists the store's NON-remitted channels (Foodpanda) and never a remitted one (Walk-in);
 *    on a verified feed day, and on an unlinked store's typed day, there is no such heading;
 *  - the four constraint-name spellings follow the DB test's constants (`sales_day_tenders_locked`,
 *    `sales_day_channels_locked`): see the doubt noted there.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/navigation', () => ({
  redirect: (target: string) => {
    throw new Error(`NEXT_REDIRECT ${target}`);
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

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import { sql as dsql } from 'drizzle-orm';
import { submitSalesDay, verifySalesDay } from '../../../../packages/domain/src/sales-days/verify';
import { importTestDay, linkTestStore, seedTestTenders } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { errorMessage } from '../../src/lib/constraint-messages';
import SalesDayDetailPage from '../../src/app/sales-days/[id]/page';
import EditSalesDayPage from '../../src/app/sales-days/[id]/edit/page';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const D10 = '2027-01-10';

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const LOCK_SENTENCE = "Sales figures for this store come only from POS and can't be changed here. A wrong sale is refunded on the POS.";
const CONSTRAINTS = ['sales_days_figures_locked', 'sales_day_tenders_locked', 'sales_day_channels_locked', 'pos_v1_store_links_store_fixed'] as const;

describe('K7 - errorMessage() maps each lock constraint to its sentence', () => {
  for (const name of CONSTRAINTS) {
    it(`${name} -> the sales-lock sentence, no constraint name, no SQL`, () => {
      const err = Object.assign(new Error(`new row for relation "sales_days" violates check constraint "${name}"`), {
        code: '23514',
        constraint_name: name,
      });
      const shown = errorMessage(err);
      expect(shown).toBe(LOCK_SENTENCE);
      expect(shown).not.toContain(name);
    });
  }

  it('control: an unmapped 23514 constraint still gets the generic sentence, not the lock one', () => {
    const err = Object.assign(new Error('violates check constraint "some_other_check"'), { code: '23514', constraint_name: 'some_other_check' });
    expect(errorMessage(err)).not.toBe(LOCK_SENTENCE);
  });
});

/** React escapes quotes and ampersands; the sentences are asserted as a person reads them. */
const text = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
const PLATFORM_H2 = /<h2[^>]*>Platform sales<\/h2>/;
/** The markup from the Platform sales heading to the next heading (or 3,000 characters). */
function platformSection(html: string): string {
  const m = PLATFORM_H2.exec(html);
  if (!m) return '';
  const rest = html.slice(m.index + m[0].length);
  const next = rest.search(/<h2[\s>]/);
  return next === -1 ? rest.slice(0, 3000) : rest.slice(0, next);
}

async function fixture(hint: string) {
  const code = uid(`t375s4w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2027-01-01', '2027-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const store2Id = await mkStore('Batangas');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, 'admin')`;
  for (const s of [storeId, store2Id]) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
  const mkChannel = async (sid: string, name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${sid}, ${name}, ${remitted}, ${receivable}) returning id`)[0]!.id;
  const walkInId = await mkChannel(storeId, 'Walk-in', true, null);
  await mkChannel(storeId, 'Foodpanda', false, '1220');
  const walkIn2Id = await mkChannel(store2Id, 'Walk-in', true, null);
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${storeId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId, channelId: walkInId, createdBy: p!.id });
  await seedTestTenders(sql, { orgId, storeId, walletAccountId: gcash!.id });
  const [m] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${m!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${m!.id}, ${storeId})`;
  const manager = { personId: m!.id, orgId };
  const admin = { personId: p!.id, orgId };
  h.actor = admin;
  return { orgId, storeId, store2Id, walkIn2Id, admin, manager };
}
type F = Awaited<ReturnType<typeof fixture>>;

const feedDay = (f: F, date: string) => asOrg(f.orgId, (tx) => importTestDay(tx, f.admin, { storeId: f.storeId, businessDate: date }));
const typedDay = async (f: F, date: string): Promise<string> =>
  (await sql<{ id: string }[]>`
    insert into sales_days (org_id, store_id, business_date, total_sales, unli_sales, ala_carte_sales, cash_collected, created_by)
    values (${f.orgId}, ${f.store2Id}, ${date}, 1000, 600, 400, 1000, ${f.admin.personId}) returning id`)[0]!.id;

const renderDay = async (f: F, id: string, storeId: string): Promise<string> => {
  h.actor = f.admin;
  const el = await SalesDayDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ store: storeId }) });
  return text(renderToStaticMarkup(el as never));
};
const renderEdit = async (f: F, id: string, storeId: string): Promise<string> => {
  h.actor = f.admin;
  const el = await EditSalesDayPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ store: storeId }) });
  return text(renderToStaticMarkup(el as never));
};

describe('W1 - the day page of a feed day on a linked store', () => {
  it('open: NO "Edit this day"; the Platform sales section lists Foodpanda and never Walk-in', async () => {
    const f = await fixture('open');
    const { id } = await feedDay(f, D10);
    const html = await renderDay(f, id, f.storeId);
    expect(html, 'no hand-edit of a feed day').not.toContain('Edit this day');
    expect(html, 'a Platform sales section (the heading)').toMatch(PLATFORM_H2);
    const section = platformSection(html);
    expect(section).toContain('Foodpanda');
    expect(section, 'a remitted channel is never typed here').not.toContain('Walk-in');
  });

  it('submitted: the section is still there', async () => {
    const f = await fixture('sub');
    const { id } = await feedDay(f, D10);
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.admin, id));
    expect(await renderDay(f, id, f.storeId)).toMatch(PLATFORM_H2);
  });

  it('verified: no Platform sales section (control)', async () => {
    const f = await fixture('ver');
    const { id } = await feedDay(f, D10);
    await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.admin, id));
    await asOrg(f.orgId, (tx) => verifySalesDayAs(tx, f, id));
    expect(await renderDay(f, id, f.storeId)).not.toMatch(PLATFORM_H2);
  });

  it('/sales-days/{id}/edit refuses with the R13 sentence', async () => {
    const f = await fixture('edit');
    const { id } = await feedDay(f, D10);
    const html = await renderEdit(f, id, f.storeId);
    expect(html).toContain('Lipa takes its sales from POS. Import the day instead.');
    expect(html, 'no figure form').not.toMatch(/name="totalSales"/);
  });
});

describe('W1 control - an UNLINKED store\'s typed day keeps the typed path', () => {
  it('"Edit this day" is offered, the edit page renders the figure form, and there is no Platform sales section', async () => {
    const f = await fixture('typed');
    const id = await typedDay(f, D10);
    const day = await renderDay(f, id, f.store2Id);
    expect(day).toContain('Edit this day');
    expect(day).not.toMatch(PLATFORM_H2);
    const edit = await renderEdit(f, id, f.store2Id);
    expect(edit, 'the typed form').toMatch(/name="totalSales"/);
    expect(edit).not.toContain('takes its sales from POS');
  });
});

// submit and verify are different people (T-138 segregation): the manager verifies what the admin submitted
async function verifySalesDayAs(tx: Tx, f: F, id: string) {
  return verifySalesDay(tx, f.manager, id);
}
