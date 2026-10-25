/**
 * T-475 S1 (TESTER) - the form layer for business-rule blockers and warnings, and the wiring of the log and verify forms.
 * Spec: docs/tasks/475-ap-expense-live-checks-self-verify-linkage.md sections 3.2, 7 S1. Node, `react-dom/server`, no jsdom
 * (T-440 A8: real-DOM behaviour - typing, focus, a real reset - is the section 6 browser smoke).
 *
 * CONTRACT PINNED HERE (the spec names the pieces, not the event names; the builder matches these or edits the PINNED lines):
 *   checkedFormReducer gains   { type: 'verdict', id: string, verdict: null | { level: 'block' | 'warn', sentence: string } }
 *       null clears the id; block registers a blocker; warn registers a warning. Nothing else about the state is pinned:
 *       the tests read it only through checkContextValue.
 *   CheckCtx gains   blockers: ReadonlyMap<string, string>,  warnings: ReadonlyMap<string, string>   (id -> sentence)
 *       blocked = some field rule fails || blockers.size > 0;  a warning NEVER blocks.
 *       summary = "Save is off until: " + the failing field requirements (as T-440) THEN the blocker sentences.
 *   <RuleCheck id facts /> from '@/components/forms' (file components/forms/RuleCheck.tsx): renders nothing outside a form context.
 *   useLookupCheck(action, inputs) exported from components/forms (file may be useLookupCheck.ts).
 *
 * MUTANTS: `blocked` ignoring blockers (Save stays on with a rule broken); a warning treated as a blocker; a blocker listed
 * BEFORE the field requirements; checks active before hydration (a no-JS submit blocked); a verdict surviving `off` (locked);
 * the verify form left a plain <form>; a log-form control with no RuleCheck; a lookup that answers (or blocks) while pending;
 * the leaf not exported / not resolvable in the client bundle.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defineFieldRules } from '../../../packages/domain/src/field-rules';

const formStatus = vi.hoisted(() => ({ pending: false }));
vi.mock('react-dom', async (orig) => ({
  ...(await orig<typeof import('react-dom')>()),
  useFormStatus: () => ({ pending: formStatus.pending, data: null, method: null, action: null }),
}));

const REPO = join(__dirname, '..', '..', '..');
const SRC = join(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(join(SRC, ...rel.split('/')), 'utf8');
/** Source with comments removed: a name that appears only in a comment proves nothing. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const readRepo = (rel: string) => readFileSync(join(REPO, ...rel.split('/')), 'utf8');
const forms = () => import('../src/components/forms');
const state = () => import('../src/components/forms/check-state');

const RULES = defineFieldRules('t475.demo', { name: { label: 'The name', kind: 'text', requires: 'Type a name.' } });
const NONE = defineFieldRules('t475.none', {});
const BLOCK = { level: 'block' as const, sentence: "A due date can't be before the invoice date." };
const WARN = { level: 'warn' as const, sentence: 'Pork Co already has invoice "INV-7" recorded (2026-01-02 ₱1200.00). Check it is not the same bill twice.' };

type Ctx = {
  active: boolean;
  blocked: boolean;
  summary: string | null;
  failing: string[];
  blockers: ReadonlyMap<string, string>;
  warnings: ReadonlyMap<string, string>;
};
type Ev = unknown;
async function drive(set: object, events: Ev[]): Promise<Ctx> {
  const s = await state();
  const reduce = s.checkedFormReducer as unknown as (st: unknown, e: unknown) => unknown;
  let st: unknown = s.CHECKED_FORM_INITIAL;
  for (const e of events) st = reduce(st, e);
  return s.checkContextValue(set as never, st as never) as unknown as Ctx;
}
const read_ = (values: Record<string, string>) => ({ type: 'read', values });
const verdict = (id: string, v: unknown) => ({ type: 'verdict', id, verdict: v });

describe('T-475 S1 - blockers and warnings in the check state', () => {
  it('a blocker alone disables Save and is named in the summary, with no field failing (mutant: blocked ignores blockers)', async () => {
    const ctx = await drive(RULES, [read_({ name: 'Ana' }), verdict('ap.invoice.dueNotBeforeInvoice', BLOCK)]);
    expect(ctx.failing).toEqual([]);
    expect(ctx.blocked).toBe(true);
    expect(ctx.blockers.get('ap.invoice.dueNotBeforeInvoice')).toBe(BLOCK.sentence);
    expect(ctx.summary).toBe(`Save is off until: ${BLOCK.sentence}`);
  });

  it('a warning NEVER disables Save and is not in the summary (mutant: warn treated as block)', async () => {
    const ctx = await drive(RULES, [read_({ name: 'Ana' }), verdict('ap.invoice.duplicateNumber', WARN)]);
    expect(ctx.blocked).toBe(false);
    expect(ctx.summary).toBeNull();
    expect(ctx.blockers.size).toBe(0);
    expect(ctx.warnings.get('ap.invoice.duplicateNumber')).toBe(WARN.sentence);
  });

  it('a null verdict clears the blocker and the warning; Save comes back on', async () => {
    const id = 'ap.invoice.dueNotBeforeInvoice';
    const ctx = await drive(RULES, [read_({ name: 'Ana' }), verdict(id, BLOCK), verdict(id, null)]);
    expect(ctx.blocked).toBe(false);
    expect(ctx.blockers.size).toBe(0);
    const w = await drive(RULES, [read_({ name: 'Ana' }), verdict('w', WARN), verdict('w', null)]);
    expect(w.warnings.size).toBe(0);
  });

  it('a block that becomes a warn under the same id moves from blockers to warnings (re-run on edit)', async () => {
    const ctx = await drive(RULES, [read_({ name: 'Ana' }), verdict('x', BLOCK), verdict('x', WARN)]);
    expect(ctx.blocked).toBe(false);
    expect(ctx.blockers.has('x')).toBe(false);
    expect(ctx.warnings.get('x')).toBe(WARN.sentence);
  });

  it('two blockers: both held, both in the summary; one cleared leaves the other blocking', async () => {
    const both = await drive(RULES, [read_({ name: 'Ana' }), verdict('a', BLOCK), verdict('b', { level: 'block', sentence: 'Second.' })]);
    expect(both.blockers.size).toBe(2);
    expect(both.summary).toContain(BLOCK.sentence);
    expect(both.summary).toContain('Second.');
    const one = await drive(RULES, [read_({ name: 'Ana' }), verdict('a', BLOCK), verdict('b', { level: 'block', sentence: 'Second.' }), verdict('a', null)]);
    expect(one.blocked).toBe(true);
    expect(one.blockers.has('a')).toBe(false);
  });

  it('field requirements come first, then the blockers (mutant: blocker listed before the field requirement)', async () => {
    const ctx = await drive(RULES, [read_({ name: '' }), verdict('a', BLOCK)]);
    expect(ctx.failing).toEqual(['name']);
    expect(ctx.blocked).toBe(true);
    const text = ctx.summary!;
    expect(text.startsWith('Save is off until: Type a name.')).toBe(true);
    expect(text.indexOf('Type a name.')).toBeLessThan(text.indexOf(BLOCK.sentence));
  });

  it('a form with an EMPTY rule set (the verify form) still blocks on a blocker', async () => {
    const ctx = await drive(NONE, [read_({}), verdict('ap.verify.attestation', { level: 'block', sentence: 'Confirm every part.' })]);
    expect(ctx.blocked).toBe(true);
    expect(ctx.summary).toBe('Save is off until: Confirm every part.');
  });

  it('BEFORE hydration (the first render = the server render) a verdict blocks nothing and shows nothing (mutant: no-JS submit blocked)', async () => {
    const ctx = await drive(RULES, [verdict('a', BLOCK)]);
    expect(ctx.active).toBe(false);
    expect(ctx.blocked).toBe(false);
    expect(ctx.summary).toBeNull();
  });

  it('a locked record (type off) is inactive even with a blocker held (mutant: checks active while locked)', async () => {
    const ctx = await drive(RULES, [read_({ name: 'Ana' }), verdict('a', BLOCK), { type: 'off' }]);
    expect(ctx.blocked).toBe(false);
    expect(ctx.summary).toBeNull();
  });

  it('a blocked submit with ONLY a blocker is stopped: preventDefault called, returns true (mutant: guard looks at field failures only)', async () => {
    const s = await state();
    const ctx = await drive(RULES, [read_({ name: 'Ana' }), verdict('a', BLOCK)]);
    let prevented = 0;
    const handled = s.onCheckedSubmit({ preventDefault: () => void prevented++ }, ctx as never, { touch: () => {}, focus: () => {} });
    expect(handled).toBe(true);
    expect(prevented).toBe(1);
  });
});

describe('T-475 S1 - <RuleCheck> and the lookup hook', () => {
  it('RuleCheck and useLookupCheck are exported from the forms barrel', async () => {
    const f = (await forms()) as unknown as Record<string, unknown>;
    expect(typeof f.RuleCheck).toBe('function');
    expect(typeof f.useLookupCheck).toBe('function');
  });

  it('outside a form context RuleCheck renders nothing (a stray one changes nothing)', async () => {
    const f = (await forms()) as unknown as { RuleCheck: never };
    expect(renderToStaticMarkup(createElement(f.RuleCheck, { id: 'ap.invoice.dueNotBeforeInvoice', facts: {} } as never))).toBe('');
  });

  it('on the server render inside a CheckedForm it prints no verdict line and Save stays enabled (no-JS safe)', async () => {
    const f = (await forms()) as unknown as { RuleCheck: never; CheckedForm: never };
    const { SubmitButton } = await import('../src/components/feedback/SubmitButton');
    const html = renderToStaticMarkup(
      createElement(
        f.CheckedForm,
        { rules: NONE, action: async () => {} } as never,
        createElement('input', { name: 'dueDate', defaultValue: '2026-01-01' }),
        createElement(f.RuleCheck, { id: 'ap.invoice.dueNotBeforeInvoice', facts: {} } as never),
        createElement(SubmitButton, null, 'Save'),
      ),
    );
    expect(html).not.toContain("can&#x27;t be before the invoice date");
    expect(html).not.toMatch(/<button[^>]*\sdisabled(=|\s|>)/);
  });

  it('RuleCheck.tsx: a client file that resolves the check by id from the leaf, tracks check.watch, and announces politely', () => {
    const p = 'components/forms/RuleCheck.tsx';
    expect(existsSync(join(SRC, p)), `${p} missing`).toBe(true);
    const src = read(p);
    expect(src.trimStart().startsWith("'use client'")).toBe(true);
    expect(src).toMatch(/from '@shareat\/domain\/business-rules'/);
    expect(src).toMatch(/BUSINESS_CHECKS\[/);
    expect(src).toMatch(/\.watch/);
    expect(src).toMatch(/aria-live="polite"/);
    // never colour alone: the block and the warn each carry an icon or a word
    expect(src).toMatch(/block/);
    expect(src).toMatch(/warn/);
  });

  it('useLookupCheck: debounced 400 ms, and gives NO verdict while unanswered or failed (mutant: blocks on a pending lookup)', () => {
    const files = ['components/forms/useLookupCheck.ts', 'components/forms/useLookupCheck.tsx', 'components/forms/RuleCheck.tsx'].filter((f) => existsSync(join(SRC, f)));
    const src = files.map(read).join('\n');
    expect(src).toMatch(/useLookupCheck/);
    expect(src).toMatch(/\b400\b/);
    expect(src).toMatch(/catch/); // a failed lookup is swallowed into "no verdict"
  });
});

describe('T-475 S1 - the leaf is reachable from the client bundle', () => {
  it('packages/domain/package.json exports ./business-rules', () => {
    const pkg = JSON.parse(readRepo('packages/domain/package.json')) as { exports: Record<string, string> };
    expect(pkg.exports['./business-rules']).toBe('./src/business-rules/index.ts');
  });
  it('vitest.config.mts and both tsconfigs resolve @shareat/domain/business-rules (exact entry before the bare name)', () => {
    expect(readRepo('vitest.config.mts')).toMatch(/'@shareat\/domain\/business-rules':/);
    expect(readRepo('apps/erp/tsconfig.json')).toContain('@shareat/domain/business-rules');
    expect(readRepo('tsconfig.json')).toContain('@shareat/domain/business-rules');
    const v = readRepo('vitest.config.mts');
    expect(v.indexOf('@shareat/domain/business-rules')).toBeLessThan(v.indexOf("'@shareat/domain':"));
  });
  it('the leaf imports only itself, field-rules-style leaves, core money/datetime and shared money-input/money-lines (no @shareat/db, no barrel)', () => {
    const dir = join(REPO, 'packages/domain/src/business-rules');
    expect(existsSync(join(dir, 'index.ts'))).toBe(true);
    const ALLOWED = /^(\.\/|\.\.\/shared\/money-input|\.\.\/shared\/money-lines|@shareat\/core\/money|@shareat\/core\/datetime)/;
    for (const f of ['index.ts', 'check.ts', 'ap.ts']) {
      const p = join(dir, f);
      if (!existsSync(p)) continue;
      const specs = [...readFileSync(p, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const s of specs) expect(ALLOWED.test(s), `${f} imports ${s}`).toBe(true);
    }
  });
});

describe('T-475 S1 - the log form (/ap) carries the checks', () => {
  const page = () => read('app/ap/page.tsx');
  it('mounts a RuleCheck for each of A1-A5 inside the CheckedForm', () => {
    const src = page();
    for (const id of ['ap.invoice.supplierActive', 'ap.invoice.dueNotBeforeInvoice', 'ap.invoice.feesNotOverTotal', 'ap.invoice.vat', 'ap.invoice.duplicateNumber'])
      expect(src, `no RuleCheck for ${id}`).toMatch(new RegExp(`<RuleCheck[\\s\\S]{0,80}id="${id.replace(/\./g, '\\.')}"`));
    expect(src).toContain('<CheckedForm rules={SUPPLIER_INVOICE_LOG_RULES}');
  });
  it('passes the supplier facts (status, VAT status) from the server component, not from a client fetch', () => {
    const src = page();
    expect(code('app/ap/page.tsx')).toMatch(/buildSupplierFacts\(/);
    expect(src).toMatch(/status/);
  });
  it('the duplicate-number check is fed by a client lookup that calls checkInvoiceNumberAction', () => {
    const dir = join(SRC, 'app', 'ap');
    const candidates = ['page.tsx', 'InvoiceNumberCheck.tsx', 'DuplicateInvoiceCheck.tsx', 'InvoiceLogChecks.tsx', 'InvoiceLogFields.tsx'].map((f) => join(dir, f)).filter(existsSync);
    const withLookup = candidates.map((f) => readFileSync(f, 'utf8')).filter((t) => /useLookupCheck/.test(t) && /checkInvoiceNumberAction/.test(t));
    expect(withLookup.length, 'no file under app/ap calls useLookupCheck with checkInvoiceNumberAction').toBeGreaterThan(0);
    expect(withLookup.some((t) => t.trimStart().startsWith("'use client'"))).toBe(true);
  });
});

describe('T-475 S1 - the verify form (/ap/invoices/[id]) is a CheckedForm with V2-V5', () => {
  const page = () => read('app/ap/invoices/[id]/page.tsx');
  it('the verify form is a <CheckedForm>, not a plain <form> (mutant: left a plain form)', () => {
    const src = page();
    expect(src).toMatch(/<CheckedForm[\s\S]{0,300}?action=\{verifyInvoiceAction\}/);
    expect(src).not.toMatch(/<form\s+action=\{verifyInvoiceAction\}/);
  });
  it('mounts a RuleCheck for V2, V3, V4 and V5', () => {
    const src = page();
    for (const id of ['ap.verify.attestation', 'ap.verify.supplierActive', 'ap.verify.receiptPhoto', 'ap.verify.draftsWouldPost'])
      expect(src, `no RuleCheck for ${id}`).toMatch(new RegExp(`<RuleCheck[\\s\\S]{0,80}id="${id.replace(/\./g, '\\.')}"`));
  });
  it('V5 facts come from the shared approval evaluator (gatherApprovalFacts + approvalVerdict), run for the draft list on the server', () => {
    const src = page();
    expect(code('app/ap/invoices/[id]/page.tsx')).toMatch(/previewInvoiceDrafts\(/);
  });
  it('the four attestation checkboxes keep their control names (the action and the leaf read them)', () => {
    const src = page();
    for (const n of ['attestSupplier', 'attestInvoice', 'attestItems', 'attestPrice']) expect(src).toContain(n);
  });
});

describe('T-475 S1 - one fact builder for the page loader and the domain (Opus review 1)', () => {
  // PINNED names: the leaf exports pure builders from DB rows; page loaders and domain refusal sites both call them.
  const BUILDERS = ['buildSupplierFacts', 'buildReceiptFacts'];
  it('the leaf exports the builders, and they produce the facts the checks read', async () => {
    const leaf = (await import('../../../packages/domain/src/business-rules')) as unknown as Record<string, (...a: never[]) => unknown>;
    for (const b of BUILDERS) expect(typeof leaf[b], `${b} not exported by the leaf`).toBe('function');
    const sup = leaf.buildSupplierFacts!([{ id: 's1', name: 'Pork Co', status: 'inactive', vatStatus: 'non_vat' }] as never) as { suppliers: Record<string, unknown> };
    expect(sup.suppliers.s1).toEqual({ name: 'Pork Co', status: 'inactive', vatStatus: 'non_vat' });
  });
  it('the log page, the verify page and the domain ap/index.ts all call the SAME builders; the pages derive nothing themselves (mutant: loader derives VAT/status on its own)', () => {
    const files = { logPage: read('app/ap/page.tsx'), verifyPage: read('app/ap/invoices/[id]/page.tsx'), domain: readRepo('packages/domain/src/ap/index.ts') };
    expect(code('app/ap/page.tsx')).toContain('buildSupplierFacts');
    expect(code('app/ap/invoices/[id]/page.tsx')).toContain('buildReceiptFacts');
    expect(files.domain).toMatch(/buildSupplierFacts|buildReceiptFacts/);
    for (const [name, text] of Object.entries(files)) {
      if (name === 'domain') continue;
      expect(text, `${name} compares a supplier status itself`).not.toMatch(/=== 'vat_registered'|=== 'non_vat'|\.status !== 'active'|\.status === 'inactive'/);
    }
  });
});

describe('T-475 S1 - a refused verify keeps the ticks and the override reason (Opus review 7)', () => {
  it('verifyInvoiceAction catch hands the typed ticks and override fields back through the flash (keepTyping), and the page refills them', () => {
    const actions = read('app/ap/actions.ts');
    const at = actions.indexOf('export async function verifyInvoiceAction');
    const body = actions.slice(at, actions.indexOf('export async function voidInvoiceAction'));
    expect(body).toMatch(/keepTyping\(/);
    expect(body).toMatch(/typed:/);
    const typedForms = read('app/ap/typed-forms.ts');
    for (const n of ['attestSupplier', 'attestInvoice', 'attestItems', 'attestPrice', 'periodOverrideReason']) expect(typedForms, n).toContain(n);
  });
});

describe('T-475 S1 - V1 keeps the current sentence (Opus review 8)', () => {
  it('ap/index.ts still says "Verification is a second pair of eyes"', () => {
    expect(readRepo('packages/domain/src/ap/index.ts')).toMatch(/Verification is a second pair of/);
  });
});
