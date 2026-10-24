/**
 * T-343 S5.1 — D1, D2. `docs/tasks/343-def-417-human-readable-refusals.md` §S5.1 table.
 *
 * The domain-tail census, shared across every S5 domain group from here on: `CONVERTED_DIRS`
 * names every `packages/domain/src/<dir>` a group has finished converting, and each LATER group
 * (S5.2, S5.3, S5.4) appends its own directories to the SAME list rather than writing a second
 * copy of D1/D2 — the point of a shared ratchet is that a later group's own D1 run still proves
 * every EARLIER group's directories stayed converted, not just its own.
 *
 * ⛔ Green on arrival is NOT the goal — each new entry starts RED (D1 records the list) and D2 (the
 * positive control) starts red too, since a converted tree that scans empty must fail. `sales-days`/
 * `expenses` were 56 raw `throw new Error(` sites before S5.1's builder converted them; `ap`/
 * `customers` (T-343 S5.2) are the same shape, added below.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { censusSource, censusTree } from '../../../tests/unit/lib/throw-census';

const repoRoot = resolve(__dirname, '..', '..', '..');

/** Every `packages/domain/src/<dir>` a group has finished converting. S5.1 is the first group and
 *  starts the list; S5.2/S5.3/S5.4 append theirs (never remove S5.1's). */
export const CONVERTED_DIRS = ['sales-days', 'expenses', 'ap', 'customers'];

/**
 * T-343 S5.3 (R4.8) — a per-FILE list, not a directory: `deliveries/`, `commissary/` and `cutover/`
 * each keep unconverted SIBLINGS (`deliveries/receive.ts`, `commissary/fulfilment.ts`,
 * `commissary/orders.ts`, `cutover/index.ts` — S5.5+), so appending these three to `CONVERTED_DIRS`
 * would demand 0 raw throws across files this group never touches. `CONVERTED_FILES` holds exactly
 * the files a group actually finished, checked by the same D1 rules (censusSource, one file at a
 * time) and counted toward D2's floor alongside `CONVERTED_DIRS`.
 */
export const CONVERTED_FILES = ['deliveries/documents.ts', 'commissary/catalogue.ts', 'cutover/opening.ts'];

function allSitesIn(dir: string) {
  return censusTree(resolve(repoRoot, 'packages', 'domain', 'src', dir));
}

function allSitesInFile(relPath: string) {
  const abs = resolve(repoRoot, 'packages', 'domain', 'src', relPath);
  return censusSource(relPath, readFileSync(abs, 'utf8'));
}

/**
 * ⛔ T-343 S5.2fu (auditor CHANGES, LOW 3, 2026-09-27) — scoped to the `refuse(` 2nd-arg check
 * ONLY, never the `throw new <X>(` first-argument check below. The two checks classify different
 * things: `refuse(`'s 2nd arg is always the USER-FACING sentence, so "joins literal labels, never
 * an id" is a real, provable exception there. `throw new <X>('s FIRST argument is the raw internal
 * diagnostic (R1.2's own target) — a class whose first argument classifies derived is exactly what
 * that rule exists to catch, and this allowlist has no business reaching it. `sales-days/create.ts`'s
 * `SalesDayBlockedError`/`TransitShortfallBlockedError` (R1 Amendment item 2's own example) need no
 * entry here at all: they carry the id as their SECOND constructor argument, never their first, so
 * the `throw new <X>(` rule already skips them structurally. A real exception is added here, one
 * line, with a reason — never granted by loosening either check itself.
 */
const DERIVED_ALLOWLIST: { dir: string; file: string; messageSubstring: string; reason: string }[] = [
  // T-475 S1: the one entry (verifyInvoice's joined attestation labels) went away with the sentence, which now lives in the
  // business-rule leaf (`packages/domain/src/business-rules/ap.ts`, outside this census); ap/index.ts's own refuse() argument is plain.
];

describe('D1 — sales-days/ and expenses/ carry no raw, id-shaped throw once converted', () => {
  it('0 raw `throw new Error(` sites in either directory', () => {
    const rawErrorSites = CONVERTED_DIRS.flatMap((dir) =>
      allSitesIn(dir)
        .filter((s) => s.callee === 'Error')
        .map((s) => `${dir}: ${s.file}:${s.line}  ${s.text.slice(0, 90)}`),
    );
    // Recorded so the raw red list is visible in CI output, win or lose (RULES §3.4a).
    console.log(`D1: ${rawErrorSites.length} raw 'throw new Error(' sites in ${CONVERTED_DIRS.join(', ')}:`);
    for (const line of rawErrorSites) console.log(`  ${line}`);
    expect(rawErrorSites).toEqual([]);
  });

  it('every refuse( 2nd arg classifies plain — no quoted raw key or column name ever reaches a sentence', () => {
    const badRefuseArgs = CONVERTED_DIRS.flatMap((dir) =>
      allSitesIn(dir)
        .filter((s) => s.callee === 'refuse' && s.kind !== 'plain')
        .filter((s) => !DERIVED_ALLOWLIST.some((e) => e.dir === dir && s.file.endsWith(`/${e.file}`) && s.text.includes(e.messageSubstring)))
        .map((s) => `${dir}: ${s.file}:${s.line} (${s.kind})  ${s.text.slice(0, 90)}`),
    );
    expect(badRefuseArgs).toEqual([]);
  });

  it('no `throw new <X>(` of any class whose first argument classifies id, key or derived (R1.2 — DERIVED_ALLOWLIST does not apply here, S5.2fu LOW 3)', () => {
    const idShapedThrows = CONVERTED_DIRS.flatMap((dir) =>
      allSitesIn(dir)
        .filter((s) => s.callee !== 'refuse' && s.callee !== 'reason' && !['gone', 'internalFault', 'recordGone'].includes(s.callee))
        .filter((s) => s.kind === 'id' || s.kind === 'key' || s.kind === 'derived')
        .map((s) => `${dir}: ${s.file}:${s.line} (${s.kind}, ${s.callee})  ${s.text.slice(0, 90)}`),
    );
    expect(idShapedThrows).toEqual([]);
  });

  it('every DERIVED_ALLOWLIST entry still names a real, currently-derived refuse( site — a stale entry fails', () => {
    const stale = DERIVED_ALLOWLIST.filter((e) => {
      const sites = allSitesIn(e.dir).filter((s) => s.callee === 'refuse' && s.file.endsWith(`/${e.file}`));
      return !sites.some((s) => s.kind === 'derived' && s.text.includes(e.messageSubstring));
    });
    expect(stale).toEqual([]);
  });

  it('no `new RefusalError(` — production code never constructs it directly (R1.5)', () => {
    const directConstructions = CONVERTED_DIRS.flatMap((dir) =>
      allSitesIn(dir)
        .filter((s) => s.callee === 'RefusalError')
        .map((s) => `${dir}: ${s.file}:${s.line}`),
    );
    expect(directConstructions).toEqual([]);
  });
});

describe('D2 — census floor: a converted tree that scans empty fails (DEF-179 positive control)', () => {
  it('refuse( + gone( + internalFault( sites across CONVERTED_DIRS + CONVERTED_FILES total at least 50', () => {
    const converted = [
      ...CONVERTED_DIRS.flatMap((dir) => allSitesIn(dir)),
      ...CONVERTED_FILES.flatMap((file) => allSitesInFile(file)),
    ].filter((s) => s.callee === 'refuse' || s.callee === 'gone' || s.callee === 'internalFault');
    console.log(
      `D2: ${converted.length} refuse(/gone(/internalFault( sites across ${CONVERTED_DIRS.join(', ')} + ${CONVERTED_FILES.join(', ')}`,
    );
    expect(converted.length).toBeGreaterThanOrEqual(50);
  });

  it('non-plain sites are still detectable at all (the scanner itself has not gone blind)', () => {
    // Combined with D1's own "0 raw sites" (a possible TRUE), this proves D1 passes because the
    // tree was actually converted, not because the census stopped seeing anything (shareat-system
    // convention: a check that skips its input reports success).
    const anySite =
      CONVERTED_DIRS.some((dir) => allSitesIn(dir).length > 0) ||
      CONVERTED_FILES.some((file) => allSitesInFile(file).length > 0);
    expect(anySite).toBe(true);
  });
});

describe('D3 — CONVERTED_FILES (S5.3): the three files carry no raw, id-shaped throw once converted', () => {
  it('0 raw `throw new Error(` sites across the three files', () => {
    const rawErrorSites = CONVERTED_FILES.flatMap((file) =>
      allSitesInFile(file)
        .filter((s) => s.callee === 'Error')
        .map((s) => `${file}:${s.line}  ${s.text.slice(0, 90)}`),
    );
    console.log(`D3: ${rawErrorSites.length} raw 'throw new Error(' sites in ${CONVERTED_FILES.join(', ')}:`);
    for (const line of rawErrorSites) console.log(`  ${line}`);
    expect(rawErrorSites).toEqual([]);
  });

  it('every refuse( 2nd arg classifies plain — no quoted raw key or column name ever reaches a sentence', () => {
    const badRefuseArgs = CONVERTED_FILES.flatMap((file) =>
      allSitesInFile(file)
        .filter((s) => s.callee === 'refuse' && s.kind !== 'plain')
        .map((s) => `${file}:${s.line} (${s.kind})  ${s.text.slice(0, 90)}`),
    );
    expect(badRefuseArgs).toEqual([]);
  });

  it('no `throw new <X>(` of any class whose first argument classifies id, key or derived (R1.2)', () => {
    const idShapedThrows = CONVERTED_FILES.flatMap((file) =>
      allSitesInFile(file)
        .filter((s) => s.callee !== 'refuse' && s.callee !== 'reason' && !['gone', 'internalFault', 'recordGone'].includes(s.callee))
        .filter((s) => s.kind === 'id' || s.kind === 'key' || s.kind === 'derived')
        .map((s) => `${file}:${s.line} (${s.kind}, ${s.callee})  ${s.text.slice(0, 90)}`),
    );
    expect(idShapedThrows).toEqual([]);
  });

  it('no `new RefusalError(` — production code never constructs it directly (R1.5)', () => {
    const directConstructions = CONVERTED_FILES.flatMap((file) =>
      allSitesInFile(file)
        .filter((s) => s.callee === 'RefusalError')
        .map((s) => `${file}:${s.line}`),
    );
    expect(directConstructions).toEqual([]);
  });
});
