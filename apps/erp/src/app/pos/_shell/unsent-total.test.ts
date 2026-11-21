/** T-621 S3 - the unsent-sales sum and the warning band. docs/tasks/621-pos-offline-safety-rails.md test 2. */
import { describe, expect, it } from 'vitest';
import type { PosEvent } from '@/lib/pos-device';
import { pesoText, showUnsentWarning, unsentSalesCentavos, unsentWarningText } from './unsent-total';

let seq = 0;
const sale = (total: string): PosEvent => ({ seq: ++seq, kind: 'sale.completed', personId: 'p', occurredAtDevice: '2026-12-07T10:00:00.000Z', payload: { device: { subtotal: total, discountTotal: '0.00', total, lines: [] } } });
const other = (kind: PosEvent['kind'], payload: Record<string, unknown> = {}): PosEvent => ({ seq: ++seq, kind, personId: 'p', occurredAtDevice: '2026-12-07T10:00:00.000Z', payload });

describe('T-621 S3 unsentSalesCentavos', () => {
  it('exact centavos: PHP 0.10 + PHP 0.20 is 30 centavos, a bigint [kills: a float sum]', () => {
    const c = unsentSalesCentavos([sale('0.10'), sale('0.20')]);
    expect(typeof c).toBe('bigint');
    expect(c).toBe(30n);
  });

  it('exact over several sales: 0.70 + 0.10 + 52,199.20 = 5,220,000 centavos [kills: a float sum truncated to centavos]', () => {
    expect(unsentSalesCentavos([sale('0.70'), sale('0.10'), sale('52199.20')])).toBe(5_220_000n);
  });

  it('only sale.completed counts: other kinds, even carrying a device total, are ignored', () => {
    const events = [sale('100.00'), other('lines.added', { device: { total: '999.00' } }), other('session.voided', { device: { total: '50.00' } }), other('discount.added'), sale('25.50')];
    expect(unsentSalesCentavos(events)).toBe(12_550n);
  });

  it('a sale with no readable total is skipped, never guessed', () => {
    expect(unsentSalesCentavos([sale('10.00'), other('sale.completed', {}), other('sale.completed', { device: { total: 'abc' } })])).toBe(1_000n);
  });

  it('nothing waiting is zero', () => expect(unsentSalesCentavos([])).toBe(0n));
});

describe('T-621 S3 warning band', () => {
  const warn = 5_000_000; // PHP 50,000 in centavos (the registry default)
  it('offline at or above the rule shows it; just below does not', () => {
    expect(showUnsentWarning({ online: false, unsentCentavos: 5_000_000n, warnCentavos: warn })).toBe(true);
    expect(showUnsentWarning({ online: false, unsentCentavos: 4_999_999n, warnCentavos: warn })).toBe(false);
  });
  it('never online, and never without a rule (an old snapshot)', () => {
    expect(showUnsentWarning({ online: true, unsentCentavos: 9_000_000n, warnCentavos: warn })).toBe(false);
    expect(showUnsentWarning({ online: false, unsentCentavos: 9_000_000n, warnCentavos: null })).toBe(false);
  });
  it('the sentence names the amount in plain pesos', () => {
    expect(unsentWarningText(5_230_000n)).toBe('₱52,300 in sales not sent yet. Keep selling; call the manager.');
    expect(pesoText(5_230_050n)).toBe('₱52,300.50');
    expect(pesoText(105n)).toBe('₱1.05');
    expect(pesoText(123_456_789_00n)).toBe('₱123,456,789');
  });
});
