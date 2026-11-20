import { describe, expect, it } from 'vitest';
import { convertBlockOf, netMovesOf } from './convert';

/** T-534 S2 - the pure figures. From = the money that leaves, To = the money that comes in. */
const CASH = 'cash-tender';
const GCASH = 'gcash-tender';
const MAYA = 'maya-tender';
const kinds = new Map<string, 'cash' | 'wallet'>([[CASH, 'cash'], [GCASH, 'wallet'], [MAYA, 'wallet']]);
const c = (fromTenderId: string, toTenderId: string, amount: string, voided = false) => ({ fromTenderId, toTenderId, amount, voidedAt: voided ? new Date() : null });

describe('convertBlockOf', () => {
  it('cash->GCash 500 is cash OUT 500; GCash->cash 200 is cash IN 200; net = in - out = -300', () => {
    expect(convertBlockOf([c(CASH, GCASH, '500.00'), c(GCASH, CASH, '200.00')], kinds)).toEqual({ cashIn: '200.00', cashOut: '500.00', net: '-300.00', count: 2 });
  });
  it('a voided Convert counts nowhere [kills: counting voided rows]', () => {
    expect(convertBlockOf([c(CASH, GCASH, '500.00', true), c(GCASH, CASH, '200.00')], kinds)).toEqual({ cashIn: '200.00', cashOut: '0.00', net: '200.00', count: 1 });
  });
  it('a wallet-to-wallet move moves no drawer cash', () => {
    expect(convertBlockOf([c(GCASH, MAYA, '75.00')], kinds)).toEqual({ cashIn: '0.00', cashOut: '0.00', net: '0.00', count: 1 });
  });
});

describe('netMovesOf', () => {
  it('opposite directions of one pair net to one move, from the larger side', () => {
    expect(netMovesOf([c(CASH, GCASH, '500.00'), c(GCASH, CASH, '200.00')])).toEqual([{ pairKey: expect.any(String), fromTenderId: CASH, toTenderId: GCASH, amount: '300.00' }]);
    expect(netMovesOf([c(CASH, GCASH, '200.00'), c(GCASH, CASH, '500.00')])).toMatchObject([{ fromTenderId: GCASH, toTenderId: CASH, amount: '300.00' }]);
  });
  it('a pair that nets to zero, or is only voided, is no move; different pairs stay separate', () => {
    expect(netMovesOf([c(GCASH, MAYA, '25.00'), c(MAYA, GCASH, '25.00')])).toEqual([]);
    expect(netMovesOf([c(CASH, GCASH, '500.00', true)])).toEqual([]);
    expect(netMovesOf([c(CASH, GCASH, '500.00'), c(CASH, MAYA, '70.00')]).map((m) => m.amount).sort()).toEqual(['500.00', '70.00']);
  });
});
