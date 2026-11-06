import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CheckContext } from '../src/components/forms/context';
import { CheckSummary } from '../src/components/forms/CheckSummary';
import { RejectReasonHint } from '../src/app/channel-settlements/review/RejectReasonHint';
import {
  REVIEW_PAGE_SIZE,
  attentionWords,
  listLoanWord,
  listStateWord,
  loanLineDetails,
  ordersHint,
  pageNumber,
  pageSlice,
  reviewHref,
  shortBlocker,
  shortDate,
} from '../src/app/channel-settlements/review/words';

/**
 * T-511 S5b SCREEN POLISH (6 Nov 2026): the list's short words, the readable date, the page slicing and the plain-words note. Pure helpers, no render.
 * The sentences themselves come from the domain (`dayBlockers`); the list shows a few words of each and the day detail keeps the full sentence.
 */
const DIR = join(resolve(__dirname, '..', 'src'), 'app', 'channel-settlements', 'review');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8');
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('shortDate', () => {
  it('prints 2026-10-19 as 19 Oct 2026, with no zero in front of the day [kills: 2026… cut in a phone card]', () => {
    expect(shortDate('2026-10-19')).toBe('19 Oct 2026');
    expect(shortDate('2026-01-05')).toBe('5 Jan 2026');
  });
  it('returns what is not a plain date unchanged [kills: Invalid Date or undefined on the page]', () => {
    expect(shortDate('')).toBe('');
    expect(shortDate('2026-13-01')).toBe('2026-13-01');
    expect(shortDate('soon')).toBe('soon');
  });
});

describe('the list is short, the detail keeps the sentence', () => {
  const lc = (status: 'ok' | 'mismatch' | 'waiting_for_other_stores' | 'no_matching_loan', sentence: string) => ({ status, sentence });
  it('maps every sentence dayBlockers writes to a few words [kills: a 200px-tall row of full sentences]', () => {
    const cases: [string, string][] = [
      ['Not paid yet: Grab still shows this payout as processing.', 'Not paid yet'],
      ['The charges in the file do not explain the whole payout: 12.00 is left over.', 'Charges not explained'],
      ['This store is not matched to the platform code in the file any more. Check the platform code on the channel.', 'Store not matched'],
      ['Waiting for the sales day to be verified', 'Sales day not verified'],
      ['Grab Lipa has no destination account set, so there is nowhere to bank this. Set the account.', 'No bank account set'],
      ['Fees exceeding the payout is a refusal, not a negative deposit. Check the figures.', 'Payout is negative'],
      ['Grab Lipa already has a posted settlement for 2026-10-19. Void that one first.', 'Already posted'],
      ['An earlier day of this channel has not been booked or rejected yet. Decide the earlier days first.', 'Waiting for earlier days'],
      ['A newer file has replaced this day. Open the newer line instead.', 'Replaced by a newer file'],
    ];
    for (const [sentence, words] of cases) expect(shortBlocker(sentence, null), sentence).toBe(words);
  });

  it('the loan blocker is told by the loan check it came from, per status [kills: three loan sentences all reading "Needs a look"]', () => {
    const mismatch = "Grab loan check, all stores together: the loan amounts don't match. The files take 2,363.11 but the loans expect 2,363.12.";
    expect(shortBlocker(mismatch, lc('mismatch', mismatch))).toBe('Loan check differs');
    expect(shortBlocker("Waiting for other stores' files (Lipa).", lc('waiting_for_other_stores', "Waiting for other stores' files (Lipa)."))).toBe("Waiting for other stores' files");
    expect(shortBlocker('No matching loan recorded.', lc('no_matching_loan', 'No matching loan recorded.'))).toBe('No matching loan');
  });

  it('a sentence nobody mapped still shows, as "Needs a look" [kills: a new blocker that vanishes from the list]', () => {
    expect(shortBlocker('Something new the domain started saying.', null)).toBe('Needs a look');
  });

  it('every short phrase is a few words [kills: a "short" status that wraps one word per line]', () => {
    for (const status of ['ok', 'mismatch', 'waiting_for_other_stores', 'no_matching_loan'] as const) {
      expect(listLoanWord(status).label.split(' ').length).toBeLessThanOrEqual(3);
    }
    for (const state of ['pending', 'booked', 'rejected'] as const) expect(listStateWord(state).label.split(' ').length).toBe(1);
    const row = { blockers: ['An earlier day of this channel has not been booked or rejected yet. Decide the earlier days first.'], loanCheck: null, changedSinceBooked: false };
    for (const w of attentionWords(row)) expect(w.split(' ').length).toBeLessThanOrEqual(5);
  });

  it('attentionWords: nothing is empty, repeats collapse, a changed day says so [kills: "Nothing" typed twice; a silent changed day]', () => {
    expect(attentionWords({ blockers: [], loanCheck: null, changedSinceBooked: false })).toEqual([]);
    const earlier = 'An earlier day of this channel has not been booked or rejected yet. Decide the earlier days first.';
    expect(attentionWords({ blockers: [earlier, earlier], loanCheck: null, changedSinceBooked: false })).toEqual(['Waiting for earlier days']);
    expect(attentionWords({ blockers: [], loanCheck: null, changedSinceBooked: true })).toEqual(['Changed since it was booked']);
  });
});

describe('the split-payout note', () => {
  it('is worded in plain words by the domain, not an internal step [kills: "slice 6 change" shown to a manager]', () => {
    const src = readFileSync(resolve(__dirname, '..', '..', '..', 'packages', 'domain', 'src', 'settlement-intake', 'day-checks.ts'), 'utf8');
    expect(src).toContain("const SPLIT_NOTE = 'This payout covers two loans. It cannot be approved yet.';");
    expect(src).not.toMatch(/slice 6 change/);
  });
});

describe('pagination of the list', () => {
  const days = Array.from({ length: 120 }, (_, i) => i + 1);
  it('50 a page: 120 days are three pages of 50, 50 and 20 [kills: 99 days in one 16,000px page]', () => {
    expect(REVIEW_PAGE_SIZE).toBe(50);
    const p1 = pageSlice(days, 1);
    expect([p1.items.length, p1.items[0], p1.pages, p1.from, p1.to, p1.total]).toEqual([50, 1, 3, 1, 50, 120]);
    const p2 = pageSlice(days, 2);
    expect([p2.items[0], p2.items.at(-1), p2.from, p2.to]).toEqual([51, 100, 51, 100]);
    const p3 = pageSlice(days, 3);
    expect([p3.items.length, p3.items[0], p3.from, p3.to]).toEqual([20, 101, 101, 120]);
  });
  it('a page past the end is the last page; an empty list is page 1 of 1 [kills: a blank page from a stale ?page=9]', () => {
    expect(pageSlice(days, 99).page).toBe(3);
    const none = pageSlice([], 4);
    expect([none.page, none.pages, none.items.length, none.from, none.to]).toEqual([1, 1, 0, 0, 0]);
  });
  it('exactly 50 days is one page [kills: an empty second page]', () => {
    expect(pageSlice(days.slice(0, 50), 1).pages).toBe(1);
    expect(pageSlice(days.slice(0, 51), 1).pages).toBe(2);
  });
  it('?page= is a whole number from 1, anything else is page 1 [kills: ?page=-3 or ?page=abc breaking the list]', () => {
    expect(pageNumber('3')).toBe(3);
    for (const bad of [undefined, '', '0', '-2', 'abc', '2.5', '1e3', '99999999']) expect(pageNumber(bad), String(bad)).toBe(1);
  });
  it('reviewHref keeps every other filter, adds page only above 1, and a day [kills: Next dropping the store filter]', () => {
    const f = { store: '00000000-0000-4000-8000-0000000000b2', platform: 'grab', period: '2026-10', needs: true };
    const q = new URL(reviewHref({ ...f, page: 2 }), 'http://x.test').searchParams;
    expect([q.get('store'), q.get('platform'), q.get('period'), q.get('needs'), q.get('page')]).toEqual([f.store, 'grab', '2026-10', '1', '2']);
    expect(reviewHref({ ...f, page: 1 })).not.toContain('page=');
    expect(reviewHref({})).toBe('/channel-settlements/review');
    expect(reviewHref({ page: 3 }, 'abc')).toBe('/channel-settlements/review?page=3&day=abc');
  });
});

describe('the review screen says nothing internal', () => {
  it('no slice number, task number or code name in what page.tsx or DayDetail.tsx print [kills: "slice 6 change" on a manager\'s phone]', () => {
    for (const f of ['page.tsx', 'DayDetail.tsx']) {
      const text = codeOnly(read(f));
      expect(text, f).not.toMatch(/\bslice\s+\d/i);
      expect(text, f).not.toMatch(/\bT-\d{3}/);
      expect(text, f).not.toMatch(/\bmigration\b/i);
      expect(text, f).not.toMatch(/\bS\d[ab]?\b/);
    }
  });
  it('the day detail prints the domain note as it is [kills: a second wording layer on the page]', () => {
    expect(codeOnly(read('DayDetail.tsx'))).toContain('{detail.postNote}');
  });
});

describe('render 2 fixes (6 Nov 2026)', () => {
  const ctx = (blocked: boolean) =>
    ({ active: true, blocked, summary: blocked ? 'Save is off until: A rejection needs a reason.' : null, failing: [], blockers: new Map(), warnings: new Map(), values: {}, setVerdict: () => {}, track: () => () => {}, result: () => undefined, touched: () => false, applies: () => true }) as never;
  const inForm = (blocked: boolean, node: ReturnType<typeof h>) => renderToStaticMarkup(h(CheckContext.Provider, { value: ctx(blocked) }, node));

  it('the hint is not a p[role=status], the shared line is: the form hides the shared one only [kills: the hint hidden by its own rule]', () => {
    const hint = inForm(true, h(RejectReasonHint));
    const shared = inForm(true, h(CheckSummary, { active: true, summary: 'Save is off until: A rejection needs a reason.' }));
    expect(shared).toMatch(/^<p\b[^>]*role="status"/);
    expect(hint).not.toMatch(/^<p\b/);
    expect(hint).toMatch(/^<div\b[^>]*role="status"/);
    expect(hint).toContain('Write a reason to reject this day.');
    expect(codeOnly(read('DayDetail.tsx'))).toContain('[&>p[role=status]]:hidden');
  });
  it('the hint is empty once the reason is filled in, and absent before the checks start [kills: a stale "write a reason"]', () => {
    expect(inForm(false, h(RejectReasonHint))).not.toContain('Write a reason');
    expect(renderToStaticMarkup(h(RejectReasonHint))).toBe('');
  });

  it('the orders hint follows the sign of the difference [kills: "look for an order staff did not record" when staff recorded more]', () => {
    expect(ordersHint('grab', '454.00')).toContain('Look for one staff did not record, such as a late order.');
    const lower = ordersHint('grab', '-120.00');
    expect(lower).toContain('Staff recorded more than the file');
    expect(lower).toContain('cancelled or refunded order');
    expect(lower).not.toContain('late order');
    expect(ordersHint('foodpanda', '10.00')).toContain('date only');
    expect(ordersHint('grab', '10.00')).not.toContain('date only');
  });

  it('a loan line never says "not matched" and "matched automatically" together [kills: the two phrases on one payout line]', () => {
    const base = { amount: '591.24', ownerStoreName: null, allocationSource: 'auto' as const };
    expect(loanLineDetails({ ...base, kind: 'deduction', loanName: null })).toEqual(['Not matched to a loan yet']);
    expect(loanLineDetails({ ...base, kind: 'deduction', loanName: 'Grab loan 1', ownerStoreName: 'Lipa' })).toEqual(['Grab loan 1 (owned by Lipa)', 'Set by the system']);
    expect(loanLineDetails({ ...base, kind: 'deduction', loanName: 'Grab loan 1', allocationSource: 'admin' })).toEqual(['Grab loan 1', 'Set by an administrator']);
    expect(loanLineDetails({ ...base, kind: 'disbursal', loanName: null })).toEqual([]);
  });

  it('a rejected or booked day shows no split note, no sales-correction promise and no Change control: they need a pending day [kills: "cannot be approved yet" on a rejected day]', () => {
    const d = codeOnly(read('DayDetail.tsx'));
    expect(d).toMatch(/detail\.reviewState === 'pending' && detail\.postNote/);
    expect(d).toMatch(/detail\.reviewState === 'pending' && detail\.salesCorrection/);
    expect(d).toMatch(/access\.canOverrideLoans && detail\.reviewState === 'pending'/);
    expect(d).toMatch(/access\.canReopen && detail\.reviewState === 'rejected'/);
  });

  it('a negative amount is never broken over two lines [kills: "-" and the figure on separate lines]', () => {
    const d = codeOnly(read('DayDetail.tsx'));
    // the amount cell never shrinks (it spilled and was clipped by the list's overflow-hidden box); the label takes what is left and wraps
    expect(d).toMatch(/<dd className=\{`[^`]*\$\{r\.amount\.length <= 16 \? 'shrink-0 whitespace-nowrap' : 'min-w-0'\}/);
    expect(d).toMatch(/<dt className="min-w-0">/);
    expect(d).toMatch(/<span className="shrink-0 whitespace-nowrap/);
  });

  it('the store name may wrap in a phone card and in the table; the list prints "Not recorded" on one line [kills: Banay-banay P clipped; a three-line cell]', () => {
    const p = codeOnly(read('page.tsx'));
    expect(p).toMatch(/className="[^"]*whitespace-normal[^"]*"\s+aria-label=\{`Open /);
    expect(p).not.toMatch(/<Td className="whitespace-nowrap">\s*<RowLink/);
    expect(p).toContain("'Not recorded'");
    expect(p).not.toContain("'Not recorded yet'");
  });
});
