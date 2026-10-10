/**
 * T-387 S6 - the pure stage -> step module (components/ui/status-steps.ts).
 *
 * API pinned:
 *   branchOrderSteps                  readonly ['draft','submitted','accepted','ready','dispatched','received']
 *   deliverySteps                     readonly ['draft','received']
 *   tradeOrderSteps                   readonly ['draft','confirmed','dispatched','received']  (no 'submitted': L10)
 *   stepIndexFor(stage)               branchOrderStage() value -> index; exits -> the index where the order left
 *   isExitStage(stage)                true for rejected / cancelled
 *   nextLineFor(stage, side)          side 'branch' | 'commissary'; sentence pinned below
 *   simpleStepIndexFor(kind, status)  kind 'delivery' | 'trade'; statuses of the schema; 'void' is an exit
 * Unknown stage / side / status THROWS (never blank).
 */
import { describe, expect, it } from 'vitest';
import {
  branchOrderSteps,
  deliverySteps,
  isExitStage,
  nextLineFor,
  simpleStepIndexFor,
  stepIndexFor,
  tradeOrderSteps,
} from '../src/components/ui/status-steps';

const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);

describe('the step lists', () => {
  it('branch order: draft, submitted, accepted, ready, dispatched, received', () => {
    expect([...branchOrderSteps]).toEqual(['draft', 'submitted', 'accepted', 'ready', 'dispatched', 'received']);
  });
  it('delivery: draft, received', () => expect([...deliverySteps]).toEqual(['draft', 'received']));
  it('trade order has no submitted step (L10: no submittedAt column)', () => {
    expect([...tradeOrderSteps]).toEqual(['draft', 'confirmed', 'dispatched', 'received']);
    expect([...tradeOrderSteps]).not.toContain('submitted');
  });
});

describe('stepIndexFor: every BranchOrderStage', () => {
  it.each([
    ['draft', 0],
    ['submitted', 1],
    ['accepted', 2],
    ['ready', 3],
    ['dispatched', 4],
    ['received', 5],
  ] as const)('%s -> %i', (stage, i) => {
    expect(stepIndexFor(stage)).toBe(i);
    expect(branchOrderSteps[i]).toBe(stage);
    expect(isExitStage(stage)).toBe(false);
  });
  it('rejected leaves at submitted (1): the commissary declines what it was asked to fill', () => {
    expect(stepIndexFor('rejected')).toBe(1);
    expect(isExitStage('rejected')).toBe(true);
  });
  it('cancelled leaves at draft (0)', () => {
    expect(stepIndexFor('cancelled')).toBe(0);
    expect(isExitStage('cancelled')).toBe(true);
  });
  it('NEGATIVE: an unknown stage throws, not blank / NaN / -1', () => {
    expect(() => call(stepIndexFor, 'shipped')).toThrow();
    expect(() => call(stepIndexFor, '')).toThrow();
    expect(() => call(stepIndexFor, undefined)).toThrow();
    expect(() => call(isExitStage, 'shipped')).toThrow();
    expect(() => call(nextLineFor, 'shipped', 'branch')).toThrow();
  });
});

describe('nextLineFor: pinned per stage and per side', () => {
  const T: ReadonlyArray<readonly [string, string, string]> = [
    ['draft', 'Add your lines, then submit the order to the commissary.', 'The branch is still drafting this order.'],
    ['submitted', 'Waiting for the commissary to accept this order.', 'Review the lines, then accept or reject the order.'],
    ['accepted', 'The commissary is packing your order.', 'Pack the lines, then mark the order ready.'],
    ['ready', 'Your order is packed and waiting to be dispatched.', 'Dispatch the order when the goods are ready to leave.'],
    ['dispatched', 'On its way. Count the goods and receive the order.', 'Dispatched. Waiting for the branch to receive it.'],
    ['received', 'Received. This order is complete.', 'Received by the branch. This order is complete.'],
    ['rejected', 'The commissary rejected this order. You can order again.', 'You rejected this order. The branch can order again.'],
    ['cancelled', 'This order was cancelled. You can order again.', 'This order was cancelled.'],
  ];
  it.each(T)('%s', (stage, branch, commissary) => {
    expect(nextLineFor(stage as never, 'branch')).toBe(branch);
    expect(nextLineFor(stage as never, 'commissary')).toBe(commissary);
  });
  it('the two sides read differently for every stage', () => {
    for (const [stage] of T) expect(nextLineFor(stage as never, 'branch')).not.toBe(nextLineFor(stage as never, 'commissary'));
  });
  it('NEGATIVE: an unknown side throws', () => {
    expect(() => call(nextLineFor, 'draft', 'warehouse')).toThrow();
    expect(() => call(nextLineFor, 'draft', undefined)).toThrow();
  });
});

describe('simpleStepIndexFor: deliveries and trade orders', () => {
  it('delivery draft 0, received 1 (last)', () => {
    expect(simpleStepIndexFor('delivery', 'draft')).toBe(0);
    expect(simpleStepIndexFor('delivery', 'received')).toBe(deliverySteps.length - 1);
  });
  it('trade draft 0, confirmed 1, dispatched 2, received 3', () => {
    expect(['draft', 'confirmed', 'dispatched', 'received'].map((s) => simpleStepIndexFor('trade', s))).toEqual([0, 1, 2, 3]);
  });
  it('void maps to an in-range index (the exit point) for both kinds', () => {
    expect(simpleStepIndexFor('delivery', 'void')).toBeGreaterThanOrEqual(0);
    expect(simpleStepIndexFor('delivery', 'void')).toBeLessThan(deliverySteps.length);
    expect(simpleStepIndexFor('trade', 'void')).toBeGreaterThanOrEqual(0);
    expect(simpleStepIndexFor('trade', 'void')).toBeLessThan(tradeOrderSteps.length);
  });
  it('NEGATIVE: unknown status or kind throws', () => {
    expect(() => call(simpleStepIndexFor, 'delivery', 'confirmed')).toThrow();
    expect(() => call(simpleStepIndexFor, 'trade', 'submitted')).toThrow();
    expect(() => call(simpleStepIndexFor, 'transfer', 'draft')).toThrow();
  });
});
