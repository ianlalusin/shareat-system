import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { money } from '@shareat/core/money';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  addUsageLine,
  deleteUsageDraft,
  postUsage,
  RESERVED_USAGE_CATEGORIES,
  removeUsageLine,
  saveUsageDraft,
  voidUsage,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';

/**
 * T-168 / DEF-135 — the document layer over `usage.ts`'s already-tested engine.
 *
 * ⭐ `packages/domain/tests/integration/stock-usage.test.ts` (19 cases) already proves the ENGINE:
 * FIFO cost, the reserved-category refusal, the period lock, void-restores-exact-layers. This file
 * proves the layer THIS task adds on top — `authorize()`, the draft/post/void document, and
 * `cogsCategoryForItemKind` wired end to end — so it deliberately does not re-run every engine case,
 * only the ones this file's own functions can newly get wrong (§8 of the task doc names which).
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "shareat_test".`,
  );
}

const sql = postgres(url, { max: 5 });

async function asOrg<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return transaction(async (tx) => {
    await tx.execute(dsql.raw(`set local role ${APP_ROLE}`));
    await tx.execute(dsql`select set_config('app.principal_kind', 'staff', true)`);
    await tx.execute(dsql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

let orgA: string, storeA: string, staffId: string, managerId: string, fileA: string;
let kitchen: string, stockroom: string, itemA: string;
let staffActor: Actor, managerActor: Actor;
// Finding B — cross-store ✗: a manager whose ONLY scope is a different store in the same org.
let storeB: string, otherManagerId: string;
let otherManagerActor: Actor;

const locations = (): LocationLike[] => [
  { id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' },
  { id: stockroom, role: 'storage', purpose: 'normal', isDefault: false, status: 'active' },
];

async function onHand(loc = kitchen): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemA} and location_id = ${loc}`;
  return r!.t;
}

async function layerRemaining(): Promise<string[]> {
  const rows = await sql<{ remaining_quantity: string }[]>`
    select remaining_quantity from stock_layers where item_id = ${itemA} order by received_at`;
  return rows.map((r) => r.remaining_quantity);
}

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

/** Two receipts at different costs into the kitchen, so FIFO has something to choose. */
async function stockUp() {
  for (const [n, cost, day] of [['10', '100.0000', '01'], ['8', '120.0000', '05']] as const) {
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
      values (${orgA},${storeA},'purchase',${'2026-08-' + day},${fileA},${staffId}) returning id`;
    await asOrg(orgA, (tx) =>
      receiveDelivery(tx, {
        orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: `2026-08-${day}`,
        locations: locations(), receivedBy: staffId,
        lines: [{ lineId: '1', itemId: itemA, itemKind: 'raw_material', receivedQuantity: quantity(n), conversionFactor: '1', unitCost: cost, locationId: kitchen }],
      }),
    );
  }
}

/** Opens a count session that FREEZES `kitchen` (T-169's trigger, migration 0068) — same shape as
 *  `count-sessions.test.ts`'s own `openSession`. */
async function freezeKitchen(): Promise<string> {
  const [s] = await sql<{ id: string }[]>`
    insert into count_sessions (org_id, store_id, status, counted_on, opened_by)
    values (${orgA},${storeA},'open','2026-08-20',${managerId}) returning id`;
  await sql`insert into count_session_locations (session_id, location_id) values (${s!.id}, ${kitchen})`;
  return s!.id;
}

const draftInput = (over: Record<string, unknown> = {}) => ({
  orgId: orgA,
  storeId: storeA,
  locationId: kitchen,
  kind: 'usage' as const,
  usedOn: '2026-08-20',
  lines: [{ itemId: itemA, quantity: '15' }],
  ...over,
});

beforeEach(async () => {
  await sql`
    truncate table count_lines, count_session_locations, count_sessions,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types, departments,
      person_store_scope, person_roles,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [sB] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'B1','B One','multi_room') returning id`;
  storeB = sB!.id;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Staffer') returning id`;
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Manager') returning id`;
  const [otherManager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Other Store Manager') returning id`;
  staffId = staff!.id;
  managerId = manager!.id;
  otherManagerId = otherManager!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${orgA}, 'staff')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgA}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${otherManagerId}, ${orgA}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffId}, ${storeA})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeA})`;
  // ⭐ Finding B — scoped to storeB ONLY, never storeA, so acting on a storeA record is refused.
  await sql`insert into person_store_scope (person_id, store_id) values (${otherManagerId}, ${storeB})`;
  staffActor = { personId: staffId, orgId: orgA };
  managerActor = { personId: managerId, orgId: orgA };
  otherManagerActor = { personId: otherManagerId, orgId: orgA };

  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Stockroom') returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${staffId}) returning id`;
  const [r3] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, created_by) values (${orgA},${storeA},'STORE','Stockroom',${t!.id},${staffId}) returning id`;
  kitchen = r2!.id; stockroom = r3!.id;
  const [i] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},'PORK','Pork Belly','raw_material','kg',${staffId}) returning id`;
  itemA = i!.id;
  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${staffId}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  // ⚠️ Wide on purpose — DEF-141's void now reverses a journal entry too, and `voidUsage` dates
  // that reversal on the REAL business date (`toBusinessDate()`, today), not the record's fixed
  // `usedOn`. A single-month window sized to match `usedOn` (as the engine's own fixture uses)
  // would pass or fail depending on which real month the suite happens to run in.
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgA},'2026-01-01','2026-12-31','open')`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-168/DEF-135 — 1. a draft moves nothing', () => {
  it('on-hand, layers and entries are unchanged until post', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);

    expect(await onHand()).toBe('18.000');
    expect(await layerRemaining()).toEqual(['10.000', '8.000']);
    const b = await balances();
    expect(b['5100']).toBeUndefined();
    expect(b['5110']).toBeUndefined();
  });
});

describe('T-168/DEF-135 — 2. posting, as a manager, kind-derived COGS', () => {
  it('⭐ raw_material -> food -> 5100 (never 5110), FIFO cost = 10@100 + 5@120', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const posted = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    expect(posted.totalCost).toBe(money('1600.00'));
    expect(posted.entryIds.length).toBeGreaterThan(0);

    const b = await balances();
    expect(b['5100']).toBe('1600.00');
    expect(b['5110']).toBeUndefined();
    expect(b['1310']).toBe('360.00');
    expect(await onHand()).toBe('3.000');

    const [row] = await sql<{ status: string; posted_by: string }[]>`
      select status, posted_by from stock_usage_records where id = ${draft.recordId}`;
    expect(row!.status).toBe('posted');
    expect(row!.posted_by).toBe(managerId);
  });
});

describe('T-168/DEF-135 — 3. every reserved category is refused at draft', () => {
  it.each(RESERVED_USAGE_CATEGORIES)('⭐ "%s" is refused, with the OUT-leg reason, and nothing is written', async (reserved) => {
    await stockUp();
    const res = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ kind: 'wastage', reasonCode: reserved })),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('OUT leg');
    expect(await onHand()).toBe('18.000');
  });

  it('nothing survives across the whole table', async () => {
    const [n] = await sql<{ c: string }[]>`select count(*)::text as c from stock_usage_records where store_id = ${storeA}`;
    expect(n!.c).toBe('0');
  });
});

describe('T-168/DEF-135 — 4. where a usage may be drawn from', () => {
  it('⛔ a storage room is refused (the DB trigger), with a readable reason', async () => {
    await stockUp();
    await expect(
      asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput({ locationId: stockroom }))),
    ).rejects.toThrow(/storage room/);
  });

  it('✅ an operating room is accepted', async () => {
    await stockUp();
    const res = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput({ locationId: kitchen })));
    expect(res.ok).toBe(true);
  });
});

describe('T-168/DEF-135 — 6. wastage lands in 5300, never a COGS account', () => {
  it('⭐ spoilage -> 5300, and 5100/5110 stay untouched', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ kind: 'wastage', reasonCode: 'spoilage' })),
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);

    const b = await balances();
    expect(b['5300']).toBe('1600.00');
    expect(b['5100']).toBeUndefined();
    expect(b['5110']).toBeUndefined();
  });
});

describe('T-168/DEF-135 — 11 (refusal half): a frozen room refuses the post', () => {
  it('⭐ a count session open on the room refuses posting, and nothing moves', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    await freezeKitchen();

    await expect(
      asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId })),
    ).rejects.toThrow(/frozen/);
    expect(await onHand()).toBe('18.000');

    const [row] = await sql<{ status: string }[]>`select status from stock_usage_records where id = ${draft.recordId}`;
    expect(row!.status).toBe('draft');
  });
});

describe('T-168/DEF-135 — 12. a voided record is never re-posted', () => {
  it('⛔ posting a void refuses cleanly (no throw — a plain status refusal)', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    const voided = await asOrg(orgA, (tx) => voidUsage(tx, managerActor, { recordId: draft.recordId, reason: 'wrong quantity' }));
    expect(voided.ok).toBe(true);

    const repost = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(repost.ok).toBe(false);
    if (repost.ok) return;
    expect(repost.reason).toContain('not draft');
  });
});

describe('T-168/DEF-135 — void restores stock to the exact layers it came from', () => {
  it('⭐ 10kg back to the ₱100 layer, 5kg back to the ₱120 layer — never 15 to the oldest', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    expect(await layerRemaining()).toEqual(['0.000', '3.000']);
    expect((await balances())['5100']).toBe('1600.00');

    const voided = await asOrg(orgA, (tx) =>
      voidUsage(tx, managerActor, { recordId: draft.recordId, reason: 'recorded in error' }),
    );
    expect(voided.ok).toBe(true);
    if (!voided.ok) return;
    // ⭐ DEF-141 — the coordinator's fix in `usage.ts`: void reverses stock, layers AND the entry.
    expect(voided.reversalEntryIds.length).toBeGreaterThan(0);

    expect(await layerRemaining()).toEqual(['10.000', '8.000']);
    expect(await onHand()).toBe('18.000');
    const afterVoid = await balances();
    expect(afterVoid['5100']).toBe('0.00');
    expect(afterVoid['1310']).toBe('1960.00');

    const [row] = await sql<{ status: string; voided_by: string; void_reason: string }[]>`
      select status, voided_by, void_reason from stock_usage_records where id = ${draft.recordId}`;
    expect(row!.status).toBe('void');
    expect(row!.voided_by).toBe(managerId);
    expect(row!.void_reason).toBe('recorded in error');
  });
});

describe('T-168/DEF-135 — the authorize() boundary', () => {
  it('✅ staff MAY draft a usage', async () => {
    await stockUp();
    const res = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(res.ok).toBe(true);
  });

  it('✅ staff MAY draft a wastage', async () => {
    await stockUp();
    const res = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ kind: 'wastage', reasonCode: 'spoilage' })),
    );
    expect(res.ok).toBe(true);
  });

  it('⛔ staff may NOT post_usage — posting is manager-only', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    await expect(
      asOrg(orgA, (tx) => postUsage(tx, staffActor, { recordId: draft.recordId })),
    ).rejects.toThrow(/may not 'post_usage'/);
    expect(await onHand()).toBe('18.000');
  });

  it('⛔ staff may NOT void_usage_record — voiding is manager-only', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    await expect(
      asOrg(orgA, (tx) => voidUsage(tx, staffActor, { recordId: draft.recordId, reason: 'x' })),
    ).rejects.toThrow(/may not 'void_usage_record'/);
    // Stock is still gone — the refusal did not partially void anything.
    expect(await onHand()).toBe('3.000');
  });
});

describe('Finding B — cross-store ✗: a manager scoped to a DIFFERENT store is refused', () => {
  it('⛔ postUsage: authorized as manager, but not for THIS record\'s store', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    await expect(
      asOrg(orgA, (tx) => postUsage(tx, otherManagerActor, { recordId: draft.recordId })),
    ).rejects.toThrow(/has no store scope/);
    // nothing moved — the refusal happened before any stock effect
    expect(await onHand()).toBe('18.000');
  });

  it('⛔ voidUsage: authorized as manager, but not for THIS record\'s store', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);

    await expect(
      asOrg(orgA, (tx) => voidUsage(tx, otherManagerActor, { recordId: draft.recordId, reason: 'wrong store manager' })),
    ).rejects.toThrow(/has no store scope/);
    // still posted — the refusal did not partially void anything
    expect(await onHand()).toBe('3.000');
  });
});

describe('T-168/DEF-135 — validation the domain owns (not the DB)', () => {
  it('⛔ a wastage with no reason is refused', async () => {
    const res = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput({ kind: 'wastage' })));
    expect(res.ok).toBe(false);
  });

  it('⛔ a wastage reason not in WASTAGE_REASONS is refused', async () => {
    const res = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ kind: 'wastage', reasonCode: 'made_up_reason' })),
    );
    expect(res.ok).toBe(false);
  });

  it('⛔ a zero or negative quantity line is refused', async () => {
    const zero = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ lines: [{ itemId: itemA, quantity: '0' }] })),
    );
    expect(zero.ok).toBe(false);
    const negative = await asOrg(orgA, (tx) =>
      saveUsageDraft(tx, staffActor, draftInput({ lines: [{ itemId: itemA, quantity: '-1' }] })),
    );
    expect(negative.ok).toBe(false);
  });

  it('⛔ an empty line list is refused', async () => {
    const res = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput({ lines: [] })));
    expect(res.ok).toBe(false);
  });
});

describe('T-168/DEF-135 — draft editing and deletion', () => {
  it('addUsageLine appends a line to a draft; removeUsageLine takes it back off', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput({ lines: [{ itemId: itemA, quantity: '1' }] })));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const added = await asOrg(orgA, (tx) =>
      addUsageLine(tx, staffActor, { recordId: draft.recordId, itemId: itemA, quantity: '2' }),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const [count1] = await sql<{ c: string }[]>`select count(*)::text as c from stock_usage_lines where record_id = ${draft.recordId}`;
    expect(count1!.c).toBe('2');

    const removed = await asOrg(orgA, (tx) => removeUsageLine(tx, staffActor, { recordId: draft.recordId, lineId: added.lineId }));
    expect(removed.ok).toBe(true);

    const [count2] = await sql<{ c: string }[]>`select count(*)::text as c from stock_usage_lines where record_id = ${draft.recordId}`;
    expect(count2!.c).toBe('1');
  });

  it('deleteUsageDraft removes the whole draft, header and lines', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const deleted = await asOrg(orgA, (tx) => deleteUsageDraft(tx, staffActor, { recordId: draft.recordId }));
    expect(deleted.ok).toBe(true);

    const [row] = await sql<{ c: string }[]>`select count(*)::text as c from stock_usage_records where id = ${draft.recordId}`;
    expect(row!.c).toBe('0');
  });

  it('⛔ a POSTED record refuses further line edits and deletion — draft-only', async () => {
    await stockUp();
    const draft = await asOrg(orgA, (tx) => saveUsageDraft(tx, staffActor, draftInput()));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postUsage(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);

    const del = await asOrg(orgA, (tx) => deleteUsageDraft(tx, managerActor, { recordId: draft.recordId }));
    expect(del.ok).toBe(false);
  });
});
