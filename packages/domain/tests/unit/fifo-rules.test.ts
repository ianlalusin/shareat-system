import { describe, expect, it } from 'vitest';
import { money } from '@shareat/core/money';
import {
  planConsumption,
  planReversal,
  type ConsumedLine,
  type CostLayer,
} from '../../src/stock/layers';
import { addQuantity, quantity, subtractQuantity } from '../../src/stock/quantity';

/**
 * T-162 §6 — the pure half of FIFO, tested without Postgres.
 *
 * ⭐ These are the rules the whole of Phase 3 rests on: what a consumption costs, and what a
 * reversal gives back. Every posting in T-163/T-164 is a consequence of the numbers this file
 * pins, so the cases are written from the spec rather than from the implementation.
 *
 * ⚠️ Written BEFORE `layers.ts` existed (bible §3.2), and each one was confirmed to fail for the
 * right reason first — a missing module, then a wrong number, never a passing stub.
 */

/** A layer builder — the fields FIFO actually reads, and nothing else. */
function layer(id: string, receivedAt: string, remaining: string, unitCost: string): CostLayer {
  return {
    id,
    receivedAt,
    remainingQuantity: quantity(remaining),
    unitCost,
  };
}

/** The running example from T-162 §6.1, reused so the numbers stay comparable across cases. */
const twoLayers = [
  layer('L1', '2026-08-01T00:00:00Z', '10', '100.0000'),
  layer('L2', '2026-08-05T00:00:00Z', '8', '120.0000'),
];

describe('planConsumption — oldest first, across as many layers as it takes', () => {
  it('⭐ spans two layers and costs each at its own rate', () => {
    // 15 = 10 from the ₱100 layer + 5 from the ₱120 layer = 1,000 + 600.
    const result = planConsumption(twoLayers, quantity('15'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines).toEqual([
      { layerId: 'L1', quantity: quantity('10'), unitCost: '100.0000', cost: money('1000.00') },
      { layerId: 'L2', quantity: quantity('5'), unitCost: '120.0000', cost: money('600.00') },
    ]);
    expect(result.totalCost).toBe(money('1600.00'));
  });

  it('takes only what it needs from the first layer when that is enough', () => {
    const result = planConsumption(twoLayers, quantity('4'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.layerId).toBe('L1');
    expect(result.totalCost).toBe(money('400.00'));
  });

  it('consuming a layer exactly to zero closes it and does not touch the next one', () => {
    const result = planConsumption(twoLayers, quantity('10'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ⚠️ The off-by-one that matters: an exact match must NOT open the next layer for zero.
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.quantity).toBe(quantity('10'));
  });

  it('⭐ orders by receivedAt, not by the order the rows arrived in', () => {
    // The newer layer is listed FIRST. FIFO must still consume the older one first — a repo that
    // forgets its ORDER BY would pass a naive test and fail this one.
    const reversed = [twoLayers[1]!, twoLayers[0]!];
    const result = planConsumption(reversed, quantity('12'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines.map((l) => l.layerId)).toEqual(['L1', 'L2']);
    expect(result.totalCost).toBe(money('1240.00')); // 10x100 + 2x120
  });

  it('breaks a receivedAt tie by layer id, so the order is total and reproducible', () => {
    const sameInstant = [
      layer('B', '2026-08-01T00:00:00Z', '5', '10.0000'),
      layer('A', '2026-08-01T00:00:00Z', '5', '20.0000'),
    ];
    expect(planConsumption(sameInstant, quantity('6'))).toEqual(
      planConsumption([...sameInstant].reverse(), quantity('6')),
    );
  });

  it('ignores layers that are already fully consumed', () => {
    const withClosed = [layer('L0', '2026-07-01T00:00:00Z', '0', '5.0000'), ...twoLayers];
    const result = planConsumption(withClosed, quantity('3'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines.map((l) => l.layerId)).toEqual(['L1']);
  });
});

describe('planConsumption — what it refuses', () => {
  it('⭐ refuses a shortfall outright; it never absorbs one', () => {
    // T-162 §5.8: there is no negative layer and no "vacuum" correction. This is the case Odoo
    // solves with a whole subsystem, and refusing it is the deliberate simplification.
    const result = planConsumption(twoLayers, quantity('20'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('18');
    expect(result.reason).toContain('20');
  });

  it('plans nothing at all when it refuses — no partial consumption', () => {
    const result = planConsumption(twoLayers, quantity('20'));
    expect(result).not.toHaveProperty('lines');
  });

  it('refuses a zero or negative quantity rather than returning an empty plan', () => {
    expect(planConsumption(twoLayers, quantity('0')).ok).toBe(false);
    expect(planConsumption(twoLayers, quantity('-1')).ok).toBe(false);
  });

  it('refuses when there are no open layers at all', () => {
    expect(planConsumption([], quantity('1')).ok).toBe(false);
  });
});

describe('planConsumption — the arithmetic, which is where a rebuild goes wrong quietly', () => {
  it('⭐ is exact at three decimals: 0.1 + 0.2 is 0.3, not 0.30000000000000004', () => {
    // Bible §12 landmine 25, applied to QUANTITY rather than money. v1 held quantities as floats
    // and fought the drift with a 1e-6 tolerance; exact decimals mean there is nothing to tolerate.
    expect(addQuantity(quantity('0.1'), quantity('0.2'))).toBe(quantity('0.3'));
    expect(subtractQuantity(quantity('10'), quantity('9.999'))).toBe(quantity('0.001'));

    const grams = [layer('G', '2026-08-01T00:00:00Z', '0.3', '1000.0000')];
    const result = planConsumption(grams, quantity('0.3'));
    expect(result.ok).toBe(true);
  });

  it('⭐ rounds cost PER LINE, because each line becomes a subledger row', () => {
    // 1 unit at ₱0.005 rounds to ₱0.01, three times over, = ₱0.03. Rounding the total instead
    // would give ₱0.02 — and then the entry would not equal the sum of `stock_layer_consumptions`,
    // which is invariant 6's tie for inventory. The line is the posting detail; it must be real
    // money at 2dp, and the total is what the lines sum to.
    const dust = [
      layer('D1', '2026-08-01T00:00:00Z', '1', '0.0050'),
      layer('D2', '2026-08-02T00:00:00Z', '1', '0.0050'),
      layer('D3', '2026-08-03T00:00:00Z', '1', '0.0050'),
    ];
    const result = planConsumption(dust, quantity('3'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines.map((l) => l.cost)).toEqual([money('0.01'), money('0.01'), money('0.01')]);
    expect(result.totalCost).toBe(money('0.03'));
  });

  it('the total always equals the sum of the lines', () => {
    const messy = [
      layer('M1', '2026-08-01T00:00:00Z', '3.333', '17.7700'),
      layer('M2', '2026-08-02T00:00:00Z', '4.667', '19.1300'),
    ];
    const result = planConsumption(messy, quantity('7.5'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const summed = result.lines.reduce((n, l) => n + BigInt(l.cost.replace('.', '')), 0n);
    expect(result.totalCost).toBe(money(summed));
  });

  it('⭐ is pure: the same inputs give the same plan, and the layers are not mutated', () => {
    const frozen = twoLayers.map((l) => ({ ...l }));
    const first = planConsumption(frozen, quantity('15'));
    const second = planConsumption(frozen, quantity('15'));

    expect(first).toEqual(second);
    expect(frozen).toEqual(twoLayers); // no in-place decrement of remainingQuantity
  });
});

describe('planReversal — a return gives back to the layers it actually took from', () => {
  /** What the original consumption wrote, oldest line first — the shape of the subledger rows. */
  const consumed: ConsumedLine[] = [
    { layerId: 'L1', quantity: quantity('10'), unitCost: '100.0000', cost: money('1000.00') },
    { layerId: 'L2', quantity: quantity('5'), unitCost: '120.0000', cost: money('600.00') },
  ];

  it('⭐ a full reversal restores every line exactly, and costs what the sale cost', () => {
    const result = planReversal(consumed, quantity('15'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ⚠️ Newest-consumed-first, so the lines come back in the OPPOSITE order to the sale. A full
    // reversal is just the limiting case of a partial one and follows the same rule — the order is
    // a property of the plan, not of the outcome, but it is asserted so the rule cannot drift.
    expect(result.lines).toEqual([...consumed].reverse());
    expect(result.totalCost).toBe(money('1600.00'));
  });

  it('⭐ a PARTIAL reversal walks the consumption backwards — newest layer returned first', () => {
    // T-179 §5: the last layer consumed is the first returned. Chosen so that a sequence of
    // partial returns sums to exactly the full reversal, and because it is the direction T-162
    // already reverses in — one rule in the system, not two.
    const result = planReversal(consumed, quantity('5'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines).toEqual([
      { layerId: 'L2', quantity: quantity('5'), unitCost: '120.0000', cost: money('600.00') },
    ]);
  });

  it('⭐ successive partial reversals sum to exactly the full reversal', () => {
    // ⚠️ The caller passes what is STILL outstanding, not the original sale — see `planReversal`'s
    // own note. Getting this wrong double-counts, which is precisely what the first draft of this
    // test did: two plans built from the same full list overlap on L2 and total ₱1,700.
    const first = planReversal(consumed, quantity('5'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.lines.map((l) => l.layerId)).toEqual(['L2']);

    // L2 is now fully returned; only L1's ten units remain outstanding.
    const stillOut: ConsumedLine[] = [consumed[0]!];
    const second = planReversal(stillOut, quantity('10'));
    const whole = planReversal(consumed, quantity('15'));
    expect(second.ok && whole.ok).toBe(true);
    if (!second.ok || !whole.ok) return;

    const partialTotal =
      BigInt(first.totalCost.replace('.', '')) + BigInt(second.totalCost.replace('.', ''));
    expect(money(partialTotal)).toBe(whole.totalCost);
  });

  it('spans back across two layers when the quantity needs it', () => {
    const result = planReversal(consumed, quantity('7'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines).toEqual([
      { layerId: 'L2', quantity: quantity('5'), unitCost: '120.0000', cost: money('600.00') },
      { layerId: 'L1', quantity: quantity('2'), unitCost: '100.0000', cost: money('200.00') },
    ]);
    expect(result.totalCost).toBe(money('800.00'));
  });

  it('⭐ never re-costs at a newer rate — the returned cost is what the sale relieved', () => {
    // T-179 invariant 5. Nothing in the input carries a current price, deliberately: there is no
    // way for a caller to accidentally pass one.
    const result = planReversal(consumed, quantity('2'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.lines[0]?.unitCost).toBe('120.0000');
  });

  it('refuses more than was consumed, and refuses zero', () => {
    expect(planReversal(consumed, quantity('16')).ok).toBe(false);
    expect(planReversal(consumed, quantity('0')).ok).toBe(false);
  });

  it('is pure and does not mutate the consumption rows', () => {
    const frozen = consumed.map((l) => ({ ...l }));
    planReversal(frozen, quantity('7'));
    expect(frozen).toEqual(consumed);
  });
});
