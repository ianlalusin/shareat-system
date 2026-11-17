// @vitest-environment happy-dom
/**
 * T-589 B5 — /reports/store-comparison on a phone: each store's figure is a labelled key of the card.
 * MUTANT (named per test): drop `data-card-keys` or `data-card-heading` from StoreComparisonTable.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import { StoreComparisonTable } from '../src/components/reports/StoreComparisonTable';
import { observePhoneTables } from '../src/components/ui/phone-table-cards';

const stop: (() => void)[] = [];
afterEach(() => { stop.splice(0).forEach(f => f()); document.body.replaceChildren(); });
const store = (storeId: string, storeName: string) => ({
  storeId, storeName, openingLabel: 'Opened January 5, 2026', revenue: money('100.00'), costOfSales: money('40.00'), grossProfit: money('60.00'),
  operatingExpenses: money('10.00'), operatingIncome: money('50.00'), otherIncomeExpense: money('0.00'), netIncome: money('50.00'),
});

describe('store comparison card', () => {
  // MUTANT: drop data-card-keys from the table -> the second store's figure becomes an unlabelled subtitle.
  it('both store figures are keys, labelled with the store name alone', () => {
    const root = document.createElement('main');
    root.innerHTML = renderToStaticMarkup(createElement(StoreComparisonTable, { stores: [store('a', 'Demo Store Alpha'), store('b', 'Demo Store Bravo')] }));
    document.body.append(root); stop.push(observePhoneTables(root));
    const cells = Array.from(root.querySelectorAll<HTMLElement>('tbody tr:first-child td')).slice(1);
    expect(cells.map(c => c.dataset.cardSlot)).toEqual(['key', 'key']);
    expect(cells.map(c => c.dataset.cardLabel)).toEqual(['Demo Store Alpha', 'Demo Store Bravo']);
  });
});
