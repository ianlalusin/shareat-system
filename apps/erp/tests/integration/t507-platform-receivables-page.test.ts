import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

import type { Actor } from '@shareat/auth';
import { plain, render, session } from './t435-fixture';
import { ASOF, buildPlatformWorld, type PlatformWorld } from '../../../../packages/domain/tests/integration/_fixtures/t507-platform-ar';

/**
 * T-507 (TESTER) - /reports/ar-aging and its CSV show "Due from delivery platforms". Spec: docs/tasks/507-platform-receivables-on-ar-report.md.
 * World and amounts: packages/domain/tests/integration/_fixtures/t507-platform-ar.ts (Lipa 11,500.00 across Foodpanda 9,000.00 and GrabFood 2,500.00;
 * Batangas 1,600.00 across Foodpanda 700.00 and Shopee 900.00 on 1250; org 13,100.00; customer 650.00).
 * Pinned wording (spec build items 1-2): heading "Due from delivery platforms"; the line
 *   "Only verified sales days appear here. {n} day(s) with platform sales are waiting for verification."
 * with a link to /sales-days; each channel row links to /channel-settlements for that channel (href carries the channel id).
 * CSV (the report has one): the platform section rows follow the customer section, each with the channel name and total.
 * Mutants: section hard-coded to 1220 (Shopee vanishes); no store filter (M-Lipa sees Batangas); unverified counted as receivable.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', async () => (await import('./t435-fixture')).sessionMock());
vi.mock('../../src/components/scheduler-status', () => ({ SchedulerStatus: () => null }));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

import { config } from 'dotenv';
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set.');
if (!isTestDatabaseUrl(url)) throw new Error('Refusing to run: database name must contain "_test".');
const sql = postgres(url, { max: 5 });
afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

let worldP: Promise<PlatformWorld> | undefined;
const world = () => (worldP ??= buildPlatformWorld(sql));

const agingPage = () => import('../../src/app/reports/ar-aging/page');
const exportRoute = () => import('../../src/app/reports/ar-aging/export/route');
async function pageFor(actor: Actor, store?: string): Promise<string> {
  try {
    return await render(agingPage, actor, { search: { asOf: ASOF, ...(store ? { store } : {}) } });
  } catch (e) {
    return `THROWN ${e instanceof Error ? e.message : String(e)}`;
  }
}
async function csvFor(actor: Actor, store?: string): Promise<string> {
  session.actor = actor;
  const { GET } = await exportRoute();
  const u = new URL('http://localhost/reports/ar-aging/export');
  u.searchParams.set('asOf', ASOF);
  if (store) u.searchParams.set('store', store);
  try {
    return await (await GET(new Request(u))).text();
  } catch (e) {
    return `THROWN ${e instanceof Error ? e.message : String(e)}`;
  }
}
const has = (html: string, ...needles: string[]) => needles.forEach((n) => expect(plain(html).includes(n) || html.includes(n), `must show "${n}"`).toBe(true));
const lacks = (html: string, ...needles: string[]) => needles.forEach((n) => expect(plain(html).includes(n) || html.includes(n), `must NOT show "${n}"`).toBe(false));

describe('T-507 page: the platform section', () => {
  it('admin sees "Due from delivery platforms" with all four channels, their amounts and the 13,100.00 total', async () => {
    const w = await world();
    const html = await pageFor(w.admin);
    has(html, 'Due from delivery platforms', 'Foodpanda', 'GrabFood', 'Shopee', '9,000.00', '2,500.00', '700.00', '900.00', '13,100.00');
  });
  it('the customer section is still there and still ties: customer name and 650.00', async () => {
    const w = await world();
    has(await pageFor(w.admin), 'T507 Customer Resto', '650.00');
  });
  it('the verified-only line with the waiting count (2 org-wide) and a link to the sales-days list', async () => {
    const w = await world();
    const html = await pageFor(w.admin);
    has(html, 'Only verified sales days appear here.', '2 day(s) with platform sales are waiting for verification.');
    expect(html).toMatch(/href="\/sales-days[^"]*"/);
  });
  it('each channel row drills to /channel-settlements for THAT channel (href carries the channel id)', async () => {
    const w = await world();
    const html = await pageFor(w.admin);
    for (const id of [w.ch.lipaFp, w.ch.lipaGrab, w.ch.batFp, w.ch.batShopee]) {
      expect(html, `link for channel ${id}`).toMatch(new RegExp(`href="/channel-settlements[^"]*${id}[^"]*"`));
    }
  });
  it('unverified platform sales (800.00 and 100.00) are not shown as receivable amounts', async () => {
    const w = await world();
    const html = await pageFor(w.admin);
    lacks(html, '14,000.00', '13,900.00');
  });
});

describe('T-507 page: store scope (manager sees only their stores)', () => {
  it('manager of Lipa: Lipa channels and 11,500.00; NO Batangas channel, no Shopee, no 1,600.00 / 13,100.00; waiting = 1', async () => {
    const w = await world();
    const html = await pageFor(w.mgrLipa);
    has(html, 'Due from delivery platforms', '9,000.00', '2,500.00', '11,500.00', '1 day(s) with platform sales are waiting for verification.');
    lacks(html, 'Shopee', '1,600.00', '13,100.00', '900.00', '700.00', w.ch.batFp, w.ch.batShopee);
  });
  it('manager of Batangas: Foodpanda 700.00 + Shopee 900.00 = 1,600.00; NO Lipa amounts', async () => {
    const w = await world();
    const html = await pageFor(w.mgrBat);
    has(html, 'Shopee', '700.00', '900.00', '1,600.00');
    lacks(html, '9,000.00', '2,500.00', '11,500.00', '13,100.00', w.ch.lipaFp, w.ch.lipaGrab);
  });
  it('a forged ?store=<Lipa> from the Batangas manager shows no Lipa platform money', async () => {
    const w = await world();
    const html = await pageFor(w.mgrBat, w.lipa);
    lacks(html, '9,000.00', '2,500.00', '11,500.00', '13,100.00', w.ch.lipaFp);
  });
  it('admin filtered to Batangas sees only the Batangas platform rows', async () => {
    const w = await world();
    const html = await pageFor(w.admin, w.bat);
    has(html, 'Shopee', '1,600.00');
    lacks(html, '9,000.00', '11,500.00', '13,100.00');
  });
});

describe('T-507 CSV: the platform section is exported too', () => {
  it('admin CSV has the customer rows AND the platform channels with their totals (13,100.00 across 4 channels)', async () => {
    const w = await world();
    const csv = await csvFor(w.admin);
    expect(csv).toContain('T507 Customer Resto');
    for (const n of ['Foodpanda', 'GrabFood', 'Shopee', '9,000.00', '2,500.00', '700.00', '900.00', '13,100.00']) expect(csv, `CSV must contain ${n}`).toContain(n);
    expect(csv.toLowerCase()).toContain('delivery platforms');
  });
  it('Lipa manager CSV: Lipa platform rows only; no Shopee, no Batangas amounts', async () => {
    const w = await world();
    const csv = await csvFor(w.mgrLipa);
    expect(csv).toContain('9,000.00');
    for (const n of ['Shopee', '1,600.00', '13,100.00', '900.00']) expect(csv.includes(n), `CSV leaks ${n}`).toBe(false);
  });
});

describe('T-507 ruling 3: /sales-days?status=unverified is open + submitted, store-scoped', () => {
  const daysPage = () => import('../../src/app/sales-days/page');
  const daysFor = async (actor: Actor, status: string, store?: string) => {
    try {
      return await render(daysPage, actor, { search: { status, ...(store ? { store } : {}) } });
    } catch (e) {
      return `THROWN ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  it('lists the three open days (03-26, 03-27, 03-28) and none of the verified ones', async () => {
    const w = await world();
    const html = plain(await daysFor(w.admin, 'unverified'));
    for (const d of ['2027-03-26', '2027-03-27', '2027-03-28']) expect(html, `must list ${d}`).toContain(d);
    for (const d of ['2027-03-25', '2027-03-20', '2027-03-10', '2027-02-20', '2026-12-15']) expect(html, `must NOT list verified ${d}`).not.toContain(d);
  });
  it('also includes a SUBMITTED day, not just open ones', async () => {
    const w = await world();
    const [d] = await sql<{ id: string }[]>`select id from sales_days where store_id = ${w.lipa} and business_date = '2027-03-28'`;
    await sql`update sales_days set status = 'submitted' where id = ${d!.id}`;
    const html = plain(await daysFor(w.admin, 'unverified'));
    await sql`update sales_days set status = 'open' where id = ${d!.id}`;
    expect(html).toContain('2027-03-28');
  });
  it('with a store filter, only that store: Lipa shows 03-28, not Batangas 03-27 / 03-26', async () => {
    const w = await world();
    const html = plain(await daysFor(w.admin, 'unverified', w.lipa));
    expect(html).toContain('2027-03-28');
    expect(html).not.toContain('2027-03-27');
    expect(html).not.toContain('2027-03-26');
  });
});

describe('DEF-809: /sales-days is gated by submit_sales_day and scoped to the viewer stores', () => {
  const daysPage = () => import('../../src/app/sales-days/page');
  const daysFor = async (actor: Actor, search: Record<string, string> = {}) => {
    try {
      return plain(await render(daysPage, actor, { search }));
    } catch (e) {
      return `THROWN ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  it('Batangas manager does not see Lipa days (no Lipa dates), even with a forged ?store=<Lipa>', async () => {
    const w = await world();
    for (const search of [{} as Record<string, string>, { store: w.lipa }]) {
      const html = await daysFor(w.mgrBat, search);
      expect(html, 'must list a Batangas day').toContain('2027-02-20');
      for (const d of ['2027-03-28', '2027-03-20', '2027-03-10', '2027-01-05', '2026-12-15']) {
        expect(html, `must NOT list Lipa day ${d}`).not.toContain(d);
      }
    }
  });
  it('staff (no submit_sales_day) is refused: no totals, a refusal instead', async () => {
    const w = await world();
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'T507 Staff') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.lipa})`;
    const html = await daysFor({ personId: p!.id, orgId: w.orgId } as Actor);
    expect(html).toMatch(/^THROWN/);
    expect(html).not.toContain('2027-03-20');
  });
});
