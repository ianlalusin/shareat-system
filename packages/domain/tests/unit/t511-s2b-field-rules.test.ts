import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as rules from '../../src/field-rules';

/**
 * T-511 S2b (TESTER) - the two new field-rule sets, and the shape the repo's guards demand of the two new domain functions.
 * No database. Spec: docs/tasks/511-settlement-upload-s2-spec.md "The two admin edits (2b)" items 1-2.
 *
 * Rule sets (names fixed by the spec):
 *   SETTINGS_PLATFORM_CODE_RULES  (field-rules/settings.ts)  keys `platform` and `code`, both optional (a blank pair clears)
 *   LOAN_REPAYMENT_RULES          (field-rules/loans.ts)     key `repaymentAmount`, kind money, min 0.01, optional (blank clears)
 * The per-platform code format (Grab UUID vs Foodpanda 3-12) may live in the set (a pattern covering both) and/or in the domain
 * function; only what no valid code can violate is pinned here. The function-level behaviour is in the integration tests.
 *
 * Source-shape legs mirror guards that run on the whole tree (t440-s2-live-check-guard G3, t440-s9-auth-first-guard,
 * domain-actions-have-callers, the T-343 throw ratchet, money-positivity-guard) so a violation is named here, with the function:
 *   - read the row, THEN authorize, THEN assertFieldRules (auth-first, T-364 order)
 *   - `refuse(...)`/`gone(...)`, never `throw new Error(` (the throw ratchet only goes down)
 *   - no `Number(x) <op> 0` (money-positivity ratchet): the amount goes through the money helpers
 */
const SRC = join(__dirname, '..', '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The text of one exported function: from its `export async function` line to the next top-level `export`. */
function fnText(file: string, name: string): string {
  const text = read(file);
  const at = text.indexOf(`export async function ${name}(`);
  expect(at, `${file} must export async function ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(at + 10);
  const next = rest.search(/\nexport /);
  return next === -1 ? text.slice(at) : text.slice(at, at + 10 + next);
}

describe('T-511 S2b - SETTINGS_PLATFORM_CODE_RULES', () => {
  const set = (rules as Record<string, unknown>).SETTINGS_PLATFORM_CODE_RULES as
    | (Record<string, { name: string; kind: string; optional?: true }> & { form: string })
    | undefined;

  it('is exported from the field-rules leaf, with keys platform and code (the control names), both optional', () => {
    expect(set, 'SETTINGS_PLATFORM_CODE_RULES missing from @shareat/domain/field-rules').toBeDefined();
    expect(typeof set!.form).toBe('string');
    expect(set!.platform?.name).toBe('platform');
    expect(set!.code?.name).toBe('code');
    expect(set!.platform?.optional, 'a blank platform is a clear').toBe(true);
    expect(set!.code?.optional, 'a blank code is a clear').toBe(true);
  });

  it('is judged by checkAll: a blank pair passes (and normalises to nulls); good codes pass; obvious garbage fails', () => {
    expect(set).toBeDefined();
    const ok = (input: Record<string, string>) => rules.checkAll(set as never, input);
    const blank = ok({ platform: '', code: '' });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.values).toEqual({ platform: null, code: null });
    expect(ok({ platform: 'foodpanda', code: 'abc123' }).ok).toBe(true);
    expect(ok({ platform: 'grab', code: randomUUID() }).ok).toBe(true);
    expect(ok({ platform: 'foodpanda', code: 'a' }).ok, 'one character is neither a UUID nor 3-12 letters/digits').toBe(false);
    expect(ok({ platform: 'foodpanda', code: 'ab cd!' }).ok).toBe(false);
    const failed = ok({ platform: 'grab', code: '!!!!!!!!' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.requirement.length).toBeGreaterThan(10);
  });
});

describe('T-511 S2b - LOAN_REPAYMENT_RULES', () => {
  const set = (rules as Record<string, unknown>).LOAN_REPAYMENT_RULES as
    | (Record<string, { name: string; kind: string; min?: number; optional?: true }> & { form: string })
    | undefined;

  it('is exported from the field-rules leaf: key repaymentAmount, kind money, min 0.01, optional (blank clears)', () => {
    expect(set, 'LOAN_REPAYMENT_RULES missing from @shareat/domain/field-rules').toBeDefined();
    expect(typeof set!.form).toBe('string');
    const r = set!.repaymentAmount!;
    expect(r?.name).toBe('repaymentAmount');
    expect(r?.kind).toBe('money');
    expect(r?.min).toBe(0.01);
    expect(r?.optional).toBe(true);
  });

  it('judges amounts: 1771.88 and 0.01 pass; blank passes as null; 0, -5, abc, 1e3, NaN, Infinity and 3 decimals fail', () => {
    expect(set).toBeDefined();
    const check = (v: string) => rules.checkAll(set as never, { repaymentAmount: v });
    const good = check('1771.88');
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.values.repaymentAmount).toBe('1771.88');
    expect(check('0.01').ok).toBe(true);
    const blank = check('');
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.values.repaymentAmount).toBeNull();
    for (const bad of ['0', '0.00', '-5', 'abc', '1e3', 'NaN', 'Infinity', '12.345']) {
      expect(check(bad).ok, `${bad} must fail`).toBe(false);
    }
  });
});

describe('T-511 S2b - setSalesChannelPlatformCode: the shape the repo guards demand', () => {
  it('reads the channel, THEN authorizes edit_platform_store_code with the channel\'s store, THEN assertFieldRules(SETTINGS_PLATFORM_CODE_RULES', () => {
    const t = fnText('sales-channels/index.ts', 'setSalesChannelPlatformCode');
    const read = t.search(/(salesDaysRepo|settlementIntakeRepo)\.\w*[cC]hannel\w*\(/);
    const auth = t.search(/authorize\(/);
    const rulesAt = t.indexOf('assertFieldRules(SETTINGS_PLATFORM_CODE_RULES');
    expect(read, 'the channel is read first (the gate needs ITS store)').toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(read);
    expect(t).toMatch(/authorize\([^)]*'edit_platform_store_code'/);
    expect(t, 'the gate reads the channel\'s own store, never a caller-supplied one').toMatch(/storeId:\s*channel\.storeId/);
    expect(rulesAt, 'assertFieldRules(SETTINGS_PLATFORM_CODE_RULES, ...) must be called (G3 reach)').toBeGreaterThan(auth);
  });

  it('refuses with refuse()/gone(), never `throw new Error(` (the T-343 throw ratchet only goes down)', () => {
    expect(fnText('sales-channels/index.ts', 'setSalesChannelPlatformCode')).not.toMatch(/throw new Error\(/);
  });

  it('writes the audit row only after the repo write, in the same function (same transaction)', () => {
    const t = fnText('sales-channels/index.ts', 'setSalesChannelPlatformCode');
    const append = t.indexOf('auditLogRepo.append(');
    expect(append, 'auditLogRepo.append( in the function').toBeGreaterThan(-1);
    expect(t.slice(0, append), 'a repo write (set/update/write...) precedes the audit row').toMatch(/(salesDaysRepo|settlementIntakeRepo)\.(set|update|write)\w*\(/);
    expect(t.slice(append)).toMatch(/source:\s*'web'/);
  });
});

describe('T-511 S2b - updateLoanRepaymentAmount: the shape the repo guards demand', () => {
  it('reads the loan, THEN authorizes edit_loan_repayment_amount with the loan\'s store, THEN assertFieldRules(LOAN_REPAYMENT_RULES', () => {
    const t = fnText('loans/index.ts', 'updateLoanRepaymentAmount');
    const read = t.search(/loansRepo\.getById\(/);
    const auth = t.search(/authorize\(/);
    const rulesAt = t.indexOf('assertFieldRules(LOAN_REPAYMENT_RULES');
    expect(read).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(read);
    expect(t).toMatch(/authorize\([^)]*'edit_loan_repayment_amount'/);
    expect(t).toMatch(/storeId:\s*loan\.storeId/);
    expect(rulesAt, 'assertFieldRules(LOAN_REPAYMENT_RULES, ...) must be called (G3 reach)').toBeGreaterThan(auth);
  });

  it('parses the amount with the money helpers and never compares Number(x) with 0 (money-positivity ratchet)', () => {
    const t = fnText('loans/index.ts', 'updateLoanRepaymentAmount');
    expect(t).toMatch(/parse(Money|Decimal)Input\(|\bmoney\(|\bdecimal\(/);
    expect(t).not.toMatch(/Number\([^)]*\)\s*(<=|>=|<|>|===|!==)\s*0\b/);
  });

  it('refuses with refuse()/gone(), never `throw new Error(`', () => {
    expect(fnText('loans/index.ts', 'updateLoanRepaymentAmount')).not.toMatch(/throw new Error\(/);
  });

  it('writes the audit row after the repo write, with source web', () => {
    const t = fnText('loans/index.ts', 'updateLoanRepaymentAmount');
    const append = t.indexOf('auditLogRepo.append(');
    expect(append).toBeGreaterThan(-1);
    expect(t.slice(0, append), 'a repo write (set/update/write...) precedes the audit row').toMatch(/(loansRepo|settlementIntakeRepo)\.(set|update|write)\w*\(/);
    expect(t.slice(append)).toMatch(/source:\s*'web'/);
  });
});
