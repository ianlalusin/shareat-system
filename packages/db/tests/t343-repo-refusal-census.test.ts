/**
 * T-343 S3 — `docs/tasks/343-def-417-human-readable-refusals.md` §S3, C1.
 *
 * Every `throw new Error(` in `packages/db/src/repo/*.ts` whose template interpolates a bare id
 * (`${id}`, `${orgId}`, `${input.id}`, `${xxxId}`) must either already be classified internal (a
 * one-line reason in `CLASSIFIED_INTERNAL` below) or have become `recordGone(...)` — the point of
 * S3 is that NONE of the ≈41-49 id-shaped "does not exist" refusals reach a screen with a raw UUID
 * in them.
 *
 * ⛔ Measured fresh against HEAD (2026-09-25), not copied from the spec's own "≈41" estimate: the
 * spec's own scan under-counted by missing throws with a trailing comma before the closing paren
 * (`` `...`,\n  ); ``, a very common multi-line shape) — the real count is 49. Reported here, not
 * silently reconciled to the smaller number (`shareat-system-measure-before-reporting-spec-defects`).
 *
 * ⭐ S3 is now BUILT (44 sites converted to `recordGone(...)`) — this file's own "sanity floor" and
 * `CLASSIFIED_INTERNAL` allowlist were both written for the PRE-conversion state and needed fixing
 * for the post-conversion one:
 *   1. The old floor (`scanRepoFiles().length > 20`) counted bare `throw new Error(` sites — which
 *      is exactly what conversion REMOVES. Replaced with a floor on `recordGone(` call sites (the
 *      thing conversion ADDS) plus a synthetic-fixture proof that the scanning regex itself still
 *      works, independent of how many real sites remain either way.
 *   2. `CLASSIFIED_INTERNAL` pinned exact LINE numbers, which is exactly what a converted FILE
 *      shifts — `journal.ts`'s own import had to be placed below line 201 to avoid moving these
 *      pins, a constraint on the SOURCE caused by a TEST's fragility. Each entry now pins by
 *      `file` + a distinctive, literal substring of the thrown message (unaffected by
 *      surrounding lines moving) instead.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// T-343 S5.0 — the widened AST scanner (see the new describe block at the end of this file).
import { censusTree } from '../../../tests/unit/lib/throw-census';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const REPO_DIR = path.join(repoRoot, 'packages', 'db', 'src', 'repo');

/** `${id}`, `${orgId}`, `${input.id}`, `${anythingId}` — the bare-identifier shapes S3 targets. */
const ID_PATTERN = /\$\{(?:[\w]*\.)?(?:id|orgId|[a-zA-Z]*Id)\}/;

interface Site {
  file: string;
  line: number;
  template: string;
}

/** The pure regex-matching mechanism, extracted from `scanRepoFiles` so it can be proven correct
 *  against a synthetic fixture string, independent of the real repo's current (post-conversion)
 *  content — see the "sanity" test below for why that independence matters. Matches
 *  `throw new Error(\`...\`)` (≤3 continuation lines, optional trailing comma before the closing
 *  paren — the shape the spec's own first-pass scan missed) whose template contains `ID_PATTERN`. A
 *  nested-template-literal throw (one interpolated expression itself containing a backtick, e.g.
 *  `remittance.ts`'s `cashierMovementByAccount`) is NOT matched by this regex and is handled instead
 *  as its own named, hand-verified `CLASSIFIED_INTERNAL` entry — documented, not silently dropped. */
function findIdShapedThrows(src: string): { line: number; template: string }[] {
  const found: { line: number; template: string }[] = [];
  const re = /throw new Error\(\s*`([^`]*(?:\n[^`]*){0,3}?)`\s*,?\s*\)/g;
  for (const m of src.matchAll(re)) {
    const template = m[1]!;
    if (!ID_PATTERN.test(template)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    found.push({ line, template: template.replace(/\s+/g, ' ').trim() });
  }
  return found;
}

function repoFiles(): string[] {
  return readdirSync(REPO_DIR).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
}

function readRepoFile(file: string): string {
  return readFileSync(path.join(REPO_DIR, file), 'utf8');
}

/** Every remaining bare id-shaped `throw new Error(...)`, across every tracked repo file. */
function scanRepoFiles(): Site[] {
  const sites: Site[] = [];
  for (const file of repoFiles()) {
    for (const hit of findIdShapedThrows(readRepoFile(file))) sites.push({ file, ...hit });
  }
  return sites;
}

/** How many `recordGone(` call sites exist across the repo layer — S3's conversion target, and
 *  therefore what a POST-conversion sanity floor must count instead of the (now mostly gone) raw
 *  throws. */
function countRecordGoneCallSites(): number {
  let total = 0;
  for (const file of repoFiles()) {
    const matches = readRepoFile(file).match(/recordGone\(/g);
    if (matches) total += matches.length;
  }
  return total;
}

/**
 * The audit's own classification (task doc §S3 "Population"), for sites that stay a bare `Error`
 * rather than becoming `recordGone(...)` — each an "unreachable in practice" programmer-invariant
 * violation, not a real user-facing "record gone" refusal.
 *
 * ⛔ Pinned by `file` + a distinctive, LITERAL substring of the source text (never a line number —
 * see this file's header for why a line pin fights the very conversion S3 exists to do). The
 * substring is copied verbatim from the `.ts` source, including its own `${...}` interpolation
 * syntax as plain text — it is never evaluated, only searched for.
 */
const CLASSIFIED_INTERNAL: { file: string; messageSubstring: string; reason: string }[] = [
  { file: 'stock-layers.ts', messageSubstring: 'consumption ${consumptionId} not found', reason: 'internal consumption-row lookup failure, not user-reachable (spec §S3)' },
  { file: 'stock-layers.ts', messageSubstring: 'only has ${row.quantity} outstanding', reason: 'internal consumption-row lookup failure, not user-reachable (spec §S3)' },
  { file: 'etl.ts', messageSubstring: 'is already running —', reason: 'ETL capture race message, operator-only surface (spec §S3)' },
  { file: 'etl.ts', messageSubstring: "was not 'running' (already finalised, or missing)", reason: 'ETL run bookkeeping, operator-only surface (spec §S3)' },
  { file: 'etl.ts', messageSubstring: 'conflict landing ${input.docPath} but no existing identical row found', reason: 'ETL document-landing conflict, operator-only surface (spec §S3)' },
  { file: 'journal.ts', messageSubstring: "idempotency conflict for org ${input.orgId} key", reason: 'unreachable in practice: a DO NOTHING conflict implies the row already exists (spec §S3)' },
  { file: 'journal.ts', messageSubstring: "unknown account code '${code}'", reason: 'unknown account code is a seed-data invariant, not a user-reachable "record gone" (spec §S3)' },
  { file: 'attendance-punches.ts', messageSubstring: 'conflicted on insert but is not readable', reason: 'RLS-hidden idempotency conflict across orgs, operator-only surface (spec §S3)' },
  { file: 'remittance.ts', messageSubstring: 'accepts no party on its own lines', reason: 'GL-account/cashier-accounts ambiguity message, not an id lookup (spec §S3)' },
];

/** Whether `substring` appears in `src` INSIDE a `throw new Error(...)` call — i.e. the nearest
 *  preceding `throw new Error(` has not yet been closed by the time the substring starts. Proximity,
 *  not a line window, so a converted file's reflow (imports moving, blank lines added) never makes
 *  a live entry read as stale. */
function isInsideThrowNewError(src: string, substring: string): boolean {
  const idx = src.indexOf(substring);
  if (idx === -1) return false;
  const throwIdx = src.lastIndexOf('throw new Error(', idx);
  if (throwIdx === -1) return false;
  const between = src.slice(throwIdx, idx);
  return !/\)\s*;/.test(between); // no closed call between the throw and our substring
}

describe('C1 — repo record-gone census: every id-shaped throw is recordGone(...) or classified', () => {
  it('⭐ sanity: the scanner finds real evidence of the S3 population, before or after conversion', () => {
    expect(readdirSync(REPO_DIR).length).toBeGreaterThan(50);

    // S3 is now built: ≥20 real `recordGone(` call sites — the thing conversion ADDS, so this floor
    // stays meaningful post-conversion (the old floor on raw `throw new Error(` counted the thing
    // conversion REMOVES, and would go vacuously low the moment the builder finished the work it
    // was meant to be checking).
    expect(countRecordGoneCallSites()).toBeGreaterThanOrEqual(20);

    // The raw-throw scanner still finds SOME real, still-bare id-shaped throws (the ones this
    // file's own regex can match at all — several `CLASSIFIED_INTERNAL` entries are concatenated
    // multi-part throws or non-id interpolations the regex was never meant to catch; the NEXT test
    // below proves each of those by message substring instead, independent of this regex).
    expect(scanRepoFiles().length).toBeGreaterThan(0);

    // ⭐ Proves the REGEX MECHANISM itself still works, independent of the real repo's current
    // counts in either direction — a planted fixture, not a real file on disk.
    const fixture =
      'export async function f(tx: Tx, orgId: string, widgetId: string) {\n' +
      '  const [row] = await tx.select().from(widgets).where(eq(widgets.id, widgetId));\n' +
      '  if (!row) {\n' +
      '    throw new Error(`widget ${widgetId} does not exist in org ${orgId}`);\n' +
      '  }\n' +
      '}\n';
    const hits = findIdShapedThrows(fixture);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.template).toContain('does not exist in org');
  });

  it('every CLASSIFIED_INTERNAL entry still names a real throw, by message substring (not stale)', () => {
    const stale: string[] = [];
    for (const entry of CLASSIFIED_INTERNAL) {
      const src = readRepoFile(entry.file);
      if (!isInsideThrowNewError(src, entry.messageSubstring)) {
        stale.push(`${entry.file} — "${entry.messageSubstring}" not found inside a throw new Error(...); the entry has moved, been reworded, or been converted`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('every exemption reason cites the spec section and says something', () => {
    const weak = CLASSIFIED_INTERNAL.filter((e) => !/§S3/.test(e.reason) || e.reason.trim().length < 30);
    expect(weak).toEqual([]);
  });

  it('⛔ every id-shaped throw is either classified internal or has become recordGone(...)', () => {
    const sites = scanRepoFiles();
    const unclassified = sites.filter(
      (s) => !CLASSIFIED_INTERNAL.some((e) => e.file === s.file && s.template.includes(e.messageSubstring)),
    );

    // Record the exact count and list, per the orchestrator's ask, win or lose.
    console.log(`C1: ${sites.length} id-shaped throw sites found, ${unclassified.length} unclassified (need recordGone):`);
    for (const s of unclassified) console.log(`  ${s.file}:${s.line}  ${s.template.slice(0, 90)}`);

    const stillBareThrow = unclassified.filter((s) => {
      const src = readRepoFile(s.file);
      const lines = src.split('\n');
      const window = lines.slice(Math.max(0, s.line - 2), s.line + 3).join('\n');
      return !window.includes('recordGone(');
    });
    expect(stillBareThrow.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// T-343 S5.0 — W4 (widened scanner). §S5 S5.0 table: "every id hit is recordGone(, in
// CLASSIFIED_INTERNAL, or in PENDING_S5_2 = exactly the 3 ap.ts sites (pinned by message
// substring); a stale PENDING_S5_2 entry fails". Uses `throw-census.ts` (a real AST walk) precisely
// because C1's own `findIdShapedThrows` above is the thing the S5 evidence proved has blind spots
// (concatenation, nested templates) — this describe is the widened replacement's own proof, not a
// second copy of C1's job. C1 above is left untouched (S3's negative half).
// ---------------------------------------------------------------------------------------------

/**
 * T-343 S5.2 — emptied. Was the 3 live, user-reachable, id-bearing repo throws the OLD regex never
 * saw (S5 evidence, `ap.ts:431,437,443` — concatenated template + string, the same shape as
 * `attendance-punches.ts` and one `CLASSIFIED_INTERNAL` `etl.ts` entry above). S5.2's builder
 * converts these to `refuse(...)` naming the invoice and supplier; emptied here so the widened
 * scanner below (§S5.0) now holds them to the SAME bar as every other repo site — no more excuse
 * once the conversion lands. A stale (re-added, non-empty) entry would only mask a regression, so
 * this list is never repopulated.
 */
const PENDING_S5_2: { file: string; messageSubstring: string; reason: string }[] = [];

/** Every non-`plain` site in the real repo tree — id/key/derived only; `recordGone(`/`gone(`/
 *  `internalFault(` call sites are already-converted and never appear here (`throw-census.ts`'s
 *  `CONVERTED_CALLEES`), so they need no allowlist entry at all. */
function nonPlainRepoSites() {
  return censusTree(REPO_DIR).filter((s) => s.kind !== 'plain');
}

describe('T-343 S5.0 — widened scanner', () => {
  it('T-343 S5.2 — PENDING_S5_2 is empty (the 3 ap.ts sites are converted or must be unaccounted)', () => {
    expect(PENDING_S5_2).toEqual([]);
  });

  it('every PENDING_S5_2 entry still names a real non-plain site — a stale entry fails', () => {
    const sites = nonPlainRepoSites();
    const stale = PENDING_S5_2.filter(
      (e) => !sites.some((s) => s.file.endsWith(`/${e.file}`) && s.text.includes(e.messageSubstring)),
    );
    expect(stale).toEqual([]);
  });

  it('⛔ every non-plain repo throw is recordGone(-shaped, CLASSIFIED_INTERNAL, or PENDING_S5_2 — nothing else', () => {
    const sites = nonPlainRepoSites();
    const unaccounted = sites.filter(
      (s) =>
        !CLASSIFIED_INTERNAL.some((e) => s.file.endsWith(`/${e.file}`) && s.text.includes(e.messageSubstring)) &&
        !PENDING_S5_2.some((e) => s.file.endsWith(`/${e.file}`) && s.text.includes(e.messageSubstring)),
    );
    console.log(`S5.0 widened scanner: ${sites.length} non-plain repo sites, ${unaccounted.length} unaccounted:`);
    for (const s of unaccounted) console.log(`  ${s.file}:${s.line}  ${s.text.slice(0, 90)}`);
    expect(unaccounted.map((s) => `${s.file}:${s.line}`)).toEqual([]);
  });
});
