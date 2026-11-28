import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * T-591 slice B - /opening-balances/stock-count: the redesigned screen.
 * Spec: docs/tasks/591-opening-balances-rename.md "Slice B".
 *
 * PINNED HERE:
 *  - `?show=uncounted` lists only the items with no count in this room; the tab says how many are missing.
 *  - `?q=` is a case-insensitive name search; no match says so and offers the whole list.
 *  - once an opening entry is POSTED the page draws the counts as plain figures (value = quantity x cost) with NO form at all,
 *    and says when the books were opened. Before that, every item has its form.
 *  - a Save made from the filtered list carries `show` back (a closed word), so the person stays on the short list.
 */
const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));

import { captureRedirect, pageParamsOf, resetJar } from '../helpers/flash-jar';
import { fixture, plain, sql } from './t389-s4-common';
import { formSegments, type Fixture } from './t389-s2-common';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';

const page = async () => (await import('../../src/app/opening-balances/stock-count/page')).default as never;
const actions = () => import('../../src/app/opening-balances/actions');

interface Ctx {
  f: Fixture;
  storeId: string;
  pork: string; // counted: 7 kg @ 10.0000 = 70.00
  rice: string; // counted: 0 kg (a real zero)
  chicken: string; // NOT counted
  squid: string; // NOT counted
}
async function ctxOf(hint: string): Promise<Ctx> {
  const f = await fixture(`b591-${hint}`, { chart: true });
  const [lt] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${f.orgId}, 'STK', 'Stockroom') returning id`;
  const [room] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
    values (${f.orgId}, ${f.storeId}, 'KIT', 'Kitchen', ${lt!.id}, 'operating', true, ${f.admin.personId}) returning id`;
  const mk = async (name: string) =>
    (await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${f.admin.personId}) returning id`)[0]!.id;
  const [pork, rice, chicken, squid] = [await mk('Pork Belly'), await mk('Rice Jasmine'), await mk('Chicken Thigh'), await mk('Squid')];
  const put = (item: string, qty: string, cost: string | null) =>
    sql`insert into opening_counts (org_id, store_id, location_id, item_id, quantity, unit_cost, cost_source, counted_by)
        values (${f.orgId}, ${f.storeId}, ${room!.id}, ${item}, ${qty}, ${cost}, ${cost ? 'typed' : null}, ${f.admin.personId})`;
  await put(pork, '7.000', '10.0000');
  await put(rice, '0.000', '12.5000');
  return { f, storeId: f.storeId, pork, rice, chicken, squid };
}

/** The books are opened: an opening_balance entry is POSTED (a draft first, because lines may only be added to a draft). */
async function openTheBooks(ctx: Ctx): Promise<void> {
  const o = ctx.f.orgId;
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${o}, '2026-11-01', '2026-11-30', 'open')`;
  const [per] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${o}`;
  const acct = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where org_id = ${o} and code = ${code}`)[0]!.id;
  const cash = await acct('1110');
  const bank = await acct('1115');
  // One transaction: the balance trigger is checked at COMMIT, so the two lines must land with the entry.
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${o}, '2026-11-01', ${per!.id}, 'opening_balance', uuidv7(), 'draft') returning id`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, debit, credit)
      values (${e!.id}, 1, ${cash}, 1, 0), (${e!.id}, 2, ${bank}, 0, 1)`;
    await tx`update journal_entries set status = 'posted', posted_at = now() where id = ${e!.id}`;
  });
}

async function render(ctx: Ctx, params: Record<string, string> = {}): Promise<string> {
  h.actor = ctx.f.admin;
  const Page = (await page()) as (p: unknown) => Promise<unknown>;
  const el = await Page({ params: Promise.resolve({}), searchParams: Promise.resolve({ store: ctx.storeId, ...params }) });
  return renderToStaticMarkup(el as never);
}
/** The names drawn in table rows, in order (the first cell of every body row). */
const rowNames = (html: string): string[] =>
  [...html.matchAll(/<tr[^>]*>\s*<td[^>]*>([^<]*)/g)].map((m) => m[1]!.trim()).filter(Boolean);
const formFor = (html: string, itemId: string) => formSegments(html).find((s) => s.includes(`name="itemId" value="${itemId}"`));

describe('T-591 B - the "Not counted yet" filter', () => {
  it('shows only the uncounted items, and a typed zero is counted, not missing', async () => {
    const ctx = await ctxOf('filter');
    const html = await render(ctx, { show: 'uncounted' });
    expect(rowNames(html).sort()).toEqual(['Chicken Thigh', 'Squid']);
    expect(plain(html)).toContain('Not counted yet (2)');
    expect(plain(html), 'a real zero (Rice Jasmine) is a count').not.toContain('Rice Jasmine');
  });

  it('with no filter every item is listed, and the progress line counts the room', async () => {
    const ctx = await ctxOf('all');
    const html = await render(ctx);
    expect(rowNames(html).sort()).toEqual(['Chicken Thigh', 'Pork Belly', 'Rice Jasmine', 'Squid']);
    expect(plain(html)).toMatch(/Counted 2 of 4 items in Kitchen/);
    expect(plain(html)).toContain('All items (4)');
  });

  it('an uncounted row is ONE table row: its two boxes name the item for a screen reader, the column header is the visible label, and Save has a word', async () => {
    const ctx = await ctxOf('onerow');
    const html = await render(ctx, { show: 'uncounted' });
    const row = /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Chicken Thigh(?:(?!<\/tr>)[\s\S])*<\/tr>/.exec(html)?.[0];
    expect(row, 'the item has its own <tr>').toBeDefined();
    expect(row).toContain('aria-label="Quantity (kg) of Chicken Thigh"');
    expect(row).toContain('aria-label="Cost per kg of Chicken Thigh"');
    expect(row, 'the row holds its own Save').toMatch(/<button[^>]*type="submit"[^>]*>[\s\S]*Save/);
    // the three headers the boxes sit under
    expect(plain(html)).toMatch(/Item Unit Quantity Cost per unit Value/);
  });

  it('an uncounted row is a form that carries `show` back, so a Save leaves the person on the short list', async () => {
    const ctx = await ctxOf('carry');
    const seg = formFor(await render(ctx, { show: 'uncounted' }), ctx.chicken)!;
    expect(seg, 'the uncounted item has its form').toBeDefined();
    expect(seg).toContain('name="show" value="uncounted"');
    expect(formFor(await render(ctx), ctx.chicken)!, 'no filter, nothing carried').not.toContain('name="show"');
    resetJar();
    h.actor = ctx.f.admin;
    const fd = new FormData();
    for (const [k, v] of Object.entries({ storeId: ctx.storeId, itemId: ctx.chicken, quantity: '-1', show: 'uncounted' })) fd.set(k, v);
    const signal = await captureRedirect(() => actions().then((m) => m.recordCountAction(fd)));
    expect(pageParamsOf(signal.url).show, 'a refused Save returns to the filtered list').toBe('uncounted');
  });

  it('an unknown show value is ignored: it is the whole list', async () => {
    const ctx = await ctxOf('unknown');
    expect(rowNames(await render(ctx, { show: 'whatever' })).length).toBe(4);
  });
});

describe('T-591 B - the item search', () => {
  it('matches part of a name, any letter case, and nothing else', async () => {
    const ctx = await ctxOf('search');
    expect(rowNames(await render(ctx, { q: 'ric' }))).toEqual(['Rice Jasmine']);
    expect(rowNames(await render(ctx, { q: 'BELLY' }))).toEqual(['Pork Belly']);
  });

  it('search and filter work together; no match says so and offers the whole list', async () => {
    const ctx = await ctxOf('search-both');
    expect(rowNames(await render(ctx, { q: 'squ', show: 'uncounted' }))).toEqual(['Squid']);
    const none = plain(await render(ctx, { q: 'pork', show: 'uncounted' }));
    expect(none).toContain('No items match "pork".');
    expect(none).toContain('Show all items');
  });
});

describe('T-591 B - read-only once the books are open', () => {
  it('before: every item has a form. After: no form anywhere, the figures are shown, and the date is said', async () => {
    const ctx = await ctxOf('readonly');
    const before = await render(ctx);
    for (const id of [ctx.pork, ctx.rice, ctx.chicken, ctx.squid]) expect(formFor(before, id), 'before opening: a form per item').toBeDefined();

    await openTheBooks(ctx);
    const html = await render(ctx);
    expect(formSegments(html).filter((s) => !s.includes('name="q"')), 'no form but the search box once the books are open').toHaveLength(0);
    expect(html).not.toContain('name="itemId"');
    const text = plain(html);
    expect(text).toContain('The books were opened on November 1, 2026.');
    expect(text).toContain('These counts are read-only.');
    // the saved figures are still on the page: 7 kg at 10 = 70.00, and the typed zero stays a zero
    expect(text).toMatch(/Pork Belly kg 7\.000 10\.0000 ₱70\.00/);
    expect(text).toMatch(/Rice Jasmine kg 0\.000 12\.5000 ₱0\.00/);
    // an uncounted item is still not a zero
    expect(text).toMatch(/Squid Not counted kg Not counted — —/);
  });
});
