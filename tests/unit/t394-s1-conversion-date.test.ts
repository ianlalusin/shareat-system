import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUTOVER_CLASSIFICATION } from '../../packages/db/src/cutover/classification';
import { CONVERSION_DATE as TIE_OUT_DATE } from '../../packages/domain/src/cutover/tie-out';
import { PURGE_AS_OF } from '../integration/t390-real-purge';

/**
 * T-394 S1 invariant 7 / R7 / DEF-642 - the conversion date is written five times; they must agree.
 * `docs/tasks/394-purge-and-opening-rehearsal.md` s4 R7, s6 I7. Written TESTER-FIRST.
 *
 * The five copies: apps/erp/src/app/cutover/lib.ts CONVERSION_DATE, packages/domain/src/cutover/tie-out.ts CONVERSION_DATE,
 * the private CONVERSION in packages/domain/src/cutover/opening-stock.ts, fiscal_periods.keepFrom in classification.ts,
 * PURGE_AS_OF in tests/integration/t390-real-purge.ts.
 *
 * The apps/erp file is read as TEXT (a unit test may not pull a server module in); the other copies are values or text of
 * modules that import cleanly. R7 also asks for opening-stock.ts to DERIVE its copy (`const CONVERSION = CONVERSION_DATE;`
 * imported from './tie-out'), so one edit moves every copy; 7.b asserts that and is red on HEAD (7.a is green on HEAD: the
 * five agree today; it is the tripwire for the day one moves).
 */

const read = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The date a source file's `<name>` constant resolves to when it is a literal, else null. */
function literalOf(src: string, name: string, exported: boolean): string | null {
  const m = new RegExp(`^${exported ? 'export ' : ''}const ${name} = '(\\d{4}-\\d{2}-\\d{2})';`, 'm').exec(src);
  return m?.[1] ?? null;
}

/** True when opening-stock-style source derives its constant from the single exported date. */
function derivesFromConversionDate(src: string): boolean {
  return (
    /^const CONVERSION = CONVERSION_DATE;/m.test(src) &&
    /import\s*\{[^}]*\bCONVERSION_DATE\b[^}]*\}\s*from\s*'\.\/tie-out'/.test(src)
  );
}

describe('T-394 S1 I7 - the five conversion-date copies are one date', () => {
  const keepFrom = (CUTOVER_CLASSIFICATION.fiscal_periods as unknown as { keepFrom: string }).keepFrom;
  const libDate = literalOf(read('apps/erp/src/app/cutover/lib.ts'), 'CONVERSION_DATE', true);
  const openingSrc = read('packages/domain/src/cutover/opening-stock.ts');

  it("7.a the readable copies equal tie-out.ts's CONVERSION_DATE (change any one: red)", () => {
    expect(TIE_OUT_DATE).toMatch(ISO);
    expect(libDate, 'apps/erp/src/app/cutover/lib.ts CONVERSION_DATE').toBe(TIE_OUT_DATE);
    expect(keepFrom, 'classification.ts fiscal_periods.keepFrom').toBe(TIE_OUT_DATE);
    expect(PURGE_AS_OF, 'tests/integration/t390-real-purge.ts PURGE_AS_OF').toBe(TIE_OUT_DATE);
  });

  it('7.b opening-stock.ts has no private copy: CONVERSION is CONVERSION_DATE imported from ./tie-out (R7)', () => {
    expect(literalOf(openingSrc, 'CONVERSION', false), 'a literal private copy is the DEF-642 shape').toBeNull();
    expect(derivesFromConversionDate(openingSrc)).toBe(true);
  });

  it('7.c the matchers themselves see the mutants: a changed literal, a restored private copy', () => {
    expect(literalOf("export const CONVERSION_DATE = '2027-02-01';", 'CONVERSION_DATE', true)).not.toBe(TIE_OUT_DATE);
    expect(literalOf("const CONVERSION = '2026-12-31';", 'CONVERSION', false)).toBe('2026-12-31');
    expect(derivesFromConversionDate("const CONVERSION = '2027-01-01';\n")).toBe(false);
    expect(derivesFromConversionDate("import { CONVERSION_DATE } from './tie-out';\nconst CONVERSION = CONVERSION_DATE;\n")).toBe(true);
  });
});
