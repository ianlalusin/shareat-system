/**
 * T-343 S4 / DEF-417 part 2 row 17 — `docs/tasks/343-def-417-human-readable-refusals.md` §S4, S-C1.
 *
 * `scheduler_runs.failures[].subjectName` is rendered verbatim by
 * `apps/erp/src/components/scheduler-status.tsx` — no `subjectName:` in `scheduler/index.ts` may
 * interpolate a raw id (`.id`, `orgId`, `storeId`, `categoryId`, `wastageId`, …). Human names
 * (`org.name`, `f.assetName`, `f.itemName`, `f.path`) are fine; a template built from an id field is
 * the defect.
 *
 * ⛔ RED until the builder fixes the three sites the spec names (row 17, `:367,650,864` at spec-time;
 * measured fresh here at `:371,654,868` — line drift since the census was written, not a different
 * defect). This file finds them by scanning, not by citing the possibly-stale line numbers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCHEDULER_FILE = path.resolve(__dirname, '..', 'src', 'scheduler', 'index.ts');

/** Matches an id-shaped identifier inside a `subjectName:` template — `${x.id}`, `${xOrgId}`,
 *  `${storeId}`, `${b.storeId}`, `${f.wastageId}`, etc. Deliberately excludes plain `.name` /
 *  `.code` / `.path` fields, which are exactly the human-readable shapes this census must NOT flag. */
const ID_IN_TEMPLATE = /\$\{[\w.]*\b(?:id|orgId|storeId|categoryId|wastageId|[a-zA-Z]*Id)\b\}/;

interface Site {
  line: number;
  snippet: string;
}

function scanSubjectNameSites(): Site[] {
  const src = readFileSync(SCHEDULER_FILE, 'utf8');
  const sites: Site[] = [];
  const re = /subjectName:\s*(`[^`]*`|[\w.]+)/g;
  for (const m of src.matchAll(re)) {
    const value = m[1]!;
    if (value.startsWith('`') && ID_IN_TEMPLATE.test(value)) {
      const line = src.slice(0, m.index).split('\n').length;
      sites.push({ line, snippet: `subjectName: ${value}` });
    }
  }
  return sites;
}

describe('S-C1 — no subjectName in scheduler/index.ts interpolates a raw id', () => {
  it('⭐ finds subjectName sites at all (a scan of nothing must not pass)', () => {
    const src = readFileSync(SCHEDULER_FILE, 'utf8');
    const total = [...src.matchAll(/subjectName:/g)].length;
    expect(total).toBeGreaterThanOrEqual(8);
  });

  it('⛔ zero subjectName templates interpolate an id — RED until the builder resolves store/category/order names first', () => {
    const sites = scanSubjectNameSites();
    console.log(`S-C1: ${sites.length} id-interpolating subjectName site(s):`);
    for (const s of sites) console.log(`  scheduler/index.ts:${s.line}  ${s.snippet}`);
    expect(sites.map((s) => s.line)).toEqual([]);
  });

  it('NEGATIVE: a human-named subjectName (org.name, f.assetName, f.path) is never flagged', () => {
    const src = `
      failures.push({ subjectId: org.id, subjectName: org.name, reason: 'x' });
      const a = { subjectName: f.assetName };
      const b = { subjectName: f.path };
    `;
    const re = /subjectName:\s*([\w.]+)/g;
    for (const m of src.matchAll(re)) {
      expect(ID_IN_TEMPLATE.test(m[1]!)).toBe(false);
    }
  });

  it('NEGATIVE: the extractor itself flags a fabricated id-shaped template', () => {
    expect(ID_IN_TEMPLATE.test('`store ${store.id}`')).toBe(true);
    expect(ID_IN_TEMPLATE.test('`order wastage ${f.wastageId}`')).toBe(true);
    expect(ID_IN_TEMPLATE.test('`${org.name}`')).toBe(false);
  });
});
