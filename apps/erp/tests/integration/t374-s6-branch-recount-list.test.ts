import { config } from 'dotenv';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-374 S6 (DEF-574) — the branch's recount list: the repo (`lowStockRepo.branchRecountList`), the page loader/markup
 * (`commissary/discrepancies/page.tsx`) and the real `resolveDiscrepancyAction`. `docs/tasks/374-money-push-follow-ups.md` §S6 T1, T2, T3, T4, T6.
 * ⛔ TESTER, not BUILDER. On HEAD `branchRecountList` does not exist (the repo legs fail "is not a function") and the page lists
 * only `d.store_id = <selected store>` (the page legs fail on the missing section). Spec R6: rows are `direction='over'`, not resolved, whose
 * order's CUSTOMER has `counterparty_store_id` = the store (the gate's definition, `discrepancy.ts:217-223`), never `requested_by_store_id`.
 *
 * Harness from `t369-s6-account-lists-web.test.ts` (session mock, `Page` stub, real `requirePageAccess`-free page render, real domain).
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

import { seedChartOfAccounts } from '../../../../packages/db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../../packages/db/seed/expense-categories';
import { closeDb, transaction, tradeRepo, lowStockRepo, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import { createCustomer, createItem, createTradeOrder, dispatchTradeOrder, receiveTradeOrder, resolveDiscrepancy } from '@shareat/domain';
import { receiveDelivery } from '../../../../packages/domain/src/deliveries/receive';
import { quantity } from '../../../../packages/domain/src/stock/quantity';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
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

// -----------------------------------------------------------------------------------------------
// Fixture — t372-receipt-discrepancy.test.ts's, with TWO branches (br, bq) and per-store people.
// `storeId` is the commissary (dispatching store); `branchId` the branch that RECEIVES and miscounts.
// -----------------------------------------------------------------------------------------------
async function fixture(hint: string) {
  const code = uid(`t374s6-${hint}`);
  const [org] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2026-01-01', '2026-01-31', 'open'), (${orgId}, '2026-02-01', '2026-02-28', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}${++seq}`}) returning id`;
    return s!.id;
  };
  const storeId = await mkStore('com');
  const branchId = await mkStore('br');
  const branch2Id = await mkStore('bq');

  const mkPerson = async (name: string, role: string, stores: string[]) => {
    const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const s of stores) await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${s})`;
    return p!.id;
  };
  const all = [storeId, branchId, branch2Id];
  const superAdminId = await mkPerson('Super', 'super_admin', all);
  const adminId = await mkPerson('Admin', 'admin', all);
  const managerId = await mkPerson('Commissary Manager', 'manager', all);
  const branchManagerId = await mkPerson('Branch Manager', 'manager', [branchId]);
  const branchStaffId = await mkPerson('Branch Staff', 'staff', [branchId]);

  const [locType] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkLocation = async (sId: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${sId}, 'A', 'Stockroom A', ${locType!.id}, 'operating', true, ${superAdminId}) returning id`;
    return row!.id;
  };
  const locationId = await mkLocation(storeId);
  await mkLocation(branchId);
  await mkLocation(branch2Id);
  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, store_id, purpose, storage_path, content_type, byte_size, checksum, uploaded_by)
    values (${orgId}, ${storeId}, 'receipt_photo', ${`orgs/${orgId}/receipt_photo/${uid('f')}.jpg`}, 'image/jpeg', 1024, ${uid('sum')}, ${superAdminId}) returning id`;
  const [names] = await sql<{ com: string; br: string }[]>`
    select (select name from stores where id = ${storeId}) as com, (select name from stores where id = ${branchId}) as br`;

  return {
    orgId, storeId, branchId, branch2Id, locationId, fileId: file!.id, comName: names!.com, brName: names!.br,
    superAdmin: actor(orgId, superAdminId), admin: actor(orgId, adminId), manager: actor(orgId, managerId),
    branchManager: actor(orgId, branchManagerId), branchStaff: actor(orgId, branchStaffId),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stock(f: Fixture, itemId: string, qty: string): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.storeId}, 'purchase', '2026-01-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.storeId, deliveryId: d!.id, deliveredOn: '2026-01-01',
      locations: [{ id: f.locationId, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: '300.0000', locationId: f.locationId }],
    }),
  );
}

/** A dispatched 20-unit order from the commissary to `branch`, received as `received` of 20. Returns the order and its discrepancy row (if any). */
async function orderTo(f: Fixture, branch: string, received: string) {
  const itemId = (await asOrg(f.orgId, (tx) => createItem(tx, f.superAdmin, { code: uid('WS'), name: `Prepped ${uid('n')}`, kind: 'raw_material', baseUnit: 'kg', sellableWholesale: true }))).id;
  await stock(f, itemId, '30');
  await sql`
    insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${branch}, ${itemId}, ${itemId}, ${f.superAdmin.personId})`;
  const customer = await asOrg(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Branch ${uid('c')}`, customerGroup: 'internal', counterpartyStoreId: branch }));
  const order = await asOrg(f.orgId, (tx) =>
    createTradeOrder(tx, f.manager, { storeId: f.storeId, customerId: customer.id, orderDate: '2026-01-10', lines: [{ itemId, quantity: '20', rate: '500' }] }),
  );
  await asOrg(f.orgId, (tx) => dispatchTradeOrder(tx, f.manager, { orderId: order.orderId }));
  const [line] = await asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, order.orderId));
  await asOrg(f.orgId, (tx) =>
    receiveTradeOrder(tx, f.manager, { orderId: order.orderId, receivedOn: '2026-01-15', lines: [{ lineId: line!.id, receivedQuantity: received, ...(Number(received) < 20 ? { shortageReason: 'damaged_in_transit' } : {}) } as never] }),
  );
  const rows = await sql<{ id: string; direction: string; status: string; disposition: string | null; store_id: string }[]>`
    select id, direction, status, disposition, store_id from trade_discrepancies where order_id = ${order.orderId}`;
  return { orderId: order.orderId, itemId, rows, row: rows[0] };
}
const overTo = async (f: Fixture, branch: string) => {
  const o = await orderTo(f, branch, '22');
  if (!o.row || o.row.direction !== 'over') throw new Error('fixture: the over-receipt raised no OVER row');
  return { ...o, row: o.row };
};
const rowState = async (id: string) =>
  (await sql<{ status: string; disposition: string | null }[]>`select status, disposition from trade_discrepancies where id = ${id}`)[0]!;
const journalCount = async (orgId: string) => Number((await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${orgId}`)[0]!.n);

// -----------------------------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------------------------
type ListRow = { id: string; direction?: string; quantity?: string; itemName?: string; orderId?: string } & Record<string, unknown>;
const branchList = (f: Fixture, store: string) =>
  asOrg(f.orgId, async (tx) => {
    const fn = (lowStockRepo as unknown as { branchRecountList?: (t: Tx, o: string, s: string) => Promise<ListRow[]> }).branchRecountList;
    if (typeof fn !== 'function') throw new Error('lowStockRepo.branchRecountList does not exist yet');
    return fn(tx, f.orgId, store);
  });
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function renderPage(who: Actor, store: string): Promise<string> {
  ACTOR_HOLDER.actor = who;
  const { default: Page } = await import('../../src/app/commissary/discrepancies/page');
  return renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ store }) } as never)) as never);
}
const decode = (h: string) => h.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
/** The <form …>…</form> element that carries `needle` (a row id), or null. */
function formWith(html: string, needle: string): string | null {
  const at = html.indexOf(`value="${needle}"`);
  if (at < 0) return null;
  const start = html.lastIndexOf('<form', at);
  const end = html.indexOf('</form>', at);
  return start < 0 || end < 0 ? null : html.slice(start, end + 7);
}
async function expectRedirectTo(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    if (err instanceof RedirectSignal) return err.to;
    throw err;
  }
  throw new Error('expected the action to redirect');
}

// -----------------------------------------------------------------------------------------------

describe('T1 — the branch list: one open over row listed once; short, resolved, and other branches\' rows are not', () => {
  it('lists the branch\'s open over row exactly once with its item, quantity, order and the DISPATCHING store\'s name', async () => {
    const f = await fixture('t1');
    const over = await overTo(f, f.branchId);
    const rows = await branchList(f, f.branchId);
    expect(ids(rows)).toEqual([over.row.id]);
    expect(rows[0]).toMatchObject({ direction: 'over', quantity: '2.000', orderId: over.orderId });
    expect(String(rows[0]!.itemName)).toMatch(/^Prepped /);
    expect(Object.values(rows[0]!), "the row carries the dispatching store's name").toContain(f.comName);
  });

  it('excludes a SHORT row, a RESOLVED over row and another branch\'s over row — positive control: the open over row stays listed beside them', async () => {
    const f = await fixture('t1x');
    const open = await overTo(f, f.branchId);
    const short = await orderTo(f, f.branchId, '18');
    expect(short.row?.direction, 'fixture: a short row').toBe('short');
    const resolvedOne = await overTo(f, f.branchId);
    const resolved = await asOrg(f.orgId, (tx) =>
      resolveDiscrepancy(tx, { orgId: f.orgId, discrepancyId: resolvedOne.row.id, commissaryStoreId: f.storeId, disposition: 'return', note: 'recount', resolvedOn: '2026-01-20', resolvedBy: f.manager.personId } as never),
    );
    expect(resolved.ok, 'fixture: the second over row resolves').toBe(true);
    const otherBranch = await overTo(f, f.branch2Id);

    expect(ids(await branchList(f, f.branchId)), 'br: only its open over row').toEqual([open.row.id]);
    expect(ids(await branchList(f, f.branch2Id)), 'bq: only its own').toEqual([otherBranch.row.id]);
    expect(await branchList(f, f.storeId), 'the dispatching store is nobody\'s branch').toEqual([]);
  });
});

describe('T2 — the definition: the customer\'s counterparty store, not requested_by_store_id', () => {
  it('requested_by_store_id NULL, and requested_by pointing at ANOTHER branch: the row is still the counterparty branch\'s and only its', async () => {
    const f = await fixture('t2');
    const over = await overTo(f, f.branchId);
    await sql`update trade_orders set requested_by_store_id = null where id = ${over.orderId}`;
    expect(ids(await branchList(f, f.branchId)), 'requested_by NULL, counterparty = br').toEqual([over.row.id]);

    await sql`update trade_orders set requested_by_store_id = ${f.branch2Id} where id = ${over.orderId}`;
    expect(ids(await branchList(f, f.branchId)), 'requested_by = bq, counterparty = br: still br\'s').toEqual([over.row.id]);
    expect(await branchList(f, f.branch2Id), 'bq must not be offered a row its gate would refuse').toEqual([]);
  });
});

describe('Page — the second section, the Return form, and nothing else', () => {
  it('as the branch store: heading "Counted over at {store} — recount and return", one Return form (hidden id, storeId = branch, disposition = return), a REQUIRED note, no other disposition, no defer, filter relabelled "Store"', async () => {
    const f = await fixture('page');
    const over = await overTo(f, f.branchId);
    const html = decode(await renderPage(f.branchManager, f.branchId));

    expect(html).toContain(`Counted over at ${f.brName} — recount and return`);
    expect(html).toContain(f.comName); // "from {dispatching store}"
    expect(html).toContain(`/commissary/orders/${over.orderId}`);
    const form = formWith(html, over.row.id);
    expect(form, 'the row has a form').not.toBeNull();
    expect(form).toMatch(/<input[^>]*name="storeId"[^>]*value="[^"]*"|<input[^>]*value="[^"]*"[^>]*name="storeId"/);
    expect(form).toContain(`value="${f.branchId}"`);
    expect(form).toMatch(/<input[^>]*(name="disposition"[^>]*value="return"|value="return"[^>]*name="disposition")/);
    expect(form).toMatch(/<input[^>]*name="resolvedOn"/);
    const noteTag = form!.match(/<input[^>]*name="note"[^>]*>/)?.[0] ?? '';
    expect(noteTag, 'a note input exists').not.toBe('');
    expect(noteTag, 'the note is REQUIRED').toMatch(/\brequired\b/);
    expect(noteTag).toContain('Who carried it back and when, or that you recounted');
    expect(form).toMatch(/>\s*Return\s*</);
    for (const other of ['extra_dispatch', 'loss', 'charge', 'audit', 'late_receipt']) expect(form, `${other} offered to the branch`).not.toContain(other);
    expect(form).not.toContain('<select');
    expect(html, 'no defer for the branch').not.toContain('name="deferredTo"');
    expect(html).not.toContain('Dispatching store');
    expect(html).toMatch(/>\s*Store\s*</);
  });

  it('control: the commissary\'s view of the same row keeps its full form (extra_dispatch offered) and has NO "Counted over at" section', async () => {
    const f = await fixture('pagec');
    const over = await overTo(f, f.branchId);
    const html = decode(await renderPage(f.manager, f.storeId));
    const form = formWith(html, over.row.id);
    expect(form, 'the commissary still sees the row').not.toBeNull();
    expect(form).toContain('extra_dispatch');
    expect(html).not.toContain('Counted over at');
  });

  it('hidden-from: another branch (bq) and an empty branch see neither the section nor the row', async () => {
    const f = await fixture('pageh');
    const over = await overTo(f, f.branchId);
    const html = decode(await renderPage(f.admin, f.branch2Id));
    expect(html).not.toContain('Counted over at');
    expect(html).not.toContain(over.row.id);
  });
});

describe('The action — the listed form, posted for real', () => {
  const form = (f: Fixture, id: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set('id', id);
    fd.set('storeId', f.branchId);
    fd.set('disposition', 'return');
    fd.set('resolvedOn', '2026-01-20');
    fd.set('note', 'Recounted, miscounted at the door');
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    return fd;
  };

  it('T3: branch manager -> resolved as return, no journal entry, the row leaves the list', async () => {
    const f = await fixture('act3');
    const over = await overTo(f, f.branchId);
    expect(ids(await branchList(f, f.branchId))).toEqual([over.row.id]);
    const { resolveDiscrepancyAction } = await import('../../src/app/commissary/discrepancies/actions');
    const before = await journalCount(f.orgId);
    ACTOR_HOLDER.actor = f.branchManager;
    const to = await expectRedirectTo(() => resolveDiscrepancyAction(form(f, over.row.id)));
    expect(new URL(to, 'http://localhost').searchParams.get('error'), `refused: ${to}`).toBeNull();
    expect(await rowState(over.row.id)).toMatchObject({ status: 'resolved', disposition: 'return' });
    expect(await journalCount(f.orgId)).toBe(before);
    expect(await branchList(f, f.branchId)).toEqual([]);
  });

  it('T4 (✗): branch staff -> refused by authorization, the row unchanged; control: the manager then succeeds on the same row', async () => {
    const f = await fixture('act4');
    const over = await overTo(f, f.branchId);
    const { resolveDiscrepancyAction } = await import('../../src/app/commissary/discrepancies/actions');
    ACTOR_HOLDER.actor = f.branchStaff;
    const err = await resolveDiscrepancyAction(form(f, over.row.id)).then(() => null, (e: unknown) => e);
    expect(err, 'branch staff resolved a discrepancy').not.toBeNull();
    expect(await rowState(over.row.id)).toMatchObject({ status: 'open', disposition: null });
    expect(ids(await branchList(f, f.branchId))).toEqual([over.row.id]);

    ACTOR_HOLDER.actor = f.branchManager;
    await expectRedirectTo(() => resolveDiscrepancyAction(form(f, over.row.id)));
    expect(await rowState(over.row.id)).toMatchObject({ status: 'resolved', disposition: 'return' });
  });

  it('T5: a forged extra_dispatch from the branch manager -> redirected back with the domain\'s sentence, nothing posted, row open', async () => {
    const f = await fixture('act5');
    const over = await overTo(f, f.branchId);
    const { resolveDiscrepancyAction } = await import('../../src/app/commissary/discrepancies/actions');
    const before = await journalCount(f.orgId);
    ACTOR_HOLDER.actor = f.branchManager;
    const to = await expectRedirectTo(() => resolveDiscrepancyAction(form(f, over.row.id, { disposition: 'extra_dispatch' })));
    expect(new URL(to, 'http://localhost').searchParams.get('error')).toMatch(/only the dispatching commissary may resolve this/);
    expect(await journalCount(f.orgId)).toBe(before);
    expect(await rowState(over.row.id)).toMatchObject({ status: 'open', disposition: null });
  });
});

describe('T6 (control, green on HEAD) — the commissary\'s list is unchanged', () => {
  it('discrepancyList(commissary) holds the over row and the short row, and nothing of another commissary\'s', async () => {
    const f = await fixture('t6');
    const over = await overTo(f, f.branchId);
    const short = await orderTo(f, f.branchId, '18');
    const rows = await asOrg(f.orgId, (tx) => lowStockRepo.discrepancyList(tx, f.orgId, f.storeId, false));
    expect(ids(rows)).toEqual(ids([{ id: over.row.id }, { id: short.row!.id }]));
    expect(await asOrg(f.orgId, (tx) => lowStockRepo.discrepancyList(tx, f.orgId, f.branchId, false)), 'discrepancyList keys on the dispatching store only').toEqual([]);
  });
});
