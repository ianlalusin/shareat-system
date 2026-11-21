/** T-621 audit fix: the update gate (S1) and the unsent-total warning (S3) count only the sales this till can send. */
import { describe, expect, it } from 'vitest';
import type { PosEvent } from '@/lib/pos-device';
import { heldSalesCount, sendableEvents } from './held-sales';
import { mayActivateUpdate } from './offline-sw';
import { showUnsentWarning, unsentSalesCentavos } from './unsent-total';

let seq = 0;
const sale = (total: string, pairingId?: string): PosEvent => ({ seq: ++seq, kind: 'sale.completed', personId: 'p', occurredAtDevice: '2026-12-07T10:00:00.000Z', pairingId, payload: { device: { subtotal: total, discountTotal: '0.00', total, lines: [] } } });

const HERE = 'pair-here';
const OTHER = 'pair-other';

describe('T-621 sendableEvents', () => {
  it('drops only events of a refused OTHER pairing; this pairing and unstamped events stay', () => {
    const mine = sale('10.00', HERE);
    const old = sale('20.00');
    const held = sale('30.00', OTHER);
    const notRefused = sale('40.00', 'pair-not-refused');
    expect(sendableEvents([mine, old, held, notRefused], [OTHER], HERE)).toEqual([mine, old, notRefused]);
    expect(heldSalesCount([mine, old, held, notRefused], [OTHER], HERE)).toBe(1);
  });

  it('S1: an outbox holding only held sales does not hold the update [kills: gate counting every pending event]', () => {
    const events = [sale('30.00', OTHER), sale('50.00', OTHER)];
    const waiting = sendableEvents(events, [OTHER], HERE).length;
    expect(waiting).toBe(0);
    expect(mayActivateUpdate({ waiting, paymentOpen: false, online: true })).toBe(true);
    expect(mayActivateUpdate({ waiting: events.length, paymentOpen: false, online: true })).toBe(false); // the old count, for contrast
  });

  it('S1: one sendable sale still holds the update', () => {
    const waiting = sendableEvents([sale('30.00', OTHER), sale('5.00', HERE)], [OTHER], HERE).length;
    expect(mayActivateUpdate({ waiting, paymentOpen: false, online: true })).toBe(false);
  });

  it('S3: held sales are left out of the unsent total [kills: summing every pending event]', () => {
    const events = [sale('100.00', HERE), sale('52000.00', OTHER)];
    const c = unsentSalesCentavos(sendableEvents(events, [OTHER], HERE));
    expect(c).toBe(10_000n);
    expect(showUnsentWarning({ online: false, unsentCentavos: c, warnCentavos: 5_000_000 })).toBe(false);
    expect(unsentSalesCentavos(events)).toBe(5_210_000n); // the old sum would have warned
  });
});
