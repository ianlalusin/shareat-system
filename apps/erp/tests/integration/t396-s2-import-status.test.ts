/**
 * T-396 S2 - `docs/tasks/396-link-remaining-stores-and-morning-import.md` S2 rows 1-5b: the morning POS import's health, on
 * `/sales-days` and in `SchedulerStatus`.
 *
 * TESTER. Real Postgres, real page render (same idiom as `t350-s4-banner.test.ts`): only `requireSession` and the shell `Page`
 * are mocked. `scheduler_runs` rows are inserted with the owner connection. Every state is a row the S1 job could really write
 * (`outcome`/`failed_count` obey `scheduler_runs_outcome_matches_failures_check`; a partial run has posted > 0).
 *
 * ASSUMED CONTRACT for the builder (the spec names behaviour, not names):
 *  - `SchedulerStatus` gains an optional prop `cadence?: 'daily' | 'monthly'` (default monthly = today's 2-calendar-month rule).
 *    Daily: stale (a warning Banner, "may have stopped") when the last run started more than 26 h ago, else the quiet `<p>` line.
 *  - The never-run text names the job's own command (`npm run pos-day-import`), not the hard-coded `npm run month-end`.
 *  - `/sales-days` embeds `<SchedulerStatus job="pos_day_import" cadence="daily" ...>` (an async server component) ONLY for a person
 *    who holds `submit_sales_day`, and shows each failure/notice line only when the person may `submit_sales_day` AT that line's
 *    store (`SchedulerFailure.subjectId` = the store id, per S1). Failure lines are `<li>` items; notices are not.
 *  - Note: `renderToStaticMarkup` cannot render an async component, so `toHtml` below expands async function components itself.
 */
import { config } from 'dotenv';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { toBusinessDate } from '@shareat/core/datetime';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const HOUR = 3_600_000;

vi.mock('../../src/lib/session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));

type Role = 'admin' | 'manager' | 'staff';

async function fixture(hint: string) {
  const code = uid(`t396s2-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const mkStore = async (name: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('s')}, ${name}) returning id`;
    return s!.id;
  };
  const storeA = await mkStore('Store Alpha');
  const storeB = await mkStore('Store Bravo');
  const mkPerson = async (name: string, role: Role, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id, source) values (${p!.id}, ${s}, 'manual')`;
    return p!.id;
  };
  const admin = await mkPerson('Admin All', 'admin', [storeA, storeB]);
  const managerA = await mkPerson('Manager A', 'manager', [storeA]);
  const staff = await mkPerson('Cashier', 'staff', [storeA]);
  return { orgId, storeA, storeB, admin, managerA, staff };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

interface Line {
  subjectId: string;
  subjectName: string;
  reason: string;
  kind?: 'notice';
}

async function insertRun(
  f: Fixture,
  o: { job?: string; startedAt?: Date; outcome?: 'ok' | 'partial' | 'failed'; posted?: number; failures?: Line[]; error?: string | null },
) {
  const startedAt = o.startedAt ?? new Date(Date.now() - HOUR);
  const failures = o.failures ?? [];
  const failedCount = failures.filter((x) => x.kind !== 'notice').length;
  const outcome = o.outcome ?? (failedCount > 0 ? 'partial' : 'ok');
  const posted = o.posted ?? (outcome === 'partial' ? 1 : 0);
  await sql`
    insert into scheduler_runs (org_id, job, period, started_at, finished_at, posted_count, skipped_count, failed_count, failures, outcome, error, trigger)
    values (${f.orgId}, ${o.job ?? 'pos_day_import'}, ${toBusinessDate(startedAt).slice(0, 7)}, ${startedAt}, ${new Date(startedAt.getTime() + 5000)},
            ${posted}, 0, ${failedCount}, ${failures.length > 0 ? sql.json(failures as never) : null}, ${outcome}, ${o.error ?? null}, 'cron')`;
}

/** Expands async function components (renderToStaticMarkup cannot), leaves sync and host elements to React. */
async function expand(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map((n) => expand(n)));
  if (!isValidElement(node)) return node;
  const el = node as { type: unknown; props: Record<string, unknown>; key: string | null };
  if (typeof el.type === 'function' && Object.prototype.toString.call(el.type) === '[object AsyncFunction]') {
    return expand(await (el.type as (p: unknown) => Promise<ReactNode>)(el.props));
  }
  const children = el.props['children'] as ReactNode;
  if (children === undefined) return node;
  return createElement(el.type as never, { ...el.props, key: el.key ?? undefined }, (await expand(children)) as never);
}
const toHtml = async (n: ReactNode) => renderToStaticMarkup((await expand(n)) as never);

let SalesDaysPage: typeof import('../../src/app/sales-days/page').default;
let SchedulerStatus: typeof import('../../src/components/scheduler-status').SchedulerStatus;
let requireSessionMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  SalesDaysPage = (await import('../../src/app/sales-days/page')).default;
  SchedulerStatus = (await import('../../src/components/scheduler-status')).SchedulerStatus;
  requireSessionMock = (await import('../../src/lib/session')).requireSession as unknown as ReturnType<typeof vi.fn>;
}, 60_000);

async function renderPageAs(f: Fixture, personId: string) {
  requireSessionMock.mockResolvedValue({
    actor: { orgId: f.orgId, personId },
    sessionId: 'session-1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  });
  return toHtml(await SalesDaysPage({ searchParams: Promise.resolve({}) }));
}

/** The text of every `<li>` on the page, joined: where failure lines live. */
const listItems = (html: string) => [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]).join('\n');

describe('S2-1 never run', () => {
  it('says the morning import has never run and names its own command - kills: hides the never-run state / reuses the month-end command', async () => {
    const f = await fixture('never');
    const html = await renderPageAs(f, f.admin);
    expect(html).toMatch(/morning[^<]*import/i);
    expect(html).toMatch(/never run/i);
    expect(html).toContain('npm run pos-day-import');
    expect(html).not.toContain('month-end');
  }, 30_000);
});

describe('S2-2 a partial run shows each failure line', () => {
  it('store, date and sentence per failure on the page; the notice is not a failure item - kills: counts only / notice styled as failure', async () => {
    const f = await fixture('partial');
    await insertRun(f, {
      failures: [
        { subjectId: f.storeA, subjectName: 'Store Alpha, 14 Oct', reason: 'POS took "Maya" but no wallet is set up for it.' },
        { subjectId: f.storeB, subjectName: 'Store Bravo', reason: 'Backlog notice: 4 imported days wait for a person to submit them.', kind: 'notice' },
      ],
    });
    const html = await renderPageAs(f, f.admin);
    const items = listItems(html);
    expect(html).toContain('Store Alpha, 14 Oct');
    expect(html).toContain('POS took &quot;Maya&quot; but no wallet is set up for it.');
    expect(items).toContain('Store Alpha, 14 Oct');
    expect(html).toContain('4 imported days wait for a person to submit them.');
    expect(items).not.toContain('4 imported days wait');
  }, 30_000);
});

describe('S2-3 / S2-4 cadence', () => {
  it('daily cadence: 27 h ago is a stale warning, 25 h is the quiet line - kills: keeps the 2-month threshold for daily', async () => {
    const f = await fixture('daily');
    await insertRun(f, { startedAt: new Date(Date.now() - 27 * HOUR) });
    const stale = await toHtml(await SchedulerStatus({ orgId: f.orgId, job: 'pos_day_import', label: 'Morning POS import', cadence: 'daily' } as never));
    expect(stale).toContain('bg-warning-soft');
    expect(stale).toMatch(/may have stopped/i);

    const g = await fixture('daily-quiet');
    await insertRun(g, { startedAt: new Date(Date.now() - 25 * HOUR) });
    const quiet = await toHtml(await SchedulerStatus({ orgId: g.orgId, job: 'pos_day_import', label: 'Morning POS import', cadence: 'daily' } as never));
    expect(quiet).not.toContain('bg-warning-soft');
    expect(quiet).not.toMatch(/may have stopped/i);
    expect(quiet).toMatch(/last ran/i);
  }, 30_000);

  it('monthly default is unchanged: last month is quiet, 100 days ago is stale (props exactly as fixed-assets passes them) - kills: changes the default', async () => {
    // A fixed 40 days would cross two calendar months on some dates (the rule counts calendar months), so: noon on the 1st of last month.
    const [y, m] = toBusinessDate().split('-').map(Number) as [number, number];
    const lastMonth = new Date(`${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01T12:00:00+08:00`);
    const f = await fixture('monthly');
    await insertRun(f, { job: 'depreciation', startedAt: lastMonth });
    const quiet = await toHtml(await SchedulerStatus({ orgId: f.orgId, job: 'depreciation', label: 'Depreciation' }));
    expect(quiet).not.toContain('bg-warning-soft');
    expect(quiet).toMatch(/last ran/i);

    const g = await fixture('monthly-old');
    await insertRun(g, { job: 'depreciation', startedAt: new Date(Date.now() - 100 * 24 * HOUR) });
    const stale = await toHtml(await SchedulerStatus({ orgId: g.orgId, job: 'depreciation', label: 'Depreciation' }));
    expect(stale).toContain('bg-warning-soft');
  }, 30_000);
});

describe('S2-5 / S2-5b who sees what', () => {
  it('a person without submit_sales_day sees no status block, though the same run is on show for an admin - kills: leaks the run to everyone', async () => {
    const f = await fixture('staff');
    await insertRun(f, { failures: [{ subjectId: f.storeA, subjectName: 'Store Alpha, 14 Oct', reason: 'ZZ-STAFF-REASON no wallet.' }] });
    expect(await renderPageAs(f, f.admin)).toContain('ZZ-STAFF-REASON');
    const html = await renderPageAs(f, f.staff);
    expect(html).not.toContain('ZZ-STAFF-REASON');
    expect(html).not.toMatch(/pos-day-import/);
    expect(html).not.toMatch(/never run/i);
  }, 30_000);

  it('a manager scoped to store A sees A lines (failure and notice), none of store B - kills: shows every store refusals org-wide', async () => {
    const f = await fixture('scoped');
    await insertRun(f, {
      failures: [
        { subjectId: f.storeA, subjectName: 'Store Alpha, 14 Oct', reason: 'ZZ-A-FAIL no wallet.' },
        { subjectId: f.storeB, subjectName: 'Store Bravo, 14 Oct', reason: 'ZZ-B-FAIL no wallet.' },
        { subjectId: f.storeA, subjectName: 'Store Alpha', reason: 'ZZ-A-NOTICE backlog.', kind: 'notice' },
        { subjectId: f.storeB, subjectName: 'Store Bravo', reason: 'ZZ-B-NOTICE backlog.', kind: 'notice' },
      ],
    });
    const html = await renderPageAs(f, f.managerA);
    expect(html).toContain('ZZ-A-FAIL');
    expect(html).toContain('ZZ-A-NOTICE');
    expect(html).not.toContain('ZZ-B-FAIL');
    expect(html).not.toContain('ZZ-B-NOTICE');
    const all = await renderPageAs(f, f.admin);
    expect(all).toContain('ZZ-B-FAIL');
  }, 30_000);
});
