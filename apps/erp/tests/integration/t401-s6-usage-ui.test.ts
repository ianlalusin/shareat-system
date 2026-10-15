/**
 * T-401 S6 - the screens. TESTER; real Postgres and the REAL domain underneath; only the session, Next's navigation helpers and the
 * `Page` shell are doubled (the pos-usage page test's pattern). Domain half: packages/domain/tests/integration/t401-s6-*.test.ts.
 *
 * ## Names the tester ASSUMED (spec names none) - the builder meets these or tells the tester
 *  - `postUsageAction(fd)` (inventory/usage/actions.ts) reads a new optional field `reason` and passes it as
 *    `verifyOutOfTolerance: { reason }` when non-blank; a refusal redirects to `/inventory/usage/{recordId}` with the domain
 *    refusal as the error banner (the existing contract), and nothing is posted;
 *  - the record page's post form carries `name="reason"` for a draft (`/inventory/usage/[id]`);
 *  - the queue page (`/inventory/usage?store=`) renders, per covered item of the store's day with a plan: item name, expected, actual
 *    and a status word, drawn from `listUsageVariances`; wording: an out-of-band row says "outside" (or "out of band"), an in-band
 *    row says "within" (or "in band" / "inside"); every draft row names its author (display name);
 *  - the settings screen is `/settings/usage-tolerance` with `setOrgUsageToleranceAction(fd { tolerance })` and
 *    `setItemUsageToleranceAction(fd { itemId, tolerance })` (an empty tolerance clears the override), in
 *    settings/usage-tolerance/actions.ts; admin only; success is an ok banner, a refusal an error banner;
 *  - the POS usage page says the pull is a CHECK ("check" appears) and no longer says finalizing posts stock;
 *  - the day-close WARNING sits on the sales-day page (`/sales-days/[id]`) for a manager: text "Yesterday's usage not posted", the
 *    COUNT of the store's usage drafts dated yesterday (the real clock's yesterday), and a link to `/inventory/usage?store=<id>`.
 *    The dashboard half of rule 7 is NOT covered here (its page needs a far larger harness); it should reuse the same domain read.
 */
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

config({ path: '.env.local' });

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('../../src/lib/page-access', () => ({
  requirePageAccess: async () => ({ actor: h.actor, refusal: null }),
}));
vi.mock('@/components/shell/Page', () => ({ Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));

import { closeDb } from '@shareat/db';
import { buildPlan, finalizeSections, saveUsageDraft } from '@shareat/domain';
import { submitSalesDay, verifySalesDay } from '../../../../packages/domain/src/sales-days/verify';
import { toBusinessDate, addDays } from '@shareat/core/datetime';
import { asOrg, makeDay, rawMap, sold, sql, stockUp, uid, world, type World } from '../../../../packages/domain/tests/integration/t401-s5-setup';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';
import { paramsOf } from '../helpers/flash-jar';
import { RedirectSignal } from '../helpers/flash-jar-core';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const DAY = '2026-08-20';
const START = 1000;
const text = (html: string): string =>
  html.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

/** Store A, day DAY: 'a' 10 sold -> Cheese x1 (expected 10), 'b' 10 sold -> Rice x1 (expected 10). Plan built. */
async function scenario(hint: string) {
  const w = await world(hint);
  await rawMap(w, w.a.storeId, 'a', { mode: 'direct', itemId: w.cheese, quantityPerSale: '1' });
  await rawMap(w, w.a.storeId, 'b', { mode: 'direct', itemId: w.rice, quantityPerSale: '1' });
  await stockUp(w, w.a.storeId, w.a.kitchen, w.cheese, String(START));
  await stockUp(w, w.a.storeId, w.a.kitchen, w.rice, String(START));
  const dayId = await makeDay(w, w.a.storeId, DAY, sold([{ key: 'a', qty: 10 }, { key: 'b', qty: 10 }]));
  const p = await asOrg(w.orgId, (tx) => buildPlan(tx, w.staff, { orgId: w.orgId, storeId: w.a.storeId, salesDayId: dayId, locationId: w.a.kitchen }));
  if (!p.ok) throw new Error(p.reason);
  return { w, dayId, pullId: p.pullId, keys: p.lines.filter((l) => !l.blocked).map((l) => l.key) };
}

const draft = async (w: World, who: { personId: string; orgId: string }, lines: { itemId: string; quantity: string }[]) => {
  const r = await asOrg(w.orgId, (tx) =>
    saveUsageDraft(tx, who, { orgId: w.orgId, storeId: w.a.storeId, locationId: w.a.kitchen, kind: 'usage', usedOn: DAY, lines }),
  );
  if (!r.ok) throw new Error(r.reason);
  return r.recordId;
};

/** Runs a server action; returns where it redirected and the banner/flash it carried. */
async function run(who: { personId: string; orgId: string }, action: (fd: FormData) => Promise<void>, fields: Record<string, string>) {
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
  } catch (err) {
    if (err instanceof RedirectSignal) {
      const u = new URL(err.url, 'http://x.test');
      return { path: u.pathname, q: paramsOf(err.url) };
    }
    throw err;
  }
  throw new Error('the action returned without redirecting');
}

const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from stock_usage_records where id = ${id}`)[0]!.status;
const cheeseOnHand = async (w: World) =>
  Number((await sql<{ t: string }[]>`select coalesce(sum(quantity),0)::text as t from stock_movements where org_id = ${w.orgId} and item_id = ${w.cheese}`)[0]!.t);

// ---------------------------------------------------------------------------------------------------------------------
describe('B1 - the post action: an out-of-band draft needs a reason', () => {
  it('without a reason (absent, then blank) it goes back to the record page with the refusal; nothing posts; with a reason it posts, writes stock and writes stock.usage_tolerance_verified', async () => {
    const { w } = await scenario('ui1');
    const id = await draft(w, w.staff, [{ itemId: w.cheese, quantity: '12' }]); // +20%
    const { postUsageAction } = await import('../../src/app/inventory/usage/actions');

    for (const fields of [{ recordId: id }, { recordId: id, reason: '   ' }]) {
      const r = await run(w.manager, postUsageAction, fields);
      expect(r.path, 'the refusal returns to the form').toBe(`/inventory/usage/${id}`);
      expect(r.q.get('ok')).toBeNull();
      expect(r.q.get('error') ?? '', 'the sentence names the item and the numbers').toMatch(/Cheese/);
      expect(r.q.get('error') ?? '').toMatch(/12/);
      expect(r.q.get('error') ?? '').toMatch(/10/);
      expect(await statusOf(id)).toBe('draft');
      expect(await cheeseOnHand(w)).toBe(START);
    }
    const [none] = await sql<{ n: string }[]>`select count(*)::text as n from audit_log where org_id = ${w.orgId} and action = 'stock.usage_tolerance_verified'`;
    expect(Number(none!.n)).toBe(0);

    const ok = await run(w.manager, postUsageAction, { recordId: id, reason: 'Two extra trays were counted' });
    expect(ok.q.get('error')).toBeNull();
    expect(ok.q.get('ok') ?? '').toMatch(/Posted/);
    expect(await statusOf(id)).toBe('posted');
    expect(await cheeseOnHand(w)).toBe(START - 12);
    const rows = await sql<{ after: Record<string, unknown> | null }[]>`
      select after from audit_log where org_id = ${w.orgId} and action = 'stock.usage_tolerance_verified'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ itemId: w.cheese, reason: 'Two extra trays were counted' });
  }, 180_000);

  it('an in-band draft posts with no reason field at all (control: the field is only asked for when needed)', async () => {
    const { w } = await scenario('ui1b');
    const id = await draft(w, w.staff, [{ itemId: w.cheese, quantity: '10.5' }]);
    const { postUsageAction } = await import('../../src/app/inventory/usage/actions');
    const r = await run(w.manager, postUsageAction, { recordId: id });
    expect(r.q.get('error')).toBeNull();
    expect(await statusOf(id)).toBe('posted');
  }, 180_000);

  it("the record page of a draft has a reason input in its post form (so the refusal's 'try again with a reason' has somewhere to go)", async () => {
    const { w } = await scenario('ui1c');
    const id = await draft(w, w.staff, [{ itemId: w.cheese, quantity: '12' }]);
    h.actor = w.manager;
    const Page = (await import('../../src/app/inventory/usage/[id]/page')).default as (p: unknown) => Promise<unknown>;
    const html = text(renderToStaticMarkup((await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as never));
    const form = html.match(/<form[^>]*>(?:(?!<\/form>)[\s\S])*name="recordId"(?:(?!<\/form>)[\s\S])*Post(?:(?!<\/form>)[\s\S])*<\/form>/)?.[0] ?? '';
    expect(form, 'the post form is on the page').not.toBe('');
    expect(form).toMatch(/name="reason"/);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('B2 - the queue page shows the band per covered item and who wrote each draft', () => {
  async function secondStaff(w: World) {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${w.orgId}, 'Cashier Cora') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${w.orgId}, 'staff')`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${w.a.storeId})`;
    const [emp] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on) values (${w.orgId}, ${w.a.storeId}, ${p!.id}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
    await grantEverydayPositionAccess(sql, { orgId: w.orgId, storeId: w.a.storeId, employmentId: emp!.id, personId: p!.id, setBy: w.manager.personId });
    return { personId: p!.id, orgId: w.orgId };
  }

  it('Cheese 10.5 of 10 reads inside, Rice 15 of 10 reads outside, with the expected and actual numbers beside each; each draft names its author; the figures are listUsageVariances', async () => {
    const { w } = await scenario('ui2');
    const cora = await secondStaff(w);
    await draft(w, w.staff, [{ itemId: w.cheese, quantity: '10.5' }]);
    await draft(w, cora, [{ itemId: w.rice, quantity: '15' }]);

    const { listUsageVariances } = await import('@shareat/domain');
    const v = await asOrg(w.orgId, (tx) => listUsageVariances(tx, w.manager, { storeId: w.a.storeId, date: DAY }));
    const cheese = v.find((r) => r.itemId === w.cheese)!;
    const rice = v.find((r) => r.itemId === w.rice)!;
    expect([cheese.withinBand, rice.withinBand], 'control: the domain read says inside, outside').toEqual([true, false]);

    h.actor = w.manager;
    const Page = (await import('../../src/app/inventory/usage/page')).default as (p: unknown) => Promise<unknown>;
    const html = text(renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: w.a.storeId, date: DAY }) })) as never));
    const rowOf = (name: string): string => {
      const i = html.indexOf(name);
      expect(i, `the queue page names ${name}`).toBeGreaterThan(-1);
      const rest = html.slice(i);
      const end = rest.search(/<\/tr>|<\/li>|<\/section>/);
      return rest.slice(0, end > 0 ? end : 600);
    };
    const cheeseRow = rowOf('Cheese');
    const riceRow = rowOf('Rice');
    expect(cheeseRow).toMatch(/10(\.0+)?\b/);
    expect(cheeseRow).toMatch(/10\.5(0+)?/);
    expect(cheeseRow, 'Cheese is in band').toMatch(/within|in band|inside/i);
    expect(cheeseRow).not.toMatch(/outside|out of band/i);
    expect(riceRow).toMatch(/15(\.0+)?\b/);
    expect(riceRow, 'Rice is out of band').toMatch(/outside|out of band/i);
    expect(html, 'the staff draft names its author').toContain('Staffer');
    expect(html, "the other staff member's draft names her").toContain('Cashier Cora');
  }, 180_000);

  it('a pull draft (system author) is on the page too, and its lines carry the expected quantities', async () => {
    const { w, pullId, keys } = await scenario('ui2b');
    const f = await asOrg(w.orgId, (tx) => finalizeSections(tx, w.manager, { pullId, sections: ['direct'], confirmedKeys: keys }));
    expect(f.ok).toBe(true);
    h.actor = w.manager;
    const Page = (await import('../../src/app/inventory/usage/page')).default as (p: unknown) => Promise<unknown>;
    const html = text(renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: w.a.storeId, date: DAY }) })) as never));
    expect(html).toContain('Cheese');
    expect(html).toContain('Rice');
    expect(html, 'a draft row exists for the day').toMatch(/draft/i);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('B3 - the tolerance settings form (admin only)', () => {
  it('admin sets the org tolerance and an item override; manager is refused on both; nothing stored for the refused call; clearing the override goes back to the org setting', async () => {
    const { w } = await scenario('ui3');
    const actions = (await import('../../src/app/settings/usage-tolerance/actions')) as unknown as {
      setOrgUsageToleranceAction(fd: FormData): Promise<void>;
      setItemUsageToleranceAction(fd: FormData): Promise<void>;
    };
    const orgTol = async () => (await sql<{ t: string }[]>`select usage_tolerance::text as t from organizations where id = ${w.orgId}`)[0]!.t;
    const itemTol = async () => (await sql<{ t: string | null }[]>`select usage_tolerance::text as t from items where id = ${w.cheese}`)[0]!.t;

    const denied = await run(w.manager, actions.setOrgUsageToleranceAction, { tolerance: '0.05' });
    expect(denied.q.get('ok')).toBeNull();
    expect(denied.q.get('error'), 'a manager is refused with a sentence').toBeTruthy();
    expect(Number(await orgTol())).toBe(0.1);
    const deniedItem = await run(w.manager, actions.setItemUsageToleranceAction, { itemId: w.cheese, tolerance: '0.02' });
    expect(deniedItem.q.get('ok')).toBeNull();
    expect(deniedItem.q.get('error')).toBeTruthy();
    expect(await itemTol()).toBeNull();

    const ok = await run(w.admin, actions.setOrgUsageToleranceAction, { tolerance: '0.05' });
    expect(ok.q.get('error')).toBeNull();
    expect(ok.q.get('ok')).toBeTruthy();
    expect(Number(await orgTol())).toBe(0.05);
    const okItem = await run(w.admin, actions.setItemUsageToleranceAction, { itemId: w.cheese, tolerance: '0.02' });
    expect(okItem.q.get('ok')).toBeTruthy();
    expect(Number(await itemTol())).toBe(0.02);

    const cleared = await run(w.admin, actions.setItemUsageToleranceAction, { itemId: w.cheese, tolerance: '' });
    expect(cleared.q.get('error')).toBeNull();
    expect(await itemTol()).toBeNull();

    const bad = await run(w.admin, actions.setOrgUsageToleranceAction, { tolerance: '1.5' });
    expect(bad.q.get('ok')).toBeNull();
    expect(bad.q.get('error')).toBeTruthy();
    expect(Number(await orgTol()), 'a nonsense value is not stored').toBe(0.05);
  }, 180_000);

  it('the settings page renders the org tolerance as a percent and a form with an item picker, for an admin', async () => {
    const { w } = await scenario('ui3b');
    h.actor = w.admin;
    const Page = (await import('../../src/app/settings/usage-tolerance/page')).default as (p: unknown) => Promise<unknown>;
    const html = text(renderToStaticMarkup((await Page({ searchParams: Promise.resolve({}) })) as never));
    expect(html).toMatch(/10(\.0+)?\s*%|0\.10/);
    expect(html).toMatch(/name="tolerance"/);
    expect(html).toMatch(/name="itemId"/);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe('B4 - the POS usage page says the pull is a check', () => {
  it('a built plan page mentions "check" and no longer says finalizing posts stock ("nothing left to post", "Puts back the stock this pull used")', async () => {
    const { w, dayId, pullId } = await scenario('ui4');
    h.actor = w.manager;
    const Page = (await import('../../src/app/inventory/pos-usage/page')).default as (p: unknown) => Promise<unknown>;
    const html = text(renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store: w.a.storeId, day: dayId, pull: pullId }) })) as never));
    expect(html).toMatch(/check/i);
    expect(html).not.toMatch(/nothing left to post/i);
    expect(html).not.toMatch(/Puts back the stock this pull used/i);
    expect(html, 'no claim that finalizing takes stock out').not.toMatch(/posts? (the )?stock|takes? (the )?stock out|stock out/i);
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------
describe("B5 - day-close warning: yesterday's usage not posted (a warning, never a block)", () => {
  const yesterday = (): string => addDays(toBusinessDate(), -1);
  const WARN = /Yesterday's usage not posted/;
  const manualDraft = async (w: World, storeId: string, kitchen: string, date: string, itemId: string) => {
    const r = await asOrg(w.orgId, (tx) =>
      saveUsageDraft(tx, w.manager, { orgId: w.orgId, storeId, locationId: kitchen, kind: 'usage', usedOn: date, lines: [{ itemId, quantity: '3' }] }),
    );
    if (!r.ok) throw new Error(`fixture: ${r.reason}`);
    return r.recordId;
  };
  const dayPage = async (w: World, id: string) => {
    h.actor = w.manager;
    const Page = (await import('../../src/app/sales-days/[id]/page')).default as (p: unknown) => Promise<unknown>;
    return text(renderToStaticMarkup((await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ store: w.a.storeId }) })) as never));
  };

  it('two unposted drafts dated yesterday: the day page names the warning, the count 2 and a link to the usage queue of that store; store B draft is not counted', async () => {
    const { w, dayId } = await scenario('ui5');
    await stockUp(w, w.a.storeId, w.a.kitchen, w.coke, '100');
    await stockUp(w, w.b.storeId, w.b.kitchen, w.coke, '100');
    await manualDraft(w, w.a.storeId, w.a.kitchen, yesterday(), w.coke);
    await manualDraft(w, w.a.storeId, w.a.kitchen, yesterday(), w.cheese);
    await manualDraft(w, w.b.storeId, w.b.kitchen, yesterday(), w.coke);
    const html = await dayPage(w, dayId);
    expect(html).toMatch(WARN);
    const chunk = html.slice(html.search(WARN), html.search(WARN) + 500);
    expect(chunk, 'the count of store A drafts').toMatch(/\b2\b/);
    expect(chunk).not.toMatch(/\b3\b/);
    const link = html.match(/href="([^"]*inventory\/usage[^"]*)"/)?.[1] ?? '';
    expect(link, 'a link to the usage queue').toContain('store=' + w.a.storeId);
  }, 180_000);

  it('no drafts, or already posted, or only an older draft: no warning', async () => {
    const { w, dayId } = await scenario('ui5b');
    expect(await dayPage(w, dayId), 'nothing pending').not.toMatch(WARN);
    await stockUp(w, w.a.storeId, w.a.kitchen, w.coke, '100');
    const id = await manualDraft(w, w.a.storeId, w.a.kitchen, yesterday(), w.coke);
    const { postUsage } = await import('@shareat/domain');
    const r = await asOrg(w.orgId, (tx) => postUsage(tx, w.manager, { recordId: id }));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    expect(await dayPage(w, dayId), 'posted').not.toMatch(WARN);
    await manualDraft(w, w.a.storeId, w.a.kitchen, addDays(toBusinessDate(), -5), w.coke);
    expect(await dayPage(w, dayId), 'the warning is about yesterday only').not.toMatch(WARN);
  }, 180_000);

  it('it is only a warning: submit and verify of the sales day still succeed while the usage is unposted', async () => {
    const { w, dayId } = await scenario('ui5c');
    await stockUp(w, w.a.storeId, w.a.kitchen, w.coke, '100');
    await manualDraft(w, w.a.storeId, w.a.kitchen, yesterday(), w.coke);
    await asOrg(w.orgId, (tx) => submitSalesDay(tx, w.manager, dayId)); // a refusal would throw
    await asOrg(w.orgId, (tx) => verifySalesDay(tx, w.admin, dayId));
    const [d] = await sql<{ status: string }[]>`select status from sales_days where id = ${dayId}`;
    expect(d!.status).toBe('verified');
  }, 180_000);
});
