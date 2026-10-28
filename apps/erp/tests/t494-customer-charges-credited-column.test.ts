import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-494 - the customer page's charge table reads Total - Settled - Written off - Credited = Outstanding, because `outstanding` is now net of
 * credit notes and returns. A source assertion: the header and the cell both exist, in that order, in the table's usual money style.
 */
const src = readFileSync(resolve(__dirname, '../src/app/customers/[customerId]/page.tsx'), 'utf8');

describe('T-494 the charge table shows what was credited', () => {
  it('has a Credited header after Written off and before Outstanding', () => {
    const w = src.indexOf('>Written off</th>');
    const c = src.indexOf('>Credited</th>');
    const o = src.indexOf('>Outstanding</th>');
    expect(w).toBeGreaterThan(-1);
    expect(c, 'Credited header is missing').toBeGreaterThan(w);
    expect(o).toBeGreaterThan(c);
  });

  it('renders creditedAmount as a peso/mono/tabular cell between written off and outstanding', () => {
    const w = src.indexOf('peso(c.writtenOffAmount)');
    const c = src.indexOf('peso(c.creditedAmount)');
    const o = src.indexOf('{peso(c.outstanding)}</td>');
    expect(c, 'Credited cell is missing').toBeGreaterThan(w);
    expect(o).toBeGreaterThan(c);
    expect(src).toContain('<td className="px-3 py-3 text-right font-mono tabular-nums">{peso(c.creditedAmount)}</td>');
  });
});
