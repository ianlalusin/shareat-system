/**
 * T-546 R3 (TESTER, written FIRST) - the tablet prints with the till's own settings, read from the snapshot. docs/tasks/546-pos-terminal-printer-settings.md R3, R5 "T-528".
 *
 * ASSUMED API (the builder matches these or says why not).
 *   apps/erp/src/app/pos/_shell/payment-part.ts   (pure: no React, no storage; use-device-sync re-exports its type)
 *     paymentPartOf(body: Record<string, unknown>): SnapshotPaymentPart | null
 *       null when the cached snapshot lacks anything Pay needs - now including store.receiptPaperMm (58 | 80) and store.receiptCopies (1..3).
 *       null is what keeps Pay blocked behind the existing "has not loaded its price list yet. Connect it to the internet once" banner.
 *   apps/erp/src/app/pos/_payment/logic.ts
 *     printSettingsOf(store: { receiptPaperMm: 58 | 80; receiptCopies: number }): { layout: { width: 58 | 80; font: 'normal' }; copies: number }
 *     paySale(deps, input) - input gains `copies`; deps.print(lines, { copies: input.copies }).
 *     PRINT_LAYOUT and RECEIPT_COPIES are DELETED (the two `shortcut:` constants).
 *
 * RED NOW FOR THE RIGHT REASON: payment-part.ts and printSettingsOf do not exist; the constants still do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// biome-ignore lint/suspicious/noExplicitAny: the modules under test are the builder's; types are theirs
async function load(path: string): Promise<any> {
  try {
    return await import(/* @vite-ignore */ path);
  } catch (e) {
    throw new Error(`MISSING MODULE: ${path} cannot be loaded (T-546 not built): ${String((e as Error).message).slice(0, 160)}`);
  }
}
const logic = () => load('../src/app/pos/_payment/logic');
const part = () => load('../src/app/pos/_shell/payment-part');

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENDERS = [{ id: id(901), name: 'Cash', kind: 'cash' }];
const RULES = { vatPercentBasisPoints: 1200, scPwdPercentBasisPoints: 2000 };
const NOW = new Date('2026-11-06T11:52:00.000Z');

// A full cached snapshot body, as the server sends it now.
const body = (store: Record<string, unknown> = {}): Record<string, unknown> => ({
  store: { storeId: id(1), name: 'Lipa', mode: 'live', terminalNo: 2, vatRegistered: true, receiptPaperMm: 58, receiptCopies: 1, ...store },
  tenders: TENDERS,
  discountPresets: [],
  rules: RULES,
  staff: [],
  stands: [],
  menu: {},
});

describe('paymentPartOf: the cached snapshot must carry the till\'s printer settings', () => {
  it('a current snapshot gives store.receiptPaperMm and store.receiptCopies as sent', async () => {
    const { paymentPartOf } = await part();
    expect(paymentPartOf(body({ receiptPaperMm: 80, receiptCopies: 2 }))?.store).toEqual({ storeId: id(1), name: 'Lipa', terminalNo: 2, vatRegistered: true, receiptPaperMm: 80, receiptCopies: 2 });
    expect(paymentPartOf(body())?.store).toMatchObject({ receiptPaperMm: 58, receiptCopies: 1 });
  });

  it('an OLD cached snapshot without the keys gives null (Pay stays blocked: connect once to refresh)', async () => {
    const { paymentPartOf } = await part();
    const old = body();
    delete (old.store as Record<string, unknown>).receiptPaperMm;
    delete (old.store as Record<string, unknown>).receiptCopies;
    expect(paymentPartOf(old)).toBeNull();
    const noCopies = body();
    delete (noCopies.store as Record<string, unknown>).receiptCopies;
    expect(paymentPartOf(noCopies), 'one key is not enough').toBeNull();
    const noPaper = body();
    delete (noPaper.store as Record<string, unknown>).receiptPaperMm;
    expect(paymentPartOf(noPaper)).toBeNull();
  });

  it('values outside the closed lists give null too (paper 58 or 80; copies a whole 1..3), never a guess', async () => {
    const { paymentPartOf } = await part();
    for (const bad of [{ receiptPaperMm: 70 }, { receiptPaperMm: '80' }, { receiptPaperMm: null }, { receiptCopies: 0 }, { receiptCopies: 4 }, { receiptCopies: 1.5 }, { receiptCopies: '2' }]) {
      expect(paymentPartOf(body(bad)), JSON.stringify(bad)).toBeNull();
    }
  });

  it('everything else still gates it as before (a snapshot with no tenders is null)', async () => {
    const { paymentPartOf } = await part();
    const b = body();
    delete b.tenders;
    expect(paymentPartOf(b)).toBeNull();
  });
});

describe('printSettingsOf: the layout and the copy count the tablet prints with', () => {
  it('80 mm and 2 copies -> an 80 mm Font A layout and copies 2', async () => {
    const { printSettingsOf } = await logic();
    expect(printSettingsOf({ receiptPaperMm: 80, receiptCopies: 2 })).toEqual({ layout: { width: 80, font: 'normal' }, copies: 2 });
    expect(printSettingsOf({ receiptPaperMm: 58, receiptCopies: 1 })).toEqual({ layout: { width: 58, font: 'normal' }, copies: 1 });
  });
});

describe('paySale prints with the settings it is given', () => {
  const RECEIPT_LINES = [{ name: 'Unli Samgyup + Cheese', qty: 4, unitPrice: '449.00', gross: '1796.00', discounts: [], net: '1796.00' }];
  const BILL_LINES = [{ lineId: id(11), qty: 4, unitPrice: '449.00', bundleHeads: null, discounts: [] }];
  const run = async (settings: { receiptPaperMm: 58 | 80; receiptCopies: number }) => {
    const { paySale, priceBill, printSettingsOf } = await logic();
    const printed: { lines: string[]; opts: { copies: number } }[] = [];
    const deps = {
      reserveTerminalSeq: async () => 7,
      newId: () => id(32),
      enqueue: async (e: unknown) => ({ seq: 1, ...(e as object) }),
      requestDrain: () => undefined,
      print: async (lines: string[], opts: { copies: number }) => {
        printed.push({ lines, opts });
        return 'printed' as const;
      },
    };
    const { layout, copies } = printSettingsOf(settings);
    const priced = priceBill({ lines: BILL_LINES, rules: RULES, vatRegistered: true });
    const result = await paySale(deps, {
      personId: id(40), sessionId: id(31), online: true, terminalNo: 2, now: NOW, priced,
      rows: [{ tenderId: id(901), amount: priced.total }], tenders: TENDERS, seniors: [], vatRateLabel: '12%', layout, copies,
      receipt: { header: { businessName: 'Shareat Lipa', addressLines: ['Lipa City, Batangas'], tin: '123-456-789-000', vatRegistered: true }, tableLabel: 'Stand 7', heads: 4, cashierName: 'Joy', issuedAtLocal: '06/11/26 19:52', footerLines: [], lines: RECEIPT_LINES, scPwdDiscount: '0.00' },
    });
    return { result, printed };
  };

  it('80 mm paper prints at 48 columns (a 58 mm roll at 32)', async () => {
    const wide = await run({ receiptPaperMm: 80, receiptCopies: 1 });
    expect(wide.result).toMatchObject({ ok: true });
    const wideLens = wide.printed[0]!.lines.map((l) => l.length);
    expect(Math.max(...wideLens), 'no line wider than 48').toBe(48);
    expect(wideLens.every((n) => n <= 48)).toBe(true);
    const narrow = await run({ receiptPaperMm: 58, receiptCopies: 1 });
    expect(Math.max(...narrow.printed[0]!.lines.map((l) => l.length))).toBe(32);
  });

  it('copies 2 calls the adapter with { copies: 2 }, once (the adapter repeats the paper, the sale is saved once)', async () => {
    const two = await run({ receiptPaperMm: 80, receiptCopies: 2 });
    expect(two.printed).toHaveLength(1);
    expect(two.printed[0]!.opts).toEqual({ copies: 2 });
    const three = await run({ receiptPaperMm: 58, receiptCopies: 3 });
    expect(three.printed[0]!.opts).toEqual({ copies: 3 });
    const one = await run({ receiptPaperMm: 58, receiptCopies: 1 });
    expect(one.printed[0]!.opts).toEqual({ copies: 1 });
  });
});

describe('the two T-528 shortcuts are gone', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', 'src', 'app', 'pos', rel), 'utf8');
  it('PRINT_LAYOUT and RECEIPT_COPIES are referenced nowhere under apps/erp/src/app/pos', () => {
    for (const f of ['_payment/logic.ts', '_payment/PaymentPanel.tsx', '_orders/Orders.tsx']) {
      expect(read(f), f).not.toMatch(/\bPRINT_LAYOUT\b|\bRECEIPT_COPIES\b/);
    }
  });

  it('the Payment screen is given the till\'s settings from the snapshot (Orders reads store.receiptPaperMm / receiptCopies through printSettingsOf)', () => {
    expect(read('_orders/Orders.tsx')).toMatch(/printSettingsOf\(/);
  });
});
