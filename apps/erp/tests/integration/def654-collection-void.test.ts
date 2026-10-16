import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * DEF-654 (TESTER) - voiding a POSTED AR collection is Tier P (docs/tasks/412-confirm-destructive-tiers.md): the server
 * must verify an administrator's own PIN (field `adminPin`) before reversing the collection, charge a wrong PIN to the
 * RECORD's store, and write `destructive.approved` in the same transaction as the void.
 *
 * Runs the REAL `voidCollectionAction` (apps/erp/src/app/customers/actions.ts) with the session mocked (t412 idiom).
 *
 * MUTANTS (each red, then reverted), one per test:
 *  M-a  voidCollectionAction never calls verifyAdminApproval            -> "no PIN" test red (collection already voided)
 *  M-b  verifyAdminApproval wrapped in a try/catch that swallows refusals -> "wrong PIN" test red
 *  M-c  the PIN is checked against a form-supplied storeId              -> "wrong PIN is charged to the record store" red
 *  M-d  the approval row is appended outside the mutation transaction   -> "valid admin PIN" test red (second void leaves 2 rows)
 *  M-e  accept a manager's correct PIN (drop the isAdmin term)          -> "manager PIN" test red
 *
 * RED TODAY: the action reads no adminPin, so the "no PIN" call VOIDS the collection.
 */
config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb } from '@shareat/db';
import { createCustomer, recordCharge, recordCollection } from '@shareat/domain';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';
import { givePin } from '../helpers/approval-pin';
import { asOrgOn } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { auditRows, moneyFixture, uid } from '../../../../packages/domain/tests/integration/_fixtures/t402-s3-money';

const sql = postgres(url, { max: 5 });
const ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.';
const MOD = '../../src/app/customers/actions';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function fixture() {
  const f = await moneyFixture(sql, 'def654');
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2027-02-01', '2027-02-28', 'open')`;
  const adminPin = await givePin(sql, { orgId: f.orgId, storeId: f.storeId, personId: f.adminId });
  const managerPin = await givePin(sql, { orgId: f.orgId, storeId: f.storeId, personId: f.managerId });
  const customer = await asOrgOn(f.orgId, (tx) => createCustomer(tx, f.admin, { name: `Resto ${uid('c')}` }));
  const charge = await asOrgOn(f.orgId, (tx) =>
    recordCharge(tx, f.admin, { storeId: f.storeId, customerId: customer.id, chargeDate: '2027-02-03', dueDate: null, totalAmount: '1000.00', revenueAccountCode: '4150' }),
  );
  const col = await asOrgOn(f.orgId, (tx) =>
    recordCollection(tx, f.admin, {
      storeId: f.storeId, customerId: customer.id, collectionDate: '2027-02-04', amount: '1000.00', moneyAccountId: f.drawerId,
      allocations: [{ chargeId: charge.chargeId, amountApplied: '1000.00' }],
    }),
  );
  const status = async () => (await sql<{ status: string }[]>`select status from ar_collections where id = ${col.collectionId}`)[0]!.status;
  const fields = { customerId: customer.id, storeId: f.storeId, collectionId: col.collectionId, reason: 'Wrong customer' };
  return { f, adminPin, managerPin, collectionId: col.collectionId, status, fields };
}

async function run(fields: Record<string, string>, who: { personId: string; orgId: string }) {
  const act = ((await import(/* @vite-ignore */ MOD)) as Record<string, (fd: FormData) => Promise<void>>).voidCollectionAction!;
  resetJar();
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => act(fd)));
}
const missCount = async (storeId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${storeId} and kind = 'miss'`)[0]!.n;
/** T-416: a wrong approval PIN is charged to the ACTOR's bucket (actor_person_id, no store). */
const actorMissCount = async (personId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where actor_person_id = ${personId} and store_id is null and kind = 'miss'`)[0]!.n;

describe('DEF-654: voidCollectionAction is Tier P', () => {
  it('no adminPin -> refused with the one sentence, the collection stays posted, no approval event (M-a)', async () => {
    const t = await fixture();
    expect(await t.status()).toBe('posted');
    const o = await run(t.fields, t.f.manager);
    expect(o.flash.error, 'refused with the one sentence').toBe(ADMIN_PIN_REFUSED);
    expect(await t.status(), 'still posted').toBe('posted');
    expect(await auditRows(sql, t.f.orgId, 'destructive.approved', t.collectionId)).toHaveLength(0);
  });

  it('a wrong PIN is refused, nothing changes, and the miss is charged to the ACTOR, not any store (a forged storeId charges nothing) (M-b, M-c, T-416)', async () => {
    const t = await fixture();
    const [other] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${t.f.orgId}, ${uid('forged')}, 'Forged') returning id`;
    const actorBefore = await actorMissCount(t.f.manager.personId);
    const recordBefore = await missCount(t.f.storeId);
    const o = await run({ ...t.fields, adminPin: '000000', approvedStoreId: other!.id }, t.f.manager);
    expect(o.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await t.status()).toBe('posted');
    expect(await actorMissCount(t.f.manager.personId), "the miss survives and is the actor's").toBe(actorBefore + 1);
    expect(await missCount(t.f.storeId), 'nothing at the record store').toBe(recordBefore);
    expect(await missCount(other!.id), 'nothing at the forged store').toBe(0);
  });

  it("a manager's correct PIN (not an administrator) is refused and nothing changes (M-e)", async () => {
    const t = await fixture();
    const o = await run({ ...t.fields, adminPin: t.managerPin }, t.f.manager);
    expect(o.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await t.status()).toBe('posted');
    expect(await auditRows(sql, t.f.orgId, 'destructive.approved', t.collectionId)).toHaveLength(0);
  });

  it('a valid administrator PIN voids it and writes destructive.approved (actor + approver, never the PIN) in the same transaction (M-d)', async () => {
    const t = await fixture();
    const o = await run({ ...t.fields, adminPin: t.adminPin }, t.f.manager);
    expect(o.flash.error, 'the approved void succeeded').toBeUndefined();
    expect(await t.status()).toBe('voided');
    const rows = await auditRows(sql, t.f.orgId, 'destructive.approved', t.collectionId);
    expect(rows, 'exactly one approval event').toHaveLength(1);
    expect(rows[0]!.store_id).toBe(t.f.storeId);
    const after = rows[0]!.after as Record<string, unknown>;
    expect(after.actorPersonId).toBe(t.f.managerId);
    expect(after.approverPersonId).toBe(t.f.adminId);
    expect(after.entityId).toBe(t.collectionId);
    expect(typeof after.capability === 'string' && (after.capability as string).length > 0).toBe(true);
    expect(typeof after.entityType === 'string' && (after.entityType as string).length > 0).toBe(true);
    expect(JSON.stringify(after), 'the PIN is never recorded').not.toContain(t.adminPin);
    // second approved call: the domain refuses (not posted) AFTER the PIN passed; no second approval row (V7)
    const again = await run({ ...t.fields, adminPin: t.adminPin }, t.f.manager);
    expect(again.flash.error, 'refused by the domain').toBeDefined();
    expect(await auditRows(sql, t.f.orgId, 'destructive.approved', t.collectionId)).toHaveLength(1);
  });
});
