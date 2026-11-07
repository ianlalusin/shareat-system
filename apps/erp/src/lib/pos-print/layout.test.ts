import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { money } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import { center, columnsFor, justify, printAmount, rule, wrap } from './layout';

const here = dirname(fileURLToPath(import.meta.url));

describe('T-528a — layout primitives', () => {
  it('columns per paper and font', () => {
    // The four combinations are a printer fact: 58 mm Font A/B and 80 mm Font A/B.
    expect(columnsFor({ width: 58, font: 'normal' })).toBe(32);
    expect(columnsFor({ width: 58, font: 'small' })).toBe(42);
    expect(columnsFor({ width: 80, font: 'normal' })).toBe(48);
    expect(columnsFor({ width: 80, font: 'small' })).toBe(64);
  });

  it('printAmount adds commas without arithmetic', () => {
    expect(printAmount(money('0.00'))).toBe('0.00');
    expect(printAmount(money('7.58'))).toBe('7.58');
    expect(printAmount(money('1234.50'))).toBe('1,234.50');
    expect(printAmount(money('1234567.89'))).toBe('1,234,567.89');
    expect(printAmount(money('-48.11'))).toBe('-48.11');
    // No currency symbol: thermal code pages frequently have no ₱.
    expect(printAmount(money('999.00'))).not.toContain('₱');

    // The figure is a decimal string and must be grouped as one. A numeric cast in here would put a
    // float between the amount the diner paid and the amount on the paper (bible §6). Scan the body
    // of `printAmount` itself, so a stray mention in a comment (or a `Number.isInteger` guard
    // elsewhere in the file) neither hides a real cast nor trips the check by itself.
    const source = readFileSync(resolve(here, 'layout.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function printAmount'));
    const printAmountBody = body.slice(0, body.indexOf('\n}') + 2);
    expect(printAmountBody.length).toBeGreaterThan(0);
    expect(printAmountBody).not.toContain('Number(');
    expect(printAmountBody).not.toContain('parseFloat');
  });

  it('justify and wrap never exceed the width', () => {
    // A long description wraps, and the amount stays on the last of its lines, right-aligned.
    const wrapped = justify('Unli Samgyup + Cheese, extra rice, no beef', '1,796.00', 32);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(line.length).toBeLessThanOrEqual(32);
    expect(wrapped[wrapped.length - 1]?.endsWith('1,796.00')).toBe(true);
    // ...and there is always at least one space before the amount.
    expect(wrapped[wrapped.length - 1]).toMatch(/ 1,796\.00$/);

    // One word with no spaces in it cannot wrap: it is cut at the paper edge, not pushed off it.
    const longWord = 'x'.repeat(40);
    expect(wrap(longWord, 32)).toEqual(['x'.repeat(32), 'x'.repeat(8)]);
    for (const line of wrap(longWord, 32)) expect(line.length).toBeLessThanOrEqual(32);

    // A rule is the paper width; a centred line is indented to look centred and never overflows.
    expect(rule(32)).toBe('-'.repeat(32));
    expect(center('REFILL', 32).length).toBeLessThanOrEqual(32);
    expect(center('REFILL', 32).trim()).toBe('REFILL');
    // Centring pads on the left (a thermal printer trims nothing on the right, so trailing spaces
    // would only waste paper and make the two halves of a line look asymmetric on the roll).
    expect(center('ab', 6)).toBe('  ab');
    expect(center('a very long header that overflows', 8)).toBe('a very long header that overflows');
  });

  it('keeps words whole where it can', () => {
    expect(wrap('Chili flakes', 32)).toEqual(['Chili flakes']);
    expect(wrap('Chili flakes, dried, crushed, harvested', 20)).toEqual(['Chili flakes, dried,', 'crushed, harvested']);
    // Empty text is one empty line, not zero lines: a caller pushing it still gets a line break.
    expect(wrap('', 32)).toEqual(['']);
  });
});
