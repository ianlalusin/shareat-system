/**
 * T-343 S5.5t — DEF-470, the rest: minutes / till counts / opening costs / conversion factor.
 * `docs/tasks/343-def-417-human-readable-refusals.md` §S5.5t item 1.
 *
 * ⛔ TESTER, not BUILDER. Every listed `<input>` still carries `type="number"`, `step`, and (where
 * present) `min`/`max` — measured directly below, never presumed.
 *
 * ⚠️ Spec-count discrepancy, measured not presumed: the spec's own prose says "Seven inputs in
 * five files" and "R-legs, one per converted box (7)", but the classification section itself names
 * only SIX locations across FOUR files (attendance/[dayId]/page.tsx:253,289,324,
 * cutover/count/page.tsx:153, till/page.tsx:209, ap/invoices/[id]/page.tsx:181) — confirmed by a
 * direct `grep 'type="number"'` over all four files: 9 total matches, of which 3 are explicitly
 * OUT of scope (cutover's `quantity` at :140 — a required spinner, same class as
 * ap/invoices' `line{i}_quantity`/`line{i}_unitPrice` at :167/:190, all named out of scope in
 * S5.5s's own "Out of scope" list). 6 in-scope boxes, not 7; 4 files, not 5. Six R-legs below, one
 * per real box, plus explicit green pins for the three untouched spinners so a future accidental
 * conversion of one of THEM fails loudly here too.
 *
 * All five files are server components (spec's own line) — every leg here is source-text, no
 * render needed (unlike S5.5s's two 'use client' forms).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..', '..');

/**
 * `nameLiteral` is the EXACT source substring that appears right after `name=` in the JSX — a
 * plain `"foo"` for a literal name, or the template-literal form (`` {`count:${a.id}`} ``) for a
 * computed one.
 *
 * ⭐ Same orchestrator ruling as S5.5s's own `inputTagFor` — asserts the box is found EXACTLY ONCE
 * before checking anything about it.
 */
function inputTagFor(filePath: string, nameLiteral: string): string {
  const src = readFileSync(resolve(repoRoot, filePath), 'utf8');
  const needle = `name=${nameLiteral}`;
  const occurrences = src.split(needle).length - 1;
  expect(occurrences, `"${needle}" must appear exactly once in ${filePath}`).toBe(1);

  const nameIdx = src.indexOf(needle);
  const tagStart = src.lastIndexOf('<input', nameIdx);
  expect(tagStart, `no preceding <input for "${needle}" in ${filePath}`).toBeGreaterThan(-1);
  // Anchor on the tag's real close (`/>`), not the first `>` — an inline `onChange={(e) => …}`
  // arrow function's own `>` sits before the tag actually closes and would truncate the slice early.
  const tagEnd = src.indexOf('/>', nameIdx);
  expect(tagEnd, `no self-closing "/>" found for "${needle}" in ${filePath}`).toBeGreaterThan(-1);
  return src.slice(tagStart, tagEnd + 2);
}

function assertConverted(filePath: string, nameLiteral: string, inputMode: 'numeric' | 'decimal') {
  const tag = inputTagFor(filePath, nameLiteral);
  expect(tag, `${filePath} ${nameLiteral}: must not carry type="number"`).not.toMatch(/type=["']number["']/);
  expect(tag, `${filePath} ${nameLiteral}: must not carry a step= attribute`).not.toMatch(/\bstep=/);
  expect(tag, `${filePath} ${nameLiteral}: must not carry a min= attribute`).not.toMatch(/\bmin=/);
  expect(tag, `${filePath} ${nameLiteral}: must not carry a max= attribute`).not.toMatch(/\bmax=/);
  expect(tag, `${filePath} ${nameLiteral}: must carry inputMode="${inputMode}"`).toMatch(
    new RegExp(`inputMode=["']${inputMode}["']`),
  );
}

describe('R-legs — source-text: each converted box has no type="number"/step/min/max, and the assigned inputMode', () => {
  it('attendance/[dayId]/page.tsx — approvedOtMinutes (numeric)', () => {
    assertConverted('apps/erp/src/app/attendance/[dayId]/page.tsx', '"approvedOtMinutes"', 'numeric');
  });
  it('attendance/[dayId]/page.tsx — chosenAnchorMinute (numeric)', () => {
    assertConverted('apps/erp/src/app/attendance/[dayId]/page.tsx', '"chosenAnchorMinute"', 'numeric');
  });
  it('attendance/[dayId]/page.tsx — effectiveOutMinute (numeric)', () => {
    assertConverted('apps/erp/src/app/attendance/[dayId]/page.tsx', '"effectiveOutMinute"', 'numeric');
  });
  it('cutover/count/page.tsx — unitCost (decimal)', () => {
    assertConverted('apps/erp/src/app/cutover/count/page.tsx', '"unitCost"', 'decimal');
  });
  it('till/page.tsx — count:${a.id} (decimal)', () => {
    assertConverted('apps/erp/src/app/till/page.tsx', '{`count:${a.id}`}', 'decimal');
  });
  it('ap/invoices/[id]/page.tsx — line${i}_conversionFactor (decimal)', () => {
    assertConverted('apps/erp/src/app/ap/invoices/[id]/page.tsx', '{`line${i}_conversionFactor`}', 'decimal');
  });
});

describe('⚠️ RULED EDIT (T-343 S5.5w) — the three legs below no longer pin "stays type=number": S5.5w converts cutover quantity and AP quantity/unitPrice too, so they flip to R-legs here', () => {
  it('R-leg (S5.5w) — cutover/count/page.tsx quantity: no type="number"/step/min, inputMode="decimal" (still required)', () => {
    const tag = inputTagFor('apps/erp/src/app/cutover/count/page.tsx', '"quantity"');
    expect(tag, 'must not carry type="number"').not.toMatch(/type=["']number["']/);
    expect(tag, 'must not carry a step= attribute').not.toMatch(/\bstep=/);
    expect(tag, 'must not carry a min= attribute').not.toMatch(/\bmin=/);
    expect(tag, 'must carry inputMode="decimal"').toMatch(/inputMode=["']decimal["']/);
    expect(tag, '`required` is unrelated to the number->text change and stays').toMatch(/\brequired\b/);
  });
  it('R-leg (S5.5w) — ap/invoices/[id]/page.tsx line${i}_quantity: no type="number"/step/min, inputMode="decimal"', () => {
    const tag = inputTagFor('apps/erp/src/app/ap/invoices/[id]/page.tsx', '{`line${i}_quantity`}');
    expect(tag, 'must not carry type="number"').not.toMatch(/type=["']number["']/);
    expect(tag, 'must not carry a step= attribute').not.toMatch(/\bstep=/);
    expect(tag, 'must not carry a min= attribute').not.toMatch(/\bmin=/);
    expect(tag, 'must carry inputMode="decimal"').toMatch(/inputMode=["']decimal["']/);
  });
  it('R-leg (S5.5w) — ap/invoices/[id]/page.tsx line${i}_unitPrice: no type="number"/step/min, inputMode="decimal" (server guard: T-351 A-legs; input change only)', () => {
    const tag = inputTagFor('apps/erp/src/app/ap/invoices/[id]/page.tsx', '{`line${i}_unitPrice`}');
    expect(tag, 'must not carry type="number"').not.toMatch(/type=["']number["']/);
    expect(tag, 'must not carry a step= attribute').not.toMatch(/\bstep=/);
    expect(tag, 'must not carry a min= attribute').not.toMatch(/\bmin=/);
    expect(tag, 'must carry inputMode="decimal"').toMatch(/inputMode=["']decimal["']/);
  });
});
