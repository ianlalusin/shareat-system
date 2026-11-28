import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T-649 audit fix 1 - the customers register says what a customer is priced from. An INTERNAL customer (one of our own branches) is charged
 * the branch price and never a list, so it must NOT read "Uses the default list"; only an outside customer with no list does.
 *
 * MUTANT: drop the `c.treatment === 'internal'` branch (or move it after the default-list branch) -> the order check goes red.
 */
const src = readFileSync(join(__dirname, '..', 'src', 'app', 'customers', 'page.tsx'), 'utf8');

describe('T-649: the register price-list cell', () => {
  it('an internal customer is "Charged at branch price", decided BEFORE the default list is named', () => {
    const internal = src.search(/c\.treatment === 'internal'\s*\?\s*'Charged at branch price'/);
    const dflt = src.indexOf('Uses the default list');
    expect(internal, 'the internal branch is present').toBeGreaterThan(-1);
    expect(dflt, 'the default-list text is present').toBeGreaterThan(-1);
    expect(internal).toBeLessThan(dflt);
  });
  it('the add form hint names the branch price for our own branches too', () => {
    expect(src).toMatch(/one of our own branches is charged the branch price/);
  });
});
