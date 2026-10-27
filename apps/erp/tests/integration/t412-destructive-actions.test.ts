import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-412 S3 / S4 (TESTER) - I10: the server actions enforce the tier, whatever the browser sends.
 * docs/tasks/412-confirm-destructive-tiers.md, "Tests" I10, V1, V6, V7, V8 (mutants M1, M6, M8, M9, M10).
 *
 * One action per batch, run through the REAL server action with the session mocked (the T-390 S5 idiom):
 *   AP/expenses        voidExpenseAction (posted expense); the draft delete moved to Tier W (T-418)
 *   ledger reversals   voidMoneyTransferAction, reverseEntryAction (loan)
 *   cutover            postOpeningBalancesAction (created BEFORE the one real purge, like t402-s3)
 *   Tier R             setItemStatusAction (retire an item; super-admin only)
 * NOT covered here (named in the report): postSeparationAction (a pay-period fixture too large for a tester pass; its P
 * wiring is held by the census), and the inventory batch (its fixtures are per-module). Census rows still cover all 35 + 14.
 *
 * CONTRACT PINNED HERE (the spec is silent or loose; the builder matches, or reports the gap):
 *  - every Tier P form posts `adminPin` (the ONLY approval value); the refusal reaches the flash as the spec's one sentence
 *    ADMIN_PIN_REFUSED, byte for byte, in the case of no PIN, a wrong PIN, and a non-admin's correct PIN.
 *  - the audit row is `destructive.approved`, its `after` carries { capability, entityType, entityId, actorPersonId,
 *    approverPersonId }, `entity_id` is the record, `store_id` is the record's store (catalogue scope 'store').
 *  - a Tier R form posts `confirmName`; a refusal is "Type the name exactly - '<name>' - to confirm." with the REAL name
 *    (the spec writes an em dash: "Type the name exactly — '<name>' — to confirm."); nothing is mutated.
 *  - postOpeningBalancesAction takes a FormData today it does not read (`postOpeningBalancesAction()` has no parameter): the
 *    builder adds one so the form can post `adminPin`. See the report: an org-level action has no record store.
 *  - the "forced domain failure after approval" leg is the SECOND approved call on the same record: the domain refuses it
 *    (already voided / gone / already reversed) AFTER the PIN passed, and the audit count must stay at 1 (V7 / M9: an audit
 *    row written outside the mutation transaction would be a second row for an action that did nothing).
 *
 * RED TODAY: no action reads adminPin or confirmName, so the "no PIN" leg finds the record already voided (the action
 * succeeds); the leg that follows never gets further. Each failure names the state it found.
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

import { closeDb, loansRepo } from '@shareat/db';
import { hashPin, pinLookupHash } from '@shareat/auth';
import * as D from '@shareat/domain';
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';
import { asOrgOn } from '../../../../packages/domain/tests/integration/_fixtures/pos-s6';
import { auditRows, draftExpense, moneyFixture, pendingInvoice, uid, type MoneyFx } from '../../../../packages/domain/tests/integration/_fixtures/t402-s3-money';
import { testItemCode } from '../../../../packages/domain/tests/integration/_fixtures/item-code';
import { realPurge } from '../../../../tests/integration/t390-real-purge';

const sql = postgres(url, { max: 5 });
const ADMIN_PIN_REFUSED = 'That PIN cannot approve this. An administrator must enter their own PIN.';
const ATTEST = { supplier: true, invoice: true, items: true, price: true };
const FORGED = { confirmed: 'true', approved: '1', pinOk: 'true', verified: 'yes', adminApproved: 'true' };

let openingFx: MoneyFx; // created before the one real purge (C2), as t402-s3 does
beforeAll(async () => {
  openingFx = await moneyFixture(sql, 'opening');
  await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values
    (${openingFx.orgId}, '2026-12-01', '2026-12-31', 'open'), (${openingFx.orgId}, '2027-01-01', '2027-01-31', 'open')`;
  await realPurge(sql, openingFx.adminId);
}, 300_000);
afterAll(async () => {
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function addPin(f: MoneyFx, personId: string): Promise<string> {
  const pin = String(300000 + Math.floor(Math.random() * 600000));
  await sql`
    insert into person_credentials (person_id, kind, store_id, secret_hash, lookup_hash)
    values (${personId}, 'pin', ${f.storeId}, ${await hashPin(pin)}, ${pinLookupHash(f.orgId, pin)})`;
  return pin;
}

async function runAction(modulePath: string, name: string, fields: Record<string, string>, who: { personId: string; orgId: string }) {
  const mod = (await import(/* @vite-ignore */ modulePath)) as Record<string, unknown>;
  const act = mod[name];
  if (typeof act !== 'function') throw new Error(`MISSING EXPORT: ${modulePath} does not export ${name}.`);
  resetJar();
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const signal = await captureRedirect(() => (act as (f: FormData) => Promise<void>)(fd));
  return outcomeOf(signal);
}

const missCount = async (storeId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where store_id = ${storeId} and kind = 'miss'`)[0]!.n;
/** T-416: a wrong approval PIN is charged to the ACTOR's bucket (actor_person_id, no store). */
const actorMissCount = async (personId: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sign_in_attempts where actor_person_id = ${personId} and store_id is null and kind = 'miss'`)[0]!.n;

interface Case {
  name: string;
  /** The module the action lives in, relative to this file. */
  modulePath: string;
  action: string;
  f: MoneyFx;
  /** The actor whose button it is. */
  actor: { personId: string; orgId: string };
  /** Form fields the REAL form posts, before any approval field. */
  fields: Record<string, string>;
  /** The record's id (audit entity_id) and store. */
  entityId: string;
  storeId: string;
  /** A snapshot of the record's state: unchanged on refusal, different after success. */
  state: () => Promise<string>;
  /** Whether a second approved call is refused by the domain (the V7 / M9 leg). */
  secondCallRefused: boolean;
}

async function approvedFixture(hint: string) {
  const f = await moneyFixture(sql, hint);
  const adminPin = await addPin(f, f.adminId);
  const managerPin = await addPin(f, f.managerId);
  return { f, adminPin, managerPin };
}
async function postedExpense(f: MoneyFx, amount: string) {
  const inv = await pendingInvoice(sql, f, '5000.00');
  await asOrgOn(f.orgId, (tx) => D.verifyInvoice(tx, f.manager, inv, ATTEST));
  const created = await draftExpense(f, inv, amount);
  return { id: created.id, inv };
}
const expenseState = (id: string) => async () => {
  const [r] = await sql<{ status: string }[]>`select status from expenses where id = ${id}`;
  return r?.status ?? 'gone';
};

type Builder = () => Promise<{ c: Case; adminPin: string; managerPin: string }>;
const builders: Record<string, Builder> = {
  voidExpenseAction: async () => {
    const { f, adminPin, managerPin } = await approvedFixture('i10-voidexp');
    const e = await postedExpense(f, '400.00');
    await asOrgOn(f.orgId, (tx) => D.approveExpense(tx, f.manager, e.id));
    return {
      adminPin,
      managerPin,
      c: {
        name: 'voidExpenseAction', modulePath: '../../src/app/expenses/actions', action: 'voidExpenseAction', f, actor: f.manager,
        fields: { expenseId: e.id, reason: 'Wrong supplier' }, entityId: e.id, storeId: f.storeId, state: expenseState(e.id), secondCallRefused: true,
      },
    };
  },
  voidMoneyTransferAction: async () => {
    const { f, adminPin, managerPin } = await approvedFixture('i10-moneytx');
    const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    const t = await asOrgOn(f.orgId, (tx) =>
      D.createMoneyTransfer(tx, f.admin, { fromMoneyAccountId: f.drawerId, toMoneyAccountId: safe!.id, amountOut: '500.00', amountIn: '500.00', transferDate: '2026-01-10' }),
    );
    return {
      adminPin,
      managerPin,
      c: {
        name: 'voidMoneyTransferAction', modulePath: '../../src/app/money-transfers/actions', action: 'voidMoneyTransferAction', f, actor: f.manager,
        fields: { moneyTransferId: t.id, reason: 'Wrong drawer' }, entityId: t.id, storeId: f.storeId,
        state: async () => (await sql<{ status: string }[]>`select status from money_transfers where id = ${t.id}`)[0]!.status, secondCallRefused: true,
      },
    };
  },
  reverseEntryAction: async () => {
    const { f, adminPin, managerPin } = await approvedFixture('i10-loan');
    await sql`insert into fiscal_periods (org_id, starts_on, ends_on, status) values (${f.orgId}, '2026-05-01', '2026-05-31', 'open')`;
    const [safe] = await sql<{ id: string }[]>`select id from money_accounts where store_id = ${f.storeId} and instrument = 'cash' and custodian = 'office' and is_foundation`;
    const loan = await asOrgOn(f.orgId, (tx) =>
      D.createLoan(tx, f.admin, {
        storeId: f.storeId, lenderName: 'Grab', name: 'Grab cash advance', principalAmount: '200000.00', interestRate: '2', ratePeriod: 'month',
        interestMethod: 'straight', paymentFrequency: 'daily', termPeriods: 90, startDate: '2026-05-11',
      }),
    );
    const d = await asOrgOn(f.orgId, (tx) => D.disburseLoan(tx, f.admin, { requestId: crypto.randomUUID(), loanId: loan.id, amount: '1000.00', intoMoneyAccountId: safe!.id, on: '2026-05-11' }));
    return {
      adminPin,
      managerPin,
      c: {
        name: 'reverseEntryAction (loan)', modulePath: '../../src/app/loans/actions', action: 'reverseEntryAction', f, actor: f.manager,
        fields: { loanId: loan.id, entryId: d.entryId, reason: 'Wrong amount' }, entityId: d.entryId, storeId: f.storeId,
        state: async () => JSON.stringify(await asOrgOn(f.orgId, (tx) => loansRepo.positionOf(tx, f.orgId, loan.id))), secondCallRefused: true,
      },
    };
  },
};

describe.each(Object.keys(builders))('I10 Tier P: %s', (key) => {
  it('no adminPin -> refused with the one sentence; nothing changes; a forged client flag changes nothing (V1, M1)', async () => {
    const { c } = await builders[key]!();
    const before = await c.state();
    const o = await runAction(c.modulePath, c.action, c.fields, c.actor);
    expect(o.flash.error, 'refused with the one sentence').toBe(ADMIN_PIN_REFUSED);
    expect(await c.state(), 'nothing changed').toBe(before);
    const forged = await runAction(c.modulePath, c.action, { ...c.fields, ...FORGED, adminPin: '' }, c.actor);
    expect(forged.flash.error, 'a forged flag is not a PIN').toBe(ADMIN_PIN_REFUSED);
    expect(await c.state(), 'still nothing changed').toBe(before);
    expect(await auditRows(sql, c.f.orgId, 'destructive.approved', c.entityId), 'no approval event for a refused action').toHaveLength(0);
  });

  it('a wrong PIN is refused, charged to the ACTOR (no store; a forged storeId field charges nothing), and nothing changes (V6, M8, T-416)', async () => {
    const { c } = await builders[key]!();
    const [other] = await sql<{ id: string }[]>`insert into stores (org_id, code, name) values (${c.f.orgId}, ${uid('forged')}, 'Forged') returning id`;
    const before = await c.state();
    const actorBefore = await actorMissCount(c.actor.personId);
    const recordBefore = await missCount(c.storeId);
    const o = await runAction(c.modulePath, c.action, { ...c.fields, adminPin: '000000', storeId: other!.id }, c.actor);
    expect(o.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await c.state()).toBe(before);
    expect(await actorMissCount(c.actor.personId), 'the miss is the actor’s').toBe(actorBefore + 1);
    expect(await missCount(c.storeId), 'nothing is charged at the record’s store').toBe(recordBefore);
    expect(await missCount(other!.id), 'nothing is charged at the store the browser named').toBe(0);
  });

  it('a manager’s correct PIN (not an administrator) is refused and nothing changes', async () => {
    const { c, managerPin } = await builders[key]!();
    const before = await c.state();
    const o = await runAction(c.modulePath, c.action, { ...c.fields, adminPin: managerPin }, c.actor);
    expect(o.flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await c.state()).toBe(before);
    expect(await auditRows(sql, c.f.orgId, 'destructive.approved', c.entityId)).toHaveLength(0);
  });

  it('an administrator’s PIN does it, and destructive.approved names actor AND approver in the same transaction (V7, M9)', async () => {
    const { c, adminPin } = await builders[key]!();
    const before = await c.state();
    const o = await runAction(c.modulePath, c.action, { ...c.fields, adminPin }, c.actor);
    expect(o.flash.error, 'the approved action succeeded').toBeUndefined();
    expect(await c.state(), 'the record changed').not.toBe(before);
    const rows = await auditRows(sql, c.f.orgId, 'destructive.approved', c.entityId);
    expect(rows, 'exactly one approval event').toHaveLength(1);
    expect(rows[0]!.store_id, 'store-scoped at the record’s store').toBe(c.storeId);
    const after = rows[0]!.after as Record<string, unknown>;
    expect(after.actorPersonId).toBe(c.actor.personId);
    expect(after.approverPersonId).toBe(c.f.adminId);
    expect(after.entityId).toBe(c.entityId);
    expect(typeof after.capability === 'string' && (after.capability as string).length > 0, 'the capability is named').toBe(true);
    expect(typeof after.entityType === 'string' && (after.entityType as string).length > 0, 'the entity type is named').toBe(true);
    expect(JSON.stringify(after), 'the PIN itself is never recorded').not.toContain(adminPin);

    if (c.secondCallRefused) {
      const again = await runAction(c.modulePath, c.action, { ...c.fields, adminPin }, c.actor);
      expect(again.flash.error, 'the domain refused the second call, AFTER the PIN passed').toBeDefined();
      expect(await auditRows(sql, c.f.orgId, 'destructive.approved', c.entityId), 'a refused mutation leaves no second approval event').toHaveLength(1);
    }
  });
});

describe('I10 Tier P: postOpeningBalancesAction (org-level: the record has no store)', () => {
  async function ready() {
    const f = openingFx; // the purge ran once, in beforeAll, before this org's operational data
    const adminPin = await addPin(f, f.adminId);
    const managerPin = await addPin(f, f.managerId);
    const fig = (code: string, direction: 'debit' | 'credit', amount: string) =>
      asOrgOn(f.orgId, (tx) => D.addOpeningFigure(tx, f.admin, { accountCode: code, storeId: f.storeId, direction, amount, entryDate: '2027-01-01' }));
    await fig('1110', 'debit', '5000.00');
    await fig('1130', 'credit', '5000.00');
    await asOrgOn(f.orgId, (tx) => D.attestStep(tx, f.admin, { stepCode: 'C3P', note: 'T-412 I10 fixture' }));
    const state = async () => String((await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where org_id = ${f.orgId} and status = 'posted'`)[0]!.n);
    return { f, adminPin, managerPin, state };
  }
  const MOD = '../../src/app/cutover/actions';

  it('no PIN, a forged flag, and a manager’s PIN each refuse and post nothing; the administrator’s PIN posts and is audited once', async () => {
    const { f, adminPin, managerPin, state } = await ready();
    const before = await state();
    expect((await runAction(MOD, 'postOpeningBalancesAction', {}, f.admin)).flash.error).toBe(ADMIN_PIN_REFUSED);
    expect((await runAction(MOD, 'postOpeningBalancesAction', { ...FORGED }, f.admin)).flash.error).toBe(ADMIN_PIN_REFUSED);
    expect((await runAction(MOD, 'postOpeningBalancesAction', { adminPin: managerPin }, f.admin)).flash.error).toBe(ADMIN_PIN_REFUSED);
    expect(await state(), 'nothing posted').toBe(before);
    expect(await auditRows(sql, f.orgId, 'destructive.approved')).toHaveLength(0);

    const o = await runAction(MOD, 'postOpeningBalancesAction', { adminPin }, f.admin);
    expect(o.flash.error).toBeUndefined();
    expect(await state(), 'the opening entries posted').not.toBe(before);
    const rows = await auditRows(sql, f.orgId, 'destructive.approved');
    expect(rows).toHaveLength(1);
    expect((rows[0]!.after as Record<string, unknown>).approverPersonId).toBe(f.adminId);
  });
});

describe('I10 Tier R: setItemStatusAction retypes the name the SERVER loads (V8, M10)', () => {
  async function item() {
    const f = await moneyFixture(sql, 'i10-retire');
    const [sa] = await sql<{ id: string }[]>`insert into persons (org_id, display_name) values (${f.orgId}, 'Super') returning id`;
    await sql`insert into person_roles (person_id, org_id, role) values (${sa!.id}, ${f.orgId}, 'super_admin')`;
    const name = `Pork Belly ${uid('i')}`;
    const [it] = await sql<{ id: string }[]>`
      insert into items (org_id, code, name, kind, base_unit, created_by)
      values (${f.orgId}, ${testItemCode()}, ${name}, 'raw_material', 'kg', ${sa!.id}) returning id`;
    const status = async () => (await sql<{ status: string }[]>`select status from items where id = ${it!.id}`)[0]!.status;
    return { f, name, id: it!.id, who: { personId: sa!.id, orgId: f.orgId }, status };
  }
  const MOD = '../../src/app/items/actions';
  const sentence = (name: string) => `Type the name exactly — '${name}' — to confirm.`;

  it('no confirmName, a wrong name and a prefix refuse with the sentence naming the REAL name; nothing changes', async () => {
    const t = await item();
    for (const typed of [undefined, 'Pork', 'something else']) {
      const fields: Record<string, string> = { itemId: t.id, status: 'inactive', ...(typed === undefined ? {} : { confirmName: typed }) };
      const o = await runAction(MOD, 'setItemStatusAction', fields, t.who);
      expect(o.flash.error, `typed ${String(typed)}`).toBe(sentence(t.name));
      expect(await t.status(), 'still active').toBe('active');
    }
  });

  it('a name supplied BY THE FORM is not the expected name: typing a wrong name next to a forged expectedName is still refused (M10)', async () => {
    const t = await item();
    const o = await runAction(MOD, 'setItemStatusAction', { itemId: t.id, status: 'inactive', confirmName: 'Beef', expectedName: 'Beef', name: 'Beef', itemName: 'Beef' }, t.who);
    expect(o.flash.error).toBe(sentence(t.name));
    expect(await t.status()).toBe('active');
  });

  it('the real name, in any case and with stray spaces, retires it', async () => {
    const t = await item();
    const o = await runAction(MOD, 'setItemStatusAction', { itemId: t.id, status: 'inactive', confirmName: `  ${t.name.toUpperCase()}  ` }, t.who);
    expect(o.flash.error).toBeUndefined();
    expect(await t.status()).toBe('inactive');
  });

  it('RESTORING an item is not a danger action: it needs no name (the same action serves Retire and Restore)', async () => {
    const t = await item();
    await sql`update items set status = 'inactive' where id = ${t.id}`;
    const o = await runAction(MOD, 'setItemStatusAction', { itemId: t.id, status: 'active' }, t.who);
    expect(o.flash.error).toBeUndefined();
    expect(await t.status()).toBe('active');
  });
});
