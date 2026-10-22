import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-372 S1 / DEF-511 — a prepared (ready) commissary order stays prepared. Once marked ready the
 * packing list is final: fulfilLine and proposeLine refuse, ready_at/ready_by never change, and the
 * order leaves `ready` only by dispatch or by cancel (reject / void).
 *
 * The refusal sentence is asserted as TEXT (the spec's READY_IS_FINAL_SENTENCE), not imported, so a
 * red fails on the behaviour, never on a missing export.
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
  submitOrder,
  branchOrderStage,
  acceptOrder,
  rejectOrder,
  fulfilLine,
  proposeLine,
  decideProposedLine,
  markReady,
  dispatchBranchOrder,
  voidTradeOrder,
} from '@shareat/domain';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

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
      values (${orgId}, ${testItemCode()}, ${name}, 'raw_material', ${unit}, ${superAdmin.personId}) returning id`;
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

  const mkEmploymentAndGrant = async (storeId: string, personId: string) => {
    const [employment] = await sql<{ id: string }[]>`
      insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
      values (${orgId}, ${storeId}, ${personId}, ${`SE-${Date.now()}${Math.floor(Math.random() * 1e6)}${Math.floor(Math.random() * 1e6)}`}, 'regular', '2025-01-01')
      returning id
    `;
    await grantEverydayPositionAccess(sql, {
      orgId, storeId, employmentId: employment!.id, personId, setBy: superAdmin.personId,
    });
  };
  await mkEmploymentAndGrant(br.id, branchStaff.personId);
  await mkEmploymentAndGrant(com.id, comStaff.personId);

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
// The spec's sentence (docs/tasks/372…, R2), asserted as text so a red fails on behaviour.
const READY_IS_FINAL =
  'This order is marked ready, so its packing list is final. It can now only be dispatched, or rejected so the branch can order again.';

async function ready(f: Fixture): Promise<string> {
  const orderId = await accepted(f);
  await asOrg(f.orgId, (tx) => markReady(tx, f.comStaff, { orderId }));
  expect(branchOrderStage(await order(f, orderId))).toBe('ready');
  return orderId;
}

async function readyStamp(orderId: string) {
  const [r] = await sql<{ ready_at: string | null; ready_by: string | null; total_amount: string }[]>`
    select ready_at::text, ready_by::text, total_amount::text from trade_orders where id = ${orderId}`;
  return r!;
}

/** The message a refusal carries to the user (falls back to message for plain errors). */
async function refusal(p: Promise<unknown>): Promise<{ userMessage: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { userMessage?: string; message: string };
    return { userMessage: err.userMessage ?? err.message, message: err.message };
  }
  throw new Error('expected a refusal, but the call resolved');
}

describe('T-372 S1 — a prepared order stays prepared (DEF-511)', () => {
  // Mutant: 'ready' put back in fulfilLine's allowed stages.
  it('R1: fulfilLine at READY is refused with the ready-is-final sentence; stamp, line and total untouched', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    const before = await readyStamp(orderId);
    const [l] = await lines(f, orderId);
    const r = await refusal(asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: l!.id, quantity: '5' })));
    expect(r.userMessage).toBe(READY_IS_FINAL);
    expect(r.message).toMatch(/is ready — ready is final \(DEF-511\)/);
    expect(await readyStamp(orderId)).toEqual(before);
    const after = (await lines(f, orderId))[0]!;
    expect(after.fulfilledQuantity).toBe(l!.fulfilledQuantity);
    expect(after.rate).toBe(l!.rate);
    expect(after.lineTotal).toBe(l!.lineTotal);
    expect(branchOrderStage(await order(f, orderId))).toBe('ready');
  });

  // Mutant: 'ready' put back in proposeLine's allowed stages.
  it('R2: proposeLine at READY is refused with the same sentence; no line, no thread message, stamp unchanged', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    const before = await readyStamp(orderId);
    const nLines = (await lines(f, orderId)).length;
    const nMsgs = (await asOrg(f.orgId, (tx) => lowStockRepo.listMessages(tx, orderId))).length;
    const r = await refusal(asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5' })));
    expect(r.userMessage).toBe(READY_IS_FINAL);
    expect(r.message).toMatch(/is ready — ready is final \(DEF-511\)/);
    expect((await lines(f, orderId)).length).toBe(nLines);
    expect((await asOrg(f.orgId, (tx) => lowStockRepo.listMessages(tx, orderId))).length).toBe(nMsgs);
    expect(await readyStamp(orderId)).toEqual(before);
  });

  // Mutant: the replace-zeroing moved above the stage check.
  it('R3: proposeLine with replacesLineId at READY is refused and does NOT zero the replaced line', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    const [porkLine] = await lines(f, orderId);
    await expect(
      asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5', replacesLineId: porkLine!.id })),
    ).rejects.toThrow();
    const after = (await lines(f, orderId)).find((l) => l.id === porkLine!.id)!;
    expect(after.fulfilledQuantity).toBe(porkLine!.fulfilledQuantity);
    expect(after.fulfilledQuantity).not.toBe('0.000');
    expect(after.lineTotal).toBe(porkLine!.lineTotal);
  });

  // Mutant: the stage check moved above authorize.
  it('R4: a non-holder editing a READY order gets the authorization refusal, not the sentence', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    const [l] = await lines(f, orderId);
    const r = await refusal(asOrg(f.orgId, (tx) => fulfilLine(tx, f.outsider, { orderId, lineId: l!.id, quantity: '5' })));
    expect(r.userMessage).not.toBe(READY_IS_FINAL);
    expect(r.message).toMatch(/no store scope/);
  });

  // Mutant: the refusal widened to 'accepted'.
  it('P1 (control): fulfilLine at ACCEPTED still works; total refreshed; stage stays accepted', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    const [l] = await lines(f, orderId);
    await asOrg(f.orgId, (tx) => fulfilLine(tx, f.comStaff, { orderId, lineId: l!.id, quantity: '5' }));
    const after = (await lines(f, orderId))[0]!;
    expect(after.fulfilledQuantity).toBe('5.000');
    expect((await order(f, orderId)).totalAmount).toBe('1550.00');
    expect(branchOrderStage(await order(f, orderId))).toBe('accepted');
  });

  it('P2 (control): proposeLine at ACCEPTED still works and lands pending', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    const { lineId } = await asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5' }));
    const added = (await lines(f, orderId)).find((l) => l.id === lineId)!;
    expect(added.approval).toBe('pending');
    expect(branchOrderStage(await order(f, orderId))).toBe('accepted');
  });

  // Mutant: the cancel path blocked at ready.
  it('P3 (control): rejecting a READY order still works; ready_at is not touched', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    const before = await readyStamp(orderId);
    await asOrg(f.orgId, (tx) => rejectOrder(tx, f.comStaff, { orderId, reason: 'no truck today' }));
    const o = await order(f, orderId);
    expect(o.status).toBe('void');
    expect(o.rejectedAt).not.toBeNull();
    expect((await readyStamp(orderId)).ready_at).toBe(before.ready_at);
  });

  it('P4 (control): voiding a READY order (branch side) still works', async () => {
    const f = await fixture();
    const orderId = await ready(f);
    await asOrg(f.orgId, (tx) => voidTradeOrder(tx, f.branchStaff, { orderId, reason: 'changed our minds' }));
    expect((await order(f, orderId)).status).toBe('void');
  });

  // Mutant: dispatch blocked at ready.
  it('P5 (control): dispatching a READY order still works', async () => {
    const f = await fixture();
    await stock(f, f.pork, '100');
    const orderId = await ready(f);
    await asOrg(f.orgId, (tx) => dispatchBranchOrder(tx, f.comMgr, { orderId }));
    expect((await order(f, orderId)).status).toBe('dispatched');
  });

  // Mutant: clearReady restored.
  it('P6: tradeRepo no longer exports clearReady', () => {
    expect('markReady' in tradeRepo).toBe(true); // positive control — the check can actually fail
    expect('clearReady' in tradeRepo).toBe(false);
  });

  // markReady can never reach this state itself (it refuses while a proposal is pending, R2
  // above), so the state is built directly: accept, propose (lands pending), then force ready by
  // SQL exactly as tradeRepo.markReady would.
  it('R5: decideProposedLine at READY (forced via a pending-proposal state only SQL can build) is refused', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    const { lineId } = await asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5' }));
    await sql`update trade_orders set ready_by = ${f.comStaff.personId}, ready_at = now(), updated_at = now() where id = ${orderId}`;
    expect(branchOrderStage(await order(f, orderId))).toBe('ready');
    const r = await refusal(
      asOrg(f.orgId, (tx) => decideProposedLine(tx, f.branchStaff, { orderId, lineId, decision: 'approved' })),
    );
    expect(r.userMessage).toBe(READY_IS_FINAL);
    const line = (await lines(f, orderId)).find((l) => l.id === lineId)!;
    expect(line.approval).toBe('pending');
  });

  // Positive control for R5: the same decide, at ACCEPTED (no forced ready), still works.
  it('R5 positive control: decideProposedLine at ACCEPTED still works', async () => {
    const f = await fixture();
    const orderId = await accepted(f);
    const { lineId } = await asOrg(f.orgId, (tx) => proposeLine(tx, f.comStaff, { orderId, itemId: f.sauce, quantity: '5' }));
    await asOrg(f.orgId, (tx) => decideProposedLine(tx, f.branchStaff, { orderId, lineId, decision: 'approved' }));
    const line = (await lines(f, orderId)).find((l) => l.id === lineId)!;
    expect(line.approval).toBe('approved');
  });
});
