/**
 * T-475 - the business-rule check layer (docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md section 3.1).
 *
 * T-440's field rules judge ONE field's format. A business rule judges what the page already knows about the record as a whole
 * (a supplier's status, the invoice date next to the due date, the draft that would not post). ONE definition, read by the
 * screen (a live line, Save off) and by the server (the refusal sentence), so the two cannot drift.
 *
 * ⛔ A CLIENT-SAFE LEAF, exported as `@shareat/domain/business-rules`. A `'use client'` file imports it, so it may import only
 * `./*`, `../shared/money-input`, `../shared/money-lines`, `@shareat/core/money` and `@shareat/core/datetime`. No `@shareat/db`,
 * no `refuse` (the server half throws `refuse(raw, verdict.sentence)` at its own refusal site).
 *
 * Facts are plain JSON a page already holds (so they cross the server-to-client boundary as props); `values` are the form
 * controls by name, as typed strings. A check returns the FIRST problem, or null. Never a typed value inside a sentence that is
 * personal data; the money sentences below name no amount that was typed.
 */
export type Verdict = null | { readonly level: 'block' | 'warn'; readonly sentence: string };
export type FormValues = Readonly<Record<string, string | undefined>>;

export interface BusinessCheck<F = unknown> {
  /** `'ap.invoice.dueNotBeforeInvoice'`: the key in `BUSINESS_CHECKS` and the id a `<RuleCheck>` names. */
  readonly id: string;
  /** Every form control name `run` reads. The form tracks exactly these. Never empty. */
  readonly watch: readonly string[];
  run(facts: F, values: FormValues): Verdict;
}

export const block = (sentence: string): Verdict => ({ level: 'block', sentence });
export const warn = (sentence: string): Verdict => ({ level: 'warn', sentence });

/** The control's value, trimmed ('' when the control is absent). */
export function typed(values: FormValues, name: string): string {
  return (values[name] ?? '').trim();
}

export function defineCheck<F>(check: BusinessCheck<F>): BusinessCheck<F> {
  return Object.freeze({ ...check, watch: Object.freeze([...check.watch]) });
}
