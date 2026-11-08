/**
 * T-551 (DEF-815) — the live rule for a `number` reads a correct thousands grouping exactly as the shared money
 * parser does (T-504 item 7).
 *
 * The number boxes now GROUP what is typed ("1,200 minutes", "12,500 units"), so a rule that refused the comma
 * would switch Save off on a perfectly good figure — and the person could do nothing about it, because the box
 * puts the comma there itself. A WRONG grouping is still refused, never re-read (DEF-383; `t504-money-commas`).
 */
import { describe, expect, it } from 'vitest';
import { checkField, defineFieldRules, nativeAttrs } from '../../src/field-rules';
import { ungroupThousands } from '../../src/shared/money-input';

const set = defineFieldRules('t551.number-commas', {
  minutes: { label: 'The minutes to pay', kind: 'number', integer: true, min: 0, max: 99999 },
  quantity: { label: 'The quantity', kind: 'number', min: 0, max: 12000 },
});

describe('ungroupThousands — the one reading of a grouping', () => {
  it.each([
    ['16,980', '16980'],
    ['1,234,567.8', '1234567.8'],
    ['-1,200', '-1200'],
    ['1,200.125', '1200.125'],
    ['  16,980  ', '16980'],
  ])('%s -> %s', (raw, want) => {
    expect(ungroupThousands(raw)).toBe(want);
  });

  it.each(['1,5', '16,98,0', ',100', '1,0000', '0,500', '01,000', '1, 000', '16980'])('%s is not a grouping', (raw) => {
    expect(ungroupThousands(raw)).toBeNull();
  });
});

describe('a number rule accepts what the box shows', () => {
  it('an integer with correct grouping passes, and the value handed on is plain', () => {
    expect(checkField(set.minutes, '1,200')).toEqual({ ok: true, value: '1200' });
    expect(checkField(set.minutes, '99,999')).toEqual({ ok: true, value: '99999' });
  });

  it('a decimal with correct grouping passes, and the range is judged on the number', () => {
    expect(checkField(set.quantity, '11,000.5')).toEqual({ ok: true, value: '11000.5' });
    expect(checkField(set.quantity, '12,500.5').ok).toBe(false); // over max 12000, read as 12500.5
  });

  it('the old plain forms are unchanged', () => {
    expect(checkField(set.minutes, '1200')).toEqual({ ok: true, value: '1200' });
    expect(checkField(set.quantity, '0.5')).toEqual({ ok: true, value: '0.5' });
  });

  it('a wrong grouping is still refused by the grammar', () => {
    expect(checkField(set.minutes, '1,5')).toMatchObject({ ok: false, progress: 'Whole numbers only' });
    expect(checkField(set.minutes, '0,500')).toMatchObject({ ok: false, progress: 'Whole numbers only' });
    expect(checkField(set.quantity, '16,98,0')).toMatchObject({ ok: false, progress: 'Numbers only' });
  });

  it('a number box is still a decimal keyboard, and grouping did not make it a pattern field', () => {
    expect(nativeAttrs(set.minutes).inputMode).toBe('numeric');
    expect(nativeAttrs(set.quantity).inputMode).toBe('decimal');
  });
});
