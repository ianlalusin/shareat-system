/**
 * T-598 S3 -- DEF-681/726 (a decimal money string is shown exactly, never through `Number`) and
 * DEF-501 (a supplier with 0 credit-term days reads "due on the invoice date").
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountAsSource, type MoneyAccountOption } from '@shareat/domain/money-lines';
import { MoneyLines } from '../src/components/money/MoneyLines';
import { SettlementPreviewFigures, isZeroAmount, type PreviewShape } from '../src/app/channel-settlements/SettlementForm';
import { peso } from '../src/lib/format';

// 14 digits: `Number('90071992547409.93')` is 90071992547409.94, a centavo wrong.
const BIG = '90071992547409.93';

describe('DEF-681: peso() keeps a decimal string exact', () => {
  it('shows every digit of a 14-digit balance', () => {
    expect(peso(BIG)).toBe('₱90,071,992,547,409.93');
  });
  it('keeps the sign for a negative and drops it for a zero', () => {
    expect(peso('-27850.00')).toBe('-₱27,850.00');
    expect(peso('-0.00')).toBe('₱0.00');
    expect(peso(12.5)).toBe('₱12.50');
  });
});

function basePreview(overrides: Partial<PreviewShape> = {}): PreviewShape {
  return {
    channelName: 'Foodpanda', outstanding: '1000.00', outstandingCleared: '1000.00', feesTotal: '50.00',
    loanDeduction: '0.00', netDeposited: '950.00', variance: '0.00', settlementGain: '0.00', tolerance: '1.00',
    destinationAccountName: 'Bank A', blockers: [], needsAcknowledgement: false, difference: '0.00',
    differenceSign: 'none', figuresComputed: true, ...overrides,
  };
}

describe('DEF-726: the settlement preview shows exact money and tests zero exactly', () => {
  it('renders the 14-digit variance exactly', () => {
    const html = renderToStaticMarkup(SettlementPreviewFigures({ preview: basePreview({ variance: BIG }) }) as never);
    expect(html).toContain('90,071,992,547,409.93');
  });
  it('isZeroAmount reads decimal strings, not floats', () => {
    expect(isZeroAmount('0.00')).toBe(true);
    expect(isZeroAmount('-0.00')).toBe(true);
    expect(isZeroAmount('0.01')).toBe(false);
    expect(isZeroAmount('not money')).toBe(false);
  });
});

const account: MoneyAccountOption = {
  id: 'acct-1', name: 'Front cashier', storeId: 'store-lipa', custodian: 'cashier', instrument: 'cash',
  glAccountCode: '1110', balance: '5000.00', overdraftLimit: '0.00', floatTarget: null,
};

function renderTerms(days: number): string {
  const html = renderToStaticMarkup(
    createElement(MoneyLines, {
      direction: 'out', sources: [accountAsSource(account)], staff: [],
      supplierId: 'sup-1', supplierName: 'Alberto', supplierCreditTermsDays: days,
      initialLines: [{ method: 'credit', amount: '100.00' }],
    }) as never,
  );
  return html.replace(/&quot;/gi, '"').replace(/&#x27;/gi, "'");
}

describe('DEF-501: 0 credit-term days', () => {
  it('says due on the invoice date, never "0 day terms"', () => {
    const html = renderTerms(0);
    expect(html).toContain('On account — due on the invoice date');
    expect(html).not.toContain('0 day terms');
  });
  it('still says N day terms for a real term', () => {
    expect(renderTerms(30)).toContain('On account — 30 day terms');
  });
});
