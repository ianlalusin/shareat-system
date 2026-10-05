import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T-316 S3 — T-S3-6 (A5). `docs/tasks/316-till-floor-on-the-cashier-account.md`, "S3 — the detector + T-375
 * guard". T-316 never reads the POS link and never branches on how a sales day was written: the files it
 * touches contain no `pos_v1_store_links`, `posV1StoreLinks`, or `source =` read. Scoped to the code T-316
 * owns: `tillFloorPosition` (repo/remittance.ts), `tillFloatOffTarget` (repo/findings.ts), and the whole of
 * `remittance/index.ts`.
 *
 * ⭐ PASSES TODAY (guards regression): S1/S2 read no link. It goes red the day someone adds one.
 * Pure `fs` (no shelled grep): this repo runs on Windows. The positive control proves the scanner can see
 * each forbidden token — without it, "finds nothing" could mean "looks at nothing".
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf8');

/** The text of one top-level `export [async] function <name>` — from its line to the next column-0 `}`. */
function functionText(src: string, name: string): string {
  const lines = src.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^export (async )?function ${name}[ (]`).test(l));
  if (start < 0) throw new Error(`function ${name} not found`);
  let end = start;
  while (end < lines.length && lines[end] !== '}') end++;
  return lines.slice(start, end + 1).join('\n');
}

const FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: 'pos_v1_store_links', re: /pos_v1_store_links/ },
  { label: 'posV1StoreLinks', re: /posV1StoreLinks/ },
  { label: 'source =', re: /\bsource\s*=(?!=)/ },
  { label: '.source', re: /\.source\b/ },
  { label: 'source in/<>/!=', re: /\bsource\s*(in\b|<>|!=)/ },
];
const hits = (text: string) => FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.label);

const SCOPE: { what: string; text: () => string }[] = [
  { what: 'repo/remittance.ts — tillFloorPosition', text: () => functionText(read('packages/db/src/repo/remittance.ts'), 'tillFloorPosition') },
  { what: 'repo/findings.ts — tillFloatOffTarget', text: () => functionText(read('packages/db/src/repo/findings.ts'), 'tillFloatOffTarget') },
  { what: 'remittance/index.ts (whole file)', text: () => read('packages/domain/src/remittance/index.ts') },
];

describe('T-S3-6 — T-316 code reads no POS link and branches on no day source (A5)', () => {
  for (const s of SCOPE) {
    it(`${s.what}: none of pos_v1_store_links / posV1StoreLinks / "source ="`, () => {
      const text = s.text();
      expect(text.length, 'the scanned text must not be empty').toBeGreaterThan(200);
      expect(hits(text)).toEqual([]);
    });
  }

  it('control: the scanner finds each forbidden token in fixture text that contains it (and none in clean text)', () => {
    expect(hits('from pos_v1_store_links l where l.store_id = x')).toEqual(['pos_v1_store_links']);
    expect(hits('import { posV1StoreLinks } from "../schema"')).toEqual(['posV1StoreLinks']);
    expect(hits("where sd.source = 'pos_v1_day_feed'")).toEqual(['source =', '.source']);
    expect(hits('and(eq(salesDays.source, "pos_v1_day_feed"))')).toEqual(['.source']);
    expect(hits('select source from t where source in (1)')).toEqual(['source in/<>/!=']);
    expect(hits("where sd.source in ('legacy_typed')")).toEqual(['.source', 'source in/<>/!=']);
    expect(hits("where sd.source <> 'legacy_typed'")).toEqual(['.source', 'source in/<>/!=']);
    expect(hits("where x.source != 'a'")).toEqual(['.source', 'source in/<>/!=']);
    expect(hits('const x = y; if (a === b) {} // source_type = sale')).toEqual([]);
  });

  it('control: functionText extracts a real function body (tillFloatOffTarget mentions its own name and a money_accounts read)', () => {
    const t = functionText(read('packages/db/src/repo/findings.ts'), 'tillFloatOffTarget');
    expect(t).toContain('money_accounts');
  });
});
