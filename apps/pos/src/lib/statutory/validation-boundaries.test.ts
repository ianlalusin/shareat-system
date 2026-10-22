import { describe, expect, it } from 'vitest';
import { addStatutoryDiner, statutoryPaymentBlockers } from './capture';
import { mkDiner, mkLine } from '@/test-helpers/statutoryOracle';

const lines = [mkLine({ id: 'pkg', type: 'package', priceC: 44900, qty: 4 })];
describe('independent audit: payment revalidates stored qualifying diners', () => {
  it.each([{ name: '' }, { idNo: '' }, { kind: 'student' }, { dishLineIds: null }])('refuses an incomplete or forged entry %j before calculating a discount', corrupt => {
    const diner = { ...mkDiner(1), ...corrupt };
    const blockers = statutoryPaymentBlockers({ lines, diners: [diner as any], heads: 4 });
    expect(blockers.some(blocker => blocker.code === 'invalid-diner')).toBe(true);
  });
  it('checks the actual ID again at payment instead of trusting stored normalization', () => {
    const diners = [mkDiner(1, { idNo: 'OSCA-1187', idNoNormalized: 'FORGED1' }),
      mkDiner(2, { idNo: 'osca 1187', idNoNormalized: 'FORGED2' })];
    expect(statutoryPaymentBlockers({ lines, diners, heads: 4 }).some(blocker => blocker.code === 'duplicate-id')).toBe(true);
    expect(addStatutoryDiner({ diners: diners.slice(0, 1), entry: { kind: 'pwd', name: 'Other', idNo: 'osca 1187' },
      heads: 4, actor: { uid: 'staff' }, nowMs: 1 })).toMatchObject({ ok: false, code: 'duplicate-id' });
  });
});
