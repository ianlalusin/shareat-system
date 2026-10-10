import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, lowStockRepo, withOrgPrincipal } from '@shareat/db';
import { decimal } from '@shareat/core/money';
import { ensureAutoOrderLines, replenishAfterUsage, suggestFor } from '../../src/commissary/auto-order';
import { listOrderMessages, postOrderMessage } from '../../src/commissary/messages';
import { quantity } from '../../src/stock/quantity';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-175 — low stock becomes an order, and the order has a conversation.
 *
 * ⭐ The reorder model is deliberately smaller than v1's data model implies: `itemReorderPolicies`
 * and `reorderAlerts` are dead schema there, and the live mechanism is one threshold field plus a
 * summed-on-read query. These tests exercise that, and nothing more.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');

const sql = postgres(url, { max: 3 });

let orgA: string, commissary: string, branch: string, other: string;
let personA: string, comKitchen: string, brKitchen: string;
let pork: string, sauce: string, customerId: string;

async function stock(storeId: string, locationId: string, itemId: string, qty: string): Promise<void> {
  await sql`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${orgA},${storeId},${locationId},${itemId}, now(), ${qty}, 'receipt', 'test', ${crypto.randomUUID()}, ${personA})`;
}

async function threshold(storeId: string, itemId: string, value: string): Promise<void> {
  await withOrgPrincipal(orgA, (tx) =>
    lowStockRepo.setThreshold(tx, { orgId: orgA, storeId, itemId, threshold: decimal(value, '14,3'), setBy: personA }),
  );
}

const autoOrder = (over: Record<string, unknown> = {}) =>
  withOrgPrincipal(orgA, (tx) =>
    ensureAutoOrderLines(tx, {
      orgId: orgA, branchStoreId: branch, customerId, orderedOn: '2026-08-25',
      createdBy: personA, ...over,
    }),
  );

beforeEach(async () => {
  await sql`
    truncate table trade_order_messages, store_item_thresholds, trade_discrepancies,
      commissary_item_map, commissary_item_offerings, commissary_links,
      trade_order_lines, trade_orders, customers, expense_categories,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const mk = async (code: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name, stock_model) values (${orgA},${code},${code},'multi_room') returning id`;
    return r!.id;
  };
  commissary = await mk('COM'); branch = await mk('BR'); other = await mk('OTHER');
  const [p] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Alice') returning id`;
  personA = p!.id;
  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const mkLoc = async (storeId: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by)
      values (${orgA},${storeId},'KIT','Kitchen',${t!.id},'operating',true,${personA}) returning id`;
    return r!.id;
  };
  comKitchen = await mkLoc(commissary); brKitchen = await mkLoc(branch);
  const mkItem = async (code: string, name: string) => {
    const [r] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgA},${testItemCode()},${name},'raw_material','kg',${personA}) returning id`;
    return r!.id;
  };
  pork = await mkItem('PORK', 'Pork'); sauce = await mkItem('SAUCE', 'Bulgogi sauce');

  await sql`
    insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by)
    values (${orgA},${commissary},${branch},${personA})`;
  for (const [item, cost] of [[pork, '310.0000'], [sauce, '95.0000']] as const) {
    await sql`
      insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by)
      values (${orgA},${commissary},${item},${cost},${personA})`;
  }
  const [cst] = await sql<{ id: string }[]>`
    insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
    values (${orgA},'Branch','internal',${branch},${personA}) returning id`;
  customerId = cst!.id;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-175 — low stock is a QUERY, not a list somebody maintains', () => {
  it('returns items at or below threshold, worst shortfall first', async () => {
    await stock(branch, brKitchen, pork, '5');
    await stock(branch, brKitchen, sauce, '18');
    await threshold(branch, pork, '20');
    await threshold(branch, sauce, '20');

    const rows = await withOrgPrincipal(orgA, (tx) => lowStockRepo.lowStock(tx, orgA, branch));
    expect(rows.map((r) => r.itemName)).toEqual(['Pork', 'Bulgogi sauce']);
    expect(rows[0]!.shortfall).toBe('15.000');
    expect(rows[1]!.shortfall).toBe('2.000');
  });

  it('an item ABOVE its threshold does not appear; exactly AT it does', async () => {
    await stock(branch, brKitchen, pork, '25');
    await stock(branch, brKitchen, sauce, '20');
    await threshold(branch, pork, '20');
    await threshold(branch, sauce, '20');

    const rows = await withOrgPrincipal(orgA, (tx) => lowStockRepo.lowStock(tx, orgA, branch));
    // ⚠️ "At or below" — v1's comparison, kept. An item sitting exactly on its threshold is the
    // moment to order, not the moment after.
    expect(rows.map((r) => r.itemName)).toEqual(['Bulgogi sauce']);
  });

  it('⭐ sums ACROSS the store’s rooms before comparing', async () => {
    const [t2] = await sql<{ id: string }[]>`
      insert into stock_locations (org_id, store_id, code, name, type_id, role, created_by)
      select ${orgA},${branch},'DRY','Dry store', type_id,'operating',${personA}
      from stock_locations where id = ${brKitchen} returning id`;
    await stock(branch, brKitchen, pork, '12');
    await stock(branch, t2!.id, pork, '12');
    await threshold(branch, pork, '20');

    // 24 kg across two rooms is not low stock. ⛔ A per-room comparison would cry low twice while
    // a shelf next door is full.
    const rows = await withOrgPrincipal(orgA, (tx) => lowStockRepo.lowStock(tx, orgA, branch));
    expect(rows).toHaveLength(0);
  });

  it('⚠️ an item with NO threshold never appears — it is a finding, not a low-stock row', async () => {
    await stock(branch, brKitchen, pork, '0.5');
    const rows = await withOrgPrincipal(orgA, (tx) => lowStockRepo.lowStock(tx, orgA, branch));
    expect(rows).toHaveLength(0);

    // ⭐ This is the replacement for v1's forcing function, which blocked a usage post until
    // somebody filled the setting in. It nags a manager instead of blocking a cook at 11pm.
    const missing = await withOrgPrincipal(orgA, (tx) => lowStockRepo.itemsWithoutThreshold(tx, orgA, branch));
    expect(missing.map((m) => m.itemName)).toContain('Pork');
  });

  it('a threshold of ZERO is a real setting — “tell me when it runs out”', async () => {
    // ⚠️ No movement at all — `stock_movements_quantity_not_zero_check` refuses a zero-quantity
    // row, and rightly: "nothing happened" is not an event. On-hand zero is the ABSENCE of rows.
    await threshold(branch, pork, '0');
    const rows = await withOrgPrincipal(orgA, (tx) => lowStockRepo.lowStock(tx, orgA, branch));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shortfall).toBe('0.000');
  });
});

describe('T-175 — ⭐ the suggested quantity, and why it is not v1’s zero', () => {
  it('rounds UP to a whole base unit', () => {
    // Ordering 3.4 kg of pork is not a thing anybody does, and a suggestion that has to be
    // rounded by hand is a suggestion that gets retyped.
    expect(suggestFor('3.400')).toBe(quantity('4'));
    expect(suggestFor('4.000')).toBe(quantity('4'));
    expect(suggestFor('0.001')).toBe(quantity('1'));
    expect(suggestFor('0')).toBe(quantity('0'));
  });

  it('⭐ appends a line carrying the suggestion, priced — never a ₱0 line', async () => {
    await stock(branch, brKitchen, pork, '4.5');
    await threshold(branch, pork, '20');

    const res = await autoOrder();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.appended).toHaveLength(1);
    expect(res.appended[0]!.suggested).toBe(quantity('16'));

    const [l] = await sql<{ suggested_quantity: string; requested_quantity: string; rate: string; line_total: string }[]>`
      select suggested_quantity, requested_quantity, rate, line_total from trade_order_lines`;
    expect(l!.suggested_quantity).toBe('16.000');
    // ⚠️ The requested quantity starts EQUAL to the suggestion — the branch accepts by doing
    // nothing, which is the whole improvement over a zero-quantity line.
    expect(l!.requested_quantity).toBe('16.000');
    expect(l!.line_total).toBe('4960.00');
  });

  it('⛔ an item the commissary has no price for is NOT added, and says so', async () => {
    const [nameless] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgA},${testItemCode()},'Unpriced thing','raw_material','kg',${personA}) returning id`;
    await threshold(branch, nameless!.id, '10');

    const res = await autoOrder();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.appended).toHaveLength(0);
    // A ₱0 line becomes a ₱0 order becomes a ₱0 receivable, and nobody notices until month end.
    expect(res.notes.join(' ')).toContain('no price');
  });
});

describe('T-175 — the order it drafts into', () => {
  it('creates a draft when there is none, and appends to it the second time', async () => {
    await stock(branch, brKitchen, pork, '4');
    await stock(branch, brKitchen, sauce, '1');
    await threshold(branch, pork, '20');

    const first = await autoOrder();
    expect(first.ok && first.created).toBe(true);
    if (!first.ok) return;

    await threshold(branch, sauce, '10');
    const second = await autoOrder();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.orderId).toBe(first.orderId);
    expect(second.appended).toHaveLength(1);

    const [n] = await sql<{ c: string }[]>`select count(*)::text c from trade_orders`;
    expect(n!.c).toBe('1');
  });

  it('⭐ the same item twice appends NOTHING — idempotent per (order, item)', async () => {
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');
    await autoOrder();
    const again = await autoOrder();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.appended).toHaveLength(0);
    expect(again.skipped).toHaveLength(1);

    const [n] = await sql<{ c: string }[]>`select count(*)::text c from trade_order_lines`;
    expect(n!.c).toBe('1');
  });

  it('⭐ a hand-edited quantity SURVIVES a later run', async () => {
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');
    await autoOrder();
    await sql`update trade_order_lines set requested_quantity = 50, quantity = 50`;
    await autoOrder();
    const [l] = await sql<{ requested_quantity: string; suggested_quantity: string }[]>`
      select requested_quantity, suggested_quantity from trade_order_lines`;
    expect(l!.requested_quantity).toBe('50.000');
    // ⚠️ The suggestion is a record of what was PROPOSED and is never refreshed. A number that
    // silently changes under somebody filling in a form is worse than a stale one.
    expect(l!.suggested_quantity).toBe('16.000');
  });

  it('⛔ never a second order while one is DISPATCHED — and it says why', async () => {
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');
    const first = await autoOrder();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // ⭐ Submitting needs an expense category on every line — `trade_orders_submit_hardening`, and
    // it fired here first, which is the guard doing its job on a machine-made line.
    const [cat] = await sql<{ id: string }[]>`
      insert into expense_categories (org_id, "group", category, account_code)
      values (${orgA},'COGS','Meat','5110') returning id`;
    await sql`update trade_order_lines set expense_category_id = ${cat!.id}`;
    await sql`update trade_orders set status = 'confirmed' where id = ${first.orderId}`;

    await stock(branch, brKitchen, sauce, '1');
    await threshold(branch, sauce, '10');
    const second = await autoOrder();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.appended).toHaveLength(0);
    expect(second.notes.join(' ')).toContain('not a draft');
    const [n] = await sql<{ c: string }[]>`select count(*)::text c from trade_orders`;
    expect(n!.c).toBe('1');
  });

  it('⛔ a store with no commissary link never auto-orders', async () => {
    const res = await withOrgPrincipal(orgA, (tx) =>
      ensureAutoOrderLines(tx, {
        orgId: orgA, branchStoreId: commissary, customerId, orderedOn: '2026-08-25', createdBy: personA,
      }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // A commissary restocks from suppliers through T-166, by a human.
    expect(res.reason).toContain('not a buyer store');
  });
});

describe('T-175 — ⭐ the order thread, and it is append-only', () => {
  async function anOrder(): Promise<string> {
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');
    const res = await autoOrder();
    if (!res.ok || !res.orderId) throw new Error('no order');
    return res.orderId;
  }

  it('either store can post and read', async () => {
    const orderId = await anOrder();
    const fromBranch = await withOrgPrincipal(orgA, (tx) =>
      postOrderMessage(tx, { orgId: orgA, orderId, body: 'two crates were short', authorId: personA, actorStoreIds: [branch] }),
    );
    expect(fromBranch.ok).toBe(true);
    const fromCommissary = await withOrgPrincipal(orgA, (tx) =>
      postOrderMessage(tx, { orgId: orgA, orderId, body: 'checking with the driver', authorId: personA, actorStoreIds: [commissary] }),
    );
    expect(fromCommissary.ok).toBe(true);

    const read = await withOrgPrincipal(orgA, (tx) => listOrderMessages(tx, { orderId, actorStoreIds: [branch] }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.messages.map((m) => m.body)).toEqual(['two crates were short', 'checking with the driver']);
  });

  it('⛔ a third store can neither post nor read', async () => {
    const orderId = await anOrder();
    const posted = await withOrgPrincipal(orgA, (tx) =>
      postOrderMessage(tx, { orgId: orgA, orderId, body: 'hello', authorId: personA, actorStoreIds: [other] }),
    );
    expect(posted.ok).toBe(false);
    const read = await withOrgPrincipal(orgA, (tx) => listOrderMessages(tx, { orderId, actorStoreIds: [other] }));
    expect(read.ok).toBe(false);
  });

  it('⛔ UPDATE and DELETE raise, in raw SQL', async () => {
    const orderId = await anOrder();
    await withOrgPrincipal(orgA, (tx) =>
      postOrderMessage(tx, { orgId: orgA, orderId, body: 'the crate was short', authorId: personA, actorStoreIds: [branch] }),
    );
    // ⚠️ An editable audit trail is not one — and this is the trail of a commercial conversation
    // between two stores, where the reason a line changed is the thing worth keeping.
    await expect(sql`update trade_order_messages set body = 'it was fine actually'`).rejects.toThrow(/append-only/);
    await expect(sql`delete from trade_order_messages`).rejects.toThrow(/append-only/);
  });

  it('an empty or whitespace-only message is refused before it reaches the table', async () => {
    const orderId = await anOrder();
    const res = await withOrgPrincipal(orgA, (tx) =>
      postOrderMessage(tx, { orgId: orgA, orderId, body: '   ', authorId: personA, actorStoreIds: [branch] }),
    );
    expect(res.ok).toBe(false);
  });
});

describe('T-223 / DEF-186 — the caller the auto-order never had', () => {
  it('⭐ resolves the counterparty customer itself when the caller has only the store', async () => {
    // ⛔ THE change that makes wiring possible. The real caller is an ERP action that has just
    // committed a usage post: it holds `storeId`, not `customerId`, and must not open a transaction
    // of its own to go looking — the whole point is that it runs AFTER the commit.
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');

    const res = await replenishAfterUsage({
      orgId: orgA, branchStoreId: branch, orderedOn: '2026-08-25', createdBy: personA,
      // ⭐ customerId deliberately omitted.
    });

    expect(res.failed).toBeNull();
    expect(res.appended).toHaveLength(1);
    expect(res.orderId).not.toBeNull();

    // ⚠️ And it resolved to the SAME counterparty an explicit call would have used — a different
    // customer would bill the wrong party for the branch's stock.
    const [ord] = await sql<{ customer_id: string }[]>`
      select customer_id from trade_orders where id = ${res.orderId!}`;
    expect(ord!.customer_id).toBe(customerId);
  });

  it('⚠️ a store with no counterparty customer is a REPORT, not a throw', async () => {
    // A store that is linked to a commissary but has no customer record cannot be billed for an
    // internal order. ⛔ That is a note, exactly like "not a buyer store" — never an exception that
    // would reach a caller who has already committed a usage post.
    const [orphan] = await sql<{ id: string }[]>`
      insert into stores (org_id, code, name) values (${orgA}, ${'ORPH-' + Date.now()}, 'Orphan Branch') returning id`;
    await sql`
      insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by)
      values (${orgA}, ${commissary}, ${orphan!.id}, ${personA})`;

    const res = await replenishAfterUsage({
      orgId: orgA, branchStoreId: orphan!.id, orderedOn: '2026-08-25', createdBy: personA,
    });

    expect(res.failed).toBeNull();
    expect(res.notes.join(' ')).toMatch(/counterparty customer/);
    expect(res.orderId).toBeNull();
  });

  it('⚠️ an explicit customerId still wins — the resolution is a fallback, not an override', async () => {
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');
    const res = await replenishAfterUsage({
      orgId: orgA, branchStoreId: branch, customerId, orderedOn: '2026-08-25', createdBy: personA,
    });
    expect(res.failed).toBeNull();
    expect(res.appended).toHaveLength(1);
  });
});

describe('T-175 — ⭐ invariant 8: the ordering subsystem can fail without costing a usage post', () => {
  it('a broken auto-order reports its failure and throws NOTHING', async () => {
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');

    // ⚠️ A customer id that does not exist — the FK refuses the draft. Standing in for any real
    // failure of the ordering path: a deadlock, a missing link, a price row someone deleted.
    const res = await replenishAfterUsage({
      orgId: orgA, branchStoreId: branch, customerId: crypto.randomUUID(),
      orderedOn: '2026-08-25', createdBy: personA,
    });

    // ⭐ It came BACK. It did not throw, so a caller that just committed a usage post is unaffected
    // — which is the whole invariant: *a cook must be able to record what they used even when the
    // ordering subsystem is down.*
    expect(res.failed).not.toBeNull();
    expect(res.orderId).toBeNull();
    expect(res.appended).toHaveLength(0);

    // ⛔ And nothing half-made was left behind — the failed transaction rolled itself back.
    const [n] = await sql<{ c: string }[]>`select count(*)::text c from trade_orders`;
    expect(n!.c).toBe('0');

    // ⚠️ The signal is not lost: the item is still on the low-stock list, and a manager still sees
    // it. What was lost is a convenience, not information.
    const rows = await withOrgPrincipal(orgA, (tx) => lowStockRepo.lowStock(tx, orgA, branch));
    expect(rows).toHaveLength(1);
  });

  it('and a SUCCESSFUL run through the same wrapper reports no failure', async () => {
    await stock(branch, brKitchen, pork, '4');
    await threshold(branch, pork, '20');
    const res = await replenishAfterUsage({
      orgId: orgA, branchStoreId: branch, customerId, orderedOn: '2026-08-25', createdBy: personA,
    });
    expect(res.failed).toBeNull();
    expect(res.appended).toHaveLength(1);
  });

  it('⚠️ a store with no commissary link is a REPORT, not a failure — most stores are not buyers', async () => {
    const res = await replenishAfterUsage({
      orgId: orgA, branchStoreId: commissary, customerId, orderedOn: '2026-08-25', createdBy: personA,
    });
    expect(res.failed).toBeNull();
    expect(res.notes.join(' ')).toContain('not a buyer store');
  });
});
