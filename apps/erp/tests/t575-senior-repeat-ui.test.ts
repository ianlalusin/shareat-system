import { describe, expect, it, vi } from 'vitest';
import { lookupSeniorRepeat, repeatWarning } from '../src/app/pos/_payment/senior-repeat';

/**
 * T-575 (TESTER) - the payment screen's side of the repeat-ID warning: the plain-words sentence, and the lookup that is skipped silently offline.
 * docs/tasks/575-pos-repeat-senior-id-warning.md: warn under the ID box after it loses focus; never block; offline skip the lookup silently.
 *
 * CONTRACT (the builder matches these): apps/erp/src/app/pos/_payment/senior-repeat.ts exports
 *   repeatWarning(check: { used: number; lastReceiptNo: string | null; lastAt: string | null }, nowMs: number): string | null
 *   lookupSeniorRepeat(o: { idNumber: string; online: boolean; fetch: typeof fetch }): Promise<check | null>   // null = no answer: offline, blank, refused, failed, malformed
 * Times are Manila time (UTC+8), 24-hour, the same way the receipt shows them.
 *
 * RED NOW: the module does not exist.
 */
const NOW = Date.parse('2026-11-13T05:00:00Z'); // 13:00 Manila
const lastAt = (iso: string) => ({ used: 1, lastReceiptNo: 'LIPA-01-000123', lastAt: iso });

describe('T-575 repeatWarning - the sentence', () => {
  it('a card used earlier today reads exactly the ruled sentence, with the receipt and the Manila time [kills: a changed sentence; UTC time]', () => {
    expect(repeatWarning(lastAt('2026-11-13T04:41:00Z'), NOW)).toBe('This ID was already used today at this store (receipt LIPA-01-000123, 12:41). You can still continue.');
  });

  it('a card used on an earlier day (a wider window) says the day instead of "today" [kills: "today" shown for a use last week]', () => {
    const s = repeatWarning(lastAt('2026-11-10T04:41:00Z'), NOW)!;
    expect(s).toBe('This ID was already used on Nov 10, 2026 at this store (receipt LIPA-01-000123, 12:41). You can still continue.');
  });

  it('a Manila-midnight edge: 00:05 Manila on the 13th (16:05Z on the 12th) is still "today" at 13:00 Manila on the 13th [kills: comparing UTC dates]', () => {
    expect(repeatWarning(lastAt('2026-11-12T16:05:00Z'), NOW)).toContain('already used today at this store (receipt LIPA-01-000123, 00:05)');
  });

  it('nothing used: no warning; missing receipt or time on a used card still warns and never prints "null" [kills: a warning for used 0; the word null on screen]', () => {
    expect(repeatWarning({ used: 0, lastReceiptNo: null, lastAt: null }, NOW)).toBeNull();
    const s = repeatWarning({ used: 2, lastReceiptNo: null, lastAt: null }, NOW)!;
    expect(s).toMatch(/^This ID was already used at this store\./);
    expect(s).toContain('You can still continue.');
    expect(s).not.toMatch(/null|undefined|NaN/);
  });
});

describe('T-575 lookupSeniorRepeat', () => {
  const ok = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('online: POSTs the ID in a JSON body to /api/pos/senior-id-check - never in the URL - and returns the answer [kills: an ID in the query string]', async () => {
    const f = ok({ ok: true, used: 1, lastReceiptNo: 'LIPA-01-000123', lastAt: '2026-11-13T04:41:00Z' });
    const r = await lookupSeniorRepeat({ idNumber: ' OSCA-1 ', online: true, fetch: f as never });
    expect(r).toEqual({ used: 1, lastReceiptNo: 'LIPA-01-000123', lastAt: '2026-11-13T04:41:00Z' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/pos/senior-id-check');
    expect(url).not.toContain('OSCA');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ idNumber: 'OSCA-1' });
    expect(new Headers(init.headers).get('content-type')).toMatch(/^application\/json/);
  });

  it('offline: no request at all, no error [kills: a lookup attempted offline]', async () => {
    const f = ok({ ok: true, used: 1, lastReceiptNo: 'X', lastAt: null });
    expect(await lookupSeniorRepeat({ idNumber: 'OSCA-1', online: false, fetch: f as never })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('a blank box asks nothing [kills: a request for an empty number]', async () => {
    const f = ok({ ok: true, used: 0, lastReceiptNo: null, lastAt: null });
    expect(await lookupSeniorRepeat({ idNumber: '   ', online: true, fetch: f as never })).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('a network failure, a refusal and an answer that is not the contract are all silent: null, never a throw [kills: a warning screen that breaks the sale]', async () => {
    expect(await lookupSeniorRepeat({ idNumber: 'A', online: true, fetch: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as never })).toBeNull();
    expect(await lookupSeniorRepeat({ idNumber: 'A', online: true, fetch: ok({ ok: false, error: 'No' }, 403) as never })).toBeNull();
    expect(await lookupSeniorRepeat({ idNumber: 'A', online: true, fetch: ok({ ok: true, used: 'many' }) as never })).toBeNull();
  });
});
