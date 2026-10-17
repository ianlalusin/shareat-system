/**
 * T-427 slice T - the Convert sheet's pure logic (Rulings 1, 6, 8; Acceptance 8).
 *
 * CONTRACT: new PURE module @/components/cashier/convert-sheet-logic (no React, no firebase):
 *   type Direction = 'cash_in' | 'cash_out'
 *   DIRECTION_LABELS: Record<Direction, string> =
 *       cash_in  'Cash-in (customer gives cash, gets GCash)'   cash_out 'Cash-out (customer gets cash)'
 *   directionLabel(direction: Direction, wallet?: string): string      // the wallet name replaces 'GCash' in the cash_in label; default GCash
 *   convertEffectText(direction: Direction, wallet: string, amountCentavos: number, cash?: string): string
 *       cash_in  500.00 GCash -> 'Drawer cash +₱500.00 · GCash −₱500.00'     cash_out -> 'Drawer cash −₱500.00 · GCash +₱500.00'
 *       (U+2212 minus, U+00B7 middle dot, thousands separators; invalid/0 amount -> '')
 *   convertButtonState(online: boolean): { disabled: boolean; label: string; hint: string | null }
 *       online  { disabled:false, label:'Convert', hint:null };   offline { disabled:true, label:'Convert', hint:'Needs the internet' }
 *   conversionRows(docs: ConversionDoc[]): { id; text: string; struck: boolean; canVoid: boolean; ... }[]
 *       newest first by createdAtClientMs; HIDES source 'pos2-correction'; v1 docs (no source) are shown but canVoid=false; canVoid only for
 *       source 'pos2-convert' with status 'active'; status 'voided' => struck=true, canVoid=false.
 *       ConversionDoc = { id; source?; status; fromMethod; toMethod; amount (pesos); createdAtClientMs; note? }
 *   conversionsNet(docs): Record<string, number> // pesos by method over ACTIVE shown docs (corrections excluded), to +, from -
 * RED: the module does not exist yet.   MUTANTS: M1 labels swapped; M2 corrections listed; M3 Void on v1 docs; M4 online-only button enabled offline.
 */
import { describe, expect, it } from 'vitest';
import { DIRECTION_LABELS, convertButtonState, convertEffectText, conversionRows, conversionsNet, directionLabel } from '@/components/cashier/convert-sheet-logic';

const doc = (over: Record<string, unknown>) => ({ id: 'x', status: 'active', fromMethod: 'GCash', toMethod: 'Cash', amount: 100, createdAtClientMs: 1000, source: 'pos2-convert', ...over }) as any;

describe('direction labels and the plain effect', () => {
  it('the two big choices read exactly as the spec', () => {
    expect(DIRECTION_LABELS.cash_in).toBe('Cash-in (customer gives cash, gets GCash)');
    expect(DIRECTION_LABELS.cash_out).toBe('Cash-out (customer gets cash)');
    expect(directionLabel('cash_in')).toBe(DIRECTION_LABELS.cash_in);
    expect(directionLabel('cash_in', 'Maya')).toBe('Cash-in (customer gives cash, gets Maya)');
    expect(directionLabel('cash_out')).toBe(DIRECTION_LABELS.cash_out);
  });

  it('cash-in: drawer cash UP, wallet DOWN (M1); cash-out is the opposite', () => {
    expect(convertEffectText('cash_in', 'GCash', 50000)).toBe('Drawer cash +₱500.00 · GCash −₱500.00');
    expect(convertEffectText('cash_out', 'GCash', 50000)).toBe('Drawer cash −₱500.00 · GCash +₱500.00');
    expect(convertEffectText('cash_in', 'Maya', 123456)).toBe('Drawer cash +₱1,234.56 · Maya −₱1,234.56');
  });

  it('an empty, zero or invalid amount shows no effect', () => {
    for (const v of [0, -5, Number.NaN, 1.5]) expect(convertEffectText('cash_in', 'GCash', v as number)).toBe('');
  });
});

describe('Acceptance 8 - offline', () => {
  it('offline: disabled with "Needs the internet" (M4); online: enabled, no hint', () => {
    expect(convertButtonState(false)).toMatchObject({ disabled: true, hint: 'Needs the internet' });
    expect(convertButtonState(true)).toMatchObject({ disabled: false, hint: null });
  });
});

describe('the list under the sheet', () => {
  it('newest first; tender corrections hidden (M2); v1 docs shown without Void (M3); only active pos2-convert can be voided', () => {
    const rows = conversionRows([
      doc({ id: 'a', createdAtClientMs: 1000 }),
      doc({ id: 'corr', source: 'pos2-correction', createdAtClientMs: 5000 }),
      doc({ id: 'v1', source: undefined, createdAtClientMs: 3000 }),
      doc({ id: 'gone', status: 'voided', createdAtClientMs: 2000 }),
      doc({ id: 'b', createdAtClientMs: 4000 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['b', 'v1', 'gone', 'a']);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.b).toMatchObject({ canVoid: true, struck: false });
    expect(by.a).toMatchObject({ canVoid: true, struck: false });
    expect(by.v1).toMatchObject({ canVoid: false, struck: false });
    expect(by.gone).toMatchObject({ canVoid: false, struck: true });
    expect(rows.every((r) => typeof r.text === 'string' && r.text.length > 0)).toBe(true);
  });

  it('the net by method counts only active, shown docs', () => {
    const net = conversionsNet([
      doc({ id: '1', amount: 500 }), // GCash -500, Cash +500
      doc({ id: '2', fromMethod: 'Cash', toMethod: 'GCash', amount: 200 }),
      doc({ id: '3', status: 'voided', amount: 999 }),
      doc({ id: '4', source: 'pos2-correction', amount: 999 }),
    ]);
    expect(net).toEqual({ Cash: 300, GCash: -300 });
  });
});
