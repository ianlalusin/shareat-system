import { describe, expect, it } from 'vitest';
import { availableByPayment, keptOf, tenderNetsAfterCorrections } from './tender-correction';

describe('T-534 S3 - the correction figures (pure)', () => {
  it('keeps what the till kept: tendered minus change', () => {
    expect(keptOf({ amount: '1500.00', changeGiven: '500.00' })).toBe(100000n);
  });
  it('what is left on a paid row is kept minus every correction off it', () => {
    const left = availableByPayment([{ id: 'p1', tenderId: 'cash', amount: '1500.00', changeGiven: '500.00' }, { id: 'p2', tenderId: 'gc', amount: '200.00', changeGiven: '0' }], [{ paymentId: 'p1', amount: '300.00' }, { paymentId: 'p1', amount: '0.50' }]);
    expect(left.get('p1')).toBe(69950n);
    expect(left.get('p2')).toBe(20000n);
  });
  it('a correction moves its amount from the old method to the new; a method left at exactly zero by it is dropped', () => {
    const pay = [{ tenderId: 'cash', net: 100000n }];
    expect(tenderNetsAfterCorrections(pay, [{ fromTenderId: 'cash', toTenderId: 'gc', amount: '300.00' }])).toEqual(new Map([['cash', 70000n], ['gc', 30000n]]));
    expect(tenderNetsAfterCorrections(pay, [{ fromTenderId: 'cash', toTenderId: 'gc', amount: '1000.00' }])).toEqual(new Map([['gc', 100000n]]));
    // no correction: a method at zero for its own reasons stays (this never hides a row the receipts made)
    expect(tenderNetsAfterCorrections([{ tenderId: 'cash', net: 0n }], [])).toEqual(new Map([['cash', 0n]]));
  });
});
