/**
 * T-570 — the pure rules behind "a number box never holds anything but a number" (DEF-821).
 *
 * The formatter is only allowed to emit text the SHARED parser reads back to the same figure, so this file also
 * runs every formatted value through `parseDecimalInput` (T-504 item 7 accepts a correct grouping; DEF-383 refuses
 * a wrong one). A formatter that grouped "500" as "0,500" would pass its own tests and fail every save.
 */
import { describe, expect, it } from 'vitest';
import { parseDecimalInput } from '@shareat/domain/money-input';
import { caretAfterFormat, formatNumberEntry, plainNumberEntry } from '../src/lib/number-entry';

describe('formatNumberEntry groups the whole part and keeps the fraction exactly as typed', () => {
  it.each([
    ['10493.75', '10,493.75'],
    ['1049', '1,049'],
    ['1000', '1,000'],
    ['999', '999'],
    ['16980', '16,980'],
    ['1234567.8', '1,234,567.8'],
    ['16,980', '16,980'],
    ['1,234,567.8', '1,234,567.8'],
    ['10493.7', '10,493.7'],
    ['0.50', '0.50'],
    ['0', '0'],
    ['-1234.50', '-1,234.50'],
    ['  16,980  ', '16,980'],
    ['₱1,234.50', '1,234.50'],
    ['PHP 1234', '1,234'],
  ])('%s -> %s', (raw, want) => {
    expect(formatNumberEntry(raw)).toBe(want);
  });

  it('drops every character that is not a digit, a point or a leading sign', () => {
    expect(formatNumberEntry('12a3b4.5')).toBe('1,234.5');
    expect(formatNumberEntry('abc')).toBe('');
    expect(formatNumberEntry('1 234 567')).toBe('1,234,567');
    expect(formatNumberEntry('1-2-3')).toBe('123');
    expect(formatNumberEntry('-12-3')).toBe('-123');
  });

  it('keeps one decimal point and drops the rest', () => {
    expect(formatNumberEntry('1.2.3')).toBe('1.23');
    expect(formatNumberEntry('12.34.56')).toBe('12.3456');
  });

  it('normalises a leading point and leading zeros (never "0,500" or "01,000")', () => {
    expect(formatNumberEntry('.5')).toBe('0.5');
    expect(formatNumberEntry('-0.5')).toBe('-0.5');
    expect(formatNumberEntry('007')).toBe('7');
    expect(formatNumberEntry('00500')).toBe('500');
    expect(formatNumberEntry('0,500')).toBe('500');
    expect(formatNumberEntry('01,000')).toBe('1,000');
    expect(formatNumberEntry('00.10')).toBe('0.10');
  });

  it('preserves a half-typed entry rather than completing it', () => {
    expect(formatNumberEntry('-')).toBe('-');
    expect(formatNumberEntry('5.')).toBe('5.');
    expect(formatNumberEntry('.')).toBe('0.');
  });

  it('is idempotent — formatting a formatted value changes nothing', () => {
    for (const raw of ['10493.75', '1000', '007', '0.5', '-1234.5', '1,234,567.89', '5.', '.5']) {
      const once = formatNumberEntry(raw);
      expect(formatNumberEntry(once), raw).toBe(once);
    }
  });

  it('whole-number boxes get digits only, with no grouping', () => {
    expect(formatNumberEntry('12a34', { decimal: false, group: false })).toBe('1234');
    expect(formatNumberEntry('1.5', { decimal: false, group: false })).toBe('15');
    expect(formatNumberEntry('-12', { decimal: false, negative: false, group: false })).toBe('12');
  });

  it('⭐ a whole-number box KEEPS a leading zero: "012345" is a PIN, not 12,345', () => {
    expect(formatNumberEntry('012345', { decimal: false, negative: false, group: false })).toBe('012345');
    expect(formatNumberEntry('007', { decimal: false, negative: false, group: false })).toBe('007');
    // Money is the other way round: the parser refuses a leading zero inside a group, so it is dropped there.
    expect(formatNumberEntry('007')).toBe('7');
  });

  it('⭐ every complete formatted value parses back to the same figure (the contract that matters)', () => {
    for (const raw of ['10493.75', '1000', '999', '16,980', '1234567.8', '007', '0.50', '-1234.50', '1,0493.75', '₱1,234.50']) {
      const shown = formatNumberEntry(raw);
      const plain = plainNumberEntry(shown);
      expect(parseDecimalInput(shown, '14,2', 'x', 'The amount'), shown).toBe(
        parseDecimalInput(plain, '14,2', 'x', 'The amount'),
      );
    }
  });
});

describe('plainNumberEntry is what the server is given', () => {
  it.each([
    ['10,493.75', '10493.75'],
    ['-1,234.50', '-1234.50'],
    ['₱1,234.50', '1234.50'],
    ['0.50', '0.50'],
  ])('%s -> %s', (raw, want) => {
    expect(plainNumberEntry(raw)).toBe(want);
  });
});

describe('caretAfterFormat keeps the cursor on the same digit', () => {
  it.each([
    // before, caret, after, where the caret ends up
    ['10493', 5, '10,493', 6],
    ['10493', 3, '10,493', 4],
    ['1049', 4, '1,049', 5],
    ['1049', 2, '1,049', 3], // crosses the comma it lands before, so the next digit joins the right group
    ['1.', 2, '1.', 2],
    ['.', 1, '0.', 2],
    ['-', 1, '-', 1],
    ['007', 3, '7', 1],
    ['1234', 4, '1,234', 5],
  ])('%s @%i -> %s @%i', (before, caret, after, want) => {
    expect(caretAfterFormat(before, caret, after)).toBe(want);
  });

  it('typing after a formatted comma keeps the number correct', () => {
    // "1,049" with the caret after the 0 (its position in "1049"), then the person types 3.
    const before = '1,049';
    const caret = caretAfterFormat('1049', 2, before);
    const typed = `${before.slice(0, caret)}3${before.slice(caret)}`;
    expect(formatNumberEntry(typed)).toBe('10,349');
  });
});
