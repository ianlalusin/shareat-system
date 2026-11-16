import { describe, expect, it } from 'vitest';
import { receiptIdentityOf } from './receipt-identity';

/** T-585 R1 - who a receipt says issued it. Made-up names and numbers only. */
const org = { name: 'Acme Grill', legalName: 'Acme Grill Foods Inc.', tin: '123456789' };
const store = { tinBranchCode: '00002', address: '12 Sample St\n  Test City, Batangas  ', contactNumber: '0917 123 4567' };

describe('receiptIdentityOf', () => {
  it('carries the legal name, the TIN with its branch, each address line and the contact number', () => {
    expect(receiptIdentityOf(org, store)).toEqual({
      businessName: 'Acme Grill Foods Inc.',
      addressLines: ['12 Sample St', 'Test City, Batangas', '0917 123 4567'],
      tin: '123-456-789-00002',
    });
  });

  it('legal name null or blank falls back to the trading name', () => {
    expect(receiptIdentityOf({ ...org, legalName: null }, store).businessName).toBe('Acme Grill');
    expect(receiptIdentityOf({ ...org, legalName: '   ' }, store).businessName).toBe('Acme Grill');
  });

  it('org TIN missing gives no TIN at all, even with a branch code', () => {
    expect(receiptIdentityOf({ ...org, tin: null }, store).tin).toBeNull();
    expect(receiptIdentityOf({ ...org, tin: '' }, store).tin).toBeNull();
  });

  it('branch code missing prints the org TIN alone', () => {
    expect(receiptIdentityOf(org, { ...store, tinBranchCode: null }).tin).toBe('123-456-789');
  });

  it('a short branch code is printed as stored (no padding the house does not do)', () => {
    expect(receiptIdentityOf(org, { ...store, tinBranchCode: '002' }).tin).toBe('123-456-789-002');
  });

  it('a 12-digit org TIN already carries a branch: with a store branch only its first 9 digits print; without one it prints as stored', () => {
    const long = { ...org, tin: '123456789000' };
    expect(receiptIdentityOf(long, store).tin).toBe('123-456-789-00002');
    expect(receiptIdentityOf(long, { ...store, tinBranchCode: null }).tin).toBe('123-456-789-000');
  });

  it('blank address and contact give no lines, never an empty line or a placeholder', () => {
    expect(receiptIdentityOf(org, { ...store, address: null, contactNumber: null }).addressLines).toEqual([]);
    expect(receiptIdentityOf(org, { ...store, address: ' \n\r\n ', contactNumber: '  ' }).addressLines).toEqual([]);
    expect(receiptIdentityOf(org, { ...store, address: 'Only line\r\n\r\n', contactNumber: null }).addressLines).toEqual(['Only line']);
  });
});
