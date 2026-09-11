import { config } from 'dotenv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import { closeDb, transaction, systemTransaction, APP_ROLE, type Tx } from '@shareat/db';
import type { Actor } from '@shareat/auth';
import {
  dispatch,
  quantity,
  receiveTransfer,
  saveDraft,
  stuckTransfers,
  transferNow,
  voidTransfer,
} from '@shareat/domain';

/**
 * T-167 — stock transfers between two rooms of one store.
 *
 * ⭐ Posts nothing (§2): a FIFO layer is per store, so a transfer moves quantity only. Test 1
 * asserts the zero-journal, zero-layer-consumption claim directly rather than trusting the header
 * comment.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(
    `Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`,
  );
}

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

const asActor = (orgId: string, personId: string): Actor => ({ personId, orgId });

async function onHand(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_movements
    where item_id = ${itemId} and location_id = ${locationId}`;
  return r!.t;
}

async function reserved(itemId: string, locationId: string): Promise<string> {
  const [r] = await sql<{ t: string }[]>`
    select coalesce(sum(quantity),0)::text as t from stock_reservations
    where item_id = ${itemId} and location_id = ${locationId} and released_at is null`;
  return r!.t;
}

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staff: Actor;
  manager: Actor;
  roomA: string;
  roomB: string;
  otherStoreRoom: string;
  itemA: string;
}

async function fixture(): Promise<Fixture> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, code) values (${'Org ' + uid('o')}, ${uid('org')}) returning id`;
  const orgId = org!.id;
  const [store] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st')}, 'Store One', 'multi_room') returning id`;
  const storeId = store!.id;
  const [otherStore] = await sql<{ id: string }[]>`
    insert into stores (org_id, code, name, stock_model) values (${orgId}, ${uid('st2')}, 'Store Two', 'multi_room') returning id`;
  const otherStoreId = otherStore!.id;

  const [manager] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Manager') returning id`;
  const [staff] = await sql<{ id: string }[]>`
    insert into persons (org_id, display_name) values (${orgId}, 'Staff') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${manager!.id}, ${orgId}, 'manager')`;
  await sql`insert into person_roles (person_id, org_id, role) values (${staff!.id}, ${orgId}, 'staff')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${staff!.id}, ${storeId})`;
  await sql`insert into person_store_scope (person_id, store_id) values (${manager!.id}, ${otherStoreId})`;

  const [type] = await sql<{ id: string }[]>`
    insert into location_types (org_id, code, name) values (${orgId}, 'STK', 'Stockroom') returning id`;
  const [a] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${storeId}, 'A', 'Room A', ${type!.id}, ${staff!.id}) returning id`;
  const [b] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${storeId}, 'B', 'Room B', ${type!.id}, ${staff!.id}) returning id`;
  const [c] = await sql<{ id: string }[]>`
    insert into stock_locations (org_id, store_id, code, name, type_id, created_by)
    values (${orgId}, ${otherStoreId}, 'C', 'Other Store Room', ${type!.id}, ${staff!.id}) returning id`;

  const [item] = await sql<{ id: string }[]>`
    insert into items (org_id, code, name, kind, base_unit, created_by)
    values (${orgId}, ${uid('ITEM')}, 'Pork Belly', 'raw_material', 'kg', ${staff!.id}) returning id`;

  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${orgId}, '2020-01-01', '2035-12-31', 'open')`;

  return {
    orgId,
    storeId,
    otherStoreId,
    staff: asActor(orgId, staff!.id),
    manager: asActor(orgId, manager!.id),
    roomA: a!.id,
    roomB: b!.id,
    otherStoreRoom: c!.id,
    itemA: item!.id,
  };
}

/** Seeds on-hand at `locationId` with a plain 'opening' movement — transfers never touch layers,
 *  so no receipt/FIFO machinery is needed to give a location stock. */
async function seedOnHand(f: Fixture, locationId: string, qty: string, itemId = f.itemA) {
  await sql`
    insert into stock_movements (org_id, store_id, location_id, item_id, moved_at, quantity, kind, source_type, source_id, created_by)
    values (${f.orgId}, ${f.storeId}, ${locationId}, ${itemId}, now(), ${qty}, 'opening', 'test_seed', ${crypto.randomUUID()}, ${f.staff.personId})`;
}

beforeEach(async () => {
  await sql`
    truncate table stock_reservations, stock_transfer_lines, stock_transfers,
      stock_movements, stock_locations, location_types,
      journal_lines, journal_entries, fiscal_periods,
      person_store_scope, person_roles, person_identities, persons, items, stores, organizations
      restart identity cascade`;
});

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('T-167 — transferNow: one step, posts nothing', () => {
  it('moves on-hand, writes two movements, zero journal entries, zero layer consumptions', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');

    const res = await asOrg(f.orgId, (tx) =>
      transferNow(tx, {
        storeId: f.storeId,
        fromLocationId: f.roomA,
        toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('5.000') }],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(true);

    expect(await onHand(f.itemA, f.roomA)).toBe('5.000');
    expect(await onHand(f.itemA, f.roomB)).toBe('5.000');

    const movements = await sql<{ n: string }[]>`select count(*)::text as n from stock_movements where source_type = 'stock_transfer'`;
    expect(movements[0]!.n).toBe('2');

    const entries = await sql<{ n: string }[]>`select count(*)::text as n from journal_entries where org_id = ${f.orgId}`;
    expect(entries[0]!.n).toBe('0');

    const layers = await sql<{ n: string }[]>`select count(*)::text as n from stock_layer_consumptions`;
    expect(layers[0]!.n).toBe('0');
  });

  it('never leaves an in_transit row — asserted by status AND by the DB refusing a direct insert', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    const res = await asOrg(f.orgId, (tx) =>
      transferNow(tx, {
        storeId: f.storeId,
        fromLocationId: f.roomA,
        toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('5.000') }],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [row] = await sql<{ status: string }[]>`select status from stock_transfers where id = ${res.transferId}`;
    expect(row!.status).toBe('received');

    await expect(
      sql`insert into stock_transfers (org_id, store_id, from_location_id, to_location_id, mode, status, created_by)
          values (${f.orgId}, ${f.storeId}, ${f.roomA}, ${f.roomB}, 'immediate', 'in_transit', ${f.staff.personId})`,
    ).rejects.toThrow();
  });

  it('dispatching more than the source holds is refused; on-hand unchanged', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    const res = await asOrg(f.orgId, (tx) =>
      transferNow(tx, {
        storeId: f.storeId,
        fromLocationId: f.roomA,
        toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('25.000') }],
        actor: f.staff,
      }),
    );
    expect(res.ok).toBe(false);
    expect(await onHand(f.itemA, f.roomA)).toBe('10.000');
    expect(await onHand(f.itemA, f.roomB)).toBe('0');
  });

  it('⭐ concurrency: two transfers of 8 from an on-hand of 10 — one commits, one is refused, final on-hand is 2', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');

    const input = {
      orgId: f.orgId,
      storeId: f.storeId,
      fromLocationId: f.roomA,
      toLocationId: f.roomB,
      lines: [{ itemId: f.itemA, quantity: quantity('8.000') }],
      actor: f.staff,
    };
    const results = await Promise.allSettled([
      asOrg(f.orgId, (tx) => transferNow(tx, input)),
      asOrg(f.orgId, (tx) => transferNow(tx, input)),
    ]);
    const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value.ok : 'threw'));
    // One succeeds, one is refused (either a clean `ok:false` or a thrown lock/refusal error).
    expect(outcomes.filter((o) => o === true)).toHaveLength(1);
    expect(await onHand(f.itemA, f.roomA)).toBe('2.000');
  });
});

describe('T-167 — two-step: dispatch reserves, receive resolves', () => {
  it('after dispatch: source falls, destination unchanged, destination RESERVED is the quantity', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    const draft = await asOrg(f.orgId, (tx) =>
      saveDraft(tx, {
        storeId: f.storeId,
        fromLocationId: f.roomA,
        toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('4.000') }],
        actor: f.staff,
      }),
    );
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const dispatched = await asOrg(f.orgId, (tx) => dispatch(tx, f.staff, draft.transferId));
    expect(dispatched.ok).toBe(true);

    expect(await onHand(f.itemA, f.roomA)).toBe('6.000');
    expect(await onHand(f.itemA, f.roomB)).toBe('0');
    expect(await reserved(f.itemA, f.roomB)).toBe('4.000');

    const received = await asOrg(f.orgId, (tx) => receiveTransfer(tx, f.staff, draft.transferId));
    expect(received.ok).toBe(true);

    expect(await onHand(f.itemA, f.roomB)).toBe('4.000');
    expect(await reserved(f.itemA, f.roomB)).toBe('0');
  });

  it('⭐ void AFTER receive reverses both movements and does NOT release the reservation a second time', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    const draft = await asOrg(f.orgId, (tx) =>
      saveDraft(tx, {
        storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('4.000') }], actor: f.staff,
      }),
    );
    if (!draft.ok) throw new Error('setup failed');
    await asOrg(f.orgId, (tx) => dispatch(tx, f.staff, draft.transferId));
    await asOrg(f.orgId, (tx) => receiveTransfer(tx, f.staff, draft.transferId));

    const [before] = await sql<{ released_at: Date }[]>`select released_at from stock_reservations where transfer_id = ${draft.transferId}`;
    expect(before!.released_at).not.toBeNull();

    const voided = await asOrg(f.orgId, (tx) => voidTransfer(tx, f.manager, draft.transferId, 'wrong destination'));
    expect(voided.ok).toBe(true);

    expect(await onHand(f.itemA, f.roomA)).toBe('10.000');
    // ⚠️ '0.000', not '0' — room B DOES have rows (an IN then its reversal); they sum to zero
    // rather than the "no rows at all" case, which sums to the bare literal '0'.
    expect(await onHand(f.itemA, f.roomB)).toBe('0.000');

    // ⛔ The named double-release bug: released_at must be UNCHANGED, not re-stamped by the void.
    const [after] = await sql<{ released_at: Date }[]>`select released_at from stock_reservations where transfer_id = ${draft.transferId}`;
    expect(after!.released_at.getTime()).toBe(before!.released_at.getTime());
  });

  it('void BEFORE receive releases the reservation and restores source on-hand', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    const draft = await asOrg(f.orgId, (tx) =>
      saveDraft(tx, {
        storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('4.000') }], actor: f.staff,
      }),
    );
    if (!draft.ok) throw new Error('setup failed');
    await asOrg(f.orgId, (tx) => dispatch(tx, f.staff, draft.transferId));
    expect(await reserved(f.itemA, f.roomB)).toBe('4.000');

    const voided = await asOrg(f.orgId, (tx) => voidTransfer(tx, f.manager, draft.transferId, 'not needed'));
    expect(voided.ok).toBe(true);

    expect(await onHand(f.itemA, f.roomA)).toBe('10.000');
    expect(await reserved(f.itemA, f.roomB)).toBe('0');
  });

  it('⛔ a frozen location refuses both the out and the in leg', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    // Freeze room A via the same mechanism T-169 uses — an active count session on it.
    const [session] = await sql<{ id: string }[]>`
      insert into count_sessions (org_id, store_id, counted_on, opened_by) values (${f.orgId}, ${f.storeId}, '2026-01-05', ${f.staff.personId}) returning id`;
    await sql`insert into count_session_locations (session_id, location_id) values (${session!.id}, ${f.roomA})`;

    // ⛔ The freeze is a DB trigger on stock_movements (T-169, migration 0068) — it RAISEs, so
    // this surfaces as a rejected promise, same as any other DB-level refusal in this codebase.
    await expect(
      asOrg(f.orgId, (tx) =>
        transferNow(tx, {
          storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB,
          lines: [{ itemId: f.itemA, quantity: quantity('1.000') }], actor: f.staff,
        }),
      ),
    ).rejects.toThrow(/frozen/);
    expect(await onHand(f.itemA, f.roomA)).toBe('10.000');
  });

  it('⛔ …and a frozen DESTINATION refuses the IN leg at receive, after a clean dispatch', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    const draft = await asOrg(f.orgId, (tx) =>
      saveDraft(tx, {
        storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('1.000') }], actor: f.staff,
      }),
    );
    if (!draft.ok) throw new Error('setup failed');
    await asOrg(f.orgId, (tx) => dispatch(tx, f.staff, draft.transferId));

    const [session] = await sql<{ id: string }[]>`
      insert into count_sessions (org_id, store_id, counted_on, opened_by) values (${f.orgId}, ${f.storeId}, '2026-01-05', ${f.staff.personId}) returning id`;
    await sql`insert into count_session_locations (session_id, location_id) values (${session!.id}, ${f.roomB})`;

    await expect(
      asOrg(f.orgId, (tx) => receiveTransfer(tx, f.staff, draft.transferId)),
    ).rejects.toThrow(/frozen/);
    expect(await onHand(f.itemA, f.roomB)).toBe('0');
  });
});

describe('T-167 — the stuck-transfer report', () => {
  it('returns a 4-day-old in_transit transfer and not a 2-day-old one', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');

    const old = await asOrg(f.orgId, (tx) =>
      saveDraft(tx, {
        storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('1.000') }], actor: f.staff,
      }),
    );
    if (!old.ok) throw new Error('setup failed');
    await asOrg(f.orgId, (tx) => dispatch(tx, f.staff, old.transferId));
    await sql`update stock_transfers set dispatched_at = now() - interval '4 days' where id = ${old.transferId}`;

    const recent = await asOrg(f.orgId, (tx) =>
      saveDraft(tx, {
        storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('1.000') }], actor: f.staff,
      }),
    );
    if (!recent.ok) throw new Error('setup failed');
    await asOrg(f.orgId, (tx) => dispatch(tx, f.staff, recent.transferId));
    await sql`update stock_transfers set dispatched_at = now() - interval '2 days' where id = ${recent.transferId}`;

    const stuck = await asOrg(f.orgId, (tx) => stuckTransfers(tx, f.storeId, 3));
    expect(stuck.map((t) => t.id)).toEqual([old.transferId]);
  });
});

describe('T-167 — cross-store is refused at the database', () => {
  it('a transfer whose destination belongs to another store is refused', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');
    await expect(
      asOrg(f.orgId, (tx) =>
        transferNow(tx, {
          storeId: f.storeId, fromLocationId: f.roomA, toLocationId: f.otherStoreRoom,
          lines: [{ itemId: f.itemA, quantity: quantity('1.000') }], actor: f.staff,
        }),
      ),
    ).rejects.toThrow();
    expect(await onHand(f.itemA, f.roomA)).toBe('10.000');
  });
});

/**
 * T-231 slice 1 / DEF-210 — the organisation is the ACTOR's, never the caller's.
 *
 * ⭐ Deliberately `systemTransaction()`, not `asOrg`: production (`apps/erp/src/app/inventory/
 * transfers/actions.ts:47`) DOES call these through `withOrgPrincipal(actor.orgId, …)` today — RLS
 * is a real backstop here, not bypassed. These tests deliberately remove that backstop anyway, to
 * prove the APPLICATION layer alone (never trusting a caller-supplied orgId) refuses the cross-org
 * write on its own — bible §15.11, no layer may be the only one for a given risk.
 * `systemTransaction()` re-arms an explicit bypass so the claim stays provable in both flag states.
 *
 * ⚠️ **This comment used to say the opposite** — that production opened these with no principal at
 * all. That was true once; `withOrgPrincipal` was added at both sites since (DEF-175's shape: a
 * comment describing a prior state as if it were current — caught 2026-09-11 while measuring
 * DEF-218). The claim below survived that change of premise; it was not written under it.
 *
 * ⭐ This is the sharpest of the three, because the attack needs **nothing the victim owns**: the
 * store, the room and the item are all the attacker's own. Only the org id is borrowed, and it is
 * a hidden field in the page (`NewTransferForm.tsx:26`).
 */
describe('T-231 / DEF-210 — a stock transfer is stamped with the actor’s org', () => {
  it('transferNow ignores a caller-supplied organisation', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');

    const [victim] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${'Victim ' + uid('v')}, ${uid('vic')}) returning id`;
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status)
              values (${victim!.id}, '2020-01-01', '2035-12-31', 'open')`;

    const res = await systemTransaction((tx) =>
      transferNow(tx, {
        // @ts-expect-error T-231/DEF-210 — the field is GONE. Supplying another org's id
        // must not compile; if someone re-adds it this directive goes unused and the build fails.
        orgId: victim!.id,
        storeId: f.storeId, // the actor's OWN store — authorize() axis 2 passes
        fromLocationId: f.roomA,
        toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('5.000') }],
        actor: f.staff,
      }),
    );
    expect(res.ok, res.ok ? '' : `transferNow refused: ${res.reason}`).toBe(true);
    if (!res.ok) return;

    const [row] = await sql<{ org_id: string }[]>`
      select org_id from stock_transfers where id = ${res.transferId}`;
    expect(row!.org_id, 'the transfer landed in the org the CALLER named').toBe(f.orgId);

    const moves = await sql<{ org_id: string }[]>`
      select m.org_id from stock_movements m
      join stock_transfer_lines l on l.out_movement_id = m.id or l.in_movement_id = m.id
      where l.transfer_id = ${res.transferId}`;
    expect(moves.length, 'a transfer writes two movements').toBe(2);
    for (const m of moves) {
      expect(m.org_id, 'a stock movement landed in another organisation’s ledger').toBe(f.orgId);
    }
  });

  it('saveDraft ignores a caller-supplied organisation', async () => {
    const f = await fixture();
    await seedOnHand(f, f.roomA, '10.000');

    const [victim] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${'Victim ' + uid('v')}, ${uid('vic')}) returning id`;

    const res = await systemTransaction((tx) =>
      saveDraft(tx, {
        // @ts-expect-error T-231/DEF-210 — the field is GONE. Supplying another org's id
        // must not compile; if someone re-adds it this directive goes unused and the build fails.
        orgId: victim!.id,
        storeId: f.storeId,
        fromLocationId: f.roomA,
        toLocationId: f.roomB,
        lines: [{ itemId: f.itemA, quantity: quantity('5.000') }],
        actor: f.staff,
      }),
    );
    expect(res.ok, res.ok ? '' : `saveDraft refused: ${res.reason}`).toBe(true);
    if (!res.ok) return;

    const [row] = await sql<{ org_id: string }[]>`
      select org_id from stock_transfers where id = ${res.transferId}`;
    expect(row!.org_id, 'the draft landed in the org the CALLER named').toBe(f.orgId);
  });
});
