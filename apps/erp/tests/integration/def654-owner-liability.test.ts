import { config } from 'dotenv';
import { afterAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * DEF-654 audit follow-up - behavioural proof for the two guards the census only reads as text:
 *  - owners `settleAction` how=writeoff is Tier P (admin PIN, miss charged to the record store, destructive.approved row);
 *    how=cash needs no PIN.
 *  - liabilities `retireAction` is Tier R (the retyped name, loaded by the server, case/space-insensitive).
 *
 * MUTANTS (each red, then reverted):
 *  M-o1  settleAction writeoff branch skips verifyAdminApproval          -> "no PIN" / "wrong PIN" red (receivable written off)
 *  M-o2  recordApproval removed from the writeoff branch                  -> "valid admin PIN" red (no approval row)
 *  M-l1  retireAction skips the retypeMatches check                       -> "without / wrong name" red (liability retired)
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
import { createLiability, createOwner } from '@shareat/domain';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';
import { givePin } from '../helpers/approval-pin';
import { asOrgOn } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { auditRows, moneyFixture, uid } from '../../../../packages/domain/tests/integration/_fixtures/t402-s3-money';

const sql = postgres(url, { max: 5 });
const ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.';

afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function call(mod: string, name: string, fields: Record<string, string>, who: { personId: string; orgId: string }) {
  const act = ((await import(/* @vite-ignore */ mod)) as Record<string, (fd: FormData) => Promise<void>>)[name]!;
  resetJar();
  h.actor = who;
  const fd = new FormData();
  // T-488: the nine posting actions need the form's per-render id; every other action ignores the extra field.
  fd.set('requestId', crypto.randomUUID());
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => act(fd)));
}
const missCount = async (storeId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${storeId} and kind = 'miss'`)[0]!.n;
/** T-416: a wrong approval PIN is charged to the ACTOR's bucket (actor_person_id, no store). */
const actorMissCount = async (personId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where actor_person_id = ${personId} and store_id is null and kind = 'miss'`)[0]!.n;

async function ownerFixture() {
  const f = await moneyFixture(sql, 'def654o');
  const adminPin = await givePin(sql, { orgId: f.orgId, storeId: f.storeId, personId: f.adminId });
  const owner = await asOrgOn(f.orgId, (tx) => createOwner(tx, f.admin, { storeId: f.storeId, personId: f.staffId, role: 'Partner' }));
  // A posted receivable the owner owes (DR 1260 / CR 1110), straight to the ledger.
  const on = '2026-01-12';
  const [period] = await sql<{ id: string }[]>`select id from fiscal_periods where org_id = ${f.orgId} and starts_on <= ${on} and ends_on >= ${on}`;
  await sql.begin(async (tx) => {
    const [e] = await tx<{ id: string }[]>`
      insert into journal_entries (org_id, entry_date, period_id, source_type, source_id, status)
      values (${f.orgId}, ${on}, ${period!.id}, 'expense', ${uid('pe')}, 'draft') returning id`;
    const codes = await tx<{ id: string; code: string }[]>`select id, code from accounts where org_id = ${f.orgId} and code in ('1260', '1110')`;
    const by = new Map(codes.map((c) => [c.code, c.id]));
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit, party_type, party_id)
      values (${e!.id}, 1, ${by.get('1260')!}, ${f.storeId}, '2000.00', '0', 'owner', ${owner.id})`;
    await tx`insert into journal_lines (entry_id, line_no, account_id, store_id, debit, credit)
      values (${e!.id}, 2, ${by.get('1110')!}, ${f.storeId}, '0', '2000.00')`;
    await tx`update journal_entries set status = 'posted' where id = ${e!.id}`;
  });
  const writeoffs = async () =>
    (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId} and source_type = 'owner_writeoff'`)[0]!.n;
  const fields = { ownerId: owner.id, how: 'writeoff', amount: '2000.00', reason: 'not collectible', on: '2026-02-05' };
  return { f, adminPin, ownerId: owner.id, writeoffs, fields };
}

const OWNERS = '../../src/app/owners/actions';
const LIAB = '../../src/app/liabilities/actions';

describe('DEF-654: owners settleAction write-off is Tier P', () => {
  it('no PIN -> refused, nothing written off, no approval row (M-o1)', async () => {
    const t = await ownerFixture();
    const o = await call(OWNERS, 'settleAction', t.fields, t.f.admin);
    expect(o.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await t.writeoffs()).toBe(0);
    expect(await auditRows(sql, t.f.orgId, 'destructive.approved', t.ownerId)).toHaveLength(0);
  });

  it('a wrong PIN is refused, nothing written off, the miss is charged to the ACTOR and no store (M-o1, T-416)', async () => {
    const t = await ownerFixture();
    const actorBefore = await actorMissCount(t.f.admin.personId);
    const recordBefore = await missCount(t.f.storeId);
    const o = await call(OWNERS, 'settleAction', { ...t.fields, adminPin: '000000' }, t.f.admin);
    expect(o.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await t.writeoffs()).toBe(0);
    expect(await actorMissCount(t.f.admin.personId)).toBe(actorBefore + 1);
    expect(await missCount(t.f.storeId), 'nothing at the record store').toBe(recordBefore);
    expect(await auditRows(sql, t.f.orgId, 'destructive.approved', t.ownerId)).toHaveLength(0);
  });

  it('a valid administrator PIN writes it off and records destructive.approved (M-o2)', async () => {
    const t = await ownerFixture();
    const o = await call(OWNERS, 'settleAction', { ...t.fields, adminPin: t.adminPin }, t.f.admin);
    expect(o.flash.error, 'the approved write-off succeeded').toBeUndefined();
    expect(await t.writeoffs()).toBe(1);
    const rows = await auditRows(sql, t.f.orgId, 'destructive.approved', t.ownerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.store_id).toBe(t.f.storeId);
    expect(JSON.stringify(rows[0]!.after), 'the PIN is never recorded').not.toContain(t.adminPin);
  });

  it('how=cash needs no PIN (only the write-off forgives anything)', async () => {
    const t = await ownerFixture();
    const o = await call(
      OWNERS,
      'settleAction',
      { ownerId: t.ownerId, how: 'cash', amount: '500.00', intoMoneyAccountId: t.f.drawerId, on: '2026-02-05' },
      t.f.admin,
    );
    expect(o.flash.error, 'cash repayment needs no PIN').toBeUndefined();
    expect(await t.writeoffs()).toBe(0);
    expect(await auditRows(sql, t.f.orgId, 'destructive.approved', t.ownerId)).toHaveLength(0);
  });
});

describe('DEF-654: liabilities retireAction is Tier R', () => {
  async function liabFixture() {
    const f = await moneyFixture(sql, 'def654l');
    const name = 'Accrued rent - January';
    const created = await asOrgOn(f.orgId, (tx) => createLiability(tx, f.manager, { storeId: f.storeId, name, category: 'accrued_expenses' }));
    const retired = async () =>
      (await sql<{ retired_at: Date | null }[]>`select retired_at from liabilities where id = ${created.id}`)[0]!.retired_at !== null;
    return { f, id: created.id, name, retired };
  }

  it('no typed name -> refused, still active (M-l1)', async () => {
    const t = await liabFixture();
    const o = await call(LIAB, 'retireAction', { liabilityId: t.id }, t.f.manager);
    expect(o.flash.error).toBeDefined();
    expect(await t.retired()).toBe(false);
  });

  it('a wrong typed name -> refused, still active (M-l1)', async () => {
    const t = await liabFixture();
    const o = await call(LIAB, 'retireAction', { liabilityId: t.id, confirmName: 'Something else' }, t.f.manager);
    expect(o.flash.error).toBeDefined();
    expect(await t.retired()).toBe(false);
  });

  it('the exact name (case and spacing ignored) retires it', async () => {
    const t = await liabFixture();
    const o = await call(LIAB, 'retireAction', { liabilityId: t.id, confirmName: `  ${t.name.toUpperCase()} ` }, t.f.manager);
    expect(o.flash.error, 'retire succeeded').toBeUndefined();
    expect(await t.retired()).toBe(true);
  });
});
