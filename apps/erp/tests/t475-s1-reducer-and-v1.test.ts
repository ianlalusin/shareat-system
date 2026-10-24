/**
 * T-475 S1 (TESTER, round 3) - two defects the browser smoke found.
 *
 * 1. The check-state reducer must PRESERVE blockers and warnings on every event that is not a verdict for that id. Found:
 *    case 'input' rebuilt the state from values/touched/active only, so a blocker vanished (Save re-enabled, the Problem line
 *    stayed) the moment any OTHER field was edited, because RuleCheck only re-registers when its own verdict changes.
 *    MUTANT: any event (input, touch, read, off) drops blockers/warnings.
 * 2. V1 (you logged this invoice) is a LIVE blocker on the verify form in S1: leaf id 'ap.verify.selfVerify' (PINNED), facts
 *    { createdByViewer: boolean }; the page feeds that fact from createdBy === actor.personId. Sentence = ap/index.ts's today.
 *    S3 will lift it for holders of verify_own_supplier_invoice. MUTANTS: the form shown to the creator with Save on; the page
 *    feeding a constant; the sentence edited in the leaf only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineFieldRules } from '../../../packages/domain/src/field-rules';
import * as leaf from '../../../packages/domain/src/business-rules';

const SRC = join(__dirname, '..', 'src');
const code = (rel: string) =>
  readFileSync(join(SRC, ...rel.split('/')), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const state = () => import('../src/components/forms/check-state');

const RULES = defineFieldRules('t475.keep', { name: { label: 'The name', kind: 'text', requires: 'Type a name.' } });
const BLOCK = { level: 'block' as const, sentence: "A due date can't be before the invoice date." };
const WARN = { level: 'warn' as const, sentence: 'Pork Co already has invoice "INV-7" recorded (2026-01-02 ₱1.00). Check it is not the same bill twice.' };

async function run(events: unknown[]) {
  const s = await state();
  const reduce = s.checkedFormReducer as unknown as (st: unknown, e: unknown) => unknown;
  let st: unknown = s.CHECKED_FORM_INITIAL;
  for (const e of events) st = reduce(st, e);
  return s.checkContextValue(RULES as never, st as never) as unknown as { blocked: boolean; blockers: ReadonlyMap<string, string>; warnings: ReadonlyMap<string, string>; summary: string | null };
}
const read = { type: 'read', values: { name: 'Ana' } };
const setup = [read, { type: 'verdict', id: 'b', verdict: BLOCK }, { type: 'verdict', id: 'w', verdict: WARN }];

describe('T-475 S1 - every reducer event preserves blockers and warnings', () => {
  const EVENTS: Array<[string, unknown]> = [
    ['input on another field', { type: 'input', name: 'name', value: 'Bea' }],
    ['input on an unruled field', { type: 'input', name: 'notes', value: 'x' }],
    ['touch', { type: 'touch', names: ['name'] }],
    ['read (mount / reset re-read)', { type: 'read', values: { name: 'Cy' } }],
  ];
  for (const [label, ev] of EVENTS) {
    it(`${label}: the blocker and the warning are still there and Save stays off (mutant: the event drops them)`, async () => {
      const ctx = await run([...setup, ev]);
      expect(ctx.blockers.get('b')).toBe(BLOCK.sentence);
      expect(ctx.warnings.get('w')).toBe(WARN.sentence);
      expect(ctx.blocked).toBe(true);
      expect(ctx.summary).toContain(BLOCK.sentence);
    });
  }
  it('several input events in a row keep them (the typing that exposed the defect)', async () => {
    const ctx = await run([...setup, ...['a', 'ab', 'abc'].map((value) => ({ type: 'input', name: 'name', value }))]);
    expect(ctx.blocked).toBe(true);
    expect(ctx.blockers.size).toBe(1);
  });
  it('a verdict for the SAME id still replaces/clears it (preservation is not stickiness)', async () => {
    expect((await run([...setup, { type: 'input', name: 'name', value: 'z' }, { type: 'verdict', id: 'b', verdict: null }])).blocked).toBe(false);
  });
  it('off then read: the inactive state is not blocked; nothing is invented', async () => {
    expect((await run([...setup, { type: 'off' }])).blocked).toBe(false);
  });
});

describe('T-475 S1 - V1 self-verify is a live blocker on the verify form', () => {
  const V1 = 'You logged this invoice, so you cannot also verify it. Verification is a second pair of eyes — ask a manager who did not enter it, or an admin.';
  const check = () => (leaf as unknown as { BUSINESS_CHECKS: Record<string, { watch: readonly string[]; run(f: unknown, v: Record<string, string>): { level: string; sentence: string } | null }> }).BUSINESS_CHECKS['ap.verify.selfVerify'];

  it('the leaf blocks the creator with the exact current sentence, passes everyone else', () => {
    expect(check(), "leaf check 'ap.verify.selfVerify' missing").toBeTruthy();
    expect(check()!.run({ createdByViewer: true }, {})).toEqual({ level: 'block', sentence: V1 });
    expect(check()!.run({ createdByViewer: false }, {})).toBeNull();
    expect(check()!.run(undefined, {})).toBeNull();
  });

  it('the verify page feeds the fact from createdBy vs the viewer (real code, comments stripped) and mounts the RuleCheck', () => {
    const page = code('app/ap/invoices/[id]/page.tsx');
    expect(page).toMatch(/<RuleCheck[\s\S]{0,80}id="ap\.verify\.selfVerify"/);
    expect(page).toMatch(/createdBy\s*===\s*actor\.personId|actor\.personId\s*===\s*invoice\.createdBy|createdByViewer/);
  });

  it('the sentence is written once, in the leaf (mutant: ap/index.ts keeps its own copy that can drift)', () => {
    const domain = readFileSync(join(__dirname, '..', '..', '..', 'packages', 'domain', 'src', 'ap', 'index.ts'), 'utf8').replace(/['"`]\s*\+\s*\n\s*['"`]/g, '');
    expect(domain).not.toContain('You logged this invoice, so you cannot also verify it.');
  });
});
