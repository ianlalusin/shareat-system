/**
 * T-533 S1 (TESTER, written FIRST) - the store POS mode rules, with no database. docs/tasks/533-pos-lipa-switch.md R1.
 * Each rule has its refusal and its pass beside it. The database side (the facts being read right, the audit row, state_version, the
 * actor gate, the v1 import) is `tests/integration/t533-s1-store-mode.test.ts` and `t533-s1-import-skip.test.ts`.
 *
 *   checkModeInput({ mode, liveFrom, reason })        -> { mode, liveFrom | null, reason }      (refuses in words)
 *   judgeGoingLive({ liveFrom, today, firstDay })      -> null | sentence   (firstDay = the first live sales day on or after liveFrom, or null)
 *   judgeLeavingLive({ current, lastZDate })           -> null | sentence   (current = the stored { mode, liveFrom })
 *   preflightRefusal(blocking)                         -> null | sentence
 *   judgeBeforeLive({ currentMode, storeName })        -> null | sentence   (currentMode = the stored mode, or null when the store has no row)
 */
import { describe, expect, it } from 'vitest';
import { RefusalError } from '@shareat/db';
import { checkModeInput, judgeBeforeLive, judgeGoingLive, judgeLeavingLive, preflightRefusal } from './store-mode';

const sentenceOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RefusalError);
    return (e as RefusalError).userMessage;
  }
  throw new Error('expected a refusal, got none');
};

describe('checkModeInput', () => {
  it('accepts off, test and live-with-a-date; trims the reason; live_from is null unless live', () => {
    expect(checkModeInput({ mode: 'off', liveFrom: undefined, reason: '  closed for repairs ' })).toEqual({ mode: 'off', liveFrom: null, reason: 'closed for repairs' });
    expect(checkModeInput({ mode: 'test', liveFrom: '2026-12-07', reason: 'soak' })).toEqual({ mode: 'test', liveFrom: null, reason: 'soak' });
    expect(checkModeInput({ mode: 'live', liveFrom: '2026-12-07', reason: 'Lipa goes live' })).toEqual({ mode: 'live', liveFrom: '2026-12-07', reason: 'Lipa goes live' });
  });

  it('refuses a mode that is not off, test or live', () => {
    expect(sentenceOf(() => checkModeInput({ mode: 'on', liveFrom: undefined, reason: 'x' }))).toContain('off, test or live');
    expect(sentenceOf(() => checkModeInput({ mode: undefined, liveFrom: undefined, reason: 'x' }))).toContain('off, test or live');
  });

  it('refuses live with no date, or a date that is not a real calendar date', () => {
    expect(sentenceOf(() => checkModeInput({ mode: 'live', liveFrom: undefined, reason: 'x' }))).toContain('needs the date');
    expect(sentenceOf(() => checkModeInput({ mode: 'live', liveFrom: '', reason: 'x' }))).toContain('needs the date');
    expect(sentenceOf(() => checkModeInput({ mode: 'live', liveFrom: '2026-02-30', reason: 'x' }))).toContain('not a valid date');
    expect(sentenceOf(() => checkModeInput({ mode: 'live', liveFrom: '7 Dec 2026', reason: 'x' }))).toContain('not a valid date');
  });

  it('the reason is 1 to 200 characters after trimming: empty, blank, not-a-string and 201 are refused; 1 and 200 pass', () => {
    for (const reason of ['', '   ', undefined, 5, 'x'.repeat(201)]) {
      expect(sentenceOf(() => checkModeInput({ mode: 'test', liveFrom: undefined, reason })), String(reason)).toContain('1 to 200 characters');
    }
    expect(checkModeInput({ mode: 'test', liveFrom: undefined, reason: 'x' }).reason).toBe('x');
    expect(checkModeInput({ mode: 'test', liveFrom: undefined, reason: 'x'.repeat(200) }).reason).toHaveLength(200);
    // 201 characters that trim down to 200 pass: the limit is on the trimmed text.
    expect(checkModeInput({ mode: 'test', liveFrom: undefined, reason: ` ${'x'.repeat(200)}` }).reason).toHaveLength(200);
  });
});

describe('judgeGoingLive', () => {
  const TODAY = '2026-12-01';
  it('today and a later date with no sales day on or after it pass', () => {
    expect(judgeGoingLive({ liveFrom: TODAY, today: TODAY, firstDay: null })).toBeNull();
    expect(judgeGoingLive({ liveFrom: '2026-12-07', today: TODAY, firstDay: null })).toBeNull();
  });
  it('a date before today is refused', () => {
    expect(judgeGoingLive({ liveFrom: '2026-11-30', today: TODAY, firstDay: null })).toContain('in the past');
  });
  it('a sales day on or after the date is refused with the next-day sentence and names that day', () => {
    const s = judgeGoingLive({ liveFrom: '2026-12-07', today: TODAY, firstDay: '2026-12-09' });
    expect(s).toContain('already exists. Switch from the next day.');
    expect(s).toContain('9');
    expect(s).toContain('Dec');
  });
});

describe('judgeLeavingLive', () => {
  it('not live: nothing to roll back, always null', () => {
    expect(judgeLeavingLive({ current: null, lastZDate: '2026-12-10' })).toBeNull();
    expect(judgeLeavingLive({ current: { mode: 'off', liveFrom: null }, lastZDate: '2026-12-10' })).toBeNull();
    expect(judgeLeavingLive({ current: { mode: 'test', liveFrom: null }, lastZDate: '2026-12-10' })).toBeNull();
  });
  it('live with no Z at all, or only a Z before live_from: allowed', () => {
    expect(judgeLeavingLive({ current: { mode: 'live', liveFrom: '2026-12-07' }, lastZDate: null })).toBeNull();
    expect(judgeLeavingLive({ current: { mode: 'live', liveFrom: '2026-12-07' }, lastZDate: '2026-12-06' })).toBeNull();
  });
  it('live with a Z on live_from or later: refused with the roll-back sentence', () => {
    for (const lastZDate of ['2026-12-07', '2026-12-20']) {
      expect(judgeLeavingLive({ current: { mode: 'live', liveFrom: '2026-12-07' }, lastZDate }), lastZDate).toBe(
        'Days are already closed on the new POS. Roll back from the next day.',
      );
    }
  });
});

describe('preflightRefusal', () => {
  it('no blocking item: null', () => expect(preflightRefusal([])).toBeNull());
  it('names how many items block and the first sentences, and points at the pre-flight page', () => {
    const s = preflightRefusal([
      { code: 'no_stands', sentence: 'This store has no stands (tables) set up.', href: null },
      { code: 'no_cash_tender', sentence: 'This store has no active cash payment method.', href: null },
    ]);
    expect(s).toContain('2');
    expect(s).toContain('no stands');
    expect(s).toContain('pre-flight');
  });
});

describe('judgeBeforeLive (a store must have been in test before it goes live)', () => {
  it('test and live (moving the date) pass', () => {
    expect(judgeBeforeLive({ currentMode: 'test', storeName: 'SharEat Lipa' })).toBeNull();
    expect(judgeBeforeLive({ currentMode: 'live', storeName: 'SharEat Lipa' })).toBeNull();
  });
  it('off, and no row at all, are refused with the plain test-first sentence naming the store', () => {
    for (const currentMode of ['off', null] as const) {
      expect(judgeBeforeLive({ currentMode, storeName: 'SharEat Lipa' }), String(currentMode)).toBe('Switch SharEat Lipa to test mode first.');
    }
  });
});
