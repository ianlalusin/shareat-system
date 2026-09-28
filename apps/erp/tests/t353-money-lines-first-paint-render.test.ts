/**
 * T-353 (DEF-484) — `docs/tasks/353-def-484-money-lines-errors-before-input.md`, legs R1-R4.
 *
 * The symptom itself: a fresh `/expenses/new` shows two red lines under "Paid 1" before the user
 * has typed anything (screenshot `~/.claude/skills/orchestrator/tools/t348-expenses-fresh-375.png`).
 * `<MoneyLines>` is rendered directly with `renderToStaticMarkup` — no DOM, no JSX, `.ts` only, per
 * `vitest.config.mts`'s unit glob and the style of `t343-s5-5r-prepaid-refund-render.test.ts`.
 *
 * R2 is a guard: loaded data (`initialLines`) must still be judged at first paint (R2.3) — only an
 * UNTOUCHED, un-submitted, default blank line stays quiet.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountAsSource, type MoneyAccountOption, type MoneyLine } from '@shareat/domain/money-lines';
import { MoneyLines } from '../src/components/money/MoneyLines';

const cashierAccount: MoneyAccountOption = {
  id: 'acct-cashier-1',
  name: 'Front cashier',
  storeId: 'store-lipa',
  custodian: 'cashier',
  instrument: 'cash',
  glAccountCode: '1110',
  balance: '5000.00',
  overdraftLimit: '0.00',
  floatTarget: null,
};

// React escapes `"` and `'` in a text node to `&quot;`/`&#x27;` — normalise before matching, the
// same idiom `t350-channel-payout-change-render.test.ts` and `t343-s6b-admin-users-labels.test.ts`
// already use.
function normalise(html: string): string {
  return html.replace(/&quot;/gi, '"').replace(/&#x27;/gi, "'");
}

function render(props: {
  initialLines?: MoneyLine[];
  mustTotal?: string | null;
}): string {
  const html = renderToStaticMarkup(
    createElement(MoneyLines, {
      direction: 'out',
      sources: [accountAsSource(cashierAccount)],
      staff: [],
      ...props,
    }) as never,
  );
  return normalise(html);
}

/**
 * The error-message `<p>` texts only, not the whole page — the page's own hidden/text `<input>`
 * tags always carry `value=""` regardless of the issue text, so matching against the full HTML for
 * `""` (R3) would false-positive on markup that has nothing to do with the message.
 */
function errorMessageTexts(html: string): string[] {
  const matches = html.matchAll(/<p class="[^"]*text-red-700[^"]*">([\s\S]*?)<\/p>/g);
  return [...matches].map((m) => m[1] ?? '');
}

describe('R1 — a fresh form (no initialLines) paints with no error text at all', () => {
  it(
    'wanted: no "text-red-700", no "is not a valid amount", no "Choose where the money came ' +
      'from", no "Enter an amount." — red today: contains both DEF-484 sentences (matches the ' +
      'screenshot)',
    () => {
      const html = render({});
      expect(html).not.toContain('text-red-700');
      expect(html).not.toContain('is not a valid amount');
      expect(html).not.toContain('Choose where the money came from');
      expect(html).not.toContain('Enter an amount.');
    },
  );
});

describe('R2 — guard: loaded data (initialLines) is judged at first paint, not hidden', () => {
  it(
    'wanted: contains the malformed-amount sentence and the Choose-where sentence — already ' +
      'green today (guard)',
    () => {
      const html = render({
        initialLines: [{ method: 'cash', amount: '1,5', moneyAccountId: null }],
      });
      expect(html).toContain('"1,5" is not a valid amount. Use at most two decimal places.');
      expect(html).toContain('Choose where the money came from — every peso has to leave somewhere nameable.');
    },
  );
});

describe('R3 — a loaded blank amount uses the new blank sentence, never quotes ""', () => {
  it(
    'wanted: contains "Enter an amount.", never `""` — red today: contains ' +
      '`"" is not a valid amount…`',
    () => {
      const html = render({
        initialLines: [{ method: 'cash', amount: '', moneyAccountId: null }],
      });
      expect(html).toContain('Enter an amount.');
      const messages = errorMessageTexts(html);
      expect(messages.some((m) => m.includes('Enter an amount.'))).toBe(true);
      expect(messages.some((m) => m.includes('""'))).toBe(false);
    },
  );
});

describe('R4 — a fresh form with a mustTotal does not paint the total-mismatch sentence', () => {
  it(
    'wanted: no "The lines total" — red today: contains ' +
      '"The lines total 0.00 but this document is for 100.00."',
    () => {
      const html = render({ mustTotal: '100.00' });
      expect(html).not.toContain('The lines total');
    },
  );
});
