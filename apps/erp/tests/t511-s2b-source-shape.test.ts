import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUnsafeRedirectInCatchForFile } from './redirect-in-catch-sweep';

/**
 * T-511 S2b (TESTER) - the SHAPE of the two admin-edit screens and actions, read from source, because several repo guards judge
 * source and each fails far from the cause. No database, no render (the behaviour is in integration/t511-s2b-actions.test.ts and
 * integration/t511-s2b-render.test.ts). Spec: docs/tasks/511-settlement-upload-s2-spec.md "The two admin edits (2b)" item 3.
 *
 * What each leg protects, and the guard it mirrors:
 *   - setPlatformCodeAction: requireActor FIRST, try { withOrgPrincipal(domain fn) } catch { redirectWithFlash(error, same store) },
 *     the success redirect AFTER the try (redirect-in-catch-sweep, T-344); no keepTyping (CheckedForm, not EditableRecord)
 *   - the platform form is a CheckedForm over SETTINGS_PLATFORM_CODE_RULES whose controls spread nativeAttrs(...) (live-check guard
 *     t440-s2 G3: a hand-rolled required/type=number is red); no second EditableRecord and no second defineTypedForm
 *     (t389-keep-typing-guard G10 applies to EditableRecord only)
 *   - can(tx, actor, 'edit_platform_store_code', { storeId }) hides the form (precedent channel-settlements/page.tsx:80-89)
 *   - the shared update action/form never mention platform or code
 *   - loans/[id]: the new input is named repaymentAmount, sits AFTER the two existing name="amount" boxes in source order (the
 *     number-box census t343-s5-5v-number-boxes locates amount[1] and amount[2] by order), the existing count stays two
 *   - an edit is not destructive: no admin PIN on the loan amount action (t412-destructive-census is not triggered)
 *   - domain-actions-have-callers: both new domain functions are called from apps/erp/src
 */
const SRC = resolve(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** The body of one exported async function: from its declaration to the next top-level export (or the end of the file). */
function fn(text: string, name: string): string {
  const at = text.indexOf(`export async function ${name}(`);
  expect(at, `export async function ${name} not found`).toBeGreaterThan(-1);
  const rest = text.slice(at + 10);
  const next = rest.search(/\nexport /);
  return next === -1 ? text.slice(at) : text.slice(at, at + 10 + next);
}
const count = (text: string, needle: string | RegExp) =>
  typeof needle === 'string' ? text.split(needle).length - 1 : (text.match(needle) ?? []).length;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('T-511 S2b - settings/sales-channels/actions.ts: setPlatformCodeAction', () => {
  const text = read('app/settings/sales-channels/actions.ts');

  it('exists, takes requireActor first, calls the domain function inside withOrgPrincipal, catches into redirectWithFlash keeping the store, and redirects AFTER the try', () => {
    const body = fn(text, 'setPlatformCodeAction');
    expect(body).toMatch(/\{\s*const actor = await requireActor\('\/settings\/sales-channels'\)/);
    expect(body).toMatch(/withOrgPrincipal\(\s*actor\.orgId/);
    expect(body).toContain('setSalesChannelPlatformCode(');
    expect(body).toMatch(/try\s*\{/);
    const catchAt = body.indexOf('catch');
    expect(catchAt).toBeGreaterThan(-1);
    const afterCatch = body.slice(catchAt);
    expect(afterCatch, 'the error redirect keeps the same store open').toMatch(/redirectWithFlash\('\/settings\/sales-channels',\s*\{\s*store:\s*\w+\s*\},\s*\{\s*error:\s*errorMessage\(err\)/);
    // the success redirect is a SECOND redirectWithFlash, after the catch block closes (never inside the try)
    expect(count(body, 'redirectWithFlash('), 'one in the catch, one for success').toBeGreaterThanOrEqual(2);
    expect(body.lastIndexOf('redirectWithFlash('), 'the success redirect comes after the catch').toBeGreaterThan(catchAt + 10);
    expect(body.slice(body.lastIndexOf('redirectWithFlash(')), 'the success redirect names an ok banner and the store').toMatch(/store:\s*\w+[\s\S]*ok:/);
  });

  it('is a CheckedForm action, not an EditableRecord one: it does not call keepTyping (no typed form for it)', () => {
    expect(fn(text, 'setPlatformCodeAction')).not.toContain('keepTyping(');
  });

  it('puts the error banner through errorMessage and reads its fields with str(): platform, code, storeId, channelId', () => {
    const body = fn(text, 'setPlatformCodeAction');
    for (const k of ['storeId', 'channelId', 'platform', 'code']) expect(body, `reads ${k}`).toMatch(new RegExp(`str\\(\\s*\\w+\\s*,\\s*'${k}'\\s*\\)`));
  });

  it('the shared updateSalesChannelAction and its typed form never mention platform or code', () => {
    const update = fn(text, 'updateSalesChannelAction');
    expect(update).not.toMatch(/platform/i);
    expect(update).not.toMatch(/'code'/);
    const typed = read('app/settings/sales-channels/typed-forms.ts');
    // T-592 R4 removed the T-564 wiring and bank-names records; the one typed form left is the shared edit, and the platform CheckedForm has none.
    expect(count(typed, 'defineTypedForm('), 'one typed form for the shared edit, none for the platform CheckedForm').toBe(1);
    expect(typed).not.toMatch(/platform|'code'/i);
    expect(typed).not.toMatch(/platform|'code'/i);
  });

  it('the redirect-in-catch analyzer finds nothing unsafe in this actions.ts or loans/actions.ts', () => {
    expect(findUnsafeRedirectInCatchForFile(join(SRC, 'app/settings/sales-channels/actions.ts'))).toEqual([]);
    expect(findUnsafeRedirectInCatchForFile(join(SRC, 'app/loans/actions.ts'))).toEqual([]);
  });
});

describe('T-511 S2b - settings/sales-channels/page.tsx: the Platform and store code form', () => {
  const text = read('app/settings/sales-channels/page.tsx');
  const pageAndLib = `${text}\n${read('app/settings/sales-channels/lib.ts')}`;

  it('has a store-code form that is a CheckedForm over SETTINGS_PLATFORM_CODE_RULES posting to setPlatformCodeAction, labelled in the platform words (T-592)', () => {
    expect(text).toContain('Foodpanda store code');
    expect(text).toContain('Grab store ID');
    expect(text).toMatch(/<CheckedForm\b[^>]*\brules=\{SETTINGS_PLATFORM_CODE_RULES\}/);
    expect(text).toMatch(/\baction=\{setPlatformCodeAction\}/);
    expect(text).toMatch(/import\s*\{[^}]*SETTINGS_PLATFORM_CODE_RULES[^}]*\}\s*from\s*'@shareat\/domain\/field-rules'/);
  });

  it('its code box spreads nativeAttrs(SETTINGS_PLATFORM_CODE_RULES.code) inside a Field with the rule (live-check guard G3); the platform is a hidden box or a radio pair, never a select (T-592 R3)', () => {
    expect(text).toContain('nativeAttrs(SETTINGS_PLATFORM_CODE_RULES.code)');
    expect(text).toMatch(/rule=\{SETTINGS_PLATFORM_CODE_RULES\.code\}/);
    expect(text).toMatch(/<input type="hidden" name="platform"/);
    expect(text).toMatch(/<Radio field="platform"/);
    expect(text).not.toMatch(/<Select[^>]*name="platform"|nativeAttrs\(SETTINGS_PLATFORM_CODE_RULES\.platform\)/);
  });

  it('is hidden by can(): imports can from @shareat/auth and asks edit_platform_store_code with the channel\'s store', () => {
    expect(pageAndLib, 'page.tsx or its lib.ts imports can from @shareat/auth').toMatch(/import\s*\{[^}]*\bcan\b[^}]*\}\s*from\s*'@shareat\/auth'/);
    expect(pageAndLib, 'asks edit_platform_store_code with a store').toMatch(/can\([^)]*'edit_platform_store_code'[^)]*storeId/s);
  });

  it('platform stays out of every EditableRecord: one record (the shared edit form), which names neither platform nor the code box', () => {
    // T-592 R4 removed the two T-564 records (settlement wiring, bank names); the intent is unchanged: no platform control in any EditableRecord.
    expect(count(text, '<EditableRecord')).toBe(1);
    const blocks: string[] = [];
    for (let i = text.indexOf('<EditableRecord'); i !== -1; i = text.indexOf('<EditableRecord', i + 1)) {
      const end = text.indexOf('</EditableRecord>', i);
      expect(end).toBeGreaterThan(i);
      blocks.push(text.slice(i, end));
    }
    for (const b of blocks) expect(b).not.toMatch(/SETTINGS_PLATFORM_CODE_RULES|name="platform"|name="code"/);
    const actions = blocks.map((b) => /action=\{(\w+)\}/.exec(b)?.[1]).sort();
    expect(actions).toEqual(['updateSalesChannelAction']);
  });

  it('keeps the platform inputs out of the add-a-channel form too', () => {
    const start = text.indexOf('Add a channel');
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf('</CheckedForm>', start);
    expect(text.slice(start, end)).not.toMatch(/SETTINGS_PLATFORM_CODE_RULES/);
  });
});

describe('T-511 S2b - loans/actions.ts: updateLoanRepaymentAmountAction', () => {
  const text = read('app/loans/actions.ts');

  it('exists: requireActor first, calls updateLoanRepaymentAmount inside withOrgPrincipal, error redirect to the loan, success redirect after the try', () => {
    const body = fn(text, 'updateLoanRepaymentAmountAction');
    expect(body).toMatch(/\{\s*const actor = await requireActor\(\)/);
    expect(body).toContain('updateLoanRepaymentAmount(');
    expect(body).toMatch(/withOrgPrincipal\(\s*actor\.orgId/);
    expect(body).toMatch(/str\(\s*\w+\s*,\s*'loanId'\s*\)/);
    expect(body).toMatch(/str\(\s*\w+\s*,\s*'repaymentAmount'\s*\)/);
    const catchAt = body.indexOf('catch');
    expect(catchAt).toBeGreaterThan(-1);
    expect(body.slice(catchAt)).toMatch(/redirectWithFlash\(`\/loans\/\$\{\w+\}`,\s*\{\},\s*\{\s*error:\s*errorMessage\(err\)/);
    expect(body.lastIndexOf('redirectWithFlash('), 'success redirect after the catch').toBeGreaterThan(catchAt + 10);
  });

  it('is an edit, not a destructive act: no admin PIN, no destructive target (t412 census is not triggered)', () => {
    const body = fn(text, 'updateLoanRepaymentAmountAction');
    expect(body).not.toMatch(/verifyAdminApproval|loadDestructiveTarget|recordApproval/);
  });
});

describe('T-511 S2b - loans/[id]/page.tsx: the repayment amount form', () => {
  const text = read('app/loans/[id]/page.tsx');
  const pageAndLib = `${text}\n${read('app/loans/lib.ts')}`;

  it('has exactly one input named repaymentAmount, AFTER the two existing name="amount" boxes in source order; the count of name="amount" stays two', () => {
    expect(count(text, 'name="amount"'), 'the draw and payment boxes keep their names (the census pins amount[1] and amount[2])').toBe(2);
    expect(count(text, 'name="repaymentAmount"'), 'exactly one repaymentAmount input (a literal name, not a variable the census cannot see)').toBe(1);
    const lastAmount = text.lastIndexOf('name="amount"');
    expect(text.indexOf('name="repaymentAmount"'), 'after the existing forms').toBeGreaterThan(lastAmount);
  });

  it('is a CheckedForm over LOAN_REPAYMENT_RULES posting to updateLoanRepaymentAmountAction; its box spreads nativeAttrs(LOAN_REPAYMENT_RULES.repaymentAmount) inside a Field', () => {
    expect(text).toMatch(/<CheckedForm\b[^>]*\brules=\{LOAN_REPAYMENT_RULES\}/);
    expect(text).toMatch(/\baction=\{updateLoanRepaymentAmountAction\}/);
    expect(text).toContain('nativeAttrs(LOAN_REPAYMENT_RULES.repaymentAmount)');
    expect(text).toMatch(/rule=\{LOAN_REPAYMENT_RULES\.repaymentAmount\}/);
    expect(text).toMatch(/import\s*\{[^}]*LOAN_REPAYMENT_RULES[^}]*\}\s*from\s*'@shareat\/domain\/field-rules'/);
  });

  it('is hidden by can(): imports can from @shareat/auth and asks edit_loan_repayment_amount with the loan\'s store', () => {
    expect(pageAndLib, 'page.tsx or loans/lib.ts imports can from @shareat/auth').toMatch(/import\s*\{[^}]*\bcan\b[^}]*\}\s*from\s*'@shareat\/auth'/);
    expect(pageAndLib, 'asks edit_loan_repayment_amount with a store').toMatch(/can\([^)]*'edit_loan_repayment_amount'[^)]*storeId/s);
  });
});

describe('T-511 S2b - domain-actions-have-callers: both new domain functions are called from apps/erp', () => {
  const files = walk(SRC).map((p) => ({ p, t: readFileSync(p, 'utf8') }));
  it.each([
    ['setSalesChannelPlatformCode', 'app/settings/sales-channels/actions.ts'],
    ['updateLoanRepaymentAmount', 'app/loans/actions.ts'],
  ])('%s has a call site in %s', (name, where) => {
    const callers = files.filter(({ t }) => new RegExp(`\\b${name}\\(`).test(t)).map(({ p }) => p.replace(SRC, '').replace(/\\/g, '/'));
    expect(callers, `${name} has no caller in apps/erp/src`).toContain(`/${where}`);
  });
});
