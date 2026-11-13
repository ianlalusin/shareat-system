import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * T-504 (TESTER) - the web legs of "a sales channel is never zero or blank unless No sales is ticked".
 * Spec: docs/tasks/504-no-sales-tick-required.md (rules 1-6 and items 7-10). Real pages, real actions, real domain, real Postgres.
 *
 * CONTRACT PINNED HERE (spec silent; the builder matches or asks):
 *  A. ACTIONS (rule 5 + item 9): createSalesDayAction / editSalesDayAction / setPlatformSalesAction pass a channel through as typed.
 *     They never drop a blank, and never turn a ticked box's amount into '0' (that was DEF-628 at the action).
 *     blank unticked -> saves (open draft, no row); 0 unticked -> refused (MISSING); ticked + amount -> refused (BOTH);
 *     ticked + blank -> a no-sales row; "16,980" saves. submitSalesDayAction refuses a day with a missing channel (MISSING).
 *  B. LIVE RULE (rule 6): a <RuleCheck id="salesDay.channels.tickedOrTyped" facts=...> is mounted from the '@/components/forms'
 *     barrel INSIDE the form's check context on /sales-days/new and /sales-days/[id]/edit. The test feeds the facts the PAGE
 *     handed it to the REAL check from BUSINESS_CHECKS with control values channel_<id> / nosales_<id> ('on' when ticked):
 *       0 unticked -> block, sentence names the channel (MISSING); amount + ticked -> block (BOTH);
 *       blank unticked -> NO block (item 9: blanks are allowed on save); ticked + blank -> none; amount -> none.
 *  C. ONE SAVE (item 8): on the typed pages exactly one submit control labelled Save*. On a feed day, the Platform sales inputs sit
 *     in a form that owns exactly one Save, and the page shows exactly one Save in total (no separate Platform Save).
 *  D. DRAFT MEMORY (item 10): the typed form markup carries data-draft-key="<draftKey(person, store, businessDate)>"
 *     (draft-memory.ts, see t504-draft-memory.test.ts); a server render holds no restored values and no "Restored" banner.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
const seen = vi.hoisted(() => ({ rc: [] as Array<{ id: string; facts: unknown; inContext: boolean }> }));

vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/forms', async (orig) => {
  const { useContext } = await import('react');
  const { CheckContext } = await import('../../src/components/forms/context');
  return {
    ...(await orig<Record<string, unknown>>()),
    RuleCheck: (props: { id: string; facts: unknown }) => {
      seen.rc.push({ id: props.id, facts: props.facts, inContext: useContext(CheckContext) !== null });
      return null;
    },
  };
});

import { BUSINESS_CHECKS } from '@shareat/domain/business-rules';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { importTestDay, linkTestStore, seedTestTenders } from '../../../../packages/domain/tests/integration/_fixtures/pos-day';
import { actor, asOrg, captureRedirect, closeAfterAll, outcomeOf, person, sql, uid } from './t389-s3-common';

closeAfterAll();

const RULE_ID = 'salesDay.channels.tickedOrTyped';
const MISSING = (n: string) => `${n}: type the sales, or tick No sales if there were none.`;
const SUBMIT_MISSING = (...names: string[]) => `Type the sales, or tick No sales, for: ${names.join(', ')}.`;
const BOTH = (n: string) => `${n}: you typed sales and ticked No sales — choose one.`;

async function setup(hint: string) {
  const code = uid(`t504w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) =>
    (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid('st')}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Batangas');
  const feedStoreId = await mkStore('Lipa');
  const adminId = await person(orgId, 'Admin', 'admin', [storeId, feedStoreId]);
  const managerId = await person(orgId, 'Manager', 'manager', [storeId, feedStoreId]);
  const mkChannel = async (sid: string, name: string, remitted: boolean, receivable: string | null) =>
    (await sql<{ id: string }[]>`
      insert into sales_channels (org_id, store_id, name, is_remitted_daily, receivable_account_code)
      values (${orgId}, ${sid}, ${name}, ${remitted}, ${receivable}) returning id`)[0]!.id;
  const walkIn = await mkChannel(storeId, 'Walk-in', true, null);
  const foodpanda = await mkChannel(storeId, 'Foodpanda', false, '1220');
  const fWalkIn = await mkChannel(feedStoreId, 'Walk-in', true, null);
  const fFoodpanda = await mkChannel(feedStoreId, 'Foodpanda', false, '1220');
  const [gcash] = await sql<{ id: string }[]>`
    insert into money_accounts (org_id, store_id, name, instrument, gl_account_code, custodian)
    values (${orgId}, ${feedStoreId}, 'GCash - Lipa', 'ewallet', '1140', 'cashier') returning id`;
  await linkTestStore(sql, { orgId, storeId: feedStoreId, channelId: fWalkIn, createdBy: adminId });
  await seedTestTenders(sql, { orgId, storeId: feedStoreId, walletAccountId: gcash!.id });
  const manager = actor(orgId, managerId);
  h.actor = manager;
  return { orgId, storeId, feedStoreId, walkIn, foodpanda, fWalkIn, fFoodpanda, manager };
}
type C = Awaited<ReturnType<typeof setup>>;

function form(entries: Record<string, string | null>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) if (v !== null) fd.set(k, v);
  return fd;
}
const FIG = { totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00' };
const createForm = (c: C, date: string, over: Record<string, string | null> = {}) =>
  form({ storeId: c.storeId, businessDate: date, ...FIG, [`channel_${c.walkIn}`]: '1000.00', [`channel_${c.foodpanda}`]: '', ...over });

async function run(fn: () => Promise<void>) {
  const o = outcomeOf(await captureRedirect(fn));
  return { error: o.flash.error as string | undefined, ok: o.flash.ok as string | undefined };
}
const dayOn = async (c: C, date: string) =>
  (await sql<{ id: string; status: string }[]>`select id, status from sales_days where store_id = ${c.storeId} and business_date = ${date}`)[0];
const rows = (dayId: string) =>
  sql<{ channel_id: string; amount: string; no_sales: boolean }[]>`select channel_id, amount::text, no_sales from sales_day_channels where sales_day_id = ${dayId}`;

async function actions() {
  return await import('../../src/app/sales-days/actions');
}

describe('A. the actions pass channels through as typed', () => {
  it('blank unticked saves an OPEN draft with no row for that channel (item 9; was: skipped by the action, rule 5)', async () => {
    const c = await setup('a1');
    const { createSalesDayAction } = await actions();
    const r = await run(() => createSalesDayAction(createForm(c, '2026-01-10')));
    expect(r.error).toBeUndefined();
    const d = await dayOn(c, '2026-01-10');
    expect(d?.status).toBe('open');
    expect((await rows(d!.id)).map((x) => x.channel_id)).toEqual([c.walkIn]);
  });

  it('0 unticked is refused in words and nothing is saved', async () => {
    const c = await setup('a2');
    const { createSalesDayAction } = await actions();
    const r = await run(() => createSalesDayAction(createForm(c, '2026-01-11', { [`channel_${c.foodpanda}`]: '0' })));
    expect(r.error).toBe(MISSING('Foodpanda'));
    expect(await dayOn(c, '2026-01-11')).toBeUndefined();
  });

  it('DEF-628 at the action: ticked + an amount is refused ("choose one"), not silently turned into 0', async () => {
    const c = await setup('a3');
    const { createSalesDayAction } = await actions();
    const r = await run(() => createSalesDayAction(createForm(c, '2026-01-12', { [`channel_${c.foodpanda}`]: '500', [`nosales_${c.foodpanda}`]: 'on' })));
    expect(r.error).toBe(BOTH('Foodpanda'));
    expect(await dayOn(c, '2026-01-12')).toBeUndefined();
  });

  it('ticked + blank saves a no-sales row; "16,980" in another box saves 16980.00', async () => {
    const c = await setup('a4');
    const { createSalesDayAction } = await actions();
    const r = await run(() => createSalesDayAction(createForm(c, '2026-01-13', { [`channel_${c.walkIn}`]: '16,980', [`channel_${c.foodpanda}`]: '', [`nosales_${c.foodpanda}`]: 'on' })));
    expect(r.error).toBeUndefined();
    const rs = await rows((await dayOn(c, '2026-01-13'))!.id);
    const fp = rs.find((x) => x.channel_id === c.foodpanda)!;
    expect([Number(fp.amount), fp.no_sales]).toEqual([0, true]);
    expect(Number(rs.find((x) => x.channel_id === c.walkIn)!.amount)).toBe(16980);
  });

  it('edit action: ticked + amount refused; blank clears the row and keeps the day open', async () => {
    const c = await setup('a5');
    const { createSalesDayAction, editSalesDayAction } = await actions();
    await run(() => createSalesDayAction(createForm(c, '2026-01-14', { [`channel_${c.foodpanda}`]: '40' })));
    const d = (await dayOn(c, '2026-01-14'))!;
    const editForm = (over: Record<string, string | null>) => form({ storeId: c.storeId, salesDayId: d.id, ...FIG, [`channel_${c.walkIn}`]: '960', ...over });
    const bad = await run(() => editSalesDayAction(editForm({ [`channel_${c.foodpanda}`]: '40', [`nosales_${c.foodpanda}`]: 'on' })));
    expect(bad.error).toBe(BOTH('Foodpanda'));
    const ok = await run(() => editSalesDayAction(editForm({ [`channel_${c.foodpanda}`]: '' })));
    expect(ok.error).toBeUndefined();
    expect((await rows(d.id)).some((x) => x.channel_id === c.foodpanda)).toBe(false);
    expect((await dayOn(c, '2026-01-14'))!.status).toBe('open');
  });

  it('submit action: a day with a blank channel is refused naming it; the day stays open', async () => {
    const c = await setup('a6');
    const { createSalesDayAction, submitSalesDayAction } = await actions();
    await run(() => createSalesDayAction(createForm(c, '2026-01-15')));
    const d = (await dayOn(c, '2026-01-15'))!;
    const r = await run(() => submitSalesDayAction(form({ storeId: c.storeId, salesDayId: d.id })));
    expect(r.error).toBe(SUBMIT_MISSING('Foodpanda'));
    expect((await dayOn(c, '2026-01-15'))!.status).toBe('open');
  });

  it('platform boxes via the one edit action: ticked + amount refused (DEF-628); 0 unticked refused; "1,500.50" saves', async () => {
    const c = await setup('a7');
    const { editSalesDayAction } = await actions();
    const { id } = await asOrg(c.orgId, (tx) => importTestDay(tx, c.manager, { storeId: c.feedStoreId, businessDate: '2026-01-10' }));
    // Ruling 3: the platform boxes are saved by the ONE edit action (`platform=1` marks a POS-fed day's form).
    const pf = (over: Record<string, string | null>) => form({ storeId: c.feedStoreId, salesDayId: id, platform: '1', ...over });
    expect((await run(() => editSalesDayAction(pf({ [`channel_${c.fFoodpanda}`]: '500', [`nosales_${c.fFoodpanda}`]: 'on' })))).error).toBe(BOTH('Foodpanda'));
    expect((await run(() => editSalesDayAction(pf({ [`channel_${c.fFoodpanda}`]: '0' })))).error).toBe(MISSING('Foodpanda'));
    expect((await run(() => editSalesDayAction(pf({ [`channel_${c.fFoodpanda}`]: '1,500.50' })))).error).toBeUndefined();
    const fp = (await rows(id)).find((x) => x.channel_id === c.fFoodpanda)!;
    expect(Number(fp.amount)).toBe(1500.5);
  });
});

// ---------------------------------------------------------------------------------------------------------------
async function render(loader: () => Promise<{ default: (p: never) => unknown }>, props: Record<string, unknown>): Promise<string> {
  seen.rc.length = 0;
  const mod = await loader();
  return renderToStaticMarkup((await mod.default(props as never)) as never);
}
const newPage = (c: C) =>
  render(() => import('../../src/app/sales-days/new/page') as never, { searchParams: Promise.resolve({ store: c.storeId }) });
const editPage = (id: string) =>
  render(() => import('../../src/app/sales-days/[id]/edit/page') as never, { params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
const dayPage = (id: string) =>
  render(() => import('../../src/app/sales-days/[id]/page') as never, { params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });

type Verdict = null | { level: string; sentence: string };
function judge(c: C, values: Record<string, string>): Verdict {
  const hit = seen.rc.find((x) => x.id === RULE_ID);
  expect(hit, `a <RuleCheck id="${RULE_ID}"> must be mounted on the page`).toBeTruthy();
  expect(hit!.inContext, 'it must sit inside the form check context (else it renders nothing)').toBe(true);
  const check = BUSINESS_CHECKS[RULE_ID];
  expect(check, `${RULE_ID} must exist in BUSINESS_CHECKS`).toBeTruthy();
  // The control names carry channel ids only the page's facts know, so the check lists them by `watchFor(facts)` (a static `watch`
  // cannot hold a uuid). The form tracks exactly these.
  for (const name of [`channel_${c.foodpanda}`, `nosales_${c.foodpanda}`]) expect(check!.watchFor!(hit!.facts), 'watchFor lists the channel controls').toContain(name);
  return check!.run(hit!.facts, values) as Verdict;
}
const SALES = (c: C, fp: string, ticked: boolean): Record<string, string> => ({
  [`channel_${c.walkIn}`]: '1000',
  [`channel_${c.foodpanda}`]: fp,
  [`nosales_${c.foodpanda}`]: ticked ? 'on' : '',
});

async function liveRuleLegs(c: C, page: () => Promise<string>) {
  const html = await page();
  expect(judge(c, SALES(c, '0', false))).toMatchObject({ level: 'block', sentence: MISSING('Foodpanda') });
  expect(judge(c, SALES(c, '0.00', false))).toMatchObject({ level: 'block', sentence: MISSING('Foodpanda') });
  expect(judge(c, SALES(c, '500', true))).toMatchObject({ level: 'block', sentence: BOTH('Foodpanda') });
  expect(judge(c, SALES(c, '', false)), 'item 9: a blank is allowed while drafting').toBeNull();
  expect(judge(c, SALES(c, '', true))).toBeNull();
  expect(judge(c, SALES(c, '16,980', false))).toBeNull();
  return html;
}

describe('B. the live rule on the typed pages', () => {
  it('/sales-days/new', async () => {
    const c = await setup('b1');
    await liveRuleLegs(c, () => newPage(c));
  });
  it('/sales-days/[id]/edit', async () => {
    const c = await setup('b2');
    const { createSalesDayAction } = await actions();
    await run(() => createSalesDayAction(createForm(c, '2026-01-10')));
    const d = (await dayOn(c, '2026-01-10'))!;
    await liveRuleLegs(c, () => editPage(d.id));
  });
});

const saveButtons = (html: string) =>
  [...html.matchAll(/<button\b[^>]*type="submit"[^>]*>([\s\S]*?)<\/button>/g)].filter((m) => /^\s*Save/.test(m[0].replace(/<[^>]+>/g, ' ').trim()) || /aria-label="Save/.test(m[0]));

describe('C. one Save for the whole report', () => {
  it('typed pages: exactly one Save', async () => {
    const c = await setup('c1');
    expect(saveButtons(await newPage(c)).length).toBe(1);
    const { createSalesDayAction } = await actions();
    await run(() => createSalesDayAction(createForm(c, '2026-01-10')));
    expect(saveButtons(await editPage((await dayOn(c, '2026-01-10'))!.id)).length).toBe(1);
  });

  it('feed day: the Platform sales boxes sit in a form that owns one Save, and the page has no other Save', async () => {
    const c = await setup('c2');
    const { id } = await asOrg(c.orgId, (tx) => importTestDay(tx, c.manager, { storeId: c.feedStoreId, businessDate: '2026-01-10' }));
    const html = await dayPage(id);
    const at = html.indexOf(`name="channel_${c.fFoodpanda}"`);
    expect(at, 'the Platform sales box is on the day page').toBeGreaterThan(-1);
    const start = html.lastIndexOf('<form', at);
    const end = html.indexOf('</form>', at);
    expect(saveButtons(html.slice(start, end)).length, 'the form around the platform boxes has one Save').toBe(1);
    expect(saveButtons(html).length, 'and there is no second Save on the page').toBe(1);
  });
});

describe('D. the form remembers unsaved typing (markup only; the browser behaviour is the helper)', () => {
  it('new page: data-draft-key = draftKey(person, store, the date in the box); nothing restored on the server render', async () => {
    const c = await setup('d1');
    const { draftKey } = await import('../../src/app/sales-days/draft-memory');
    const html = await newPage(c);
    const date = /name="businessDate"[^>]*value="(\d{4}-\d{2}-\d{2})"|value="(\d{4}-\d{2}-\d{2})"[^>]*name="businessDate"/.exec(html);
    const d = date?.[1] ?? date?.[2];
    expect(d, 'the date box carries its value').toBeTruthy();
    expect(html).toContain(`data-draft-key="${draftKey(c.manager.personId, c.storeId, d!)}"`);
    expect(html).not.toMatch(/Restored what you typed/);
  });

  it('edit page: keyed by the DAY\'s own date', async () => {
    const c = await setup('d2');
    const { draftKey } = await import('../../src/app/sales-days/draft-memory');
    const { createSalesDayAction } = await actions();
    await run(() => createSalesDayAction(createForm(c, '2026-01-10')));
    const html = await editPage((await dayOn(c, '2026-01-10'))!.id);
    expect(html).toContain(`data-draft-key="${draftKey(c.manager.personId, c.storeId, '2026-01-10')}"`);
  });
});
