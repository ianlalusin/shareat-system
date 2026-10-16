import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { closeDb, tradeRepo } from '@shareat/db';
import { recordCharge, WHOLESALE_REVENUE_CODE } from '@shareat/domain';
import { api, asOrg, audit, buyer, counts, dispatch, fixture, freezeClock, orderWorth, owed, payNow, sayOf, thawClock, type Fx } from './_fixtures/t433-b2b';

/**
 * T-433 S3 (TESTER) - credit-limit warning, override audit, customer-row lock. Cases 14-21.
 * Limit 10,000 and the buyer already owes 8,000 unless a test says otherwise. Mutants M14..M21.
 *
 * ASSUMED shape of previewCreditExposure's result (the spec fixes the sentence, not the type):
 *   { owed: '8000.00', after: '11000.00', limit: '10000.00', over: true }  - money as 2dp strings.
 * Only `over` (boolean) and the figures are asserted; if the builder picks other names, adjust here.
 */
config({ path: '.env.local' });
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set. See .env.example.');
if (!/shareat_test|_test(\?|$)/.test(url)) {
  throw new Error(`Refusing to run against ${url.replace(/:\/\/[^@]*@/, '://***@')} - name must contain "_test".`);
}
const sql = postgres(url, { max: 5 });

beforeAll(() => freezeClock());
afterAll(async () => {
  thawClock();
  await closeDb();
  await sql.end({ timeout: 5 });
});

/** A buyer who already owes `amount` (charged with NO limit set), then given `limit`. */
async function owing(f: Fx, amount: string, limit: string | null, atStore: string = f.storeId) {
  const customerId = await buyer(sql, f);
  await asOrg(f.orgId, (tx) =>
    recordCharge(tx, f.manager, {
      storeId: atStore, customerId, chargeDate: '2026-10-01', totalAmount: amount, revenueAccountCode: WHOLESALE_REVENUE_CODE,
    }),
  );
  if (limit !== null) await sql`update customers set credit_limit = ${limit} where id = ${customerId}`;
  return customerId;
}
const preview = (f: Fx, who: Fx['manager'], customerId: string, total: string, extra: Record<string, unknown> = {}, storeId = f.storeId) =>
  asOrg(f.orgId, (tx) => api.previewCreditExposure(tx, who, { customerId, storeId, total, ...extra }));
const LIMIT_SENTENCE = /limit of ₱10000\.00/;

describe('S3 credit limit', () => {
  it('14. a 5,000 order over the limit, manager, no reason: the existing refusal; nothing posted (M14: default the reason)', async () => {
    const f = await fixture(sql, 's3c14');
    const customerId = await owing(f, '8000.00', '10000.00');
    const o = await orderWorth(sql, f, customerId, '5000.00');
    const r = await sayOf(dispatch(f, f.manager, o.orderId));
    expect(r.message).toMatch(LIMIT_SENTENCE);
    expect(r.message).toMatch(/owes ₱8000\.00/);
    expect((await counts(sql, f, customerId)).charges).toBe(1); // only the earlier 8,000 charge
    expect(await audit(sql, f.orgId, 'credit_limit.overridden')).toHaveLength(0);
  });

  it('15. the same order with pay-now 3,000 passes (exposure 8,000 + 2,000 = 10,000 is not over) and records NO override (M15: helper ignores payNow)', async () => {
    const f = await fixture(sql, 's3c15');
    const customerId = await owing(f, '8000.00', '10000.00');
    const o = await orderWorth(sql, f, customerId, '5000.00');
    const r = await dispatch(f, f.manager, o.orderId, payNow('3000.00', f.drawerA));
    expect(r.creditOverridden).toBe(false);
    const order = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(order!.creditOverrideReason).toBeNull();
    expect(await audit(sql, f.orgId, 'credit_limit.overridden')).toHaveLength(0);
    expect(await owed(sql, f, customerId)).toBe('10000.00');
  });

  it('16. an override with a reason sets the order columns AND appends exactly one credit_limit.overridden row (M16: no append)', async () => {
    const f = await fixture(sql, 's3c16');
    const customerId = await owing(f, '8000.00', '10000.00');
    const o = await orderWorth(sql, f, customerId, '5000.00');
    const r = await dispatch(f, f.manager, o.orderId, { creditOverrideReason: 'Owner agreed, pays Friday.' });
    expect(r.creditOverridden).toBe(true);
    const order = await asOrg(f.orgId, (tx) => tradeRepo.getOrderById(tx, f.orgId, o.orderId));
    expect(order!.creditOverrideReason).toBe('Owner agreed, pays Friday.');
    expect(order!.creditOverrideBy).toBe(f.manager.personId);
    const rows = await audit(sql, f.orgId, 'credit_limit.overridden');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_person_id).toBe(f.manager.personId);
    expect(rows[0]!.entity_id).toBe(r.chargeId); // entity ar_charges
    expect(JSON.stringify(rows[0]!.after)).toContain('Owner agreed, pays Friday.');
  });

  it('17. no limit set: no check, no audit row, no warning (M17: treat null as 0)', async () => {
    const f = await fixture(sql, 's3c17');
    const customerId = await owing(f, '8000.00', null);
    const o = await orderWorth(sql, f, customerId, '99999.00');
    const p = await preview(f, f.manager, customerId, '99999.00');
    expect(p.over ?? false, 'preview warned about a customer with no limit').toBeFalsy();
    const r = await dispatch(f, f.manager, o.orderId);
    expect(r.creditOverridden).toBe(false);
    expect(await audit(sql, f.orgId, 'credit_limit.overridden')).toHaveLength(0);
  });

  it('18. the 8,000 is owed at store B, a 3,000 order at A: the preview warns AND the gate refuses - exposure is org-wide (M18: store-level balance)', async () => {
    const f = await fixture(sql, 's3c18');
    const customerId = await owing(f, '8000.00', '10000.00', f.otherStoreId);
    const o = await orderWorth(sql, f, customerId, '3000.00');
    const p = await preview(f, f.manager, customerId, '3000.00');
    expect(p.over).toBe(true);
    expect(JSON.stringify(p)).toContain('8000.00');
    expect(JSON.stringify(p)).toContain('11000.00');
    expect(JSON.stringify(p)).toContain('10000.00');
    const r = await sayOf(dispatch(f, f.manager, o.orderId));
    expect(r.message).toMatch(LIMIT_SENTENCE);
    // and pay-now brings the same order back under the line in the preview
    const p2 = await preview(f, f.manager, customerId, '3000.00', { payNow: '1000.00' });
    expect(p2.over ?? false).toBeFalsy();
  });

  it('19. a staff actor calling previewCreditExposure gets the approve_buyer refusal and NO figures (M19: drop its authorize)', async () => {
    const f = await fixture(sql, 's3c19');
    const customerId = await owing(f, '8000.00', '10000.00');
    const r = await sayOf(preview(f, f.staff, customerId, '5000.00'));
    expect(r.message).toMatch(/may not 'approve_buyer'/);
    expect(r.message).not.toMatch(/8000|10000|11000|13000/);
    // a manager at ANOTHER store only is refused too (the capability is checked at the order's store)
    const other = await sayOf(preview(f, f.managerB, customerId, '5000.00'));
    expect(other.message).toMatch(/approve_buyer|store/i);
  });

  it('20. recordCharge alone is still gated at the FULL total (M20: default addedExposure to 0)', async () => {
    const f = await fixture(sql, 's3c20');
    const customerId = await owing(f, '8000.00', '10000.00');
    const charge = (amount: string, reason?: string) =>
      asOrg(f.orgId, (tx) =>
        recordCharge(tx, f.manager, {
          storeId: f.storeId, customerId, chargeDate: '2026-10-10', totalAmount: amount, revenueAccountCode: WHOLESALE_REVENUE_CODE,
          ...(reason ? { creditOverrideReason: reason } : {}),
        }),
      );
    await expect(charge('3000.00')).rejects.toThrow(LIMIT_SENTENCE);
    expect(await owed(sql, f, customerId)).toBe('8000.00');
    await expect(charge('2000.00')).resolves.toBeTruthy(); // exactly at the limit is allowed
    expect(await owed(sql, f, customerId)).toBe('10000.00');
  });

  it('21. RACE: two connections dispatch 1,500 orders at once (limit 10k, owes 8k; spec says 3,000 but 8k+3k is already over, so the first would be refused too): the first posts, the second is refused without an override (M21: remove the FOR UPDATE lock)', async () => {
    const f = await fixture(sql, 's3c21');
    const customerId = await owing(f, '8000.00', '10000.00');
    const a = await orderWorth(sql, f, customerId, '1500.00');
    const b = await orderWorth(sql, f, customerId, '1500.00');

    // Deterministic overlap: transaction 1 dispatches and then HOLDS its transaction open; transaction 2 starts
    // meanwhile. Without a customer-row lock, 2 reads the old 8,000 (1 is uncommitted) and passes. With the lock,
    // 2 waits for 1 to commit, then reads 11,000 and is refused.
    let releaseFirst!: () => void;
    const hold = new Promise<void>((res) => { releaseFirst = res; });
    let firstPosted!: () => void;
    const posted = new Promise<void>((res) => { firstPosted = res; });

    const first = asOrg(f.orgId, async (tx) => {
      const r = await api.dispatchTradeOrder(tx, f.manager, { orderId: a.orderId });
      firstPosted();
      await hold;
      return r;
    });
    await posted;
    const second = sayOf(dispatch(f, f.manager, b.orderId)).then(
      (x) => ({ ok: false as const, x }),
      (e: Error) => ({ ok: e.message }), // sayOf throws 'NOT REFUSED' when the dispatch posted
    ); // a second pooled connection; handler attached at once so a fast outcome is never "unhandled"
    await new Promise((res) => setTimeout(res, 1500)); // let 2 reach its credit read (and block, if locked)
    releaseFirst();
    const r1 = await first;
    const r2 = await second;
    expect(r1.creditOverridden).toBe(false);
    expect(r2, 'the second dispatch must be refused, not posted').toMatchObject({ ok: false });
    const said = (r2 as { x: { message: string } }).x.message;
    expect(said).toMatch(LIMIT_SENTENCE);
    expect(said).toMatch(/owes ₱9500\.00/); // it saw the first dispatch, i.e. it queued behind it
    expect(await owed(sql, f, customerId)).toBe('9500.00');
    expect(await audit(sql, f.orgId, 'credit_limit.overridden')).toHaveLength(0);
  });
});
