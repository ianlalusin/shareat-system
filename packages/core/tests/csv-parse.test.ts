import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/csv';

describe('parseCsv (T-502 S4)', () => {
  it('reads plain rows with CRLF, LF and a BOM; reports the start line of each record', () => {
    const r = parseCsv('﻿a,b\r\n1,2\n3,4\r\n');
    expect(r).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', '2'] },
      { line: 3, cells: ['3', '4'] },
    ]);
  });
  it('handles quoted commas, doubled quotes and line breaks inside quotes', () => {
    const r = parseCsv('a,b\n"x, y","say ""hi"""\n"two\nlines",z\nlast,row');
    expect(r[1]!.cells).toEqual(['x, y', 'say "hi"']);
    expect(r[2]).toEqual({ line: 3, cells: ['two\nlines', 'z'] });
    expect(r[3]).toEqual({ line: 5, cells: ['last', 'row'] });
  });
  it('skips blank lines but keeps empty cells', () => {
    const r = parseCsv('a,b,c\n\n,,\nx,,z\n\n');
    expect(r.map((x) => x.cells)).toEqual([['a', 'b', 'c'], ['x', '', 'z']]);
    expect(r[1]!.line).toBe(4);
  });
  it('an empty string has no records; an unclosed quote is refused in words', () => {
    expect(parseCsv('')).toEqual([]);
    expect(() => parseCsv('a,b\n"open,1')).toThrow(/line 2.*never closed/);
  });
  it('a quote in the middle of an unquoted cell is kept as text', () => {
    expect(parseCsv('5" pan,x')[0]!.cells).toEqual(['5" pan', 'x']);
  });
});
