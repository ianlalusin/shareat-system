/**
 * T-387 S6 - exitStepFromTimestamps: where a rejected / cancelled / void record left, from the furthest timestamp
 * it really has. The fixed convention (stepIndexFor / simpleStepIndexFor) is only the fallback.
 */
import { describe, expect, it } from 'vitest';
import { exitStepFromTimestamps, simpleStepIndexFor, stepIndexFor } from '../src/components/ui/status-steps';

const D = new Date('2026-10-11T00:00:00Z');

describe('branch exits', () => {
  it('no timestamp: the fallback stands (rejected 1, cancelled 0)', () => {
    expect(exitStepFromTimestamps('branch', {}, stepIndexFor('rejected'))).toBe(1);
    expect(exitStepFromTimestamps('branch', { acceptedAt: null, readyAt: null, dispatchedAt: null }, stepIndexFor('cancelled'))).toBe(0);
  });
  it('acceptedAt -> accepted (2); readyAt -> ready (3); dispatchedAt -> dispatched (4)', () => {
    expect(exitStepFromTimestamps('branch', { acceptedAt: D }, 0)).toBe(2);
    expect(exitStepFromTimestamps('branch', { acceptedAt: D, readyAt: D }, 0)).toBe(3);
    expect(exitStepFromTimestamps('branch', { acceptedAt: D, readyAt: D, dispatchedAt: D }, 1)).toBe(4);
  });
  it('the furthest wins even when an earlier column is empty', () => {
    expect(exitStepFromTimestamps('branch', { dispatchedAt: D }, 0)).toBe(4);
  });
  it('never goes below the fallback', () => {
    expect(exitStepFromTimestamps('branch', { acceptedAt: D }, 3)).toBe(3);
  });
});

describe('trade exits', () => {
  it('no timestamp: the fallback (void -> 0)', () => expect(exitStepFromTimestamps('trade', {}, simpleStepIndexFor('trade', 'void'))).toBe(0));
  it('dispatchedAt -> dispatched (2); receivedAt -> received (3)', () => {
    expect(exitStepFromTimestamps('trade', { dispatchedAt: D }, 0)).toBe(2);
    expect(exitStepFromTimestamps('trade', { dispatchedAt: D, receivedAt: D }, 0)).toBe(3);
  });
  it('acceptedAt / readyAt are ignored: a trade order has no such step', () => {
    expect(exitStepFromTimestamps('trade', { acceptedAt: D, readyAt: D }, 0)).toBe(0);
  });
});

it('NEGATIVE: an unknown kind throws', () => {
  expect(() => exitStepFromTimestamps('delivery' as never, {}, 0)).toThrow();
});
