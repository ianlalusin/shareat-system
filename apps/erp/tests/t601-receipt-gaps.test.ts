import { describe, expect, it } from 'vitest';
import { missingSeqs } from '../src/app/pos/_till/receipt-gaps';

const r = (terminalNo: number, terminalSeq: number) => ({ terminalNo, terminalSeq });

describe('T-601 S2 missingSeqs - numbers missing between a till\'s lowest and highest', () => {
  it('[1, 2, 4] is missing 3', () => {
    expect(missingSeqs([r(1, 1), r(1, 2), r(1, 4)])).toEqual([{ terminalNo: 1, seq: 3 }]);
  });

  it('two tills are counted apart: till 1 has 1,2,3 and till 2 has 7,9; the only gap is till 2\'s 8', () => {
    expect(missingSeqs([r(1, 1), r(2, 7), r(1, 3), r(1, 2), r(2, 9)])).toEqual([{ terminalNo: 2, seq: 8 }]);
  });

  it('empty and a single row have no gaps', () => {
    expect(missingSeqs([])).toEqual([]);
    expect(missingSeqs([r(1, 5)])).toEqual([]);
  });

  it('input order does not matter, and a repeated number is one number', () => {
    expect(missingSeqs([r(1, 4), r(1, 1), r(1, 1), r(1, 2)])).toEqual([{ terminalNo: 1, seq: 3 }]);
  });
});
