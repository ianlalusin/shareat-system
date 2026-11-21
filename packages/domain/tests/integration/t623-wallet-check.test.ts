import { isTestDatabaseUrl } from '../../../../scripts/lib/test-db-name.mjs';
import { redactDbUrl } from '../../../../tests/helpers/redact-db-url';
/**
 * T-623 - the manager checks a wallet payment marked "to check". docs/tasks/623-pos-wallet-payments-check.md. Real Postgres on a scratch "_test" database (the T-531 fixture).
 * Each case names the mutant it kills.
 */
import { config } from 'dotenv';
import { afterAll, describe, expect, it } from 'vitest';

config({ path: '.env.local' });

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!isTestDatabaseUrl(url)) {
  throw new Error(`Refusing to run against ${redactDbUrl(url)} - the database name must contain "_test".`);
}

import { AuthorizationError } from '@shareat/auth';
import { RefusalError } from '@shareat/db';
import { checkWalletPayment, listWalletPaymentsToCheck } from '../../src/pos';
import { D1, addDays, asOrg, auditsOf, closeAll, manila, porkSale, reading, sell, sql, world, type World } from './_fixtures/t531-day-close';

afterAll(closeAll);

const AT = manila(D1, '12:00');

/** One offline GCash payment (marked "to check", reference GC-0001234) and its payment id. */
async function toCheck(w: World, at: Date = AT) {
  const s = await sell(w, { at, items: [{ item: w.menu.pork, qty: 1 }], offline: true, expectTotal: '250.00', pay: [{ tenderId: w.gcash, amount: '250.00', ref: 'GC-0001234' }] });
  const [p] = await sql<{ id: string }[]>`select id from pos_sales_receipt_payments where receipt_id = ${s.receiptId}`;
  return { receiptId: s.receiptId, paymentId: p!.id };
}
const check = (w: World, paymentId: string, who: World['manager'] = w.manager, storeId: string = w.storeId) =>
  asOrg(w.orgId, (tx) => checkWalletPayment(tx, who, { storeId, paymentId }));
const stored = async (paymentId: string) =>
  (await sql<{ checked_by: string | null; checked_at: Date | null }[]>`select checked_by, checked_at from pos_sales_receipt_payments where id = ${paymentId}`)[0]!;

async function expectRefusal(p: Promise<unknown>, sentence: string | RegExp) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, 'expected a refusal, got success').not.toBeNull();
  expect(err).toBeInstanceOf(RefusalError);
  const msg = (err as RefusalError).userMessage;
  if (typeof sentence === 'string') expect(msg).toBe(sentence);
  else expect(msg).toMatch(sentence);
}

describe('T-623 - checkWalletPayment', () => {
  it('a manager checks a to-check payment: the columns are set, one audit row names receipt, amount and reference [kills: nothing written]', async () => {
    const w = await world();
    const r = await toCheck(w);
    expect(await stored(r.paymentId)).toEqual({ checked_by: null, checked_at: null });
    await expect(check(w, r.paymentId)).resolves.toEqual({ wrote: true });
    const after = await stored(r.paymentId);
    expect(after.checked_by).toBe(w.managerId);
    expect(after.checked_at).toBeInstanceOf(Date);
    const audits = await auditsOf(w, 'pos.payment_checked');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_person_id: w.managerId, store_id: w.storeId, entity_id: r.paymentId, after: { amount: '250.00', referenceNo: 'GC-0001234' } });
    expect((audits[0]!.after as { receiptNo: string }).receiptNo).toMatch(/^.+-01-\d{6}$/);
  });

  it('a second check is a plain refusal naming who and when; nothing more is written [kills: no already-checked guard]', async () => {
    const w = await world();
    const r = await toCheck(w);
    await check(w, r.paymentId);
    const first = await stored(r.paymentId);
    await expectRefusal(check(w, r.paymentId, w.admin), /^This payment was already checked by Manny Manager at \d{1,2}:\d{2}\s?(am|pm)\.$/i);
    expect(await stored(r.paymentId)).toEqual(first);
    expect(await auditsOf(w, 'pos.payment_checked')).toHaveLength(1);
  });

  it('two managers racing: exactly one writes, the other gets the plain refusal [kills: the update ignoring checked_at is null]', async () => {
    const w = await world();
    const r = await toCheck(w);
    const outcomes = await Promise.allSettled([check(w, r.paymentId, w.manager), check(w, r.paymentId, w.admin)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as RefusalError).userMessage).toMatch(/^This payment was already checked/);
    expect(await auditsOf(w, 'pos.payment_checked')).toHaveLength(1);
  });

  it('a cashier is refused and nothing is written [kills: drop authorize]', async () => {
    const w = await world();
    const r = await toCheck(w);
    await expect(check(w, r.paymentId, w.counter)).rejects.toBeInstanceOf(AuthorizationError);
    expect(await stored(r.paymentId)).toEqual({ checked_by: null, checked_at: null });
    expect(await auditsOf(w, 'pos.payment_checked')).toHaveLength(0);
  });

  it('a payment that was never marked to check is refused [kills: no to_check guard]', async () => {
    const w = await world();
    const s = await sell(w, { at: AT, items: [{ item: w.menu.pork, qty: 1 }], expectTotal: '250.00', pay: [{ tenderId: w.cash, amount: '250.00' }] });
    const [p] = await sql<{ id: string }[]>`select id from pos_sales_receipt_payments where receipt_id = ${s.receiptId}`;
    await expectRefusal(check(w, p!.id), 'This payment is not marked "to check".');
    expect(await auditsOf(w, 'pos.payment_checked')).toHaveLength(0);
  });

  it("another store's payment id is refused, even by a manager of the other store [kills: drop the store filter]", async () => {
    const w = await world();
    const r = await toCheck(w);
    await expect(check(w, r.paymentId, w.managerOther, w.store2Id)).rejects.toBeInstanceOf(RefusalError);
    expect(await stored(r.paymentId)).toEqual({ checked_by: null, checked_at: null });
    expect(await auditsOf(w, 'pos.payment_checked')).toHaveLength(0);
  });
});

describe('T-623 - the list and the Z', () => {
  it('the list holds the last 7 days of unchecked payments, newest first, and only for a person with the right', async () => {
    const w = await world();
    const later = addDays(D1, 8);
    const now = manila(later, '18:00');
    await toCheck(w, manila(D1, '12:00')); // 8 days old: too old
    const a = await toCheck(w, manila(later, '12:00'));
    const b = await toCheck(w, manila(later, '13:00'));
    await check(w, a.paymentId);
    const mine = await asOrg(w.orgId, (tx) => listWalletPaymentsToCheck(tx, w.manager, { storeId: w.storeId, now }));
    expect(mine.canCheck).toBe(true);
    expect(mine.payments.map((p) => p.paymentId)).toEqual([b.paymentId]);
    expect(mine.payments[0]).toMatchObject({ tenderName: 'GCash', amount: '250.00', referenceNo: 'GC-0001234' });
    const cashier = await asOrg(w.orgId, (tx) => listWalletPaymentsToCheck(tx, w.counter, { storeId: w.storeId, now }));
    expect(cashier).toEqual({ canCheck: false, payments: [] });
  });

  it('the Z toCheckCount drops by one after a check; the money stays in the wallet row [kills: the old count query]', async () => {
    const w = await world();
    const a = await toCheck(w, manila(D1, '12:00'));
    await toCheck(w, manila(D1, '13:00'));
    await porkSale(w, manila(D1, '14:00'));
    const at = manila(D1, '22:00');
    expect((await reading(w, at)).toCheckCount).toBe(2);
    await check(w, a.paymentId);
    const x = await reading(w, at);
    expect(x.toCheckCount).toBe(1);
    expect(x.byTender.find((t: { tenderId: string }) => t.tenderId === w.gcash)).toMatchObject({ amount: '500.00' });
  });
});
