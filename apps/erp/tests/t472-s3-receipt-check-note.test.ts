/**
 * T-472 S3 - the Sales days page note for the nightly receipt bridge: ONE plain line, only when a recent day check is a mismatch.
 * The wording is a pure function; the page wiring is checked from source (the idiom of t339-sales-day-new-store-picker).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { receiptCheckLine } from '../src/app/sales-days/receipt-check';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(here, '..', 'src', 'app', 'sales-days', 'page.tsx'), 'utf8');
const name = (id: string) => (id === 's1' ? 'Lipa' : 'Malvar');

describe('receiptCheckLine', () => {
  it('says nothing when there is no mismatch', () => {
    expect(receiptCheckLine([], name)).toBeNull();
  });
  it('names the newest mismatch with the peso difference, whatever its sign', () => {
    expect(receiptCheckLine([{ storeId: 's1', posCalendarDate: '2027-01-12', differenceCentavos: -49900 }], name)).toBe(
      'Receipt check: Lipa 12 Jan 2027 differs from the POS day total by ₱499.00.',
    );
  });
  it('counts the rest instead of listing them: still one line', () => {
    const line = receiptCheckLine(
      [
        { storeId: 's1', posCalendarDate: '2027-01-12', differenceCentavos: 150 },
        { storeId: 's2', posCalendarDate: '2027-01-11', differenceCentavos: 5 },
        { storeId: 's1', posCalendarDate: '2027-01-10', differenceCentavos: 5 },
      ],
      name,
    )!;
    expect(line).toContain('(and 2 more days)');
    expect(line.split('\n').length).toBe(1);
  });
});

describe('Sales days page wiring', () => {
  it('reads recent mismatches, only for stores the person may submit for, and renders one Banner line', () => {
    expect(page).toContain('posBridgeRepo.recentMismatches');
    expect(page).toContain('receiptCheckLine');
    expect(page).toMatch(/submitStoreIds\.includes/);
    expect(page).toMatch(/receiptNote && \(\s*<Banner tone="warning">/);
  });
});
