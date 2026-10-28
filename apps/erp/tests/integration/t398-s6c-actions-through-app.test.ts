import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';

/**
 * T-398 S6c (TESTER) - the app's OWN action and OWN wrapper, not a test-only helper. docs/tasks/398-s6/{S6-REFRESH s5 + s8 S6c, TESTS S6c}.md.
 * The S5 smoketest found a bug the domain tests hid (the app's `withOrgPrincipal` carries no person); these legs go through what the screens call.
 *
 *   W1  the chokepoint `apps/erp/src/app/expenses/lib` exports `withActorPrincipal(orgId, personId, fn)` (S6-REFRESH s8: "re-export only"); inside it the person
 *       is in the transaction and the franchisor reads run without the 42501 "needs a signed-in person".                (RED: not exported)
 *   W2  S5's inbound `withActorPrincipal(actor, fn)` still carries the person (it may delegate to the shared helper).    (pinned, GREEN)
 *   A1  voidExpenseAction (the real server action, session mocked): a PG manager's button, Ian's-person-in-PG PIN -> the expense is voided AND exactly one
 *       break_glass_approval row names Ian with capability void_expense and the record's store.                           (RED: no row)
 *   A2  the same button with another administrator's PIN -> voided, ZERO break-glass rows.                                 (GREEN pin: kills "log every approver")
 *   A3  Ian's PIN is wrong / the approval is refused -> expense unchanged, ZERO rows.                                       (GREEN pin: kills "log before the checks")
 * Mutants: withActorPrincipal not re-exported or session-scoped -> W1; verifyAdminApproval does not log or logs without setting the approver as the principal person
 *   (42501 aborts the action: flash error) -> A1; logs for every approver -> A2; logs before the PIN is verified -> A3.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - the database name must contain "_test".`);
}

const h = vi.hoisted(() => ({ actor: null as null | { personId: string; orgId: string } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', async () => (await import('../helpers/flash-jar-core')).nextNavigationMock());
vi.mock('../../src/lib/session', () => ({
  requireActor: vi.fn(async () => h.actor),
  requireSession: vi.fn(async () => ({ actor: h.actor, sessionId: 'session-1', credentialKind: 'pin' as const, storeId: null, expiresAt: new Date('2099-01-01') })),
}));

import { closeDb, type Tx } from '@shareat/db';
import { hashPin, pinLookupHash } from '@shareat/auth';
import * as D from '@shareat/domain';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';
import { asOrgOn } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { draftExpense, moneyFixture, pendingInvoice, uid, type MoneyFx } from '../../../../packages/domain/tests/integration/_fixtures/t402-s3-money';
import { D0, franchiseWorld, type FranchiseWorld } from '../../../../packages/db/tests/integration/_fixtures/t398-s6-franchise';

const sql = postgres(url, { max: 5 });
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

const ATTEST = { supplier: true, invoice: true, items: true, price: true };
let pinSeq = 0;
async function addPin(f: MoneyFx, personId: string): Promise<string> {
  const pin = String(420100 + ++pinSeq * 17);
  await sql`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${f.storeId}, ${await hashPin(pin)}, ${pinLookupHash(f.orgId, pin)})`;
  return pin;
}

/** An org where the admin is Ian's person in a franchisee (agreement to a fresh franchisor org), a manager, and a SECOND administrator. */
async function franchisee(hint: string) {
  const f = await moneyFixture(sql, hint);
  const [fr] = await sql<{ id: string }[]>`insert into organizations (name, code) values (${`Franchisor ${uid(hint)}`}, ${uid('frc')}) returning id`;
  await sql`insert into franchise_agreements (org_id, franchisor_org_id, franchisor_person_id, sales_visible_from) values (${f.orgId}, ${fr!.id}, ${f.adminId}, ${D0})`;
  const [p2] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Other Admin') returning id`;
  await sql`insert into person_roles (person_id, org_id, role) values (${p2!.id}, ${f.orgId}, 'admin')`;
  await sql`insert into person_store_scope (person_id, store_id) values (${p2!.id}, ${f.storeId})`;
  return { f, ianPin: await addPin(f, f.adminId), otherAdminId: p2!.id, otherAdminPin: await addPin(f, p2!.id) };
}

async function postedExpense(f: MoneyFx, amount: string) {
  const inv = await pendingInvoice(sql, f, '5000.00');
  await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
  const created = await draftExpense(f, inv, amount);
  await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, created.id));
  return created.id;
}
const statusOf = async (id: string) => (await sql<{ status: string }[]>`select status from expenses where id = ${id}`)[0]?.status ?? 'gone';
const approvalRows = (orgId: string) =>
  sql<{ franchisee_person_id: string; capability: string; store_id: string | null }[]>`
    select franchisee_person_id, capability, store_id from franchise_access_log where org_id = ${orgId} and what = 'break_glass_approval' order by occurred_at, id`;

async function voidAs(f: MoneyFx, expenseId: string, pin: string) {
  const { voidExpenseAction } = await import('../../src/app/expenses/actions');
  resetJar();
  h.actor = f.manager; // the button belongs to the PG manager; the PIN typed is whoever's it is
  const fd = new FormData();
  fd.set('expenseId', expenseId);
  fd.set('reason', 'Wrong supplier');
  fd.set('adminPin', pin);
  return outcomeOf(await captureRedirect(() => voidExpenseAction(fd)));
}

describe('W1/W2 the app\'s own wrappers carry the acting person', () => {
  it('W1: expenses/lib exports withActorPrincipal(orgId, personId, fn); inside it app.person_id is set and a franchisor read is not refused for lack of a person (RED: not exported)', async () => {
    const lib = (await import('../../src/app/expenses/lib')) as Record<string, unknown>;
    const wrap = lib.withActorPrincipal as undefined | (<T>(org: string, person: string, fn: (tx: Tx) => Promise<T>) => Promise<T>);
    if (typeof wrap !== 'function') throw new Error('MISSING EXPORT: apps/erp/src/app/expenses/lib does not export withActorPrincipal (S6c: the chokepoint re-exports the shared helper).');
    const W: FranchiseWorld = await franchiseWorld();
    const seen = await wrap(W.l.orgId, W.ianL.id, async (tx) => {
      const r = (await tx.execute(dsql`select nullif(current_setting('app.person_id', true), '') as p`)) as unknown as { p: string | null }[];
      return r[0]!.p;
    });
    expect(seen, 'the person is in the transaction').toBe(W.ianL.id);
    const franchisees = await wrap(W.l.orgId, W.ianL.id, (tx) => D.listFranchisees(tx, { personId: W.ianL.id, orgId: W.l.orgId }));
    expect(franchisees.map((x) => x.franchiseeOrgId), 'no 42501 "needs a signed-in person"; Ian sees PG').toContain(W.pg.orgId);
    const after = await wrap(W.l.orgId, W.superL.id, async () => 'second call');
    expect(after).toBe('second call');
  });

  it('W2: S5\'s inbound withActorPrincipal(actor, fn) still sets the person (pinned; may now delegate to the shared helper)', async () => {
    const { withActorPrincipal } = await import('../../src/app/inventory/deliveries/inbound/lib');
    const f = await moneyFixture(sql, 'w2');
    const seen = await withActorPrincipal(f.manager, async (tx) => {
      const r = (await tx.execute(dsql`select nullif(current_setting('app.person_id', true), '') as p, nullif(current_setting('app.org_id', true), '') as o`)) as unknown as { p: string | null; o: string | null }[];
      return r[0]!;
    });
    expect(seen).toEqual({ p: f.managerId, o: f.orgId });
  });
});

describe('A1-A3 a PIN approval through the real voidExpenseAction', () => {
  it('A1: PG manager clicks Void, Ian\'s person in PG types his PIN -> expense voided, exactly one break_glass_approval row naming Ian (void_expense, the record\'s store) (RED: no row)', async () => {
    const { f, ianPin } = await franchisee('a1');
    const id = await postedExpense(f, '400.00');
    const o = await voidAs(f, id, ianPin);
    expect(o.flash.error, `the action said: ${o.flash.error}`).toBeUndefined();
    expect(await statusOf(id), 'the void went through').toBe('voided');
    const rows = await approvalRows(f.orgId);
    expect(rows, 'exactly one approval row').toHaveLength(1);
    expect(rows[0]).toEqual({ franchisee_person_id: f.adminId, capability: 'void_expense', store_id: f.storeId });
  });

  it('A2: the same button with ANOTHER administrator\'s PIN -> voided, zero break-glass rows (kills: log every approver)', async () => {
    const { f, otherAdminPin } = await franchisee('a2');
    const id = await postedExpense(f, '410.00');
    const o = await voidAs(f, id, otherAdminPin);
    expect(o.flash.error, `the action said: ${o.flash.error}`).toBeUndefined();
    expect(await statusOf(id)).toBe('voided');
    expect(await approvalRows(f.orgId)).toHaveLength(0);
  });

  it('A3: Ian\'s person with a WRONG PIN -> refused, the expense is untouched, zero rows (kills: logging before the PIN is verified)', async () => {
    const { f } = await franchisee('a3');
    const id = await postedExpense(f, '420.00');
    const before = await statusOf(id);
    const o = await voidAs(f, id, '000000');
    expect(o.flash.error, 'the PIN was refused').toBe('That PIN cannot approve this. An administrator must enter their own PIN.');
    expect(await statusOf(id)).toBe(before);
    expect(await approvalRows(f.orgId)).toHaveLength(0);
  });
});
