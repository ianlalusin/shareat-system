/**
 * T-343 S5.5w — DEF-472 census, the rest (8 elements, 28 fields).
 * `docs/tasks/343-def-417-human-readable-refusals.md` §"S5.5w — build" item 1.
 *
 * ⛔ TESTER, not BUILDER. Every listed `<input>` still carries `type="number"` — measured directly
 * below, never presumed.
 *
 * `NumField`/`IntField` (`settings/attendance/page.tsx`) are shared helper components rendering
 * MANY fields through one element each — the spec's own "R-legs ×8 elements... asserted on the
 * helper element" — so those two legs read the function BODY (found by name), not a per-field
 * `name=` literal the way every other leg here does.
 *
 * ⚠️ Judgment call, flagged rather than guessed silently: the spec's item 1 says NumField "drop[s]
 * step/min" and IntField "drop[s] min/max", but does not separately spell out `type="number"` for
 * either — read as implied (DEF-472's whole premise; every prior slice's boilerplate). IntField's
 * hardcoded `step={1}` is not mentioned as dropped or kept for it specifically, so this file asserts
 * only what the spec states for each: NumField loses type/step/min; IntField loses type/min/max.
 * IntField's `step` is left unasserted either way.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');

function inputTagFor(filePath: string, nameLiteral: string): string {
  const src = readFileSync(resolve(repoRoot, filePath), 'utf8');
  const needle = `name=${nameLiteral}`;
  const occurrences = src.split(needle).length - 1;
  expect(occurrences, `"${needle}" must appear exactly once in ${filePath}`).toBe(1);

  const nameIdx = src.indexOf(needle);
  const tagStart = src.lastIndexOf('<input', nameIdx);
  expect(tagStart, `no preceding <input for "${needle}" in ${filePath}`).toBeGreaterThan(-1);
  const tagEnd = src.indexOf('/>', nameIdx);
  expect(tagEnd, `no self-closing "/>" found for "${needle}" in ${filePath}`).toBeGreaterThan(-1);
  return src.slice(tagStart, tagEnd + 2);
}

/** For a shared helper component rendering one <input> per call — finds it by function name. */
function helperInputTag(filePath: string, functionName: string): string {
  const src = readFileSync(resolve(repoRoot, filePath), 'utf8');
  const fnNeedle = `function ${functionName}(`;
  const occurrences = src.split(fnNeedle).length - 1;
  expect(occurrences, `"${fnNeedle}" must appear exactly once in ${filePath}`).toBe(1);
  const fnIdx = src.indexOf(fnNeedle);
  const tagStart = src.indexOf('<input', fnIdx);
  expect(tagStart, `no <input inside ${functionName} in ${filePath}`).toBeGreaterThan(-1);
  const tagEnd = src.indexOf('/>', tagStart);
  expect(tagEnd, `no self-closing "/>" for the <input> inside ${functionName} in ${filePath}`).toBeGreaterThan(-1);
  return src.slice(tagStart, tagEnd + 2);
}

describe('R-legs — source-text: each converted box has no type="number"/step/min/max, and the assigned inputMode', () => {
  it('ap/invoices/[id]/page.tsx — line${i}_quantity (decimal)', () => {
    const tag = inputTagFor('apps/erp/src/app/ap/invoices/[id]/page.tsx', '{`line${i}_quantity`}');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bstep=/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).toMatch(/inputMode=["']decimal["']/);
  });

  it('ap/invoices/[id]/page.tsx — line${i}_unitPrice (decimal; server guard: T-351 A-legs)', () => {
    const tag = inputTagFor('apps/erp/src/app/ap/invoices/[id]/page.tsx', '{`line${i}_unitPrice`}');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bstep=/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).toMatch(/inputMode=["']decimal["']/);
  });

  it('cutover/count/page.tsx — quantity (decimal, still required)', () => {
    const tag = inputTagFor('apps/erp/src/app/cutover/count/page.tsx', '"quantity"');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bstep=/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).toMatch(/inputMode=["']decimal["']/);
  });

  it('prepaid/page.tsx — totalCost (decimal)', () => {
    const tag = inputTagFor('apps/erp/src/app/prepaid/page.tsx', '"totalCost"');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bstep=/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).toMatch(/inputMode=["']decimal["']/);
  });

  it('prepaid/page.tsx — coverageMonths (numeric)', () => {
    const tag = inputTagFor('apps/erp/src/app/prepaid/page.tsx', '"coverageMonths"');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bstep=/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).toMatch(/inputMode=["']numeric["']/);
  });

  it('prepaid/[id]/page.tsx — coverageMonths (numeric)', () => {
    const tag = inputTagFor('apps/erp/src/app/prepaid/[id]/page.tsx', '"coverageMonths"');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bstep=/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).toMatch(/inputMode=["']numeric["']/);
  });

  it('settings/attendance/page.tsx — NumField helper element (decimal; drops step/min)', () => {
    const tag = helperInputTag('apps/erp/src/app/settings/attendance/page.tsx', 'NumField');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bstep=/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).toMatch(/inputMode=["']decimal["']/);
  });

  it('settings/attendance/page.tsx — IntField helper element (numeric; drops min/max)', () => {
    const tag = helperInputTag('apps/erp/src/app/settings/attendance/page.tsx', 'IntField');
    expect(tag).not.toMatch(/type=["']number["']/);
    expect(tag).not.toMatch(/\bmin=/);
    expect(tag).not.toMatch(/\bmax=/);
    expect(tag).toMatch(/inputMode=["']numeric["']/);
  });
});

describe('R-legs — green, unedited: the one REQUIRED spinner this task census names as staying', () => {
  it('⛔ green, unedited — payroll/thirteenth-month/page.tsx year stays type="number" (a GET preview parameter, harmless)', () => {
    // Three `name="year"` inputs exist on this page (one visible, two hidden); the visible one is
    // the only one with `type="number"` and is distinguished by that, not by `inputTagFor`'s
    // exactly-once search (which would fail here for an unrelated reason — three matches).
    const src = readFileSync(resolve(repoRoot, 'apps/erp/src/app/payroll/thirteenth-month/page.tsx'), 'utf8');
    const needle = 'name="year" type="number"';
    expect(src, `expected "${needle}" to appear exactly once`).toMatch(needle);
    expect(src.split(needle).length - 1).toBe(1);
  });
});
