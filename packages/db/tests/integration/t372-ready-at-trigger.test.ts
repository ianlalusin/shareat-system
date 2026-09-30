import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * T-372 S2 (DEF-511 DB backstop + DEF-127 R5 fee CHECK) — migration `0175` (0173 = T-367,
 * 0174 = T-368 S0), legs T1-T8. `docs/tasks/372-def-511-prepared-order-stays-prepared.md` §S2,
 * "Tests" → "S2: t372-ready-at-trigger". Raw SQL against the (not yet migrated) test DB, as the
 * migration role — same convention as `t366-0172-migration.test.ts`/`t367-s1-migration.test.ts`/
 * `t368-migration.test.ts`.
 *
 * ⛔ TESTER, not BUILDER. Migration 0175 does not exist yet: `trade_orders_ready_is_final_trg`
 * (R4) is absent, so T1-T4 are red today for a real, verified reason — the raw update simply
 * succeeds. T5 and T6 are positive controls unaffected by the migration's absence.
 *
 * ⛔⛔ **SPEC DEFECT — R5's `trade_orders_fees_non_negative_check` ALREADY EXISTS.** Verified
 * live on `shareat_test_t372_tester` (`pg_get_constraintdef`) and in migration history:
 * `0056_t151_landed_cost_and_branch_price.sql:32-33` added the byte-identical constraint —
 * `CHECK ((delivery_fee >= 0) AND (other_fees >= 0))` — on `trade_orders`, months before this
 * task, and nothing has dropped it since (grep across every migration finds exactly that one
 * creation, no drop). So T7/T8 are NOT red today — they are already green, proving a constraint
 * that already exists. If migration 0175 tries to `ADD CONSTRAINT trade_orders_fees_non_negative_
 * check` again, it will fail outright with Postgres 42710 (duplicate_object), not silently no-op.
 * **R5 should be dropped from 0175** (R5b, the `trade_order_lines` received_quantity CHECK, is
 * unaffected and genuinely new — verified separately, no existing non-negative check on that
 * column; only `delivery_lines` has one, matching the spec's own citation). Reported, not
 * worked around (RULES §3.4a) — kept as a standing proof of current behavior, not reframed as a
 * new red.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — the database name must contain "_test".`);
}

const sql = postgres(url, { max: 10 });
let seq = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++seq}`;

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

// -----------------------------------------------------------------------------------------------
// Fixture — a bare trade_orders row, no domain layer. status='confirmed' + ready_at set is 'ready'
// (branchOrderStage, packages/domain/src/commissary/orders.ts:88-89); no readyAt is 'accepted'.
// -----------------------------------------------------------------------------------------------

async function org(hint: string) {
  const code = uid(`t372trg-${hint}`);
  const [o] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
  const orgId = o!.id;
  const [store] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${orgId}, ${uid(hint)}, ${`Store ${hint}`}) returning id`;
  const [p1] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Packer') returning id`;
  const [p2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${orgId}, 'Other packer') returning id`;
  const [customer] = await sql<{ id: string }[]>`insert into customers (org_id, name, created_by) values (${orgId}, ${`Cust ${code}`}, ${p1!.id}) returning id`;
  return { orgId, storeId: store!.id, customerId: customer!.id, personId: p1!.id, otherPersonId: p2!.id };
}
type Org = Awaited<ReturnType<typeof org>>;

async function tradeOrder(o: Org, opts: { readyAt?: 'now' | null; deliveryFee?: string; otherFees?: string } = {}): Promise<string> {
  // trade_orders_branch_stage_check requires accepted_at/accepted_by set whenever ready_at is, and
  // requested_by_store_id set whenever accepted_at is — so an "accepted" fixture needs all three
  // regardless of whether ready_at itself is set. total_amount must be > 0 (…_total_positive_check).
  const [row] = await sql<{ id: string }[]>`
    insert into trade_orders (
      org_id, store_id, customer_id, order_date, status, total_amount, requested_by_store_id, created_by,
      accepted_at, accepted_by, ready_at, ready_by, delivery_fee, other_fees
    )
    values (
      ${o.orgId}, ${o.storeId}, ${o.customerId}, '2026-10-01', 'confirmed', '100.00', ${o.storeId}, ${o.personId},
      now(), ${o.personId},
      ${opts.readyAt === 'now' ? sql`now()` : null}, ${opts.readyAt === 'now' ? o.personId : null},
      ${opts.deliveryFee ?? '0'}, ${opts.otherFees ?? '0'}
    ) returning id`;
  return row!.id;
}
async function readyOrder(o: Org): Promise<string> {
  return tradeOrder(o, { readyAt: 'now' });
}
async function readyStamp(orderId: string): Promise<{ readyAt: string | null; readyBy: string | null }> {
  const [row] = await sql<{ ready_at: string | null; ready_by: string | null }[]>`
    select ready_at::text, ready_by::text from trade_orders where id = ${orderId}`;
  return { readyAt: row!.ready_at, readyBy: row!.ready_by };
}

// -----------------------------------------------------------------------------------------------
// T1-T4 — the erasure/change of an already-set ready_at/ready_by is refused
// -----------------------------------------------------------------------------------------------

describe('T1 — clearing ready_at/ready_by on a READY order', () => {
  it('update … set ready_at=null, ready_by=null: rejects /ready is final/ — Mutant: trigger absent, red (succeeds today)', async () => {
    const o = await org('t1');
    const orderId = await readyOrder(o);
    const before = await readyStamp(orderId);
    const err = await sql`update trade_orders set ready_at = null, ready_by = null where id = ${orderId}`.catch((e) => e);
    expect(err, 'today: trade_orders_ready_is_final_trg does not exist yet, so this update succeeds').toBeInstanceOf(Error);
    expect((err as { message?: string }).message ?? '').toMatch(/ready is final/);
    expect(await readyStamp(orderId)).toEqual(before);
  });
});

describe('T2 — changing ready_at (not clearing it) on a READY order', () => {
  it("update … set ready_at = ready_at + interval '1 day': rejects — Mutant: WHEN tests only NEW.ready_at IS NULL, red (succeeds today)", async () => {
    const o = await org('t2');
    const orderId = await readyOrder(o);
    const before = await readyStamp(orderId);
    const err = await sql`update trade_orders set ready_at = ready_at + interval '1 day' where id = ${orderId}`.catch((e) => e);
    expect(err, 'today: no trigger exists, so this update succeeds').toBeInstanceOf(Error);
    expect((err as { message?: string }).message ?? '').toMatch(/ready is final/);
    expect(await readyStamp(orderId)).toEqual(before);
  });
});

describe('T3 — changing ready_by (not ready_at) on a READY order', () => {
  it('update … set ready_by = <other person>: rejects — Mutant: ready_by left out of UPDATE OF / WHEN, red (succeeds today)', async () => {
    const o = await org('t3');
    const orderId = await readyOrder(o);
    const before = await readyStamp(orderId);
    const err = await sql`update trade_orders set ready_by = ${o.otherPersonId} where id = ${orderId}`.catch((e) => e);
    expect(err, 'today: no trigger exists, so this update succeeds').toBeInstanceOf(Error);
    expect(await readyStamp(orderId)).toEqual(before);
  });
});

describe('T4 — the trigger fires even under session_replication_role = replica', () => {
  it("inside sql.begin: SET LOCAL session_replication_role = 'replica', then T1's update: rejects — Mutant: ENABLE ALWAYS omitted, red (succeeds today)", async () => {
    const o = await org('t4');
    const orderId = await readyOrder(o);
    const before = await readyStamp(orderId);
    const err = await sql
      .begin(async (t) => {
        await t`set local session_replication_role = 'replica'`;
        await t`update trade_orders set ready_at = null, ready_by = null where id = ${orderId}`;
      })
      .catch((e) => e);
    expect(err, 'today: no trigger exists at all, replica role or not, so this succeeds').toBeInstanceOf(Error);
    expect(await readyStamp(orderId)).toEqual(before);
  });
});

// -----------------------------------------------------------------------------------------------
// T5-T6 — positive controls, unaffected by the migration's absence
// -----------------------------------------------------------------------------------------------

describe('T5 — +control: null-to-set (markReady\'s own shape) is untouched', () => {
  it('accepted order (ready_at null); update … set ready_at=now(), ready_by=<p>: succeeds — Mutant: trigger fires on null-to-set, red', async () => {
    const o = await org('t5');
    const orderId = await tradeOrder(o, { readyAt: null });
    await expect(
      sql`update trade_orders set ready_at = now(), ready_by = ${o.personId} where id = ${orderId}`,
    ).resolves.toBeDefined();
    const after = await readyStamp(orderId);
    expect(after.readyAt).not.toBeNull();
    expect(after.readyBy).toBe(o.personId);
  });
});

describe('T6 — +control: other columns on a READY order stay editable', () => {
  it("update … set notes='x' on a ready order: succeeds — Mutant: UPDATE OF dropped (fires on any column), red", async () => {
    const o = await org('t6a');
    const orderId = await readyOrder(o);
    await expect(sql`update trade_orders set notes = 'x' where id = ${orderId}`).resolves.toBeDefined();
  });
  it("a ready order voided (status='void', voided_at=now(), voided_by=<p>, void_reason='x'): succeeds", async () => {
    const o = await org('t6b');
    const orderId = await readyOrder(o);
    await expect(
      sql`update trade_orders set status = 'void', voided_at = now(), voided_by = ${o.personId}, void_reason = 'x' where id = ${orderId}`,
    ).resolves.toBeDefined();
  });
});

// -----------------------------------------------------------------------------------------------
// T7-T8 — the fee CHECK (R5) — SEE THE FILE HEADER: this constraint ALREADY EXISTS
// (0056_t151_landed_cost_and_branch_price.sql), so T7/T8 are already green today, not red. Kept
// as a standing proof of current behavior — R5 is a spec defect (duplicate), reported above.
// -----------------------------------------------------------------------------------------------

describe('T7 — a negative fee is refused (ALREADY TRUE today — pre-existing constraint, see file header)', () => {
  it('update … set delivery_fee = -1: rejects /trade_orders_fees_non_negative_check/ — green today via the PRE-EXISTING constraint, not migration 0175', async () => {
    const o = await org('t7a');
    const orderId = await tradeOrder(o);
    const err = await sql`update trade_orders set delivery_fee = -1 where id = ${orderId}`.catch((e) => e);
    expect(err, 'a pre-existing CHECK (0056) already refuses this — see file header re: R5').toBeInstanceOf(Error);
    expect((err as { message?: string; constraint?: string }).constraint ?? (err as Error).message).toMatch(
      /trade_orders_fees_non_negative_check/,
    );
  });
  it('update … set other_fees = -1: rejects — green today via the PRE-EXISTING constraint', async () => {
    const o = await org('t7b');
    const orderId = await tradeOrder(o);
    const err = await sql`update trade_orders set other_fees = -1 where id = ${orderId}`.catch((e) => e);
    expect(err, 'a pre-existing CHECK (0056) already refuses this').toBeInstanceOf(Error);
    expect((err as { message?: string; constraint?: string }).constraint ?? (err as Error).message).toMatch(
      /trade_orders_fees_non_negative_check/,
    );
  });
});

describe('T8 — +control: zero and a positive fee both succeed', () => {
  it("delivery_fee = 0 and = 250.00 both succeed — already green today (same pre-existing constraint)", async () => {
    const o = await org('t8');
    const orderId = await tradeOrder(o);
    await expect(sql`update trade_orders set delivery_fee = 0 where id = ${orderId}`).resolves.toBeDefined();
    await expect(sql`update trade_orders set delivery_fee = 250.00 where id = ${orderId}`).resolves.toBeDefined();
  });
});
