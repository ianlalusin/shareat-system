import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import { receiptHeaderOf } from './header';
import { formatReceipt } from './receipt-text';
import type { ReceiptView } from './types';

/** T-585 R2/R3 - the one place a ReceiptHeader is built from what the till knows. Made-up names only. */
const identity = { businessName: 'Acme Grill Foods Inc.', addressLines: ['12 Sample St', 'Test City'], tin: '123-456-789-00002' };

describe('receiptHeaderOf', () => {
  it('uses the identity as sent and adds the VAT flag', () => {
    expect(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: true, identity })).toEqual({ ...identity, vatRegistered: true });
  });

  it('an OLD snapshot without an identity prints the store name only, never crashes', () => {
    const expected = { businessName: 'Acme Lipa', addressLines: [], tin: null, vatRegistered: false };
    expect(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: false })).toEqual(expected);
    for (const junk of [undefined, null, 'x', 5, {}, { businessName: '', addressLines: [], tin: null }, { businessName: 'A', addressLines: 'no', tin: null }, { businessName: 'A', addressLines: [], tin: 7 }]) {
      expect(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: false, identity: junk })).toEqual(expected);
    }
  });

  it('survives a JSON round trip (the snapshot cache)', () => {
    const cached = JSON.parse(JSON.stringify({ name: 'Acme Lipa', vatRegistered: true, identity }));
    expect(receiptHeaderOf(cached)).toEqual({ ...identity, vatRegistered: true });
  });
});

describe('what prints', () => {
  const view = (header: ReceiptView['header']): ReceiptView => ({
    header, receiptNo: 'T-1', issuedAtLocal: '15/11/26 10:00', tableLabel: null, heads: null, cashierName: 'Joy', lines: [],
    subtotal: money('0.00'), discountTotal: money('0.00'), total: money('0.00'), tenders: [], change: money('0.00'), diners: [], footerLines: [], offline: false, reprint: false, vat: null,
  });
  const print = (header: ReceiptView['header']) => formatReceipt(view(header), { width: 58, font: 'normal' }).map((l) => l.trim());

  it('the receipt header shows the legal name, the address and the TIN with its branch', () => {
    const out = print(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: true, identity }));
    expect(out.slice(0, 4)).toEqual(['ACME GRILL FOODS INC.', '12 Sample St', 'Test City', 'TIN: 123-456-789-00002 VAT']);
  });

  it('org TIN missing: no TIN line and no TIN label anywhere on the receipt', () => {
    const out = print(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: true, identity: { ...identity, tin: null } }));
    expect(out.join(' ')).not.toMatch(/TIN/);
  });

  it('an old snapshot prints the store name and then the blank line, nothing else', () => {
    const out = print(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: true }));
    expect(out.slice(0, 2)).toEqual(['ACME LIPA', '']);
  });
});

describe('T-601 S4 - the TEST flag', () => {
  it('mode test sets header.test; any other mode leaves the key out (a real slip is unchanged)', () => {
    expect(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: true, identity, mode: 'test' }).test).toBe(true);
    expect(receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: true, mode: 'test' }).test).toBe(true);
    for (const mode of ['live', 'off', undefined]) expect('test' in receiptHeaderOf({ name: 'Acme Lipa', vatRegistered: true, identity, mode })).toBe(false);
  });
});
