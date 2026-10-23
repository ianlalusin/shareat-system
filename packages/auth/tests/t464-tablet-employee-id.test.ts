import { describe, expect, it } from 'vitest';
import { parseTabletEmployeeId, tabletEmployeeIdToStaffCode } from '../src/tablet-employee-id';

/**
 * T-464 - the Employee ID a POS tablet takes is the NUMBER of the badge code: 1-3 digits, expanded to `SE-` + 3 digits.
 * The browser form and the server share this one rule (a leaf with no imports), so these cases cover both.
 */
describe('tabletEmployeeIdToStaffCode', () => {
  it('7, 07 and 007 all mean SE-007; 12 -> SE-012; 999 -> SE-999; whitespace around it is trimmed', () => {
    for (const typed of ['7', '07', '007', ' 7 ']) expect(tabletEmployeeIdToStaffCode(typed), typed).toBe('SE-007');
    expect(tabletEmployeeIdToStaffCode('12')).toBe('SE-012');
    expect(tabletEmployeeIdToStaffCode('999')).toBe('SE-999');
    expect(tabletEmployeeIdToStaffCode('0')).toBe('SE-000');
  });

  it('letters, a prefix, a 4th digit, inner spaces, signs, decimals and the empty string are refused (null)', () => {
    for (const bad of ['', '   ', 'SE-7', 'se007', '7a', 'a7', '0007', '1000', '1 2', '-7', '+7', '7.0', '٣', '７', '0x7']) {
      expect(tabletEmployeeIdToStaffCode(bad), JSON.stringify(bad)).toBeNull();
      expect(parseTabletEmployeeId(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('DEF-725: a digit-heavy stored code can never be reached by what is typed (only SE- + the 3 padded digits are produced)', () => {
    for (const typed of ['1', '10', '100', '999']) expect(tabletEmployeeIdToStaffCode(typed)).toMatch(/^SE-\d{3}$/);
  });
});
