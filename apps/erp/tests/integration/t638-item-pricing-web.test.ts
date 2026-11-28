/**
 * T-638 - the price to stores on /items/[id] (edited) and Commissary -> Catalogue (read only). Real Postgres, real
 * `@shareat/auth`, real page renders and real actions; only the session, `next/navigation` and path aliases are mocked.
 * Each test names its killing mutant.
 */
import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { paramsOf } from '../helpers/flash-jar';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  // FormModal (catalogue page) reads the path to close itself on navigation.
  usePathname: () => '/commissary/catalogue',
  useSearchParams: () => new URLSearchParams(),
}));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!,
    sessionId: 'session-1',
    credentialKind: 'pin' as const,
    storeId: null,
    expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../../src/lib/constraint-messages'));
vi.mock('@/components/shell/Page', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), Page: ({ children }: { children: unknown }) => children }));
vi.mock('@/components/shell/PageDescription', () => ({ PageDescription: () => null }));

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  const { closeDb } = await import('@shareat/db');
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture(hint: string) {
  const code = uid(`t638-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, 'Commissary') returning id`;
  const mk = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${store!.id})`;
    return { orgId, personId: p!.id };
  };
  const manager = await mk('Manager', 'manager');
  const admin = await mk('Admin', 'admin');
  const staff = await mk('Staff', 'staff');
  const [sup] = await sql<{ id: string }[]>`insert into suppliers (org_id, name, created_by) values (${orgId}, ${uid('sup')}, ${manager.personId}) returning id`;
  return { orgId, storeId: store!.id, supplierId: sup!.id, manager, admin, staff };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function insertItem(f: Fixture, name: string, wholesale: boolean): Promise<string> {
  const code = `TZ${String(10 + (seq % 80))}-${String(100 + (++seq % 900))}`;
  const [row] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, sellable_wholesale, created_by)
    values (${f.orgId}, ${code}, ${name}, 'raw_material', 'kg', ${wholesale}, ${f.manager.personId})
    returning id`;
  return row!.id;
}
/** One landed delivery of an item at this unit cost (the cost the markup rules add to). */
async function deliver(f: Fixture, itemId: string, unitCost: string, date: string): Promise<void> {
  const [inv] = await sql<{ id: string }[]>`
    insert into supplier_invoices (org_id, store_id, supplier_id, invoice_date, total_amount, created_by)
    values (${f.orgId}, ${f.storeId}, ${f.supplierId}, ${date}, ${unitCost}, ${f.manager.personId}) returning id`;
  await sql`
    insert into supplier_invoice_lines (supplier_invoice_id, line_no, item_id, quantity, purchase_unit, conversion_factor, unit_price, line_total)
    values (${inv!.id}, 1, ${itemId}, '1', 'kg', '1', ${unitCost}, ${unitCost})`;
}
async function setRule(f: Fixture, itemId: string, r: { mode: string; fixed?: string; pct?: string; amt?: string; alert?: string }) {
  await sql`
    insert into item_pricing (org_id, item_id, pricing_mode, fixed_amount, markup_percent, fixed_markup_amount, margin_alert_threshold_pct, set_by)
    values (${f.orgId}, ${itemId}, ${r.mode}, ${r.fixed ?? null}, ${r.pct ?? null}, ${r.amt ?? null}, ${r.alert ?? null}, ${f.manager.personId})`;
}
const ruleRow = async (itemId: string) =>
  (
    await sql<{ pricing_mode: string; fixed_amount: string | null; markup_percent: string | null; fixed_markup_amount: string | null; margin_alert_threshold_pct: string | null }[]>`
    select pricing_mode, fixed_amount::text, markup_percent::text, fixed_markup_amount::text, margin_alert_threshold_pct::text from item_pricing where item_id = ${itemId}`
  )[0];

async function redirectOf(action: () => Promise<void>): Promise<string> {
  try {
    await action();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => paramsOf(to).get(k);
function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

let ItemDetailPage: typeof import('../../src/app/items/[id]/page').default;
let CataloguePage: typeof import('../../src/app/commissary/catalogue/page').default;
let actions: typeof import('../../src/app/items/actions');
beforeAll(async () => {
  ItemDetailPage = (await import('../../src/app/items/[id]/page')).default;
  CataloguePage = (await import('../../src/app/commissary/catalogue/page')).default;
  actions = await import('../../src/app/items/actions');
}, 60_000);

async function detailHtml(actor: { orgId: string; personId: string }, id: string): Promise<string> {
  ACTOR_HOLDER.actor = actor;
  const el = await ItemDetailPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
  return decode(renderToStaticMarkup(el as never));
}
/** Visible words: tags (and React's <!-- --> markers) removed, whitespace collapsed. */
const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
const priceBlock = (html: string) => html.slice(html.indexOf('id="price-to-stores"'), html.indexOf('id="price-to-stores"') + 5000);

describe('T-638 the item page, Wholesale row', () => {
  it('a wholesale item shows the price now with how it was worked out, and an Edit button for an admin only. MUTANTS: block dropped; basis ignored; edit not gated; edit gate back to manage_items', async () => {
    const f = await fixture('page');
    const id = await insertItem(f, 'Pork belly', true);
    await deliver(f, id, '200.00', '2026-11-01');
    await deliver(f, id, '213.04', '2026-11-10');
    await setRule(f, id, { mode: 'percent_markup', pct: '15', alert: '30' });
    const html = await detailHtml(f.admin, id);
    const block = priceBlock(html);
    expect(block).toContain('Price to stores (wholesale)');
    expect(block).toContain('₱245.00 = last delivery ₱213.04 + 15%');
    expect(block).toMatch(/aria-label="Edit Pork belly price to stores"/);
    expect(block).toContain('Diner (retail) prices are set under Menu');
    expect(html).toContain('name="pricingMode"');
    expect(html).toContain('name="markupPercent"');
    expect(block).toContain("Franchise prices (e.g. Padre Garcia) come from their own price list under Customers → Price lists and don't follow this price.");
    // A manager still SEES the price, but gets no form and is told who can change it.
    const mgr = await detailHtml(f.manager, id);
    expect(priceBlock(mgr)).toContain('₱245.00 = last delivery ₱213.04 + 15%');
    expect(mgr).not.toContain('name="pricingMode"');
    expect(text(priceBlock(mgr))).toContain('Only an admin can change it.');
  }, 60_000);

  it('no rule and no deliveries: "Needs a cost", never a zero price', async () => {
    const f = await fixture('needs');
    const id = await insertItem(f, 'Sauce', true);
    const block = priceBlock(await detailHtml(f.manager, id));
    expect(block).toContain('Needs a cost');
    expect(block).not.toMatch(/₱0\.00/);
  }, 60_000);

  it('a manual cost on an offering is shown when nothing else can price the item', async () => {
    const f = await fixture('manual');
    const id = await insertItem(f, 'Kimchi', true);
    await sql`insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by) values (${f.orgId}, ${f.storeId}, ${id}, '95.0000', ${f.manager.personId})`;
    const block = priceBlock(await detailHtml(f.manager, id));
    expect(text(block)).toContain('At Commissary: ₱95.00 = manual cost (no deliveries yet)');
  }, 60_000);

  it('an item not sold wholesale shows the hint and no edit. MUTANT: gate on wholesale dropped', async () => {
    const f = await fixture('retailonly');
    const id = await insertItem(f, 'Soda', false);
    const block = priceBlock(await detailHtml(f.manager, id));
    expect(block).toContain('Applies once');
    expect(block).not.toContain('price to stores"');
    expect(block).not.toContain('name="pricingMode"');
  }, 60_000);

  it('a store that sells it wholesale (override) makes the price show even when the org flag is off', async () => {
    const f = await fixture('override');
    const id = await insertItem(f, 'Stock', false);
    await sql`insert into store_item_sellability (org_id, store_id, item_id, sellable_wholesale, set_by) values (${f.orgId}, ${f.storeId}, ${id}, true, ${f.manager.personId})`;
    const block = priceBlock(await detailHtml(f.manager, id));
    expect(block).toContain('Needs a cost');
    expect(block).not.toContain('Applies once');
  }, 60_000);
});

describe('T-638 Commissary catalogue: read-only column', () => {
  it('shows the same words and links to the item page; no form for the price', async () => {
    const f = await fixture('cat');
    const id = await insertItem(f, 'Beef short rib', true);
    await deliver(f, id, '100.00', '2026-11-10');
    await setRule(f, id, { mode: 'fixed_markup', amt: '20' });
    await sql`insert into commissary_item_offerings (org_id, commissary_store_id, item_id, created_by) values (${f.orgId}, ${f.storeId}, ${id}, ${f.manager.personId})`;
    ACTOR_HOLDER.actor = f.manager;
    const el = await CataloguePage({ searchParams: Promise.resolve({ commissary: f.storeId }) });
    const html = decode(renderToStaticMarkup(el as never));
    expect(text(html)).toContain('Price to stores');
    expect(text(html)).toContain('₱120.00 = last delivery ₱100.00 + ₱20.00');
    expect(html).toContain(`/items/${id}#price-to-stores`);
    expect(html).not.toContain('name="pricingMode"');
  }, 60_000);
});

describe('T-638 setItemPricingAction', () => {
  it('a staff member AND a manager are refused, and the field sentence is never said. MUTANTS: assertFieldRules before the gate; authorize back to manage_items', async () => {
    const f = await fixture('auth');
    const id = await insertItem(f, 'Rice', true);
    for (const who of [f.staff, f.manager]) {
      ACTOR_HOLDER.actor = who;
      // A blank figure would read "The markup percent ..." if the field check ran first.
      const to = await redirectOf(() => actions.setItemPricingAction(form({ itemId: id, pricingMode: 'percent_markup', markupPercent: '' })));
      expect(param(to, 'error')).toBe('Only an admin can set the price to stores.');
      expect(await ruleRow(id)).toBeUndefined();
      // A valid save is refused too: the manager's gate is the capability, not the typed figure.
      const ok = await redirectOf(() => actions.setItemPricingAction(form({ itemId: id, pricingMode: 'percent_markup', markupPercent: '10' })));
      expect(param(ok, 'error')).toBe('Only an admin can set the price to stores.');
      expect(await ruleRow(id)).toBeUndefined();
    }
  }, 60_000);

  it('an admin saves each rule; a figure the rule does not use is not stored; an audit row is written. MUTANTS: unused figure stored; no audit', async () => {
    const f = await fixture('save');
    const id = await insertItem(f, 'Chicken', true);
    ACTOR_HOLDER.actor = f.admin;
    const ok = await redirectOf(() =>
      actions.setItemPricingAction(form({ itemId: id, pricingMode: 'percent_markup', markupPercent: '12.5', fixedAmount: '999', fixedMarkupAmount: '5', marginAlertThresholdPct: '10' })),
    );
    expect(param(ok, 'ok')).toMatch(/^Saved/);
    expect(await ruleRow(id)).toEqual({ pricing_mode: 'percent_markup', fixed_amount: null, markup_percent: '12.5000', fixed_markup_amount: null, margin_alert_threshold_pct: '10.0000' });
    await redirectOf(() => actions.setItemPricingAction(form({ itemId: id, pricingMode: 'fixed', fixedAmount: '180', markupPercent: '12.5' })));
    expect(await ruleRow(id)).toMatchObject({ pricing_mode: 'fixed', fixed_amount: '180.00', markup_percent: null, margin_alert_threshold_pct: null });
    const audits = await sql<{ before: Record<string, unknown> | null; after: Record<string, unknown> }[]>`select before, after from audit_log where org_id = ${f.orgId} and entity_id = ${id} and action = 'item_pricing.set' order by id`;
    expect(audits.length).toBe(2);
    expect(audits[0]!.before).toBeNull();
    // The second save: percent 12.5 -> fixed 180, with the first row's figures as "before".
    expect(audits[1]!.before).toMatchObject({ pricingMode: 'percent_markup', markupPercent: '12.5000', fixedAmount: null });
    expect(audits[1]!.after).toMatchObject({ pricingMode: 'fixed', fixedAmount: '180.00', markupPercent: null });
  }, 60_000);

  it('a blank figure for the chosen rule is refused in words and nothing is written', async () => {
    const f = await fixture('blank');
    const id = await insertItem(f, 'Fish', true);
    ACTOR_HOLDER.actor = f.admin;
    const to = await redirectOf(() => actions.setItemPricingAction(form({ itemId: id, pricingMode: 'fixed_markup', fixedMarkupAmount: '' })));
    expect(param(to, 'error')).toMatch(/markup amount/i);
    expect(await ruleRow(id)).toBeUndefined();
  }, 60_000);
});

describe('T-638 the live preview is computeBranchPrice', () => {
  it('equals computeBranchPrice for the same inputs and the cost derived on the server; null for a markup with no deliveries, a bad number, or without the right (a manager included)', async () => {
    const f = await fixture('prev');
    const id = await insertItem(f, 'Pork', true);
    const { computeBranchPrice } = await import('@shareat/domain');
    ACTOR_HOLDER.actor = f.admin;
    expect(await actions.previewItemPricingAction({ itemId: id, pricingMode: 'percent_markup', markupPercent: '15' })).toBeNull();
    await deliver(f, id, '213.04', '2026-11-10');
    const got = await actions.previewItemPricingAction({ itemId: id, pricingMode: 'percent_markup', markupPercent: '15', marginAlertThresholdPct: '20' });
    const want = computeBranchPrice({ pricingMode: 'percent_markup', markupPercent: '15', marginAlertThresholdPct: '20' }, '213.04');
    expect(got).toEqual({ price: want.price, marginPct: want.marginPct, marginAlert: want.marginAlert });
    expect(got!.price).toBe('245.00');
    const amt = await actions.previewItemPricingAction({ itemId: id, pricingMode: 'fixed_markup', fixedMarkupAmount: '1,000.50', marginAlertThresholdPct: '5' });
    const wantAmt = computeBranchPrice({ pricingMode: 'fixed_markup', fixedMarkupAmount: '1000.50', marginAlertThresholdPct: '5' }, '213.04');
    expect(amt).toEqual({ price: wantAmt.price, marginPct: wantAmt.marginPct, marginAlert: wantAmt.marginAlert });
    expect(await actions.previewItemPricingAction({ itemId: id, pricingMode: 'percent_markup', markupPercent: 'abc' })).toBeNull();
    for (const who of [f.manager, f.staff]) {
      ACTOR_HOLDER.actor = who;
      expect(await actions.previewItemPricingAction({ itemId: id, pricingMode: 'percent_markup', markupPercent: '15' })).toBeNull();
    }
  }, 60_000);
});
