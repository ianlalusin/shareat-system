import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-172 — the branch order: draft → submit → accept/reject → fulfil (with a proposed substitution
 * the branch approves) → ready → dispatch, and the receipt that closes the loop. DEF-136.
 *
 * ⭐ The test that carries the design is the FULL LOOP at the end: after the branch signs for what
 * arrived, stock has moved at BOTH stores and `1340` is empty. Everything before it is the
 * conversation that gets the goods onto the truck with nothing left to argue about.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { seedExpenseCategories } from '../../../db/seed/expense-categories';
import { closeDb, lowStockRepo, tradeRepo, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  saveBranchOrderDraft,
  addBranchOrderLine,
  updateBranchOrderLine,
  removeBranchOrderLine,
  submitOrder,
  decideProposedLine,
  branchOrderStage,
  orderableCatalogue,
  resolveBranchRate,
  normaliseRate,
  acceptOrder,
  rejectOrder,
  fulfilLine,
  proposeLine,
  markReady,
  dispatchBranchOrder,
  receiveTradeOrder,
  voidTradeOrder,
  setItemPricing,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';

const sql = postgres(url, { max: 5 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

const actor = (orgId: string, personId: string): Actor => ({ personId, orgId });

/**
 * One org, a commissary (COM) and a branch (BR), a third store nobody on the order holds, and one
 * person per (role, side) — because invariant 10 is about WHICH STORE a capability resolves at,
 * the fixture needs people who hold exactly one side.
 */
async function fixture() {
  const code = uid('bo');
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = org!.id;
  await seedChartOfAccounts(sql, orgId);
  await seedExpenseCategories(sql, orgId);
  await sql`
    insert into fiscal_periods (org_id, starts_on, ends_on, status) values
      (${orgId}, '2026-07-01', '2026-07-31', 'closed'),
      (${orgId}, '2026-08-01', '2026-08-31', 'open')`;

  const mkStore = async (label: string) => {
    const [s] = await sql<{ id: string; code: string }[]>`
      insert into stores (org_id, code, name, stock_model)
      values (${orgId}, ${uid(label)}, ${`Store ${label}`}, 'multi_room') returning id, code`;
    return s!;
  };
  const com = await mkStore('com');
  const br = await mkStore('br');
  const other = await mkStore('other');

  const mkPerson = async (name: string, role: string, scopes: string[]) => {
    const [p] = await sql<{ id: string }[]>`
      insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
    for (const storeId of scopes) {
      await sql`insert into person_store_scope (person_id, store_id) values (${p!.id}, ${storeId})`;
    }
    return actor(orgId, p!.id);
  };
  const superAdmin = await mkPerson('Super', 'super_admin', [com.id, br.id, other.id]);
  const admin = await mkPerson('Admin', 'admin', [com.id, br.id]);
  const branchStaff = await mkPerson('Branch cook', 'staff', [br.id]);
  const branchMgr = await mkPerson('Branch manager', 'manager', [br.id]);
  const comStaff = await mkPerson('Commissary packer', 'staff', [com.id]);
  const comMgr = await mkPerson('Commissary manager', 'manager', [com.id]);
  const outsider = await mkPerson('Someone else', 'manager', [other.id]);

  const [locType] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const mkRoom = async (storeId: string, roomCode: string, isDefault: boolean) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgId}, ${storeId}, ${roomCode}, ${roomCode}, ${locType!.id}, 'operating', ${isDefault}, ${superAdmin.personId})
      returning id`;
    return r!.id;
  };
  const comKitchen = await mkRoom(com.id, 'KIT', true);
  const comDry = await mkRoom(com.id, 'DRY', false);
  const brKitchen = await mkRoom(br.id, 'KIT', true);

  const mkItem = async (name: string, unit = 'kg') => {
    const [i] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${uid('I')}, ${name}, 'raw_material', ${unit}, ${superAdmin.personId}) returning id`;
    return i!.id;
  };
  const pork = await mkItem('Pork belly');
  const porkBr = await mkItem('Pork belly (branch)');
  const sauce = await mkItem('Bulgogi sauce');
  const sauceBr = await mkItem('Bulgogi sauce (branch)');
  const unmapped = await mkItem('Unmapped thing');
  const unpriced = await mkItem('Unpriced thing');

  await sql`
    insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by)
    values (${orgId}, ${com.id}, ${br.id}, ${superAdmin.personId})`;
  for (const [item, cost] of [[pork, '310.0000'], [sauce, '95.0000'], [unmapped, '10.0000']] as const) {
    await sql`
      insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by)
      values (${orgId}, ${com.id}, ${item}, ${cost}, ${superAdmin.personId})`;
  }
  // Offered, but with no cost of any kind — T-171 §5's "priced: false".
  await sql`
    insert into commissary_item_offerings (org_id, commissary_store_id, item_id, created_by)
    values (${orgId}, ${com.id}, ${unpriced}, ${superAdmin.personId})`;

  const [cst] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
    values (${orgId}, ${`Store br (internal) ${code}`}, 'internal', ${br.id}, ${superAdmin.personId}) returning id`;
  const [cogs] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and "group" = 'COGS' order by category limit 1`;
  const [cogs2] = await sql<{ id: string }[]>`
    select id from expense_categories where org_id = ${orgId} and "group" = 'COGS' order by category offset 1 limit 1`;

  const mapRow = async (from: string, to: string, category: string | null, ledgerOnly = false) => {
    await sql`
      insert into commissary_item_map (org_id, commissary_store_id, branch_store_id, commissary_item_id, branch_item_id, is_ledger_only, expense_category_id, created_by)
      values (${orgId}, ${com.id}, ${br.id}, ${from}, ${to}, ${ledgerOnly}, ${category}, ${superAdmin.personId})`;
  };
  await mapRow(pork, porkBr, cogs!.id);
  await mapRow(sauce, sauceBr, cogs!.id);

  const [file] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgId}, ${'orgs/' + orgId + '/p.jpg'}, 'image/jpeg', 10, ${uid('x')}, 'receipt_photo', ${superAdmin.personId}) returning id`;

  return {
    orgId, com, br, other, comKitchen, comDry, brKitchen,
    pork, porkBr, sauce, sauceBr, unmapped, unpriced,
    customerId: cst!.id, cogs: cogs!.id, cogs2: cogs2!.id, fileId: file!.id,
    superAdmin, admin, branchStaff, branchMgr, comStaff, comMgr, outsider, mapRow,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Real stock at the commissary — through `receiveDelivery`, the same path a real receipt takes. */
async function stock(f: Fixture, itemId: string, qty: string, cost = '300.0000', locationId = f.comKitchen): Promise<void> {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${f.orgId}, ${f.com.id}, 'purchase', '2026-08-01', ${f.fileId}, ${f.superAdmin.personId}) returning id`;
  const res = await asOrg(f.orgId, (tx) =>
    receiveDelivery(tx, {
      orgId: f.orgId, storeId: f.com.id, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: [
        { id: f.comKitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
        { id: f.comDry, role: 'operating', purpose: 'normal', isDefault: false, status: 'active' },
      ],
      receivedBy: f.superAdmin.personId,
      lines: [{ lineId: '1', itemId, itemKind: 'raw_material', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId }],
    }),
  );
  if (!res.ok) throw new Error(res.reason);
}

async function onHand(itemId: string, storeId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements where item_id = ${itemId} and store_id = ${storeId}`;
  return r!.t;
}

async function balances(orgId: string, storeId: string): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgId} and l.store_id = ${storeId} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

async function order(f: Fixture, id: string) {
  return (await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, id)))!;
}
async function lines(f: Fixture, id: string) {
  return asOrg(f.orgId, (tx) => tradeRepo.linesFor(tx, f.orgId, id));
}

const draftInput = (f: Fixture, lines: { itemId: string; quantity: string; rate?: string }[] = [{ itemId: f.pork, quantity: '20' }]) => ({
  branchStoreId: f.br.id, commissaryStoreId: f.com.id, orderDate: '2026-08-20', lines,
});

/** Draft → submit → accept, as the two staff members — the state most tests start from. */
async function accepted(f: Fixture, lineInput?: { itemId: string; quantity: string; rate?: string }[]): Promise<string> {
  const { orderId } = await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f, lineInput)));
  await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
  await asOrg(f.orgId, (tx) => acceptOrder(tx, f.comStaff, { orderId }));
  return orderId;
}

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

// ================================================================================================

describe('T-172 — the draft, and what a branch may put on it', () => {
  it('a branch cook drafts from the catalogue; the rate is resolved and CAPTURED, the map previewed', async () => {
    const f = await fixture();
    const { orderId, totalAmount } = await asOrg(f.orgId, (tx) =>
      saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)),
    );
    const o = await order(f, orderId);
    expect(o.status).toBe('draft');
    expect(branchOrderStage(o)).toBe('draft');
    expect(o.requestedByStoreId).toBe(f.br.id);
    expect(o.storeId).toBe(f.com.id);
    // 20 kg × ₱310 (the offering's manual cost — no branch-price rule exists yet).
    expect(totalAmount).toBe('6200.00');

    const [l] = await lines(f, orderId);
    expect(l!.requestedQuantity).toBe('20.000');
    expect(l!.fulfilledQuantity).toBeNull();
    expect(l!.rate).toBe('310.00');
    expect(l!.origin).toBe('requested');
    expect(l!.approval).toBe('not_required');
    // The map is previewed onto the draft so the screen can show what submit will demand.
    expect(l!.expenseCategoryId).toBe(f.cogs);
  });

  it('⭐ a stated rate wins over the branch price — and survives the pricing rule changing (invariant 11)', async () => {
    const f = await fixture();
    await asOrg(f.orgId, (tx) => setItemPricing(tx, f.admin, { itemId: f.pork, pricingMode: 'fixed', fixedAmount: '350' }));
    // No rate stated: the branch-price RULE (tier 1) beats the offering's manual cost (tier 3).
    const resolved = await asOrg(f.orgId, (tx) => resolveBranchRate(tx, f.orgId, f.com.id, f.pork));
    expect(resolved).toEqual({ rate: '350.00', from: 'branch_price' });

    const { orderId } = await asOrg(f.orgId, (tx) =>
      saveBranchOrderDraft(tx, f.branchStaff, draftInput(f, [{ itemId: f.pork, quantity: '10', rate: '320' }])),
    );
    await asOrg(f.orgId, (tx) => setItemPricing(tx, f.admin, { itemId: f.pork, pricingMode: 'fixed', fixedAmount: '400' }));
    const [l] = await lines(f, orderId);
    expect(l!.rate).toBe('320.00');
    expect(l!.lineTotal).toBe('3200.00');
  });

  it('⛔ an unpriced item is refused by name — never a ₱0 line (T-171 §5)', async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f, [{ itemId: f.unpriced, quantity: '1' }]))),
    ).rejects.toThrow(/Unpriced thing cannot be priced/);
    const catalogue = await asOrg(f.orgId, (tx) => orderableCatalogue(tx, f.orgId, f.com.id, f.br.id));
    const line = catalogue.find((c) => c.commissaryItemId === f.unpriced)!;
    expect(line.priced).toBe(false);
    expect(line.price).toBeNull();
    // And the catalogue says what submit will refuse, before anybody drafts.
    expect(catalogue.find((c) => c.commissaryItemId === f.unmapped)!.blocker).toMatch(/not mapped/);
    expect(catalogue.find((c) => c.commissaryItemId === f.pork)!.submittable).toBe(true);
  });

  it('⛔ an item the commissary does not OFFER is refused', async () => {
    const f = await fixture();
    await expect(
      asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f, [{ itemId: f.porkBr, quantity: '1' }]))),
    ).rejects.toThrow(/not on the commissary.s catalogue/);
  });

  it('lines are added, changed and removed on a draft — and frozen after submit', async () => {
    const f = await fixture();
    const { orderId } = await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
    const { lineId } = await asOrg(f.orgId, (tx) => addBranchOrderLine(tx, f.branchStaff, { orderId, itemId: f.sauce, quantity: '4' }));
    expect((await order(f, orderId)).totalAmount).toBe('6580.00'); // 6200 + 4 × 95

    await asOrg(f.orgId, (tx) => updateBranchOrderLine(tx, f.branchStaff, { orderId, lineId, quantity: '6' }));
    expect((await order(f, orderId)).totalAmount).toBe('6770.00');

    // The same item twice — the domain names it; the partial unique index would refuse it anyway.
    await expect(
      asOrg(f.orgId, (tx) => addBranchOrderLine(tx, f.branchStaff, { orderId, itemId: f.sauce, quantity: '1' })),
    ).rejects.toThrow(/already on this order/);

    await asOrg(f.orgId, (tx) => removeBranchOrderLine(tx, f.branchStaff, { orderId, lineId }));
    expect((await order(f, orderId)).totalAmount).toBe('6200.00');

    await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
    const [l] = await lines(f, orderId);
    await expect(
      asOrg(f.orgId, (tx) => updateBranchOrderLine(tx, f.branchStaff, { orderId, lineId: l!.id, quantity: '99' })),
    ).rejects.toThrow(/frozen after submit/);
    await expect(
      asOrg(f.orgId, (tx) => removeBranchOrderLine(tx, f.branchStaff, { orderId, lineId: l!.id })),
    ).rejects.toThrow(/cannot be removed after submit/);
  });
});

// ================================================================================================

describe('T-172 — submit, and invariant 2’s pre-submit hardening', () => {
  it('⛔ test 1: a line with no map is refused NAMING THE ITEM; the same line ledger-only submits', async () => {
    const f = await fixture();
    const { orderId } = await asOrg(f.orgId, (tx) =>
      saveBranchOrderDraft(tx, f.branchStaff, draftInput(f, [{ itemId: f.pork, quantity: '5' }, { itemId: f.unmapped, quantity: '2' }])),
    );
    await expect(asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }))).rejects.toThrow(
      /Unmapped thing: not mapped/,
    );
    expect((await order(f, orderId)).status).toBe('draft');

    // The explicit ledger-only decision, with no category, is enough — the receipt moves no stock
    // for it and has nothing to post against.
    await f.mapRow(f.unmapped, f.porkBr, null, true);
    await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
    const o = await order(f, orderId);
    expect(o.status).toBe('confirmed');
    expect(branchOrderStage(o)).toBe('submitted');
    const captured = (await lines(f, orderId)).find((l) => l.itemId === f.unmapped)!;
    expect(captured.isLedgerOnly).toBe(true);
  });

  it('⛔ test 2 + 16: a mapped line with NO expense category is refused — and the trigger says so by id if the domain is bypassed', async () => {
    const f = await fixture();
    await f.mapRow(f.unmapped, f.porkBr, null);
    const { orderId } = await asOrg(f.orgId, (tx) =>
      saveBranchOrderDraft(tx, f.branchStaff, draftInput(f, [{ itemId: f.unmapped, quantity: '2' }])),
    );
    await expect(asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }))).rejects.toThrow(
      /Unmapped thing: its map has no expense category/,
    );
    // ⚠️ The DATABASE refuses the same thing — `trade_orders_submit_hardening` (0070), so a caller
    // that skipped `submitOrder` gets the same answer with a line id instead of a name.
    await expect(sql`update trade_orders set status = 'confirmed' where id = ${orderId}`).rejects.toThrow(
      /has no expense category/,
    );
  });

  it('⭐ test 16: the category is CAPTURED at submit — a later map edit does not reach the order', async () => {
    const f = await fixture();
    const { orderId } = await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
    await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
    await sql`update commissary_item_map set expense_category_id = ${f.cogs2} where commissary_item_id = ${f.pork}`;
    const [l] = await lines(f, orderId);
    expect(l!.expenseCategoryId).toBe(f.cogs);
  });

  it('⛔ test 3: a second open order for the same pair is refused — by the domain, and by the DATABASE', async () => {
    const f = await fixture();
    const { orderId } = await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
    await expect(asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)))).rejects.toThrow(
      /already has an open order/,
    );
    await expect(sql`
      insert into trade_orders (org_id, store_id, customer_id, order_date, status, total_amount, requested_by_store_id, created_by)
      values (${f.orgId}, ${f.com.id}, ${f.customerId}, '2026-08-21', 'draft', 1, ${f.br.id}, ${f.branchStaff.personId})
    `).rejects.toThrow(/trade_orders_one_open_per_branch_key/);

    // Only received / rejected / cancelled free the branch — voiding this one does.
    await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.branchStaff, { orderId, reason: 'changed our minds' }));
    expect(branchOrderStage(await order(f, orderId))).toBe('cancelled');
    await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
  });
});

// ================================================================================================

describe('T-172 — accept, reject, fulfil', () => {
  it('⭐ test 4: accept seeds fulfilled from requested on EVERY line', async () => {
    const f = await fixture();
    const orderId = await accepted(f, [{ itemId: f.pork, quantity: '20' }, { itemId: f.sauce, quantity: '3' }]);
    const o = await order(f, orderId);
    expect(branchOrderStage(o)).toBe('accepted');
    expect(o.acceptedBy).toBe(f.comStaff.personId);
    for (const l of await lines(f, orderId)) expect(l.fulfilledQuantity).toBe(l.requestedQuantity);
  });

  it('reject voids the order with the reason, posts nothing, and frees the branch to order again', async () => {
    const f = await fixture();
    const { orderId } = await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
    await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
    await expect(asOrg(f.orgId, (tx) => rejectOrder(tx, f.comStaff, { orderId, reason: '  ' }))).rejects.toThrow(/say why/);
    await asOrg(f.orgId, (tx) => rejectOrder(tx, f.comStaff, { orderId, reason: 'no pork this week' }));
    const o = await order(f, orderId);
    expect(o.status).toBe('void');
    expect(branchOrderStage(o)).toBe('rejected');
    expect(o.rejectReason).toBe('no pork this week');
    expect(o.journalEntryId).toBeNull();
    const [n] = await sql<{ c: string }[]>`select count(*)::text c from journal_entries where org_id = ${f.orgId}`;
    expect(n!.c).toBe('0');
    // The reason is on the thread, where the branch reads it.
    const thread = await asOrg(f.orgId, (tx) => lowStockRepo.listMessages(tx, orderId));
    expect(thread.map((m) => m.body).join(' ')).toContain('no pork this week');
    await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
  });

  it('fulfilment sets quantity, rate and room per line; ZERO is "none of this"; the total follows what will be SENT', async () => {
    const f = await fixture();
    const orderId = await accepted(f, [{ itemId: f.pork, quantity: '20' }, { itemId: f.sauce, quantity: '3' }]);
    const [porkLine, sauceLine] = (await lines(f, orderId)).sort((a, b) => (a.itemId === f.pork ? -1 : 1));

    await asOrg(f.orgId, (tx) =>
      fulfilLine(tx, f.comStaff, { orderId, lineId: porkLine!.id, quantity: '18', rate: '315', sourceLocationId: f.comDry }),
    );
    await asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: sauceLine!.id, quantity: '0' }));

    const after = await lines(f, orderId);
    const p = after.find((l) => l.id === porkLine!.id)!;
    const s = after.find((l) => l.id === sauceLine!.id)!;
    expect(p.fulfilledQuantity).toBe('18.000');
    expect(p.requestedQuantity).toBe('20.000'); // the ask is the record of what was wanted
    expect(p.rate).toBe('315.00');
    expect(p.lineTotal).toBe('5670.00');
    expect(p.sourceLocationId).toBe(f.comDry);
    expect(s.fulfilledQuantity).toBe('0.000');
    expect(s.lineTotal).toBe('0.00'); // migration 0121: representable, and only for a zero fulfilment
    expect((await order(f, orderId)).totalAmount).toBe('5670.00');

    await expect(
      asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: porkLine!.id, quantity: '1', sourceLocationId: f.brKitchen })),
    ).rejects.toThrow(/not one of the commissary.s active rooms/);
  });

  it('⛔ a zero line_total is refused by the DATABASE unless the fulfilment is zero', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    const [l] = await lines(f, orderId);
    await expect(sql`update trade_order_lines set line_total = 0 where id = ${l!.id}`).rejects.toThrow(
      /trade_order_lines_total_positive_check/,
    );
    await expect(sql`update trade_order_lines set requested_quantity = 0 where id = ${l!.id}`).rejects.toThrow(
      /trade_order_lines_requested_quantity_check/,
    );
  });
});

// ================================================================================================

describe('T-172 — ⭐ invariant 5: a proposed line counts for NOTHING until the branch says so', () => {
  it('test 5: pending → total unchanged and ready refused; approved → both true', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    expect((await order(f, orderId)).totalAmount).toBe('6200.00');

    const { lineId } = await asOrg(f.orgId, (tx) =>
      proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5', note: 'goes well with the pork' }),
    );
    const proposed = (await lines(f, orderId)).find((l) => l.id === lineId)!;
    expect(proposed.origin).toBe('commissary_added');
    expect(proposed.approval).toBe('pending');
    expect(proposed.requestedQuantity).toBeNull();
    expect(proposed.fulfilledQuantity).toBe('5.000');
    expect(proposed.lineTotal).toBe('475.00');
    // ⭐ Not in the total.
    expect((await order(f, orderId)).totalAmount).toBe('6200.00');
    // ⭐ Not ready.
    await expect(asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }))).rejects.toThrow(/still await the branch/);
    // ⭐ And the database refuses the truck too, even if the domain were bypassed.
    await sql`update trade_orders set ready_at = now(), ready_by = ${f.comStaff.personId} where id = ${orderId}`;
    await expect(sql`update trade_orders set status = 'dispatched' where id = ${orderId}`).rejects.toThrow(
      /awaiting the branch decision/,
    );
    await sql`update trade_orders set ready_at = null, ready_by = null where id = ${orderId}`;

    await asOrg(f.orgId, (tx) => decideProposedLine(tx, f.branchStaff, { orderId, lineId, decision: 'approved' }));
    expect((await lines(f, orderId)).find((l) => l.id === lineId)!.approval).toBe('approved');
    expect((await order(f, orderId)).totalAmount).toBe('6675.00');
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    expect(branchOrderStage(await order(f, orderId))).toBe('ready');

    // ⭐ The total's SQL filter and the domain's `lineCounts` agree — asserted, not assumed.
    const all = await lines(f, orderId);
    const counted = all.filter(tradeRepo.lineCounts).reduce((n, l) => n + Number(l.lineTotal), 0);
    expect(counted.toFixed(2)).toBe((await order(f, orderId)).totalAmount);
  });

  it('⛔ test 6: approving a proposed line with no map is refused; rejecting zero-fulfils it', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    const { lineId } = await asOrg(f.orgId, (tx) =>
      proposeLine(tx, f.comStaff, { orderId, itemId: f.unmapped, quantity: '2' }),
    );
    await expect(
      asOrg(f.orgId, (tx) => decideProposedLine(tx, f.branchStaff, { orderId, lineId, decision: 'approved' })),
    ).rejects.toThrow(/map Unmapped thing to one of this branch.s items/);

    await asOrg(f.orgId, (tx) => decideProposedLine(tx, f.branchStaff, { orderId, lineId, decision: 'rejected' }));
    const rejected = (await lines(f, orderId)).find((l) => l.id === lineId)!;
    expect(rejected.approval).toBe('rejected');
    expect(rejected.fulfilledQuantity).toBe('0.000');
    expect(rejected.lineTotal).toBe('0.00');
    // Declined, so a second proposal of the same item is allowed; an edit of the declined one is not.
    await expect(
      asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId, quantity: '1' })),
    ).rejects.toThrow(/declined that line/);
    await asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.unmapped, quantity: '1' }));
  });

  it('a substitution zero-fulfils the line it replaces, and any change after READY drops the order back to accepted', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    const [porkLine] = await lines(f, orderId);

    await asOrg(f.orgId, (tx) =>
      proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5', replacesLineId: porkLine!.id }),
    );
    const o = await order(f, orderId);
    expect(branchOrderStage(o)).toBe('accepted');
    expect(o.readyAt).toBeNull();
    const original = (await lines(f, orderId)).find((l) => l.id === porkLine!.id)!;
    expect(original.fulfilledQuantity).toBe('0.000');
    expect(original.requestedQuantity).toBe('20.000');
    expect(o.totalAmount).toBe('0.01'); // nothing counted yet — the placeholder the CHECK demands

    const thread = await asOrg(f.orgId, (tx) => lowStockRepo.listMessages(tx, orderId));
    expect(thread.at(-1)!.body).toMatch(/Proposed 5.000 kg Bulgogi sauce.*to replace Pork belly/);
  });

  it('ready is refused when nothing at all would go', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    const [l] = await lines(f, orderId);
    await asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: l!.id, quantity: '0' }));
    await expect(asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }))).rejects.toThrow(/nothing would be sent/);
  });
});

// ================================================================================================

describe('T-172 — ⭐ invariant 10: two roles, one document, each field has one owner', () => {
  it('test 11: a branch-only user cannot fulfil; a commissary-only user cannot edit the ask, submit, or decide', async () => {
    const f = await fixture();
    const { orderId } = await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
    const [l] = await lines(f, orderId);

    // The commissary's people, on the branch's fields.
    await expect(
      asOrg(f.orgId, (tx) => updateBranchOrderLine(tx, f.comMgr, { orderId, lineId: l!.id, quantity: '5' })),
    ).rejects.toThrow(/no store scope/);
    await expect(asOrg(f.orgId, (tx) => submitOrder(tx, f.comMgr, { orderId }))).rejects.toThrow(/no store scope/);

    await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
    // The branch's people, on the commissary's fields.
    await expect(asOrg(f.orgId, (tx) => acceptOrder(tx, f.branchMgr, { orderId }))).rejects.toThrow(/no store scope/);
    await asOrg(f.orgId, (tx) => acceptOrder(tx, f.comStaff, { orderId }));
    await expect(
      asOrg(f.orgId, (tx) => fulfilLine(tx, f.branchMgr, { orderId, lineId: l!.id, quantity: '5' })),
    ).rejects.toThrow(/no store scope/);
    await expect(
      asOrg(f.orgId, (tx) => proposeLine(tx, f.branchMgr, { orderId, itemId: f.sauce, quantity: '1' })),
    ).rejects.toThrow(/no store scope/);
    await expect(asOrg(f.orgId, (tx) => markReady(tx, f.branchMgr, { orderId }))).rejects.toThrow(/no store scope/);

    const { lineId } = await asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '1' }));
    await expect(
      asOrg(f.orgId, (tx) => decideProposedLine(tx, f.comMgr, { orderId, lineId, decision: 'approved' })),
    ).rejects.toThrow(/no store scope/);
    // And a third store is nobody on this order.
    await expect(asOrg(f.orgId, (tx) => markReady(tx, f.outsider, { orderId }))).rejects.toThrow(/no store scope/);
  });

  it('⛔ dispatch is manager+ (the posting event); packing is staff-open; the branch cannot dispatch at all', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    const orderId = await accepted(f);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await expect(asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comStaff, { orderId }))).rejects.toThrow(
      /may not 'dispatch_branch_order'/,
    );
    await expect(asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.branchMgr, { orderId }))).rejects.toThrow(/no store scope/);
    const res = await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    expect(res.treatment).toBe('internal');
  });

  it('withdrawing before dispatch is EITHER side’s; after dispatch it is the dispatcher’s', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    const orderId = await accepted(f);
    await expect(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.outsider, { orderId, reason: 'x' }))).rejects.toThrow(/no store scope/);
    await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.comStaff, { orderId, reason: 'cannot fill it' }));
    expect(branchOrderStage(await order(f, orderId))).toBe('cancelled');

    const second = await accepted(f);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId: second }));
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId: second }));
    await expect(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.branchMgr, { orderId: second, reason: 'x' }))).rejects.toThrow(
      /no store scope/,
    );
    await expect(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.comStaff, { orderId: second, reason: 'x' }))).rejects.toThrow(
      /may not 'dispatch_branch_order'/,
    );
  });
});

// ================================================================================================

describe('T-172 — dispatch: the gate that fails CLOSED, and the posting to 1340', () => {
  it('⛔ a branch order goes out READY or not at all — domain and database both', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    const orderId = await accepted(f);
    await expect(asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }))).rejects.toThrow(/order is accepted/);
    await expect(sql`update trade_orders set status = 'dispatched' where id = ${orderId}`).rejects.toThrow(
      /only after the commissary marks it ready/,
    );
  });

  it('⛔ test 7: 20 asked, 18 on hand — refused; an UNTRACKED item — refused (fail closed)', async () => {
    const f = await fixture();
    await stock(f, f.pork, '18');
    const orderId = await accepted(f);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await expect(asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }))).rejects.toThrow(
      /cannot dispatch more than the commissary holds/,
    );
    expect(await onHand(f.pork, f.com.id)).toBe('18.000');

    // Untracked: the sauce was never received anywhere at the commissary.
    const [l] = await lines(f, orderId);
    await asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: l!.id, quantity: '10' }));
    const { lineId } = await asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '1' }));
    await asOrg(f.orgId, (tx) => decideProposedLine(tx, f.branchStaff, { orderId, lineId, decision: 'approved' }));
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await expect(asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }))).rejects.toThrow(/no tracked balance/);
  });

  it('⭐ test 8: dispatch moves stock off the shelf and posts Dr 1340 / Cr 1310 at FIFO cost — nothing crosses to the branch', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100', '300.0000');
    const orderId = await accepted(f);
    const [l] = await lines(f, orderId);
    // 18 of the 20, from the dry store — which is where the gate must NOT look alone (T-165: the
    // gate is per item, store-wide; the RELIEF is from the room the line names).
    await stock(f, f.pork, '30', '300.0000', f.comDry);
    await asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: l!.id, quantity: '18', sourceLocationId: f.comDry }));
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));

    const res = await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    expect(res.chargeId).toBeNull();
    const com = await balances(f.orgId, f.com.id);
    expect(com['1340']).toBe('5400.00');
    expect(com['1310']).toBe('33600.00'); // 39,000 received − 5,400 out
    expect(com['1250']).toBeUndefined();
    expect(com['2150']).toBeUndefined();
    expect(Object.keys(await balances(f.orgId, f.br.id))).toHaveLength(0);
    expect(await onHand(f.pork, f.com.id)).toBe('112.000');
    const [room] = await sql<{ t: string }[]>`
      select coalesce(sum(quantity),0)::text t from stock_movements where item_id = ${f.pork} and location_id = ${f.comDry}`;
    expect(room!.t).toBe('12.000');
    const after = (await lines(f, orderId))[0]!;
    expect(after.dispatchCost).toBe('5400.00');
    expect(branchOrderStage(await order(f, orderId))).toBe('dispatched');
  });

  it('⛔ test 13: dispatch into a CLOSED period is refused', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    const { orderId } = await asOrg(f.orgId, (tx) =>
      saveBranchOrderDraft(tx, f.branchStaff, { ...draftInput(f), orderDate: '2026-07-15' }),
    );
    await asOrg(f.orgId, (tx) => submitOrder(tx, f.branchStaff, { orderId }));
    await asOrg(f.orgId, (tx) => acceptOrder(tx, f.comStaff, { orderId }));
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await expect(asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }))).rejects.toThrow(/closed|period/i);
    expect(await onHand(f.pork, f.com.id)).toBe('100.000');
  });

  it('⭐ test 9: void after dispatch reverses the 1340 entry and returns the stock to its layers', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    const orderId = await accepted(f);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    expect(await onHand(f.pork, f.com.id)).toBe('80.000');

    const res = await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.comMgr, { orderId, reason: 'truck never left' }));
    expect(res.reversedEntryId).not.toBeNull();
    const com = await balances(f.orgId, f.com.id);
    expect(com['1340']).toBe('0.00');
    expect(com['1310']).toBe('30000.00');
    expect(await onHand(f.pork, f.com.id)).toBe('100.000');
    expect(branchOrderStage(await order(f, orderId))).toBe('cancelled');
  });
});

// ================================================================================================

describe('T-172/T-173 — ⭐ the full loop, and the fail-direction asymmetry', () => {
  it('draft → submit → accept → fulfil → propose → approve → ready → dispatch → receive: stock moves at BOTH stores', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100', '300.0000');
    await stock(f, f.sauce, '10', '80.0000');

    const orderId = await accepted(f);
    const [porkLine] = await lines(f, orderId);
    await asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: porkLine!.id, quantity: '18' }));
    const { lineId } = await asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5' }));
    await asOrg(f.orgId, (tx) => decideProposedLine(tx, f.branchStaff, { orderId, lineId, decision: 'approved' }));
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));

    // In transit: 18 × ₱300 + 5 × ₱80 = ₱5,800 at COST.
    let com = await balances(f.orgId, f.com.id);
    expect(com['1340']).toBe('5800.00');
    expect(await onHand(f.pork, f.com.id)).toBe('82.000');
    expect(await onHand(f.sauce, f.com.id)).toBe('5.000');
    // ⚠️ The branch has NO tracked balance of either item — the receipt must fail OPEN (test 15).
    expect(await onHand(f.porkBr, f.br.id)).toBe('0');

    // The branch cook signs for all of it — `confirm_receipt` at the BRANCH, staff-open.
    const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.branchStaff, { orderId, receivedOn: '2026-08-21' }));
    expect(received.entryId).not.toBeNull();

    com = await balances(f.orgId, f.com.id);
    const br = await balances(f.orgId, f.br.id);
    // Transfer value: 18 × ₱310 + 5 × ₱95 = ₱6,055. Margin ₱255 to 5175. 1340 relieved at cost.
    expect(com['1340']).toBe('0.00');
    expect(com['1250']).toBe('6055.00');
    expect(com['5175']).toBe('-255.00');
    expect(br['1310']).toBe('6055.00');
    expect(br['2150']).toBe('-6055.00');
    // ⭐ Stock moved at BOTH stores, into the BRANCH's own items via the map.
    expect(await onHand(f.porkBr, f.br.id)).toBe('18.000');
    expect(await onHand(f.sauceBr, f.br.id)).toBe('5.000');
    expect(await onHand(f.pork, f.br.id)).toBe('0');
    const o = await order(f, orderId);
    expect(branchOrderStage(o)).toBe('received');
    expect(o.receivedBy).toBe(f.branchStaff.personId);
    const [rec] = await sql<{ c: string }[]>`select count(*)::text c from trade_discrepancies where order_id = ${orderId}`;
    expect(rec!.c).toBe('0');

    // ⛔ test 10: void after receipt is refused.
    await expect(asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.comMgr, { orderId, reason: 'x' }))).rejects.toThrow(
      /already been received/,
    );
    // And the branch may order again.
    await asOrg(f.orgId, (tx) => saveBranchOrderDraft(tx, f.branchStaff, draftInput(f)));
  });

  it('⭐ test 15: an UNTRACKED item is refused at DISPATCH and accepted at RECEIPT — both halves, one test', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    // Half one: the commissary never received any pork. Fail CLOSED — the commissary fixes its data.
    await expect(asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }))).rejects.toThrow(/no tracked balance/);
    await stock(f, f.pork, '20');
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    // Half two: the branch has never tracked its pork. Fail OPEN — the goods are on its floor.
    expect(await onHand(f.porkBr, f.br.id)).toBe('0');
    const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.branchStaff, { orderId, receivedOn: '2026-08-21' }));
    expect(received.entryId).not.toBeNull();
    expect(await onHand(f.porkBr, f.br.id)).toBe('20.000');
  });

  it('a ledger-only line moves NO branch stock; a zero-fulfilled line is neither dispatched nor received', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    await stock(f, f.unmapped, '10', '10.0000');
    await f.mapRow(f.unmapped, f.porkBr, null, true);
    const orderId = await accepted(f, [{ itemId: f.pork, quantity: '20' }, { itemId: f.unmapped, quantity: '2' }, { itemId: f.sauce, quantity: '3' }]);
    const sauceLine = (await lines(f, orderId)).find((l) => l.itemId === f.sauce)!;
    await asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: sauceLine.id, quantity: '0' }));
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    // The sauce was never on the truck — no cost, no movement.
    expect((await lines(f, orderId)).find((l) => l.id === sauceLine.id)!.dispatchCost).toBeNull();
    expect(await onHand(f.sauce, f.com.id)).toBe('0');
    expect(await onHand(f.unmapped, f.com.id)).toBe('8.000');

    await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.branchStaff, { orderId, receivedOn: '2026-08-21' }));
    expect(await onHand(f.porkBr, f.br.id)).toBe('20.000'); // the ledger-only line did NOT add to pork (branch)
    const br = await balances(f.orgId, f.br.id);
    expect(br['1310']).toBe('6200.00'); // 20 × ₱310; the ₱20 ledger-only line posts nothing at the branch
    // ⚠️ Its cost is still stranded in 1340 — a ledger-only line is the commissary's to write off.
    expect((await balances(f.orgId, f.com.id))['1340']).toBe('20.00');
  });

  it('⭐ DEF-140: two commissary items mapped to ONE branch item are both received — one movement per LINE', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100', '300.0000');
    await stock(f, f.sauce, '10', '80.0000');
    // The sauce arrives at the branch as PORK too — a slab and its trimmed cut both received as
    // "pork belly" is the everyday shape of this. Found live on 9008 on 2026-09-03: the second
    // line's movement violated `stock_movements_source_pair_key` and the whole receipt rolled back.
    await sql`update commissary_item_map set branch_item_id = ${f.porkBr} where commissary_item_id = ${f.sauce}`;
    const orderId = await accepted(f, [{ itemId: f.pork, quantity: '8' }, { itemId: f.sauce, quantity: '5' }]);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    const received = await asOrg(f.orgId, (tx) => receiveTradeOrder(tx, f.branchStaff, { orderId, receivedOn: '2026-08-21' }));
    expect(received.entryId).not.toBeNull();
    expect(await onHand(f.porkBr, f.br.id)).toBe('13.000');
    const [n] = await sql<{ c: string }[]>`
      select count(*)::text c from stock_movements where store_id = ${f.br.id} and source_type = 'trade_order_receipt'`;
    expect(n!.c).toBe('2');
    // Two layers at two rates — never one merged layer at a made-up cost.
    const layers = await sql<{ unit_cost: string; quantity: string }[]>`
      select unit_cost::text, quantity::text from stock_layers where store_id = ${f.br.id} and item_id = ${f.porkBr}`;
    expect(layers.map((l) => `${l.quantity}@${l.unit_cost}`).sort()).toEqual(['5.000@95.0000', '8.000@310.0000']);
  });

  it('a short receipt raises a discrepancy and leaves the rest in 1340 — the T-174 seam, reached from the order', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    const orderId = await accepted(f);
    await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    const [l] = await lines(f, orderId);
    await asOrg(f.orgId, (tx) =>
      receiveTradeOrder(tx, f.branchStaff, {
        orderId, receivedOn: '2026-08-21',
        lines: [{ lineId: l!.id, receivedQuantity: '15', shortageReason: 'damaged_in_transit' }],
      }),
    );
    expect(await onHand(f.porkBr, f.br.id)).toBe('15.000');
    expect((await balances(f.orgId, f.com.id))['1340']).toBe('1500.00');
    const [d] = await sql<{ quantity: string; status: string }[]>`
      select quantity::text, status from trade_discrepancies where order_id = ${orderId}`;
    expect(d!.quantity).toBe('5.000');
    expect(d!.status).not.toBe('resolved');
  });
});

describe('T-172 — rate normalisation is integer arithmetic', () => {
  it('rounds half-up to the centavo, never through a float', () => {
    expect(normaliseRate('310', 'x')).toBe('310.00');
    expect(normaliseRate('310.0000', 'x')).toBe('310.00');
    expect(normaliseRate('1.235', 'x')).toBe('1.24');
    expect(normaliseRate('1.2349', 'x')).toBe('1.23');
    expect(normaliseRate('0.005', 'x')).toBe('0.01');
    expect(() => normaliseRate('-1', 'x')).toThrow(/not a rate/);
    expect(() => normaliseRate('abc', 'x')).toThrow(/not a rate/);
  });
});
