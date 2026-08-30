import { describe, expect, it } from 'vitest';
import { maskAccountNumber, matchesSupplier } from '../src/app/ap/lib';

/**
 * T-188's two pure decisions on the supplier register: what a bank account number looks like on a
 * list, and what a search actually searches.
 */
describe('masking a bank account number for a list', () => {
  it('⭐ keeps the last four — enough to recognise, not enough to use', () => {
    expect(maskAccountNumber('1234567890')).toBe('••••••7890');
  });

  it('⚠️ never grows longer than the number it hides', () => {
    // A 40-dot mask on a 12-digit account tells a reader the number is longer than it is.
    expect(maskAccountNumber('123456789012345678901234')!.length).toBeLessThanOrEqual(12);
  });

  it('a very short number is hidden entirely, never partly revealed', () => {
    expect(maskAccountNumber('12')).toBe('••');
    expect(maskAccountNumber('1234')).toBe('••••');
  });

  it('nothing in, nothing out', () => {
    expect(maskAccountNumber(null)).toBeNull();
  });
});

describe('searching the register', () => {
  const s = {
    name: 'Fleetwide Trading',
    tin: '123-456-789-000',
    representativeName: 'Ms. Reyes',
    email: 'ap@fleetwide.example',
    contactNo: '09171234567',
    bankName: 'BPI',
  } as never;

  it('matches on every field a person would actually type', () => {
    for (const q of ['fleet', '123-456', 'reyes', 'fleetwide.example', '0917', 'bpi']) {
      expect(matchesSupplier(s, q), `"${q}" should match`).toBe(true);
    }
  });

  it('is case-insensitive and ignores surrounding space', () => {
    expect(matchesSupplier(s, '  FLEETWIDE  ')).toBe(true);
  });

  it('⚠️ an empty query matches everything — a blank search box is not a filter', () => {
    expect(matchesSupplier(s, '')).toBe(true);
    expect(matchesSupplier(s, '   ')).toBe(true);
  });

  it('does not match what is not there', () => {
    expect(matchesSupplier(s, 'landbank')).toBe(false);
  });

  it('⛔ a null field never throws and never matches', () => {
    const bare = { name: 'Bare Co.', tin: null, representativeName: null, email: null, contactNo: null, bankName: null } as never;
    expect(matchesSupplier(bare, 'bare')).toBe(true);
    expect(matchesSupplier(bare, 'null')).toBe(false);
  });
});
