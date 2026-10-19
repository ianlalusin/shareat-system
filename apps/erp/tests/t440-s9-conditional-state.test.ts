import { describe, expect, it } from 'vitest';
import { SUPPLIER_ADD_RULES, ruleInputNames } from '../../../packages/domain/src/field-rules';
import { CHECKED_FORM_INITIAL, checkContextValue, checkedFormReducer, fieldCheckLine } from '../src/components/forms/check-state';

describe('conditional field state follows the payment terms controller', () => {
  it('watches the unruled controller as well as the ruled fields', () => {
    expect(ruleInputNames(SUPPLIER_ADD_RULES)).toEqual(['name', 'creditTermsDays', 'termsMode']);
  });
  it('COD skips bad days, credit blocks, and switching back clears the failure', () => {
    let state = checkedFormReducer(CHECKED_FORM_INITIAL, { type: 'read', values: { name: 'Supplier', termsMode: 'cod', creditTermsDays: 'abc' } });
    let ctx = checkContextValue(SUPPLIER_ADD_RULES, state);
    expect(ctx.blocked).toBe(false);
    expect(ctx.applies('creditTermsDays')).toBe(false);
    expect(fieldCheckLine(SUPPLIER_ADD_RULES.creditTermsDays, ctx.result('creditTermsDays'), true, false)).toEqual({ kind: 'muted', text: 'Not needed for Cash on delivery' });
    state = checkedFormReducer(state, { type: 'input', name: 'termsMode', value: 'credit' });
    ctx = checkContextValue(SUPPLIER_ADD_RULES, state);
    expect(ctx.applies('creditTermsDays')).toBe(true);
    expect(ctx.failing).toEqual(['creditTermsDays']);
    expect(ctx.summary).toContain('whole number');
    state = checkedFormReducer(state, { type: 'input', name: 'termsMode', value: 'cod' });
    ctx = checkContextValue(SUPPLIER_ADD_RULES, state);
    expect(ctx.blocked).toBe(false);
    expect(ctx.summary).toBeNull();
  });
  it('reset restores credit requirements and the inactive server render never blocks', () => {
    expect(checkContextValue(SUPPLIER_ADD_RULES, CHECKED_FORM_INITIAL).blocked).toBe(false);
    const state = checkedFormReducer(CHECKED_FORM_INITIAL, { type: 'read', values: { name: 'Supplier', termsMode: 'credit', creditTermsDays: '' } });
    const ctx = checkContextValue(SUPPLIER_ADD_RULES, state);
    expect(ctx.blocked).toBe(true);
    expect(ctx.result('creditTermsDays')).toMatchObject({ ok: false, progress: 'Required' });
  });
});
