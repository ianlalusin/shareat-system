/**
 * T-343 S5.1 — D1, D2. `docs/tasks/343-def-417-human-readable-refusals.md` §S5.1 table.
 *
 * The domain-tail census, shared across every S5 domain group from here on: `CONVERTED_DIRS`
 * names every `packages/domain/src/<dir>` a group has finished converting, and each LATER group
 * (S5.2, S5.3, S5.4) appends its own directories to the SAME list rather than writing a second
 * copy of D1/D2 — the point of a shared ratchet is that a later group's own D1 run still proves
 * every EARLIER group's directories stayed converted, not just its own.
 *
 * ⛔ Green on arrival is NOT the goal here — `packages/domain/src/sales-days`,
 * `packages/domain/src/expenses` are still 56 raw `throw new Error(` sites until S5.1's builder
 * converts them (D1 is RED, recording the list). D2 (the positive control) is ALSO red on arrival —
 * a converted tree that scans empty must fail, and today's tree has not been converted at all.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { censusTree } from '../../../tests/unit/lib/throw-census';

const repoRoot = resolve(__dirname, '..', '..', '..');

/** Every `packages/domain/src/<dir>` a group has finished converting. S5.1 is the first group and
 *  starts the list; S5.2/S5.3/S5.4 append theirs (never remove S5.1's). */
export const CONVERTED_DIRS = ['sales-days', 'expenses'];

function allSitesIn(dir: string) {
  return censusTree(resolve(repoRoot, 'packages', 'domain', 'src', dir));
}

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
        .map((s) => `${dir}: ${s.file}:${s.line} (${s.kind})  ${s.text.slice(0, 90)}`),
    );
    expect(badRefuseArgs).toEqual([]);
  });

  it('no `throw new <X>(` of any class whose first argument classifies id, key or derived (R1.2; derived allowlisted per R1.3)', () => {
    // `SalesDayBlockedError`/`TransitShortfallBlockedError` (`sales-days/create.ts:135,157`) carry
    // the id as their SECOND constructor argument, never their first — R1 Amendment item 2's own
    // example of a site this rule must NOT flag. No allowlist entry exists today because nothing
    // in either directory needs one; a real future exception is added here, one line, with a
    // reason — never granted by loosening the check itself.
    const DERIVED_ALLOWLIST: { dir: string; file: string; messageSubstring: string; reason: string }[] = [];
    const idShapedThrows = CONVERTED_DIRS.flatMap((dir) =>
      allSitesIn(dir)
        .filter((s) => s.callee !== 'refuse' && s.callee !== 'reason' && !['gone', 'internalFault', 'recordGone'].includes(s.callee))
        .filter((s) => s.kind === 'id' || s.kind === 'key' || s.kind === 'derived')
        .filter((s) => !DERIVED_ALLOWLIST.some((e) => e.dir === dir && s.file.endsWith(`/${e.file}`) && s.text.includes(e.messageSubstring)))
        .map((s) => `${dir}: ${s.file}:${s.line} (${s.kind}, ${s.callee})  ${s.text.slice(0, 90)}`),
    );
    expect(idShapedThrows).toEqual([]);
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
  it('refuse( + gone( + internalFault( sites across CONVERTED_DIRS total at least 50', () => {
    const converted = CONVERTED_DIRS.flatMap((dir) =>
      allSitesIn(dir).filter((s) => s.callee === 'refuse' || s.callee === 'gone' || s.callee === 'internalFault'),
    );
    console.log(`D2: ${converted.length} refuse(/gone(/internalFault( sites across ${CONVERTED_DIRS.join(', ')}`);
    expect(converted.length).toBeGreaterThanOrEqual(50);
  });

  it('non-plain sites are still detectable at all (the scanner itself has not gone blind)', () => {
    // Combined with D1's own "0 raw sites" (a possible TRUE), this proves D1 passes because the
    // tree was actually converted, not because the census stopped seeing anything (shareat-system
    // convention: a check that skips its input reports success).
    const anySite = CONVERTED_DIRS.some((dir) => allSitesIn(dir).length > 0);
    expect(anySite).toBe(true);
  });
});
