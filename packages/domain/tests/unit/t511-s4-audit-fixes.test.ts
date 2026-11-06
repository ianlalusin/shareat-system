/**
 * T-511 S4 audit fixes (2026-11-04), the pure and source-shape parts. The database parts are in
 * `tests/integration/t511-s4-audit-fixes.test.ts`. docs/tasks/511-settlement-upload-s4-spec.md "Opus rulings".
 *
 *  F5  a Foodpanda weekly fee that no day can pay, or that has no sales day at all, adds a plain warning to the staged result (no refusal)
 *  F6  period-level lines get the same value checks as day lines (finite, description at most 200, PandaGO never booked), named STAGED_BAD_VALUE
 *  F7  UploadForm has a catch (a failed send says so in a sentence) and caps a batch at 6 files
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Money } from '@shareat/core/money';
import { SettlementIntakeRefusal } from '../../src/settlement-intake/refusal';
import { openSettlementZip } from '../../src/settlement-intake/safe-zip';
import { readFoodpandaInvoice } from '../../src/settlement-intake/foodpanda-workbook';
import { checkStagedPeriodLines, stageFoodpandaDays, type StagedOtherLine } from '../../src/settlement-intake/stage';
import { day as isoDay, fp34Order, fpChargeRow, fpWorkbook, zipBytes } from './t511-s3-helpers';

const MATCHED = { channelId: 'c', channelName: 'Foodpanda', storeId: 's', storeName: 'Lipa', platform: 'foodpanda' as const, code: 'ZZ99' };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function stage(orderRows: (string | number | Date | null)[][], feeNet: number) {
  const book = fpWorkbook({ orderRows, chargeRows: [fpChargeRow('Platform Fee', 'PF for the month of September 2026 (W4):zz99', feeNet)] });
  const zip = zipBytes([{ name: '20261015_200999999999.xls', data: book }, { name: '20261015_200999999999.pdf', data: Buffer.from('%PDF-1.4 stub') }]);
  return stageFoodpandaDays(await readFoodpandaInvoice((await openSettlementZip(zip)).workbook), MATCHED);
}
const small = (code: string, date: string) => fp34Order(code, { 7: isoDay(date) }); // R 100.00

describe('F5 the weekly platform fee that cannot be placed says so', () => {
  it('a fee larger than every day lands on the last day and the result carries a plain warning naming that date [kills: silent negative net payout]', async () => {
    const staged = await stage([small('zz99-0001-a', '2026-10-10'), small('zz99-0002-a', '2026-10-15')], 223.21);
    expect(staged.days.map((d) => d.salesDate)).toEqual(['2026-10-10', '2026-10-15']);
    expect(staged.warnings).toEqual(['The weekly platform fee on this invoice is larger than any single sales day: it was placed on 2026-10-15, please check.']);
  });

  it('a fee that a day can pay produces no warning [kills: warning on every invoice]', async () => {
    const staged = await stage([small('zz99-0001-a', '2026-10-10'), small('zz99-0002-a', '2026-10-15')], 20);
    expect(staged.warnings).toEqual([]);
  });

  it('a fee with no sales days is kept as an unbooked period charge and the result warns that it needs review [kills: fee dropped without a word]', async () => {
    const staged = await stage([], 223.21);
    expect(staged.days).toEqual([]);
    expect(staged.periodLines.map((l) => `${l.kind}:${l.bookedAs}:${l.amount}`)).toEqual(['period_charge:none:223.21']);
    // S5a audit fix EDIT (5 Nov): a second sentence now names the VAT that no day carries (pinned in t511-s5a-pdf-tie.test.ts).
    expect(staged.warnings[0]).toBe('This invoice has a platform fee but no sales days: it is kept as a period charge and needs review.');
    expect(staged.warnings.length).toBe(2);
  });
});

describe('F6 period lines are checked like day lines', () => {
  const line = (over: Partial<StagedOtherLine> = {}): StagedOtherLine => ({ kind: 'period_charge', bookedAs: 'none', amount: '1.00' as Money, lineDate: '2026-10-10', description: 'ok', ...over });
  const refusalOf = (lines: StagedOtherLine[]): SettlementIntakeRefusal => {
    try {
      checkStagedPeriodLines(lines);
    } catch (e) {
      if (e instanceof SettlementIntakeRefusal) return e;
      throw e;
    }
    throw new Error('expected a refusal');
  };

  it('good period lines pass', () => {
    expect(() => checkStagedPeriodLines([line(), line({ kind: 'pandago', description: null })])).not.toThrow();
  });
  it('a non-finite amount, a long description, a booked PandaGO line and a bad date are each refused as STAGED_BAD_VALUE with no id in the sentence', () => {
    for (const bad of [line({ amount: 'NaN' as Money }), line({ amount: 'Infinity' as Money }), line({ description: 'x'.repeat(201) }), line({ kind: 'pandago', bookedAs: 'platformFee' }), line({ lineDate: '10 Oct' })]) {
      const r = refusalOf([line(), bad]);
      expect(r.code).toBe('STAGED_BAD_VALUE');
      expect(r.message).not.toMatch(UUID);
      expect(r.message).not.toContain('[hidden]');
    }
  });
});

describe('F6 wiring and F7 the upload form (source shape)', () => {
  const REPO = resolve(__dirname, '..', '..', '..', '..');
  const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf8');

  it('ingest.ts checks the period lines before anything is stored', () => {
    const s = read('packages', 'domain', 'src', 'settlement-intake', 'ingest.ts');
    expect(s).toMatch(/checkStagedPeriodLines\(staged\.periodLines\)/);
    expect(s.indexOf('checkStagedPeriodLines(staged.periodLines)')).toBeLessThan(s.indexOf('await uploadFile('));
  });

  it('UploadForm catches a failed send with the plain sentence and caps the batch at 6 files', () => {
    const s = read('apps', 'erp', 'src', 'app', 'channel-settlements', 'upload', 'UploadForm.tsx');
    expect(s).toMatch(/\bcatch\b/);
    expect(s).toContain('The upload could not be sent. Try fewer files at a time (each file is up to 3 MB; a batch is limited to about 20 MB).');
    expect(s).toMatch(/MAX_FILES_PER_BATCH\s*=\s*6\b/);
    expect(s).toMatch(/length\s*>\s*MAX_FILES_PER_BATCH/);
  });
});
