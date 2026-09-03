import { describe, expect, it } from 'vitest';
import { quantity } from '../../src/stock/quantity';
import { validateTransferRequest } from '../../src/stock/transfer-rules';

/** T-167 §7 — the pure half. Written before `transfers.ts` had a caller. */

describe('validateTransferRequest', () => {
  const line = (itemId: string, qty: string) => ({ itemId, quantity: quantity(qty) });

  it('accepts a well-formed request', () => {
    const result = validateTransferRequest({
      fromLocationId: 'A',
      toLocationId: 'B',
      lines: [line('ITEM-1', '5.000')],
    });
    expect(result.ok).toBe(true);
  });

  it('⛔ refuses identical locations', () => {
    const result = validateTransferRequest({
      fromLocationId: 'A',
      toLocationId: 'A',
      lines: [line('ITEM-1', '5.000')],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('two different locations');
  });

  it('⛔ refuses a transfer with no lines', () => {
    const result = validateTransferRequest({ fromLocationId: 'A', toLocationId: 'B', lines: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no lines');
  });

  it('⛔ refuses a non-positive quantity', () => {
    const result = validateTransferRequest({
      fromLocationId: 'A',
      toLocationId: 'B',
      lines: [line('ITEM-1', '0.000')],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ITEM-1');
  });

  it('⭐ refuses the same item on two lines — stock_reservations is unique per (transfer, item)', () => {
    const result = validateTransferRequest({
      fromLocationId: 'A',
      toLocationId: 'B',
      lines: [line('ITEM-1', '2.000'), line('ITEM-1', '3.000')],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('more than one line');
  });

  it('allows several different items on one transfer', () => {
    const result = validateTransferRequest({
      fromLocationId: 'A',
      toLocationId: 'B',
      lines: [line('ITEM-1', '2.000'), line('ITEM-2', '3.000')],
    });
    expect(result.ok).toBe(true);
  });
});
