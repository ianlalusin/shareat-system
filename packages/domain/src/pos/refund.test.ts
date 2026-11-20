import { describe, expect, it } from 'vitest';
import { refundAmountsOfLine, refundBlockOf, refundCentsByTender, refundLineCents, refundNoOf, refundRoutes } from './refund';

describe('T-534 S4 - the refund figures (pure)', () => {
  it('q of Q units is round-half-up of net x q / Q; the refund that reaches Q takes the exact remainder', () => {
    // net 428.57 over 2 units: 214.285 rounds UP to 214.29, the last takes 214.28 (never 214.29 again)
    expect(refundLineCents(42857n, 2, 0, 0n, 1)).toBe(21429n);
    expect(refundLineCents(42857n, 2, 1, 21429n, 1)).toBe(21428n);
    // net 535.71 over 3: 178.57 each, the last the remainder 178.57
    expect(refundLineCents(53571n, 3, 0, 0n, 1)).toBe(17857n);
    expect(refundLineCents(53571n, 3, 1, 17857n, 2)).toBe(35714n);
    // all at once is the whole net
    expect(refundLineCents(10001n, 3, 0, 0n, 3)).toBe(10001n);
  });
  it('the pieces of any refund order add up to the net exactly, whatever the rounding', () => {
    for (const net of [1n, 2n, 99n, 10001n, 42857n, 100000n]) {
      for (const sold of [1, 2, 3, 7]) {
        let qty = 0;
        let cents = 0n;
        while (qty < sold) {
          cents += refundLineCents(net, sold, qty, cents, 1);
          qty += 1;
        }
        expect(cents, `net ${net} over ${sold}`).toBe(net);
      }
    }
  });
  it('a piece is never more than what is left, and the screen list has one amount per refundable quantity', () => {
    expect(refundLineCents(2n, 3, 0, 0n, 1)).toBe(1n);
    expect(refundLineCents(2n, 3, 1, 1n, 1)).toBe(1n);
    expect(refundAmountsOfLine({ id: 'l', qty: 4, net: '1000.00' }, 0, 0n)).toEqual(['250.00', '500.00', '750.00', '1000.00']);
    expect(refundAmountsOfLine({ id: 'l', qty: 4, net: '1000.00' }, 3, 75000n)).toEqual(['250.00']);
    expect(refundAmountsOfLine({ id: 'l', qty: 4, net: '1000.00' }, 4, 100000n)).toEqual([]);
  });
  it('what a paid row can still give back is tendered - change given - corrected away - already refunded; a correction target takes back what was moved to it (T-613 D1)', () => {
    const pays = [{ id: 'p1', tenderId: 'c', amount: '1500.00', changeGiven: '500.00' }, { id: 'p2', tenderId: 'c', amount: '200.00', changeGiven: '0.00' }];
    const plain = refundRoutes(pays, [], [{ paymentId: 'p1', tenderId: 'c', amount: '300.00' }]);
    expect(plain).toEqual([{ paymentId: 'p1', tenderId: 'c', left: 70000n }, { paymentId: 'p2', tenderId: 'c', left: 20000n }]);
    // 1,000 kept on p1, 300 corrected to GCash: cash 700, GCash 300; a 100 GCash refund leaves 200.
    const fixed = refundRoutes([pays[0]!], [{ paymentId: 'p1', toTenderId: 'g', amount: '300.00' }], [{ paymentId: 'p1', tenderId: 'g', amount: '100.00' }]);
    expect(fixed).toEqual([{ paymentId: 'p1', tenderId: 'c', left: 70000n }, { paymentId: 'p1', tenderId: 'g', left: 20000n }]);
    // an old refund above the new cap never goes negative
    expect(refundRoutes([pays[0]!], [{ paymentId: 'p1', toTenderId: 'g', amount: '300.00' }], [{ paymentId: 'p1', tenderId: 'c', amount: '900.00' }])[0]!.left).toBe(0n);
  });
  it('the refund block counts the drawer\'s part (cash tenders) apart from the total', () => {
    const kinds = new Map<string, 'cash' | 'wallet'>([['c', 'cash'], ['g', 'wallet']]);
    const pays = [{ tenderId: 'c', amount: '300.00' }, { tenderId: 'g', amount: '200.00' }];
    expect(refundBlockOf([{ total: '500.00' }], pays, kinds)).toEqual({ total: '500.00', cash: '300.00', count: 1 });
    expect(refundCentsByTender(pays)).toEqual(new Map([['c', 30000n], ['g', 20000n]]));
  });
  it('the printed number is <store code>-R-<6 digits>', () => {
    expect(refundNoOf('SL', 7)).toBe('SL-R-000007');
  });
});
