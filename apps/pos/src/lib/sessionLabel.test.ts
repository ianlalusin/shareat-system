import { describe, expect, it } from 'vitest';
import { sessionDialogLabel, sessionTableLabel } from './sessionLabel';

describe('sessionTableLabel', () => {
  it('uses the table display name when set', () => {
    expect(sessionTableLabel({ tableDisplayName: ' Patio 3 ', tableNumber: '3' })).toBe('Patio 3');
  });
  it('falls back to "Table <number>"', () => {
    expect(sessionTableLabel({ tableNumber: '12' })).toBe('Table 12');
    expect(sessionTableLabel({ tableNumber: 5 })).toBe('Table 5');
    expect(sessionTableLabel({ tableDisplayName: '  ', tableNumber: '7' })).toBe('Table 7');
  });
  it('returns null for N/A (any case) and empty numbers', () => {
    expect(sessionTableLabel({ tableNumber: 'N/A' })).toBeNull();
    expect(sessionTableLabel({ tableNumber: ' n/a ' })).toBeNull();
    expect(sessionTableLabel({ tableNumber: '' })).toBeNull();
    expect(sessionTableLabel({ tableNumber: '   ' })).toBeNull();
    expect(sessionTableLabel({ tableNumber: null })).toBeNull();
    expect(sessionTableLabel({})).toBeNull();
  });
  it('ignores an N/A display name', () => {
    expect(sessionTableLabel({ tableDisplayName: 'N/A', tableNumber: '4' })).toBe('Table 4');
  });
  it('returns null for alacarte even with a table number', () => {
    expect(sessionTableLabel({ sessionMode: 'alacarte', tableNumber: '3' })).toBeNull();
    expect(sessionTableLabel({ sessionMode: 'alacarte', tableDisplayName: 'X', tableNumber: 'N/A' })).toBeNull();
  });
});

describe('sessionDialogLabel', () => {
  it('uses the table label for table sessions', () => {
    expect(sessionDialogLabel({ tableDisplayName: 'Patio 3', tableNumber: '3' })).toBe('Patio 3');
    expect(sessionDialogLabel({ tableNumber: '1' })).toBe('Table 1');
  });
  it('alacarte uses the customer name, never "Table N/A"', () => {
    expect(sessionDialogLabel({ sessionMode: 'alacarte', tableNumber: 'N/A', customer: { name: 'Ben' } })).toBe('Ben');
    expect(sessionDialogLabel({ sessionMode: 'alacarte', tableNumber: 'N/A', customerName: 'Cy' })).toBe('Cy');
  });
  it('alacarte without a name is "Ala Carte"', () => {
    expect(sessionDialogLabel({ sessionMode: 'alacarte', tableNumber: 'N/A' })).toBe('Ala Carte');
  });
  it('non-alacarte without a table is undefined', () => {
    expect(sessionDialogLabel({ tableNumber: 'N/A' })).toBeUndefined();
    expect(sessionDialogLabel({})).toBeUndefined();
  });
});
