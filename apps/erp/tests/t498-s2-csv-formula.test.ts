import { describe, expect, it, vi } from 'vitest';
import { toCsv } from '../src/lib/csv';

// T-498 S2 / DEF-800: a spreadsheet runs a cell that starts = + - @ TAB CR as a formula.
const cell = (v: string | number): string => toCsv(['h'], [[v]]).split('\r\n')[1] ?? '';

describe('CSV cells that look like formulas are made inert', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(1,1)', `"'@SUM(1,1)"`],
    ['\t=1', "'\t=1"],
    ['\r=1', `"'\r=1"`],
  ])('%j -> %j', (input, out) => {
    expect(cell(input)).toBe(out);
  });

  it('numbers and money figures stay numbers', () => {
    expect(cell('-₱303.03')).toBe('-₱303.03');
    expect(cell('₱-303.03')).toBe('₱-303.03');
    expect(cell('-12')).toBe('-12');
    expect(cell('-1,234.50')).toBe('"-1,234.50"');
    expect(cell('1,234.50')).toBe('"1,234.50"');
    expect(cell('₱1,234.50')).toBe('"₱1,234.50"');
    expect(cell(-5)).toBe('-5');
  });

  it('quoting still works after prefixing', () => {
    expect(cell('=a,"b"')).toBe(`"'=a,""b"""`);
    expect(cell('plain, text')).toBe('"plain, text"');
  });
});

describe('the sales-rollup export route', () => {
  it('writes a channel named =1+1 as an inert cell', async () => {
    vi.resetModules();
    vi.doMock('../src/app/reports/lib', () => ({
      reportScope: async () => ({ actor: { orgId: 'o' }, stores: [], storeId: undefined }),
      runReport: async (_o: string, fn: (tx: unknown) => unknown) => fn({}),
    }));
    vi.doMock('@shareat/domain', () => ({
      getSalesRollup: async () => ({
        periods: [],
        ledgerTotal: '0.00',
        channels: [{ channelName: '=1+1', isRemittedDaily: true, total: '-303.03' }],
        channelTotal: '-303.03',
        modes: [],
        modeTotal: '0.00',
      }),
    }));
    const { GET } = await import('../src/app/reports/sales-rollup/export/route');
    const res = await GET(new Request('http://x/reports/sales-rollup/export?from=2026-01-01&to=2026-01-31'));
    const text = await res.text();
    expect(text).toContain("\r\n'=1+1,Yes,-₱303.03\r\n");
  });
});
