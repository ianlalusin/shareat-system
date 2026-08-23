import { describe, expect, it } from 'vitest';
import {
  ALL_CASE_CLASSES,
  TAXONOMY,
  isAnomalyClass,
  shouldCapture,
  taxonomyEntry,
  type CaseClass,
} from '../src/taxonomy';

describe('taxonomy table', () => {
  it('has exactly the 22 case classes named in Contract §1', () => {
    expect(TAXONOMY.length).toBe(22);
    expect(ALL_CASE_CLASSES.length).toBe(22);
  });

  it('matches the targets in Contract §1 for a representative sample', () => {
    expect(taxonomyEntry('sale.dine_in_unli.plain').target).toBe(5);
    expect(taxonomyEntry('sale.a_la_carte.plain').target).toBe(5);
    expect(taxonomyEntry('sale.discount').target).toBe(5);
    expect(taxonomyEntry('sale.comps').target).toBe(3);
    expect(taxonomyEntry('sale.voided').target).toBe(5);
    expect(taxonomyEntry('sale.partial_refund').target).toBe(3);
    expect(taxonomyEntry('sale.re_rung').target).toBe(3);
    expect(taxonomyEntry('sale.split_payment').target).toBe(5);
    expect(taxonomyEntry('sale.online_order').target).toBe(3);
    expect(taxonomyEntry('sale.branch_sale').target).toBe(3);
    expect(taxonomyEntry('ticket.cancelled').target).toBe(3);
    expect(taxonomyEntry('refill.addon').target).toBe(5);
    expect(taxonomyEntry('expense.cash').target).toBe(3);
    expect(taxonomyEntry('expense.ap').target).toBe(3);
    expect(taxonomyEntry('expense.online').target).toBe(3);
    expect(taxonomyEntry('expense.capex').target).toBe(3);
    expect(taxonomyEntry('expense.personal').target).toBe(3);
    expect(taxonomyEntry('channel.settlement').target).toBe(3);
  });

  it('marks exactly the four anomaly classes uncapped (target: null, anomaly: true)', () => {
    const anomalyClasses: CaseClass[] = [
      'anomaly.zero_amount',
      'anomaly.negative',
      'anomaly.same_day_void',
      'anomaly.cross_period',
    ];
    for (const cls of anomalyClasses) {
      expect(taxonomyEntry(cls).target).toBeNull();
      expect(taxonomyEntry(cls).anomaly).toBe(true);
      expect(isAnomalyClass(cls)).toBe(true);
    }
    for (const cls of ALL_CASE_CLASSES) {
      if (!anomalyClasses.includes(cls)) {
        expect(isAnomalyClass(cls)).toBe(false);
        expect(taxonomyEntry(cls).target).not.toBeNull();
      }
    }
  });

  it('throws for an unknown case class rather than returning undefined', () => {
    expect(() => taxonomyEntry('not.a.real.class' as CaseClass)).toThrow(/Unknown case class/);
  });
});

describe('shouldCapture — invariant 1: capture only when below target', () => {
  it('captures when the class is below its target', () => {
    expect(shouldCapture('sale.dine_in_unli.plain', 0)).toBe(true);
    expect(shouldCapture('sale.dine_in_unli.plain', 4)).toBe(true);
  });

  it('stops capturing once the class is AT target', () => {
    expect(shouldCapture('sale.dine_in_unli.plain', 5)).toBe(false);
  });

  it('stays stopped past target (defensive — should never happen via the sampler, but must not re-open)', () => {
    expect(shouldCapture('sale.dine_in_unli.plain', 6)).toBe(false);
  });

  it('rejects a negative or non-integer count rather than guessing a behaviour', () => {
    expect(() => shouldCapture('sale.dine_in_unli.plain', -1)).toThrow(RangeError);
    expect(() => shouldCapture('sale.dine_in_unli.plain', 1.5)).toThrow(RangeError);
  });
});

describe('shouldCapture — invariant 2: anomaly classes are never capped', () => {
  it('captures an anomaly regardless of how many are already captured', () => {
    expect(shouldCapture('anomaly.zero_amount', 0)).toBe(true);
    expect(shouldCapture('anomaly.zero_amount', 500)).toBe(true);
    expect(shouldCapture('anomaly.negative', 1_000_000)).toBe(true);
  });
});
