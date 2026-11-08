/**
 * T-511 S6d - the settlement form on /channel-settlements/record is redrawn, not rewired.
 * Spec: docs/tasks/511-settlement-upload-s6d-spec.md.
 *
 *  A  field-name pin: the form posts exactly the names it posted before (captured from git HEAD before the redraw).
 *  B  rendered-text guard: the two developer-history sentences are gone from what a person reads; the new words are present.
 *  C  loanSectionOpen: when the optional loan section opens by itself.
 *  D  SplitWorkspace `stickyDetails`: a class, and the CSS for it only inside the container query that makes two columns.
 *  E  a refused post lands back on the form (with the banner); a good post still goes to the overview.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SplitWorkspace } from '../src/components/ui/SplitWorkspace';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

/** Block comments and whole-line `//` comments out, newlines kept (same shape as the T-542 guard). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ''));
}

/** The 19 `name=` attributes of the form at git HEAD (f1386b4 + spec), rendered with one loan on the channel's store. */
const HEAD_FIELD_NAMES = [
  'businessDate', 'channelId', 'commission', 'differenceReason', 'grossAmount', 'loanAmount', 'loanId',
  'loanOwnerStoreId', 'marketing', 'netDeposited', 'penalty', 'platformFee', 'reference', 'salesDayId',
  'salesDayPicker', 'settledOn', 'storeId', 'vatOnFees', 'withholdingTax',
];

const CHANNEL: { id: string; name: string; storeId: string; storeName: string; outstanding: string; destinationAccountName: string | null; destinationMoneyAccountId: string | null } = {
  id: 'c1', name: 'GrabFood', storeId: 's1', storeName: 'Lipa', outstanding: '0.00',
  destinationAccountName: 'GCash', destinationMoneyAccountId: 'm1',
};

async function renderForm(over: { loans?: { id: string; label: string; storeId: string; outstanding: string }[]; channel?: Partial<typeof CHANNEL> } = {}) {
  const { SettlementForm } = await import('../src/app/channel-settlements/SettlementForm');
  return renderToStaticMarkup(
    createElement(SettlementForm, {
      previewAction: async () => ({ ok: false, error: 'unused' }) as never,
      channels: [{ ...CHANNEL, ...over.channel }],
      days: [{ salesDayId: 'd1', channelId: 'c1', businessDate: '2026-01-15', reportedAmount: '1000.00', ageDays: 1 }],
      loans: over.loans ?? [{ id: 'l1', label: 'Loan A', storeId: 's1', outstanding: '5.00' }],
      today: '2026-01-01',
    }),
  );
}

const textOf = (html: string) =>
  html.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('A - the form still posts the same names', () => {
  it('the set of name= attributes equals the one captured from HEAD, each once', async () => {
    const html = await renderForm();
    const names = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*?\bname="([^"]+)"/g)].map((m) => m[1]!);
    expect([...new Set(names)].sort()).toEqual([...HEAD_FIELD_NAMES].sort());
    expect(names.length, 'no name appears twice').toBe(HEAD_FIELD_NAMES.length);
  }, 120000);
});

describe('B - what a person reads', () => {
  const src = stripComments(read('src/app/channel-settlements/SettlementForm.tsx'));

  it('source outside comments has no 198,148, no "legacy system", no glyph, no old button words', () => {
    expect(src).not.toContain('198,148');
    expect(src).not.toMatch(/legacy system/i);
    expect(src).not.toMatch(/⛔|⭐/);
    expect(src).not.toContain('Post this settlement');
  });

  it('the reasons survive as comments', () => {
    const raw = read('src/app/channel-settlements/SettlementForm.tsx');
    expect(raw).toContain('198,148.29');
    expect(raw).toMatch(/legacy system filtered/i);
  });

  it('renders the four section titles, the button words and the two muted lines', async () => {
    const t = textOf(await renderForm());
    for (const w of [
      'Which day',
      'The payout',
      'What the platform deducted',
      'Loan docked from the payout (optional)',
      'Post settlement',
      'Check the numbers',
      'Each fee posts to its own account. A deduction can be negative: a promo credit stays a minus.',
      "Book platform fees here only. Don't also log them as an expense.",
    ]) expect(t, w).toContain(w);
    expect(t).not.toMatch(/198,148|legacy system/i);
  }, 120000);

  it('an unwired channel says where to set the payout account; the old "above" wording is gone', async () => {
    const t = textOf(await renderForm({ channel: { destinationMoneyAccountId: null, destinationAccountName: null } }));
    expect(t).toContain('No payout account is set for this channel. Set it on the Channel settlements page before recording.');
    expect(t).not.toContain('set it above');
  }, 120000);

  it('"Post settlement" is a text button, not the round icon the words "Post" would pick', async () => {
    const html = await renderForm();
    expect(html).not.toContain('erp-icon-btn');
  }, 120000);

  it('the loan section is a <details>, open when a loan sits on the channel store, closed otherwise', async () => {
    expect(await renderForm()).toMatch(/<details[^>]*\sopen=""/);
    const closed = await renderForm({ loans: [] });
    expect(closed).toMatch(/<details/);
    expect(closed).not.toMatch(/<details[^>]*\sopen=""/);
  }, 120000);
});

describe('C - loanSectionOpen', () => {
  const loans = [{ storeId: 's1' }, { storeId: 's2' }];
  it('opens for each reason, stays closed otherwise', async () => {
    const { loanSectionOpen } = await import('../src/app/channel-settlements/SettlementForm');
    expect(loanSectionOpen({ loanId: 'l1', loanAmount: '', channelStoreId: 's9', loans: [] }), 'a loan chosen').toBe(true);
    expect(loanSectionOpen({ loanId: '', loanAmount: '12.50', channelStoreId: 's9', loans: [] }), 'an amount typed').toBe(true);
    expect(loanSectionOpen({ loanId: '', loanAmount: '', channelStoreId: 's1', loans }), 'loan on the channel store').toBe(true);
    expect(loanSectionOpen({ loanId: '', loanAmount: '', channelStoreId: 's9', loans: [] }), 'no loans').toBe(false);
    expect(loanSectionOpen({ loanId: '', loanAmount: '  ', channelStoreId: 's3', loans }), 'loans of other stores only').toBe(false);
    expect(loanSectionOpen({ loanId: '', loanAmount: '', channelStoreId: undefined, loans }), 'no channel').toBe(false);
  }, 120000);
});

describe('D - SplitWorkspace stickyDetails', () => {
  const render = (extra: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(SplitWorkspace, { form: 'F', details: 'D', ...extra }));

  it('adds the sticky class to the grid only when asked', () => {
    expect(render({ stickyDetails: true })).toContain('split-workspace-sticky');
    expect(render({})).not.toContain('split-workspace-sticky');
    expect(render({ balance: 'details' })).not.toContain('split-workspace-sticky');
  });

  it('the CSS makes the details section sticky ONLY inside the two-column container query', () => {
    const css = read('src/app/globals.css');
    const start = css.indexOf('@container (min-width: 58rem) {');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = start;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) { end = i; break; }
    }
    const block = css.slice(start, end);
    expect(block).toContain('.split-workspace-grid');
    expect(block).toMatch(/\.split-workspace-sticky[^{]*\{[^}]*position:\s*sticky[^}]*top:\s*1rem/);
    const outside = css.slice(0, start) + css.slice(end);
    expect(outside, 'no sticky rule outside the block').not.toContain('split-workspace-sticky');
  });
});

describe('E - errors stay on the form', () => {
  const actions = read('src/app/channel-settlements/actions.ts');
  const body = actions.slice(actions.indexOf('export async function recordSettlementAction'), actions.indexOf('export async function voidSettlementAction'));

  it('a refused post goes back to /channel-settlements/record; a good one to the overview', () => {
    expect(body).toMatch(/catch \(err\)[\s\S]*redirectWithFlash\('\/channel-settlements\/record'[\s\S]*error: errorMessage\(err\)/);
    expect(body).toMatch(/redirectWithFlash\('\/channel-settlements', \{\}, \{ ok: 'posted' \}\)/);
    expect(body).not.toMatch(/catch \(err\)[\s\S]*redirectWithFlash\('\/channel-settlements', \{\}, \{ error/);
  });

  it('the record page reads the flash and draws the banner', () => {
    const page = read('src/app/channel-settlements/record/page.tsx');
    expect(page).toMatch(/withFlash\(searchParams\)/);
    expect(page).toContain('<FlashBanner flash={sp} />');
  });
});
