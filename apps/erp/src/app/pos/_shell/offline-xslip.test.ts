/** T-621 S4 - the offline X-slip: figures, paper, and once-per-period timing. docs/tasks/621-pos-offline-safety-rails.md tests 3 and 4. */
import { money, toCentavos } from '@shareat/core/money';
import { describe, expect, it } from 'vitest';
import type { PosEvent } from '@/lib/pos-device';
import { formatOfflineXSlip } from '@/lib/pos-print';
import { checkOfflineXSlip, offlineXSlipFigures, offlineXSlipStep, offlineXSlipView, type OfflineXSlipMeta } from './offline-xslip';

const H = 3_600_000;
const TENDERS = [
  { id: 'cash', name: 'Cash', kind: 'cash' },
  { id: 'gcash', name: 'GCash', kind: 'wallet' },
];
let seq = 0;
const sale = (total: string, payments: { tenderId: string; amount: string }[]): PosEvent => ({
  seq: ++seq,
  kind: 'sale.completed',
  personId: 'p',
  occurredAtDevice: '2026-12-07T10:00:00.000Z',
  payload: { device: { subtotal: total, discountTotal: '0.00', total, lines: [] }, payments },
});
const noise: PosEvent = { seq: 999, kind: 'lines.added', personId: 'p', occurredAtDevice: '2026-12-07T10:00:00.000Z', payload: {} };

// 1,250.00 cash paid 1,500 (250 change); 799.50 split 300 cash + 499.50 GCash; 120.00 GCash paid 119.99 (short 0.01); 40.00 on a tender the snapshot no longer has.
const EVENTS = [
  sale('1250.00', [{ tenderId: 'cash', amount: '1500.00' }]),
  sale('799.50', [{ tenderId: 'cash', amount: '300.00' }, { tenderId: 'gcash', amount: '499.50' }]),
  noise,
  sale('120.00', [{ tenderId: 'gcash', amount: '119.99' }]),
  sale('40.00', [{ tenderId: 'retired', amount: '40.00' }]),
];

describe('T-621 S4 offlineXSlipFigures', () => {
  it('counts sales only, takes change off the cash row, keeps short pay apart, and an unknown tender prints as OTHER TENDER', () => {
    const f = offlineXSlipFigures(EVENTS, TENDERS);
    expect(f).toEqual({
      saleCount: 4,
      totalCentavos: 220_950n,
      tenders: [
        { name: 'Cash', centavos: 155_000n },
        { name: 'GCash', centavos: 61_949n },
        { name: 'OTHER TENDER', centavos: 4_000n },
      ],
      shortPaidCentavos: 1n,
    });
  });

  it('tenders + short paid add up to the total, always', () => {
    const f = offlineXSlipFigures(EVENTS, TENDERS);
    expect(f.tenders.reduce((s, t) => s + t.centavos, 0n) + f.shortPaidCentavos).toBe(f.totalCentavos);
  });

  it('change with no cash row comes off the largest row', () => {
    const f = offlineXSlipFigures([sale('100.00', [{ tenderId: 'gcash', amount: '150.00' }])], TENDERS);
    expect(f.tenders).toEqual([{ name: 'GCash', centavos: 10_000n }]);
  });
});

const view = () =>
  offlineXSlipView(offlineXSlipFigures(EVENTS, TENDERS), {
    header: { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true },
    terminalNo: 2,
    offlineSinceLocal: '07/12/26 10:00',
    printedAtLocal: '07/12/26 14:00',
    waitingCount: 5,
  });

describe('T-621 S4 formatOfflineXSlip', () => {
  it('58 mm (32 columns): the exact lines', () => {
    expect(formatOfflineXSlip(view(), { width: 58, font: 'normal' })).toEqual(SLIP_58);
  });

  it('80 mm (48 columns): the exact lines', () => {
    expect(formatOfflineXSlip(view(), { width: 80, font: 'normal' })).toEqual(SLIP_80);
  });

  it('no line is wider than the paper, and the printed tenders + short paid add up to the printed total', () => {
    for (const [layout, cols] of [[{ width: 58, font: 'normal' }, 32], [{ width: 80, font: 'small' }, 64]] as const) {
      const lines = formatOfflineXSlip(view(), layout);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(cols);
      const amountOf = (label: string) => {
        const line = lines.find((l) => l.startsWith(label));
        return line ? toCentavos(money(line.slice(label.length).trim().replace(/,/g, ''))) : 0n;
      };
      expect(amountOf('Cash') + amountOf('GCash') + amountOf('OTHER TENDER') + amountOf('SHORT PAID')).toBe(amountOf('TOTAL'));
    }
  });
});

describe('T-621 S4 timing (offlineXSlipStep)', () => {
  const since = Date.UTC(2026, 11, 7, 2, 0);
  it('nothing before N hours; prints at N h; not again before 2N h; again at 2N h', () => {
    let meta: OfflineXSlipMeta | null = null;
    const at = (h: number) => {
      const s = offlineXSlipStep({ meta, offlineSinceMs: since, nowMs: since + h * H, hours: 4 });
      meta = s.meta;
      return s.print;
    };
    expect([at(1), at(3.99), at(4), at(4.5), at(7.99), at(8), at(8.1), at(12)]).toEqual([false, false, true, false, false, true, false, true]);
  });

  it('asleep through several periods: one slip, for the current period', () => {
    const s = offlineXSlipStep({ meta: { sinceMs: since, printedPeriod: 1 }, offlineSinceMs: since, nowMs: since + 13 * H, hours: 4 });
    expect(s).toEqual({ print: true, meta: { sinceMs: since, printedPeriod: 3 } });
  });
});

/** An in-memory device meta store, shared across "reloads". */
function harness(mutantNoMeta = false) {
  let stored: unknown = null;
  const printed: number[] = [];
  const check = (o: { online?: boolean; offlineSinceMs: number; nowMs: number }) =>
    checkOfflineXSlip({
      online: o.online ?? false,
      offlineSinceMs: o.offlineSinceMs,
      nowMs: o.nowMs,
      hours: 4,
      getMeta: async () => (mutantNoMeta ? null : stored),
      setMeta: async (v) => void (stored = v),
      print: async (s) => void printed.push(s),
    });
  return { check, printed, stored: () => stored };
}

describe('T-621 S4 checkOfflineXSlip: survives a reload through the meta store', () => {
  const since = Date.UTC(2026, 11, 7, 2, 0);
  const run = async (mutantNoMeta: boolean) => {
    const h = harness(mutantNoMeta);
    const counts: number[] = [];
    await h.check({ offlineSinceMs: since, nowMs: since + 4 * H }); // prints period 1
    counts.push(h.printed.length);
    await h.check({ offlineSinceMs: since, nowMs: since + 4.5 * H }); // same page, same period
    counts.push(h.printed.length);
    // reload at 5 h: the new page's offline clock starts at the reload, but the stretch began at `since`
    await h.check({ offlineSinceMs: since + 5 * H, nowMs: since + 5 * H + 60_000 });
    counts.push(h.printed.length);
    await h.check({ offlineSinceMs: since + 5 * H, nowMs: since + 8 * H }); // period 2 of the ORIGINAL stretch
    counts.push(h.printed.length);
    return { printed: h.printed, counts };
  };

  it('prints once at 4 h, not again after a reload, and again at 8 h of the original stretch', async () => {
    expect(await run(false)).toEqual({ printed: [since, since], counts: [1, 1, 1, 2] });
  });

  it('MUTANT no meta (getMeta always empty) -> prints twice in the first period -> red', async () => {
    const { counts } = await run(true);
    expect(counts[1]).toBe(2); // the same period printed again
    expect(counts).not.toEqual([1, 1, 1, 2]);
  });

  it('going online forgets the stretch; the next offline stretch starts fresh', async () => {
    const h = harness();
    await h.check({ offlineSinceMs: since, nowMs: since + 4 * H });
    await h.check({ online: true, offlineSinceMs: since, nowMs: since + 5 * H });
    expect(h.stored()).toBeNull();
    const later = since + 6 * H;
    await h.check({ offlineSinceMs: later, nowMs: later + 3 * H });
    expect(h.printed).toEqual([since]);
    await h.check({ offlineSinceMs: later, nowMs: later + 4 * H });
    expect(h.printed).toEqual([since, later]);
  });
});

const SLIP_58: string[] = [
  "          SHAREAT LIPA",
  "      Lipa City, Batangas",
  "    TIN: 123-456-789-000 VAT",
  "",
  "   OFFLINE X-SLIP - not a BIR",
  "            reading",
  " From this tablet's own unsent",
  "             sales",
  "TERMINAL:                      2",
  "OFFLINE SINCE:    07/12/26 10:00",
  "PRINTED AT:       07/12/26 14:00",
  "--------------------------------",
  "SALES                          4",
  "TOTAL                   2,209.50",
  "--------------------------------",
  "Cash                    1,550.00",
  "GCash                     619.49",
  "OTHER TENDER               40.00",
  "SHORT PAID                  0.01",
  "--------------------------------",
  "WAITING TO SEND                5",
  "--------------------------------",
  "Cash control, not a BIR document",
];
const SLIP_80: string[] = [
  "                  SHAREAT LIPA",
  "              Lipa City, Batangas",
  "            TIN: 123-456-789-000 VAT",
  "",
  "       OFFLINE X-SLIP - not a BIR reading",
  "      From this tablet's own unsent sales",
  "TERMINAL:                                      2",
  "OFFLINE SINCE:                    07/12/26 10:00",
  "PRINTED AT:                       07/12/26 14:00",
  "------------------------------------------------",
  "SALES                                          4",
  "TOTAL                                   2,209.50",
  "------------------------------------------------",
  "Cash                                    1,550.00",
  "GCash                                     619.49",
  "OTHER TENDER                               40.00",
  "SHORT PAID                                  0.01",
  "------------------------------------------------",
  "WAITING TO SEND                                5",
  "------------------------------------------------",
  "        Cash control, not a BIR document",
];
