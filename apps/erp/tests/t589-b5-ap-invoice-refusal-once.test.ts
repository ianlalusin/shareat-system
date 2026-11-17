/**
 * T-589 B5 (b) — /ap/invoices/[id]: each refusal reason once. The red lines beside the checkboxes are the reasons;
 * the status line under the disabled button only points. Every test names its MUTANT.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineFieldRules } from '../../../packages/domain/src/field-rules';
import { CHECKED_FORM_INITIAL, checkContextValue, checkedFormReducer } from '../src/components/forms';

const page = readFileSync(join(__dirname, '..', 'src', 'app', 'ap', 'invoices', '[id]', 'page.tsx'), 'utf8');
const RULES = defineFieldRules('t589b5.demo', { name: { label: 'The name', kind: 'text', requires: 'Type a name.' } });
const SELF = 'You cannot verify an invoice you logged yourself.';
const ATTEST = 'Tick all four boxes before you verify.';
const withBlockers = () => [
  { type: 'read', values: { name: 'Ana' } },
  { type: 'verdict', id: 'ap.verify.selfVerify', verdict: { level: 'block', sentence: SELF } },
  { type: 'verdict', id: 'ap.verify.attestation', verdict: { level: 'block', sentence: ATTEST } },
].reduce((st, e) => checkedFormReducer(st, e as never), CHECKED_FORM_INITIAL);

describe('verify invoice: reasons once', () => {
  // MUTANT: ignore `pointerOnly` in checkContextValue -> the status line repeats both sentences under the button.
  it('pointer mode names no reason sentence; the default mode still does', () => {
    const point = checkContextValue(RULES, withBlockers(), true);
    expect(point.blocked).toBe(true);
    expect(point.summary).toBe('To save, fix what is marked above.');
    expect(point.summary).not.toContain(SELF);
    expect(point.blockers.get('ap.verify.selfVerify')).toBe(SELF); // the red line still has the reason
    expect(checkContextValue(RULES, withBlockers()).summary).toContain(SELF); // every other form unchanged
  });

  // MUTANT: drop `pointerSummary` from the verify form (or `quietSummary` from a void form) -> the sentence returns under its button.
  it('the page opts the verify form into the pointer and quiets both void forms', () => {
    expect(page).toMatch(/action=\{verifyInvoiceAction\}\s+pointerSummary/);
    expect(page).toContain('rules={PAYMENT_VOID_RULES} action={voidPaymentAction} quietSummary');
    expect(page).toContain('rules={INVOICE_VOID_RULES} action={voidInvoiceAction} quietSummary');
  });
});
