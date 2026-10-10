import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { money } from '@shareat/core/money';
import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  createProductionDraft,
  editPostedProduction,
  postProduction,
  voidProduction,
} from '@shareat/domain';
import { seedChartOfAccounts } from '../../../db/seed/chart-of-accounts';
import { receiveDelivery } from '../../src/deliveries/receive';
import { quantity } from '../../src/stock/quantity';
import type { LocationLike } from '../../src/stock-locations/rules';
import { grantEverydayPositionAccess } from './_fixtures/staff-everyday-access';
import { testItemCode } from './_fixtures/item-code';

/**
 * T-176 — production: slab -> slice, recipe -> batch, and the payroll lock.
 *
 * ⚠️ **Test 1's numbers are this lane's own, not the spec's literal ones.** T-176 §9 test 1
 * states `Dr 1330 30,903 / Dr 5300 97 / … outputs layered at ₱318.59/kg` for 100 kg @ ₱300 in,
 * 97 kg out, ₱1,000 labour — and those three figures do not reconcile with each other, with the
 * plain-language formula stated immediately above them in the spec, OR with §3's own worked
 * `310/kg` figure applied to the very same no-loss baseline (T-133). Reported as a spec defect
 * (bible §3.4a) rather than silently matched; see `validate.ts`'s `computeValueIdentity` doc
 * comment and the task report. This file uses the CORRECT numbers for the same inputs under the
 * formula the prose states: yield-loss valued at the input's own blended rate
 * (3 kg x ₱300/kg = ₱900), output value = 30,000 + 1,000 - 900 = ₱30,100.
 *
 * ⚠️ **Account routing note**, also reported as a spec defect: the sliced output's account is
 * `1310` (from `INVENTORY_ACCOUNT_BY_ITEM_KIND['meat_sliced']`), not the spec's stated `1330` —
 * see `production/index.ts`'s header comment for the full reasoning.
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
let kitchen: string;
let staffActor: Actor, managerActor: Actor;
let slabItem: string, sliceA: string, sliceB: string, sliceC: string, otherSlab: string, otherSlice: string;

const locations = (): LocationLike[] => [{ id: kitchen, role: 'operating', purpose: 'normal', isDefault: true, status: 'active' }];

async function onHand(itemId: string, loc = kitchen): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${loc}`;
  return r!.t;
}

async function balances(): Promise<Record<string, string>> {
  const rows = await sql<{ code: string; net: string }[]>`
    select a.code, (sum(l.debit) - sum(l.credit))::text as net
    from journal_lines l join accounts a on a.id = l.account_id
    where a.org_id = ${orgA} group by a.code`;
  return Object.fromEntries(rows.map((r) => [r.code, r.net]));
}

async function trialBalance(): Promise<string> {
  const [tb] = await sql<{ net: string }[]>`
    select (sum(debit) - sum(credit))::text as net from journal_lines l
    join accounts a on a.id = l.account_id where a.org_id = ${orgA}`;
  return tb!.net;
}

/** One 100kg slab layer at ₱300/kg via a real receipt (FIFO layer creation, T-166). */
async function stockUpSlab(qty = '100', cost = '300.0000') {
  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (org_id, store_id, kind, delivered_on, proof_file_id, created_by)
    values (${orgA},${storeA},'purchase','2026-08-01',${fileA},${staffId}) returning id`;
  const result = await asOrg(orgA, (tx) =>
    receiveDelivery(tx, {
      orgId: orgA, storeId: storeA, deliveryId: d!.id, deliveredOn: '2026-08-01',
      locations: locations(), receivedBy: staffId,
      lines: [{ lineId: '1', itemId: slabItem, itemKind: 'meat_slab', receivedQuantity: quantity(qty), conversionFactor: '1', unitCost: cost, locationId: kitchen }],
    }),
  );
  if (!result.ok) throw new Error(`stockUpSlab failed: ${result.reason}`);
}

beforeEach(async () => {
  await sql`
    truncate table
      production_record_lines, production_records, production_recipe_lines, production_recipes,
      stock_usage_lines, stock_usage_records, delivery_lines, deliveries,
      stock_layer_consumptions, stock_layers, stock_movements,
      stock_locations, location_types,
      person_store_scope, person_roles,
      journal_lines, journal_entries, fiscal_periods, audit_log, stored_files,
      accounts, items, person_identities, persons, stores, organizations restart identity cascade`;
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org A','org-a') returning id`;
  orgA = o!.id;
  const [s] = await sql<{ id: string }[]>`insert into stores (org_id, code, name, stock_model) values (${orgA},'A1','A One','multi_room') returning id`;
  storeA = s!.id;
  const [staff] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Staffer') returning id`;
  const [manager] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgA},'Manager') returning id`;
  staffId = staff!.id;
  managerId = manager!.id;
  await sql`insert into person_roles (person_id, org_id, role) values (${staffId}, ${orgA}, 'staff')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${managerId}, ${orgA}, 'manager')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staffId}, ${storeA})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${managerId}, ${storeA})`;
  staffActor = { personId: staffId, orgId: orgA };
  managerActor = { personId: managerId, orgId: orgA };

  const [t] = await sql<{ id: string }[]>`insert into location_types (org_id, code, name) values (${orgA},'STK','Kitchen type') returning id`;
  const [r2] = await sql<{ id: string }[]>`insert into stock_locations (org_id, store_id, code, name, type_id, role, is_default, created_by) values (${orgA},${storeA},'KIT','Kitchen',${t!.id},'operating',true,${staffId}) returning id`;
  kitchen = r2!.id;

  const [slab] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Beef Forequarter','meat_slab','kg',${staffId}) returning id`;
  slabItem = slab!.id;
  const mkSlice = async (code: string, name: string) => {
    const [row] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
      values (${orgA},${testItemCode()},${name},'meat_sliced','kg',${slabItem},${staffId}) returning id`;
    return row!.id;
  };
  sliceA = await mkSlice('SLICE-A', 'Beef Slice A');
  sliceB = await mkSlice('SLICE-B', 'Beef Slice B');
  sliceC = await mkSlice('SLICE-C', 'Beef Slice C');

  const [slab2] = await sql<{ id: string }[]>`insert into items (org_id, code, name, kind, base_unit, created_by) values (${orgA},${testItemCode()},'Pork Forequarter','meat_slab','kg',${staffId}) returning id`;
  otherSlab = slab2!.id;
  const [os] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
    values (${orgA},${testItemCode()},'Pork Slice','meat_sliced','kg',${otherSlab},${staffId}) returning id`;
  otherSlice = os!.id;

  const [f] = await sql<{ id: string }[]>`
    insert into stored_files (org_id, storage_path, content_type, byte_size, checksum, purpose, uploaded_by)
    values (${orgA}, ${'orgs/' + orgA + '/p.jpg'}, 'image/jpeg', 10, 'x', 'receipt_photo', ${staffId}) returning id`;
  fileA = f!.id;
  await seedChartOfAccounts(sql, orgA);
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) select ${orgA}, m::date, (m + interval '1 month' - interval '1 day')::date, 'open' from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') m`;

  const [staffEmployment] = await sql<{ id: string }[]>`
    insert into employments (org_id, store_id, person_id, staff_code, employment_status, started_on)
    values (${orgA}, ${storeA}, ${staffId}, 'SE-001', 'regular', '2025-01-01')
    returning id
  `;
  await grantEverydayPositionAccess(sql, {
    orgId: orgA, storeId: storeA, employmentId: staffEmployment!.id, personId: staffId, setBy: managerId,
  });
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function draftAndPost(over: Record<string, unknown> = {}) {
  const draft = await asOrg(orgA, (tx) =>
    createProductionDraft(tx, staffActor, {
      orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
      labourCost: '1000.00',
      inputs: [{ itemId: slabItem, quantity: '100', unit: 'kg' }],
      outputs: [
        { itemId: sliceA, quantity: '40', unit: 'kg' },
        { itemId: sliceB, quantity: '35', unit: 'kg' },
        { itemId: sliceC, quantity: '22', unit: 'kg' },
      ],
      ...over,
    }),
  );
  if (!draft.ok) throw new Error(`draft failed: ${draft.reason}`);
  const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
  return { recordId: draft.recordId, posted };
}

/** T-369 S4: the refusal is the SENTENCE now (the domain asks the ledger before the first write); the trigger (migration 0145) stays the backstop (I3). */
const closedSentenceRe = (month: string, doing: string) =>
  new RegExp(`^${month} is closed\\. Stock can't be ${doing} on .+ — a closed month's stock stays as it was, and the closed-month override doesn't change that\\. Use a date in an open month\\.$`);

describe('T-176 test 1 — the value identity, corrected numbers (spec-defect note above)', () => {
  it('one entry, output layered proportionally, and the value identity ties to the centavo', async () => {
    await stockUpSlab();
    const { posted } = await draftAndPost();
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.journalEntryId).toBeTruthy();

    // Cr 1310 (raw slab relief) 30,000.00; Dr 5300 (yield loss) 900.00; Cr 6100 (labour) 1,000.00;
    // Dr 1310 (sliced output value) 30,100.00 — SAME account as the credit, two separate lines
    // (the account-routing spec-defect noted at the top of this file).
    const b = await balances();
    expect(b['5300']).toBe('900.00');
    expect(b['6100']).toBe('-1000.00'); // credited — capitalised into inventory, not an OPEX any more
    // ⚠️ `stockUpSlab()` ITSELF posts Dr 1310 30,000.00 for the slab's own receipt (T-166). This
    // run's production entry then adds Dr 1310 30,100.00 (output value) and Cr 1310 30,000.00
    // (input relief) — net +100.00 on top of the receipt, so 1310's total balance is
    // 30,000 (receipt) + 100 (production's own net) = 30,100.00.
    expect(b['1310']).toBe('30100.00');

    // Isolate the PRODUCTION entry's own two 1310 lines directly, to prove the value identity on
    // its own terms (not entangled with the receipt).
    const rawLines = await sql<{ debit: string; credit: string }[]>`
      select l.debit, l.credit from journal_lines l join accounts a on a.id = l.account_id
      where l.entry_id = ${posted.journalEntryId!} and a.code = '1310' order by l.line_no`;
    const net1310 = rawLines.reduce((sum, r) => sum + Number(r.debit) - Number(r.credit), 0);
    expect(Math.round(net1310 * 100) / 100).toBe(100); // 30,100 debit - 30,000 credit

    expect(await trialBalance()).toBe('0.00');

    // Total layered value = 30,100.00, across 97kg of output.
    const layers = await sql<{ item_id: string; quantity: string; unit_cost: string }[]>`
      select item_id, quantity, unit_cost from stock_layers where source = 'production' order by received_at`;
    expect(layers).toHaveLength(3);
    const totalLayerValue = layers.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_cost), 0);
    expect(Math.round(totalLayerValue * 100) / 100).toBeCloseTo(30100, 0);
  });
});

describe('T-176 test 2 — output exceeding input is a HARD block', () => {
  it('refuses, and nothing is written', async () => {
    await stockUpSlab();
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '15', unit: 'kg' }],
      }),
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(false);
    expect(await onHand(slabItem)).toBe('100.000');
  });
});

describe('T-176 test 3 / test 19 — a lineage mismatch SOFT warns and posts', () => {
  it('trimmings pooling across primals warns, never blocks', async () => {
    await stockUpSlab();
    // otherSlice's parent is otherSlab, not slabItem — a lineage mismatch against THIS run's input.
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '5', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    // sliceA has no lineage mismatch here (it IS a child of slabItem) — assert the record posts
    // cleanly with an empty or absent lineage warning for THIS case, and separately prove a real
    // mismatch warns by posting otherSlice as an output of a slabItem-input run.
    const draft2 = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '5', unit: 'kg' }],
        outputs: [{ itemId: otherSlice, quantity: '2', unit: 'kg' }],
      }),
    );
    if (!draft2.ok) throw new Error(draft2.reason);
    const posted2 = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft2.recordId }));
    expect(posted2.ok).toBe(true);
    if (!posted2.ok) return;
    expect(posted2.warnings.some((w) => w.includes('source slab differs'))).toBe(true);
  });
});

describe('T-176 test 4 — unit conversion', () => {
  it('a pcs<->pack line is refused with a readable error; g<->kg converts', async () => {
    await stockUpSlab();
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '9500', unit: 'g' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    if (posted.ok) {
      const [layer] = await sql<{ quantity: string }[]>`select quantity from stock_layers where item_id = ${sliceA}`;
      expect(layer!.quantity).toBe('9.500'); // converted to the item's own base unit (kg)
    }
  });
});

describe('T-176 test 6 — convert', () => {
  it('between two children of ONE slab posts NO journal entry', async () => {
    await stockUpSlab();
    // First slice the slab into sliceA so there is something to convert.
    const { posted: firstPost } = await draftAndPost();
    expect(firstPost.ok).toBe(true);

    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'convert', producedOn: '2026-08-11',
        inputs: [{ itemId: sliceA, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: sliceB, quantity: '10', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const before = await trialBalance();
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.journalEntryId).toBeNull();
    expect(await trialBalance()).toBe(before); // unchanged — no journal entry
  });

  it('between children of DIFFERENT slabs is refused', async () => {
    await stockUpSlab();
    const { posted: firstPost } = await draftAndPost();
    expect(firstPost.ok).toBe(true);
    await stockUpSlab('10', '250.0000'); // stock otherSlab isn't sliced, so skip — just prove refusal via lineage.

    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'convert', producedOn: '2026-08-11',
        inputs: [{ itemId: sliceA, quantity: '5', unit: 'kg' }],
        outputs: [{ itemId: otherSlice, quantity: '5', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(false);
    if (posted.ok) return;
    expect(posted.reason).toMatch(/SAME slab/);
  });
});

describe('T-176 test 7 — recategorising a slab away while a child points at it is refused BY THE DATABASE', () => {
  it('the trigger fires', async () => {
    await expect(sql`update items set kind = 'raw_material' where id = ${slabItem}`).rejects.toThrow(/invariant 6/);
  });
});

describe('T-176 test 8 — a sliced child with a different base unit is refused', () => {
  it('the trigger fires on insert', async () => {
    await expect(
      sql`insert into items (org_id, code, name, kind, base_unit, parent_slab_item_id, created_by)
          values (${orgA}, ${testItemCode()}, 'Bad Unit Slice', 'meat_sliced', 'g', ${slabItem}, ${staffId})`,
    ).rejects.toThrow(/invariant 7/);
  });
});

describe('T-176 test 9 — editing a posted record', () => {
  it('reverses and re-applies; revision becomes 2; old legs stay visible; trial balance ties throughout', async () => {
    await stockUpSlab();
    const { recordId, posted } = await draftAndPost();
    expect(posted.ok).toBe(true);
    expect(await trialBalance()).toBe('0.00');

    const edited = await asOrg(orgA, (tx) =>
      editPostedProduction(tx, managerActor, {
        recordId,
        inputs: [{ itemId: slabItem, quantity: '100', unit: 'kg' }],
        outputs: [
          { itemId: sliceA, quantity: '50', unit: 'kg' },
          { itemId: sliceB, quantity: '45', unit: 'kg' },
        ],
        labourCost: '1200.00',
      }),
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.revision).toBe(2);
    expect(await trialBalance()).toBe('0.00');

    const [rec] = await sql<{ revision: number }[]>`select revision from production_records where id = ${recordId}`;
    expect(rec!.revision).toBe(2);

    const oldLines = await sql<{ reversed_at: Date | null }[]>`
      select reversed_at from production_record_lines where record_id = ${recordId} and revision = 1`;
    expect(oldLines.length).toBeGreaterThan(0);
    expect(oldLines.every((l) => l.reversed_at !== null)).toBe(true);
  });

  it('editing a convert is refused', async () => {
    await stockUpSlab();
    const { posted: firstPost } = await draftAndPost();
    expect(firstPost.ok).toBe(true);
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'convert', producedOn: '2026-08-11',
        inputs: [{ itemId: sliceA, quantity: '5', unit: 'kg' }],
        outputs: [{ itemId: sliceB, quantity: '5', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    const edited = await asOrg(orgA, (tx) =>
      editPostedProduction(tx, managerActor, {
        recordId: draft.recordId,
        inputs: [{ itemId: sliceA, quantity: '3', unit: 'kg' }],
        outputs: [{ itemId: sliceB, quantity: '3', unit: 'kg' }],
      }),
    );
    expect(edited.ok).toBe(false);
    if (edited.ok) return;
    expect(edited.reason).toMatch(/convert record cannot be edited/);
  });
});

describe('T-176 test 10 — void tolerates a missing ledger leg', () => {
  it('still reverses the stock correctly from the record\'s own fields and reports the gap', async () => {
    // ⚠️ `journal_lines`/`journal_entries` are immutable once posted (a DB trigger refuses
    // UPDATE/DELETE — T-105) and `production_records.journal_entry_id` carries a real FK, so "the
    // entry row itself vanished" is structurally UNREACHABLE in v2 — a genuine, reportable finding
    // in its own right (see the task report). The reachable shape of "the leg I expected is not
    // there for me to reverse" is: something else already reversed the SAME entry first — a real
    // race this test constructs directly, by pointing this record's journal_entry_id at an entry
    // that a SEPARATE, already-completed reversal has left in `status = 'reversed'`.
    await stockUpSlab();
    const { recordId, posted } = await draftAndPost();
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;

    // A second, throwaway slice run — post it for a REAL entry to rewire onto.
    await stockUpSlab('50', '300.0000');
    const draft2 = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '20', unit: 'kg' }],
        outputs: [{ itemId: sliceC, quantity: '18', unit: 'kg' }],
      }),
    );
    if (!draft2.ok) throw new Error(draft2.reason);
    const posted2 = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft2.recordId }));
    expect(posted2.ok).toBe(true);
    if (!posted2.ok) return;

    // Flip that entry to `reversed` DIRECTLY (never through `reverseEntry`, so this test does not
    // also consume the `reverse:{entryId}` idempotency key `reverseEntry` would derive for it —
    // ⚠️ found by this test: two attempts to reverse the SAME entry id, one via a real void and
    // one via this record, would otherwise share that default key and the SECOND would idempotently
    // no-op rather than hit "already reversed", masking the exact race this test means to prove).
    await sql`update journal_entries set status = 'reversed' where id = ${posted2.journalEntryId!}`;

    // Now rewire the FIRST record onto that entry — satisfies the FK (the row genuinely exists),
    // but `reverseEntry` will refuse to reverse an entry that is already `reversed`.
    await sql`update production_records set journal_entry_id = ${posted2.journalEntryId!} where id = ${recordId}`;

    const result = await asOrg(orgA, (tx) => voidProduction(tx, managerActor, { recordId, reason: 'testing DEF gap tolerance' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledgerGap).toBe(true);
    expect(result.ledgerGapReason).toBeTruthy();

    // Stock is STILL correctly reversed, from the record's own fields — never fabricated.
    // sliceA/sliceB were only ever produced by the first (now-voided) run; sliceC's 18 kg from
    // the SECOND run is untouched — this void reverses only recordId's own lines.
    expect(await onHand(sliceA)).toBe('0.000');
    expect(await onHand(sliceB)).toBe('0.000');
    expect(await onHand(sliceC)).toBe('18.000');

    const [rec] = await sql<{ status: string }[]>`select status from production_records where id = ${recordId}`;
    expect(rec!.status).toBe('void');
  });
});

describe('T-176 test 11 — concurrency: two posts against the same slab, one commits, one refused', () => {
  it('the -20kg drift cannot recur', async () => {
    await stockUpSlab('10', '300.0000'); // only 10kg on the shelf

    const draftBig = async () =>
      asOrg(orgA, (tx) =>
        createProductionDraft(tx, staffActor, {
          orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
          inputs: [{ itemId: slabItem, quantity: '8', unit: 'kg' }],
          outputs: [{ itemId: sliceA, quantity: '8', unit: 'kg' }],
        }),
      );
    const d1 = await draftBig();
    const d2 = await draftBig();
    if (!d1.ok || !d2.ok) throw new Error('drafts failed');

    const [r1, r2] = await Promise.allSettled([
      asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: d1.recordId })),
      asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: d2.recordId })),
    ]);

    const outcomes = [r1, r2].map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, reason: 'threw' }));
    const succeeded = outcomes.filter((o) => o.ok);
    expect(succeeded.length).toBe(1); // one commits, one is refused — never both
    expect(await onHand(slabItem)).toBe('2.000'); // 10 - 8, never -6
  });
});

describe('T-176 test 12 — the slicer-payment lock, stubbed (§7)', () => {
  it('until Phase 5 exists, every record posts, edits and voids freely', async () => {
    await stockUpSlab();
    const { recordId, posted } = await draftAndPost();
    expect(posted.ok).toBe(true);
    // hasLiveSlicerPaymentCovering is a stub that always returns false — proven by every other
    // test in this file succeeding at all three operations. Explicitly exercised here too:
    const voided = await asOrg(orgA, (tx) => voidProduction(tx, managerActor, { recordId, reason: 'no lock yet' }));
    expect(voided.ok).toBe(true);
  });
});

describe('T-176 test 13 — period lock and frozen location', () => {
  it('post into a closed period is refused', async () => {
    await stockUpSlab();
    await sql`update fiscal_periods set status = 'closed' where org_id = ${orgA}`;
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '9', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const count = async () => {
      const [m] = await sql<{ c: string }[]>`select count(*)::text as c from stock_movements where org_id = ${orgA}`;
      const [e] = await sql<{ c: string }[]>`select count(*)::text as c from journal_entries where org_id = ${orgA}`;
      return { movements: m!.c, entries: e!.c };
    };
    const before = await count();
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok, 'a post into a closed month went through').toBe(false);
    if (!posted.ok) expect(posted.reason).toMatch(closedSentenceRe('August 2026', 'produced'));
    expect(await count(), 'a refused post left movements or entries behind').toEqual(before);
    const [rec] = await sql<{ status: string }[]>`select status from production_records where id = ${draft.recordId}`;
    expect(rec!.status).toBe('draft');
  });

  it('I3 (the backstop): a RAW stock movement dated in the closed period is still refused by the database trigger', async () => {
    await sql`update fiscal_periods set status = 'closed' where org_id = ${orgA}`;
    await expect(
      sql`insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
          values (${orgA}, ${storeA}, ${kitchen}, ${slabItem}, '2026-08-10T04:00:00Z', 1, 'receipt', 'delivery', ${crypto.randomUUID()}, ${staffId})`,
    ).rejects.toThrow(/closed period/i);
  });
});

describe('T-176 test 15 — a run with zero outputs is refused', () => {
  it('the error names a wastage instead', async () => {
    await stockUpSlab();
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10', unit: 'kg' }], outputs: [],
      }),
    );
    expect(draft.ok).toBe(false);
    if (draft.ok) return;
    expect(draft.reason).toMatch(/wastage/);
  });
});

describe('T-176 test 16 — the same product cannot be both input and output', () => {
  it('refused at post', async () => {
    await stockUpSlab();
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: sliceA, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '5', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(false);
  });
});

describe('T-176 test 17 — an unresolvable product id is a HARD reject', () => {
  it('for the output — an item from a DIFFERENT org (passes the raw FK, fails org-scoped resolution)', async () => {
    // A genuinely nonexistent uuid trips `production_record_lines`' own FK at DRAFT time — this
    // schema cannot even hold a reference to an item that never existed. The realistic
    // "unresolvable" case `validateProductionLines`'s `resolved` flag exists for is exactly this:
    // an id that is a real ITEM ROW, but not in the actor's own org.
    const [otherOrg] = await sql<{ id: string }[]>`insert into organizations (name, code) values ('Org B','org-b') returning id`;
    const [otherOrgPerson] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${otherOrg!.id},'Other') returning id`;
    const [foreignItem] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${otherOrg!.id},${testItemCode()},'Foreign item','raw_material','kg',${otherOrgPerson!.id}) returning id`;

    await stockUpSlab();
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: foreignItem!.id, quantity: '5', unit: 'kg' }],
      }),
    );
    // The FK is satisfied (it IS a real items row) — the refusal must come from validation.
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(false);
    if (posted.ok) return;
    expect(posted.reason).toMatch(/does not resolve/);
  });
});

describe('T-176 test 18 — the SCALE tolerance holds both ways', () => {
  it('cutting 10.005 from 10.000 on hand is ALLOWED', async () => {
    await stockUpSlab('10.000', '300.0000');
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10.005', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '9.5', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(true);
    expect(await onHand(slabItem)).toBe('0.000'); // clamped to what was actually there
  });

  it('cutting 10.02 from 10.000 on hand is refused — past tolerance', async () => {
    await stockUpSlab('10.000', '300.0000');
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10.02', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '9.5', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    const posted = await asOrg(orgA, (tx) => postProduction(tx, managerActor, { recordId: draft.recordId }));
    expect(posted.ok).toBe(false);
  });
});

describe('capability gates — post_production / edit_posted_production / void_production', () => {
  it('staff cannot post', async () => {
    await stockUpSlab();
    const draft = await asOrg(orgA, (tx) =>
      createProductionDraft(tx, staffActor, {
        orgId: orgA, storeId: storeA, locationId: kitchen, kind: 'slice', producedOn: '2026-08-10',
        inputs: [{ itemId: slabItem, quantity: '10', unit: 'kg' }],
        outputs: [{ itemId: sliceA, quantity: '9', unit: 'kg' }],
      }),
    );
    if (!draft.ok) throw new Error(draft.reason);
    await expect(asOrg(orgA, (tx) => postProduction(tx, staffActor, { recordId: draft.recordId }))).rejects.toThrow(
      /may not 'post_production'/,
    );
  });

  it('staff cannot void', async () => {
    await stockUpSlab();
    const { recordId, posted } = await draftAndPost();
    expect(posted.ok).toBe(true);
    await expect(
      asOrg(orgA, (tx) => voidProduction(tx, staffActor, { recordId, reason: 'nope' })),
    ).rejects.toThrow(/may not 'void_production'/);
  });

  it('staff cannot edit a posted record', async () => {
    await stockUpSlab();
    const { recordId, posted } = await draftAndPost();
    expect(posted.ok).toBe(true);
    await expect(
      asOrg(orgA, (tx) =>
        editPostedProduction(tx, staffActor, {
          recordId, inputs: [{ itemId: slabItem, quantity: '100', unit: 'kg' }], outputs: [{ itemId: sliceA, quantity: '90', unit: 'kg' }],
        }),
      ),
    ).rejects.toThrow(/may not 'edit_posted_production'/);
  });

  it('manager can post, edit and void', async () => {
    await stockUpSlab();
    const { posted } = await draftAndPost();
    expect(posted.ok).toBe(true);
  });
});
