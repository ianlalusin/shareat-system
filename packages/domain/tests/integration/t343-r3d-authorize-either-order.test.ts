import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-343 Amendment R3(d) — against the REAL `authorizeEither` (`packages/domain/src/trade/index.ts:
 * 65-81`), not a hand copy. It is not exported, so this drives it through its real caller,
 * `voidTradeOrder` (`trade/index.ts:675-751`), which calls it exactly like this when a branch
 * order's status is not yet `dispatched`/`received`:
 *
 *   await authorizeEither(trx, actor, [
 *     { capability: 'place_branch_order', storeId: order.requestedByStoreId },  // PRIMARY
 *     { capability: 'fulfil_branch_order', storeId: order.storeId },            // fallback
 *   ]);
 *
 * The actor below is refused on BOTH attempts, for genuinely DIFFERENT reasons: `place_branch_order`
 * (the primary/first attempt) is refused because a plain `staff` role never holds it via the matrix
 * and has no grant either ("role may not"); `fulfil_branch_order` (the fallback/second attempt) IS
 * held, via an explicit grant, but the actor has no store-scope row for the commissary at all ("no
 * store scope"). Before this task's fix, `authorizeEither` kept overwriting its `refused` variable
 * on every loop iteration, so the error that reached the caller was the LAST attempt's (the
 * fallback's "no store scope") rather than the FIRST (primary) capability's — the exact defect
 * Amendment R3 item 1 names. The builder has since fixed the source (`firstRefusal ??= e`), so this
 * is expected to be GREEN; state-if-reverted: with the old `refused = e` (no `??=`), this assertion
 * would see `fulfil_branch_order`'s "no store scope" message instead.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} — name must contain "_test".`);
}

import { closeDb, transaction, APP_ROLE, type Tx } from '@shareat/db';
import { authorize, AuthorizationError, type Actor } from '@shareat/auth';
import { saveBranchOrderDraft, voidTradeOrder } from '@shareat/domain';
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

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

describe('R3(d) — authorizeEither surfaces the PRIMARY (first) capability\'s refusal, never the fallback\'s', () => {
  it('voidTradeOrder on a draft branch order: refused for place_branch_order, not fulfil_branch_order', async () => {
    const code = uid('r3d');
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, code) values (${`Org ${code}`}, ${code}) returning id`;
    const orgId = org!.id;

    const mkStore = async (label: string) => {
      const [s] = await sql<{ id: string }[]>`
        insert into stores (org_id, code, name) values (${orgId}, ${uid(label)}, ${`Store ${label}`}) returning id`;
      return s!.id;
    };
    const branchStoreId = await mkStore('br');
    const commissaryStoreId = await mkStore('com');

    const mkPerson = async (name: string, role: string) => {
      const [p] = await sql<{ id: string }[]>`
        insert into persons (org_id, display_name) values (${orgId}, ${name}) returning id`;
      await sql`insert into person_roles (person_id, org_id, role) values (${p!.id}, ${orgId}, ${role})`;
      return p!.id;
    };
    // The BRANCH's own staff — drafts the order (holds `place_branch_order` at its own store, same
    // as every branch-order test does; not the actor under test).
    const branchStaffId = await mkPerson('Branch drafter', 'staff');
    await sql`insert into person_store_scope (person_id, store_id) values (${branchStaffId}, ${branchStoreId})`;
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${branchStaffId}, 'place_branch_order', null, 'grant')`;

    // The actor under test: refused BOTH ways, for DIFFERENT reasons, and scoped to NEITHER store.
    const testActorId = await mkPerson('R3d Actor (refused both ways, differently)', 'staff');
    await sql`insert into person_grants (person_id, grant_name, granted_by, grant_source) values (${testActorId}, 'fulfil_branch_order', null, 'grant')`;
    // Deliberately NO grant for `place_branch_order` — a plain staff role, matrix-false, no override
    // (T-318) — and NO store-scope row anywhere, so `fulfil_branch_order`'s grant cannot save it.

    // Item, commissary link, internal customer — `saveBranchOrderDraft`'s own preconditions.
    const [item] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${orgId}, ${testItemCode()}, 'Pork belly', 'raw_material', 'kg', ${branchStaffId}) returning id`;
    await sql`
      insert into commissary_links (org_id, commissary_store_id, branch_store_id, created_by)
      values (${orgId}, ${commissaryStoreId}, ${branchStoreId}, ${branchStaffId})`;
    // `saveBranchOrderDraft` refuses any item not on the commissary's own offered catalogue.
    await sql`
      insert into commissary_item_offerings (org_id, commissary_store_id, item_id, manual_cost, created_by)
      values (${orgId}, ${commissaryStoreId}, ${item!.id}, '310.0000', ${branchStaffId})`;
    await sql`
      insert into customers (org_id, name, customer_group, counterparty_store_id, created_by)
      values (${orgId}, ${`Store br (internal) ${code}`}, 'internal', ${branchStoreId}, ${branchStaffId})`;

    const branchDrafter: Actor = { personId: branchStaffId, orgId };
    const { orderId } = await asOrg(orgId, (tx) =>
      saveBranchOrderDraft(tx, branchDrafter, {
        branchStoreId,
        commissaryStoreId,
        orderDate: '2026-08-20',
        lines: [{ itemId: item!.id, quantity: '5' }],
      }),
    );

    const testActor: Actor = { personId: testActorId, orgId };

    // Negative half: confirm the fixture actually produces two DIFFERENT refusal reasons for the
    // two attempts `voidTradeOrder` will make — same discipline the T6b describe uses for its own
    // mechanism, before trusting what the real code does with it.
    await expect(
      asOrg(orgId, (tx) => authorize(tx, testActor, 'place_branch_order', { storeId: branchStoreId })),
    ).rejects.toMatchObject({ message: expect.stringMatching(/may not 'place_branch_order'/) });
    await expect(
      asOrg(orgId, (tx) => authorize(tx, testActor, 'fulfil_branch_order', { storeId: commissaryStoreId })),
    ).rejects.toMatchObject({ message: expect.stringMatching(/no store scope/) });

    let caught: unknown;
    await asOrg(orgId, async (tx) => {
      try {
        await voidTradeOrder(tx, testActor, { orderId, reason: 'R3d probe' });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(AuthorizationError);
    const err = caught as AuthorizationError;
    expect(err.capability).toBe('place_branch_order'); // the PRIMARY/first attempt, not the fallback
    expect(err.message).toMatch(/role 'staff' may not 'place_branch_order'/);
    expect(err.message).not.toMatch(/no store scope/); // the fallback's own reason must NOT surface
  });
});
