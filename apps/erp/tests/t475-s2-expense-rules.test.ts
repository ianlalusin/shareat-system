/**
 * T-475 S2 (TESTER) - the expense rule leaf and the wiring of /expenses/new, /expenses/[id] (edit + approve). No database.
 * Spec: docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md sections 3, 4 (E1-E4, P1-P3), 6 (C2), 7 S2 and the
 * amendments R8 (fact builders), R10 (previews never authorize), R12 (editExpense refuses only a CHANGE onto an unmapped category).
 *
 * PINNED NAMES (the spec fixes the shape, not the ids; edit the ONE table below if the builder names them differently):
 *   packages/domain/src/business-rules/expenses.ts  - exported from the index, registered in BUSINESS_CHECKS by these ids:
 *     E1 expense.new.amountWithinRemaining   E2 expense.new.creditNeedsTerms   E3 expense.new.supplierActive
 *     E4 expense.edit.categoryMapped
 *     P1 expense.approve.invoiceVerified     P2 expense.approve.periodOpen     P3 expense.approve.wouldPost
 *   components/money/InvoiceMoneyLines.tsx (spec section 6 C2) - a client wrapper that feeds the picked invoice's supplier to MoneyLines.
 * What the facts look like is NOT pinned here: the behaviour tests (integration/t475-s2-expense-pages.test.ts) run the check the
 * page mounted, with the facts the page handed it, so only ids and control names are contract.
 *
 * MUTANTS killed (named per test): a check missing from the registry; an expense check reading a control it does not list in
 * `watch`; the leaf importing @shareat/db; `supplierId={null}` restored on /expenses/new (Credit never offered); the sentence left
 * inline in create.ts / edit.ts / approve.ts (two copies that can drift); the approve form left a plain <form> (no live line);
 * the edit select offering an unmapped category enabled; the P2 loader gated on `canOverrideClosedMonth` again.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as leaf from '../../../packages/domain/src/business-rules';

const ID = {
  amountWithinRemaining: 'expense.new.amountWithinRemaining',
  creditNeedsTerms: 'expense.new.creditNeedsTerms',
  supplierActive: 'expense.new.supplierActive',
  categoryMapped: 'expense.edit.categoryMapped',
  invoiceVerified: 'expense.approve.invoiceVerified',
  periodOpen: 'expense.approve.periodOpen',
  wouldPost: 'expense.approve.wouldPost',
} as const;

type Check = { id: string; watch: readonly string[]; run(facts: unknown, values: Record<string, string>): unknown };
const REGISTRY = (leaf as unknown as { BUSINESS_CHECKS: Record<string, Check> }).BUSINESS_CHECKS;

const REPO = join(__dirname, '..', '..', '..');
const SRC = join(__dirname, '..', 'src');
const readRepo = (rel: string) => readFileSync(join(REPO, ...rel.split('/')), 'utf8');
const readSrc = (rel: string) => readFileSync(join(SRC, ...rel.split('/')), 'utf8');
/** Source with comments removed: a name that appears only in a comment proves nothing. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (rel: string) => strip(readSrc(rel));
const domainCode = (rel: string) => strip(readRepo(`packages/domain/src/${rel}`));

function yes(src: string, what: RegExp | string): void {
  const hit = typeof what === 'string' ? src.includes(what) : what.test(src);
  expect(hit, `expected the source to contain ${String(what)}`).toBe(true);
}
function no(src: string, what: RegExp | string): void {
  const hit = typeof what === 'string' ? src.includes(what) : what.test(src);
  expect(hit, `expected the source NOT to contain ${String(what)}`).toBe(false);
}

const LEAF_FILE = 'packages/domain/src/business-rules/expenses.ts';

describe('T-475 S2 - the expense leaf exists and is registered', () => {
  it('business-rules/expenses.ts exists and the index exports it (mutant: leaf file missing)', () => {
    expect(existsSync(join(REPO, ...LEAF_FILE.split('/'))), `${LEAF_FILE} does not exist`).toBe(true);
    yes(domainCode('business-rules/index.ts'), /export \* from '\.\/expenses'/);
  });

  it('holds E1-E4 and P1-P3, each keyed by its own id with a non-empty watch list and a run function (mutant: a check not registered)', () => {
    expect(REGISTRY, 'BUSINESS_CHECKS is not exported by @shareat/domain/business-rules').toBeTruthy();
    for (const id of Object.values(ID)) {
      const c = REGISTRY[id];
      expect(c, `missing check ${id}`).toBeTruthy();
      expect(c!.id).toBe(id);
      expect(Array.isArray(c!.watch) && c!.watch.length > 0, `${id} watches nothing`).toBe(true);
      expect(typeof c!.run).toBe('function');
    }
  });

  it('the new-expense checks watch the picked invoice; the edit check watches the category; P2 watches the override tick (mutant: reads a control it does not list)', () => {
    for (const id of [ID.amountWithinRemaining, ID.creditNeedsTerms, ID.supplierActive]) {
      expect(REGISTRY[id]?.watch ?? [], id).toContain('supplierInvoiceId');
    }
    expect(REGISTRY[ID.categoryMapped]?.watch ?? []).toContain('categoryId');
    expect(REGISTRY[ID.periodOpen]?.watch ?? []).toContain('periodOverrideConfirm');
  });

  it('E1 and E2 also watch the payment lines they read (the count, a method and an amount) - a check that reads lineAmount_0 must list it, or typing an amount never re-runs it', () => {
    const e1 = REGISTRY[ID.amountWithinRemaining]?.watch ?? [];
    const e2 = REGISTRY[ID.creditNeedsTerms]?.watch ?? [];
    expect(e1.some((n) => /^lineAmount/.test(n)), `E1 watch: ${e1.join(',')}`).toBe(true);
    expect(e2.some((n) => /^lineMethod/.test(n)), `E2 watch: ${e2.join(',')}`).toBe(true);
  });

  it('the leaf is client-safe: it imports only ./*, @shareat/core/{money,datetime} and ../shared/{money-input,money-lines} (mutant: imports @shareat/db or refuse)', () => {
    const src = domainCode('business-rules/expenses.ts');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i, `import ${i}`).toMatch(/^(\.\/[a-z-]+|\.\.\/shared\/(money-input|money-lines)|@shareat\/core\/(money|datetime))$/);
    }
  });
});

describe('T-475 S2 - one copy of each sentence: the leaf holds it, the domain site throws it (spec 3.1)', () => {
  it('E3: the "not active - an expense cannot be recorded" sentence lives in the leaf and no longer inline in create.ts (mutant: two copies)', () => {
    const phrase = 'an expense cannot be recorded against a supplier the business has stopped buying from';
    yes(domainCode('business-rules/expenses.ts'), phrase);
    no(domainCode('expenses/create.ts'), phrase);
  });

  it('E4: "no ledger account yet" lives in the leaf; editExpense imports the leaf rather than owning the sentence (mutant: check inline / removed)', () => {
    const phrase = 'has no ledger account yet';
    yes(domainCode('business-rules/expenses.ts'), phrase);
    const edit = domainCode('expenses/edit.ts');
    no(edit, phrase)
    yes(edit, /business-rules/)
  });

  it('P2: the locked / closed month sentences live in the leaf, not inline in approve.ts (mutant: two copies)', () => {
    yes(domainCode('business-rules/expenses.ts'), 'Nothing can be posted into it, not even with the closed-month override');
    yes(domainCode('business-rules/expenses.ts'), 'Ask an administrator to post this one entry into it');
    const approve = domainCode('expenses/approve.ts');
    no(approve, 'Nothing can be posted into it, not even with the closed-month override')
    no(approve, 'Ask an administrator to post this one entry into it')
  });
});

describe('T-475 S2 - /expenses/new wiring (E1-E3, C2 / F1)', () => {
  it('no longer hands MoneyLines a null supplier: `supplierId={null}` is gone and InvoiceMoneyLines is used (mutant: the F1 bug restored - Credit can never be entered)', () => {
    const page = code('app/expenses/new/page.tsx');
    no(page, /supplierId=\{null\}/)
    no(page, /supplierCreditTermsDays=\{null\}/)
    yes(page, /InvoiceMoneyLines/)
  });

  it('InvoiceMoneyLines exists, is a client component, and passes a picked invoice\'s supplier and terms to MoneyLines (mutant: wrapper still passes null)', () => {
    const rel = 'components/money/InvoiceMoneyLines.tsx';
    expect(existsSync(join(SRC, ...rel.split('/'))), `${rel} does not exist`).toBe(true);
    const raw = readSrc(rel);
    expect(raw.trimStart().startsWith("'use client'") || raw.trimStart().startsWith('"use client"'), 'must be a client component').toBe(true);
    const src = strip(raw);
    yes(src, /<MoneyLines/)
    no(src, /supplierId=\{null\}/)
    yes(src, /creditTermsDays/)
  });

  it('mounts a RuleCheck for each of E1, E2 and E3 (mutant: a rule the server enforces but the page never shows)', () => {
    const page = code('app/expenses/new/page.tsx') + (existsSync(join(SRC, 'components/money/InvoiceMoneyLines.tsx')) ? code('components/money/InvoiceMoneyLines.tsx') : '');
    for (const id of [ID.amountWithinRemaining, ID.creditNeedsTerms, ID.supplierActive]) yes(page, id);
    yes(page, /RuleCheck/)
  });

  it('the picker facts come from listOpenInvoicesForPicker and carry the supplier terms, status and room (spec C2)', () => {
    const lib = code('app/ap/lib.ts');
    const body = lib.slice(lib.indexOf('export async function listOpenInvoicesForPicker'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/creditTermsDays/);
    expect(body.slice(0, body.indexOf('\n}\n'))).toMatch(/supplierStatus|status:\s*supplier/);
  });
});

describe('T-475 S2 - /expenses/[id] wiring (E4, P1-P3)', () => {
  const PAGE = 'app/expenses/[id]/page.tsx';

  it('the approve card is a CheckedForm, not a plain <form action={approveExpenseAction}> (mutant: left a plain form, so no live line and Save never goes off)', () => {
    const page = code(PAGE);
    no(page, /<form\s+action=\{approveExpenseAction\}/)
    yes(page, /<CheckedForm[\s\S]{0,200}action=\{approveExpenseAction\}/)
  });

  it('mounts a RuleCheck for each of P1, P2, P3 and E4 (mutant: one of the rules not shown)', () => {
    const page = code(PAGE);
    for (const id of [ID.invoiceVerified, ID.periodOpen, ID.wouldPost, ID.categoryMapped]) yes(page, id);
  });

  it('the page never calls authorize() (R10: a page view writes no denial row; it asks can())', () => {
    const page = code(PAGE);
    no(page, /\bauthorize\(/)
  });

  it('the category select disables a category that has no ledger account, unless it is the draft\'s current one (mutant: select offers unmapped enabled - F4)', () => {
    const page = code(PAGE);
    const at = page.indexOf('name="categoryId"');
    expect(at).toBeGreaterThan(0);
    const select = page.slice(at, page.indexOf('</Select>', at));
    yes(select, /disabled=\{/)
    yes(select, /accountCode/)
  });

  it('the period lookup is NOT inside the override-holder branch: the old `canOverrideClosedMonth(actor) ?` gate no longer decides whether the month is looked up (mutant: P2 gated on holder again - F7)', () => {
    const page = code(PAGE);
    const holderGate = /canOverrideClosedMonth\(actor\)\s*\)\s*\?\s*closedMonthOf\(/;
    no(page, holderGate)
  });
});
