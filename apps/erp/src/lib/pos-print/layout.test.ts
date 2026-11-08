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

// T-528b section 5 (absorbed into T-528). RED NOW FOR THE RIGHT REASON: justify overflows when the RIGHT value is long, and wrap drops leading spaces.
describe('T-528b - justify and wrap never overflow, and keep an indent', () => {
  it('justify never overflows: a 40-character right value at 32 columns puts the label on its own line, then the value, every line <= 32', () => {
    const right = 'x'.repeat(40);
    const lines = justify('TOTAL', right, 32);
    expect(lines[0]).toBe('TOTAL');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32);
    expect(lines[1]).toBe('x'.repeat(32)); // the value is cut with wrap, right-aligned (a full line is flush right)
    expect(lines.slice(1).join('').replace(/\s/g, '')).toBe(right); // nothing lost
    expect(lines[lines.length - 1]!.endsWith('x'.repeat(8))).toBe(true);
  });

  it('justify never overflows at any width with a long right value of several words', () => {
    for (const cols of [32, 42, 48, 64]) {
      for (const line of justify('Ref', 'GCASH 4012 889 213 4012 889 213 4012 889 213 4012 889 213', cols)) expect(line.length).toBeLessThanOrEqual(cols);
    }
  });

  it('wrapped indented text keeps its indent: a long "  10% promo for regular guests (1)" at 32 columns, every continuation line starts with two spaces', () => {
    const lines = justify('  10% promo for regular guests (1)', '-15.00', 32);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('  10% promo for regular');
    expect(lines[1]!.startsWith('  guests (1)')).toBe(true);
    expect(lines[1]!.endsWith(' -15.00')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32);
  });

  it('wrap itself keeps the leading spaces on every continuation line', () => {
    const lines = wrap('  10% promo for regular guests (1)', 20);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect(line.startsWith('  ')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
    expect(lines.map((l) => l.trim()).join(' ')).toBe('10% promo for regular guests (1)');
  });
});
