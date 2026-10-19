/**
 * T-425 slice T - the X-slip text (Ruling 7; ADR A4.5). Acceptance 13 (content: totals equal the ledger; header says it is not a BIR document).
 *
 * CONTRACT for the builder (S5) - file `apps/pos/src/lib/printing/xSlipFormatter.ts` (pure; no firebase, no React). Exports exactly:
 *   XSLIP_HEADER = 'X-READING — cash control, not a BIR document'
 *   interface XSlipSummary { receiptCount: number; firstReceiptNumber: string | null; lastReceiptNumber: string | null;
 *       grossCentavos: number; totalsByTender: Record<string, { centavos: number; toCheck: boolean }>; unpaidVoids: number; unsentTotalCentavos: number }
 *   summarizeXSlip(events: LedgerEvent[], periodStartMs: number, periodEndMs: number): XSlipSummary
 *       Data from the ledger ONLY. Counted sales = kind 'sale' with createdAtClientMs in [start, end] and status unsent | acknowledged | stuck | quarantined
 *       (skipped, rejected and reserved rows are not sales on this slip). receipt numbers ordered by terminalSeq. totalsByTender sums `tenders[].centavos`
 *       keyed by `method`; toCheck is true when ANY tender of that method was toCheck. unpaidVoids = kind 'void' events in the period (not skipped).
 *       unsentTotalCentavos = sum of totalCentavos of ALL sale events in `events` with status unsent | stuck (not period-filtered).
 *   formatXSlip(i: { storeName: string; terminalNo: number; periodStartMs: number; periodEndMs: number; events: LedgerEvent[]; widthMm?: 58 | 80 /* default 80 *\/ }): string
 *       Plain text for printHub, lines never longer than 48 (80 mm) / 32 (58 mm) characters. Contains: the XSLIP_HEADER line, the store name, the terminal
 *       number, the period from and to, the receipt count, first and last receipt number, one line per tender with its total formatted `1,196.00`
 *       (e-wallet tenders marked `TO CHECK`), the unpaid-void count and the unsent total.
 */
import { describe, expect, it } from 'vitest';
import type { LedgerEvent } from '@/lib/outbox/ledger';
import * as xs from '@/lib/printing/xSlipFormatter';

const T0 = 1_800_000_000_000;
let seq = 0;
const ev = (o: Partial<LedgerEvent> & { cents?: number; method?: string; toCheck?: boolean; at?: number }): LedgerEvent => {
  const terminalSeq = o.terminalSeq ?? ++seq;
  const cents = o.cents ?? 59800;
  return {
    deviceId: 'DEV-A', storeId: 'S1', terminalNo: 1, terminalSeq, receiptId: `s${terminalSeq}`, receiptNumber: `SHT-01-${String(terminalSeq).padStart(6, '0')}`,
    kind: 'sale', totalCentavos: cents, linesHash: 'h', tenders: [{ method: o.method ?? 'Cash', centavos: cents, toCheck: o.toCheck ?? false, reference: o.toCheck ? 'REF1' : null }],
    createdAtClientMs: o.at ?? T0 + 1000, status: 'acknowledged', attempts: 0, lastError: null, ...o,
  } as LedgerEvent;
};

describe('summarizeXSlip', () => {
  it('counts the period\'s sales, first/last number by terminalSeq, totals by tender, e-wallets marked toCheck', () => {
    const events = [
      ev({ terminalSeq: 7, cents: 100_000, at: T0 + 10 }),
      ev({ terminalSeq: 5, cents: 59_800, at: T0 + 20 }),
      ev({ terminalSeq: 6, cents: 20_000, method: 'GCash', toCheck: true, at: T0 + 30 }),
      ev({ terminalSeq: 8, cents: 5_000, method: 'GCash', toCheck: true, status: 'unsent', at: T0 + 40 }),
    ];
    const s = xs.summarizeXSlip(events, T0, T0 + 100);
    expect(s.receiptCount).toBe(4);
    expect(s.firstReceiptNumber).toBe('SHT-01-000005');
    expect(s.lastReceiptNumber).toBe('SHT-01-000008');
    expect(s.grossCentavos).toBe(184_800);
    expect(s.totalsByTender.Cash).toEqual({ centavos: 159_800, toCheck: false });
    expect(s.totalsByTender.GCash).toEqual({ centavos: 25_000, toCheck: true });
    expect(s.unsentTotalCentavos).toBe(5_000);
  });

  it('totals equal the sum of the period\'s sales (the X-slip number is the ledger number)', () => {
    const events = Array.from({ length: 12 }, (_, i) => ev({ cents: 1000 * (i + 1), at: T0 + i }));
    const s = xs.summarizeXSlip(events, T0, T0 + 50);
    const sum = Object.values(s.totalsByTender).reduce((a, t) => a + t.centavos, 0);
    expect(sum).toBe(s.grossCentavos);
    expect(s.grossCentavos).toBe(events.reduce((a, e) => a + e.totalCentavos, 0));
  });

  it('leaves out sales outside the period and skipped / rejected / reserved rows', () => {
    const events = [
      ev({ at: T0 - 1 }), ev({ at: T0 + 101 }),
      ev({ status: 'skipped', at: T0 + 5 }), ev({ status: 'rejected', at: T0 + 5 }), ev({ status: 'reserved', at: T0 + 5 }),
      ev({ status: 'quarantined', at: T0 + 5 }), ev({ status: 'stuck', at: T0 + 5 }),
    ];
    expect(xs.summarizeXSlip(events, T0, T0 + 100).receiptCount).toBe(2);
  });

  it('counts unpaid voids (offline void events) and reports an empty period without throwing', () => {
    const v = ev({ kind: 'void', cents: 0, tenders: [], at: T0 + 5 });
    const s = xs.summarizeXSlip([v], T0, T0 + 100);
    expect(s).toMatchObject({ receiptCount: 0, unpaidVoids: 1, firstReceiptNumber: null, lastReceiptNumber: null, grossCentavos: 0 });
    expect(s.totalsByTender).toEqual({});
  });
});

describe('formatXSlip (Acceptance 13)', () => {
  const events = [
    ev({ terminalSeq: 5, cents: 119_600, at: T0 + 10 }),
    ev({ terminalSeq: 6, cents: 20_000, method: 'GCash', toCheck: true, at: T0 + 30 }),
    ev({ kind: 'void', terminalSeq: 7, cents: 0, tenders: [], at: T0 + 40, status: 'unsent' }),
    ev({ terminalSeq: 8, cents: 4_500_000, status: 'unsent', at: T0 + 50 }),
  ];
  const input = { storeName: 'Shareat Test', terminalNo: 1, periodStartMs: T0, periodEndMs: T0 + 3_600_000, events };

  it('the header says it is a cash-control reading and NOT a BIR document', () => {
    const text = xs.formatXSlip(input);
    expect(xs.XSLIP_HEADER).toBe('X-READING — cash control, not a BIR document');
    expect(text).toContain('X-READING — cash control, not a BIR document');
    expect(text.split('\n').slice(0, 4).join('\n')).toContain('X-READING');
  });

  it('shows store, terminal, count, first/last number, tender totals (e-wallet TO CHECK), unpaid voids and the unsent total', () => {
    const text = xs.formatXSlip(input);
    expect(text).toContain('Shareat Test');
    expect(text).toMatch(/terminal\D*0?1\b/i);
    expect(text).toMatch(/receipts?\D*3\b/i);
    expect(text).toContain('SHT-01-000005');
    expect(text).toContain('SHT-01-000008');
    // The period includes both the acknowledged 1,196 sale and the unsent 45,000 sale.
    expect(text).toMatch(/cash.*46,196\.00/i);
    expect(text).toMatch(/gcash.*200\.00/i);
    expect(text).toMatch(/gcash[^\n]*to check|to check[^\n]*gcash/i);
    const cashLine = text.split('\n').find((l) => /^\s*cash\b/i.test(l));
    expect(cashLine, 'a line that starts with Cash').toBeTruthy();
    expect(cashLine).not.toMatch(/to check/i);
    expect(text).toMatch(/void\w*\D*1\b/i);
    expect(text).toMatch(/unsent.*45,000\.00/i);
  });

  it('every line fits the paper: 48 characters at 80 mm, 32 at 58 mm', () => {
    for (const [w, max] of [[80, 48], [58, 32]] as const) {
      const lines = xs.formatXSlip({ ...input, widthMm: w }).split('\n');
      expect(Math.max(...lines.map((l) => l.length)), `${w}mm`).toBeLessThanOrEqual(max);
    }
  });

  it('is built from the ledger only: the text changes when a ledger sale changes', () => {
    const a = xs.formatXSlip(input);
    const b = xs.formatXSlip({ ...input, events: [...events, ev({ terminalSeq: 9, cents: 12_345, at: T0 + 60 })] });
    expect(b).not.toBe(a);
    expect(b).toContain('SHT-01-000009');
    expect(b).toMatch(/receipts?\D*4\b/i);
  });
});
