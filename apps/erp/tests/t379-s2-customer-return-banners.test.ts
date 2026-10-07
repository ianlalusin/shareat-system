/**
 * T-379 S2 (DEF-592, DEF-564 trade half) - a customer return and a credit application say what happened.
 * `docs/tasks/379-erp-small-follow-ups.md` S2, R2.
 *
 * TESTER, not BUILDER. `recordReturnAction` and `applyCreditAction` (trade/returns) return normally on success (no
 * banner) and `throw new Error(reason)` on a refusal (a digest in production). The target is `voidReturnAction`'s shape:
 * success -> `revalidatePath` then `?store=<S>&ok=<sentence>`; `{ok:false}` and a thrown refusal -> `?error=<sentence>`
 * through the REAL `errorMessage`. The record form must carry the store, or the redirect would drop the picker.
 *
 * Harness: `t376-s2-return-banners.test.ts` (RedirectSignal; the real domain module with only the two customer-return
 * functions replaced, so `refuse` builds real refusals).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`redirect:${to}`);
  }
}

const calls = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    calls.order.push(`redirect:${to}`);
    throw new RedirectSignal(to);
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (p: string) => {
    calls.order.push(`revalidate:${p}`);
  },
}));
vi.mock('../src/lib/session', () => ({
  requireActor: vi.fn(async () => ({ orgId: 'org-1', personId: 'person-1' })),
}));
vi.mock('@/lib/constraint-messages', async () => await import('../src/lib/constraint-messages'));
vi.mock('../src/app/expenses/lib', () => ({
  withOrgPrincipal: async (_orgId: string, fn: (tx: unknown) => unknown) => fn({}),
}));

const mocks = vi.hoisted(() => ({
  recordCustomerReturn: vi.fn(),
  applyCredit: vi.fn(),
}));
vi.mock('@shareat/domain', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    recordCustomerReturn: mocks.recordCustomerReturn,
    applyCredit: mocks.applyCredit,
  };
});

beforeAll(async () => {
  await import('@shareat/domain');
  await import('../src/app/trade/returns/actions');
}, 120_000);

afterEach(() => {
  vi.clearAllMocks();
  calls.order.length = 0;
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SETTLEMENTS: ReadonlyArray<readonly [string, string]> = [
  ['cash_refund', 'Return recorded. The refund was paid out.'],
  ['reduce_ar', 'Return recorded. It comes off what the customer owes.'],
  ['store_credit', 'Return recorded. The customer has it as store credit.'],
  ['mixed', 'Return recorded. Part comes off what the customer owes; the rest is store credit.'],
  ['reverse_transfer', 'Return recorded. The transfer to the branch is reversed.'],
];
const CREDIT_OK = 'Credit applied to the order.';

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}
const RETURN_FORM = { store: 'store-9', tradeOrderId: 'to-1', tradeOrderLineId: 'tol-1', quantity: '2', reason: 'Spoiled' };
const CREDIT_FORM = { store: 'store-9', tradeOrderId: 'to-1', moneyAccountId: 'acct-1', amount: '100.00' };

async function outcomeOf(run: () => Promise<unknown>): Promise<{ redirect: string | null; thrown: Error | null }> {
  try {
    await run();
    return { redirect: null, thrown: null };
  } catch (err) {
    if (err instanceof RedirectSignal) return { redirect: err.to, thrown: null };
    return { redirect: null, thrown: err as Error };
  }
}
const param = (to: string | null, key: string): string | null =>
  to ? new URLSearchParams(to.split('?')[1] ?? '').get(key) : null;
const recordRun = async (entries: Record<string, string> = RETURN_FORM) => {
  const a = await import('../src/app/trade/returns/actions');
  return outcomeOf(() => a.recordReturnAction(form(entries)));
};
const creditRun = async (entries: Record<string, string> = CREDIT_FORM) => {
  const a = await import('../src/app/trade/returns/actions');
  return outcomeOf(() => a.applyCreditAction(form(entries)));
};

describe('B1 recordReturnAction success, per settlement', () => {
  it.each(SETTLEMENTS)(
    '%s: revalidate BEFORE redirect to /trade/returns?store=S&ok=<its sentence>',
    async (settlement, sentence) => {
      // Killing mutants: revalidate after the redirect (order); one generic ok for every settlement (the non-default legs).
      mocks.recordCustomerReturn.mockResolvedValue({ ok: true, settlement });
      const out = await recordRun();
      expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
      expect(out.redirect, 'no redirect on success (the screen stays silent)').not.toBeNull();
      expect(out.redirect!.startsWith('/trade/returns?'), `redirect: ${out.redirect}`).toBe(true);
      expect(param(out.redirect, 'ok'), `redirect: ${out.redirect}`).toBe(sentence);
      expect(param(out.redirect, 'store'), `store lost (redirect: ${out.redirect})`).toBe('store-9');
      expect(param(out.redirect, 'error'), `redirect: ${out.redirect}`).toBeNull();
      const rev = calls.order.indexOf('revalidate:/trade/returns');
      const red = calls.order.findIndex((m) => m.startsWith('redirect:'));
      expect(rev, `no revalidate (order: ${calls.order.join(' | ')})`).toBeGreaterThanOrEqual(0);
      expect(rev, `order: ${calls.order.join(' | ')}`).toBeLessThan(red);
    },
  );
});

describe('B2 {ok:false} with an id in the reason', () => {
  it('redirects with ?error= and no uuid; nothing thrown (mutant: error: result.reason raw)', async () => {
    const withId = 'trade order 0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b does not exist.';
    const { errorMessage } = await import('../src/lib/constraint-messages');
    mocks.recordCustomerReturn.mockResolvedValue({ ok: false, reason: withId });
    const out = await recordRun();
    expect(out.thrown, `the action threw (a digest in production): ${out.thrown?.message}`).toBeNull();
    const shown = param(out.redirect, 'error');
    expect(shown, `no ?error= (redirect: ${out.redirect})`).not.toBeNull();
    expect(shown, 'a uuid reached the page').not.toMatch(UUID_RE);
    expect(shown).toBe(errorMessage(new Error(withId)));
    expect(param(out.redirect, 'store')).toBe('store-9');
    expect(param(out.redirect, 'ok')).toBeNull();
    expect(calls.order.filter((m) => m.startsWith('revalidate:')), `order: ${calls.order.join(' | ')}`).toEqual([]);
  });
});

describe('B3 a thrown refusal', () => {
  it('?error= carries the user sentence, not the raw text; nothing thrown (mutant: drop the try/catch)', async () => {
    const { refuse } = await import('@shareat/domain');
    const sentence = 'The quantity must be a number.';
    mocks.recordCustomerReturn.mockRejectedValue(refuse('raw: quantity failed parse 0190a3b4', sentence));
    const out = await recordRun();
    expect(out.thrown, `the action threw (a digest in production): ${out.thrown?.message}`).toBeNull();
    expect(param(out.redirect, 'error'), `redirect: ${out.redirect}`).toBe(sentence);
    expect(param(out.redirect, 'store')).toBe('store-9');
    expect(param(out.redirect, 'ok')).toBeNull();
  });
});

describe('B4 applyCreditAction', () => {
  it('success: revalidate BEFORE redirect with the credit sentence and the store kept', async () => {
    mocks.applyCredit.mockResolvedValue({ ok: true });
    const out = await creditRun();
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(out.redirect, 'no redirect on success').not.toBeNull();
    expect(param(out.redirect, 'ok'), `redirect: ${out.redirect}`).toBe(CREDIT_OK);
    expect(param(out.redirect, 'store'), `redirect: ${out.redirect}`).toBe('store-9');
    const rev = calls.order.indexOf('revalidate:/trade/returns');
    const red = calls.order.findIndex((m) => m.startsWith('redirect:'));
    expect(rev, `order: ${calls.order.join(' | ')}`).toBeGreaterThanOrEqual(0);
    expect(rev, `order: ${calls.order.join(' | ')}`).toBeLessThan(red);
  });

  it('{ok:false}: ?error= redacted exactly as the thrown path; nothing thrown', async () => {
    const withId = 'trade order 0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b does not exist.';
    const { errorMessage } = await import('../src/lib/constraint-messages');
    mocks.applyCredit.mockResolvedValue({ ok: false, reason: withId });
    const out = await creditRun();
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    const shown = param(out.redirect, 'error');
    expect(shown, `no ?error= (redirect: ${out.redirect})`).not.toBeNull();
    expect(shown, 'a uuid reached the page').not.toMatch(UUID_RE);
    expect(shown).toBe(errorMessage(new Error(withId)));
    expect(param(out.redirect, 'ok')).toBeNull();
  });

  it('a thrown refusal: ?error= carries the sentence; nothing thrown (mutant: drop the try/catch)', async () => {
    const { refuse } = await import('@shareat/domain');
    const sentence = 'That amount is more than the credit on the order.';
    mocks.applyCredit.mockRejectedValue(refuse('raw: amount over credit 0190a3b4', sentence));
    const out = await creditRun();
    expect(out.thrown, `the action threw: ${out.thrown?.message}`).toBeNull();
    expect(param(out.redirect, 'error'), `redirect: ${out.redirect}`).toBe(sentence);
  });
});

describe('B5 no store in the form', () => {
  it('there is no store param, on success and refusal, for both actions; control: a store is kept', async () => {
    const { store: _s1, ...noStoreReturn } = RETURN_FORM;
    const { store: _s2, ...noStoreCredit } = CREDIT_FORM;
    const has = (to: string | null) => new URLSearchParams((to ?? '').split('?')[1] ?? '').has('store');

    mocks.recordCustomerReturn.mockResolvedValue({ ok: true, settlement: 'reduce_ar' });
    const a = await recordRun(noStoreReturn);
    expect(a.redirect, 'no redirect').not.toBeNull();
    expect(has(a.redirect), `redirect: ${a.redirect}`).toBe(false);
    mocks.recordCustomerReturn.mockResolvedValue({ ok: false, reason: 'refused' });
    const b = await recordRun(noStoreReturn);
    expect(has(b.redirect), `redirect: ${b.redirect}`).toBe(false);
    expect(param(b.redirect, 'error')).toBe('refused');

    mocks.applyCredit.mockResolvedValue({ ok: true });
    const c = await creditRun(noStoreCredit);
    expect(c.redirect, 'no redirect').not.toBeNull();
    expect(has(c.redirect), `redirect: ${c.redirect}`).toBe(false);
    mocks.applyCredit.mockResolvedValue({ ok: false, reason: 'refused' });
    const d = await creditRun(noStoreCredit);
    expect(has(d.redirect), `redirect: ${d.redirect}`).toBe(false);

    mocks.recordCustomerReturn.mockResolvedValue({ ok: true, settlement: 'reduce_ar' });
    const keep = await recordRun();
    expect(param(keep.redirect, 'store'), `control redirect: ${keep.redirect}`).toBe('store-9');
  });
});

describe('B6 the sentences carry no amount and no id', () => {
  it('no ok value contains a peso sign, a digit or a uuid; none is empty', async () => {
    const seen: Array<string | null> = [];
    for (const [settlement] of SETTLEMENTS) {
      mocks.recordCustomerReturn.mockResolvedValue({ ok: true, settlement });
      seen.push(param((await recordRun()).redirect, 'ok'));
    }
    mocks.applyCredit.mockResolvedValue({ ok: true });
    seen.push(param((await creditRun()).redirect, 'ok'));
    for (const ok of seen) {
      expect(ok, 'a success produced no ok sentence').not.toBeNull();
      expect(ok).not.toBe('');
      expect(ok, `sentence: ${ok}`).not.toMatch(/₱|\d/);
      expect(ok, `sentence: ${ok}`).not.toMatch(UUID_RE);
    }
  });
});

describe('W3 the record form carries the store', () => {
  it('the recordReturnAction form contains name="store" (HEAD: no hidden store input)', () => {
    const src = readFileSync(resolve(__dirname, '../src/app/trade/returns/page.tsx'), 'utf8');
    const start = src.indexOf('<form action={recordReturnAction}');
    expect(start, 'the record form is gone from the page').toBeGreaterThanOrEqual(0);
    const end = src.indexOf('</form>', start);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end), 'the record form drops the chosen store on redirect').toMatch(/name=["']store["']/);
  });
});
