import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * T-433 (TESTER) case 13 - the REAL dispatchOrderAction with pay-now fields.
 * Form fields assumed (spec: "payNowAmount + moneyAccountId + photo"): payNowAmount, moneyAccountId,
 * receiptPhoto (same name recordCollectionAction reads), referenceNo optional.
 * Mutant M13: the action drops payNow -> the order is billed but nothing is paid.
 * Clock frozen at 2026-10-16.
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
import { captureRedirect, outcomeOf, resetJar } from '../helpers/flash-jar';
import { buyer, counts, fixture, freezeClock, orderWorth, owed, thawClock } from '../../../../packages/domain/tests/integration/_fixtures/t433-b2b';

const sql = postgres(url, { max: 5 });
beforeAll(() => freezeClock());
afterAll(async () => {
  thawClock();
  await closeDb();
  await sql.end({ timeout: 5 });
});

async function runDispatch(fields: Record<string, string | File>, who: { personId: string; orgId: string }) {
  const act = (await import('../../src/app/trade/orders/actions')).dispatchOrderAction;
  resetJar();
  h.actor = who;
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return outcomeOf(await captureRedirect(() => act(fd)));
}

describe('T-433 case 13: dispatchOrderAction pays now', () => {
  it('payNowAmount + moneyAccountId + photo: flash says dispatched, billed and paid 2,000.00 with 3,000.00 still owed; the books agree (M13: action drops payNow)', async () => {
    const f = await fixture(sql, 'act13');
    const customerId = await buyer(sql, f);
    const o = await orderWorth(sql, f, customerId, '5000.00');
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'proof.jpg', { type: 'image/jpeg' });
    const out = await runDispatch({ orderId: o.orderId, payNowAmount: '2000.00', moneyAccountId: f.drawerA, receiptPhoto: photo }, f.manager);
    expect(out.flash.error ?? null).toBeNull();
    expect(out.flash.ok).toBe('Dispatched, billed and paid ₱2,000.00; ₱3,000.00 still owed.');
    expect(await counts(sql, f, customerId)).toMatchObject({ charges: 1, collections: 1, allocations: 1 });
    expect(await owed(sql, f, customerId)).toBe('3000.00');
  });

  it('a blank payNowAmount is the old dispatch: billed, nothing collected, the old flash', async () => {
    const f = await fixture(sql, 'act13b');
    const customerId = await buyer(sql, f);
    const o = await orderWorth(sql, f, customerId, '5000.00');
    const out = await runDispatch({ orderId: o.orderId, payNowAmount: '', moneyAccountId: '' }, f.manager);
    expect(out.flash.ok).toMatch(/^Dispatched and billed/);
    expect(await counts(sql, f, customerId)).toMatchObject({ charges: 1, collections: 0 });
  });

  it('an over-paid amount comes back as the refusal sentence on the order page, and nothing posts', async () => {
    const f = await fixture(sql, 'act13c');
    const customerId = await buyer(sql, f);
    const o = await orderWorth(sql, f, customerId, '5000.00');
    const out = await runDispatch({ orderId: o.orderId, payNowAmount: '5000.01', moneyAccountId: f.drawerA }, f.manager);
    expect(out.flash.error).toBe("Paid now cannot be more than this order's ₱5000.00.");
    expect(await counts(sql, f, customerId)).toMatchObject({ charges: 0, collections: 0, movements: 0 });
  });
});
