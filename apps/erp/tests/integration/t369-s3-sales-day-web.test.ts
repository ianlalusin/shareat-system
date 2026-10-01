import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-369 S3 (DEF-479 + DEF-291's sales-day leg) — the web legs. `docs/tasks/369-unwired-money-screens.md`
 * §S3: T9 (the wallet loader and `/sales-days/new`), plus the screens and actions the BUILDER bullets
 * add (detail page Edit / Withdraw, `/sales-days/[id]/edit`, `editSalesDayAction`, `voidSalesDayAction`).
 *
 * ⛔ TESTER, not BUILDER. Harness from `t362-supplier-terms-web.test.ts` (session mock, `Page` stub,
 * `RedirectSignal`). The REAL pages, REAL actions, REAL domain and REAL Postgres run underneath.
 *
 * ## What the spec leaves open, pinned so the builder has one reading
 * - `editSalesDayAction(formData)` reads the SAME fields as `createSalesDayAction` — `storeId`,
 *   `totalSales`, `unliSales`, `alaCarteSales`, `cashCollected`, … and `channel_<id>` / `tender_<id>` —
 *   plus `salesDayId`. It redirects to `/sales-days/{id}?store=…` (error banner via `&error=`).
 * - The detail page links `href="/sales-days/{id}/edit"` for open/submitted days, and shows the
 *   wording "Withdraw this unverified day" (a void form with a required `reason`) for open/submitted
 *   days; a VERIFIED day keeps the existing void form, worded "Void (reverses the posting)".
 * - The edit page is a `SalesDayForm` prefilled from the day: `name="totalSales"` carries the day's
 *   figure, `name="channel_<id>"` the channel's amount, and a hidden `salesDayId`.
 * If the builder reads different names, that is a QUESTION to the tester, not a test edit.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
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
    throw new Error('notFound() called — fixture is broken');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const ACTOR_HOLDER: { actor: { orgId: string; personId: string } | null } = { actor: null };
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => ACTOR_HOLDER.actor!),
  requireSession: vi.fn(async () => ({
    actor: ACTOR_HOLDER.actor!, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01'),
  })),
}));
vi.mock('@/components/shell/Page', () => ({
  Page: ({ children }: { children: unknown }) => children,
}));

import { transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createSalesDay, submitSalesDay } from '@shareat/domain';
import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { grantEverydayPositionAccess } from '../../../../packages/domain/tests/integration/_fixtures/staff-everyday-access';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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
const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/** Lipa (+ its channels and wallets), Malvar (+ its wallets); staff / manager scoped to Lipa only. */
async function fixture(hint: string) {
  const code = uid(`t369s3w-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open')`;
  const mkStore = async (name: string) => (await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(name)}, ${name}) returning id`)[0]!.id;
  const storeId = await mkStore('Lipa');
  const malvarId = await mkStore('Malvar');
  const mkPerson = async (name: string, role: string) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    return p!.id;
  };
  const staffId = await mkPerson('Staff', 'staff');
  const managerId = await mkPerson('Manager', 'manager');
  const adminId = await mkPerson('Admin', 'admin');
  await sql`insert into person_store_scope (person_id, store_id) values (${adminId}, ${malvarId})`;
  const walkIn = (await sql<{ id: string }[]>`
    insert into sales_channels (org_id, store_id, name, is_remitted_daily) values (${orgId}, ${storeId}, 'Walk-in', true) returning id`)[0]!.id;
  const [emp] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgId}, ${storeId}, ${staffId}, ${uid('SE')}, 'regular', '2025-01-01') returning id`;
  await grantEverydayPositionAccess(sql, { orgId, storeId, employmentId: emp!.id, personId: staffId, setBy: managerId });
  const lipaWallets = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${storeId}`;
  const malvarWallets = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${malvarId}`;
  return {
    orgId, storeId, malvarId, walkIn, staffId, managerId, adminId,
    staff: actor(orgId, staffId), manager: actor(orgId, managerId), admin: actor(orgId, adminId),
    lipaWallets: lipaWallets.map((w) => w.id), malvarWallets: malvarWallets.map((w) => w.id),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function mkDay(f: Fixture, date: string, walkIn: string, submit = false): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createSalesDay(tx, f.staff, {
      storeId: f.storeId, businessDate: date, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '1000.00',
      channels: [{ channelId: f.walkIn, amount: walkIn }],
    }),
  );
  if (submit) await asOrg(f.orgId, (tx) => submitSalesDay(tx, f.staff, id));
  return id;
}
const dayStatus = async (id: string) => (await sql<{ status: string }[]>`select status from sales_days where id = ${id}`)[0]!.status;
const channelAmount = async (id: string, channelId: string) =>
  (await sql<{ amount: string }[]>`select amount::text from sales_day_channels where sales_day_id = ${id} and channel_id = ${channelId}`)[0]?.amount;

async function load<T>(spec: () => Promise<T>, what: string): Promise<T> {
  try {
    return await spec();
  } catch (err) {
    throw new Error(`${what} does not exist yet (or fails to import): ${String((err as Error).message).split('\n')[0]}`);
  }
}
async function render(who: Actor, loader: () => Promise<{ default: (p: never) => Promise<unknown> | unknown }>, what: string, props: Record<string, unknown>): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const mod = await load(loader, what);
  return renderToStaticMarkup((await mod.default(props as never)) as never);
}
const detail = (who: Actor, id: string, search: Record<string, string> = {}) =>
  render(who, () => import('../../src/app/sales-days/[id]/page') as never, '/sales-days/[id]/page.tsx', { params: Promise.resolve({ id }), searchParams: Promise.resolve(search) });
const editPage = (who: Actor, id: string, search: Record<string, string> = {}) =>
  render(who, () => import('../../src/app/sales-days/[id]/edit/page') as never, '/sales-days/[id]/edit/page.tsx', { params: Promise.resolve({ id }), searchParams: Promise.resolve(search) });
const newPage = (who: Actor, search: Record<string, string> = {}) =>
  render(who, () => import('../../src/app/sales-days/new/page') as never, '/sales-days/new/page.tsx', { searchParams: Promise.resolve(search) });

async function expectRedirectTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}
const param = (to: string, k: string) => new URL(to, 'http://localhost').searchParams.get(k);
const pathOf = (to: string) => new URL(to, 'http://localhost').pathname;

// -----------------------------------------------------------------------------------------------
// T9 (DEF-291) — wallets are the store's, asserted on the LOADER as well as the markup
// -----------------------------------------------------------------------------------------------

describe('T9 — /sales-days/new?store=Lipa offers only Lipa\'s wallets', () => {
  it('the new store-scoped loader returns Lipa\'s accounts only (none of Malvar\'s) — red today: listStoreMoneyAccounts does not exist', async () => {
    const f = await fixture('t9load');
    expect(f.lipaWallets.length, 'fixture: Lipa has foundation wallets').toBeGreaterThan(0);
    expect(f.malvarWallets.length, 'fixture: Malvar has foundation wallets').toBeGreaterThan(0);

    const lib = (await load(() => import('../../src/app/sales-days/lib'), 'apps/erp/src/app/sales-days/lib.ts')) as unknown as {
      listStoreMoneyAccounts?: (orgId: string, storeId: string) => Promise<{ id: string; storeId: string }[]>;
    };
    expect(typeof lib.listStoreMoneyAccounts, 'listStoreMoneyAccounts is not exported from sales-days/lib.ts').toBe('function');
    const rows = await lib.listStoreMoneyAccounts!(f.orgId, f.storeId);
    const ids = rows.map((r) => r.id);
    for (const id of f.malvarWallets) expect(ids, "another store's account leaked out of the loader").not.toContain(id);
    for (const r of rows) expect(r.storeId).toBe(f.storeId);
    for (const id of f.lipaWallets) expect(ids, "Lipa's own account is missing").toContain(id);
  });

  it('the rendered form carries a tender_<id> input for each Lipa wallet and none for Malvar\'s', async () => {
    const f = await fixture('t9page');
    const html = await newPage(f.manager, { store: f.storeId });
    for (const id of f.lipaWallets) expect(html).toContain(`name="tender_${id}"`);
    for (const id of f.malvarWallets) expect(html).not.toContain(id);
  });

  it('the page no longer reads the org-wide picker: expenses/lib.ts has no listMoneyAccountsForPicker export (DEF-291 leg; the builder deletes it)', async () => {
    const lib = (await import('../../src/app/expenses/lib')) as unknown as Record<string, unknown>;
    expect(lib.listMoneyAccountsForPicker, 'the unscoped org-wide picker still exists').toBeUndefined();
  });
});

// -----------------------------------------------------------------------------------------------
// The detail page — Edit and Withdraw
// -----------------------------------------------------------------------------------------------

describe('/sales-days/[id] — Edit and Withdraw', () => {
  it('a manager sees an Edit link and "Withdraw this unverified day" on an OPEN day; a staff member sees no Withdraw form (positive control: the manager)', async () => {
    const f = await fixture('detail-open');
    const id = await mkDay(f, '2026-01-10', '500.00');

    const mgr = await detail(f.manager, id, { store: f.storeId });
    expect(mgr).toMatch(new RegExp(`href="/sales-days/${id}/edit`));
    expect(mgr).toMatch(/Withdraw this unverified day/);

    const staff = await detail(f.staff, id, { store: f.storeId });
    expect(staff, 'money controls render only where usable').not.toMatch(/Withdraw this unverified day/);
  });

  it('a SUBMITTED day offers Edit and Withdraw to the manager; a VERIFIED day offers neither Edit nor "Withdraw this unverified day", and its void form reads "Void (reverses the posting)"', async () => {
    const f = await fixture('detail-states');
    const submitted = await mkDay(f, '2026-01-12', '500.00', true);
    const html = await detail(f.manager, submitted, { store: f.storeId });
    expect(html).toMatch(new RegExp(`href="/sales-days/${submitted}/edit`));
    expect(html).toMatch(/Withdraw this unverified day/);

    const verified = await mkDay(f, '2026-01-09', '1000.00');
    const { verifySalesDay } = await import('@shareat/domain');
    await asOrg(f.orgId, (tx) => verifySalesDay(tx, f.manager, verified));
    const vhtml = await detail(f.manager, verified, { store: f.storeId });
    expect(vhtml).not.toMatch(new RegExp(`href="/sales-days/${verified}/edit`));
    expect(vhtml).not.toMatch(/Withdraw this unverified day/);
    expect(vhtml).toMatch(/Void \(reverses the posting\)/);
  });
});

// -----------------------------------------------------------------------------------------------
// The edit page
// -----------------------------------------------------------------------------------------------

describe('/sales-days/[id]/edit — a SalesDayForm prefilled from the day', () => {
  it('carries the day\'s figures, the channel amount and a hidden salesDayId; the store and date are not editable inputs', async () => {
    const f = await fixture('editpage');
    const id = await mkDay(f, '2026-01-10', '500.00');
    const html = await editPage(f.manager, id, { store: f.storeId });

    const total = html.match(/<input[^>]*name="totalSales"[^>]*>/);
    expect(total, 'no totalSales input').not.toBeNull();
    expect(total![0]).toMatch(/value="1000(\.00)?"/);
    const channel = html.match(new RegExp(`<input[^>]*name="channel_${f.walkIn}"[^>]*>`));
    expect(channel, 'no channel input').not.toBeNull();
    expect(channel![0]).toMatch(/value="500(\.00)?"/);
    expect(html).toMatch(new RegExp(`<input[^>]*name="salesDayId"[^>]*value="${id}"|<input[^>]*value="${id}"[^>]*name="salesDayId"`));
    expect(html, 'R1: the date is not an editable input on the edit form').not.toMatch(/<input[^>]*name="businessDate"(?![^>]*type="hidden")(?![^>]*readonly)(?![^>]*disabled)[^>]*>/);
  });
});

// -----------------------------------------------------------------------------------------------
// The actions
// -----------------------------------------------------------------------------------------------

function editForm(f: Fixture, id: string, walkIn: string): FormData {
  const fd = new FormData();
  fd.set('salesDayId', id);
  fd.set('storeId', f.storeId);
  fd.set('totalSales', '1000.00');
  fd.set('unliSales', '1000.00');
  fd.set('alaCarteSales', '0.00');
  fd.set('cashCollected', '1000.00');
  fd.set(`channel_${f.walkIn}`, walkIn);
  return fd;
}

describe('editSalesDayAction', () => {
  it('a manager fixes the channel: redirect to /sales-days/{id} with no error; the channel now 1,000; the status unchanged — and verify now posts', async () => {
    const f = await fixture('act-edit');
    const id = await mkDay(f, '2026-01-10', '500.00', true);
    ACTOR_HOLDER.actor = f.manager;
    const actions = await load(() => import('../../src/app/sales-days/actions'), 'sales-days/actions.ts');
    const editAction = (actions as unknown as { editSalesDayAction?: (fd: FormData) => Promise<void> }).editSalesDayAction;
    expect(typeof editAction, 'editSalesDayAction is not exported from sales-days/actions.ts').toBe('function');

    const to = await expectRedirectTo(() => editAction!(editForm(f, id, '1000.00')));
    expect(pathOf(to)).toBe(`/sales-days/${id}`);
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(await channelAmount(id, f.walkIn)).toBe('1000.00');
    expect(await dayStatus(id)).toBe('submitted');

    const verifyTo = await expectRedirectTo(() => (actions as unknown as { verifySalesDayAction: (fd: FormData) => Promise<void> }).verifySalesDayAction(editForm(f, id, '1000.00')));
    expect(param(verifyTo, 'error')).toBeNull();
    expect(await dayStatus(id)).toBe('verified');
  });

  it("a staff member's forged edit of a SUBMITTED day is refused with a banner (no id) and changes nothing — control: the manager's edit above", async () => {
    const f = await fixture('act-edit-staff');
    const id = await mkDay(f, '2026-01-10', '500.00', true);
    ACTOR_HOLDER.actor = f.staff;
    const actions = await load(() => import('../../src/app/sales-days/actions'), 'sales-days/actions.ts');
    const editAction = (actions as unknown as { editSalesDayAction?: (fd: FormData) => Promise<void> }).editSalesDayAction;
    expect(typeof editAction, 'editSalesDayAction is not exported from sales-days/actions.ts').toBe('function');

    const to = await expectRedirectTo(() => editAction!(editForm(f, id, '1000.00')));
    expect(pathOf(to)).toBe(`/sales-days/${id}`);
    expect(param(to, 'error'), 'a refusal banner').toBeTruthy();
    expect(param(to, 'error')).not.toMatch(UUID);
    expect(await channelAmount(id, f.walkIn)).toBe('500.00');
  });
});

describe('voidSalesDayAction on an unverified day', () => {
  it('a manager withdraws an OPEN day with a reason: no error banner; the day is voided — control for the staff leg', async () => {
    const f = await fixture('act-void');
    const id = await mkDay(f, '2026-01-10', '500.00');
    ACTOR_HOLDER.actor = f.manager;
    const { voidSalesDayAction } = await load(() => import('../../src/app/sales-days/actions'), 'sales-days/actions.ts');
    const fd = new FormData();
    fd.set('salesDayId', id);
    fd.set('storeId', f.storeId);
    fd.set('reason', 'Typed on the wrong store');

    const to = await expectRedirectTo(() => voidSalesDayAction(fd));
    expect(param(to, 'error'), `refused: ${param(to, 'error')}`).toBeNull();
    expect(await dayStatus(id)).toBe('voided');
  });

  it("a staff member's forged withdraw is refused with a banner (no id); the day stays open", async () => {
    const f = await fixture('act-void-staff');
    const id = await mkDay(f, '2026-01-10', '500.00');
    ACTOR_HOLDER.actor = f.staff;
    const { voidSalesDayAction } = await load(() => import('../../src/app/sales-days/actions'), 'sales-days/actions.ts');
    const fd = new FormData();
    fd.set('salesDayId', id);
    fd.set('storeId', f.storeId);
    fd.set('reason', 'Forged');

    const to = await expectRedirectTo(() => voidSalesDayAction(fd));
    expect(param(to, 'error'), 'a refusal banner').toBeTruthy();
    expect(param(to, 'error')).not.toMatch(UUID);
    expect(await dayStatus(id)).toBe('open');
  });
});

// -----------------------------------------------------------------------------------------------
// S3 AUDIT legs (A, B, E, F) — added after the auditor's findings.
// -----------------------------------------------------------------------------------------------

async function ewallets(f: Fixture) {
  const rows = await sql<{ id: string; name: string }[]>`select id, name from money_accounts where store_id = ${f.storeId} and instrument = 'ewallet' and is_active order by name`;
  if (rows.length < 2) throw new Error(`fixture: expected two ewallet accounts at Lipa, found ${rows.length}`);
  return { w1: rows[0]!, w2: rows[1]! };
}
async function onlineDayWithTender(f: Fixture, date: string, moneyAccountId: string): Promise<string> {
  const { id } = await asOrg(f.orgId, (tx) =>
    createSalesDay(tx, f.staff, {
      storeId: f.storeId, businessDate: date, totalSales: '1000.00', unliSales: '1000.00', alaCarteSales: '0.00', cashCollected: '700.00', onlineCollected: '300.00',
      channels: [{ channelId: f.walkIn, amount: '1000.00' }], tenders: [{ moneyAccountId, amount: '300.00' }],
    }),
  );
  return id;
}
const tenderCount = async (dayId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from sales_day_tenders where sales_day_id = ${dayId}`)[0]!.n);
const daysOn = async (orgId: string, date: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from sales_days where org_id = ${orgId} and business_date = ${date}`)[0]!.n);

function dayForm(f: Fixture, o: { id?: string; date?: string; walkIn?: string; online?: string; tenders?: Record<string, string> }): FormData {
  const fd = new FormData();
  if (o.id) fd.set('salesDayId', o.id);
  fd.set('storeId', f.storeId);
  if (o.date) fd.set('businessDate', o.date);
  fd.set('totalSales', '1000.00');
  fd.set('unliSales', '1000.00');
  fd.set('alaCarteSales', '0.00');
  fd.set('cashCollected', String(1000 - Number(o.online ?? '0')) + '.00');
  fd.set('onlineCollected', o.online ?? '0');
  fd.set(`channel_${f.walkIn}`, o.walkIn ?? '1000.00');
  for (const [id, v] of Object.entries(o.tenders ?? {})) fd.set(`tender_${id}`, v);
  return fd;
}

describe('AUDIT A (web) — tenders', () => {
  it('the edit page shows a RETIRED wallet\'s tender read-only (name and amount, no editable input) and still offers the active wallets as inputs', async () => {
    const f = await fixture('auditA-page');
    const { w1, w2 } = await ewallets(f);
    const id = await onlineDayWithTender(f, '2026-01-10', w1.id);
    await sql`update money_accounts set is_active = false where id = ${w1.id}`;

    const html = await editPage(f.manager, id, { store: f.storeId });
    expect(html, "the retired wallet's name is not shown").toContain(w1.name);
    expect(html, "the retired wallet's amount is not shown").toMatch(/300\.00/);
    const editable = html.match(new RegExp(`<input[^>]*name="tender_${w1.id}"[^>]*>`));
    expect(editable === null || /readonly|disabled/.test(editable[0]), 'the retired wallet is an EDITABLE input').toBe(true);
    expect(html, 'an active wallet is still an input').toContain(`name="tender_${w2.id}"`);
  });

  for (const bad of ['-5', '0']) {
    it(`a tender typed "${bad}" is refused with a banner by BOTH editSalesDayAction and createSalesDayAction (not silently dropped); nothing changes — control: ₱50 saves`, async () => {
      const f = await fixture(`auditA-act-${bad}`);
      const { w1, w2 } = await ewallets(f);
      const id = await onlineDayWithTender(f, '2026-01-10', w1.id);
      const actions = await load(() => import('../../src/app/sales-days/actions'), 'sales-days/actions.ts');
      const { editSalesDayAction, createSalesDayAction } = actions as unknown as { editSalesDayAction: (fd: FormData) => Promise<void>; createSalesDayAction: (fd: FormData) => Promise<void> };

      ACTOR_HOLDER.actor = f.manager;
      const edited = await expectRedirectTo(() => editSalesDayAction(dayForm(f, { id, online: '300.00', tenders: { [w2.id]: bad } })));
      expect(param(edited, 'error'), `an edit with a "${bad}" tender was accepted/dropped silently`).toBeTruthy();
      expect(param(edited, 'error')).not.toMatch(UUID);
      expect(await tenderCount(id)).toBe(1);

      const created = await expectRedirectTo(() => createSalesDayAction(dayForm(f, { date: '2026-01-05', online: '300.00', tenders: { [w2.id]: bad } })));
      expect(param(created, 'error'), `a create with a "${bad}" tender was accepted/dropped silently`).toBeTruthy();
      expect(await daysOn(f.orgId, '2026-01-05'), 'the refused create left a day behind').toBe(0);

      const ok = await expectRedirectTo(() => editSalesDayAction(dayForm(f, { id, online: '350.00', tenders: { [w2.id]: '50.00' } })));
      expect(param(ok, 'error'), `refused: ${param(ok, 'error')}`).toBeNull();
    });
  }
});

describe('AUDIT B (web) — the withdraw panel says the date stays used', () => {
  it('a manager\'s withdraw panel on an open day reads "The date stays used — a new day cannot be entered for {date}."', async () => {
    const f = await fixture('auditB-page');
    const id = await mkDay(f, '2026-01-10', '500.00');
    const html = await detail(f.manager, id, { store: f.storeId });
    expect(html).toMatch(/The date stays used — a new day cannot be entered for [^<]*(2026-01-10|Jan(uary)? 10, 2026)/);
  });
});

describe('AUDIT E (web) — staff cannot reach the edit form of a SUBMITTED day', () => {
  it('a staff GET of /sales-days/{id}/edit for a submitted day renders no edit form (no totalSales input) but does render the page; the manager gets the form (control)', async () => {
    const f = await fixture('auditE-edit');
    const id = await mkDay(f, '2026-01-10', '500.00', true);

    const staff = await editPage(f.staff, id, { store: f.storeId });
    expect(staff, 'the page should still render (a back link)').toMatch(/Back to this day/);
    expect(staff, 'a staff member was handed the edit form of a submitted day').not.toMatch(/name="totalSales"/);

    const manager = await editPage(f.manager, id, { store: f.storeId });
    expect(manager).toMatch(/name="totalSales"/);
  });
});

describe('AUDIT F (I7) — the create-block banner is a plain sentence', () => {
  it('staff creating a newer day over an unverified older one: the banner has no "createSalesDay:" prefix and no "(blocking day" fragment, and names the open date', async () => {
    const f = await fixture('auditF');
    await mkDay(f, '2026-01-10', '500.00'); // unverified -> blocks newer days for staff
    const actions = await load(() => import('../../src/app/sales-days/actions'), 'sales-days/actions.ts');
    const { createSalesDayAction } = actions as unknown as { createSalesDayAction: (fd: FormData) => Promise<void> };

    ACTOR_HOLDER.actor = f.staff;
    const to = await expectRedirectTo(() => createSalesDayAction(dayForm(f, { date: '2026-01-11' })));
    const error = param(to, 'error');
    expect(error, 'the blocked create must show a banner').toBeTruthy();
    expect(error, `raw function prefix on screen: ${error}`).not.toMatch(/createSalesDay:/);
    expect(error, `raw fragment on screen: ${error}`).not.toMatch(/\(blocking day/);
    expect(error).not.toMatch(UUID);
    expect(error, 'the banner must name the open date').toMatch(/2026-01-10|Jan(uary)? 10, 2026/);
    expect(await daysOn(f.orgId, '2026-01-11')).toBe(0);
  });
});
